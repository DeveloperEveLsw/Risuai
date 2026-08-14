import { Sha256 } from "@aws-crypto/sha256-js"

export type TranslationSourceFormat = 'plain' | 'html-segments-v1'

export interface TranslationContext {
    characterId?: string
    chatId?: string
    messageId?: string
    translatorNote: string
}

export interface TranslationPlanInput {
    source: string
    sourceFormat: TranslationSourceFormat
    sourceLanguage: string
    targetLanguage: string
    engine: string
    presetId?: number | string
    presetName?: string
    prompt: string
    maxTokens: number
    model: string
    fallbackModels?: string[]
    context: TranslationContext
    engineOptions?: unknown
}

export interface TranslationSemanticDescriptorV1 {
    schemaVersion: 1
    pipelineVersion: 'translation-core-v1'
    tokenizerVersion: 'protected-token-v2'
    sourceHash: string
    sourceFormat: TranslationSourceFormat
    sourceLanguage: string
    targetLanguage: string
    engine: string
    presetId: number | string | null
    presetNameHash: string
    promptHash: string
    maxTokens: number
    model: string
    fallbackModels: string[]
    characterContextHash: string
    chatContextHash: string
    messageContextHash: string
    translatorNoteHash: string
    engineOptionsHash: string
}

export interface ProtectedTranslationToken {
    token: string
    value: string
}

export interface TranslationPlanV1 {
    schemaVersion: 1
    key: string
    descriptor: TranslationSemanticDescriptorV1
    source: string
    protectedSource: string
    protectedTokens: readonly ProtectedTranslationToken[]
    context: Readonly<TranslationContext>
}

export interface ManualTranslationCacheKeyInput {
    source: string
    sourceFormat: TranslationSourceFormat
    targetLanguage: string
    context: TranslationContext
}

export class TranslationIntegrityError extends Error {
    constructor(message = 'The translation changed protected content.') {
        super(message)
        this.name = 'TranslationIntegrityError'
    }
}

const tokenPrefix = '__RISU_PROTECTED_'
const protectedTokenRegex = /__RISU_PROTECTED_\d{6}_[a-f0-9]{16}__/g

function stableValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(stableValue)
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
                .map(([key, entry]) => [key, stableValue(entry)])
        )
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
        return String(value)
    }
    if (value === undefined) {
        return null
    }
    return value
}

export function stableTranslationJson(value: unknown): string {
    return JSON.stringify(stableValue(value))
}

async function sha256(value: string): Promise<string> {
    const digest = new Sha256()
    digest.update(new TextEncoder().encode(value))
    return Array.from(await digest.digest(), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function normalizedLanguage(value: string): string {
    return value.trim().replaceAll('_', '-').toLocaleLowerCase('en-US')
}

interface ProtectedRange {
    start: number
    end: number
}

function findClosingTag(source: string, start: number, tagName: string): number | null {
    const closingTag = new RegExp(`</\\s*${tagName}\\s*>`, 'gi')
    closingTag.lastIndex = start
    const match = closingTag.exec(source)
    return match === null ? null : match.index + match[0].length
}

function findHtmlTagEnd(source: string, start: number): number | null {
    if (source.startsWith('<!--', start)) {
        const end = source.indexOf('-->', start + 4)
        return end === -1 ? null : end + 3
    }

    let quote = ''
    for (let index = start + 1; index < source.length; index++) {
        const current = source[index]
        if (quote) {
            if (current === quote) {
                quote = ''
            }
            continue
        }
        if (current === '"' || current === "'") {
            quote = current
            continue
        }
        if (current === '>') {
            return index + 1
        }
    }
    return null
}

function isEscaped(source: string, index: number): boolean {
    let slashCount = 0
    for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor--) {
        slashCount++
    }
    return slashCount % 2 === 1
}

function isLineStart(source: string, index: number): boolean {
    return index === 0 || source[index - 1] === '\n' || source[index - 1] === '\r'
}

function findFencedCodeEnd(source: string, start: number): number | null {
    if (!isLineStart(source, start)) return null

    const opening = /^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r\n|\r|\n|$)/.exec(source.slice(start))
    if (!opening) return null

    const openingFence = opening[1]
    let lineStart = start + opening[0].length
    if (lineStart === source.length) return source.length

    while (lineStart < source.length) {
        const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*(?:\r\n|\r|\n|$)/.exec(source.slice(lineStart))
        if (
            closing
            && closing[1][0] === openingFence[0]
            && closing[1].length >= openingFence.length
        ) {
            return lineStart + closing[0].length
        }

        const lineBreak = /\r\n|\r|\n/.exec(source.slice(lineStart))
        if (!lineBreak) return source.length
        lineStart += lineBreak.index + lineBreak[0].length
    }

    // CommonMark treats an unclosed fence as code through end-of-document.
    return source.length
}

function previousLineIsBlank(source: string, lineStart: number): boolean {
    if (lineStart === 0) return true
    let previousEnd = lineStart - 1
    if (source[previousEnd] === '\n' && source[previousEnd - 1] === '\r') previousEnd--
    const previousStart = Math.max(
        source.lastIndexOf('\n', previousEnd - 1),
        source.lastIndexOf('\r', previousEnd - 1),
    ) + 1
    return source.slice(previousStart, previousEnd).trim().length === 0
}

function findIndentedCodeEnd(source: string, start: number): number | null {
    if (
        !isLineStart(source, start)
        || !previousLineIsBlank(source, start)
        || !/^(?: {4}|\t)/.test(source.slice(start))
    ) {
        return null
    }

    let cursor = start
    let protectedEnd = start
    while (cursor < source.length) {
        const lineBreak = /\r\n|\r|\n/.exec(source.slice(cursor))
        const contentEnd = lineBreak ? cursor + lineBreak.index : source.length
        const lineEnd = lineBreak ? contentEnd + lineBreak[0].length : source.length
        const line = source.slice(cursor, contentEnd)
        if (!/^(?: {4}|\t)/.test(line) && line.trim().length > 0) break
        protectedEnd = lineEnd
        cursor = lineEnd
    }
    return protectedEnd > start ? protectedEnd : null
}

function findInlineCodeEnd(source: string, start: number): { end: number | null, runLength: number } {
    let runLength = 1
    while (source[start + runLength] === '`') runLength++
    if (isEscaped(source, start)) return { end: null, runLength }

    const delimiter = '`'.repeat(runLength)
    let searchStart = start + runLength
    while (searchStart < source.length) {
        const closingStart = source.indexOf(delimiter, searchStart)
        if (closingStart === -1) return { end: null, runLength }
        if (
            source[closingStart - 1] !== '`'
            && source[closingStart + runLength] !== '`'
        ) {
            return { end: closingStart + runLength, runLength }
        }
        searchStart = closingStart + 1
    }
    return { end: null, runLength }
}

// This is intentionally an allowlist. These names carry parser/runtime
// structure or opaque identifiers; unknown macros may intentionally contain
// natural language and remain visible to the translation provider.
const structuralDirective = /^\{\{(?:moduleassetlist|inlayeddata|video-img|emotionlist|assetlist|position|emotion|inlayed|source|button|asset|image|video|audio|inlay|file|path|raw|risu|img|bgm|bg)(?=::|\s|\}\})/i

function findStructuralDirectiveEnd(source: string, start: number): number | null {
    const opening = structuralDirective.exec(source.slice(start))
    if (!opening) return null
    const closingStart = source.indexOf('}}', start + opening[0].length)
    return closingStart === -1 ? null : closingStart + 2
}

function findMarkdownLinkLabelStart(source: string, closingBracket: number): number | null {
    let nestedBrackets = 0
    for (let index = closingBracket - 1; index >= 0; index--) {
        if (isEscaped(source, index)) continue
        if (source[index] === ']') {
            nestedBrackets++
            continue
        }
        if (source[index] === '[') {
            if (nestedBrackets === 0) return index
            nestedBrackets--
        }
    }
    return null
}

function normalizeMarkdownReferenceLabel(label: string): string {
    return label
        .replace(/\\(.)/g, '$1')
        .trim()
        .replace(/\s+/g, ' ')
        .toLocaleLowerCase('en-US')
}

function findMarkdownLabelEnd(source: string, openingBracket: number): number | null {
    let nestedBrackets = 0
    for (let index = openingBracket + 1; index < source.length; index++) {
        if (source[index] === '\n' || source[index] === '\r') return null
        if (isEscaped(source, index)) continue
        if (source[index] === '[') {
            nestedBrackets++
            continue
        }
        if (source[index] === ']') {
            if (nestedBrackets === 0) return index
            nestedBrackets--
        }
    }
    return null
}

function findMarkdownLinkDestinationEnd(source: string, openingParenthesis: number): number | null {
    let nestedParentheses = 0
    let quote = ''
    let angleDestination = false
    let seenNonWhitespace = false

    for (let index = openingParenthesis + 1; index < source.length; index++) {
        const current = source[index]
        if (isEscaped(source, index)) continue

        if (angleDestination) {
            if (current === '>') angleDestination = false
            continue
        }
        if (quote) {
            if (current === quote) quote = ''
            continue
        }
        if (!seenNonWhitespace && /\s/.test(current)) continue
        if (!seenNonWhitespace) {
            seenNonWhitespace = true
            if (current === '<') {
                angleDestination = true
                continue
            }
        }
        if (
            (current === '"' || current === "'")
            && index > openingParenthesis + 1
            && /\s/.test(source[index - 1])
        ) {
            quote = current
            continue
        }
        if (current === '(') {
            nestedParentheses++
            continue
        }
        if (current === ')') {
            if (nestedParentheses === 0) return index + 1
            nestedParentheses--
        }
    }
    return null
}

function findExplicitReferenceIdentifierEnd(source: string, openingBracket: number): number | null {
    if (source[openingBracket] !== '[' || source[openingBracket + 1] === ']') return null
    for (let index = openingBracket + 1; index < source.length; index++) {
        if (source[index] === '\n' || source[index] === '\r') return null
        if (source[index] === ']' && !isEscaped(source, index)) return index + 1
    }
    return null
}

interface MarkdownReferenceDefinition {
    range: ProtectedRange
    normalizedLabel: string
}

function findReferenceDefinition(source: string, lineStart: number): MarkdownReferenceDefinition | null {
    if (!isLineStart(source, lineStart)) return null
    const prefix = /^ {0,3}\[((?:\\.|[^\]\\\r\n])+)\]:[ \t]*/.exec(source.slice(lineStart))
    if (!prefix) return null

    const destinationStart = lineStart + prefix[0].length
    if (destinationStart >= source.length || /[\r\n]/.test(source[destinationStart])) return null

    let destinationEnd = destinationStart
    if (source[destinationStart] === '<') {
        destinationEnd++
        while (destinationEnd < source.length && !/[\r\n]/.test(source[destinationEnd])) {
            if (source[destinationEnd] === '>' && !isEscaped(source, destinationEnd)) {
                destinationEnd++
                break
            }
            destinationEnd++
        }
        if (source[destinationEnd - 1] !== '>') return null
    } else {
        while (destinationEnd < source.length && !/[\s]/.test(source[destinationEnd])) {
            destinationEnd++
        }
    }

    if (destinationEnd === destinationStart) return null
    const remainingLine = /\r\n|\r|\n/.exec(source.slice(destinationEnd))
    const definitionEnd = remainingLine
        ? destinationEnd + remainingLine.index
        : source.length
    return {
        range: { start: lineStart, end: definitionEnd },
        normalizedLabel: normalizeMarkdownReferenceLabel(prefix[1]),
    }
}

function collectMarkdownReferenceLabels(source: string): Set<string> {
    const labels = new Set<string>()
    let lineStart = 0
    while (lineStart < source.length) {
        const definition = findReferenceDefinition(source, lineStart)
        if (definition) labels.add(definition.normalizedLabel)
        const lineBreak = /\r\n|\r|\n/.exec(source.slice(lineStart))
        if (!lineBreak) break
        lineStart += lineBreak.index + lineBreak[0].length
    }
    return labels
}

function findProtectedRanges(source: string): ProtectedRange[] {
    const ranges: ProtectedRange[] = []
    const lowerSource = source.toLocaleLowerCase('en-US')
    const referenceLabels = collectMarkdownReferenceLabels(source)
    let index = 0

    while (index < source.length) {
        const fencedCodeEnd = findFencedCodeEnd(source, index)
        if (fencedCodeEnd !== null) {
            ranges.push({ start: index, end: fencedCodeEnd })
            index = fencedCodeEnd
            continue
        }

        const indentedCodeEnd = findIndentedCodeEnd(source, index)
        if (indentedCodeEnd !== null) {
            ranges.push({ start: index, end: indentedCodeEnd })
            index = indentedCodeEnd
            continue
        }

        const referenceDefinition = findReferenceDefinition(source, index)
        if (referenceDefinition !== null) {
            ranges.push(referenceDefinition.range)
            index = referenceDefinition.range.end
            continue
        }

        if (source[index] === '`') {
            const inlineCode = findInlineCodeEnd(source, index)
            if (inlineCode.end !== null) {
                ranges.push({ start: index, end: inlineCode.end })
                index = inlineCode.end
                continue
            }
            index += inlineCode.runLength
            continue
        }

        if (source[index] === '[' && !isEscaped(source, index)) {
            const closingBracket = findMarkdownLabelEnd(source, index)
            if (closingBracket !== null) {
                const label = normalizeMarkdownReferenceLabel(
                    source.slice(index + 1, closingBracket)
                )
                if (label && referenceLabels.has(label)) {
                    if (source.startsWith('[]', closingBracket + 1)) {
                        ranges.push({ start: index, end: closingBracket + 3 })
                        index = closingBracket + 3
                        continue
                    }
                    if (
                        source[closingBracket + 1] !== '('
                        && source[closingBracket + 1] !== '['
                        && source[closingBracket + 1] !== ':'
                    ) {
                        ranges.push({ start: index, end: closingBracket + 1 })
                        index = closingBracket + 1
                        continue
                    }
                }
            }
        }

        if (lowerSource.startsWith('<risu-style>', index)) {
            const end = findClosingTag(source, index + 12, 'risu-style')
            const protectedEnd = end ?? source.length
            ranges.push({ start: index, end: protectedEnd })
            index = protectedEnd
            continue
        }

        if (source.startsWith('{{', index)) {
            const end = findStructuralDirectiveEnd(source, index)
            if (end !== null) {
                ranges.push({ start: index, end })
                index = end
                continue
            }
        }

        // Raw translation input can already contain HTML, including markup
        // emitted by CBS (for example button trigger attributes).
        if (source[index] === '<') {
            const opening = /^<\s*([A-Za-z][\w:-]*)\b/.exec(source.slice(index))
            const tagName = opening?.[1]?.toLocaleLowerCase('en-US')
            if (
                tagName === 'script'
                || tagName === 'style'
                || tagName === 'code'
                || tagName === 'pre'
            ) {
                const end = findClosingTag(source, index + opening[0].length, tagName)
                const protectedEnd = end ?? source.length
                ranges.push({ start: index, end: protectedEnd })
                index = protectedEnd
                continue
            }

            if (/^<\/?\s*[A-Za-z!]/.test(source.slice(index)) || source.startsWith('<!--', index)) {
                const end = findHtmlTagEnd(source, index)
                if (end !== null) {
                    ranges.push({ start: index, end })
                    index = end
                    continue
                }
            }
        }

        if (
            source[index] === ']'
            && source[index + 1] === '('
            && !isEscaped(source, index)
            && findMarkdownLinkLabelStart(source, index) !== null
        ) {
            const end = findMarkdownLinkDestinationEnd(source, index + 1)
            if (end !== null) {
                ranges.push({ start: index + 1, end })
                index = end
                continue
            }
        }

        if (
            source[index] === ']'
            && source[index + 1] === '['
            && !isEscaped(source, index)
            && findMarkdownLinkLabelStart(source, index) !== null
        ) {
            const end = findExplicitReferenceIdentifierEnd(source, index + 1)
            if (end !== null) {
                ranges.push({ start: index + 1, end })
                index = end
                continue
            }
        }

        index++
    }

    return ranges
}

interface MarkdownLinkStructure {
    kind: 'link' | 'image' | 'reference'
    structuralSuffix: string
    hasLabelContent: boolean
}

/**
 * Protected destination tokens are not sufficient on their own: a model can
 * keep every token but move `(destination)` away from its `[label]`, silently
 * turning a link into prose. Capture the link grammar independently so labels
 * and alt text remain translatable while delimiters/destinations stay valid.
 */
function collectMarkdownLinkStructure(source: string): MarkdownLinkStructure[] {
    const structures: MarkdownLinkStructure[] = []
    for (let index = 0; index < source.length; index++) {
        if (source[index] !== '[' || isEscaped(source, index)) continue
        const closingBracket = findMarkdownLabelEnd(source, index)
        if (closingBracket === null) continue
        const hasLabelContent = source.slice(index + 1, closingBracket).trim().length > 0
        const isImage = index > 0 && source[index - 1] === '!' && !isEscaped(source, index - 1)

        if (source[closingBracket + 1] === '(') {
            const end = findMarkdownLinkDestinationEnd(source, closingBracket + 1)
            if (end !== null) {
                structures.push({
                    kind: isImage ? 'image' : 'link',
                    structuralSuffix: source.slice(closingBracket + 1, end),
                    hasLabelContent,
                })
                index = end - 1
            }
            continue
        }

        if (source[closingBracket + 1] === '[') {
            const end = findExplicitReferenceIdentifierEnd(source, closingBracket + 1)
            if (end !== null) {
                structures.push({
                    kind: isImage ? 'image' : 'reference',
                    structuralSuffix: source.slice(closingBracket + 1, end),
                    hasLabelContent,
                })
                index = end - 1
            }
        }
    }
    return structures
}

function assertMarkdownLinkStructure(source: string, restored: string): void {
    const expected = collectMarkdownLinkStructure(source)
    const actual = collectMarkdownLinkStructure(restored)
    if (
        expected.length !== actual.length
        || expected.some((entry, index) => {
            const candidate = actual[index]
            return !candidate
                || candidate.kind !== entry.kind
                || candidate.structuralSuffix !== entry.structuralSuffix
                || candidate.hasLabelContent !== entry.hasLabelContent
        })
    ) {
        throw new TranslationIntegrityError('The translation changed Markdown link structure.')
    }
}

function collectHtmlTextSlotOccupancy(source: string): boolean[] {
    const slots: boolean[] = []
    let cursor = 0
    let index = 0
    let foundTag = false
    while (index < source.length) {
        if (
            source[index] === '<'
            && (/^<\/?\s*[A-Za-z!]/.test(source.slice(index)) || source.startsWith('<!--', index))
        ) {
            const end = findHtmlTagEnd(source, index)
            if (end !== null) {
                slots.push(source.slice(cursor, index).trim().length > 0)
                foundTag = true
                cursor = end
                index = end
                continue
            }
        }
        index++
    }
    if (!foundTag) return []
    slots.push(source.slice(cursor).trim().length > 0)
    return slots
}

function assertHtmlTextSlotStructure(source: string, restored: string): void {
    const expected = collectHtmlTextSlotOccupancy(source)
    const actual = collectHtmlTextSlotOccupancy(restored)
    if (
        expected.length !== actual.length
        || expected.some((occupied, index) => actual[index] !== occupied)
    ) {
        throw new TranslationIntegrityError('The translation moved text across HTML structure.')
    }
}

/**
 * Replaces non-translatable structure with deterministic sentinels. The
 * original bytes stay only in this in-memory plan; neither the key nor its
 * semantic descriptor contains them.
 */
export async function protectTranslationSource(
    source: string,
    _sourceFormat: TranslationSourceFormat
): Promise<{ protectedSource: string, protectedTokens: ProtectedTranslationToken[] }> {
    if (source.includes(tokenPrefix)) {
        throw new TranslationIntegrityError('The source collides with the protected-token namespace.')
    }

    const ranges = findProtectedRanges(source)
    const protectedTokens: ProtectedTranslationToken[] = []
    let protectedSource = ''
    let cursor = 0

    for (let index = 0; index < ranges.length; index++) {
        const range = ranges[index]
        const value = source.slice(range.start, range.end)
        const valueHash = (await sha256(value)).slice(0, 16)
        const token = `${tokenPrefix}${index.toString().padStart(6, '0')}_${valueHash}__`
        protectedSource += source.slice(cursor, range.start) + token
        protectedTokens.push({ token, value })
        cursor = range.end
    }

    protectedSource += source.slice(cursor)
    return { protectedSource, protectedTokens }
}

/** Restores protected bytes only when every sentinel survived exactly once and in order. */
export function restoreProtectedTranslationSource(
    translated: string,
    protectedTokens: readonly ProtectedTranslationToken[]
): string {
    const found = translated.match(protectedTokenRegex) ?? []
    const expected = protectedTokens.map(({ token }) => token)

    if (found.length !== expected.length || found.some((token, index) => token !== expected[index])) {
        throw new TranslationIntegrityError()
    }

    let restored = translated
    for (const { token, value } of protectedTokens) {
        const first = restored.indexOf(token)
        if (first === -1 || restored.indexOf(token, first + token.length) !== -1) {
            throw new TranslationIntegrityError()
        }
        restored = restored.slice(0, first) + value + restored.slice(first + token.length)
    }

    if (restored.includes(tokenPrefix)) {
        throw new TranslationIntegrityError()
    }
    return restored
}

export async function prepareTranslationPlan(input: TranslationPlanInput): Promise<TranslationPlanV1> {
    const context: TranslationContext = {
        characterId: input.context.characterId,
        chatId: input.context.chatId,
        messageId: input.context.messageId,
        translatorNote: input.context.translatorNote ?? '',
    }
    const { protectedSource, protectedTokens } = await protectTranslationSource(
        input.source,
        input.sourceFormat
    )
    const descriptor: TranslationSemanticDescriptorV1 = {
        schemaVersion: 1,
        pipelineVersion: 'translation-core-v1',
        tokenizerVersion: 'protected-token-v2',
        sourceHash: await sha256(input.source),
        sourceFormat: input.sourceFormat,
        sourceLanguage: normalizedLanguage(input.sourceLanguage),
        targetLanguage: normalizedLanguage(input.targetLanguage),
        engine: input.engine,
        presetId: input.presetId ?? null,
        presetNameHash: await sha256(input.presetName ?? ''),
        promptHash: await sha256(input.prompt),
        maxTokens: input.maxTokens,
        model: input.model,
        fallbackModels: [...(input.fallbackModels ?? [])],
        characterContextHash: await sha256(context.characterId ?? ''),
        chatContextHash: await sha256(context.chatId ?? ''),
        messageContextHash: await sha256(context.messageId ?? ''),
        translatorNoteHash: await sha256(context.translatorNote),
        engineOptionsHash: await sha256(stableTranslationJson(input.engineOptions ?? null)),
    }
    const key = `translation:v1:${await sha256(stableTranslationJson(descriptor))}`

    return {
        schemaVersion: 1,
        key,
        descriptor,
        source: input.source,
        protectedSource,
        protectedTokens,
        context: Object.freeze(context),
    }
}

/**
 * Manual corrections intentionally survive provider/preset/note changes. They
 * remain scoped to the source, target language, format, and stable
 * character/chat/message identity so another message is never overwritten.
 */
export async function createManualTranslationCacheKey(
    input: ManualTranslationCacheKeyInput
): Promise<string> {
    const descriptor = {
        schemaVersion: 1,
        pipelineVersion: 'translation-manual-v1',
        sourceHash: await sha256(input.source),
        sourceFormat: input.sourceFormat,
        targetLanguage: normalizedLanguage(input.targetLanguage),
        characterContextHash: await sha256(input.context.characterId ?? ''),
        chatContextHash: await sha256(input.context.chatId ?? ''),
        messageContextHash: await sha256(input.context.messageId ?? ''),
    }
    return `translation:manual:v1:${await sha256(stableTranslationJson(descriptor))}`
}

export function finalizeTranslation(plan: TranslationPlanV1, coreResult: string): string {
    const restored = restoreProtectedTranslationSource(coreResult, plan.protectedTokens)
    assertMarkdownLinkStructure(plan.source, restored)
    assertHtmlTextSlotStructure(plan.source, restored)
    return restored
}

export function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError'
}

export function createTranslationAbortError(signal?: AbortSignal): Error {
    const reason = signal?.reason
    if (reason instanceof Error && reason.name === 'AbortError') {
        return reason
    }
    if (typeof DOMException !== 'undefined') {
        return new DOMException(
            typeof reason === 'string' ? reason : 'The operation was aborted.',
            'AbortError'
        )
    }
    const error = new Error(typeof reason === 'string' ? reason : 'The operation was aborted.')
    error.name = 'AbortError'
    return error
}

export function throwIfTranslationAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw createTranslationAbortError(signal)
    }
}
