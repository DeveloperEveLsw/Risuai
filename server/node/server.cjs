const express = require('express');
const app = express();
const path = require('path');
const htmlparser = require('node-html-parser');
const { existsSync, readFileSync, writeFileSync } = require('fs');
const fs = require('fs/promises')
const nodeCrypto = require('crypto')
const { createStorage } = require('./storage/storageFactory.cjs')
const { ChunkSessionStore, DEFAULT_CHUNK_SIZE } = require('./chunkSessions.cjs')
app.use(express.static(path.join(process.cwd(), 'dist'), {index: false}));
app.use(express.json({ limit: '100mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '100mb' }));
app.use(express.text({ limit: '100mb' }));
const {pipeline} = require('stream/promises')
const https = require('https');
const sslPath = path.join(process.cwd(), 'server/node/ssl/certificate');
const hubURL = 'https://sv.risuai.xyz'; 
const openid = require('openid-client');

let password = ''
let knownPublicKeysHashes = []
const hexRegex = /^[0-9a-fA-F]+$/;
const { driver: storageDriver, storage } = createStorage()
const chunkSessions = new ChunkSessionStore()

function isHex(str) {
    return hexRegex.test(str.toUpperCase().trim());
}

function decodeStorageKey(value) {
    return Buffer.from(value, 'hex').toString('utf-8')
}

async function hashJSON(json){
    const hash = nodeCrypto.createHash('sha256');
    hash.update(JSON.stringify(json));
    return hash.digest('hex');
}

function parseChunkIndex(value) {
    const parsed = Number.parseInt(value, 10)
    if (!Number.isFinite(parsed) || parsed < 0) {
        return null
    }
    return parsed
}

function handleChunkRouteError(res, error, next) {
    if (error?.statusCode) {
        res.status(error.statusCode).send({
            error: error.message
        })
        return
    }
    next(error)
}

function buildChunkManifest(meta) {
    return {
        id: meta.id,
        chunkSize: meta.chunkSize,
        totalChunks: meta.totalChunks,
        size: meta.size,
        contentType: meta.contentType || 'application/octet-stream'
    }
}

app.get('/', async (req, res, next) => {

    const clientIP = req.headers['x-forwarded-for'] || req.ip || req.socket.remoteAddress || 'Unknown IP';
    const timestamp = new Date().toISOString();
    console.log(`[Server] ${timestamp} | Connection from: ${clientIP}`);
    
    try {
        const mainIndex = await fs.readFile(path.join(process.cwd(), 'dist', 'index.html'))
        const root = htmlparser.parse(mainIndex)
        const head = root.querySelector('head')
        head.innerHTML = `<script>globalThis.__NODE__ = true</script>` + head.innerHTML
        
        res.send(root.toString())
    } catch (error) {
        console.log(error)
        next(error)
    }
})

async function checkAuth(req, res, returnOnlyStatus = false){
    try {
        const authHeader = req.headers['risu-auth'];

        if(!authHeader){
            console.log('No auth header')
            if(returnOnlyStatus){
                return false;
            }
            res.status(400).send({
                error:'No auth header'
            });
            return false
        }


        //jwt token
        const [
            jsonHeaderB64,
            jsonPayloadB64,
            signatureB64,
        ] = authHeader.split('.');

        //alg, typ
        const jsonHeader = JSON.parse(Buffer.from(jsonHeaderB64, 'base64url').toString('utf-8'));

        //iat, exp, pub
        const jsonPayload = JSON.parse(Buffer.from(jsonPayloadB64, 'base64url').toString('utf-8'));

        //signature
        const signature = Buffer.from(signatureB64, 'base64url');

        
        //check expiration
        const now = Math.floor(Date.now() / 1000);
        if(jsonPayload.exp < now){
            console.log('Token expired')
            if(returnOnlyStatus){
                return false;
            }
            res.status(400).send({
                error:'Token Expired'
            });
            return false
        }

        //check if public key is known
        const pubKeyHash = await hashJSON(jsonPayload.pub)
        if(!knownPublicKeysHashes.includes(pubKeyHash)){
            console.log('Unknown public key')
            if(returnOnlyStatus){
                return false;
            }
            res.status(400).send({
                error:'Unknown Public Key'
            });
            return false
        }

        //check signature
        if(jsonHeader.alg !== "ES256"){
            //only support ECDSA for now
            console.log('Unsupported algorithm')
            if(returnOnlyStatus){
                return false;
            }
            res.status(400).send({
                error:'Unsupported Algorithm'
            });
            return false
        }

        const isValid = await crypto.subtle.verify(
            {
                name: 'ECDSA',
                hash: {name: 'SHA-256'},
            },
            await crypto.subtle.importKey(
                'jwk',
                jsonPayload.pub,
                {
                    name: 'ECDSA',
                    namedCurve: 'P-256',
                },
                false,
                ['verify']
            ),
            signature,
            Buffer.from(`${jsonHeaderB64}.${jsonPayloadB64}`)
        );

        if(!isValid){
            console.log('Invalid signature')
            if(returnOnlyStatus){
                return false;
            }
            res.status(400).send({
                error:'Invalid Signature'
            });
            return false
        }
        
        return true   
    } catch (error) {
        console.log(error)
        if(returnOnlyStatus){
            return false;
        }
        res.status(500).send({
            error:'Internal Server Error'
        });
        return false
    }
}

const reverseProxyFunc = async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    
    const urlParam = req.headers['risu-url'] ? decodeURIComponent(req.headers['risu-url']) : req.query.url;

    if (!urlParam) {
        res.status(400).send({
            error:'URL has no param'
        });
        return;
    }
    const header = req.headers['risu-header'] ? JSON.parse(decodeURIComponent(req.headers['risu-header'])) : req.headers;
    if(!header['x-forwarded-for']){
        header['x-forwarded-for'] = req.ip
    }

    if(req.headers['authorization']?.startsWith('X-SERVER-REGISTER')){
        const authCode = await storage.getSecret('authcode')
        if(!authCode){
            delete header['authorization']
        }
        else{
            header['authorization'] = `Bearer ${authCode}`
        }
    }
    let originalResponse;
    try {
        // make request to original server
        originalResponse = await fetch(urlParam, {
            method: req.method,
            headers: header,
            body: JSON.stringify(req.body)
        });
        // get response body as stream
        const originalBody = originalResponse.body;
        // get response headers
        const head = new Headers(originalResponse.headers);
        head.delete('content-security-policy');
        head.delete('content-security-policy-report-only');
        head.delete('clear-site-data');
        head.delete('Cache-Control');
        head.delete('Content-Encoding');
        const headObj = {};
        for (let [k, v] of head) {
            headObj[k] = v;
        }
        // send response headers to client
        res.header(headObj);
        // send response status to client
        res.status(originalResponse.status);
        // send response body to client
        await pipeline(originalResponse.body, res);


    }
    catch (err) {
        next(err);
        return;
    }
}

const reverseProxyFunc_get = async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    
    const urlParam = req.headers['risu-url'] ? decodeURIComponent(req.headers['risu-url']) : req.query.url;

    if (!urlParam) {
        res.status(400).send({
            error:'URL has no param'
        });
        return;
    }
    const header = req.headers['risu-header'] ? JSON.parse(decodeURIComponent(req.headers['risu-header'])) : req.headers;
    if(!header['x-forwarded-for']){
        header['x-forwarded-for'] = req.ip
    }
    let originalResponse;
    try {
        // make request to original server
        originalResponse = await fetch(urlParam, {
            method: 'GET',
            headers: header
        });
        // get response body as stream
        const originalBody = originalResponse.body;
        // get response headers
        const head = new Headers(originalResponse.headers);
        head.delete('content-security-policy');
        head.delete('content-security-policy-report-only');
        head.delete('clear-site-data');
        head.delete('Cache-Control');
        head.delete('Content-Encoding');
        const headObj = {};
        for (let [k, v] of head) {
            headObj[k] = v;
        }
        // send response headers to client
        res.header(headObj);
        // send response status to client
        res.status(originalResponse.status);
        // send response body to client
        await pipeline(originalResponse.body, res);
    }
    catch (err) {
        next(err);
        return;
    }
}

let accessTokenCache = {
    token: null,
    expiry: 0
}
async function getSionywAccessToken() {
    if(accessTokenCache.token && Date.now() < accessTokenCache.expiry){
        return accessTokenCache.token;
    }
    //Schema of the client data file
    // {
    //     refresh_token: string;
    //     client_id: string;
    //     client_secret: string;
    // }
    
    const clientDataPath = path.join(process.cwd(), 'save', '__sionyw_client_data.json');
    let refreshToken = ''
    let clientId = ''
    let clientSecret = ''
    if(!existsSync(clientDataPath)){
        throw new Error('No Sionyw client data found');
    }
    const clientDataRaw = readFileSync(clientDataPath, 'utf-8');
    const clientData = JSON.parse(clientDataRaw);
    refreshToken = clientData.refresh_token;
    clientId = clientData.client_id;
    clientSecret = clientData.client_secret;

    //Oauth Refresh Token Flow
    
    const tokenResponse = await fetch('account.sionyw.com/account/api/oauth/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: clientId,
            client_secret: clientSecret
        })
    })

    if(!tokenResponse.ok){
        throw new Error('Failed to refresh Sionyw access token');
    }

    const tokenData = await tokenResponse.json();

    //Update the refresh token in the client data file
    if(tokenData.refresh_token && tokenData.refresh_token !== refreshToken){
        clientData.refresh_token = tokenData.refresh_token;
        writeFileSync(clientDataPath, JSON.stringify(clientData), 'utf-8');
    }

    accessTokenCache.token = tokenData.access_token;
    accessTokenCache.expiry = Date.now() + (tokenData.expires_in * 1000) - (5 * 60 * 1000); //5 minutes early

    return tokenData.access_token;
}


async function hubProxyFunc(req, res) {
    const excludedHeaders = [
        'content-encoding',
        'content-length',
        'transfer-encoding'
    ];

    try {
        let externalURL = '';

        const pathHeader = req.headers['x-risu-node-path'];
        if (pathHeader) {
            const decodedPath = decodeURIComponent(pathHeader);
            externalURL = decodedPath;
        } else {
            const pathAndQuery = req.originalUrl.replace(/^\/hub-proxy/, '');
            externalURL = hubURL + pathAndQuery;
        }
        
        const headersToSend = { ...req.headers };
        delete headersToSend.host;
        delete headersToSend.connection;
        delete headersToSend['content-length'];
        delete headersToSend['x-risu-node-path'];

        const hubOrigin = new URL(hubURL).origin;
        headersToSend.origin = hubOrigin;

        //if Authorization header is "Server-Auth, set the token to be Server-Auth
        if(headersToSend['Authorization'] === 'X-Node-Server-Auth'){
            //this requires password auth
            if(!await checkAuth(req, res)){
                return;
            }

            headersToSend['Authorization'] = "Bearer " + await getSionywAccessToken();
            delete headersToSend['risu-auth'];
        }
        
        
        const response = await fetch(externalURL, {
            method: req.method,
            headers: headersToSend,
            body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
            redirect: 'manual',
            duplex: 'half'
        });
        
        for (const [key, value] of response.headers.entries()) {
            // Skip encoding-related headers to prevent double decoding
            if (excludedHeaders.includes(key.toLowerCase())) {
                continue;
            }
            res.setHeader(key, value);
        }
        res.status(response.status);

        if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
            const redirectUrl = response.headers.get('location');
            const newHeaders = { ...headersToSend };
            const redirectResponse = await fetch(redirectUrl, {
                method: req.method,
                headers: newHeaders,
                body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
                redirect: 'manual',
                duplex: 'half'
            });
            for (const [key, value] of redirectResponse.headers.entries()) {
                if (excludedHeaders.includes(key.toLowerCase())) {
                    continue;
                }
                res.setHeader(key, value);
            }
            res.status(redirectResponse.status);
            if (redirectResponse.body) {
                await pipeline(redirectResponse.body, res);
            } else {
                res.end();
            }
            return;
        }
        
        if (response.body) {
            await pipeline(response.body, res);
        } else {
            res.end();
        }
        
    } catch (error) {
        console.error("[Hub Proxy] Error:", error);
        if (!res.headersSent) {
            res.status(502).send({ error: 'Proxy request failed: ' + error.message });
        } else {
            res.end();
        }
    }
}

app.get('/proxy', reverseProxyFunc_get);
app.get('/proxy2', reverseProxyFunc_get);
app.get('/hub-proxy/*', hubProxyFunc);

app.post('/proxy', reverseProxyFunc);
app.post('/proxy2', reverseProxyFunc);
app.post('/hub-proxy/*', hubProxyFunc);

// app.get('/api/password', async(req, res)=> {
//     if(password === ''){
//         res.send({status: 'unset'})
//     }
//     else if(req.body.password && req.body.password.trim() === password.trim()){
//         res.send({status:'correct'})
//     }
//     else{
//         res.send({status:'incorrect'})
//     }
// })

app.get('/api/test_auth', async(req, res) => {

    if(!password){
        res.send({status: 'unset'})
    }
    else if(!await checkAuth(req, res, true)){
        res.send({status: 'incorrect'})
    }
    else{
        res.send({status: 'success'})
    }
})

let loginTries = 0;
let loginTriesResetsIn = 0;
app.post('/api/login', async (req, res) => {

    if(loginTriesResetsIn < Date.now()){
        loginTriesResetsIn = Date.now() + (30 * 1000); //30 seconds
        loginTries = 0;
    }

    if(loginTries >= 10){
        res.status(429).send({error: 'Too many attempts. Please wait and try again later.'})
        return;
    }
    else{
        loginTries++;
    }

    if(password === ''){
        res.status(400).send({error: 'Password not set'})
        return;
    }
    if(req.body.password && req.body.password.trim() === password.trim()){
        knownPublicKeysHashes.push(await hashJSON(req.body.publicKey))
        res.send({status:'success'})
    }
    else{
        res.status(400).send({error: 'Password incorrect'})
    }
})

app.post('/api/crypto', async (req, res) => {
    try {
        const hash = nodeCrypto.createHash('sha256')
        hash.update(Buffer.from(req.body.data, 'utf-8'))
        res.send(hash.digest('hex'))
    } catch (error) {
        res.status(500).send({ error: 'Crypto operation failed' });
    }
})


app.post('/api/set_password', async (req, res) => {
    if(password === ''){
        password = req.body.password
        await storage.setSecret('password', password)
        res.send({status: 'success'})
    }
    else{
        res.status(400).send("already set")
    }
})

app.get('/api/read', async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    const filePath = req.headers['file-path'];
    if (!filePath) {
        console.log('no path')
        res.status(400).send({
            error:'File path required'
        });
        return;
    }

    if(!isHex(filePath)){
        res.status(400).send({
            error:'Invaild Path'
        });
        return;
    }
    try {
        const data = await storage.readBuffer(decodeStorageKey(filePath))
        if(!data){
            res.send();
        }
        else{
            res.setHeader('Content-Type','application/octet-stream');
            res.send(data);
        }
    } catch (error) {
        next(error);
    }
});

app.get('/api/remove', async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    const filePath = req.headers['file-path'];
    if (!filePath) {
        res.status(400).send({
            error:'File path required'
        });
        return;
    }
    if(!isHex(filePath)){
        res.status(400).send({
            error:'Invaild Path'
        });
        return;
    }

    try {
        await storage.deleteKey(decodeStorageKey(filePath));
        res.send({
            success: true,
        });
    } catch (error) {
        next(error);
    }
});

app.get('/api/list', async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    try {
        const data = await storage.listKeys()
        res.send({
            success: true,
            content: data
        });
    } catch (error) {
        next(error);
    }
});

app.post('/api/write', async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    const filePath = req.headers['file-path'];
    const fileContent = req.body
    if (!filePath || !fileContent) {
        res.status(400).send({
            error:'File path required'
        });
        return;
    }
    if(!isHex(filePath)){
        res.status(400).send({
            error:'Invaild Path'
        });
        return;
    }

    try {
        await storage.writeBuffer(decodeStorageKey(filePath), fileContent);
        res.send({
            success: true
        });
    } catch (error) {
        next(error);
    }
});

app.post('/api/chunked/upload/init', async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }

    const purpose = req.body?.purpose
    const key = req.body?.key
    const size = Number(req.body?.size ?? 0)
    const chunkSize = Number(req.body?.chunkSize ?? DEFAULT_CHUNK_SIZE)

    if (!['storage', 'db-import'].includes(purpose)) {
        res.status(400).send({ error: 'Invalid chunk upload purpose' })
        return
    }
    if (purpose === 'storage' && typeof key !== 'string') {
        res.status(400).send({ error: 'Storage key is required for chunk uploads' })
        return
    }
    if (!Number.isFinite(size) || size < 0) {
        res.status(400).send({ error: 'Upload size must be a non-negative number' })
        return
    }
    if (purpose === 'db-import' && typeof storage.importStructuredDatabase !== 'function') {
        res.status(404).send({ error: 'Structured database import is not supported by this storage driver' })
        return
    }

    try {
        const session = await chunkSessions.createUploadSession({
            purpose,
            key: key || '',
            size,
            chunkSize
        })
        res.send({
            uploadId: session.id,
            chunkSize: session.chunkSize,
            totalChunks: session.totalChunks
        })
    } catch (error) {
        handleChunkRouteError(res, error, next)
    }
})

app.post('/api/chunked/upload/:uploadId/part/:index', async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }

    const chunkIndex = parseChunkIndex(req.params.index)
    if (chunkIndex === null) {
        res.status(400).send({ error: 'Chunk index must be a non-negative integer' })
        return
    }

    try {
        const chunk = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '')
        await chunkSessions.appendUploadChunk(req.params.uploadId, chunkIndex, chunk)
        res.send({ success: true })
    } catch (error) {
        handleChunkRouteError(res, error, next)
    }
})

app.post('/api/chunked/upload/:uploadId/complete', async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }

    try {
        const { meta, data } = await chunkSessions.finalizeUpload(req.params.uploadId)

        if (meta.purpose === 'storage') {
            await storage.writeBuffer(meta.key, data)
            res.send({ success: true })
            return
        }

        if (meta.purpose === 'db-import') {
            if (typeof storage.importStructuredDatabase !== 'function') {
                res.status(404).send({ error: 'Structured database import is not supported by this storage driver' })
                return
            }

            let payload
            try {
                payload = JSON.parse(data.toString('utf-8'))
            } catch (error) {
                res.status(400).send({ error: 'Invalid structured database payload' })
                return
            }

            if (!payload || typeof payload !== 'object') {
                res.status(400).send({ error: 'Structured database payload required' })
                return
            }

            await storage.importStructuredDatabase(payload)
            res.send({ success: true })
            return
        }

        res.status(400).send({ error: 'Unsupported chunk upload purpose' })
    } catch (error) {
        handleChunkRouteError(res, error, next)
    }
})

app.get('/api/chunked/download/storage/:filePath/manifest', async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }

    const filePath = req.params.filePath
    if (!filePath || !isHex(filePath)) {
        res.status(400).send({ error: 'Invaild Path' })
        return
    }

    try {
        const storageKey = decodeStorageKey(filePath)
        const data = await storage.readBuffer(storageKey)
        if (!data) {
            res.status(204).end()
            return
        }

        const session = await chunkSessions.createDownloadSession({
            purpose: 'storage',
            key: storageKey,
            data
        })
        res.send(buildChunkManifest(session))
    } catch (error) {
        handleChunkRouteError(res, error, next)
    }
})

app.get('/api/chunked/download/db-export/manifest', async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }

    if(typeof storage.exportStructuredDatabase !== 'function'){
        res.status(404).send({ error: 'Structured database export is not supported by this storage driver' })
        return
    }

    try {
        const data = await storage.exportStructuredDatabase()
        if(!data){
            res.status(204).end()
            return
        }

        const session = await chunkSessions.createDownloadSession({
            purpose: 'db-export',
            data: Buffer.from(JSON.stringify(data), 'utf-8'),
            contentType: 'application/json'
        })
        res.send(buildChunkManifest(session))
    } catch (error) {
        handleChunkRouteError(res, error, next)
    }
})

app.get('/api/chunked/download/:downloadId/part/:index', async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }

    const chunkIndex = parseChunkIndex(req.params.index)
    if (chunkIndex === null) {
        res.status(400).send({ error: 'Chunk index must be a non-negative integer' })
        return
    }

    try {
        const { meta, chunk } = await chunkSessions.readDownloadChunk(req.params.downloadId, chunkIndex)
        res.setHeader('Content-Type', meta.contentType || 'application/octet-stream')
        res.send(chunk)
    } catch (error) {
        handleChunkRouteError(res, error, next)
    }
})

app.post('/api/chunked/download/:downloadId/complete', async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }

    try {
        await chunkSessions.cleanupSession(req.params.downloadId)
        res.send({ success: true })
    } catch (error) {
        handleChunkRouteError(res, error, next)
    }
})

app.get('/api/db/export', async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    if(typeof storage.exportStructuredDatabase !== 'function'){
        res.status(404).send({ error: 'Structured database export is not supported by this storage driver' })
        return
    }

    try {
        const data = await storage.exportStructuredDatabase()
        if(!data){
            res.status(204).end()
            return
        }
        res.send(data)
    } catch (error) {
        next(error)
    }
})

app.post('/api/db/import', async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    if(typeof storage.importStructuredDatabase !== 'function'){
        res.status(404).send({ error: 'Structured database import is not supported by this storage driver' })
        return
    }
    if(!req.body || typeof req.body !== 'object'){
        res.status(400).send({ error: 'Database payload required' })
        return
    }

    try {
        await storage.importStructuredDatabase(req.body)
        res.send({
            success: true
        })
    } catch (error) {
        next(error)
    }
})

const oauthData = {
    client_id: '',
    client_secret: '',
    config: {},
    code_verifier: ''

}
app.get('/api/oauth_login', async (req, res) => {
    const redirect_uri = (new URL (req.url)).host + '/api/oauth_callback'

    if(!redirect_uri){
        res.status(400).send({ error: 'redirect_uri is required' });
        return
    }
    if(!oauthData.client_id || !oauthData.client_secret){
        const discovery = await openid.discovery('https://account.sionyw.com/','','');
        oauthData.config = discovery;

        //oauth dynamic client registration
        //https://datatracker.ietf.org/doc/html/rfc7591

        const serverMeta = discovery.serverMetadata()
        //since we can't find a good library to do this, we will do it manually
        const registrationResponse = await fetch(serverMeta.registration_endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + (serverMeta.registration_access_token || '')
            },
            body: JSON.stringify({
                client_id: oauthData.client_id,
                client_secret: oauthData.client_secret,
                redirect_uris: [redirect_uri],
                response_types: ['code'],
                grant_types: ['authorization_code'],
                scope: 'risuai',
                token_endpoint_auth_method: 'client_secret_basic',
                client_name: 'Risuai Node Server',
            })
        });

        if(registrationResponse.status === 201 || registrationResponse.status === 200){
            const registrationData = await registrationResponse.json();
            oauthData.client_id = registrationData.client_id;
            oauthData.client_secret = registrationData.client_secret;
            discovery.clientMetadata().client_id = oauthData.client_id;
            discovery.clientMetadata().client_secret = oauthData.client_secret;
        }
        else{
            console.error('[Server] OAuth2 dynamic client registration failed:', registrationResponse.statusText);
            res.status(500).send({ error: 'OAuth2 client registration failed' });
            return
        }


        //now lets request

        let code_verifier = openid.randomPKCECodeVerifier();
        let code_challenge = await openid.calculatePKCECodeChallenge(code_verifier);

        oauthData.code_verifier = code_verifier;
        let redirectTo = openid.buildAuthorizationUrl(oauthData.config, {
            redirect_uri,
            code_challenge,
            code_challenge_method: 'S256',
            scope: 'risuai',
        })

        res.redirect(redirectTo.toString());

        return;

    }
    
    res.status(500).send({ error: 'OAuth2 login failed' });
});

app.get('/api/oauth_callback', async (req, res) => {

    //since this is a callback we don't need to check password

    const params = (new URL(req.url, `http://${req.headers.host}`)).searchParams;
    const code = params.get('code');

    if(!code){
        res.status(400).send({ error: 'code is required' });
        return
    }
    if(!oauthData.client_id || !oauthData.client_secret || !oauthData.code_verifier){
        res.status(400).send({ error: 'OAuth2 not initialized' });
        return
    }

    let tokens = await openid.authorizationCodeGrant(
        oauthData.config,   
        getCurrentUrl(),
        {
            pkceCodeVerifier: oauthData.code_verifier,
        },
    )

    await storage.setSecret('authcode', tokens.access_token)

    res.send(tokens)
            
})

async function getHttpsOptions() {

    const keyPath = path.join(sslPath, 'server.key');
    const certPath = path.join(sslPath, 'server.crt');

    try {
 
        await fs.access(keyPath);
        await fs.access(certPath);

        const [key, cert] = await Promise.all([
            fs.readFile(keyPath),
            fs.readFile(certPath)
        ]);
       
        return { key, cert };

    } catch (error) {
        console.error('[Server] SSL setup errors:', error.message);
        console.log('[Server] Start the server with HTTP instead of HTTPS...');
        return null;
    }
}

async function startServer() {
    try {
        await storage.init()
        password = await storage.getSecret('password')
        console.log(`[Server] Storage driver: ${storageDriver}`)
      
        const port = process.env.PORT || 6001;
        const httpsOptions = await getHttpsOptions();

        if (httpsOptions) {
            // HTTPS
            https.createServer(httpsOptions, app).listen(port, () => {
                console.log("[Server] HTTPS server is running.");
                console.log(`[Server] https://localhost:${port}/`);
            });
        } else {
            // HTTP
            app.listen(port, () => {
                console.log("[Server] HTTP server is running.");
                console.log(`[Server] http://localhost:${port}/`);
            });
        }
    } catch (error) {
        console.error('[Server] Failed to start server :', error);
        process.exit(1);
    }
}

async function closeStorage() {
    if (typeof storage.close === 'function') {
        await storage.close()
    }
}

process.on('SIGTERM', async () => {
    await closeStorage()
    process.exit(0)
});

process.on('SIGINT', async () => {
    await closeStorage()
    process.exit(0)
});

(async () => {
    await startServer();
})();
