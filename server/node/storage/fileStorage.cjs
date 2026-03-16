const path = require('path')
const { existsSync, mkdirSync } = require('fs')
const fs = require('fs/promises')

function encodeKey(key) {
    return Buffer.from(key, 'utf-8').toString('hex')
}

function decodeKey(key) {
    return Buffer.from(key, 'hex').toString('utf-8')
}

class FileStorage {
    constructor({ savePath }) {
        this.savePath = savePath
    }

    async init() {
        if (!existsSync(this.savePath)) {
            mkdirSync(this.savePath, { recursive: true })
        }
    }

    async readBuffer(key) {
        try {
            return await fs.readFile(path.join(this.savePath, encodeKey(key)))
        } catch (error) {
            if (error.code === 'ENOENT') {
                return null
            }
            throw error
        }
    }

    async writeBuffer(key, value) {
        await this.init()
        await fs.writeFile(path.join(this.savePath, encodeKey(key)), value)
    }

    async deleteKey(key) {
        try {
            await fs.rm(path.join(this.savePath, encodeKey(key)))
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw error
            }
        }
    }

    async listKeys() {
        await this.init()
        const keys = await fs.readdir(this.savePath)
        return keys
            .filter((key) => !key.startsWith('__'))
            .map((key) => decodeKey(key))
            .sort()
    }

    async getSecret(name) {
        try {
            return await fs.readFile(path.join(this.savePath, `__${name}`), 'utf-8')
        } catch (error) {
            if (error.code === 'ENOENT') {
                return ''
            }
            throw error
        }
    }

    async setSecret(name, value) {
        await this.init()
        await fs.writeFile(path.join(this.savePath, `__${name}`), value, 'utf-8')
    }
}

module.exports = {
    FileStorage
}
