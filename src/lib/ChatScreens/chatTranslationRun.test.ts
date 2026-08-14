import { describe, expect, it } from 'vitest'
import {
    applyCachedTranslationEditScripts,
    createChatTranslationIdentityKey,
    createChatTranslationScopeKey,
    snapshotChatTranslationSettings,
    TranslationResultHandoff,
} from './chatTranslationRun'

const baseIdentity = () => ({
    source: 'source-a',
    manualSource: 'raw-source-a',
    displayCharacter: 'speaker-a',
    translationCharacter: null,
    chatId: 4,
    firstMessage: false,
    role: 'char',
    context: {
        characterId: 'group-a',
        chatId: 'room-a',
        messageId: 'message-a',
        translatorNote: '',
    },
    settings: {
        translator: 'ko',
        preset: 'preset-a',
        translateBeforeHTMLFormatting: false,
    },
    cacheRevision: 0,
    presentationRevision: 0,
})

describe('chat translation run identity', () => {
    it('changes for source, settings, canonical context, and script owner independently', () => {
        const base = createChatTranslationIdentityKey(baseIdentity())
        expect(createChatTranslationIdentityKey({ ...baseIdentity(), source: 'source-b' })).not.toBe(base)
        expect(createChatTranslationIdentityKey({
            ...baseIdentity(),
            manualSource: 'raw-source-b',
        })).not.toBe(base)
        expect(createChatTranslationIdentityKey({
            ...baseIdentity(),
            settings: { ...baseIdentity().settings, translator: 'ja' },
        })).not.toBe(base)
        expect(createChatTranslationIdentityKey({
            ...baseIdentity(),
            context: { ...baseIdentity().context, chatId: 'room-b' },
        })).not.toBe(base)
        expect(createChatTranslationIdentityKey({
            ...baseIdentity(),
            translationCharacter: 'speaker-a',
        })).not.toBe(base)
        expect(createChatTranslationIdentityKey({
            ...baseIdentity(),
            cacheRevision: 1,
        })).not.toBe(base)
        expect(createChatTranslationIdentityKey({
            ...baseIdentity(),
            presentationRevision: 1,
        })).not.toBe(base)
    })

    it('rejects stale and ABA completions while preserving a completed same-identity handoff', () => {
        const handoff = new TranslationResultHandoff<string>()
        const firstA = handoff.begin('A')
        const b = handoff.begin('B')
        expect(handoff.publish(firstA, 'stale A')).toBe(false)
        expect(handoff.publish(b, 'result B')).toBe(true)
        expect(handoff.read('B')).toBe('result B')

        const secondA = handoff.begin('A')
        expect(handoff.publish(firstA, 'ABA stale A')).toBe(false)
        expect(handoff.publish(secondA, 'fresh A')).toBe(true)
        expect(handoff.begin('A')).toMatchObject({ identityKey: 'A' })
        expect(handoff.read('A')).toBe('fresh A')
    })

    it('shares canonical scope across display speakers while retaining context boundaries', () => {
        const base = createChatTranslationScopeKey(baseIdentity())
        expect(createChatTranslationScopeKey({
            ...baseIdentity(),
            displayCharacter: 'another-speaker',
        })).toBe(base)
        expect(createChatTranslationScopeKey({
            ...baseIdentity(),
            context: { ...baseIdentity().context, messageId: 'message-b' },
        })).not.toBe(base)
    })

    it('fences effective Ollama, persona username, and current-character name changes', () => {
        const db = {
            ollamaModelSource: 'local',
            selectedPersona: 0,
            personas: [{ name: 'Persona A' }],
            username: 'Fallback User',
        }
        const identityFor = (
            settings: unknown,
        ) => createChatTranslationIdentityKey({ ...baseIdentity(), settings })
        const base = identityFor(snapshotChatTranslationSettings(db, {
            userName: 'Persona A',
            currentCharacterName: 'Character A',
        }))

        expect(identityFor(snapshotChatTranslationSettings({
            ...db,
            ollamaModelSource: 'cloud',
        }, {
            userName: 'Persona A',
            currentCharacterName: 'Character A',
        }))).not.toBe(base)
        expect(identityFor(snapshotChatTranslationSettings({
            ...db,
            selectedPersona: 1,
            personas: [...db.personas, { name: 'Persona B' }],
        }, {
            userName: 'Persona B',
            currentCharacterName: 'Character A',
        }))).not.toBe(base)
        expect(identityFor(snapshotChatTranslationSettings(db, {
            userName: 'Persona A',
            currentCharacterName: 'Character B',
        }))).not.toBe(base)
    })
})

describe('cached translation edittrans handoff', () => {
    const moduleScript = {
        type: 'edittrans',
        in: 'module',
        out: 'MODULE',
        ableFlag: false,
        flag: 'g',
        comment: '',
    } as const
    const speakerScript = {
        type: 'edittrans',
        in: 'speaker',
        out: 'SPEAKER',
        ableFlag: false,
        flag: 'g',
        comment: '',
    } as const

    it('uses the selected group rather than the display speaker as the canonical script owner', () => {
        const groupScript = {
            ...speakerScript,
            in: 'group',
            out: 'GROUP',
        }
        const result = applyCachedTranslationEditScripts(
            'module group speaker',
            'group-a',
            [moduleScript],
            (id) => ({ customscript: id === 'group-a' ? [groupScript] : [speakerScript] }),
        )
        expect(result).toBe('MODULE GROUP speaker')
    })

    it('uses the explicit canonical character scripts and preserves the empty-string opt-out', () => {
        const resolve = () => ({ customscript: [speakerScript] })
        expect(applyCachedTranslationEditScripts(
            'module speaker',
            'speaker-a',
            [moduleScript],
            resolve,
        )).toBe('MODULE SPEAKER')
        expect(applyCachedTranslationEditScripts(
            'module speaker',
            '',
            [moduleScript],
            resolve,
        )).toBe('module speaker')
    })
})
