const path = require('path');
const { existsSync, mkdirSync } = require('fs');
const fs = require('fs/promises');

class FileStorage {
    constructor(options = {}) {
        this.savePath = options.savePath;

        if (!this.savePath) {
            throw new Error('FileStorage requires a savePath');
        }

        if (!existsSync(this.savePath)) {
            mkdirSync(this.savePath, { recursive: true });
        }
    }

    get type() {
        return 'file';
    }

    async initialize() {
        return;
    }

    toFileName(key) {
        return Buffer.from(key, 'utf-8').toString('hex');
    }

    toFilePath(key) {
        return path.join(this.savePath, this.toFileName(key));
    }

    async getItem(key) {
        try {
            return await fs.readFile(this.toFilePath(key));
        }
        catch (error) {
            if (error && error.code === 'ENOENT') {
                return null;
            }
            throw error;
        }
    }

    async setItem(key, value) {
        await fs.writeFile(this.toFilePath(key), value);
    }

    async removeItem(key) {
        try {
            await fs.rm(this.toFilePath(key));
        }
        catch (error) {
            if (error && error.code === 'ENOENT') {
                return;
            }
            throw error;
        }
    }

    async keys() {
        const entries = await fs.readdir(this.savePath);
        return entries
            .filter((entry) => /^[0-9a-fA-F]+$/.test(entry))
            .map((entry) => Buffer.from(entry, 'hex').toString('utf-8'));
    }
}

module.exports = {
    FileStorage,
};
