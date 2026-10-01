/** Isolated source diagnostic: actual Chats, DB proxy and save encoder.
 * Chat's display body is a delayed fixture; its 80ms delay is injected, not
 * an estimate of the live user's parser/assets. No service data is loaded.
 */
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createServer as createHttpServer } from 'node:http'
import assert from 'node:assert/strict'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const repo = root
const require = createRequire(join(repo, 'package.json'))
const { compile, compileModule } = require('svelte/compiler')
const { build } = await import(require.resolve('vite'))
const e2e = require(join(repo, 'server/node/runtimeGenerations/browserE2E.cjs'))
const temp = await mkdtemp(join(tmpdir(), 'risu-ui-analysis-'))
const sourcePaths = {
    chats: 'src/lib/ChatScreens/Chats.svelte',
    state: 'src/ts/storage/databaseState.svelte.ts',
    encoder: 'src/ts/storage/risuSave.ts',
}
const sources = Object.fromEntries(
    await Promise.all(
        Object.entries(sourcePaths).map(async ([k, p]) => [
            k,
            await readFile(join(repo, p), 'utf8'),
        ]),
    ),
)
// Compiler cannot accept the TS type syntax in compileModule. Vite's TS
// transform strips it first, retaining the real module body and rune calls.
const { transformWithEsbuild } = await import(require.resolve('vite'))
const stateJS = (
    await transformWithEsbuild(sources.state, 'databaseState.ts', {
        loader: 'ts',
    })
).code
const bodySource = await readFile(
    join(repo, 'src/lib/ChatScreens/ChatBody.svelte'),
    'utf8',
)
const bodyTemplate = bodySource.slice(
    bodySource.lastIndexOf('</script>') + '</script>'.length,
)
const bodyEffect = bodySource.slice(
    bodySource.lastIndexOf('    $effect(() => {'),
    bodySource.lastIndexOf('</script>'),
)
const modules = {
    chats: compile(sources.chats, {
        filename: join(repo, sourcePaths.chats),
        generate: 'client',
        dev: false,
    }).js.code,
    state: compileModule(stateJS, {
        filename: 'databaseState.svelte.js',
        generate: 'client',
        dev: false,
    }).js.code,
    stores: `import {writable} from 'svelte/store'; export {DBState} from 'virtual:state';
    export const selectedCharID=writable(0), ReloadChatPointer=writable({});
    export function createSimpleCharacter(c){return c;}`,
    globals:
        'export const chatFoldedStateMessageIndex={index:-1}; export const forageStorage={isAccount:false};',
    chars: 'export const getCharImage=()=>"";',
    database: `import {snapshot} from 'svelte/internal/client'; import {DBState} from 'virtual:state';
    export const presetTemplate={}; export function getDatabase(o={}){return o.snapshot?snapshot(DBState.db):DBState.db;}`,
    platform: 'export const isNodeServer=true, isTauri=false;',
    localforage:
        'export default {createInstance(){return {setItem:async()=>{},getItem:async()=>null,keys:async()=>[]}}};',
    tauri: 'export const BaseDirectory={AppData:0}; export const writeFile=async()=>{}, exists=async()=>false, mkdir=async()=>{}, readFile=async()=>new Uint8Array();',
    encoder: sources.encoder,
    snapshot: await readFile(
        join(repo, 'src/ts/storage/databaseSaveSnapshot.ts'),
        'utf8',
    ),
    entries: await readFile(
        join(repo, 'src/ts/runtime/chatPresentationEntries.ts'),
        'utf8',
    ),
    child: compile(
        `<script>
    import {onMount,onDestroy} from 'svelte';
    let {message,rawStreamingText}= $props();
    let ready=$state(false); let id;
    onMount(()=>{window.fixture.mounts++;id=setTimeout(()=>ready=true,80)});
    onDestroy(()=>{window.fixture.unmounts++;clearTimeout(id)});
    export function updateStreamingDisplay(s){rawStreamingText=s.rawStreamingText}
    </script>{#if ready}<p class="probe-body">{rawStreamingText||message}</p>{/if}`,
        { filename: 'DelayedChat.svelte', generate: 'client', dev: false },
    ).js.code,
    awaitProbe: compile(
        `<script lang="ts">
    let lastParsed=$state(''); let retainedRawStreamingText=$state(null); const isAbortError=()=>false; let markParsingResult=$state(Promise.resolve('<input class="probe-radio" type="radio">'));
    let shouldRenderRawStreaming=false, rawStreamingText='',modelShortName='';
    const addMetadataToElement=x=>x,trimRenderedMarkdown=x=>x,checkImg=()=>{};
    window.replaceAwaitPromise=()=>markParsingResult=new Promise(resolve=>setTimeout(()=>resolve('<input class="probe-radio" type="radio">'),80));
    ${bodyEffect}
    </script>${bodyTemplate}`,
        {
            filename: 'ActualChatBodyAwaitFragment.svelte',
            generate: 'client',
            dev: false,
        },
    ).js.code,
    harness: compile(
        `<script>
    import Chats from 'virtual:chats'; import {DBState} from 'virtual:state';
    let outputs=$state([]);
    window.setOutputs=x=>outputs=x;
    let c=$derived(DBState.db.characters[0]);
    </script><Chats messages={c.chats[0].message} currentCharacter={c}
      onReroll={()=>{}} unReroll={()=>{}} currentUsername="Fixture" userIcon="" loadPages={30} assistantOutputs={outputs}/>`,
        { filename: 'Harness.svelte', generate: 'client', dev: false },
    ).js.code,
    entry: `import {mount,tick} from 'svelte'; import {snapshot} from 'svelte/internal/client';
    import {DBState,setDatabaseLite} from 'virtual:state';
    import {ReloadChatPointer} from 'virtual:stores'; import Harness from 'virtual:harness';import AwaitProbe from 'virtual:awaitProbe';
    import {RisuSaveEncoder} from 'virtual:encoder';
    import {snapshotDatabaseForSave} from 'virtual:snapshot';
    const wait=ms=>new Promise(r=>setTimeout(r,ms));
    window.fixture={mounts:0,unmounts:0};
    const small=()=>({characters:[{chaId:'c0',name:'Fixture',type:'character',chatPage:0,chats:[{id:'room',message:[]}]}],globalChatVariables:{},botPresets:[],modules:[],loadouts:[],plugins:[],pluginCustomStorage:{},streamingDisplayOptimizationMode:'off'});
    setDatabaseLite(small()); mount(Harness,{target:document.body});mount(AwaitProbe,{target:document.body});
    window.runDiagnostic=async()=>{
      window.setOutputs([{messageId:'m0',commandId:'command0',messageIndex:0,createdAt:1,data:'response',version:1,optimizationMode:'off'}]);
      await wait(120); const old=document.querySelector('.probe-body');
      DBState.db.characters[0].chats[0].message.push({role:'char',data:'response',chatId:'m0'});
      window.setOutputs([]); await tick();
      const handoff={oldBodyConnected:old.isConnected,bodiesDuringPending:document.querySelectorAll('.probe-body').length,mounts:window.fixture.mounts,unmounts:window.fixture.unmounts,injectedBodyDelayMs:80};
      await wait(120); handoff.bodiesAfterReady=document.querySelectorAll('.probe-body').length;
      const beforeReload=document.querySelector('.probe-body'); ReloadChatPointer.set({0:1}); await tick();
      const reload={oldBodyConnected:beforeReload.isConnected,bodiesDuringPending:document.querySelectorAll('.probe-body').length,mounts:window.fixture.mounts,unmounts:window.fixture.unmounts};
      await wait(120);
      const beforeEdit=document.querySelector('.probe-body');DBState.db.characters[0].chats[0].message[0].data='changed';await tick();
      const edit={oldBodyConnected:beforeEdit.isConnected,bodiesDuringPending:document.querySelectorAll('.probe-body').length,mounts:window.fixture.mounts,unmounts:window.fixture.unmounts};
      await wait(120);
      let previousRadio=document.querySelector('.probe-radio');previousRadio.checked=true;
      window.replaceAwaitPromise();await tick();
      const awaitFragment={pendingRetainsOldNode:previousRadio.isConnected,pendingChecked:document.querySelector('.probe-radio').checked};
      previousRadio=document.querySelector('.probe-radio');await wait(120);
      awaitFragment.readyRetainsPendingNode=previousRadio.isConnected;awaitFragment.readyChecked=document.querySelector('.probe-radio').checked;
      const sizes=[];
      for(const [characters,messages] of [[5,100],[30,500],[60,1000]]){
        const db=small();db.characters=Array.from({length:characters},(_,c)=>({chaId:'c'+c,name:'C'+c,type:'character',chatPage:0,chats:[{id:'room'+c,message:Array.from({length:messages},(_,m)=>({role:'char',chatId:'m'+c+'_'+m,data:'fixture '.repeat(64)}))}]}));
        const jsonBytes=new TextEncoder().encode(JSON.stringify(db)).length;
        let t=performance.now();setDatabaseLite(db);const attachMs=performance.now()-t;
        await tick();
        // Snapshot matches getDatabase({snapshot:true}) exactly. The later
        // canonical navigation/filter traversal and network CAS are excluded.
        const samples=[];for(let n=0;n<5;n++){t=performance.now();snapshot(DBState.db);samples.push(performance.now()-t)}
        samples.sort((a,b)=>a-b);
        const data=snapshot(DBState.db);const enc=new RisuSaveEncoder();await enc.init(data,{compression:false});
        const flags=()=>({character:[],botPreset:false,modules:false,loadouts:false,plugins:false,pluginCustomStorage:false});
        const rootSamples=[],characterSamples=[];
        for(let n=0;n<5;n++){
          t=performance.now();snapshotDatabaseForSave(DBState.db,flags(),snapshot,id=>enc.hasCharacterBlock(id));rootSamples.push(performance.now()-t);
          t=performance.now();snapshotDatabaseForSave(DBState.db,{...flags(),character:['c0']},snapshot,id=>enc.hasCharacterBlock(id));characterSamples.push(performance.now()-t);
        }
        rootSamples.sort((a,b)=>a-b);characterSamples.sort((a,b)=>a-b);
        DBState.db.globalChatVariables.toggle_example='1';
        const captured=snapshotDatabaseForSave(DBState.db,flags(),snapshot,id=>enc.hasCharacterBlock(id));
        t=performance.now();await enc.set(captured.database,flags());const encoderSetMs=performance.now()-t;
        t=performance.now();const bytes=enc.encode();const assembleMs=performance.now()-t;
        sizes.push({characters,messagesPerCharacter:messages,totalMessages:characters*messages,jsonBytes,attachMs,snapshotMedianMs:samples[2],snapshotSamplesMs:samples,rootSnapshotMedianMs:rootSamples[2],characterSnapshotMedianMs:characterSamples[2],encoderSetMs,assembleMs,encodedBytes:bytes.byteLength});
        await wait(25);
      }
      return {handoff,reload,edit,awaitFragment,sizes};
    };window.ready=true;`,
}

let cdp, http
try {
    const output = await build({
        configFile: false,
        root: repo,
        logLevel: 'error',
        plugins: [
            {
                name: 'isolated-source-fixture',
                resolveId(id, importer) {
                    if (id.startsWith('virtual:')) return '\\0' + id
                    if (!importer?.includes('virtual:')) return null
                    const mapping = {
                        'src/ts/stores.svelte': 'stores',
                        'src/ts/characters': 'chars',
                        'src/ts/globalApi.svelte': 'globals',
                        './Chat.svelte': 'child',
                        'src/ts/runtime/chatPresentationEntries': 'entries',
                        './database.svelte': 'database',
                        '../globalApi.svelte': 'globals',
                        'src/ts/platform': 'platform',
                        localforage: 'localforage',
                        '@tauri-apps/plugin-fs': 'tauri',
                    }
                    return mapping[id] ? '\\0virtual:' + mapping[id] : null
                },
                load(id) {
                    return id.startsWith('\\0virtual:')
                        ? modules[id.slice('\\0virtual:'.length)]
                        : null
                },
                async transform(code, id) {
                    if (
                        id === '\\0virtual:encoder' ||
                        id === '\\0virtual:entries' ||
                        id === '\\0virtual:snapshot'
                    )
                        return (
                            await transformWithEsbuild(code, 'fixture.ts', {
                                loader: 'ts',
                            })
                        ).code
                },
            },
        ],
        build: {
            write: false,
            minify: false,
            target: 'esnext',
            rollupOptions: { input: 'virtual:entry', output: { format: 'es' } },
        },
        resolve: { conditions: ['browser'] },
    })
    const bundle = output.output.find(
        (x) => x.type === 'chunk' && x.isEntry,
    ).code
    await writeFile(join(temp, 'fixture.js'), bundle)
    http = createHttpServer((req, res) => {
        res.setHeader(
            'Content-Type',
            req.url === '/fixture.js' ? 'text/javascript' : 'text/html',
        )
        res.end(
            req.url === '/fixture.js'
                ? bundle
                : '<!doctype html><body><script type="module" src="/fixture.js"></script>',
        )
    })
    await new Promise((r) => http.listen(0, '127.0.0.1', r))
    process.env.RISU_BROWSER_E2E_CHROMIUM ??= '/usr/bin/chromium'
    e2e.setTemporaryRoot(temp)
    cdp = await e2e.launchChromium()
    const page = await cdp.createPage({
        width: 1200,
        height: 800,
        name: 'performance-fixture',
    })
    await page.navigate('http://127.0.0.1:' + http.address().port)
    await page.waitFor('window.ready===true')
    const result = await page.evaluate('window.runDiagnostic()')
    for (const c of [result.handoff, result.reload, result.edit]) {
        assert.equal(c.oldBodyConnected, true)
        assert.equal(c.bodiesDuringPending, 1)
    }
    assert.equal(result.handoff.bodiesAfterReady, 1)
    assert.deepEqual(result.awaitFragment, {
        pendingRetainsOldNode: true,
        pendingChecked: true,
        readyRetainsPendingNode: true,
        readyChecked: true,
    })
    const record = {
        observedAt: new Date().toISOString(),
        baselineCommit: '782da98789732d175408c9fcec7d0734c325fef3',
        chromium: await page.evaluate('navigator.userAgent'),
        scope: 'Actual source Chats with delayed child double; exact ChatBody template/effect fragment with identity formatting and injected 80ms promise; actual database proxy, full and incremental snapshot; actual RisuSaveEncoder with Node platform/cache/storage doubles. No canonical filter traversal, network, providers or live data.',
        ...result,
    }
    await writeFile(
        process.env.RISU_UI_PERFORMANCE_RESULT ?? join(temp, 'result.json'),
        JSON.stringify(record, null, 2) + '\n',
    )
    console.log(JSON.stringify(record, null, 2))
} finally {
    if (cdp) await cdp.close()
    await e2e.stopAllChildren()
    if (http) await new Promise((r) => http.close(r))
    await rm(temp, { recursive: true, force: true })
}
