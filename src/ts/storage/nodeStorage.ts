import { language } from "src/lang"
import { alertError, alertInput, waitAlert } from "../alert"
import { base64url, getKeypairStore, saveKeypairStore } from "../util"
import type { Database } from "./database.svelte"


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

    async setItem(key:string, value:Uint8Array) {
        const da = await fetch('/api/write', {
            method: "POST",
            body: value as any,
            headers: await this.getAuthHeaders({
                'content-type': 'application/octet-stream',
                'file-path': Buffer.from(key, 'utf-8').toString('hex')
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
        const da = await fetch('/api/read', {
            method: "GET",
            headers: await this.getAuthHeaders({
                'file-path': Buffer.from(key, 'utf-8').toString('hex')
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
                'file-path': Buffer.from(key, 'utf-8').toString('hex')
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
        const response = await fetch('/api/db/import', {
            method: 'POST',
            headers: await this.getAuthHeaders({
                'content-type': 'application/json'
            }),
            body: JSON.stringify(database)
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
