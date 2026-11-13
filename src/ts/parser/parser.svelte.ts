import DOMPurify from 'dompurify';
import markdownit from 'markdown-it'
import { appVer, getCurrentCharacter, getDatabase, type Database, type character, type customscript, type groupChat, type triggerscript } from '../storage/database.svelte';
import { CurrentTriggerIdStore, DBState, selIdState } from '../stores.svelte';
import { aiWatermarkingLawApplies, getFileSrc } from '../globalApi.svelte';
import { isTauri, isNodeServer } from "src/ts/platform"
import { getChatVar, setChatVar, getGlobalChatVar } from './chatVar.svelte';
import { processScriptFull } from '../process/scripts';
import { entityRuntimeEnabled } from '../runtime/browserRuntimeState.svelte';
import { displayMetadata } from '../runtime/browserDisplayMetadata';
import { captureDisplayScope, commitDisplayScope, createDisplayAdmission } from '../process/scriptings';
import { createDisplayCbsScope } from '../runtime/displayCbsScope';
import type { DisplayCapture } from '../runtime/displayEffects';
import { yieldDisplayTurn } from '../runtime/displayScheduling';
import { forkDisplayScope } from '../runtime/displayScopeCache.svelte';
import { inheritDisplayReads } from '../runtime/displayReadDependencies';
import type { DisplayRenderCache, DisplayRenderTicket } from '../runtime/displayRenderCache';
import { get } from 'svelte/store';
import css, { type CssAtRuleAST } from '@adobe/css-tools'
import { selectedCharID } from '../stores.svelte';
import { calcString } from '../process/infunctions';
import { findCharacterbyId, getPersonaPrompt, getUserIcon, getUserName, pickHashRand, replaceAsync} from '../util';
import { getInlayAssetBlob } from '../process/files/inlays';
import { getModuleAssets, getModuleLorebooks, getModules } from '../process/modules';
import hljs from 'highlight.js/lib/core'
import 'highlight.js/styles/atom-one-dark.min.css'
import { language } from 'src/lang';
import katex from 'katex'
import { getModelInfo } from '../model/modellist';
import { createCbsRuntime, type CbsConditions } from './cbsRuntime';
export type { CbsConditions } from './cbsRuntime';
import { risuEscape, risuUnescape } from './cbsText';
export { risuEscape, risuUnescape } from './cbsText';
import { formatThoughtTools } from './thoughtToolFormatting';
import cssSelectorParser from 'postcss-selector-parser'

const markdownItOptions = {
    html: true,
    breaks: true,
    linkify: false,
    typographer: true,
    quotes: '\u{E9b0}\u{E9b1}\u{E9b2}\u{E9b3}', //placeholder characters to convert to real quotes
}

const md = markdownit(markdownItOptions)
const mdHighlight = markdownit({
    highlight: function (str, lang) {
        if(lang){
            return `<pre-hljs-placeholder lang="${lang}">`+ str +'</pre-hljs-placeholder>';
        }
        return ''
    },
    ...markdownItOptions
})

md.disable(['code'])
mdHighlight.disable(['code'])

export interface MarkdownPresentation {
  capture?: DisplayCapture;
  renderCache?: DisplayRenderCache;
  current?: () => boolean;
  finalize?: (
    html: string,
    current?: () => boolean,
  ) => Promise<string | undefined>;
}
type MarkdownContext = {
  settings: Database;
  parseCss: (data: string) => string;
  check: () => void;
};
let sanitizerSettings: Database | undefined;
function withSanitizerSettings<T>(
  settings: Database | undefined,
  action: () => T,
): T {
  const previous = sanitizerSettings;
  sanitizerSettings = settings;
  try {
    return action();
  } finally {
    sanitizerSettings = previous;
  }
}
function currentSanitizerSettings() {
  return sanitizerSettings ?? DBState.db;
}

DOMPurify.addHook("uponSanitizeElement", (node: HTMLElement, data) => {
    if (data.tagName === "iframe") {
       const src = node.getAttribute("src") || "";
       if (!src.startsWith("https://www.youtube.com/embed/")) {
          return node.parentNode.removeChild(node);
       }
    }
    if(data.tagName === 'img'){
        // Hide external images when hideAllImages is enabled
        if(currentSanitizerSettings()?.hideAllImages){
            const src = node.getAttribute("src") || "";
            // Replace with placeholder if it's an external/loaded image
            if(src && !src.startsWith('data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP')){
                node.setAttribute("src", "/none.webp");
                node.setAttribute("alt", "?");
            }
            return;
        }
        
        const loading = node.getAttribute("loading")
        if(!loading){
            node.setAttribute("loading","lazy")
        }
        const decoding = node.getAttribute("decoding")
        if(!decoding){
            node.setAttribute("decoding", "async")
        }
    }
});

DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
    switch(data.attrName){
        case 'style':{
            // Remove background-image URLs when hideAllImages is enabled
            if(currentSanitizerSettings()?.hideAllImages && data.attrValue){
                // Remove background-image property from inline styles
                data.attrValue = data.attrValue.replace(/background(-image)?:\s*url\([^)]*\);?/gi, '')
                // Also remove background property if it contains url()
                data.attrValue = data.attrValue.replace(/background:\s*[^;]*url\([^)]*\)[^;]*;?/gi, '')
            }
            break
        }
        case 'class':{
            if(data.attrValue){
                data.attrValue = data.attrValue.split(' ').map((v) => {
                    if(v.startsWith('hljs')){
                        return v
                    }
                    if(v.startsWith('x-risu-')){
                        return v
                    }
                    return "x-risu-" + v
                }).join(' ')
            }
            break
        }
        case 'href':{
            if(data.attrValue.startsWith('http://') || data.attrValue.startsWith('https://')){
                node.setAttribute('target', '_blank')
                break
            }
            data.attrValue = ''
            break
        }
    }
})

DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
    if (['IMG', 'SOURCE', 'VIDEO', 'AUDIO', 'STYLE'].includes(node.nodeName) && data.attrName === 'src') {
        if (data.attrValue.startsWith('blob:') || data.attrValue.startsWith('asset:')) {
            data.forceKeepAttr = true;
        }
    }
});


function renderMarkdown(
  md: markdownit,
  data: string,
  settings = DBState.db,
  reusable?: { value: boolean },
) {
  let quotes = ["“", "”", "‘", "’"];
  if (settings?.customQuotes) {
    quotes = settings.customQuotesData ?? quotes;
  }
  data = data.replace(/\$\$(.*?)\$\$/gs, (match: string, content: string) => {
    try {
      content = content
        .replace(/\uE9b8/gu, "{")
        .replace(/\uE9b9/gu, "}")
        .replace(/\uE9ba/gu, "(")
        .replace(/\uE9bb/gu, ")");
      const rendered = katex.renderToString(content, {
        displayMode: false,
        throwOnError: true,
        output: "mathml",
      });
      return rendered;
    } catch (error) {
      if (reusable) reusable.value = false;
      console.error("KaTeX render error:", error);
      return match;
    }
  });
  let text = risuUnescape(
    md.render(data.replace(/“|”/g, '"').replace(/‘|’/g, "'")),
  );

  if (settings?.unformatQuotes) {
    text = text.replace(/\uE9b0/gu, quotes[0]).replace(/\uE9b1/gu, quotes[1]);
    text = text.replace(/\uE9b2/gu, quotes[2]).replace(/\uE9b3/gu, quotes[3]);
  } else if (settings?.blockquoteStyling) {
    text = text
      .replace(/\uE9b0(.+?)\uE9b1/gmu, (full, content) => {
        content = content
          .replace(/\uE9b2/gu, '<mark risu-mark="quote1">' + quotes[2])
          .replace(/\uE9b3/gu, quotes[3] + "</mark>");
        return `<br><br><mark risu-mark="blockquote2">${quotes[0]}${content}${quotes[1]}</mark><br><br>`;
      })
      .replace(/\uE9b2(.+?)\uE9b3/gmu, (full, content) => {
        return `<br><br><mark risu-mark="blockquote1">${quotes[2]}${content}${quotes[3]}</mark><br><br>`;
      });

    //clean up any unmatched quote marks
    text = text.replace(/\uE9b0/gu, quotes[0]).replace(/\uE9b1/gu, quotes[1]);
    text = text.replace(/\uE9b2/gu, quotes[2]).replace(/\uE9b3/gu, quotes[3]);
  } else {
    text = text
      .replace(/\uE9b0/gu, '<mark risu-mark="quote2">' + quotes[0])
      .replace(/\uE9b1/gu, quotes[1] + "</mark>");
    text = text
      .replace(/\uE9b2/gu, '<mark risu-mark="quote1">' + quotes[2])
      .replace(/\uE9b3/gu, quotes[3] + "</mark>");
  }

  return text;
}

async function renderHighlightableMarkdown(
  data: string,
  settings = DBState.db,
  reusable?: { value: boolean },
) {
  let rendered = renderMarkdown(mdHighlight, data, settings, reusable);
  const highlightPlaceholders = rendered.match(
    /<pre-hljs-placeholder lang="(.+?)">(.+?)<\/pre-hljs-placeholder>/gms,
  );
  if (!highlightPlaceholders) {
    return rendered;
  }

  for (const placeholder of highlightPlaceholders) {
    try {
      let lang = placeholder.match(/lang="(.+?)"/)?.[1];
      const code = placeholder.match(
        /<pre-hljs-placeholder lang=".+?">(.+?)<\/pre-hljs-placeholder>/ms,
      )?.[1];
      if (!lang || !code) {
        continue;
      }
      //import language if not already loaded
      //we do not refactor this to a function because we want to keep vite to only import the languages that are needed
      let languageModule: typeof import("highlight.js/lib/languages/*") | null =
        null;
      let fileExt = "";

      switch (lang) {
        case "bash": {
          fileExt = "sh";
          lang = "bash";
          if (!hljs.getLanguage("bash")) {
            languageModule = await import("highlight.js/lib/languages/bash");
          }
          break;
        }
        case "c":
        case "cpp": {
          fileExt = lang;
          lang = "cpp";
          if (!hljs.getLanguage("cpp")) {
            languageModule = await import("highlight.js/lib/languages/cpp");
          }
          break;
        }
        case "cs":
        case "csharp": {
          fileExt = "cs";
          lang = "csharp";
          if (!hljs.getLanguage("csharp")) {
            languageModule = await import("highlight.js/lib/languages/csharp");
          }
          break;
        }
        case "css": {
          fileExt = "css";
          lang = "css";
          if (!hljs.getLanguage("css")) {
            languageModule = await import("highlight.js/lib/languages/css");
          }
          break;
        }
        case "dart": {
          fileExt = "dart";
          lang = "dart";
          if (!hljs.getLanguage("dart")) {
            languageModule = await import("highlight.js/lib/languages/dart");
          }
          break;
        }
        case "html":
        case "svg":
        case "xml": {
          fileExt = lang;
          lang = "xml";
          if (!hljs.getLanguage("xml")) {
            languageModule = await import("highlight.js/lib/languages/xml");
          }
          break;
        }
        case "java": {
          fileExt = "java";
          lang = "java";
          if (!hljs.getLanguage("java")) {
            languageModule = await import("highlight.js/lib/languages/java");
          }
          break;
        }
        case "js":
        case "jsx":
        case "javascript": {
          fileExt = "js";
          lang = "javascript";
          if (!hljs.getLanguage("javascript")) {
            languageModule =
              await import("highlight.js/lib/languages/javascript");
          }
          break;
        }
        case "json": {
          fileExt = "json";
          lang = "json";
          if (!hljs.getLanguage("json")) {
            languageModule = await import("highlight.js/lib/languages/json");
          }
          break;
        }
        case "lua": {
          fileExt = "lua";
          lang = "lua";
          if (!hljs.getLanguage("lua")) {
            languageModule = await import("highlight.js/lib/languages/lua");
          }
          break;
        }
        case "markdown":
        case "md": {
          fileExt = "md";
          lang = "markdown";
          if (!hljs.getLanguage("markdown")) {
            languageModule =
              await import("highlight.js/lib/languages/markdown");
          }
          break;
        }
        case "py":
        case "python": {
          fileExt = "py";
          lang = "python";
          if (!hljs.getLanguage("python")) {
            languageModule = await import("highlight.js/lib/languages/python");
          }
          break;
        }
        case "rust": {
          fileExt = "rs";
          lang = "rust";
          if (!hljs.getLanguage("rust")) {
            languageModule = await import("highlight.js/lib/languages/rust");
          }
          break;
        }
        case "shell": {
          fileExt = "sh";
          lang = "shell";
          if (!hljs.getLanguage("shell")) {
            languageModule = await import("highlight.js/lib/languages/shell");
          }
          break;
        }
        case "ts":
        case "tsx":
        case "typescript": {
          fileExt = "ts";
          lang = "typescript";
          if (!hljs.getLanguage("typescript")) {
            languageModule =
              await import("highlight.js/lib/languages/typescript");
          }
          break;
        }
        case "txt":
        case "vtt": {
          fileExt = lang;
          lang = "plaintext";
          if (!hljs.getLanguage("plaintext")) {
            languageModule =
              await import("highlight.js/lib/languages/plaintext");
          }
          break;
        }
        case "yaml": {
          fileExt = "yml";
          lang = "yaml";
          if (!hljs.getLanguage("yaml")) {
            languageModule = await import("highlight.js/lib/languages/yaml");
          }
          break;
        }
        case "risuerror": {
          lang = "error";
          fileExt = "error";
          break;
        }
        default: {
          lang = "none";
          fileExt = "none";
        }
      }
      if (languageModule) {
        hljs.registerLanguage(lang, languageModule.default);
      }
      if (lang === "none") {
        rendered = rendered.replace(
          placeholder,
          `<pre><code>${md.utils.escapeHtml(code)}</code></pre>`,
        );
      } else if (lang === "error") {
        rendered = rendered.replace(
          placeholder,
          `<div class="risu-error"><h1>${language.error}</h1>${md.utils.escapeHtml(code)}</div>`,
        );
      } else {
        const highlighted = hljs.highlight(code, {
          language: lang,
          ignoreIllegals: true,
        }).value;
        rendered = rendered.replace(
          placeholder,
          `<pre class="hljs" x-hl-lang="${fileExt}"><code>${highlighted}</code></pre>`,
        );
      }
    } catch (error) {
      if (reusable) reusable.value = false;
    }
  }

  return rendered;
}

export { assetRegex } from "./assetSyntax";
import { assetRegex } from "./assetSyntax";

function getAssetSrc(assetArr: string[][], assetPaths: AssetPaths) {
    for (const asset of assetArr) {
        const key = asset[0].toLocaleLowerCase()
        assetPaths[key] ??= {
            srcPaths: [],
            ext: asset[2]
        }
        if(assetPaths[key].ext === asset[2]){
            assetPaths[key].srcPaths.push(asset[1])
        }
    }
}

function getEmoSrc(emoArr: string[][], emoPaths: AssetPaths) {
    for (const emo of emoArr) {
        emoPaths[emo[0].toLocaleLowerCase()] = {
            srcPaths: [emo[1]]
        }
    }
}

const fileSrcCache = new Map<string, string>()

async function getFileSrcCached(path:string){
    let cached = fileSrcCache.get(path)
    if(cached){
        return cached
    }
    const src = await getFileSrc(path)
    fileSrcCache.set(path, src)
    return src
}

type AssetPaths = {[key:string]:{
    srcPaths:string[]
    ext?:string
}}

let assetsCache: AssetPaths | null = null
let emoAssetsCache: AssetPaths | null = null

export function resetAssetsCache(charAssets: string[][], emoAssets: string[][], moduleAssets: string[][]) {
    const assetPaths: AssetPaths = {}
    const charEmoPaths: AssetPaths = {}

    getAssetSrc(charAssets, assetPaths)
    getAssetSrc(moduleAssets, assetPaths)
    getEmoSrc(emoAssets, charEmoPaths)

    assetsCache = assetPaths
    emoAssetsCache = charEmoPaths
}

$effect.root(() => {
    $effect(() => {
        const charId = selIdState.selId
        const char = DBState.db.characters?.[charId]
        if (!char || char.type !== 'character') {
            return
        }

        const charAssets = char.additionalAssets ?? []
        const emoAssets = char.emotionImages ?? []
        const moduleAssets = getModuleAssets()

        resetAssetsCache(charAssets, emoAssets, moduleAssets)
    })
})

const imageCBS = ['img', 'image', 'emotion', 'asset', 'bg', 'raw', 'path']
const videoExtensions = ['mp4', 'webm', 'avi', 'm4p', 'm4v']

async function parseAdditionalAssets(data:string, char:simpleCharacterArgument|character, mode:'normal'|'back', arg:{ch:number}){
    const capture = entityRuntimeEnabled
      ? displayMetadata.get(char)?.capture
      : undefined;
    const settings = capture?.database ?? DBState.db;
    const assetWidthString =
      (settings.assetWidth && settings.assetWidth !== -1) ||
      settings.assetWidth === 0
        ? `max-width:${settings.assetWidth}rem;`
        : "";

    let assetPaths: AssetPaths;
    let emoPaths: AssetPaths;
    if (capture && capture.character.type === "character") {
      assetPaths = {};
      emoPaths = {};
      getAssetSrc(capture.character.additionalAssets ?? [], assetPaths);
      getAssetSrc(
        capture.cbsModules?.flatMap((module) => module.assets ?? []) ?? [],
        assetPaths,
      );
      getEmoSrc(capture.character.emotionImages ?? [], emoPaths);
    } else {
      if (char.type === "character" && (!assetsCache || !emoAssetsCache)) {
        resetAssetsCache(
          char.additionalAssets ?? [],
          char.emotionImages,
          getModuleAssets(),
        );
      }
      assetPaths = assetsCache ?? {};
      emoPaths = emoAssetsCache ?? {};
    }

    let needsSourceAccess = false
    let cx: number|null = null

    data = await replaceAsync(data, assetRegex, async (full:string, type:string, name:string) => {
        name = name.toLocaleLowerCase()

        // Skip image-related assets when hideAllImages is enabled
        // raw and path are also included as they're used in CSS background-image
        if(settings.hideAllImages && imageCBS.includes(type)){
            return ''  // Hide the image asset
        }

        if(type === 'emotion'){
            const srcPath = emoPaths?.[name]?.srcPaths?.[0]
            const path = srcPath ? await getFileSrcCached(srcPath) : null
            if(!path){
                return ''
            }
            return `<img src="${path}" alt="${path}" style="${assetWidthString} "/>`
        }

        if(type === 'source'){
            needsSourceAccess = true
            switch(name){
                case 'char':{
                    return '\uE9b4CHAR\uE9b4'
                }
                case 'user': {
                    return '\uE9b4USER\uE9b4'
                }
            }
        }

        let match = assetPaths?.[name]

        if(!match){
            if(settings.legacyMediaFindings){
                return ''
            }

            if(assetPaths){
                match = getClosestMatch(capture?.character.type === 'character' ? capture.character : char, name, assetPaths, settings.assetMaxDifference)
            }

            if(!match){
                return ''
            }
        }

        let pSrc = match.srcPaths[0]

        if(match.srcPaths.length > 1){
            if(cx === null){
                const chatID = arg.ch
                cx = pickHashRand(chatID, (char.chaId || 'global') + chatID)
            }
            const selIndex = Math.floor(cx * match.srcPaths.length)
            pSrc = match.srcPaths[selIndex]
        }

        const p = await getFileSrcCached(pSrc)
        switch(type){
            case 'raw':
            case 'path':
                return p
            case 'img':
                return `<img src="${p}" alt="${p}" style="${assetWidthString} "/>`
            case 'image':
                return `<div class="risu-inlay-image"><img src="${p}" alt="${p}" style="${assetWidthString}"/></div>\n`
            case 'video':
                return `<video controls autoplay loop><source src="${p}" type="video/mp4"></video>\n`
            case 'video-img':
                return `<video autoplay muted loop><source src="${p}" type="video/mp4"></video>\n`
            case 'audio':
                return `<audio controls autoplay loop><source src="${p}" type="audio/mpeg"></audio>\n`
            case 'bg':
                if(mode === 'back'){
                    return `<div style="width:100%;height:100%;background: linear-gradient(rgba(0, 0, 0, 0.8), rgba(0, 0, 0, 0.8)),url(${p}); background-size: cover;"></div>`
                }
                break
            case 'asset':{
                if(match.ext && videoExtensions.includes(match.ext)){
                    return `<video autoplay muted loop><source src="${p}" type="video/mp4"></video>\n`
                }
                return `<img src="${p}" alt="${p}" style="${assetWidthString} "/>\n`
            }
            case 'bgm':
                return `<div risu-ctrl="bgm___auto___${p}" style="display:none;"></div>\n`
        }
        return ''
    })

    if(needsSourceAccess){
        const chara = capture?.character ?? getCurrentCharacter();
        const userIcon = capture
          ? createDisplayCbsScope(
              capture,
              getBrowserCbsHost(),
            ).util.getUserIcon()
          : getUserIcon();
        if (chara.image) {
        }
        data = data.replace(
          /\uE9b4CHAR\uE9b4/g,
          chara.image ? await getFileSrc(chara.image) : "",
        );

        data = data.replace(
          /\uE9b4USER\uE9b4/g,
          userIcon ? await getFileSrc(userIcon) : "",
        );
    }
    
    return data
}

function getClosestMatch(char: simpleCharacterArgument|character, name:string, assetPaths:AssetPaths, maxDifference=DBState.db.assetMaxDifference){
    if(!char.additionalAssets) return null

    let closest = ''
    let closestDist = 999999
    let targetPath = ''
    let targetExt = ''

    const trimmedName = trimmer(name)
    for(const asset of char.additionalAssets) {
        const key = asset[0].toLocaleLowerCase()
        const dist = getDistance(trimmedName, trimmer(key))
        if(dist < closestDist){
            closest = key
            closestDist = dist
            targetPath = asset[1]
            targetExt = asset[2]
        }
    }
    
    if(closestDist > maxDifference){
        return null
    }

    assetPaths[closest] = {
        srcPaths: [targetPath],
        ext: targetExt
    }

    return assetPaths[closest]
}

//Levenshtein distance, new with 1d array
export function getDistance(a:string, b:string) {
    const h = a.length + 1
    const w = b.length + 1
    let d = new Int16Array(h * w)
    for(let i=0;i<h;i++){
        d[i * w] = i
    }
    for(let i=0;i<w;i++){
        d[i] = i
    }
    for(let i=1; i<h; i++){
        for(let j=1;j<w;j++){
            d[i * w + j] = Math.min(
                d[(i-1) * w + j-1] + (a.charAt(i-1)===b.charAt(j-1) ? 0 : 1),
                d[(i-1) * w + j]+1, d[i * w + j-1]+1
            )
        }
    }
    return d[h * w - 1]
}

function trimmer(str:string){
    const ext = ['webp', 'png', 'jpg', 'jpeg', 'gif', 'mp4', 'webm', 'avi', 'm4p', 'm4v', 'mp3', 'wav', 'ogg']
    for(const e of ext){
        if(str.endsWith('.' + e)){
            str = str.substring(0, str.length - e.length - 1)
        }
    }

    return str.trim().replace(/[_ -.]/g, '')
}

const blobUrlCache = new Map<string, string>()

async function parseInlayAssets(data:string, settings=DBState.db){
    const inlayMatch = data.match(/{{(inlay|inlayed|inlayeddata)::(.+?)}}/g)
    if(inlayMatch){
        for(const inlay of inlayMatch){
            const inlayType = inlay.startsWith('{{inlayed') ? 'inlayed' : 'inlay'
            const id = inlay.substring(inlay.indexOf('::') + 2, inlay.length - 2)
            let prefix = inlayType !== 'inlay' ? `<div class="risu-inlay-image">` : ''
            let postfix = inlayType !== 'inlay' ? `</div>\n\n` : ''

            const asset = await getInlayAssetBlob(id)
            let url = blobUrlCache.get(id)
            if(!url && asset?.data){
                url = URL.createObjectURL(asset.data)
                blobUrlCache.set(id, url)
            } 
            switch(asset?.type){
                case 'image':
                    // Hide inlay images when hideAllImages is enabled
                    if(settings.hideAllImages){
                        data = data.replace(inlay, '')
                        break
                    }
                    data = data.replace(inlay, `${prefix}<img src="${url}"/>${postfix}`)
                    break
                case 'video':
                    data = data.replace(inlay, `${prefix}<video controls><source src="${url}" type="video/mp4"></video>${postfix}`)
                    break
                case 'audio':
                    data = data.replace(inlay, `${prefix}<audio controls><source src="${url}" type="audio/mpeg"></audio>${postfix}`)
                    break
            }
            
        }
    }
    return data
}

export interface simpleCharacterArgument{
    type: 'simple'
    additionalAssets?: [string, string, string][]
    customscript: customscript[]
    chaId: string,
    virtualscript?: string
    emotionImages?: [string, string][]
    triggerscript?: triggerscript[]
}

function parseThoughtsAndTools(data:string){
    let result = '', i = 0
    while (i < data.length) {
        if (data.slice(i, i + 10) === '<Thoughts>') {
            let j = i + 10, depth = 1
            while (j < data.length && depth > 0) {
                if (data.slice(j, j + 10) === '<Thoughts>') depth++
                if (data.slice(j, j + 11) === '</Thoughts>') depth--
                j++
            }
            if (depth === 0) {
                result += `<details><summary>${language.cot}</summary>${data.substring(i + 10, j - 1)}</details>`
                i = j + 10
                continue
            }
        }
        result += data[i++]
    }
    return result.replace(/<tool_call>(.+?)<\/tool_call>/gms, (full, txt:string) => {
        return `<div class="x-risu-tool-call">🛠️ ${language.toolCalled.replace('{{tool}}',txt.split('\uf100')?.[1] ?? 'unknown')}</div>\n\n`
    })
}

// Only the immutable formatting stage is reusable. Script execution, asset
// resolution, captures, CSS CBS and effect admission keep their own lifetimes.
function displayRenderKey(settings: Database) {
  if (settings.plugins?.length) return undefined;
  const quotes = settings.customQuotes
    ? (settings.customQuotesData ?? ["“", "”", "‘", "’"])
    : ["“", "”", "‘", "’"];
  if (
    !Array.isArray(quotes) ||
    quotes.length !== 4 ||
    quotes.some((value) => typeof value !== "string")
  )
    return undefined;
  return JSON.stringify([
    quotes,
    Boolean(settings.unformatQuotes),
    Boolean(settings.blockquoteStyling),
    language.error,
  ]);
}

export async function ParseMarkdown(
  data: string,
  charArg: character | simpleCharacterArgument | groupChat | string = null,
  mode: "normal" | "back" | "pretranslate" | "notrim" = "normal",
  chatID = -1,
  cbsConditions: CbsConditions = {},
  presentation?: MarkdownPresentation,
) {
  let firstParsed = "";
  const additionalAssetMode = mode === "back" ? "back" : "normal";
  const processingChar =
    typeof charArg === "string" ? findCharacterbyId(charArg) : charArg;
  // Original group rows supply no simple character, but still have a captured
  // canonical owner. Finalize their HTML under that owner/settings without
  // introducing character scripts the original null argument would skip.
  let char =
    processingChar ??
    (entityRuntimeEnabled ? presentation?.capture?.character : undefined);
  if (entityRuntimeEnabled && char) {
    const supplied = presentation?.capture;
    if (
      supplied &&
      (supplied.character.chaId !== char.chaId ||
        (!cbsConditions.firstmsg &&
          cbsConditions.messageId &&
          supplied.message?.id !== cbsConditions.messageId))
    )
      throw new Error(
        "Display presentation source does not belong to its captured owner",
      );
    const capture = supplied
      ? forkDisplayScope(supplied, supplied, supplied.cbsEnvironment)
      : captureDisplayScope(
          chatID,
          Boolean(cbsConditions.firstmsg),
          char.chaId,
          cbsConditions.messageId,
          cbsConditions.bookmarkSession,
        );
    if (supplied && capture) {
      capture.presentationVariables = supplied.presentationVariables;
      inheritDisplayReads(supplied, capture);
    }
    char = { ...char };
    displayMetadata.set(char, {
      firstMessage: Boolean(cbsConditions.firstmsg),
      rawContent: data,
      captured: true,
      capture,
      current: presentation?.current,
      admit: capture && createDisplayAdmission(capture),
    });
  }
  const capture =
    entityRuntimeEnabled && char
      ? displayMetadata.get(char)?.capture
      : undefined;
  let cssScope: ReturnType<typeof createDisplayCbsScope> | undefined;
  const context: MarkdownContext | undefined = capture
    ? {
        settings: capture.database,
        parseCss: (text) => {
          cssScope ??= createDisplayCbsScope(capture, getBrowserCbsHost());
          // Original CSS decoding parses with default CBS arguments (-1),
          // while every state/definition/body still belongs to this owner.
          return cssScope.parse(text, { db: cssScope.database });
        },
        check: () => cssScope?.check(),
      }
    : undefined;
  let preparedHtml: string | undefined;
  let preparedSanitized = false;
  const renderCache = context && presentation?.renderCache;
  let renderTicket: DisplayRenderTicket | undefined;
  const sanitize = (html: string) => {
    const key = String(Boolean(context?.settings.hideAllImages));
    const cached =
      renderTicket && renderCache?.sanitized(renderTicket, html, key);
    if (cached !== undefined) return cached;
    const rendered = trimMarkdown(html, context);
    if (renderTicket)
      renderCache?.rememberSanitized(renderTicket, html, key, rendered);
    return rendered;
  };
  if (presentation && entityRuntimeEnabled) {
    presentation.finalize = async (html, current = () => true) => {
      // Retain the previous DOM while the confirmed scope is fenced.
      if (
        !context ||
        !char ||
        !current() ||
        (presentation.current && !presentation.current())
      )
        return undefined;
      const rendered =
        preparedSanitized && html === preparedHtml ? html : sanitize(html);
      context.check();
      if (!current()) return undefined;
      await commitDisplayScope(char);
      return rendered;
    };
  }

  // An owning UI cannot publish a result without this canonical context: its
  // finalizer above already rejects it. Retain the previous DOM and wait for
  // the owner's fresh projection instead of preparing discarded assets/HTML.
  // Unowned/background/translation calls keep their original fallback.
  if (entityRuntimeEnabled && presentation?.current && !context) return "";

  // The private owner/settings/read context is pinned above. Break the burst
  // of immediately fulfilled asset/pre-Lua promises without recapturing state.
  if (context) await yieldDisplayTurn();
  // The owner can retire while this captured task yields or resolves assets.
  // Avoid starting original script work for a presentation already discarded.
  if (context && presentation?.current && !presentation.current()) return "";

  if (char && char.type !== "group") {
    data = await parseAdditionalAssets(data, char, additionalAssetMode, {
      ch: chatID,
    });
    firstParsed = data;
  }

  if (context && presentation?.current && !presentation.current()) return "";
  if (processingChar && char) {
    data = (
      await processScriptFull(char, data, "editdisplay", chatID, cbsConditions)
    ).data;
  }

  if (firstParsed !== data && char && char.type !== "group") {
    data = await parseAdditionalAssets(data, char, additionalAssetMode, {
      ch: chatID,
    });
  }

  data = await parseInlayAssets(data ?? "", context?.settings);

  // Ordinary/plugin formatting retains the original function. The private
  // entity presentation uses an equivalent literal-token pass after scripts.
  data =
    context && !context.settings.plugins?.length && typeof data === "string"
      ? formatThoughtTools(data, () => language)
      : parseThoughtsAndTools(data);

  data = encodeStyle(data);
  if (mode === "normal" || mode === "notrim") {
    const source = data;
    const key = renderCache && displayRenderKey(context.settings);
    renderTicket =
      key === undefined ? undefined : renderCache.lookup(source, key);
    if (renderTicket) data = renderTicket.rendered;
    else {
      const reusable = { value: true };
      data = await renderHighlightableMarkdown(
        data,
        context?.settings,
        reusable,
      );
      if (
        reusable.value &&
        key !== undefined &&
        key === displayRenderKey(context.settings)
      )
        renderTicket = renderCache.remember(source, key, data);
    }

    if (mode === "notrim") {
      preparedHtml = data;
      if (entityRuntimeEnabled && char && !presentation) {
        // Keep the public raw-return API, but validate its final CSS
        // before accepting effects. Actual UI callers finalize once.
        if (context) {
          trimMarkdown(data, context);
          context.check();
        }
        await commitDisplayScope(char);
      }
      return data;
    }
  }
  const rendered = sanitize(data);
  context?.check();
  preparedHtml = rendered;
  preparedSanitized = true;
  if (entityRuntimeEnabled && char && !presentation)
    await commitDisplayScope(char);
  return rendered;
}

const trimPurifyConfig = {
    ADD_TAGS: ["iframe", "style", "risu-style", "x-em", 'annotation', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'msqrt'],
    ADD_ATTR: ["allow", "allowfullscreen", "frameborder", "scrolling", "risu-ctrl" ,"risu-btn", 'risu-trigger', 'risu-mark', 'risu-id', 'x-hl-lang', 'x-hl-text'],
}

export function trimMarkdown(data: string, context?: MarkdownContext) {
  if (!data) {
    return "";
  }

  // Without a <risu-style> there is nothing to decode, so the plain string
  // result is already final. Note the tag itself is not trusted input:
  // risu-style is in ADD_TAGS, so cards, model output and user scripts can
  // author one directly. Only its position in the parsed tree is relied on.
  if (!data.includes("<risu-style")) {
    return withSanitizerSettings(context?.settings, () =>
      DOMPurify.sanitize(data, trimPurifyConfig),
    );
  }

  // Decoded CSS must never be handed back to the HTML sanitizer as <style>
  // text: DOMPurify drops style nodes whose CSS contains '<' (SAFE_FOR_XML),
  // which silently deletes svg data-uris and markup-like content strings.
  // Take the DOM out of the sanitize we already run and swap the elements in
  // place instead, so the CSS never re-enters the HTML parser at all.
  // RETURN_DOM hands back the sanitized <body>, typed as Node. It is null only
  // for empty input, which the guard above already excludes.
  const root = withSanitizerSettings(context?.settings, () =>
    DOMPurify.sanitize(data, {
      ...trimPurifyConfig,
      RETURN_DOM: true,
    }),
  ) as HTMLElement | null;
  if (!root) {
    return "";
  }

  // Only real <risu-style> elements are decoded. A <risu-style> that survived
  // inside an attribute value is not an element, so it is left as inert text
  // and a <style> tag can never be restored into an attribute context.
  for (const el of Array.from(root.querySelectorAll("risu-style"))) {
    const decoded = decodeStyleContent(el.textContent ?? "", context);
    if (decoded.css === undefined) {
      el.replaceWith(root.ownerDocument.createTextNode(decoded.fallback ?? ""));
      continue;
    }
    const style = root.ownerDocument.createElement("style");
    // <style> is RAWTEXT, so '</style' is the only sequence that can end the
    // block early and leak the rest of the CSS as markup once this string is
    // parsed again ('\/' is still '/' inside CSS).
    style.textContent = decoded.css.replaceAll(/<\/(?=style)/gi, "<\\/");
    el.replaceWith(style);
  }

  return root.innerHTML;
}

const metaCodes = [
    '\u200B', //zero width space
    '\u200C', //zero width non-joiner
    '\u200D', //zero width joiner
    '\uFEFF', //zero width no-break space
    '\u2060', //word joiner
    '\u180E', //mongolian vowel separator
]

const encodedMetadataCache = new Map<string, string>()

function encodeMetadata(modelShortName:string){
    const metadata = '{' + [
        'risuai',
        modelShortName.toLocaleLowerCase().replace(/[^a-z]/g, ''),
    ].join('|') + '}'

    const cached = encodedMetadataCache.get(metadata)
    if(cached !== undefined){
        return cached
    }

    let encodedMetaCode = ''
    for(let i=0;i<metadata.length;i++){
        let byte = (metadata.charCodeAt(i) - 97).toString(6).padStart(2,'0')
        for(let j=0;j<byte.length;j++){
            switch(byte.charAt(j)){
                case '0':{
                    encodedMetaCode += metaCodes[0]
                    break
                }
                case '1':{
                    encodedMetaCode += metaCodes[1]
                    break
                }
                case '2':{
                    encodedMetaCode += metaCodes[2]
                    break
                }
                case '3':{
                    encodedMetaCode += metaCodes[3]
                    break
                }
                case '4':{
                    encodedMetaCode += metaCodes[4]
                    break
                }
                case '5':{
                    encodedMetaCode += metaCodes[5]
                    break
                }
            }
        }
    }

    encodedMetadataCache.set(metadata, encodedMetaCode)
    return encodedMetaCode
}

export function addMetadataToElement(data:string, modelShortName:string){
    if(!aiWatermarkingLawApplies()){
        return data
    }

    const encodedMetaCode = encodeMetadata(modelShortName)
    console.log('Encoded metadata:', encodedMetaCode.length, 'characters')
    console.log('This requires at least', Math.ceil(encodedMetaCode.length / 32), '<p> tags to store')

    let d =  data.replace(/\<p\>/g, (v) => {
        return '<p>' + encodedMetaCode
    })

    return d + encodedMetaCode
}

export async function postTranslationParse(data:string){
    let lines = data.split('\n')

    for(let i=0;i<lines.length;i++){
        const trimed = lines[i].trim()
        if(trimed.startsWith('<')){
            lines[i] = trimed
        }
    }

    data = await renderHighlightableMarkdown(lines.join('\n'))
    return data
}

export function parseMarkdownSafe(data:string, arg:{
    forbidTags?: string[],
} = {}) {
    return DOMPurify.sanitize(renderMarkdown(md, data), {
        FORBID_TAGS: ["a", "style", ...(arg.forbidTags || [])],
        FORBID_ATTR: ["style", "href", "class"]
    })
}


const styleRegex = /\<style\>(.+?)\<\/style\>/gms
function encodeStyle(txt:string){
    return txt.replaceAll(styleRegex, (f, c1) => {
        return "<risu-style>" + Buffer.from(c1).toString('hex') + "</risu-style>"
    })
}

function decodeStyleRule(rule:CssAtRuleAST){
    if(rule.type === 'rule'){
        if(rule.selectors){
            for(let i=0;i<rule.selectors.length;i++){
                let slt:string = rule.selectors[i]
                if(slt){

                    const parser = cssSelectorParser((root) => {
                        root.walkClasses((classes) => {
                            if(classes.type === 'class' && !classes.value.startsWith('x-risu-')){
                                classes.value = 'x-risu-' + classes.value
                            }
                        })
                    })

                    slt = parser.processSync(slt)

                    rule.selectors[i] = ".chattext " + slt
                }
            }
        }
    }
    if(rule.type === 'media' || rule.type === 'supports' || rule.type === 'document' || rule.type === 'host' || rule.type === 'container' ){
        for(let i=0;i<rule.rules.length;i++){
            rule.rules[i] = decodeStyleRule(rule.rules[i])
        }
    }
    if(rule.type === 'import'){
       if(rule.import.startsWith('data:')){
            rule.import = 'data:,'
       }
    }
    return rule
}

/**
 * Decodes one <risu-style> body into scoped CSS. Returns the CSS on its own so
 * the caller can put it into a real <style> element instead of a markup string.
 * On a CSS parse error the style is dropped and `fallback` holds the text that
 * takes its place.
 */
function decodeStyleContent(
  hexText: string,
  context?: MarkdownContext,
): { css?: string; fallback?: string } {
  try {
    let text = Buffer.from(hexText, "hex").toString("utf-8");
    text = context ? context.parseCss(text) : risuChatParser(text);
    const ast = css.parse(text);
    const rules = ast?.stylesheet?.rules;
    if (rules) {
      for (let i = 0; i < rules.length; i++) {
        rules[i] = decodeStyleRule(rules[i]);
      }
      ast.stylesheet.rules = rules;
    }
    return {
      css: css.stringify(ast, {
        indent: "",
        compress: true,
      }),
    };
  } catch (error) {
    if ((context?.settings ?? DBState.db).returnCSSError) {
      return { fallback: `CSS ERROR: ${error}` };
    }
    return { fallback: "" };
  }
}

export async function hasher(data:Uint8Array){
    return Buffer.from(await crypto.subtle.digest("SHA-256", data as any)).toString('hex');
}

let browserCbsRuntime: ReturnType<typeof createCbsRuntime>;

function getBrowserCbsRuntime() {
  return (browserCbsRuntime ??= createCbsRuntime(getBrowserCbsHost()));
}
export function getBrowserCbsHost(): import("./cbsRuntime").CbsRuntimeHost {
  return {
    getDatabase,
    getUserName,
    getPersonaPrompt,
    safeStructuredClone: (value) => safeStructuredClone(value),
    getChatVar,
    setChatVar,
    getGlobalChatVar,
    calcString,
    getModules,
    getModuleLorebooks,
    pickHashRand,
    getSelectedCharID: () => get(selectedCharID),
    getCurrentTriggerId: () => get(CurrentTriggerIdStore),
    getModelInfo,
    callInternalFunction: () => "",
    isTauri,
    isNodeServer,
    isMobile: false,
    appVer,
    findCharacterbyId,
  };
}

export function risuChatParser(
  data: string,
  arg: Parameters<ReturnType<typeof createCbsRuntime>["parse"]>[1] = {},
  presentation?: MarkdownPresentation,
): string {
  if (
    entityRuntimeEnabled &&
    (arg.visualize ||
      arg.cbsConditions?.messageId ||
      arg.cbsConditions?.firstmsg)
  ) {
    const capture = captureDisplayScope(
      arg.chatID ?? -1,
      Boolean(arg.cbsConditions?.firstmsg),
      undefined,
      arg.cbsConditions?.messageId,
      arg.cbsConditions?.bookmarkSession,
    );
    if (!capture) return data;
    const scope = createDisplayCbsScope(capture, getBrowserCbsHost());
    const result = scope.parse(data, {
      ...arg,
      db: scope.database,
      chatID: capture.history?.ordinal ?? arg.chatID ?? -1,
    });
    scope.check();
    if (presentation) presentation.capture = capture;
    return result;
  }
  return getBrowserCbsRuntime().parse(data, arg);
}

export function applyMarkdownToNode(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent;
        if (text) {
            let markdown = renderMarkdown(md, text);
            if (markdown !== text) {
                const span = document.createElement('span');
                span.innerHTML = markdown;
                
                // inherit inline style from the parent node
                const parentStyle = (node.parentNode as HTMLElement)?.style;
                if(parentStyle){
                    for(let i=0;i<parentStyle.length;i++){
                        span.style.setProperty(parentStyle[i], parentStyle.getPropertyValue(parentStyle[i]))
                    }   
                }
                (node as Element)?.replaceWith(span);
                return
            }
        }
    } else {
        for (const child of node.childNodes) {
            applyMarkdownToNode(child);
        }
    }
}
