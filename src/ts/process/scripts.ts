import { get } from "svelte/store";
import { CharEmotion } from "../stores.svelte";
import { type character, type customscript, type groupChat } from "../storage/database.svelte";
import { downloadFile } from "../globalApi.svelte";
import { alertError, alertNormal } from "../alert";
import { language } from "src/lang";
import { selectSingleFile } from "../util";
import { assetRegex, type CbsConditions, risuChatParser as risuChatParserOrg, type simpleCharacterArgument } from "../parser/parser.svelte";
import { getModuleAssets, getModuleRegexScripts } from "./modules";
import { HypaProcesser } from "./memory/hypamemory";
import { getRequestRuntimeContext } from "./runtimeContext";
import { finishRuntimeTraceScope, startRuntimeTraceScope, traceRuntimeEvent } from "./runtimeTrace";
import { runLuaEditTrigger } from "./scriptings";
import { pluginV2 } from "../plugins/plugins.svelte";
import { runTrigger } from "./triggers";

const dreg = /{{data}}/g
const randomness = /\|\|\|/g

export type ScriptMode = 'editinput'|'editoutput'|'editprocess'|'editdisplay'

type pScript = {
    script: customscript,
    order: number
    actions: string[]
}

function getDatabase(options: Parameters<ReturnType<typeof getRequestRuntimeContext>["getDatabase"]>[0] = {}) {
    return getRequestRuntimeContext().getDatabase(options)
}

function getCurrentCharacter(options: Parameters<ReturnType<typeof getRequestRuntimeContext>["getCurrentCharacter"]>[0] = {}) {
    return getRequestRuntimeContext().getCurrentCharacter(options)
}

function getCurrentChat() {
    return getRequestRuntimeContext().getCurrentChat()
}

function getSelectedCharacterIndex() {
    return getRequestRuntimeContext().getSelectedCharacterIndex()
}

export async function processScript(char:character|groupChat, data:string, mode:ScriptMode, cbsConditions:CbsConditions = {}){
    return (await processScriptFull(char, data, mode, -1, cbsConditions)).data
}

export function exportRegex(s?:customscript[]){
    let db = getDatabase()
    const script = s ?? db.globalscript
    const data = Buffer.from(JSON.stringify({
        type: 'regex',
        data: script
    }), 'utf-8')
    downloadFile(`regexscript_export.json`,data)
    alertNormal(language.successExport)
}

export async function importRegex(o?:customscript[]):Promise<customscript[]>{
    o = o ?? []
    const filedata = (await selectSingleFile(['json'])).data
    if(!filedata){
        return o
    }
    let db = getDatabase()
    try {
        const imported= JSON.parse(Buffer.from(filedata).toString('utf-8'))
        if(imported.type === 'regex' && imported.data){
            const datas:customscript[] = imported.data
            const script = o
            for(const data of datas){
                script.push(data)
            }
            return o
        }
        else{
            alertError("File invaid or corrupted")
        }

    } catch (error) {
        alertError(error)
    }
    return o
}

let bestMatchCache = new Map<string, string>()
let processScriptCache = new Map<string, string>()

function generateScriptCacheKey(scripts: customscript[], data: string, mode: ScriptMode, chatID = -1, cbsConditions: CbsConditions = {}) {
    let hash = data + '|||' + mode + '|||';
    for (const script of scripts) {
        if(script.type !== mode){
            continue
        }
        hash += `${script.flag?.includes('<cbs>') ? risuChatParser(script.in, { chatID: chatID, cbsConditions }) : script.in}|||${script.out}${chatID}|||${script.flag ?? ''}|||${script.ableFlag ? 1 : 0}`;
    }
    return hash;
}

function cacheScript(hash:string, result:string){
    processScriptCache.set(hash, result)

    if(processScriptCache.size > 1000){
        processScriptCache.delete(processScriptCache.keys().next().value)
    }

}

function getScriptCache(hash:string){
    return processScriptCache.get(hash)
}

export function resetScriptCache(){
    processScriptCache = new Map()
}

export async function processScriptFull(char:character|groupChat|simpleCharacterArgument, data:string, mode:ScriptMode, chatID = -1, cbsConditions:CbsConditions = {}){
    const traceScope = startRuntimeTraceScope('script.processScriptFull', {
        mode,
        chatID,
        charId: 'chaId' in char ? char.chaId : null,
        inputLength: data.length,
    })
    let traceStatus:'ok'|'error' = 'ok'

    try {
        let db = getDatabase()
        let emoChanged = false
        traceRuntimeEvent('script.lua_edit.start', {
            mode,
            chatID,
        })
        data = await runLuaEditTrigger(char, mode, data, { index:chatID })
        traceRuntimeEvent('script.lua_edit.end', {
            mode,
            chatID,
            outputLength: data.length,
        })

        if(mode === 'editdisplay'){
            const currentChar = getCurrentCharacter()
            if(currentChar.type !== 'group'){
                try{
                    traceRuntimeEvent('script.display_trigger.start', {
                        chatID,
                        charId: currentChar.chaId,
                    })
                    const perf = performance.now()
                    const d = await runTrigger(currentChar, 'display', {
                        chat: getCurrentChat(),
                        displayMode: true,
                        displayData: data
                    })

                    data = d?.displayData ?? data
                    traceRuntimeEvent('script.display_trigger.end', {
                        chatID,
                        durationMs: performance.now() - perf,
                        outputLength: data.length,
                    })
                    console.log('Trigger time', performance.now() - perf)
                }
                catch(e){
                    traceRuntimeEvent('script.display_trigger.error', {
                        chatID,
                        error: e,
                    })
                    console.error(e)
                }
            }
        }

        if(pluginV2[mode].size > 0){
            traceRuntimeEvent('script.plugin_v2.start', {
                mode,
                chatID,
                pluginCount: pluginV2[mode].size,
            })
            let pluginIndex = 0
            for(const plugin of pluginV2[mode]){
                const res = await plugin(data)
                if(res !== null && res !== undefined){
                    data = res
                }
                traceRuntimeEvent('script.plugin_v2.applied', {
                    mode,
                    chatID,
                    pluginIndex,
                    changed: res !== null && res !== undefined,
                    outputLength: data.length,
                })
                pluginIndex += 1
            }
        }

        data = risuChatParser(data, { chatID: chatID, cbsConditions })
        const scripts = (db.presetRegex ?? []).concat(char.customscript).concat(getModuleRegexScripts())
        const hash = generateScriptCacheKey(scripts, data, mode, chatID, cbsConditions)
        const cached = getScriptCache(hash)
        traceRuntimeEvent('script.regex.prepare', {
            mode,
            chatID,
            scriptCount: scripts.length,
            cacheHit: Boolean(cached),
            parsedLength: data.length,
        })
        if(cached){
            return {data: cached, emoChanged: false}
        }

        if(scripts.length === 0){
            cacheScript(hash, data)
            return {data, emoChanged}
        }

        function executeScript(pscript:pScript){
            const script = pscript.script

            if(script.in === ''){
                return
            }

            if(script.type === mode){

                let outScript2 = script.out.replaceAll("$n", "\n")
                let outScript = outScript2.replace(dreg, "$&")
                let flag = 'g'
                if(script.ableFlag){
                    flag = script.flag || 'g'
                }
                if(outScript.startsWith('@@move_top') || outScript.startsWith('@@move_bottom') || pscript.actions.includes('move_top') || pscript.actions.includes('move_bottom')){
                    flag = flag.replace('g', '') //temperary fix
                }
                if(outScript.endsWith('>') && !pscript.actions.includes('no_end_nl')){
                    outScript += '\n'
                }
                flag = flag.trim().replace(/[^dgimsuvy]/g, '')
                flag = flag.split('').filter((v, i, a) => a.indexOf(v) === i).join('')

                if(flag.length === 0){
                    flag = 'u'
                }

                let input = script.in
                if(pscript.actions.includes('cbs')){
                    input = risuChatParser(input, { chatID: chatID, cbsConditions })
                }

                const reg = new RegExp(input, flag)
                if(outScript.startsWith('@@') || pscript.actions.length > 0){
                    if(reg.test(data)){
                        if(outScript.startsWith('@@emo ')){
                            const emoName = script.out.substring(6).trim()
                            let charemotions = get(CharEmotion)
                            let tempEmotion = charemotions[char.chaId]
                            if(!tempEmotion){
                                tempEmotion = []
                            }
                            if(tempEmotion.length > 4){
                                tempEmotion.splice(0, 1)
                            }
                            if(char.type !== 'simple'){
                                for(const emo of char.emotionImages){
                                    if(emo[0] === emoName){
                                        const emos:[string, string,number] = [emo[0], emo[1], Date.now()]
                                        tempEmotion.push(emos)
                                        charemotions[char.chaId] = tempEmotion
                                        CharEmotion.set(charemotions)
                                        emoChanged = true
                                        break
                                    }
                                }
                            }
                        }
                        else if((outScript.startsWith('@@inject') || pscript.actions.includes('inject')) && chatID !== -1){
                            const selchar = db.characters[getSelectedCharacterIndex()]
                            selchar.chats[selchar.chatPage].message[chatID].data = data
                            data = data.replace(reg, "")
                        }
                        else if(
                            outScript.startsWith('@@move_top') || outScript.startsWith('@@move_bottom') ||
                            pscript.actions.includes('move_top') || pscript.actions.includes('move_bottom')
                        ){
                            const isGlobal = flag.includes('g')
                            const matchAll = isGlobal ? data.matchAll(reg) : [data.match(reg)]
                            data = data.replace(reg, "")
                            for(const matched of matchAll){
                                if(matched){
                                    const inData = matched[0]
                                    let out = outScript.replace('@@move_top ', '').replace('@@move_bottom ', '')
                                        .replace(/(?<!\$)\$[0-9]+/g, (v)=>{
                                            const index = parseInt(v.substring(1))
                                            if(index < matched.length){
                                                return matched[index]
                                            }
                                            return v
                                        })
                                        .replace(/\$\&/g, inData)
                                        .replace(/(?<!\$)\$<([^>]+)>/g, (v) => {
                                            const groupName = parseInt(v.substring(2, v.length - 1))
                                            if(matched.groups && matched.groups[groupName]){
                                                return matched.groups[groupName]
                                            }
                                            return v
                                        })
                                    if(outScript.startsWith('@@move_top') || pscript.actions.includes('move_top')){
                                        data = out + '\n' +data
                                    }
                                    else{
                                        data = data + '\n' + out
                                    }
                                }
                            }
                        }
                        else{
                            data = risuChatParser(data.replace(reg, outScript), { chatID: chatID, cbsConditions })
                        }
                    }
                    else{
                        if((outScript.startsWith('@@repeat_back') || pscript.actions.includes('repeat_back'))  && chatID !== -1){
                            const v = outScript.split(' ', 2)[1]
                            const selchar = db.characters[getSelectedCharacterIndex()]
                            const chat = selchar.chats[selchar.chatPage]
                            let lastChat = chat.fmIndex === -1 ? selchar.firstMessage : selchar.alternateGreetings[chat.fmIndex]
                            let pointer = chatID - 1
                            while(pointer >= 0){
                                if(chat.message[pointer].role === chat.message[chatID].role){
                                    lastChat = chat.message[pointer].data
                                    break
                                }
                                pointer--
                            }

                            const r = lastChat.match(reg)
                            if(!v){
                                data = data + r[0]
                            }
                            else if(r[0]){
                                switch(v){
                                    case 'end':
                                        data = data + r[0]
                                        break
                                    case 'start':
                                        data = r[0] + data
                                        break
                                    case 'end_nl':
                                        data = data + "\n" + r[0]
                                        break
                                    case 'start_nl':
                                        data = r[0] + "\n" + data
                                        break
                                }

                            }
                        }
                    }
                }
                else{
                    data = risuChatParser(data.replace(reg, outScript), { chatID: chatID, cbsConditions })
                }
            }
        }

        let parsedScripts:pScript[] = []
        let orderChanged = false
        for (const script of scripts){
            if(script.ableFlag && script.flag?.includes('<')){
                const rregex = /<(.+?)>/g
                const scriptData = safeStructuredClone(script)
                let order = 0
                const actions:string[] = []
                scriptData.flag = scriptData.flag?.replace(rregex, (v:string, p1:string) => {
                    const meta = p1.split(',').map((v) => v.trim())
                    for(const m of meta){
                        if(m.startsWith('order ')){
                            order = parseInt(m.substring(6))
                            orderChanged = true
                        }
                        else{
                            actions.push(m)
                        }
                    }

                    return ''
                })
                parsedScripts.push({
                    script: scriptData,
                    order,
                    actions
                })
                continue
            }
            parsedScripts.push({
                script,
                order: 0,
                actions: []
            })
        }

        if(orderChanged){
            parsedScripts.sort((a, b) => b.order - a.order)
        }
        for (const script of parsedScripts){
            try {
                executeScript(script)
            } catch (error) {
                traceRuntimeEvent('script.regex.execution_error', {
                    mode,
                    chatID,
                    error,
                })
                console.error(error)
            }
        }

        if(db.dynamicAssets && (char.type === 'simple' || char.type === 'character') && char.additionalAssets && char.additionalAssets.length > 0){
            if((!db.dynamicAssetsEditDisplay && mode === 'editdisplay')
                || mode === 'editinput' || mode === 'editprocess'){
                cacheScript(hash, data)
                return {data, emoChanged}
            }
            const assetNames = char.additionalAssets.map((v) => v[0])

            const moduleAssets = getModuleAssets()
            if(moduleAssets.length > 0){
                for(const asset of moduleAssets){
                    assetNames.push(asset[0])
                }
            }

            const processer = new HypaProcesser()
            await processer.addText(assetNames)
            const matches = data.matchAll(assetRegex)

            for(const match of matches){
                const type = match[1]
                const assetName = match[2]
                const cacheKey = char.chaId + '::' + assetName
                if(type !== 'emotion' && type !== 'source'){
                    if(bestMatchCache.has(cacheKey)){
                        data = data.replaceAll(match[0], `{{${type}::${bestMatchCache.get(cacheKey)}}}`)
                    }
                    else if(!assetNames.includes(assetName)){
                        const searched = await processer.similaritySearch(assetName)
                        const bestMatch = searched[0]
                        if(bestMatch){
                            data = data.replaceAll(match[0], `{{${type}::${bestMatch}}}`)
                            bestMatchCache.set(cacheKey, bestMatch)
                        }
                    }
                }
            }
        }

        cacheScript(hash, data)
        traceRuntimeEvent('script.regex.complete', {
            mode,
            chatID,
            scriptCount: parsedScripts.length,
            outputLength: data.length,
            emoChanged,
        })

        return {data, emoChanged}
    }
    catch (error) {
        traceStatus = 'error'
        traceRuntimeEvent('script.processScriptFull.error', {
            mode,
            chatID,
            error,
        })
        throw error
    }
    finally {
        finishRuntimeTraceScope(traceScope, traceStatus, {
            mode,
            chatID,
            outputLength: data.length,
        })
    }
}


const rgx = /(?:{{|<)(.+?)(?:}}|>)/gm
export const risuChatParser = risuChatParserOrg
