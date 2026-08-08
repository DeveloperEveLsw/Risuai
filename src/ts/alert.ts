import { get, writable } from "svelte/store"
import { sleep } from "./util"
import { language } from "../lang"
import { isTauri, isNodeServer } from "src/ts/platform"
import { getDatabase, type MessageGenerationInfo } from "./storage/database.svelte"
import { alertStore as alertStoreImported } from "./stores.svelte"

export interface alertData{
    type: 'error'|'normal'|'none'|'ask'|'wait'|'selectChar'
            |'input'|'toast'|'wait2'|'markdown'|'select'|'login'
            |'tos'|'cardexport'|'requestdata'|'addchar'|'hypaV2'|'selectModule'
            |'chatOptions'|'pukmakkurit'|'branches'|'progress'|'pluginconfirm'|'requestlogs',
    msg: string,
    submsg?: string
    datalist?: [string, string][],
    stackTrace?: string;
    defaultValue?: string
}

export interface RuntimeAlertBridge {
    prompt: (data: alertData) => Promise<string>
    notice: (data: alertData) => void | Promise<void>
}

export interface RuntimeAlertPromptEnvelope {
    commandId: string
    promptId: string
    prompt: alertData
}

// Legacy V2.1 plugins receive these instead of native browser dialogs. Native
// dialogs block the hidden resident Chromium main thread and cannot be handed
// off to another device; the Promise form preserves blocking semantics for
// plugins that await the result while using the same AlertComp bridge.
export const runtimeAlertGlobals = {
    alert: async (message?: unknown) => {
        await alertNormalWait(String(message ?? ''))
    },
    confirm: async (message?: unknown) => {
        return await alertConfirm(String(message ?? ''))
    },
    prompt: async (message?: unknown, defaultValue?: unknown) => {
        return await alertInput(
            String(message ?? ''),
            undefined,
            defaultValue === undefined ? '' : String(defaultValue),
        )
    },
}

let runtimeAlertBridge: RuntimeAlertBridge | null = null

export function installRuntimeAlertBridge(bridge: RuntimeAlertBridge) {
    const previous = runtimeAlertBridge
    runtimeAlertBridge = bridge
    return () => {
        if (runtimeAlertBridge === bridge) {
            runtimeAlertBridge = previous
        }
    }
}

async function presentBlockingAlert(data: alertData) {
    if (runtimeAlertBridge) {
        return await runtimeAlertBridge.prompt(data)
    }
    alertStoreImported.set(data)
    await waitAlert()
    return String(get(alertStoreImported).msg ?? '')
}

function relayRuntimeNotice(data: alertData) {
    if (!runtimeAlertBridge) {
        return false
    }
    void Promise.resolve(runtimeAlertBridge.notice(data)).catch((error) => {
        console.error('[Runtime Alert Notice]', error)
    })
    return true
}

type DirectRuntimePromptState = {
    commandId: string
    promptId: string
    prompt: alertData
    presenting: boolean
    dismissed: boolean
    result: Promise<string | null>
    resolve: (value: string | null) => void
}

const directRuntimePrompts = new Map<string, DirectRuntimePromptState>()
let directRuntimeAlertQueue = Promise.resolve()

export function presentRuntimeAlertPrompt(envelope: RuntimeAlertPromptEnvelope) {
    const existing = directRuntimePrompts.get(envelope.promptId)
    if (existing) {
        return existing.result
    }
    let resolveResult!: (value: string | null) => void
    const result = new Promise<string | null>((resolve) => {
        resolveResult = resolve
    })
    const state: DirectRuntimePromptState = {
        ...envelope,
        presenting: false,
        dismissed: false,
        result,
        resolve: resolveResult,
    }
    directRuntimePrompts.set(envelope.promptId, state)
    const present = directRuntimeAlertQueue.then(async () => {
        if (state.dismissed) {
            state.resolve(null)
            return
        }
        state.presenting = true
        alertStoreImported.set({ ...state.prompt })
        while (!state.dismissed && get(alertStoreImported).type !== 'none') {
            await sleep(10)
        }
        state.presenting = false
        if (state.dismissed) {
            state.resolve(null)
            return
        }
        const response = String(get(alertStoreImported).msg ?? '')
        // Do not leave prompt answers (often API keys) sitting in the shared
        // UI store after the response body has been constructed.
        alertStoreImported.set({ type: 'none', msg: '' })
        state.resolve(response)
    })
    directRuntimeAlertQueue = present.catch((error) => {
        console.error('[Runtime Alert Prompt]', error)
        state.resolve(null)
    })
    return result
}

export function dismissRuntimeAlertPrompt(promptId: string) {
    const state = directRuntimePrompts.get(promptId)
    if (!state) {
        return
    }
    state.dismissed = true
    if (state.presenting && get(alertStoreImported).type !== 'none') {
        alertStoreImported.set({ type: 'none', msg: '' })
    }
    state.resolve(null)
    directRuntimePrompts.delete(promptId)
}

export function dismissRuntimeAlertPromptsForCommand(commandId: string) {
    for (const state of directRuntimePrompts.values()) {
        if (state.commandId === commandId) {
            dismissRuntimeAlertPrompt(state.promptId)
        }
    }
}

export function presentRuntimeAlertNotice(notice: alertData) {
    directRuntimeAlertQueue = directRuntimeAlertQueue.then(() => {
        alertStoreImported.set({ ...notice })
    })
    return directRuntimeAlertQueue
}

type AlertGenerationInfoStoreData = {
    genInfo: MessageGenerationInfo,
    idx: number
}
export const alertGenerationInfoStore = writable<AlertGenerationInfoStoreData>(null)
export const alertStore = {
    set: (d:alertData) => {
        alertStoreImported.set(d)
    }
}

export function alertError(msg: string | Error) {
    console.error(msg)
    const db = getDatabase()

    let stackTrace: string | undefined = undefined; 

    if (typeof(msg) !== 'string') {
        try{
            if (msg instanceof Error) {
                stackTrace = msg.stack
                msg = msg.message
            } else {
                msg = JSON.stringify(msg)
            }
        } catch {
            msg = `${msg}`
        }
    }

    msg = msg.trim()

    const ignoredErrors = [
        '{}'
    ]

    if(ignoredErrors.includes(msg)){
        return
    }

    let submsg = ''

    //check if it's a known error
    if(msg.includes('Failed to fetch') || msg.includes("NetworkError when attempting to fetch resource.")){
        submsg =    db.usePlainFetch ? language.errors.networkFetchPlain :
                    (!isTauri && !isNodeServer) ? language.errors.networkFetchWeb : language.errors.networkFetch
    }

    const notice: alertData = {
        'type': 'error',
        'msg': msg,
        'submsg': submsg,
        'stackTrace': stackTrace
    }
    if (!relayRuntimeNotice(notice)) {
        alertStoreImported.set(notice)
    }
}

export async function waitAlert(){
    while(true){
        if (get(alertStoreImported).type === 'none'){
            break
        }
        await sleep(10)
    }
}

export function alertNormal(msg:string){
    const notice: alertData = {
        'type': 'normal',
        'msg': msg
    }
    if (!relayRuntimeNotice(notice)) {
        alertStoreImported.set(notice)
    }
}

export async function alertNormalWait(msg:string){
    await presentBlockingAlert({
        'type': 'normal',
        'msg': msg
    })
}

export async function alertAddCharacter() {
    return await presentBlockingAlert({
        'type': 'addchar',
        'msg': language.addCharacter
    })
}

export async function alertChatOptions() {
    const response = await presentBlockingAlert({
        'type': 'chatOptions',
        'msg': language.chatOptions
    })
    return parseInt(response)
}

export async function alertLogin(){
    return await presentBlockingAlert({
        'type': 'login',
        'msg': 'login'
    })
}

export async function alertSelect(msg:string[], display?:string){
    const message = display !== undefined ? `__DISPLAY__${display}||${msg.join('||')}` : msg.join('||')
    return await presentBlockingAlert({
        'type': 'select',
        'msg': message
    })
}

export async function alertErrorWait(msg:string){
    alertStoreImported.set({
        'type': 'wait2',
        'msg': msg
    })
    await waitAlert()
}

export function alertMd(msg:string){
    const notice: alertData = {
        'type': 'markdown',
        'msg': msg
    }
    if (!relayRuntimeNotice(notice)) {
        alertStoreImported.set(notice)
    }
}

export function doingAlert(){
    return get(alertStoreImported).type !== 'none' && get(alertStoreImported).type !== 'toast' && get(alertStoreImported).type !== 'wait'
}

export function alertToast(msg:string){
    alertStoreImported.set({
        'type': 'toast',
        'msg': msg
    })
}

export function alertWait(msg:string){
    alertStoreImported.set({
        'type': 'wait',
        'msg': msg
    })

}


export function alertClear(){
    alertStoreImported.set({
        'type': 'none',
        'msg': ''
    })
}

export async function alertSelectChar(){
    return await presentBlockingAlert({
        'type': 'selectChar',
        'msg': ''
    })
}

export async function alertConfirm(msg:string){
    const response = await presentBlockingAlert({
        'type': 'ask',
        'msg': msg
    })
    return response === 'yes'
}

export async function alertPluginConfirm(msg:string){
    const response = await presentBlockingAlert({
        'type': 'pluginconfirm',
        'msg': msg
    })
    return response === 'yes'
}

export async function alertCardExport(type:string = ''){
    const response = await presentBlockingAlert({
        'type': 'cardexport',
        'msg': '',
        'submsg': type
    })
    return JSON.parse(response) as {
        type: string,
        type2: string,
    }
}

export async function alertTOS(){

    if(localStorage.getItem('tos4') === 'true'){
        return true
    }

    const response = await presentBlockingAlert({
        'type': 'tos',
        'msg': 'tos'
    })

    if(response === 'yes'){
        localStorage.setItem('tos4', 'true')
        return true
    }

    if(localStorage.getItem('tos2') && Date.now() - new Date('2026-05-15').getTime() < 0){
        //apply grace period until 2026-05-15 for users who accepted tos2
        return true
    }

    return false
}

export async function alertInput(msg:string, datalist?:[string, string][], defaultValue?:string) {
    return await presentBlockingAlert({
        'type': 'input',
        'msg': msg,
        'datalist': datalist ?? [],
        'defaultValue': defaultValue ?? ''
    })
}

export async function alertModuleSelect(){
    return await presentBlockingAlert({
        'type': 'selectModule',
        'msg': ''
    })
}

export function alertRequestData(info:AlertGenerationInfoStoreData){
    alertGenerationInfoStore.set(info)
    alertStoreImported.set({
        'type': 'requestdata',
        'msg': info.genInfo.generationId ?? 'none'
    })
}

export function showHypaV2Alert(){
    alertStoreImported.set({
        'type': 'hypaV2',
        'msg': ""
    })
}

export function alertRequestLogs(){
    alertStoreImported.set({
        'type': 'requestlogs',
        'msg': ''
    })
}
