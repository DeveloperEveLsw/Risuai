import { language } from "src/lang"
import { alertError, alertInput, waitAlert } from "../alert"
import { base64url, getKeypairStore, saveKeypairStore } from "../util"
import type { Database } from "./database.svelte"

const CHUNK_TRANSFER_THRESHOLD = 1024 * 1024 * 4
const DEFAULT_CHUNK_SIZE = 1024 * 1024 * 64

type ChunkUploadSession = {
    uploadId:string
    chunkSize:number
    totalChunks:number
}

type ChunkDownloadManifest = {
    id:string
    chunkSize:number
    totalChunks:number
    size:number
    contentType:string
}

export class NodeStorage{

    authChecked = false
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

    private async getAuthHeaders(extraHeaders:Record<string, string> = {}) {
        await this.checkAuth()
        return {
            ...extraHeaders,
            'risu-auth': await this.createAuth()
        }
    }

    private encodeKey(key:string) {
        return Buffer.from(key, 'utf-8').toString('hex')
    }

    private shouldUseChunkedStorage(key:string, valueLength:number) {
        return key.startsWith('database/') || valueLength >= CHUNK_TRANSFER_THRESHOLD
    }

    private async readError(response:Response) {
        try {
            return await response.text()
        } catch (error) {
            return ''
        }
    }

    private async initChunkedUpload(arg:{
        purpose:'storage'|'db-import'
        key?:string
        size:number
    }):Promise<ChunkUploadSession|null> {
        const response = await fetch('/api/chunked/upload/init', {
            method: 'POST',
            headers: await this.getAuthHeaders({
                'content-type': 'application/json'
            }),
            body: JSON.stringify({
                ...arg,
                chunkSize: DEFAULT_CHUNK_SIZE
            })
        })

        if (response.status === 404) {
            return null
        }
        if (response.status < 200 || response.status >= 300) {
            throw await this.readError(response)
        }

        return await response.json() as ChunkUploadSession
    }

    private async uploadChunked(arg:{
        purpose:'storage'|'db-import'
        data:Uint8Array
        key?:string
    }) {
        const session = await this.initChunkedUpload({
            purpose: arg.purpose,
            key: arg.key,
            size: arg.data.length
        })

        if (!session) {
            return false
        }

        const chunkSize = Math.max(1, session.chunkSize || DEFAULT_CHUNK_SIZE)
        const totalChunks = Math.max(1, session.totalChunks || Math.ceil(arg.data.length / chunkSize))

        for(let i = 0; i < totalChunks; i++) {
            const start = i * chunkSize
            const end = Math.min(arg.data.length, start + chunkSize)
            const chunk = arg.data.slice(start, end)
            const response = await fetch(`/api/chunked/upload/${session.uploadId}/part/${i}`, {
                method: 'POST',
                body: chunk as any,
                headers: await this.getAuthHeaders({
                    'content-type': 'application/octet-stream'
                })
            })

            if (response.status < 200 || response.status >= 300) {
                throw await this.readError(response)
            }
        }

        const completeResponse = await fetch(`/api/chunked/upload/${session.uploadId}/complete`, {
            method: 'POST',
            headers: await this.getAuthHeaders()
        })

        if (completeResponse.status < 200 || completeResponse.status >= 300) {
            throw await this.readError(completeResponse)
        }

        return true
    }

    private async getChunkedDownloadManifest(url:string):Promise<ChunkDownloadManifest|null|false> {
        const response = await fetch(url, {
            method: 'GET',
            headers: await this.getAuthHeaders()
        })

        if (response.status === 404) {
            return false
        }
        if (response.status === 204) {
            return null
        }
        if (response.status < 200 || response.status >= 300) {
            throw await this.readError(response)
        }

        return await response.json() as ChunkDownloadManifest
    }

    private async downloadChunked(manifestUrl:string):Promise<Buffer|null|false> {
        const manifest = await this.getChunkedDownloadManifest(manifestUrl)
        if (manifest === false) {
            return false
        }
        if (manifest === null) {
            return null
        }

        const data = new Uint8Array(manifest.size)
        let offset = 0

        try {
            for(let i = 0; i < manifest.totalChunks; i++) {
                const response = await fetch(`/api/chunked/download/${manifest.id}/part/${i}`, {
                    method: 'GET',
                    headers: await this.getAuthHeaders()
                })

                if (response.status < 200 || response.status >= 300) {
                    throw await this.readError(response)
                }

                const chunk = new Uint8Array(await response.arrayBuffer())
                data.set(chunk, offset)
                offset += chunk.length
            }
        } finally {
            await fetch(`/api/chunked/download/${manifest.id}/complete`, {
                method: 'POST',
                headers: await this.getAuthHeaders()
            }).catch(() => {})
        }

        return Buffer.from(data.buffer.slice(0, offset))
    }

    async setItem(key:string, value:Uint8Array) {
        if (this.shouldUseChunkedStorage(key, value.length)) {
            const uploaded = await this.uploadChunked({
                purpose: 'storage',
                key,
                data: value
            })
            if (uploaded) {
                return
            }
        }

        const da = await fetch('/api/write', {
            method: "POST",
            body: value as any,
            headers: await this.getAuthHeaders({
                'content-type': 'application/octet-stream',
                'file-path': this.encodeKey(key)
            })
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
        if (key.startsWith('database/')) {
            const chunkedData = await this.downloadChunked(`/api/chunked/download/storage/${this.encodeKey(key)}/manifest`)
            if (chunkedData === null) {
                return null
            }
            if (chunkedData !== false) {
                return chunkedData
            }
        }

        const da = await fetch('/api/read', {
            method: "GET",
            headers: await this.getAuthHeaders({
                'file-path': this.encodeKey(key)
            })
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
        const da = await fetch('/api/list', {
            method: "GET",
            headers: await this.getAuthHeaders()
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
    async removeItem(key:string){
        const da = await fetch('/api/remove', {
            method: "GET",
            headers: await this.getAuthHeaders({
                'file-path': this.encodeKey(key)
            })
        })
        if(da.status < 200 || da.status >= 300){
            throw "removeItem Error"
        }
        const data = await da.json()
        if(data.error){
            throw data.error
        }
    }

    async exportDatabase():Promise<Database|null> {
        const chunkedData = await this.downloadChunked('/api/chunked/download/db-export/manifest')
        if (chunkedData === null) {
            return null
        }
        if (chunkedData instanceof Buffer) {
            return JSON.parse(chunkedData.toString('utf-8')) as Database
        }

        const response = await fetch('/api/db/export', {
            method: 'GET',
            headers: await this.getAuthHeaders()
        })

        if(response.status === 204 || response.status === 404){
            return null
        }
        if(response.status < 200 || response.status >= 300){
            throw "exportDatabase Error"
        }

        return await response.json() as Database
    }

    async importDatabase(database:Database) {
        const payload = Buffer.from(JSON.stringify(database), 'utf-8')
        if (payload.length >= CHUNK_TRANSFER_THRESHOLD) {
            const uploaded = await this.uploadChunked({
                purpose: 'db-import',
                data: payload
            })
            if (uploaded) {
                return true
            }
        }

        const response = await fetch('/api/db/import', {
            method: 'POST',
            headers: await this.getAuthHeaders({
                'content-type': 'application/json'
            }),
            body: payload
        })

        if(response.status === 404){
            return false
        }
        if(response.status < 200 || response.status >= 300){
            throw "importDatabase Error"
        }

        return true
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

                //too many requests
                if(s.status === 429){
                    alertError(`Too many attempts. Please wait and try again later.`)
                    await waitAlert()
                }
                

                return await this.createAuth()
            
            }
            else{
                this.authChecked = true
            }
        }
    }

    listItem = this.keys
}

async function digestPassword(message:string) {
    const crypt = await (await fetch('/api/crypto', {
        body: JSON.stringify({
            data: message
        }),
        headers: {
            'content-type': 'application/json'
        },
        method: "POST"
    })).text()
    
    return crypt;
}
