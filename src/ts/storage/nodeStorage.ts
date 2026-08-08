import { language } from "src/lang"
import { alertError, alertInput, waitAlert } from "../alert"
import { base64url, getKeypairStore, saveKeypairStore } from "../util"
import {
    NodeDatabaseSync,
    type NodeDatabaseCommitOptions,
} from "./nodeDatabaseSync"
import { isServerResidentExecutor } from "../platform"

export const NODE_DATABASE_STORAGE_KEY = 'database/database.bin'

export interface NodeStorageOptions {
    databaseSync?: NodeDatabaseSync
}

export class NodeStorage{

    authChecked = false
    readonly databaseSync: NodeDatabaseSync
    private hubSessionExpiresAt = 0
    private hubSessionRequest: Promise<void> | null = null

    constructor(options: NodeStorageOptions = {}) {
        this.databaseSync = options.databaseSync ?? new NodeDatabaseSync({
            getAuth: () => this.getProxyAuth(),
            getKeyPair: () => this.getKeyPair(),
        })
    }

    JSONStringlifyAndbase64Url(obj:any){
        return base64url(Buffer.from(JSON.stringify(obj), 'utf-8'))
    }

    async createAuth(){
        const keyPair = await this.getKeyPair()
        const date = Math.floor(Date.now() / 1000)
        
        const header = {
            alg: "ES256",
            typ: "JWT",   
        }
        const payload = {
            iat: date,
            exp: date + 5 * 60, //5 minutes expiration
            pub: await crypto.subtle.exportKey('jwk', keyPair.publicKey)
        }
        const sig = await crypto.subtle.sign(
            {
                name: "ECDSA",
                hash: "SHA-256"
            },
            keyPair.privateKey,
            Buffer.from(
                this.JSONStringlifyAndbase64Url(header) + "." + this.JSONStringlifyAndbase64Url(payload)
            )
        )
        const sigString = base64url(new Uint8Array(sig))
        return this.JSONStringlifyAndbase64Url(header) + "." + this.JSONStringlifyAndbase64Url(payload) + "." + sigString
    }

    async getProxyAuth() {
        await this.checkAuth()
        const auth = await this.createAuth()
        await this.ensureHubSession(auth)
        return auth
    }

    private async ensureHubSession(auth: string) {
        if (this.hubSessionExpiresAt > Date.now() + 60_000) {
            return
        }
        if (this.hubSessionRequest) {
            await this.hubSessionRequest
            return
        }
        this.hubSessionRequest = (async () => {
            try {
                const response = await fetch('/api/hub-session', {
                    method: 'POST',
                    headers: { 'risu-auth': auth },
                })
                if (!response.ok) {
                    throw new Error(`Hub session setup failed (${response.status})`)
                }
                const body = await response.json() as { expiresAt?: unknown }
                if (
                    typeof body.expiresAt !== 'number'
                    || !Number.isSafeInteger(body.expiresAt)
                    || body.expiresAt <= Date.now()
                ) {
                    throw new Error('Hub session setup returned an invalid expiry')
                }
                this.hubSessionExpiresAt = body.expiresAt
            } catch (error) {
                // The JWT on programmatic hub requests remains valid, and an
                // optional Hub outage must never block canonical DB loading.
                console.warn('[Node Storage] Could not prepare the Hub resource session:', error)
            } finally {
                this.hubSessionRequest = null
            }
        })()
        await this.hubSessionRequest
    }

    async getKeyPair():Promise<CryptoKeyPair>{
        
        const storedKey = await getKeypairStore('node')

        if(storedKey){
            return storedKey
        }

        const keyPair = await crypto.subtle.generateKey(
            {
                name: "ECDSA",
                namedCurve: "P-256"
            },
            false,
            ["sign", "verify"],
        );

        await saveKeypairStore('node', keyPair)

        return keyPair

    }

    async setItem(key:string, value:Uint8Array, options: NodeDatabaseCommitOptions = {}) {
        if (key === NODE_DATABASE_STORAGE_KEY) {
            await this.databaseSync.commit(value, options)
            return
        }
        await this.checkAuth()
        const da = await fetch('/api/write', {
            method: "POST",
            body: value as any,
            headers: {
                'content-type': 'application/octet-stream',
                'file-path': Buffer.from(key, 'utf-8').toString('hex'),
                'risu-auth': await this.createAuth()
            }
        })
        if(da.status < 200 || da.status >= 300){
            throw "setItem Error"
        }
        const data = await da.json()
        if(data.error){
            throw data.error
        }
    }
    async getItem(key:string):Promise<Buffer> {
        if (key === NODE_DATABASE_STORAGE_KEY) {
            const data = await this.databaseSync.read()
            return data === null ? null : Buffer.from(data)
        }
        await this.checkAuth()
        const da = await fetch('/api/read', {
            method: "GET",
            headers: {
                'file-path': Buffer.from(key, 'utf-8').toString('hex'),
                'risu-auth': await this.createAuth()
            }
        })
        if(da.status < 200 || da.status >= 300){
            throw "getItem Error"
        }

        const data = Buffer.from(await da.arrayBuffer())
        if (data.length == 0){
            return null
        }
        return data
    }
    async keys():Promise<string[]>{
        await this.checkAuth()
        const da = await fetch('/api/list', {
            method: "GET",
            headers:{
                'risu-auth': await this.createAuth()
            }
        })
        if(da.status < 200 || da.status >= 300){
            throw "listItem Error"
        }
        const data = await da.json()
        if(data.error){
            throw data.error
        }
        return data.content
    }
    async removeItem(key:string|string[]){
        await this.checkAuth()
        const encodedKeys = (Array.isArray(key) ? key : [key])
            .map((entry) => Buffer.from(entry, 'utf-8').toString('hex'))
            .join('$$')
        const da = await fetch('/api/remove', {
            method: "GET",
            headers: {
                'file-path': encodedKeys,
                'risu-auth': await this.createAuth()
            }
        })
        if(da.status < 200 || da.status >= 300){
            throw "removeItem Error"
        }
        const data = await da.json()
        if(data.error){
            throw data.error
        }
    }

    private async checkAuth(){

        if(!this.authChecked){
            const data = await (await fetch('/api/test_auth',{
                headers: {
                    'risu-auth': await this.createAuth()
                }
            })).json()

            if(data.status === 'unset'){
                const input = await digestPassword(await alertInput(language.setNodePassword))
                await fetch('/api/set_password',{
                    method: "POST",
                    body:JSON.stringify({
                        password: input 
                    }),
                    headers: {
                        'content-type': 'application/json'
                    }
                })
                return await this.createAuth()
            }
            else if(data.status === 'incorrect'){
                const keypair = await this.getKeyPair()
                const publicKey = await crypto.subtle.exportKey('jwk', keypair.publicKey)
                if(isServerResidentExecutor){
                    const executorLogin = await fetch('/api/executor_login', {
                        method: 'POST',
                        body: JSON.stringify({ publicKey }),
                        headers: { 'content-type': 'application/json' },
                    })
                    if(!executorLogin.ok){
                        throw new Error(`Resident executor enrollment failed (${executorLogin.status})`)
                    }
                    this.authChecked = true
                    return await this.createAuth()
                }
                const input = await digestPassword(await alertInput(language.inputNodePassword))

                const s = await fetch('/api/login',{
                    method: "POST",
                    body: JSON.stringify({
                        password: input,
                        publicKey: publicKey
                    }),
                    headers: {
                        'content-type': 'application/json'
                    }
                })
                if(s.status < 200 || s.status >= 300){
                    let message = `Login failed (${s.status})`
                    try {
                        const body = await s.json()
                        if(body?.error){
                            message = body.error
                        }
                    } catch {}
                    alertError(message)
                    await waitAlert()
                    throw message
                }
                this.authChecked = true
                return await this.createAuth()
            
            }
            else{
                this.authChecked = true
            }
        }
    }

    listItem = this.keys
}

const sharedNodeStorage = new NodeStorage()

export function getSharedNodeStorage() {
    return sharedNodeStorage
}

export async function getNodeServerProxyAuth() {
    return await sharedNodeStorage.getProxyAuth()
}

async function digestPassword(message:string) {
    const response = await fetch('/api/crypto', {
        body: JSON.stringify({
            data: message
        }),
        headers: {
            'content-type': 'application/json'
        },
        method: "POST"
    })

    if(response.status < 200 || response.status >= 300){
        let message = `Password crypto failed (${response.status})`
        try {
            const body = await response.json()
            if(body?.error){
                message = body.error
            }
        } catch {}
        throw message
    }
    const crypt = await response.text()
    
    return crypt;
}
