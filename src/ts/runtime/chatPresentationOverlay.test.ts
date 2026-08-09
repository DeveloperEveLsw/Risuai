import { beforeEach, describe, expect, it } from 'vitest'
import { get } from 'svelte/store'
import {
    bindRuntimeChatPresentationCommand,
    clearRuntimeChatPresentationOverlays,
    createRuntimeChatPresentationOverlay,
    ensureRuntimeChatPresentationOverlay,
    getRuntimeChatPresentationOverlay,
    markRuntimeChatOverlayCanonical,
    removeRuntimeChatPresentationOverlay,
    reserveRuntimeChatPresentationRequest,
    resolveRuntimeChatPresentationText,
    runtimeChatPresentationOverlays,
    settleRuntimeChatOverlay,
    visibleRuntimeChatPresentationOverlays,
} from './chatPresentationOverlay.svelte'

describe('runtime chat presentation overlays', () => {
    beforeEach(() => clearRuntimeChatPresentationOverlays())

    it('matches canonical says-nothing semantics for continue commands', () => {
        expect(resolveRuntimeChatPresentationText({
            input: '',
            files: [],
            useSayNothing: true,
            isGroup: false,
            lastRole: 'char',
            continueResponse: true,
        })).toBe('*says nothing*')
        expect(resolveRuntimeChatPresentationText({
            input: '',
            useSayNothing: true,
            isGroup: false,
            lastRole: 'user',
            continueResponse: true,
        })).toBe('')
    })

    it('keeps pending chat presentation outside the canonical database', () => {
        const canonicalMessages = [{ role: 'char', data: 'existing' }]
        createRuntimeChatPresentationOverlay({
            requestId: 'request-1',
            characterId: 'character-1',
            chatId: 'chat-1',
            input: 'hello',
            files: ['asset-1'],
            baseRevision: 14,
        })

        expect(canonicalMessages).toEqual([{ role: 'char', data: 'existing' }])
        expect(get(runtimeChatPresentationOverlays)).toEqual([
            expect.objectContaining({
                requestId: 'request-1',
                displayText: 'hello{{inlayed::asset-1}}',
                phase: 'submitting',
                baseRevision: 14,
            }),
        ])
    })

    it('binds an accepted command and hides it when input_committed is canonical', () => {
        createRuntimeChatPresentationOverlay({
            requestId: 'request-1',
            characterId: 'character-1',
            chatId: 'chat-1',
            input: 'hello',
            baseRevision: 14,
        })
        bindRuntimeChatPresentationCommand('request-1', {
            commandId: 'command-1',
            state: 'queued',
        })

        expect(getRuntimeChatPresentationOverlay('command-1')).toEqual(expect.objectContaining({
            commandId: 'command-1',
            phase: 'queued',
        }))
        expect(get(visibleRuntimeChatPresentationOverlays)).toHaveLength(1)

        markRuntimeChatOverlayCanonical('command-1', {
            requestId: 'request-1',
            canonicalRevision: 15,
            messageId: 'message-1',
        })

        expect(get(visibleRuntimeChatPresentationOverlays)).toHaveLength(0)
        expect(getRuntimeChatPresentationOverlay('command-1')).toEqual(expect.objectContaining({
            canonicalRevision: 15,
            canonicalMessageId: 'message-1',
        }))
    })

    it('buffers only an exactly reserved local request before command binding', () => {
        reserveRuntimeChatPresentationRequest('request-1')
        markRuntimeChatOverlayCanonical('unrelated-command', {
            requestId: 'another-request',
            canonicalRevision: 15,
            messageId: 'unrelated-message',
        })
        markRuntimeChatOverlayCanonical('command-1', {
            requestId: 'request-1',
            canonicalRevision: 16,
            messageId: 'message-1',
        })

        createRuntimeChatPresentationOverlay({
            requestId: 'request-1',
            characterId: 'character-1',
            chatId: 'chat-1',
            input: 'large payload admitted now',
            baseRevision: 14,
        })
        bindRuntimeChatPresentationCommand('request-1', {
            commandId: 'unrelated-command',
            state: 'running',
        })
        expect(getRuntimeChatPresentationOverlay('unrelated-command')).toEqual(expect.objectContaining({
            canonicalRevision: null,
        }))

        clearRuntimeChatPresentationOverlays()
        reserveRuntimeChatPresentationRequest('request-1')
        markRuntimeChatOverlayCanonical('command-1', {
            requestId: 'request-1',
            canonicalRevision: 16,
            messageId: 'message-1',
        })
        createRuntimeChatPresentationOverlay({
            requestId: 'request-1',
            characterId: 'character-1',
            chatId: 'chat-1',
            input: 'large payload admitted now',
            baseRevision: 14,
        })
        bindRuntimeChatPresentationCommand('request-1', {
            commandId: 'command-1',
            state: 'running',
        })
        expect(getRuntimeChatPresentationOverlay('command-1')).toEqual(expect.objectContaining({
            canonicalRevision: 16,
            canonicalMessageId: 'message-1',
        }))
    })

    it('retains terminal reconciliation metadata until the caller removes it', () => {
        createRuntimeChatPresentationOverlay({
            requestId: 'request-1',
            characterId: 'character-1',
            chatId: 'chat-1',
            input: 'hello',
            baseRevision: 14,
        })
        bindRuntimeChatPresentationCommand('request-1', { commandId: 'command-1' })
        settleRuntimeChatOverlay('command-1', {
            state: 'cancelled',
            terminalRevision: 16,
            canonicalMutationPersisted: false,
        })

        expect(getRuntimeChatPresentationOverlay('command-1')).toEqual(expect.objectContaining({
            phase: 'terminal',
            terminalState: 'cancelled',
            terminalRevision: 16,
            canonicalMutationPersisted: false,
        }))

        removeRuntimeChatPresentationOverlay('command-1')
        expect(get(runtimeChatPresentationOverlays)).toEqual([])
    })

    it('idempotently reconstructs an accepted command on another browser', () => {
        const accepted = {
            requestId: 'request-1',
            commandId: 'command-1',
            characterId: 'character-1',
            chatId: 'chat-1',
            input: 'hello',
            files: ['asset-1'],
            createdAt: 123,
            baseRevision: 14,
            state: 'queued' as const,
        }

        ensureRuntimeChatPresentationOverlay(accepted)
        ensureRuntimeChatPresentationOverlay({ ...accepted, state: 'running' })

        expect(get(runtimeChatPresentationOverlays)).toHaveLength(1)
        expect(getRuntimeChatPresentationOverlay('command-1')).toEqual(expect.objectContaining({
            requestId: 'request-1',
            displayText: 'hello{{inlayed::asset-1}}',
            phase: 'running',
            createdAt: 123,
        }))
        expect(() => ensureRuntimeChatPresentationOverlay({
            ...accepted,
            requestId: 'different-request',
        })).toThrow(/identity disagrees/)
    })

    it('reconciles an adopted input_committed event that races ahead of the create ACK', () => {
        createRuntimeChatPresentationOverlay({
            requestId: 'request-1',
            characterId: 'character-1',
            chatId: 'chat-1',
            input: 'hello',
            baseRevision: 14,
        })

        markRuntimeChatOverlayCanonical('command-1', {
            requestId: 'request-1',
            canonicalRevision: 15,
            messageId: 'message-1',
        })
        expect(get(visibleRuntimeChatPresentationOverlays)).toHaveLength(1)

        bindRuntimeChatPresentationCommand('request-1', {
            commandId: 'command-1',
            state: 'running',
        })

        expect(get(visibleRuntimeChatPresentationOverlays)).toHaveLength(0)
        expect(getRuntimeChatPresentationOverlay('command-1')).toEqual(expect.objectContaining({
            phase: 'running',
            canonicalRevision: 15,
            canonicalMessageId: 'message-1',
        }))
    })

    it('discards pre-ACK reconciliation when its exact request is abandoned', () => {
        reserveRuntimeChatPresentationRequest('request-1')
        markRuntimeChatOverlayCanonical('command-1', {
            requestId: 'request-1',
            canonicalRevision: 15,
            messageId: 'message-1',
        })
        settleRuntimeChatOverlay('command-1', {
            requestId: 'request-1',
            state: 'failed',
            terminalRevision: 15,
        })

        removeRuntimeChatPresentationOverlay('request-1')
        createRuntimeChatPresentationOverlay({
            requestId: 'request-1',
            characterId: 'character-1',
            chatId: 'chat-1',
            input: 'retry',
            baseRevision: 15,
        })
        bindRuntimeChatPresentationCommand('request-1', {
            commandId: 'command-1',
            state: 'queued',
        })

        expect(getRuntimeChatPresentationOverlay('command-1')).toEqual(expect.objectContaining({
            phase: 'queued',
            canonicalRevision: null,
            terminalState: null,
        }))
    })

    it('validates revision boundaries and duplicate request IDs', () => {
        expect(() => createRuntimeChatPresentationOverlay({
            requestId: 'request-1',
            characterId: 'character-1',
            chatId: 'chat-1',
            input: 'hello',
            baseRevision: -1,
        })).toThrow(TypeError)

        createRuntimeChatPresentationOverlay({
            requestId: 'request-1',
            characterId: 'character-1',
            chatId: 'chat-1',
            input: 'hello',
            baseRevision: 0,
        })
        expect(() => createRuntimeChatPresentationOverlay({
            requestId: 'request-1',
            characterId: 'character-1',
            chatId: 'chat-1',
            input: 'again',
            baseRevision: 0,
        })).toThrow(/already exists/)
    })
})
