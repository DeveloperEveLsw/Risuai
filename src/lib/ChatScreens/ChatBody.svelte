<script lang="ts">
    import { DBState } from 'src/ts/stores.svelte'
    import { getUserName, sleep } from "src/ts/util"
    import { alertError } from "../../ts/alert"
    import { addMetadataToElement, finalizePreparedMarkdown, getDistance, ParseMarkdown, ParseMarkdownReadOnlyPresentation, postTranslationParse, prepareMarkdownDisplay, trimMarkdown, trimMarkdownReadOnlyPresentation, type CbsConditions, type PreparedMarkdownDisplay, type simpleCharacterArgument } from "../../ts/parser/parser.svelte"
    import {
        getLLMCache,
        getLLMCacheIdentity,
        resolveTranslationContext,
        subscribeTranslationCacheMutations,
        TranslationProviderError,
        translateHTML,
        type TranslationCacheMutationEvent,
    } from "../../ts/translator/translator"
    import { isAbortError, throwIfTranslationAborted, TranslationIntegrityError, type TranslationContext, type TranslationSourceFormat } from "../../ts/translator/translationPlan"
    import { getModuleAssets, getModuleRegexScripts } from "src/ts/process/modules";
    import { getCurrentCharacter } from "src/ts/storage/database.svelte";
    import { getFileSrc } from "src/ts/globalApi.svelte";
    import { getAbortSignal, onDestroy } from "svelte";
    import {
        applyCachedTranslationEditScripts,
        createChatTranslationIdentityKey,
        createChatTranslationScopeKey,
        snapshotChatTranslationSettings,
        TranslationResultHandoff,
        type ChatTranslationCharacter,
        type ManualTranslationPreparedTarget,
        type ManualTranslationPresentationHandoff,
        type TranslationRunToken,
    } from './chatTranslationRun'

    interface Props {
        character?: simpleCharacterArgument|string|null
        translationCharacter?: simpleCharacterArgument|string|null
        manualTranslationPresentation?: ManualTranslationPresentationHandoff | null
        onManualTranslationTargetPrepared?: (target: ManualTranslationPreparedTarget) => void
        firstMessage?: boolean
        idx?: number
        msgDisplay?: string
        translationManualSource?: string
        name?: string
        role: string|null
        translated: boolean
        translating: boolean
        retranslate: boolean
        bodyRoot?: HTMLElement|null
        modelShortName: string
        renderRawStreaming?: boolean
        rawStreamingText?: string
        readOnlyPresentation?: boolean
        displayRevision?: string
    }

    let {
        character = null,
        translationCharacter = undefined,
        manualTranslationPresentation = null,
        onManualTranslationTargetPrepared = () => {},
        idx = 0,
        firstMessage = false,
        msgDisplay,
        translationManualSource = undefined,
        role,
        translated = $bindable(false),
        translating = $bindable(false),
        retranslate = $bindable(false),
        bodyRoot,
        modelShortName = '',
        renderRawStreaming = false,
        rawStreamingText = '',
        readOnlyPresentation = false,
        displayRevision = '',
    }: Props =  $props()

    let lastParsed = $state('')
    let retainedRawStreamingText = $state<string | null>(null)
    let activeIdentityKey = ''
    let activeCacheMutationRevision = 0
    let lastAutoDecisionIdentityKey = ''
    let pendingAutoTranslatedIdentityKey = ''
    let retranslateOperationIdentityKey = ''
    let retranslateFallback: { identityKey: string; rendered: string } | null = null
    let relevantCacheMutation = $state<TranslationCacheMutationEvent>({
        revision: 0,
        reason: 'clear',
        touchedKeys: [],
        scope: null,
    })
    let currentManualIdentityForMutation = ''
    let activePreparedTargetForMutation: ManualTranslationPreparedTarget | null = null
    const translationHandoff = new TranslationResultHandoff<string>()

    interface PreparedChatTranslation {
        identityKey: string
        data: string
        charArg: ChatTranslationCharacter
        chatID: number
        translateBeforeFormatting: boolean
        legacyTranslation: boolean
        firstMessage: boolean
        role: string | null
        cbsConditions: CbsConditions
        preparedDisplay: PreparedMarkdownDisplay | null
        translationInput: string
        sourceFormat: TranslationSourceFormat
        normalDisplay?: string
    }

    let preparedChatTranslation: PreparedChatTranslation | null = null

    let canonicalTranslationCharacter = $derived(
        translationCharacter === undefined ? character : translationCharacter
    )

    function getCbsCondition(): CbsConditions {
        try{
            const cbsConditions:CbsConditions = {
                firstmsg: firstMessage ?? false,
                chatRole: role,
            }
            return cbsConditions
        }
        catch(e){
            return {
                firstmsg: firstMessage ?? false,
                chatRole: null,
            }
        }
    }

    async function prepareChatTranslation(
        data: string,
        charArg: ChatTranslationCharacter,
        chatID: number,
        identityKey: string,
        cbsConditions: CbsConditions,
        translateBeforeFormatting: boolean,
        legacyTranslation: boolean,
        signal?: AbortSignal,
    ): Promise<PreparedChatTranslation> {
        const cached = preparedChatTranslation
        if (
            cached
            && cached.identityKey === identityKey
        ) {
            throwIfTranslationAborted(signal)
            return cached
        }

        let preparedDisplay: PreparedMarkdownDisplay | null = null
        let translationInput = data
        let sourceFormat: TranslationSourceFormat = 'plain'
        if (!translateBeforeFormatting) {
            preparedDisplay = await prepareMarkdownDisplay(data, charArg, chatID, cbsConditions)
            throwIfTranslationAborted(signal)
            translationInput = await finalizePreparedMarkdown(
                preparedDisplay,
                legacyTranslation ? 'notrim' : 'pretranslate'
            )
            sourceFormat = 'html-segments-v1'
        }

        throwIfTranslationAborted(signal)
        const prepared: PreparedChatTranslation = {
            identityKey,
            data,
            charArg,
            chatID,
            translateBeforeFormatting,
            legacyTranslation,
            firstMessage: !!firstMessage,
            role,
            cbsConditions,
            preparedDisplay,
            translationInput,
            sourceFormat,
        }
        preparedChatTranslation = prepared
        return prepared
    }

    async function getPreparedNormalDisplay(
        prepared: PreparedChatTranslation,
        signal?: AbortSignal,
    ): Promise<string> {
        if (!prepared.preparedDisplay) {
            const marked = await ParseMarkdown(
                prepared.data,
                prepared.charArg,
                'notrim',
                prepared.chatID,
                prepared.cbsConditions
            )
            throwIfTranslationAborted(signal)
            return marked
        }
        if (prepared.normalDisplay === undefined) {
            prepared.normalDisplay = await finalizePreparedMarkdown(prepared.preparedDisplay, 'notrim')
        }
        throwIfTranslationAborted(signal)
        return prepared.normalDisplay
    }

    interface ChatTranslationRunSnapshot {
        identityKey: string
        manualIdentityKey: string
        manualScopeKey: string
        presentationRevision: number
        cacheMutation: TranslationCacheMutationEvent
        manualTranslationCore: string | null
        manualTranslationTarget: ManualTranslationPreparedTarget | null
        manualSource: string
        context: TranslationContext
        displayCharacter: ChatTranslationCharacter
        translationCharacter: ChatTranslationCharacter
        cbsConditions: CbsConditions
        autoTranslate: boolean
        cachedOnly: boolean
        translatorType: string
        translateBeforeFormatting: boolean
        legacyTranslation: boolean
    }

    function createTranslationRunSnapshot(
        data: string,
        displayCharacter: ChatTranslationCharacter,
        translationOwner: ChatTranslationCharacter,
        chatID: number,
    ): ChatTranslationRunSnapshot {
        const context = resolveTranslationContext(translationOwner, chatID)
        const cbsConditions = getCbsCondition()
        const currentCharacter = getCurrentCharacter()
        const settings = snapshotChatTranslationSettings(
            DBState.db as unknown as Record<string, any>,
            {
                userName: getUserName(),
                currentCharacterName: currentCharacter?.nickname || currentCharacter?.name,
            },
        )
        const cacheMutation = relevantCacheMutation
        const cacheRevision = 0
        const manualSource = translationManualSource ?? data
        const identityInput = {
            source: data,
            manualSource,
            displayCharacter,
            translationCharacter: translationOwner,
            chatId: chatID,
            firstMessage: !!firstMessage,
            role,
            context,
            settings,
            cacheRevision,
        }
        const manualIdentityKey = createChatTranslationIdentityKey(identityInput)
        currentManualIdentityForMutation = manualIdentityKey
        if (activePreparedTargetForMutation?.identityKey !== manualIdentityKey) {
            activePreparedTargetForMutation = null
        }
        const manualScopeKey = createChatTranslationScopeKey(identityInput)
        const currentManualPresentation = manualTranslationPresentation?.identityKey === manualIdentityKey
            ? manualTranslationPresentation
            : null
        const currentManualTarget = currentManualPresentation?.target?.identityKey === manualIdentityKey
            ? currentManualPresentation.target
            : null
        return {
            identityKey: createChatTranslationIdentityKey({
                ...identityInput,
                presentationRevision: currentManualPresentation?.revision ?? 0,
            }),
            manualIdentityKey,
            manualScopeKey,
            presentationRevision: currentManualPresentation?.revision ?? 0,
            cacheMutation,
            manualTranslationCore: currentManualPresentation?.core ?? null,
            manualTranslationTarget: currentManualTarget,
            manualSource,
            context,
            displayCharacter,
            translationCharacter: translationOwner,
            cbsConditions,
            autoTranslate: !!DBState.db.autoTranslate,
            cachedOnly: !!DBState.db.autoTranslateCachedOnly,
            translatorType: DBState.db.translatorType,
            translateBeforeFormatting: !!DBState.db.translateBeforeHTMLFormatting,
            legacyTranslation: !!DBState.db.legacyTranslation,
        }
    }

    function assertCurrentRun(token: TranslationRunToken, signal?: AbortSignal): void {
        throwIfTranslationAborted(signal)
        if (!translationHandoff.isCurrent(token)) {
            throw new DOMException('Superseded translation presentation.', 'AbortError')
        }
    }

    function scheduleForCurrentRun(token: TranslationRunToken, callback: () => void): void {
        setTimeout(() => {
            if (translationHandoff.isCurrent(token)) callback()
        }, 10)
    }

    function applyCachedEditTranslation(
        coreResult: string,
        translationOwner: ChatTranslationCharacter,
    ): string {
        return applyCachedTranslationEditScripts(
            coreResult,
            translationOwner,
            getModuleRegexScripts() ?? [],
            (id) => DBState.db.characters.find((entry) => entry.chaId === id),
        )
    }

    async function renderTranslatedCore(
        prepared: PreparedChatTranslation,
        coreResult: string,
        snapshot: ChatTranslationRunSnapshot,
        token: TranslationRunToken,
        signal?: AbortSignal,
    ): Promise<string> {
        let rendered: string
        if (snapshot.translateBeforeFormatting) {
            rendered = await ParseMarkdown(
                coreResult,
                prepared.charArg,
                'notrim',
                prepared.chatID,
                prepared.cbsConditions,
            )
        }
        else if (!snapshot.legacyTranslation) {
            rendered = await postTranslationParse(coreResult)
        }
        else {
            rendered = coreResult
        }
        assertCurrentRun(token, signal)
        return rendered
    }

    async function handOffManualTranslationTarget(
        prepared: PreparedChatTranslation,
        snapshot: ChatTranslationRunSnapshot,
        token: TranslationRunToken,
        signal?: AbortSignal,
    ): Promise<ManualTranslationPreparedTarget> {
        const cacheIdentity = await getLLMCacheIdentity(prepared.translationInput, {
            signal,
            context: snapshot.context,
            sourceFormat: prepared.sourceFormat,
            manualSource: snapshot.manualSource,
        })
        assertCurrentRun(token, signal)
        const target: ManualTranslationPreparedTarget = {
            identityKey: snapshot.manualIdentityKey,
            scopeKey: snapshot.manualScopeKey,
            translationInput: prepared.translationInput,
            manualSource: snapshot.manualSource,
            sourceFormat: prepared.sourceFormat,
            context: { ...snapshot.context },
            manualKey: cacheIdentity.manualKey,
            planKey: cacheIdentity.planKey,
            legacyKey: cacheIdentity.legacyKey,
        }
        activePreparedTargetForMutation = target
        onManualTranslationTargetPrepared(target)
        return target
    }

    function restoreManualPreparedTranslation(
        data: string,
        charArg: ChatTranslationCharacter,
        chatID: number,
        snapshot: ChatTranslationRunSnapshot,
        target: ManualTranslationPreparedTarget,
    ): PreparedChatTranslation {
        // The editor was opened from this exact prepared input. ChatBody is
        // unmounted while editing, so rebuilding editdisplay here could turn
        // a stateful/random A preparation into B immediately after saving.
        return {
            identityKey: snapshot.identityKey,
            data,
            charArg,
            chatID,
            translateBeforeFormatting: snapshot.translateBeforeFormatting,
            legacyTranslation: snapshot.legacyTranslation,
            firstMessage: !!firstMessage,
            role,
            cbsConditions: snapshot.cbsConditions,
            preparedDisplay: null,
            translationInput: target.translationInput,
            sourceFormat: target.sourceFormat,
        }
    }

    async function renderCachedTranslation(
        data: string,
        charArg: ChatTranslationCharacter,
        chatID: number,
        snapshot: ChatTranslationRunSnapshot,
        token: TranslationRunToken,
        signal?: AbortSignal,
    ): Promise<string | null> {
        const prepared = await prepareChatTranslation(
            data,
            charArg,
            chatID,
            snapshot.identityKey,
            snapshot.cbsConditions,
            snapshot.translateBeforeFormatting,
            snapshot.legacyTranslation,
            signal,
        )
        await handOffManualTranslationTarget(prepared, snapshot, token, signal)
        let cachedCore: string | null = null
        try {
            cachedCore = await getLLMCache(prepared.translationInput, {
                signal,
                context: snapshot.context,
                sourceFormat: prepared.sourceFormat,
                manualSource: snapshot.manualSource,
            })
            assertCurrentRun(token, signal)
        }
        catch (error) {
            if (isAbortError(error)) throw error
            console.error(error)
        }
        if (cachedCore === null) return null
        const coreWithEdittrans = applyCachedEditTranslation(
            cachedCore,
            snapshot.translationCharacter,
        )
        return renderTranslatedCore(
            prepared,
            coreWithEdittrans,
            snapshot,
            token,
            signal,
        )
    }

    async function renderNormalDisplay(
        data: string,
        charArg: ChatTranslationCharacter,
        chatID: number,
        snapshot: ChatTranslationRunSnapshot,
        token: TranslationRunToken,
        signal?: AbortSignal,
    ): Promise<string> {
        const prepared = preparedChatTranslation
            && preparedChatTranslation.identityKey === snapshot.identityKey
            ? preparedChatTranslation
            : null
        const marked = prepared
            ? await getPreparedNormalDisplay(prepared, signal)
            : await ParseMarkdown(data, charArg, 'notrim', chatID, snapshot.cbsConditions)
        assertCurrentRun(token, signal)
        return marked
    }

    function leaveTranslationMode(token: TranslationRunToken, identityKey: string): void {
        translationHandoff.clear(identityKey)
        if (retranslateFallback?.identityKey === identityKey) retranslateFallback = null
        pendingAutoTranslatedIdentityKey = ''
        retranslateOperationIdentityKey = ''
        scheduleForCurrentRun(token, () => {
            translated = false
            retranslate = false
        })
    }

    function cacheMutationMatchesTarget(
        mutation: TranslationCacheMutationEvent,
        target: ManualTranslationPreparedTarget,
        context: TranslationContext,
    ): boolean {
        const keys = [target.manualKey, target.planKey, target.legacyKey]
            .filter((key): key is string => typeof key === 'string')
        const keyMatches = mutation.touchedKeys.some((key) => keys.includes(key))
        if (mutation.reason === 'import') return keyMatches
        const scope = mutation.scope
        const scopeMatches = scope !== null
            && (scope.characterId === undefined || scope.characterId === context.characterId)
            && (scope.chatId === undefined || scope.chatId === context.chatId)
            && (scope.messageId === undefined || scope.messageId === context.messageId)
        return keyMatches && scopeMatches
    }

    function cacheMutationResultMatchesPreparedPlan(
        mutation: TranslationCacheMutationEvent,
        target: ManualTranslationPreparedTarget,
    ): boolean {
        if (mutation.reason !== 'force' || mutation.result === undefined) return false
        return [target.planKey, target.legacyKey]
            .some((key) => typeof key === 'string' && mutation.touchedKeys.includes(key))
    }

    const unsubscribeTranslationCacheMutations = subscribeTranslationCacheMutations((mutation) => {
        if (mutation.reason === 'clear') {
            relevantCacheMutation = mutation
            return
        }
        const target = activePreparedTargetForMutation
        if (
            target === null
            || target.identityKey !== currentManualIdentityForMutation
            || !cacheMutationMatchesTarget(mutation, target, target.context)
        ) return
        // Only a matching event is allowed to invalidate the derived run.
        // An unrelated global event must not abort/restart a paid provider.
        relevantCacheMutation = mutation
    })
    onDestroy(unsubscribeTranslationCacheMutations)

    let shouldRenderRawStreaming = $derived(renderRawStreaming && !translated && !retranslate)

    const markParsing = async (
        data: string,
        charArg: ChatTranslationCharacter,
        chatID: number,
        snapshot: ChatTranslationRunSnapshot,
        tries?:number,
        signal?: AbortSignal,
    ) => {
        // track 'translated' and 'retranslate' state
        translated;
        retranslate;
        const previousIdentityKey = activeIdentityKey
        const hasActiveRun = previousIdentityKey !== ''
        const identityChanged = previousIdentityKey !== snapshot.identityKey
        const cacheMutationChanged = hasActiveRun
            && snapshot.cacheMutation.revision > 0
            && activeCacheMutationRevision !== snapshot.cacheMutation.revision
        activeIdentityKey = snapshot.identityKey
        activeCacheMutationRevision = snapshot.cacheMutation.revision
        const token = translationHandoff.begin(snapshot.identityKey)
        if (identityChanged) {
            preparedChatTranslation = null
            lastAutoDecisionIdentityKey = ''
            pendingAutoTranslatedIdentityKey = ''
            retranslateOperationIdentityKey = ''
            retranslateFallback = null
        }
        let mode = 'notrim' as const
        try {
            throwIfTranslationAborted(signal)
            if(readOnlyPresentation){
                // Runtime output is uncommitted presentation state. Keep its
                // parser pure: no Lua/plugin/trigger/regex editdisplay, CBS
                // state access, translation request, or translation cache.
                const marked = await ParseMarkdownReadOnlyPresentation(data, charArg, mode, chatID)
                assertCurrentRun(token, signal)
                return marked
            }
            let desiredTranslated = translated
            let forceTranslation = retranslate
            const manualPresentationInvalidated = cacheMutationChanged && (
                snapshot.cacheMutation.reason === 'clear'
                || (
                    snapshot.manualTranslationTarget !== null
                    && cacheMutationMatchesTarget(
                        snapshot.cacheMutation,
                        snapshot.manualTranslationTarget,
                        snapshot.context,
                    )
                )
            )

            // A force flag belongs to the identity that initiated it. Never
            // carry a delayed flag from an old message into a replacement.
            if (identityChanged && previousIdentityKey && forceTranslation) {
                forceTranslation = false
                scheduleForCurrentRun(token, () => { retranslate = false })
            }

            if (
                snapshot.manualTranslationCore !== null
                && snapshot.manualTranslationTarget !== null
                && !manualPresentationInvalidated
                && !forceTranslation
                && (translated || snapshot.autoTranslate)
                && translationHandoff.read(snapshot.identityKey) === undefined
            ) {
                // ChatBody is unmounted while the manual editor is open. The
                // parent therefore hands the just-committed core result to the
                // new instance atomically instead of making a provider-capable
                // translateHTML call after remount.
                const prepared = restoreManualPreparedTranslation(
                    data,
                    charArg,
                    chatID,
                    snapshot,
                    snapshot.manualTranslationTarget,
                )
                assertCurrentRun(token, signal)
                activePreparedTargetForMutation = snapshot.manualTranslationTarget
                onManualTranslationTargetPrepared(snapshot.manualTranslationTarget)
                const rendered = await renderTranslatedCore(
                    prepared,
                    applyCachedEditTranslation(
                        snapshot.manualTranslationCore,
                        snapshot.translationCharacter,
                    ),
                    snapshot,
                    token,
                    signal,
                )
                assertCurrentRun(token, signal)
                translationHandoff.publish(token, rendered)
                if (!translated) {
                    pendingAutoTranslatedIdentityKey = snapshot.identityKey
                    scheduleForCurrentRun(token, () => { translated = true })
                }
                return rendered
            }

            const refreshVisibleTranslation = cacheMutationChanged && (
                snapshot.cacheMutation.reason === 'clear'
                || (
                    snapshot.translatorType === 'llm'
                    && (translated || snapshot.autoTranslate || forceTranslation)
                )
            )
            if (refreshVisibleTranslation) {
                // Clear is the only global invalidation. Manual/force events
                // are canonical-message scoped; imports are exact-key scoped.
                // Every non-clear refresh remains cache/provider-free unless
                // the event itself carries a committed core result.
                if (snapshot.cacheMutation.reason === 'clear') {
                    lastAutoDecisionIdentityKey = snapshot.identityKey
                    const normalDisplay = await renderNormalDisplay(
                        data,
                        charArg,
                        chatID,
                        snapshot,
                        token,
                        signal,
                    )
                    leaveTranslationMode(token, snapshot.identityKey)
                    return normalDisplay
                }
                const prepared = await prepareChatTranslation(
                    data,
                    charArg,
                    chatID,
                    snapshot.identityKey,
                    snapshot.cbsConditions,
                    snapshot.translateBeforeFormatting,
                    snapshot.legacyTranslation,
                    signal,
                )
                const target = await handOffManualTranslationTarget(
                    prepared,
                    snapshot,
                    token,
                    signal,
                )
                if (cacheMutationMatchesTarget(snapshot.cacheMutation, target, snapshot.context)) {
                    lastAutoDecisionIdentityKey = snapshot.identityKey
                    let rendered: string | null = null
                    if (cacheMutationResultMatchesPreparedPlan(snapshot.cacheMutation, target)) {
                        rendered = await renderTranslatedCore(
                            prepared,
                            applyCachedEditTranslation(
                                snapshot.cacheMutation.result as string,
                                snapshot.translationCharacter,
                            ),
                            snapshot,
                            token,
                            signal,
                        )
                    }
                    else {
                        rendered = await renderCachedTranslation(
                            data,
                            charArg,
                            chatID,
                            snapshot,
                            token,
                            signal,
                        )
                    }
                    if (rendered !== null) {
                        assertCurrentRun(token, signal)
                        translationHandoff.clear(snapshot.identityKey)
                        translationHandoff.publish(token, rendered)
                        if (forceTranslation || snapshot.cacheMutation.reason === 'force') {
                            retranslateOperationIdentityKey = ''
                            retranslateFallback = null
                            scheduleForCurrentRun(token, () => { retranslate = false })
                        }
                        if (!translated) {
                            pendingAutoTranslatedIdentityKey = snapshot.identityKey
                            scheduleForCurrentRun(token, () => { translated = true })
                        }
                        return rendered
                    }
                    const completed = translationHandoff.read(snapshot.identityKey)
                    if (completed !== undefined) return completed
                    const normalDisplay = await renderNormalDisplay(
                        data,
                        charArg,
                        chatID,
                        snapshot,
                        token,
                        signal,
                    )
                    leaveTranslationMode(token, snapshot.identityKey)
                    return normalDisplay
                }
            }

            if (lastAutoDecisionIdentityKey !== snapshot.identityKey) {
                // A freshly remounted ChatBody (notably after the manual editor
                // closes) must preserve an already-selected translated mode.
                // Only a replacement of an existing message identity resets
                // the old mode before applying auto-translation policy.
                desiredTranslated = previousIdentityKey ? false : translated
                if (snapshot.autoTranslate) {
                    if (snapshot.cachedOnly && snapshot.translatorType === 'llm') {
                        desiredTranslated = false
                        const rendered = await renderCachedTranslation(
                            data,
                            charArg,
                            chatID,
                            snapshot,
                            token,
                            signal,
                        )
                        lastAutoDecisionIdentityKey = snapshot.identityKey
                        if (rendered !== null) {
                            assertCurrentRun(token, signal)
                            translationHandoff.publish(token, rendered)
                            pendingAutoTranslatedIdentityKey = snapshot.identityKey
                            scheduleForCurrentRun(token, () => { translated = true })
                            return rendered
                        }
                    }
                    else {
                        desiredTranslated = true
                        // Do not mutate the bound mode until this run has a
                        // completed presentation to hand to the rerender. A
                        // premature mutation aborts the first provider call
                        // and starts a duplicate one for the same identity.
                        pendingAutoTranslatedIdentityKey = snapshot.identityKey
                        lastAutoDecisionIdentityKey = snapshot.identityKey
                    }
                }
                else {
                    lastAutoDecisionIdentityKey = snapshot.identityKey
                }
                if (forceTranslation) desiredTranslated = true
                if (
                    translated !== desiredTranslated
                    && pendingAutoTranslatedIdentityKey !== snapshot.identityKey
                ) {
                    const nextTranslated = desiredTranslated
                    scheduleForCurrentRun(token, () => { translated = nextTranslated })
                }
            }

            if (pendingAutoTranslatedIdentityKey === snapshot.identityKey && translated) {
                pendingAutoTranslatedIdentityKey = ''
            }

            let startingRetranslate = false
            if (forceTranslation) {
                if (retranslateOperationIdentityKey !== snapshot.identityKey) {
                    retranslateOperationIdentityKey = snapshot.identityKey
                    const previousCompleted = translationHandoff.read(snapshot.identityKey)
                    retranslateFallback = previousCompleted === undefined
                        ? null
                        : { identityKey: snapshot.identityKey, rendered: previousCompleted }
                    translationHandoff.clear(snapshot.identityKey)
                    startingRetranslate = true
                }
                desiredTranslated = true
            }

            const completed = translationHandoff.read(snapshot.identityKey)
            const mayUseCompleted = desiredTranslated
                && (translated || pendingAutoTranslatedIdentityKey === snapshot.identityKey || forceTranslation)
                && !(forceTranslation && startingRetranslate)
            if (completed !== undefined && mayUseCompleted) {
                if (forceTranslation) {
                    scheduleForCurrentRun(token, () => { retranslate = false })
                }
                else if (retranslateOperationIdentityKey === snapshot.identityKey) {
                    retranslateOperationIdentityKey = ''
                }
                return completed
            }

            if(forceTranslation || desiredTranslated){
                const prepared = await prepareChatTranslation(
                    data,
                    charArg,
                    chatID,
                    snapshot.identityKey,
                    snapshot.cbsConditions,
                    snapshot.translateBeforeFormatting,
                    snapshot.legacyTranslation,
                    signal,
                )
                await handOffManualTranslationTarget(prepared, snapshot, token, signal)
                const translationOptions = {
                    signal,
                    force: forceTranslation,
                    context: snapshot.context,
                    sourceFormat: prepared.sourceFormat,
                    manualSource: snapshot.manualSource,
                    throwOnFailure: forceTranslation,
                }

                if(snapshot.translatorType === 'llm' && snapshot.translateBeforeFormatting){
                    await sleep(100)
                    assertCurrentRun(token, signal)
                }

                translating = true
                let coreTranslated: string
                try {
                    coreTranslated = await translateHTML(
                        prepared.translationInput,
                        false,
                        snapshot.translationCharacter,
                        chatID,
                        forceTranslation,
                        translationOptions,
                    )
                }
                finally {
                    translating = false
                }
                assertCurrentRun(token, signal)
                const rendered = await renderTranslatedCore(
                    prepared,
                    coreTranslated,
                    snapshot,
                    token,
                    signal,
                )
                translationHandoff.publish(token, rendered)
                retranslateFallback = null
                if (
                    pendingAutoTranslatedIdentityKey === snapshot.identityKey
                    && !translated
                ) {
                    scheduleForCurrentRun(token, () => { translated = true })
                }
                if (forceTranslation) {
                    scheduleForCurrentRun(token, () => { retranslate = false })
                }
                return rendered
            }
            else{
                return renderNormalDisplay(data, charArg, chatID, snapshot, token, signal)
            }   
        } catch (error) {
            if (isAbortError(error)) {
                if (signal?.aborted || !translationHandoff.isCurrent(token)) {
                    throw error
                }
                // The translator can fail closed while this component run is
                // still current (for example, a newly appearing dynamic hook
                // or another view superseding a shared flight). Never commit
                // an empty presentation for that case.
                const normalDisplay = await renderNormalDisplay(
                    data,
                    charArg,
                    chatID,
                    snapshot,
                    token,
                    signal,
                )
                leaveTranslationMode(token, snapshot.identityKey)
                return normalDisplay
            }
            if (error instanceof TranslationIntegrityError) {
                assertCurrentRun(token, signal)
                // Protected structure was changed by the provider. Do not
                // retry the same unsafe response or leave translation mode on;
                // render the ordinary untranslated presentation once.
                alertError('Translation integrity check failed. Showing the original message.')
                const normalDisplay = await renderNormalDisplay(
                    data,
                    charArg,
                    chatID,
                    snapshot,
                    token,
                    signal,
                )
                // Mutating the reactive mode aborts this run's signal, so do
                // it only after the fallback presentation has been prepared.
                leaveTranslationMode(token, snapshot.identityKey)
                return normalDisplay
            }
            if (error instanceof TranslationProviderError) {
                assertCurrentRun(token, signal)
                const fallback = retranslateFallback?.identityKey === snapshot.identityKey
                    ? retranslateFallback.rendered
                    : undefined
                retranslateFallback = null
                retranslateOperationIdentityKey = ''
                if (fallback !== undefined) {
                    translationHandoff.publish(token, fallback)
                    scheduleForCurrentRun(token, () => { retranslate = false })
                    return fallback
                }
                const normalDisplay = await renderNormalDisplay(
                    data,
                    charArg,
                    chatID,
                    snapshot,
                    token,
                    signal,
                )
                leaveTranslationMode(token, snapshot.identityKey)
                return normalDisplay
            }
            //retry
            if(tries > 2){

                alertError(`Error while parsing chat message: ${translated}, ${error.message}, ${error.stack}`)
                return data
            }
            return await markParsing(data, charArg, chatID, snapshot, (tries ?? 0) + 1, signal)
        }
    }

    const checkImg = () => {
        if(!DBState.db.newImageHandlingBeta || !bodyRoot){
            return
        }
        const imgs = bodyRoot.querySelectorAll('img:not([src^="data:"]):not([src^="http:"]):not([src^="https:"]):not([src^="blob:"]):not([src^="file:"]):not([src^="tauri:"]):not([noimage])') as NodeListOf<HTMLImageElement>
        
        if (imgs.length > 0) {
            const currentCharacter = getCurrentCharacter()
            const styl = currentCharacter.prebuiltAssetStyle
            const assets = getModuleAssets().concat(currentCharacter.additionalAssets ?? [])
            const normalizedAssets = assets.map((asset) => {
                return {
                    name: asset[0].toLocaleLowerCase(),
                    path: asset[1]
                }
            })
            const exactAssets = new Map(normalizedAssets.map((asset) => [asset.name, asset.path]))

            imgs.forEach(async (img) => {
                const name = img.getAttribute('src')?.toLocaleLowerCase() || ''
                console.log(name)

                if(
                    name.length > 200 ||
                    name.includes(':')
                ){
                    img.setAttribute('noimage', 'true')
                    return
                }
                
                const foundAsset = exactAssets.get(name)
                console.log('Checking image:', name, 'Assets:', assets)
                if(foundAsset){
                    img.classList.add('root-loaded-image')
                    img.classList.add('root-loaded-image-' + styl)
                    img.src = await getFileSrc(foundAsset)
                    return
                }

                if(name.length < 3){
                    img.setAttribute('noimage', 'true')
                    return
                }
                const prefixLoc = name.lastIndexOf('.')
                const prefix = prefixLoc > 0 ? name.substring(0, prefixLoc) : ''
                let currentDistance = 1000
                let currentFound = ''
                for(const asset of normalizedAssets){
                    if(!asset.name.startsWith(prefix)){
                        continue
                    }
                    const distance = getDistance(name, asset.name)
                    if(distance < currentDistance){
                        currentDistance = distance
                        currentFound = asset.path
                    }
                }
                if(currentFound){
                    const got = await getFileSrc(currentFound)
                    const name2 = img.getAttribute('src')?.toLocaleLowerCase() || ''
                    if(name === name2){
                        img.setAttribute('src', got)
                    }

                    if(img.classList.length === 0){
                        img.classList.add('root-loaded-image')
                        img.classList.add('root-loaded-image-' + styl)
                    }
                    img.removeAttribute('noimage')
                }
                else{
                    img.setAttribute('noimage', 'true')
                }
            })
        }
    }

    let markParsingResult = $derived.by(() => {
        void displayRevision
        void readOnlyPresentation
        const snapshot = createTranslationRunSnapshot(
            msgDisplay,
            character,
            canonicalTranslationCharacter,
            idx,
        )
        const signal = getAbortSignal()
        return markParsing(
            msgDisplay,
            character,
            idx,
            snapshot,
            undefined,
            signal,
        ).catch((error) => {
            // Superseded derived promises are no longer presented. Resolve
            // their aborts so teardown/identity changes cannot leak an
            // unhandled rejection from Svelte's await block.
            if (isAbortError(error) && signal.aborted) return ''
            throw error
        })
    })
    let trimRenderedMarkdown = $derived(readOnlyPresentation
        ? trimMarkdownReadOnlyPresentation
        : trimMarkdown)

    $effect(() => {
        if (shouldRenderRawStreaming) {
            retainedRawStreamingText = rawStreamingText
            return
        }
        const presentation = markParsingResult
        let active = true
        presentation.then((value) => {
            if (!active || markParsingResult !== presentation) return
            lastParsed = value
            retainedRawStreamingText = null
            checkImg()
        }).catch((error) => {
            if (active && !isAbortError(error)) console.error('[Chat display]', error)
        })
        return () => { active = false }
    })

    function escapeStreamingText(value: string): string {
        return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    }
    // One HTML boundary retains nodes when the prepared output is unchanged.
    // Keep raw streaming text visible until canonical formatting is ready.
    let renderedHtml = $derived(retainedRawStreamingText !== null
        ? `<span class="whitespace-pre-wrap">${escapeStreamingText(retainedRawStreamingText)}</span>`
        : addMetadataToElement(trimRenderedMarkdown(lastParsed), modelShortName))
</script>

{@html renderedHtml}
