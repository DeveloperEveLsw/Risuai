#!/usr/bin/env node

const { writeFileSync } = require('fs')
const WebSocket = require('ws')

const CDP_ENDPOINT = process.env.RISU_RUNTIME_CDP || 'http://127.0.0.1:9222'

class CdpClient {
    constructor(socket) {
        this.socket = socket
        this.nextId = 1
        this.pending = new Map()

        socket.on('message', (raw) => {
            const message = JSON.parse(raw.toString())
            if (!message.id) {
                return
            }
            const pending = this.pending.get(message.id)
            if (!pending) {
                return
            }
            this.pending.delete(message.id)
            if (message.error) {
                pending.reject(new Error(message.error.message))
            }
            else {
                pending.resolve(message.result)
            }
        })
    }

    call(method, params = {}) {
        return new Promise((resolve, reject) => {
            const id = this.nextId++
            this.pending.set(id, { resolve, reject })
            this.socket.send(JSON.stringify({ id, method, params }))
        })
    }

    close() {
        this.socket.close()
    }
}

async function connect() {
    const targets = await fetch(`${CDP_ENDPOINT}/json`).then((response) => response.json())
    const target = targets.find((candidate) => candidate.type === 'page' && candidate.url.includes(':6001/'))
    if (!target) {
        throw new Error('The resident RisuAI page was not found')
    }

    const websocketUrl = new URL(target.webSocketDebuggerUrl)
    const endpointUrl = new URL(CDP_ENDPOINT)
    websocketUrl.host = endpointUrl.host
    const socket = new WebSocket(websocketUrl)
    await new Promise((resolve, reject) => {
        socket.once('open', resolve)
        socket.once('error', reject)
    })
    return new CdpClient(socket)
}

async function evaluate(client, expression) {
    const result = await client.call('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true
    })
    if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text || 'Runtime evaluation failed')
    }
    return result.result?.value
}

async function main() {
    const command = process.argv[2] || 'summary'
    const client = await connect()
    try {
        if (command === 'summary' || command === 'verify') {
            const summary = await evaluate(client, `(async () => {
                let backendReachable = false
                let backendStatus = 0
                try {
                    const response = await fetch('/logo_32.png', { cache: 'no-store' })
                    backendReachable = response.ok
                    backendStatus = response.status
                    await response.arrayBuffer()
                }
                catch {
                    // Report the failed browser-origin request in the summary.
                }

                return {
                    title: document.title,
                    url: location.href,
                    readyState: document.readyState,
                    nodeMode: globalThis.__NODE__ === true,
                    secureContext: globalThis.isSecureContext,
                    backendReachable,
                    backendStatus,
                    inputCount: document.querySelectorAll('input, textarea').length,
                    buttonCount: document.querySelectorAll('button').length,
                    bodyText: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 800)
                }
            })()`)
            process.stdout.write(`${JSON.stringify(summary)}\n`)
            if (command === 'verify' && !(
                summary.readyState === 'complete' &&
                summary.nodeMode === true &&
                summary.secureContext === true &&
                summary.backendReachable === true
            )) {
                throw new Error('The resident RisuAI page failed its readiness checks')
            }
            return
        }

        if (command === 'screenshot') {
            const outputPath = process.argv[3]
            if (!outputPath) {
                throw new Error('screenshot requires an output path')
            }
            const screenshot = await client.call('Page.captureScreenshot', {
                format: 'png',
                fromSurface: true
            })
            writeFileSync(outputPath, Buffer.from(screenshot.data, 'base64'))
            process.stdout.write(`${outputPath}\n`)
            return
        }

        if (command === 'evaluate-base64') {
            const encodedExpression = process.argv[3]
            if (!encodedExpression) {
                throw new Error('evaluate-base64 requires an encoded expression')
            }
            const expression = Buffer.from(encodedExpression, 'base64').toString('utf-8')
            const value = await evaluate(client, expression)
            process.stdout.write(`${JSON.stringify(value)}\n`)
            return
        }

        throw new Error(`Unknown command: ${command}`)
    }
    finally {
        client.close()
    }
}

main().catch((error) => {
    console.error(error.message)
    process.exit(1)
})
