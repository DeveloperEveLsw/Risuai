import { describe, expect, it } from 'vitest'
import {
    TranslationIntegrityError,
    finalizeTranslation,
    prepareTranslationPlan,
    stableTranslationJson,
    type TranslationPlanInput,
} from './translationPlan'

const baseInput: TranslationPlanInput = {
    source: 'private source text',
    sourceFormat: 'plain',
    sourceLanguage: 'EN',
    targetLanguage: 'ko_KR',
    engine: 'llm',
    presetId: 2,
    presetName: 'Private preset',
    prompt: 'Translate {{slot::content}}.',
    maxTokens: 500,
    model: 'model-a',
    fallbackModels: ['model-b'],
    context: {
        characterId: 'character-a',
        chatId: 'chat-a',
        messageId: 'message-a',
        translatorNote: 'secret character note',
    },
    engineOptions: { temperature: 0.4 },
}

describe('TranslationPlanV1 semantic key', () => {
    it('sorts mixed-case and non-ASCII settings by locale-independent code units', () => {
        expect(stableTranslationJson({ '한': 5, 'ä': 4, a: 3, Z: 2, A: 1 })).toBe(
            '{"A":1,"Z":2,"a":3,"ä":4,"한":5}'
        )
    })

    it.each([
        ['source language', { sourceLanguage: 'ja' }],
        ['target language', { targetLanguage: 'fr' }],
        ['source', { source: 'another source' }],
        ['format', { sourceFormat: 'html-segments-v1' as const }],
        ['preset', { presetId: 3 }],
        ['prompt', { prompt: 'A different prompt' }],
        ['max tokens', { maxTokens: 900 }],
        ['model', { model: 'model-c' }],
        ['fallback model', { fallbackModels: ['model-d'] }],
        ['character context', { context: { ...baseInput.context, characterId: 'character-b' } }],
        ['chat context', { context: { ...baseInput.context, chatId: 'chat-b' } }],
        ['message context', { context: { ...baseInput.context, messageId: 'message-b' } }],
        ['note', { context: { ...baseInput.context, translatorNote: 'another note' } }],
        ['engine options', { engineOptions: { temperature: 0.7 } }],
    ])('changes when %s changes', async (_name, change) => {
        const first = await prepareTranslationPlan(baseInput)
        const second = await prepareTranslationPlan({ ...baseInput, ...change })

        expect(second.key).not.toBe(first.key)
    })

    it('normalizes language spelling and excludes UI-only force state', async () => {
        const first = await prepareTranslationPlan(baseInput)
        const second = await prepareTranslationPlan({
            ...baseInput,
            sourceLanguage: ' en ',
            targetLanguage: 'KO-kr',
        })

        expect(second.key).toBe(first.key)
    })

    it('does not expose source, prompt, preset name, or translator note in the key descriptor', async () => {
        const plan = await prepareTranslationPlan(baseInput)
        const publicMaterial = `${plan.key}\n${JSON.stringify(plan.descriptor)}`

        expect(publicMaterial).not.toContain(baseInput.source)
        expect(publicMaterial).not.toContain(baseInput.prompt)
        expect(publicMaterial).not.toContain(baseInput.presetName)
        expect(publicMaterial).not.toContain(baseInput.context.translatorNote)
        expect(plan.key).toMatch(/^translation:v1:[a-f0-9]{64}$/)
    })
})

describe('TranslationPlanV1 protected structure', () => {
    it('round-trips style, media/raw directives, script/style blocks, and HTML bytes exactly', async () => {
        const protectedBytes = [
            '<risu-style>2e666f6f7b636f6c6f723a7265647d</risu-style>',
            '<div class="card" data-value="> literal">',
            '<img src="asset.webp" alt="private">',
            '{{img::portrait.webp}}',
            '{{video::clip.mp4}}',
            '{{audio::voice.mp3}}',
            '{{raw <span data-x="1">do not translate</span>}}',
            '<style>.private { color: red }</style>',
            '<script>window.privateValue = "secret"</script>',
            '</div>',
        ]
        const source = `${protectedBytes[0]}\n${protectedBytes[1]}Hello${protectedBytes.slice(2).join('\n')} `
        const plan = await prepareTranslationPlan({
            ...baseInput,
            source,
            sourceFormat: 'html-segments-v1',
        })
        const translated = plan.protectedSource.replace('Hello', '안녕하세요')
        const restored = finalizeTranslation(plan, translated)

        expect(restored).toBe(source.replace('Hello', '안녕하세요'))
        for (const value of protectedBytes) {
            expect(restored).toContain(value)
        }
        expect(restored).toContain('<risu-style>')
        expect(restored).toContain('</risu-style>')
    })

    it('protects raw-path HTML and the parser structural directive allowlist byte-for-byte', async () => {
        const directives = [
            '{{asset::portrait card}}',
            '{{emotion::smile}}',
            '{{audio::voice.mp3}}',
            '{{bg::room}}',
            '{{bgm::theme}}',
            '{{video::clip.mp4}}',
            '{{video-img::preview}}',
            '{{image::portrait.webp}}',
            '{{img::portrait.webp}}',
            '{{path::font-file}}',
            '{{raw::font-file}}',
            '{{inlay::attachment-a}}',
            '{{inlayed::attachment-b}}',
            '{{inlayeddata::attachment-c}}',
            '{{source::char}}',
            '{{position::sidebar}}',
            '{{button::Do not translate::trigger::exact payload}}',
            '{{file::private.bin::AAECAwQ=}}',
            '{{assetlist}}',
            '{{emotionlist}}',
            '{{moduleassetlist::module-a}}',
            '{{risu::60}}',
        ]
        const buttonOpen = '<button class="button-default" risu-trigger="send::exact payload">'
        const source = `Translate this.\n${directives.join('\n')}\n${buttonOpen}Click me</button>`
        const plan = await prepareTranslationPlan({ ...baseInput, source, sourceFormat: 'plain' })
        const translated = plan.protectedSource
            .replace('Translate this.', '이 문장을 번역합니다.')
            .replace('Click me', '클릭하세요')
        const restored = finalizeTranslation(plan, translated)

        expect(restored).toBe(
            source.replace('Translate this.', '이 문장을 번역합니다.').replace('Click me', '클릭하세요')
        )
        for (const directive of directives) {
            expect(plan.protectedSource).not.toContain(directive)
            expect(restored).toContain(directive)
        }
        expect(restored).toContain(buttonOpen)
    })

    it('protects fenced and inline Markdown code while leaving adjacent prose translatable', async () => {
        const fenced = [
            '```ts',
            'const exact = `do not translate`',
            '{{custom::code payload}}',
            '```',
            '~~~html',
            '<button data-action="exact">Do not translate</button>',
            '~~~~',
        ].join('\n')
        const inline = '`const exact = "private"` and ``code with a ` tick``'
        const indented = '    npm run exact\n\tconst privateValue = 1'
        const htmlCode = '<pre data-mode="exact"><code>do_not_translate()</code></pre>'
        const source = `Translate before.\n${fenced}\n\n${indented}\n\n${htmlCode}\nTranslate ${inline} after.`
        const plan = await prepareTranslationPlan({ ...baseInput, source, sourceFormat: 'plain' })
        const translated = plan.protectedSource
            .replace('Translate before.', '앞 문장 번역.')
            .replace('Translate ', '번역 ')
            .replace(' after.', ' 이후.')
        const restored = finalizeTranslation(plan, translated)

        expect(restored).toBe(
            source
                .replace('Translate before.', '앞 문장 번역.')
                .replace('Translate ', '번역 ')
                .replace(' after.', ' 이후.')
        )
        expect(restored).toContain(fenced)
        expect(restored).toContain(indented)
        expect(restored).toContain(htmlCode)
        expect(restored).toContain(inline)
    })

    it('protects Markdown link destinations but leaves link labels and image alt text translatable', async () => {
        const linkDestination = '(https://example.test/a_(b)?next=one\\)two "exact title")'
        const imageDestination = '(<risu-assets/image path.webp> "exact image title")'
        const referenceDefinition = '[private-ref]: https://example.test/reference_(exact)'
        const source = [
            `Read [link label]${linkDestination}.`,
            `See ![image alt]${imageDestination}.`,
            '[reference label][private-ref].',
            referenceDefinition,
        ].join('\n')
        const plan = await prepareTranslationPlan({ ...baseInput, source, sourceFormat: 'plain' })
        const translated = plan.protectedSource
            .replace('Read ', '읽기 ')
            .replace('link label', '링크 레이블')
            .replace('See ', '보기 ')
            .replace('image alt', '이미지 설명')
            .replace('reference label', '참조 레이블')
            .replaceAll('private-ref', 'translated-reference-id')
        const restored = finalizeTranslation(plan, translated)

        expect(restored).toContain(`[링크 레이블]${linkDestination}`)
        expect(restored).toContain(`![이미지 설명]${imageDestination}`)
        expect(restored).toContain('[참조 레이블][private-ref]')
        expect(restored).toContain(referenceDefinition)
        expect(plan.protectedSource).not.toContain('[private-ref]')
    })

    it('keeps collapsed/shortcut reference identities and definition titles exact', async () => {
        const collapsed = '[Collapsed Label][]'
        const shortcut = '[Shortcut Label]'
        const collapsedDefinition = '[Collapsed Label]: https://example.test/collapsed "Exact title"'
        const shortcutDefinition = "[Shortcut Label]: <https://example.test/shortcut> 'Exact shortcut title'"
        const source = [
            `Read ${collapsed} and ${shortcut}.`,
            '',
            collapsedDefinition,
            shortcutDefinition,
        ].join('\n')
        const plan = await prepareTranslationPlan({ ...baseInput, source, sourceFormat: 'plain' })
        const translated = plan.protectedSource
            .replace('Read ', '읽기 ')
            .replaceAll('Collapsed Label', '번역된 축약 레이블')
            .replaceAll('Shortcut Label', '번역된 단축 레이블')
            .replaceAll('Exact title', '변조된 제목')
        const restored = finalizeTranslation(plan, translated)

        expect(restored).toContain(`읽기 ${collapsed} and ${shortcut}.`)
        expect(restored).toContain(collapsedDefinition)
        expect(restored).toContain(shortcutDefinition)
        expect(plan.protectedSource).not.toContain(collapsed)
        expect(plan.protectedSource).not.toContain(shortcutDefinition)
    })

    it.each([
        {
            name: 'inline destination',
            source: 'Read [Hello](https://example.test/exact).',
            corrupt: (protectedSource: string, token: string) => protectedSource
                .replace(`[Hello]${token}`, `Hello ${token}`),
        },
        {
            name: 'reference identifier',
            source: 'Read [Hello][exact-ref].\n[exact-ref]: https://example.test/exact',
            corrupt: (protectedSource: string, token: string) => protectedSource
                .replace(`[Hello]${token}`, `${token} [Hello]`),
        },
    ])('fails closed when a provider detaches a $name from its label', async ({ source, corrupt }) => {
        const plan = await prepareTranslationPlan({ ...baseInput, source, sourceFormat: 'plain' })
        const destinationToken = plan.protectedTokens.find(({ value }) => (
            value.startsWith('(') || value.startsWith('[')
        ))
        expect(destinationToken).toBeTruthy()

        expect(() => finalizeTranslation(
            plan,
            corrupt(plan.protectedSource, destinationToken!.token),
        )).toThrow(TranslationIntegrityError)
    })

    it('fails closed when translated text is moved outside its original HTML element', async () => {
        const source = '<a href="https://example.test/exact">Click</a>'
        const plan = await prepareTranslationPlan({
            ...baseInput,
            source,
            sourceFormat: 'html-segments-v1',
        })
        const [opening, closing] = plan.protectedTokens.map(({ token }) => token)
        expect(opening).toBeTruthy()
        expect(closing).toBeTruthy()

        expect(() => finalizeTranslation(
            plan,
            `클릭 ${opening}${closing}`,
        )).toThrow(TranslationIntegrityError)
    })

    it('does not hide arbitrary natural-language macros outside the structural allowlist', async () => {
        const source = 'Translate {{custom::natural language payload}}.'
        const plan = await prepareTranslationPlan({ ...baseInput, source, sourceFormat: 'plain' })

        expect(plan.protectedSource).toContain('{{custom::natural language payload}}')
        expect(finalizeTranslation(
            plan,
            plan.protectedSource.replace('natural language payload', '자연어 내용')
        )).toBe('Translate {{custom::자연어 내용}}.')
    })

    it.each(['missing', 'duplicate', 'mutated', 'reordered'])(
        'fails closed for a %s protected token',
        async (kind) => {
            const plan = await prepareTranslationPlan({
                ...baseInput,
                source: '<b>Hello</b>{{img::a.png}}',
                sourceFormat: 'html-segments-v1',
            })
            const [first, second] = plan.protectedTokens.map(({ token }) => token)
            let corrupt = plan.protectedSource
            if (kind === 'missing') corrupt = corrupt.replace(first, '')
            if (kind === 'duplicate') corrupt += first
            if (kind === 'mutated') corrupt = corrupt.replace(first, first.replace('RISU', 'RIXU'))
            if (kind === 'reordered') corrupt = corrupt.replace(first, 'TEMP').replace(second, first).replace('TEMP', second)

            expect(() => finalizeTranslation(plan, corrupt)).toThrow(TranslationIntegrityError)
        }
    )
})
