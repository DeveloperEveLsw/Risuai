import { allowedDbKeys, customProviderStore, getV2PluginAPIs, handlePluginInstallViaPlugin, pluginV2, type PluginV2ProviderArgument, type PluginV2ProviderOptions, type RisuPlugin } from "../plugins.svelte";
import { SandboxHost } from "./factory";
import { getDatabase } from "src/ts/storage/database.svelte";
import { SafeLocalPluginStorage, tagWhitelist } from "../pluginSafeClass";
import DOMPurify from 'dompurify';
import { additionalChatMenu, additionalFloatingActionButtons, additionalHamburgerMenu, additionalSettingsMenu, bodyIntercepterStore, chatPanelStore, DBState, selectedCharID, type MenuDef } from "src/ts/stores.svelte";
import { v4 } from "uuid";
import { sleep } from "src/ts/util";
import { alertConfirm, alertError, alertNormal } from "src/ts/alert";
import { language } from "src/lang";
import { checkCharOrder, forageStorage, getFetchLogs } from "src/ts/globalApi.svelte";
import { changeColorScheme, updateColorScheme, updateTextThemeAndCSS, type ColorScheme } from "src/ts/gui/colorscheme";
import { isNodeServer, isTauri } from "src/ts/platform";
import { get } from "svelte/store";
import { registerMCPModule, registeredCustomPluginMCPs, unregisterMCPModule } from "src/ts/process/mcp/pluginmcp";
import { getInlayAsset } from "src/ts/process/files/inlays";
import { getLLMCache, searchLLMCache } from "src/ts/translator/translator";
import { hasher } from "src/ts/parser/parser.svelte";
import localforage from "localforage";
import { LLMFlags, LLMFormat, LLMProvider, LLMTokenizer, type LLMModel } from "src/ts/model/types";
import { sendChat as processSendChat, doingChat } from "src/ts/process/index.svelte";
import { getModelInfo } from "src/ts/model/modellist";
import type { ModelModeExtended } from "src/ts/process/request/shared";
import { requestChatDataMain } from "src/ts/process/request/request";
import { getModuleLorebooks } from "src/ts/process/modules";
import type { ScriptMode } from "src/ts/process/scripts";
import {
    registerTTSPreprocessor,
    unregisterTTSPreprocessor,
    registerTTSPostprocessor,
    unregisterTTSPostprocessor,
    type BeforeTTSContext,
    type BeforeTTSResult,
    type AfterTTSContext,
    type AfterTTSResult,
    type TTSHookFn,
} from "src/ts/process/ttsHooks";

/*
    V3 API for RisuAI Plugins

    Before adding new APIs here, please check the limitations

    - APIs must be a functions
        - If you want nested objects, first add as a plain function, `_getPluginStorage` for example
            And add it too _getAliases function ({'pluginStorage':{'getItem': '_getPluginStorage', ... }})
            This will make pluginStorage.getItem() work in plugins
        - If you need constants, use _getPropertiesForInitialization to set them up
            For example apiVersion and apiVersionCompatibleWith are set this way,
            Accessable in plugins as risuai.apiVersion
    - APIs must return, or accept as parameters, only the following types:
        - Serializable data (string, number, boolean, null, array, object)
        - Class instances marked with __classType = 'REMOTE_REQUIRED'
        - Callback functions (only as parameters)
        - Note that Class or Callbacks inside arrays or objects are not supported
*/

const pluginChannel = new Map<string, Function>();
const documentEventListeners: Array<{type: string, listener: EventListenerOrEventListenerObject, options: any}> = [];

type PluginActivationScope = {
    name: string;
    active: boolean;
    abortController: AbortController;
}

const assertPluginActivation = (activation?: PluginActivationScope) => {
    if(activation && !activation.active){
        throw new Error(`PluginInactiveError: Plugin "${activation.name}" is no longer active.`);
    }
}

class SafeElement {
    #element: HTMLElement;
    #pluginName?: string;
    #activation?: PluginActivationScope;
    __classType = 'REMOTE_REQUIRED' as const;

    constructor(element: HTMLElement, pluginName?: string, activation?: PluginActivationScope) {
        if(element.getAttribute('freezed')){
            throw new Error("This element cannot be accessed by SafeELement")
        }
        this.#element = element;
        this.#pluginName = pluginName;
        this.#activation = activation;
    }

    public appendChild(child: SafeElement) {
        this.#element.appendChild(child.#element);
    }

    public removeChild(child: SafeElement) {
        this.#element.removeChild(child.#element);
    }

    public replaceChild(newChild: SafeElement, oldChild: SafeElement) {
        this.#element.replaceChild(newChild.#element, oldChild.#element);
    }

    public replaceWith(newElement: SafeElement) {
        this.#element.replaceWith(newElement.#element);
    }

    public cloneNode(deep: boolean = false): SafeElement {
        const cloned = this.#element.cloneNode(deep);
        return new SafeElement(cloned as HTMLElement, this.#pluginName, this.#activation);
    }

    public prepend(child: SafeElement) {
        this.#element.prepend(child.#element);
    }

    public remove() {
        this.#element.remove();
    }

    public innerText(): string {
        return this.#element.innerText;
    }

    public textContent(): string | null {
        return this.#element.textContent;
    }

    public setTextContent(value: string) {
        this.#element.textContent = value;
    }

    public setInnerText(value: string) {
        this.#element.innerText = value;
    }


    public setAttribute(name: string, value: string) {
        if(!name.startsWith('x-')){
            throw new Error("Can only set attributes starting with 'x-' for security reasons. for other attributes, use dedicated methods.");
        }
        this.#element.setAttribute(name, value);
    }
    public getAttribute(name: string): string | null {
        if(!name.startsWith('x-')){
            throw new Error("Can only get attributes starting with 'x-' for security reasons. for other attributes, use dedicated methods.");
        }
        return this.#element.getAttribute(name);
    }
    public setStyle(property: string, value: string) {
        (this.#element.style as any)[property] = value;
    }
    public getStyle(property: string): string {
        return (this.#element.style as any)[property];
    }
    public getStyleAttribute(): string {
        return this.#element.getAttribute('style') || '';
    }
    public setStyleAttribute(value: string) {
        this.#element.setAttribute('style', value);
    }
    public addClass(className: string) {
        // 
        this.#element.classList.add(className);
    }
    public removeClass(className: string) {
        // 
        this.#element.classList.remove(className);
    }
    public setClassName(className: string){
        this.#element.className = className
    }
    public getClassName(){
        return this.#element.className
    }
    public hasClass(className: string): boolean {
        //We don't need to check the className here since we're just checking
        return this.#element.classList.contains(className);
    }
    public focus() {
        this.#element.focus();
    }
    public getChildren(): SafeClassArray<SafeElement> {
        const children: SafeElement[] = [];
        this.#element.childNodes.forEach(node => {
            if(node instanceof HTMLElement) {
                children.push(new SafeElement(node, this.#pluginName, this.#activation));
            }
        });
        return new SafeClassArray<SafeElement>(children);
    }
    public getParent(): SafeElement | null {
        if(this.#element.parentElement) {
            return new SafeElement(this.#element.parentElement, this.#pluginName, this.#activation);
        }
        return null;
    }
    public getInnerHTML(): string {
        return this.#element.innerHTML;
    }
    public getOuterHTML(): string {
        return this.#element.outerHTML;
    }
    public clientHeight(): number {
        return this.#element.clientHeight;
    }
    public clientWidth(): number {
        return this.#element.clientWidth;
    }
    public clientTop(): number {
        return this.#element.clientTop;
    }
    public clientLeft(): number {
        return this.#element.clientLeft;
    }
    public nodeName(): string {
        return this.#element.nodeName;
    }
    public nodeType(): number {
        return this.#element.nodeType;
    }
    public querySelectorAll(selector: string): SafeClassArray<SafeElement> {
        const nodeList = this.#element.querySelectorAll(selector);
        const elements: SafeElement[] = [];
        nodeList.forEach(node => {
            if(node instanceof HTMLElement) {
                elements.push(new SafeElement(node, this.#pluginName, this.#activation));
            }
        });
        return new SafeClassArray<SafeElement>(elements);
    }
    public querySelector(selector: string): SafeElement | null {
        const element = this.#element.querySelector(selector);
        if(element instanceof HTMLElement) {
            return new SafeElement(element, this.#pluginName, this.#activation);
        }
        return null;
    }
    public getElementById(id: string): SafeElement | null {
        const element = this.querySelector('#' + id);
        return element;
    }
    public getElementsByClassName(className: string): SafeClassArray<SafeElement> {
        return this.querySelectorAll('.' + className);
    }
    public getClientRects(): DOMRectList {
        return this.#element.getClientRects();
    }
    public getBoundingClientRect(): DOMRect {
        return this.#element.getBoundingClientRect();
    }
    public setInnerHTML(value: string) {
        const san = DOMPurify.sanitize(value);
        this.#element.innerHTML = san;
    }
    public setOuterHTML(value: string) {
        const san = DOMPurify.sanitize(value);
        this.#element.outerHTML = san;
    }
    public scrollIntoView(options?: boolean | ScrollIntoViewOptions) {
        this.#element.scrollIntoView(options);
    }
    #eventIdMap = new Map<string, Function>()

    public async addEventListener(type:string, listener: (event: any) => void, options?: boolean | AddEventListenerOptions):Promise<string> {
        assertPluginActivation(this.#activation);
        const realOptions = typeof options === 'boolean' ? { capture: options } : options || {};

        //allowed with unlimited
        const allowedDocumentEventListeners = [
            'click',
            'dblclick',
            'contextmenu',
            'mousedown',
            'mouseup',
            'mousemove',
            'mouseover',
            'mouseleave',
            'pointercancel',
            'pointerdown',
            'pointerenter',
            'pointerleave',
            'pointermove',
            'pointerout',
            'pointerover',
            'pointerup',
            'scroll',
            'scrollend'
        ]

        //allowed, but it has fingerprinting issues,
        //so it will be delayed random ms.
        const allowedDelayedEventListeners = [
            'keydown',
            'keyup',
            'keypress'
        ]

        const id = v4()

        const trimEvent = (event: MouseEvent | KeyboardEvent | Event) => {
            if(event instanceof MouseEvent){
                return {
                    type: event.type,
                    clientX: event.clientX,
                    clientY: event.clientY,
                    button: event.button,
                    buttons: event.buttons,
                    altKey: event.altKey,
                    ctrlKey: event.ctrlKey,
                    shiftKey: event.shiftKey,
                    metaKey: event.metaKey,
                }
            }
            else if(event instanceof KeyboardEvent){
                return {
                    type: event.type,
                    key: event.key,
                    code: event.code,
                    repeat: event.repeat,
                    altKey: event.altKey,
                    ctrlKey: event.ctrlKey,
                    shiftKey: event.shiftKey,
                    metaKey: event.metaKey,
                }
            }
            else{
                return {
                    type: event.type
                }
            }

        }

        if(allowedDocumentEventListeners.includes(type)){
            const modifiedListener = (event: any) => {
                listener(trimEvent(event))
            }
            this.#eventIdMap.set(id, modifiedListener)
            documentEventListeners.push({type, listener: modifiedListener as EventListenerOrEventListenerObject, options: realOptions})
            document.addEventListener(type, modifiedListener, realOptions)
            this.#registerEventListenerCleanup(type, modifiedListener, realOptions)
            return id;
        }
        else if(allowedDelayedEventListeners.includes(type)){
            const modifiedListener = (event: any) => {
                let delay = 0;
                try {
                    delay = (crypto.getRandomValues(new Uint32Array(1))[0] / 100) % 100; //0-99 ms              
                } catch (error) {}
                setTimeout(() => {
                    listener(trimEvent(event));
                }, delay);
            }
            this.#eventIdMap.set(id, modifiedListener)
            documentEventListeners.push({type, listener: modifiedListener as EventListenerOrEventListenerObject, options: realOptions})
            document.addEventListener(type, modifiedListener, realOptions);
            this.#registerEventListenerCleanup(type, modifiedListener, realOptions)
            return id;
        }
        else{
            throw new Error(`Event listener of type '${type}' is not allowed for security reasons.`);
        }        
    }

    public removeEventListener(type:string, id:string, options?: boolean | EventListenerOptions) {
        const listener = this.#eventIdMap.get(id);
        if(listener){
            const realOptions = typeof options === 'boolean' ? { capture: options } : options || {};
            document.removeEventListener(type, listener as EventListenerOrEventListenerObject, realOptions);
            const idx = documentEventListeners.findIndex(e => e.listener === listener);
            if(idx !== -1) documentEventListeners.splice(idx, 1);
            this.#eventIdMap.delete(id);
        }
    }

    #registerEventListenerCleanup(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options: AddEventListenerOptions,
    ) {
        if(!this.#pluginName){
            return;
        }
        addPluginUnloadCallback(this.#pluginName, () => {
            document.removeEventListener(type, listener, options);
            const index = documentEventListeners.findIndex(entry => entry.listener === listener);
            if(index !== -1){
                documentEventListeners.splice(index, 1);
            }
            for(const [id, registeredListener] of this.#eventIdMap){
                if(registeredListener === listener){
                    this.#eventIdMap.delete(id);
                    break;
                }
            }
        });
    }

    public matches (selector: string): boolean {
        return this.#element.matches(selector);
    }
}

class SafeDocument extends SafeElement {
    __classType = 'REMOTE_REQUIRED' as const;
    #pluginName: string;
    #activation: PluginActivationScope;
    constructor(document: Document, pluginName: string, activation: PluginActivationScope) {
        super(document.documentElement, pluginName, activation);
        this.#pluginName = pluginName;
        this.#activation = activation;
    }
    createElement(tagName: string): SafeElement {
        if(!tagWhitelist.includes(tagName.toLowerCase())) {
            console.warn(`Creation of <${tagName}> elements is restricted. Creating a <div> instead.`);
            tagName = 'div';
        }
        if(tagName.toLowerCase() === 'a'){
            console.warn(`<a> can be created but href attribute cannot be set directly for security reasons. Use .createAnchorElement(href: string) to create safe anchor elements.`);
        }
        const element = document.createElement(tagName);
        return new SafeElement(element, this.#pluginName, this.#activation);
    }
    createAnchorElement(href: string): SafeElement {
        const anchor = document.createElement('a');
        try {
            const url = new URL(href);
            if(url.protocol !== 'http:' && url.protocol !== 'https:'){
                throw new Error("Invalid protocol");
            }
            anchor.setAttribute('href', url.toString());
        } catch (error) {
            console.warn(`Invalid URL provided for anchor element: ${href}. Setting href to '#' instead.`);
            anchor.setAttribute('href', '#');
        }
        return new SafeElement(anchor, this.#pluginName, this.#activation);
    }
}

type SafeMutationRecordObject = {
    type: string;
    target: SafeElement;
    addedNodes: SafeElement[];
}

class SafeClassArray<T> {
    #items: T[];
    __classType = 'REMOTE_REQUIRED' as const;
    constructor(items: T[] = []) {
        this.#items = items;
    }
    at(index: number): T {
        return this.#items.at(index);
    }
    length(): number {
        return this.#items.length;
    }
    push(item: T) {
        this.#items.push(item);
    }
}

class SafeMutationRecord{
    __classType = 'REMOTE_REQUIRED' as const;
    #type: string;
    #target: SafeElement;
    #addedNodes: SafeClassArray<SafeElement>;
    constructor(type: string, target: SafeElement, addedNodes: SafeElement[]) {
        this.#type = type;
        this.#target = target;
        this.#addedNodes = new SafeClassArray<SafeElement>(addedNodes);
    }
    getType(): string {
        return this.#type;
    }
    getTarget(): SafeElement {
        return this.#target;
    }
    getAddedNodes(): SafeClassArray<SafeElement> {
        return this.#addedNodes;
    }
}

type SafeMutationCallback = (mutations: SafeClassArray<SafeMutationRecord>) => void;

class SafeMutationObserver {
    #observer: MutationObserver;
    #pluginName: string;
    #activation: PluginActivationScope;
    __classType = 'REMOTE_REQUIRED' as const;
    constructor(callback: SafeMutationCallback, pluginName: string, activation: PluginActivationScope) {
        this.#pluginName = pluginName;
        this.#activation = activation;
        this.#observer = new MutationObserver((mutations) => {
            const safeMutations: SafeMutationRecordObject[] = mutations.map(mutation => {

                const elementMapHelper = (nodeList: NodeList): SafeElement[] => {
                    const elements: SafeElement[] = [];
                    nodeList.forEach(node => {
                        if(node instanceof HTMLElement) {
                            elements.push(new SafeElement(node, this.#pluginName, this.#activation));
                        }
                    })
                    return elements;
                }

                return {
                    type: mutation.type,
                    target: new SafeElement(mutation.target as HTMLElement, this.#pluginName, this.#activation),
                    addedNodes: elementMapHelper(mutation.addedNodes),
                    removedNodes: elementMapHelper(mutation.removedNodes)
                    
                }
            })

            const safeClassed = new SafeClassArray<SafeMutationRecord>([]);
            for(const record of safeMutations){
                safeClassed.push(new SafeMutationRecord(
                    record.type,
                    record.target,
                    record.addedNodes
                ));
            }
            callback(safeClassed);
        });
    }

    observe(element:SafeElement, options: MutationObserverInit) {
        assertPluginActivation(this.#activation);
        const identifier = v4();
        element.setAttribute('x-identifier', identifier);
        const rawElement = document.querySelector(`[x-identifier="${identifier}"]`) as HTMLElement;
        if(rawElement){
            this.#observer.observe(rawElement, options);
            element.setAttribute('x-identifier', '');
        }
    }

    disconnect() {
        this.#observer.disconnect();
    }

}

const pluginUnloadCallbacks: Map<string, Function[]> = new Map();

const addPluginUnloadCallback = (pluginName: string, callback: Function) => {
    if(!pluginUnloadCallbacks.has(pluginName)){
        pluginUnloadCallbacks.set(pluginName, []);
    }
    pluginUnloadCallbacks.get(pluginName)?.push(callback);
}

const makeMenuUnloadCallback = (menuId:string, menuStore: MenuDef[]) =>{
    return () => {
        const index = menuStore.findIndex(item => item.id === menuId);
        if(index !== -1){
            menuStore.splice(index, 1);
        }
    }
}

const removeChatPanel = (id: string) => {
    const index = chatPanelStore.findIndex(item => item.id === id);
    if(index !== -1){
        chatPanelStore.splice(index, 1);
    }
}

const removePluginChatPanels = (pluginName: string) => {
    for(let i = chatPanelStore.length - 1; i >= 0; i--){
        if(chatPanelStore[i].pluginName === pluginName){
            chatPanelStore.splice(i, 1);
        }
    }
}

const unloadV3Plugin = async (pluginName: string) => {
    const callbacks = pluginUnloadCallbacks.get(pluginName);
    const instance = v3PluginInstances.find(p => p.name === pluginName);
    if(instance){
        instance.activation.active = false;
        instance.activation.abortController.abort(
            new Error(`PluginInactiveError: Plugin "${pluginName}" is no longer active.`),
        );
        const index = v3PluginInstances.findIndex(p => p.name === pluginName);
        if(index !== -1){
            v3PluginInstances.splice(index, 1);
        }
    }
    if(callbacks){
        // Detach the scope first: callbacks are allowed to call plugin APIs, but
        // anything they register must not become part of the failed/old scope.
        pluginUnloadCallbacks.delete(pluginName);
        const promises: Promise<unknown>[] = [];
        for(const callback of callbacks){
            try {
                const result = callback();
                if(result instanceof Promise){
                    promises.push(result);
                }
            }
            catch(error){
                console.error(`Error unloading plugin ${pluginName}:`, error);
            }
        }

        if(promises.length > 0){
            await Promise.race([
                Promise.allSettled(promises),
                sleep(1000), // Do not let a broken onUnload block every plugin.
            ]);
        }
    }
    try {
        instance?.host?.terminate();
    } catch (error) {
        console.error(`Error terminating plugin ${pluginName}:`, error);
    }
    // SandboxHost removes its iframe, but retain an explicit host-independent
    // cleanup guarantee for constructor/run failures and test hosts.
    instance?.iframe.remove();
}

// A permission decision belongs to one exact plugin script and capability.
// Caching by plugin name would let a harmless permission (or an older script)
// silently authorize every other protected API for the rest of the session.
const grantedPluginPermissions: Set<string> = new Set();
const deniedPluginPermissions: Set<string> = new Set();
const periodicPluginPermissionGrantTimes: Map<string, number> = new Map();
let pluginApiReloadInProgress = false;
const localPermissionForage = localforage.createInstance({
    name: 'plugin_permissions',
    storeName: 'plugin_permissions'
});

const permissionForage = {
    async getItem<T extends boolean | number>(key: string): Promise<T | null> {
        return await localPermissionForage.getItem<T>(key);
    },
    async setItem<T extends boolean | number>(key: string, value: T): Promise<T> {
        return await localPermissionForage.setItem(key, value);
    },
};

type PluginV3ProviderOptions = PluginV2ProviderOptions & {
    model?: LLMModel
}

export const customV3ProviderMetaStore:LLMModel[] = []

type V3ProviderRegistration = {
    provider: (arg: PluginV2ProviderArgument, abortSignal?: AbortSignal) => Promise<{ success: boolean, content: string | ReadableStream<string> }>;
    options: PluginV2ProviderOptions;
    modelData: LLMModel;
}

type V3ProviderBaseline = {
    hasProvider: boolean;
    provider?: V3ProviderRegistration['provider'];
    hasOptions: boolean;
    options?: PluginV2ProviderOptions;
    listed: boolean;
}

const v3ProviderRegistrationStacks = new Map<string, V3ProviderRegistration[]>();
const v3ProviderBaselines = new Map<string, V3ProviderBaseline>();

type V3MCPClient = NonNullable<ReturnType<typeof registeredCustomPluginMCPs.get>>;
type V3MCPRegistration = {
    identifier: string;
    client: V3MCPClient;
};
type V3MCPBaseline = {
    hasClient: boolean;
    client?: V3MCPClient;
}
const v3MCPRegistrationStacks = new Map<string, V3MCPRegistration[]>();
const v3MCPBaselines = new Map<string, V3MCPBaseline>();

const installV3ProviderRegistration = (name: string, registration: V3ProviderRegistration) => {
    let stack = v3ProviderRegistrationStacks.get(name);
    if(!stack){
        stack = [];
        v3ProviderRegistrationStacks.set(name, stack);
        v3ProviderBaselines.set(name, {
            hasProvider: pluginV2.providers.has(name),
            provider: pluginV2.providers.get(name),
            hasOptions: pluginV2.providerOptions.has(name),
            options: pluginV2.providerOptions.get(name),
            listed: get(customProviderStore).includes(name),
        });
    }
    stack.push(registration);
    pluginV2.providers.set(name, registration.provider);
    pluginV2.providerOptions.set(name, registration.options);
    customProviderStore.update(providers => (
        providers.includes(name) ? providers : [...providers, name]
    ));
    customV3ProviderMetaStore.push(registration.modelData);
}

const removeV3ProviderRegistration = (name: string, registration: V3ProviderRegistration) => {
    const modelIndex = customV3ProviderMetaStore.indexOf(registration.modelData);
    if(modelIndex !== -1){
        customV3ProviderMetaStore.splice(modelIndex, 1);
    }

    const stack = v3ProviderRegistrationStacks.get(name);
    if(!stack){
        return;
    }
    const registrationIndex = stack.indexOf(registration);
    if(registrationIndex === -1){
        return;
    }
    const wasApplied = pluginV2.providers.get(name) === registration.provider;
    stack.splice(registrationIndex, 1);

    if(wasApplied){
        const next = stack.at(-1);
        if(next){
            pluginV2.providers.set(name, next.provider);
            pluginV2.providerOptions.set(name, next.options);
        }
        else{
            const baseline = v3ProviderBaselines.get(name);
            if(baseline?.hasProvider && baseline.provider){
                pluginV2.providers.set(name, baseline.provider);
            }
            else{
                pluginV2.providers.delete(name);
            }
            if(baseline?.hasOptions && baseline.options){
                pluginV2.providerOptions.set(name, baseline.options);
            }
            else{
                pluginV2.providerOptions.delete(name);
            }
            if(!baseline?.listed){
                customProviderStore.update(providers => providers.filter(provider => provider !== name));
            }
        }
    }

    if(stack.length === 0){
        v3ProviderRegistrationStacks.delete(name);
        v3ProviderBaselines.delete(name);
    }
}

const installV3MCPRegistration = (
    identifier: string,
    registration: V3MCPRegistration,
    previousClient?: V3MCPClient,
) => {
    let stack = v3MCPRegistrationStacks.get(identifier);
    if(!stack){
        stack = [];
        v3MCPRegistrationStacks.set(identifier, stack);
        v3MCPBaselines.set(identifier, {
            hasClient: previousClient !== undefined,
            client: previousClient,
        });
    }
    stack.push(registration);
}

const removeV3MCPRegistration = async (identifier: string, registration: V3MCPRegistration) => {
    const stack = v3MCPRegistrationStacks.get(identifier);
    if(!stack){
        return;
    }
    const registrationIndex = stack.indexOf(registration);
    if(registrationIndex === -1){
        return;
    }
    const wasApplied = registeredCustomPluginMCPs.get(identifier) === registration.client;
    stack.splice(registrationIndex, 1);
    if(wasApplied){
        const next = stack.at(-1);
        if(next){
            registeredCustomPluginMCPs.set(identifier, next.client);
        }
        else{
            const baseline = v3MCPBaselines.get(identifier);
            if(baseline?.hasClient && baseline.client){
                registeredCustomPluginMCPs.set(identifier, baseline.client);
            }
            else{
                await unregisterMCPModule(identifier);
            }
        }
    }
    if(stack.length === 0){
        v3MCPRegistrationStacks.delete(identifier);
        v3MCPBaselines.delete(identifier);
    }
}

type PluginPermissionPrincipal = {
    name: string;
    scriptHash: string;
}

type PluginPermissionDescription = 'fetchLogs'|'db'|'mainDom'|'replacer'|'provider'|'sendChat';
type PluginPermissionReconfirmation = boolean|'periodically';
const inFlightPluginPermissionRequests = new Map<string, Promise<boolean>>();
let nodePluginPermissionClientPromise: Promise<import('src/ts/runtime/pluginPermissionClient').RuntimePluginPermissionClient> | null = null;

const getNodePluginPermissionClient = async () => {
    nodePluginPermissionClientPromise ??= import('src/ts/runtime/pluginPermissionClient')
        .then(({ RuntimePluginPermissionClient }) => new RuntimePluginPermissionClient());
    return await nodePluginPermissionClientPromise;
}

const pluginPermissionTitle = (
    pluginName: string,
    permissionDesc: PluginPermissionDescription,
) => permissionDesc === 'fetchLogs' ? language.fetchLogConsent.replace("{}", pluginName)
    : permissionDesc === 'db' ? language.getFullDatabaseConsent.replace("{}", pluginName)
    : permissionDesc === 'mainDom' ? language.mainDomAccessConsent.replace("{}", pluginName)
    : permissionDesc === 'replacer' ? language.replacerPermissionConsent.replace("{}", pluginName)
    : permissionDesc === 'provider' ? language.providerPermissionConsent.replace("{}", pluginName)
    : permissionDesc === 'sendChat' ? language.sendChatConsent.replace("{}", pluginName)
    : `Error`;

const resolvePluginPermission = async (
    principal: PluginPermissionPrincipal,
    permissionDesc: PluginPermissionDescription,
    reconfirm: PluginPermissionReconfirmation = false,
    signal?: AbortSignal,
) => {
    const pluginName = principal.name;
    const pluginHash = `${pluginName}_${principal.scriptHash}_${permissionDesc}`;
    const periodicGrantKey = `${pluginHash}_lastGrantTime`;

    const alertTitle = pluginPermissionTitle(pluginName, permissionDesc);
    if(alertTitle === 'Error'){
        return false;
    }

    if(isNodeServer){
        const policy = reconfirm === 'periodically'
            ? 'periodically'
            : reconfirm === true
                ? 'always'
                : 'persistent';
        const client = await getNodePluginPermissionClient();
        return await client.resolve(principal, permissionDesc, policy, alertTitle, signal);
    }

    if(deniedPluginPermissions.has(pluginHash)){
        return false;
    }

    let requiresReconfirm = false;

    if(reconfirm === 'periodically'){
        const lastGrantTime = periodicPluginPermissionGrantTimes.get(pluginHash)
            ?? await permissionForage.getItem<number>(periodicGrantKey);
        const now = Date.now();
        if(!lastGrantTime || now - lastGrantTime > 3 * 24 * 60 * 60 * 1000){ //3 days
            requiresReconfirm = true;
        }
        else{
            periodicPluginPermissionGrantTimes.set(pluginHash, lastGrantTime);
        }
    }
    else if(reconfirm === true){
        requiresReconfirm = true;
    }

    if(!requiresReconfirm && grantedPluginPermissions.has(pluginHash)){
        return true;
    }
    if(requiresReconfirm){
        // Do not let a long-lived resident process turn a periodic grant into a
        // permanent one. The persisted timestamp above is the source of truth.
        grantedPluginPermissions.delete(pluginHash);
    }

    if(!requiresReconfirm &&await permissionForage.getItem(pluginHash)){
        grantedPluginPermissions.add(pluginHash);
        return true;
    }   
    

    const conf = await alertConfirm(alertTitle)
    if(conf && pluginHash){
        grantedPluginPermissions.add(pluginHash);
        await permissionForage.setItem(pluginHash, true);
        if(reconfirm === 'periodically'){
            const grantTime = Date.now();
            periodicPluginPermissionGrantTimes.set(pluginHash, grantTime);
            await permissionForage.setItem(periodicGrantKey, grantTime);
        }
        return true;
    }
    deniedPluginPermissions.add(pluginHash);
    return false;
}

const getPluginPermission = (
    principal: PluginPermissionPrincipal,
    permissionDesc: PluginPermissionDescription,
    reconfirm: PluginPermissionReconfirmation = false,
    signal?: AbortSignal,
) => {
    // Include the reconfirmation policy so a weaker non-periodic request can
    // never satisfy a concurrent periodic re-check. Calls using the same
    // capability policy share exactly one consent prompt/storage transaction.
    const requestKey = `${principal.name}_${principal.scriptHash}_${permissionDesc}_${String(reconfirm)}`;
    const existing = inFlightPluginPermissionRequests.get(requestKey);
    if(existing){
        return existing;
    }
    const request = resolvePluginPermission(principal, permissionDesc, reconfirm, signal);
    inFlightPluginPermissionRequests.set(requestKey, request);
    void request.finally(() => {
        if(inFlightPluginPermissionRequests.get(requestKey) === request){
            inFlightPluginPermissionRequests.delete(requestKey);
        }
    }).catch(() => undefined);
    return request;
}

class PermissionDeniedError extends Error {
    constructor(pluginName: string, permissionDesc: 'db'|'provider') {
        // SandboxHost currently transports only the error message across its
        // RPC boundary, so keep the error kind in both the name and message.
        super(`PermissionDeniedError: Plugin "${pluginName}" was denied "${permissionDesc}" permission.`);
        this.name = 'PermissionDeniedError';
    }
}

const requirePluginPermission = async (
    principal: PluginPermissionPrincipal,
    permissionDesc: 'db'|'provider',
    signal?: AbortSignal,
) => {
    const permitted = await getPluginPermission(
        principal,
        permissionDesc,
        'periodically',
        signal,
    );
    if(!permitted){
        throw new PermissionDeniedError(principal.name, permissionDesc);
    }
}

const urlBlacklist = [
    'risuai.xyz',
    'risuai.net',
    'sionyw.com',
]

const authorizationHeaders = [
    'x-api-key',
    'authorization',
    'proxy-authorization',
]

const makeRisuaiAPIV3 = (
    iframe: HTMLIFrameElement,
    plugin: RisuPlugin,
    principal: PluginPermissionPrincipal,
    activation: PluginActivationScope,
) => {

    const oldApis = getV2PluginAPIs();
    const permissionSignal = activation.abortController.signal;
    const ownedMCPRegistrations = new Set<V3MCPRegistration>();
    const registerUnloadCallback = (callback: Function) => {
        assertPluginActivation(activation);
        addPluginUnloadCallback(plugin.name, callback);
    }
    return {

        //Old APIs from v2.1
        risuFetch: (url, options) => {
            console.error(`[DEPRECATION WARNING] risuFetch is deprecated and will be removed in future versions. Please use nativeFetch instead.`)
            for(const blocked of urlBlacklist){
                if(url.toLowerCase().includes(blocked)){
                    throw new Error(`Requests to ${blocked} are blocked for security reasons.`);
                }
            }

            //scan headers
            const headers = options?.headers || {};
            for(const headerName in headers){
                if(authorizationHeaders.includes(headerName.toLowerCase())){
                    console.warn(`Request contains potentially sensitive header '${headerName}'. handling of such headers may be changed to only work with nativeFetch.`);
                }
            }
            return oldApis.risuFetch(url, options);
        },
        nativeFetch: (url, options) => {
            for(const blocked of urlBlacklist){
                if(url.toLowerCase().includes(blocked)){
                    throw new Error(`Requests to ${blocked} are blocked for security reasons.`);
                }
            }

            //scan headers
            const headers = options?.headers || {};
            for(const headerName in headers){
                if(authorizationHeaders.includes(headerName.toLowerCase())){
                    console.warn(`Request contains potentially sensitive header '${headerName}'. handling of such headers may be changed to use server-side approch with write-only api access in the future for better security.`);
                }
            }
            return oldApis.nativeFetch(url, options);
        },
        getChar: async () => {
            await requirePluginPermission(principal, 'db', permissionSignal);
            return oldApis.getChar();
        },
        setChar: async (char: any) => {
            await requirePluginPermission(principal, 'db', permissionSignal);
            assertPluginActivation(activation);
            return oldApis.setChar(char);
        },
        addProvider: (name: string, func: (arg: PluginV2ProviderArgument, abortSignal?: AbortSignal) => Promise<{ success: boolean, content: string | ReadableStream<string> }>, options?: PluginV3ProviderOptions) => {
            assertPluginActivation(activation);
            console.warn(`[WARN] addProvider is a powerful API that can potentially be unsafe if used incorrectly. addProvider's functionality might be limited or changed in future updates to ensure security. please use other APIs if possible.`);
            const wrappedProvider = async (arg: PluginV2ProviderArgument, abortSignal?: AbortSignal) => {
               assertPluginActivation(activation);
               const permitted = await getPluginPermission(principal, 'provider', 'periodically', permissionSignal);
               if(!permitted){
                   return {
                       success: false,
                       content: `Provider permission denied for plugin "${plugin.name}"`,
                   };
               }
               assertPluginActivation(activation);
               //mode is overridden to v3, due to vulnerabilities using mode.
               //Alternative to mode will be added in future
               arg.mode = 'v3'
               return await func(arg, abortSignal);
            };

            const modelData:LLMModel = {
                id: `pluginmodel:::${name}`,
                name: options?.model?.name ?? name,
                shortName: options?.model?.shortName ?? name,
                fullName: options?.model?.fullName ?? name,
                internalID: options?.model?.internalID ?? `pluginmodel:::${name}`,
                provider: LLMProvider.AsIs,
                format: LLMFormat.Plugin,
                flags: options?.model?.flags ?? [LLMFlags.hasFullSystemPrompt],
                parameters: options?.model?.parameters ?? ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'repetition_penalty', 'min_p', 'top_a', 'top_k', 'thinking_tokens'],
                tokenizer:options?.model?.tokenizer ??  LLMTokenizer.Unknown
            }
            const registration: V3ProviderRegistration = {
                provider: wrappedProvider,
                options: options ?? {},
                modelData,
            };
            installV3ProviderRegistration(name, registration);
            registerUnloadCallback(() => removeV3ProviderRegistration(name, registration));
        },
        addTTSPreprocessor: async (
            func: TTSHookFn<BeforeTTSContext, BeforeTTSResult>,
        ) => {
            assertPluginActivation(activation);
            registerTTSPreprocessor(func);
            registerUnloadCallback(() => unregisterTTSPreprocessor(func));
        },
        addTTSPostprocessor: async (
            func: TTSHookFn<AfterTTSContext, AfterTTSResult>,
        ) => {
            assertPluginActivation(activation);
            registerTTSPostprocessor(func);
            registerUnloadCallback(() => unregisterTTSPostprocessor(func));
        },
        addRisuScriptHandler: (name: ScriptMode, func: Function) => {
            assertPluginActivation(activation);
            oldApis.addRisuScriptHandler(name, func as any);
            registerUnloadCallback(
                () => oldApis.removeRisuScriptHandler(name, func as any),
            );
        },
        removeRisuScriptHandler: oldApis.removeRisuScriptHandler,
        addRisuReplacer: async (name:string,func:Function) => {
            assertPluginActivation(activation);
            //permission check for replacer
            const conf = await getPluginPermission(principal, 'replacer', 'periodically', permissionSignal);
            if(!conf){
                return;
            }
            assertPluginActivation(activation);
            oldApis.addRisuReplacer(name, func as any);
            registerUnloadCallback(
                () => oldApis.removeRisuReplacer(name, func as any),
            );
        },
        removeRisuReplacer: oldApis.removeRisuReplacer,
        addRisuChatListener: async (mode:'output', func:Function) => {
            assertPluginActivation(activation);
            oldApis.addRisuChatListener(mode, func as any);
            registerUnloadCallback(() => oldApis.removeRisuChatListener(mode, func as any));
        },
        removeRisuChatListener: oldApis.removeRisuChatListener,
        setDatabaseLite: async (newDb: any) => {
            await requirePluginPermission(principal, 'db', permissionSignal);
            assertPluginActivation(activation);
            return await oldApis.setDatabaseLite(newDb);
        },
        setDatabase: async (newDb: any) => {
            await requirePluginPermission(principal, 'db', permissionSignal);
            assertPluginActivation(activation);
            return await oldApis.setDatabase(newDb);
        },
        loadPlugins: async () => {
            await requirePluginPermission(principal, 'db', permissionSignal);
            assertPluginActivation(activation);
            if(pluginApiReloadInProgress){
                throw new Error('PluginReloadInProgressError: A plugin reload is already in progress.');
            }
            pluginApiReloadInProgress = true;
            try {
                return await oldApis.loadPlugins();
            }
            finally {
                pluginApiReloadInProgress = false;
            }
        },
        readImage: oldApis.readImage,
        readInlay: async (id: string) => {
            return await getInlayAsset(id);
        },
        saveAsset: oldApis.saveAsset,
        //Same functionality, but new implementation
        getDatabase: async (includeOnly:string[]|'all' = 'all') => {
            const conf = await getPluginPermission(principal, 'db', 'periodically', permissionSignal);
            if(!conf){
                return null;
            }
            const db = DBState.db
            let liteDB = {}
            for(const key of allowedDbKeys){
                if(includeOnly !== 'all' && !includeOnly.includes(key)){
                    continue;
                }
                (liteDB as any)[key] = $state.snapshot((db as any)[key]);
            }
            return liteDB;
        },

        installPlugin: handlePluginInstallViaPlugin,

        // --- Color Scheme APIs ---
        changeColorScheme: (name: string) => {
            changeColorScheme(name)
        },
        setColorScheme: (scheme: ColorScheme) => {
            const requiredKeys = ['bgcolor','darkbg','borderc','selected','draculared','textcolor','textcolor2','darkBorderc','darkbutton','type'] as const
            for (const key of requiredKeys) {
                if (typeof (scheme as any)[key] !== 'string') {
                    throw new Error(`Invalid color scheme: missing or invalid '${key}'`)
                }
            }
            if (scheme.type !== 'light' && scheme.type !== 'dark') {
                throw new Error('Invalid color scheme type: must be "light" or "dark"')
            }
            const db = DBState.db
            db.colorSchemeName = 'custom'
            db.customColorScheme = scheme
            db.colorScheme = scheme
            updateColorScheme()
        },
        getColorScheme: () => {
            const db = DBState.db
            return {
                name: db.colorSchemeName,
                scheme: $state.snapshot(db.colorScheme)
            }
        },

        // --- Text Theme APIs ---
        changeTextTheme: (name: string) => {
            if (!['standard','highcontrast'].includes(name)) {
                throw new Error(`Invalid text theme: ${name}`)
            }
            const db = DBState.db
            db.textTheme = name
            updateTextThemeAndCSS()
        },
        setCustomTextTheme: (theme: {
            FontColorStandard: string,
            FontColorBold: string,
            FontColorItalic: string,
            FontColorItalicBold: string,
            FontColorQuote1: string,
            FontColorQuote2: string
        }) => {
            const requiredKeys = ['FontColorStandard','FontColorBold','FontColorItalic','FontColorItalicBold','FontColorQuote1','FontColorQuote2'] as const
            for (const key of requiredKeys) {
                if (typeof (theme as any)[key] !== 'string') {
                    throw new Error(`Invalid text theme: missing or invalid '${key}'`)
                }
            }
            const db = DBState.db
            db.textTheme = 'custom'
            db.customTextTheme = theme
            updateTextThemeAndCSS()
        },
        getTextTheme: () => {
            const db = DBState.db
            return {
                name: db.textTheme,
                customTheme: $state.snapshot(db.customTextTheme)
            }
        },

        //Deprecated APIs from v2.1
        //Use getArgument / setArgument instead if possible
        getArg: oldApis.getArg,
        setArg: oldApis.setArg,

        //New APIs for v3
        getArgument: async (key:string) => {
            const db = getDatabase()
            for (const p of db.plugins) {
                if (p.name === plugin.name) {
                    return p.realArg[key];
                }
            }
        },
        setArgument: async (key:string, value:string) => {
            const db = getDatabase();
            for (const p of db.plugins) {
                if (p.name === plugin.name) {
                    p.realArg[key] = value;
                }
            }
        },
        getCharacterFromIndex: async (index:number) => {
            await requirePluginPermission(principal, 'db', permissionSignal);
            const db = DBState.db
            const charIds = Object.keys(db.characters);
            const charId = charIds[index];
            if(charId){
                return $state.snapshot(db.characters[charId]);
            }
            return null;
        },
        setCharacterToIndex: async (index:number, char:any) => {
            await requirePluginPermission(principal, 'db', permissionSignal);
            assertPluginActivation(activation);
            const db = DBState.db
            const charIds = Object.keys(db.characters);
            const charId = charIds[index];
            if(charId){
                DBState.db.characters[charId] = char
            }
        },
        getChatFromIndex: async (characterIndex:number, chatIndex:number) => {
            await requirePluginPermission(principal, 'db', permissionSignal);
            const db = DBState.db
            const charIds = Object.keys(db.characters);
            const charId = charIds[characterIndex];
            if(charId){
                const chats = db.characters[charId].chats;
                if(chats && chats[chatIndex]){
                    return $state.snapshot(chats[chatIndex]);
                }
            }
            return null;
        },
        setChatToIndex: async (characterIndex:number, chatIndex:number, chat:any) => {
            await requirePluginPermission(principal, 'db', permissionSignal);
            assertPluginActivation(activation);
            const db = DBState.db
            const charIds = Object.keys(db.characters);
            const charId = charIds[characterIndex];
            if(charId){
                const chats = db.characters[charId].chats;
                if(chats && chats[chatIndex]){
                    DBState.db.characters[charId].chats[chatIndex] = chat
                }
            }
        },
        getCurrentCharacterIndex: async () => {
            await requirePluginPermission(principal, 'db', permissionSignal);
            return get(selectedCharID)
        },
        getCurrentChatIndex: async () => {
            await requirePluginPermission(principal, 'db', permissionSignal);
            const db = DBState.db
            const charId = get(selectedCharID)
            return db.characters[charId].chatPage
        },
        getCurrentLorebookEntries: async () => {
            await requirePluginPermission(principal, 'db', permissionSignal);
            const charId = get(selectedCharID)
            const char = DBState.db.characters[charId]
            if(!char){
                return []
            }
            const page = char.chatPage
            const characterLore = char.globalLore ?? []
            const chatLore = char.chats?.[page]?.localLore ?? []
            const moduleLore = getModuleLorebooks()
            return $state.snapshot(characterLore.concat(chatLore).concat(moduleLore))
        },
        //New names for character APIs, to match API naming conventions
        getCharacter: async () => {
            await requirePluginPermission(principal, 'db', permissionSignal);
            return oldApis.getChar();
        },
        setCharacter: async (char: any) => {
            await requirePluginPermission(principal, 'db', permissionSignal);
            assertPluginActivation(activation);
            return oldApis.setChar(char);
        },

        showContainer: (
            //more types may be added in future
            type: 'fullscreen' = 'fullscreen'
        ) => {
            iframe.style.display = "block";
            
            switch(type) {
                case 'fullscreen': {
                    //move iframe to body if not already there
                    if(iframe.parentElement !== document.body) {
                        document.body.appendChild(iframe);
                    }

                    //Make iframe cover whole screen
                    iframe.style.position = "fixed";
                    iframe.style.top = "0";
                    iframe.style.left = "0";
                    iframe.style.width = "100%";
                    iframe.style.height = "100%";
                    iframe.style.border = "none";
                    iframe.style.zIndex = "1000";
                    break;
                }
                default: {
                    return
                }
            }
        },
        hideContainer: () => {
            iframe.style.display = "none";
        },
        getRootDocument: async () => {
            const conf = await getPluginPermission(principal, 'mainDom', false, permissionSignal);
            if(!conf){
                return null;
            }
            assertPluginActivation(activation);
            return new SafeDocument(document, plugin.name, activation);
        },
        registerSetting: (
            name:string,
            callback: any,
            icon:string = '',
            iconType:'html'|'img'|'none' = 'none',
            id?:string
        ) => {
            assertPluginActivation(activation);
            if(iconType !== 'html' && iconType !== 'img' && iconType !== 'none'){
                throw new Error("iconType must be 'html', 'img' or 'none'");
            }
            if(typeof name !== 'string' || name.trim() === ''){
                throw new Error("name must be a non-empty string");
            }
            const menuId = id || v4()
            const menuDef:MenuDef = {
                id: menuId,
                name,
                icon,
                iconType,
                callback
            }
            const existingIndex = additionalSettingsMenu.findIndex(item => item.id === menuId)
            if(existingIndex !== -1){
                additionalSettingsMenu[existingIndex] = menuDef
                registerUnloadCallback(
                    makeMenuUnloadCallback(menuId, additionalSettingsMenu)
                )
                return {id: menuId}
            }
            additionalSettingsMenu.push(menuDef)
            registerUnloadCallback(
                makeMenuUnloadCallback(menuId, additionalSettingsMenu)
            )
            return {id: menuId};
        },
        registerBodyIntercepter: async (callback: (body: any, type: string) => any) => {
            assertPluginActivation(activation);
            if(await getPluginPermission(principal, 'replacer', false, permissionSignal) === false){
                return null;
            }
            assertPluginActivation(activation);
            
            const id = v4();
            bodyIntercepterStore.push({
                id,
                callback
            })
            registerUnloadCallback(() => {
                const index = bodyIntercepterStore.findIndex(item => item.id === id);
                if(index !== -1){
                    bodyIntercepterStore.splice(index, 1);
                }
            })
            return {id:id};
        },
        
        unregisterBodyIntercepter: (id: string) => {
            const index = bodyIntercepterStore.findIndex(item => item.id === id);
            if(index !== -1){
                bodyIntercepterStore.splice(index, 1);
            }
        },
            
        registerButton: (
            arg: {
                name: string,
                icon: string,
                iconType: 'html'|'img'|'none',
                location?: 'action'|'chat'|'hamburger',
                id?: string
            },
            callback: () => void
        ) => {
            assertPluginActivation(activation);
            let { name, icon, iconType, location, id: providedId } = arg;
            location = location || 'action';
            if(iconType !== 'html' && iconType !== 'img' && iconType !== 'none'){
                throw new Error("iconType must be 'html', 'img' or 'none'");
            }
            if(typeof name !== 'string' || name.trim() === ''){
                throw new Error("name must be a non-empty string");
            }
            if(typeof icon !== 'string'){
                throw new Error("icon must be a string");
            }
            const id = providedId || v4()
            const menuDef:MenuDef = {
                name,
                icon,
                iconType,
                callback,
                id
            }

            const buttonStores = [additionalFloatingActionButtons, additionalHamburgerMenu, additionalChatMenu]
            for(const store of buttonStores){
                const existingIndex = store.findIndex(item => item.id === id)
                if(existingIndex !== -1){
                    store[existingIndex] = menuDef
                    registerUnloadCallback(
                        makeMenuUnloadCallback(id, store)
                    )
                    return {id}
                }
            }

            switch(location){
                case 'action':{
                    additionalFloatingActionButtons.push(menuDef)
                    registerUnloadCallback(
                        makeMenuUnloadCallback(menuDef.id, additionalFloatingActionButtons)
                    )
                    break
                }
                case 'hamburger':{
                    additionalHamburgerMenu.push(menuDef)
                    registerUnloadCallback(
                        makeMenuUnloadCallback(menuDef.id, additionalHamburgerMenu)
                    )
                    break
                }
                case 'chat':{
                    additionalChatMenu.push(menuDef)
                    registerUnloadCallback(
                        makeMenuUnloadCallback(menuDef.id, additionalChatMenu)
                    )
                    break
                }
                default:{
                    throw new Error("Invalid location for button")
                }
            }
            return {id};
        },
        setChatPanel: (
            content: string | null,
            options: {
                id?: string,
                className?: string,
            } = {}
        ) => {
            assertPluginActivation(activation);
            const id = options.id || `${plugin.name}:default`;

            if(content === null || content === ''){
                removeChatPanel(id);
                return {id};
            }

            if(typeof content !== 'string'){
                throw new Error("content must be a string or null");
            }

            const panel = {
                id,
                pluginName: plugin.name,
                html: DOMPurify.sanitize(content),
                className: typeof options.className === 'string'
                    ? DOMPurify.sanitize(options.className, {ALLOWED_TAGS: [], ALLOWED_ATTR: []})
                    : undefined,
            }

            const existingIndex = chatPanelStore.findIndex(item => item.id === id);
            if(existingIndex !== -1){
                chatPanelStore[existingIndex] = panel;
            }
            else{
                chatPanelStore.push(panel);
            }
            registerUnloadCallback(() => removePluginChatPanels(plugin.name));
            return {id};
        },
        registerMCP: async (...args: Parameters<typeof registerMCPModule>) => {
            assertPluginActivation(activation);
            const identifier = args[0].identifier;
            const previousClient = registeredCustomPluginMCPs.get(identifier);
            // registerMCPModule returns the exact client it inserted. Reading
            // the shared map after await can capture a concurrent plugin's
            // later same-identifier registration instead.
            const registeredClient = await registerMCPModule(...args);
            const registration: V3MCPRegistration = {
                identifier,
                client: registeredClient,
            };
            if(!activation.active){
                if(registeredCustomPluginMCPs.get(identifier) === registeredClient){
                    if(previousClient){
                        registeredCustomPluginMCPs.set(identifier, previousClient);
                    }
                    else{
                        await unregisterMCPModule(identifier);
                    }
                }
                assertPluginActivation(activation);
            }
            installV3MCPRegistration(identifier, registration, previousClient);
            ownedMCPRegistrations.add(registration);
            registerUnloadCallback(async () => {
                ownedMCPRegistrations.delete(registration);
                await removeV3MCPRegistration(identifier, registration);
            });
        },
        unregisterMCP: async (identifier: string) => {
            assertPluginActivation(activation);
            const registration = [...ownedMCPRegistrations]
                .reverse()
                .find(candidate => candidate.identifier === identifier);
            if(!registration){
                throw new Error(
                    `PluginMCPRegistrationOwnershipError: Plugin "${plugin.name}" does not own "${identifier}".`,
                );
            }
            ownedMCPRegistrations.delete(registration);
            await removeV3MCPRegistration(identifier, registration);
        },
        unregisterUIPart: (id: string) => {
            const removeFromMenuStore = (menuStore: MenuDef[]) => {
                const index = menuStore.findIndex(item => item.id === id);
                if(index !== -1){
                    menuStore.splice(index, 1);
                }
            }

            removeFromMenuStore(additionalSettingsMenu);
            removeFromMenuStore(additionalFloatingActionButtons);
            removeFromMenuStore(additionalHamburgerMenu);
            removeFromMenuStore(additionalChatMenu);
            removeChatPanel(id);
        },
        log: (message:string) => {
            console.log(`[RisuAI Plugin: ${plugin.name}] ${message}`);
        },
        createMutationObserver(callback: SafeMutationCallback): SafeMutationObserver {
            assertPluginActivation(activation);
            const observer = new SafeMutationObserver(callback, plugin.name, activation)
            registerUnloadCallback(() => {
                observer.disconnect()
            })
            return observer
        },
        onUnload: (callback: () => void) => {
            registerUnloadCallback(callback);
        },
        getFetchLogs: async () => {
            const unsafeFetchLog = getFetchLogs()
            const conf = await getPluginPermission(principal, 'fetchLogs', false, permissionSignal);
            if(!conf){
                return null;
            }
            return unsafeFetchLog.map(log => {

                const url = new URL(log.url);
                return {
                    url: url.origin + url.pathname,
                    body: log.body,
                    status: log.status,
                    response: log.response,
                }
            })
        },

        alert: (msg:string) => {
            return alertNormal(msg)
        },
        alertConfirm: (msg:string) => {
            return alertConfirm(msg)
        },
        alertError: (msg:string) => {
            return alertError(msg)
        },
        getRuntimeInfo: () => {
            return {
                apiVersion: "3.0",
                platform: 
                    isNodeServer ? 'node' :
                    isTauri ? 'tauri' :
                    'web',
                saveMethod:
                    isTauri ? 'tauri' :
                    forageStorage.isAccount ? 'account' :
                    'local',
            }
        },
        getLocalPluginStorage: () => {
            return new SafeLocalPluginStorage()
        },
        checkCharOrder: checkCharOrder,
        requestPluginPermission: (permission:string) => {
            return getPluginPermission(principal, permission as any, false, permissionSignal);
        },
        //Internal use APIs
        _getOldKeys: () => {
            return Object.keys(oldApis)
        },
        _getPropertiesForInitialization: () => {
            const v = {
                apiVersion: "3.0",
                apiVersionCompatibleWith: ["3.0"],
            } as any;

            v.list = Object.keys(v);
            
            return v;
        },
        _getPluginStorage: oldApis.pluginStorage.getItem,
        _setPluginStorage: oldApis.pluginStorage.setItem,
        _removePluginStorage: oldApis.pluginStorage.removeItem,
        _clearPluginStorage: oldApis.pluginStorage.clear,
        _keyPluginStorage: oldApis.pluginStorage.key,
        _keysPluginStorage: oldApis.pluginStorage.keys,
        _lengthPluginStorage: oldApis.pluginStorage.length,
        _getSafeLocalStorage: oldApis.safeLocalStorage.getItem,
        _setSafeLocalStorage: oldApis.safeLocalStorage.setItem,
        _removeSafeLocalStorage: oldApis.safeLocalStorage.removeItem,
        _clearSafeLocalStorage: oldApis.safeLocalStorage.clear,
        _keySafeLocalStorage: oldApis.safeLocalStorage.key,
        _keysSafeLocalStorage: oldApis.safeLocalStorage.keys,
        searchTranslationCache: async (partialKey: string) => {
            await requirePluginPermission(principal, 'db', permissionSignal);
            return searchLLMCache(partialKey)
        },
        getTranslationCache: async (key: string) => {
            await requirePluginPermission(principal, 'db', permissionSignal);
            return getLLMCache(key)
        },
        _getAliases: () => {
            return {
                'pluginStorage':{
                    'getItem': '_getPluginStorage',
                    'setItem': '_setPluginStorage',
                    'removeItem': '_removePluginStorage',
                    'clear': '_clearPluginStorage',
                    'key': '_keyPluginStorage',
                    'keys': '_keysPluginStorage',
                    'length': '_lengthPluginStorage',
                },
                'safeLocalStorage':{
                    'getItem': '_getSafeLocalStorage',
                    'setItem': '_setSafeLocalStorage',
                    'removeItem': '_removeSafeLocalStorage',
                    'clear': '_clearSafeLocalStorage',
                    'key': '_keySafeLocalStorage',
                    'keys': '_keysSafeLocalStorage',
                }
            }
        },
        runLLMModel: async (options: {
            mode: ModelModeExtended
            messages: OpenAIChat[]
            staticModel?: string
            allowPlugins?: boolean
        }) => {
            await requirePluginPermission(principal, 'provider', permissionSignal);
            assertPluginActivation(activation);
            return requestChatDataMain({
                formated: options.messages,
                bias: {},
                staticModel: options.staticModel,

                // Calls into plugin-provided models are blocked by default to
                // guard against accidental IPC loops between provider plugins.
                // Plugin authors who need to reach the user's plugin-supplied
                // main or auxiliary model (e.g. a TTS preprocessor that
                // rewrites text with the configured otherAx model) can opt in
                // explicitly with `allowPlugins: true`, accepting responsibility
                // for avoiding provider-to-provider call loops.
                blockPlugins: !options.allowPlugins,
            }, options.mode)
        },
        sendChat: async (message: string) => {
            const conf = await getPluginPermission(principal, 'sendChat', false, permissionSignal);
            if(!conf){
                return false;
            }
            assertPluginActivation(activation);

            if(typeof message !== 'string'){
                throw new Error("Message must be a string");
            }

            if(get(doingChat)){
                throw new Error("A chat is already in progress");
            }

            if(getModelInfo(DBState.db.aiModel).id.startsWith('pluginmodel:::')){
                // Executing plugin provider is block because it can be used for loopholes for ipc right now.
                throw new Error("Sending chat with plugin-based model is currently blocked");
            }

            const charId = get(selectedCharID);
            const char = DBState.db.characters[charId];
            if(!char){
                throw new Error("No character selected");
            }

            const chat = char.chats[char.chatPage];
            if(!chat){
                throw new Error("No active chat found");
            }

            if(message){
                chat.message.push({
                    role: 'user',
                    data: message,
                    time: Date.now(),
                });
            }

            try {
                await processSendChat(-1, {});
            } finally {
                // Plugin API path does not pass through the UI unlock logic,
                // so release doingChat here on both success and failure.
                doingChat.set(false);
            }

            return true;
        },
        addPluginChannelListener: (channelName: string, callback: Function) => {
            assertPluginActivation(activation);
            pluginChannel.set(plugin.name + channelName, callback);
            registerUnloadCallback(() => {
                pluginChannel.delete(plugin.name + channelName);
            })
        },
        postPluginChannelMessage: (pluginName: string, channelName: string, message: any) => {

            const currentPluginName = plugin.name;
            const receiverPlugin = DBState.db.plugins.find(p => p.name === pluginName);

            if(!receiverPlugin){
                console.warn(`[RisuAI Plugin: ${currentPluginName}] Attempted to send message to non-existent plugin '${pluginName}' on channel '${channelName}'.`);
                return;
            }

            if(!receiverPlugin.allowedIPC?.includes(currentPluginName)){
                console.warn(`[RisuAI Plugin: ${currentPluginName}] Attempted to send message to plugin '${pluginName}' but receiver plugin does not allow IPC communication from this plugin. declare //@allowed-ipc ${currentPluginName} in the reciver plugin script to allow IPC communication.`);
                return;
            }

            if(!plugin.allowedIPC?.includes(receiverPlugin.name)){
                console.warn(`[RisuAI Plugin: ${currentPluginName}] Attempted to send message to plugin '${pluginName}' but the sender plugin does not allow IPC communication to this plugin. declare //@allowed-ipc ${receiverPlugin.name} in the sender plugin script to allow IPC communication.`);
                return;
            }


            const callback = pluginChannel.get(pluginName + channelName);
            if(callback){
                callback(message, {
                    sender: currentPluginName,
                    channel: channelName
                });
            }
        },
        saveSecretHeader: async (key: string, value: string|string[]) => {
            //TODO: Implement server-side secret storage with write-only access for plugins, to enhance security when handling sensitive information like API keys.
            //This will have rate-limit, to prevent saving it publicly and writing as secret every time before using it.
            console.warn(`[RisuAI Plugin: ${plugin.name}] saveServerSecret is not implemented yet. This API is intended for securely storing sensitive information like API keys with write-only access for plugins. Please avoid using this API until it is implemented.`);
        }
    }
}

type V3PluginInstance = {
    name: string;
    host: SandboxHost;
    iframe: HTMLIFrameElement;
    activation: PluginActivationScope;
}

const v3PluginInstances: V3PluginInstance[] = [];
const pendingV3PluginNames = new Set<string>();

export async function loadV3Plugins(plugins:RisuPlugin[]){
    // Reverse order mirrors a registration stack: if two plugins intentionally
    // shadow the same provider/MCP identifier, unloading the newer one first
    // cannot resurrect an already terminated callback.
    for(const instance of [...v3PluginInstances].reverse()){
        await unloadV3Plugin(instance.name);
    }

    for(const entry of documentEventListeners){
        document.removeEventListener(entry.type, entry.listener, entry.options);
    }
    documentEventListeners.length = 0;

    const loadPromises = plugins.map(plugin => executePluginV3(plugin));
    const results = await Promise.allSettled(loadPromises);
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if(errors.length === 1){
        throw errors[0];
    }
    if(errors.length > 1){
        throw new AggregateError(errors, `${errors.length} API V3 plugins failed to initialize.`);
    }
}

export async function executePluginV3(plugin:RisuPlugin){

    const alreadyRunning = v3PluginInstances.find(p => p.name === plugin.name);
    if(alreadyRunning || pendingV3PluginNames.has(plugin.name)){
        console.log(`[RisuAI Plugin: ${plugin.name}] Plugin is already running. Skipping load.`);
        return;
    }
    pendingV3PluginNames.add(plugin.name);
    try {
        await executeReservedPluginV3(plugin);
    }
    finally {
        pendingV3PluginNames.delete(plugin.name);
    }
}

async function executeReservedPluginV3(plugin: RisuPlugin){

    // Bind permissions to the exact code entering this sandbox. Looking the
    // script up by name on every API call would silently change a running
    // sandbox's identity when the database is edited before reload.
    const principal: PluginPermissionPrincipal = {
        name: plugin.name,
        scriptHash: await hasher(new TextEncoder().encode(plugin.script)),
    };
    const activation: PluginActivationScope = {
        name: plugin.name,
        active: true,
        abortController: new AbortController(),
    };
    const iframe = document.createElement('iframe');
    iframe.style.display = "none";
    document.body.appendChild(iframe);
    let host: SandboxHost | null = null;
    try {
        host = new SandboxHost(makeRisuaiAPIV3(iframe, plugin, principal, activation));
        v3PluginInstances.push({
            name: plugin.name,
            host,
            iframe,
            activation,
        });
        await host.run(iframe, plugin.script);
        console.log(`[RisuAI Plugin: ${plugin.name}] Loaded API V3 plugin.`);
    }
    catch(error){
        if(host){
            await unloadV3Plugin(plugin.name);
        }
        else{
            activation.active = false;
            activation.abortController.abort(
                new Error(`PluginInactiveError: Plugin "${plugin.name}" failed to activate.`),
            );
            iframe.remove();
        }
        throw error;
    }
}

export function getV3PluginInstance(name: string) {
    return v3PluginInstances.find(p => p.name === name);
}

globalThis.__debugV3Plugin = (code: string|Function, pluginName: string = '') => {
    if(code instanceof Function){
        code = `(${code.toString()})()`;
    }
    if(pluginName === ''){
        return v3PluginInstances[0].host.executeInIframe(code);
    }
    const instance = v3PluginInstances.find(p => p.name === pluginName);
    if(!instance){
        throw new Error(`Plugin ${pluginName} not found.`);
    }
    return instance.host.executeInIframe(code);
};
