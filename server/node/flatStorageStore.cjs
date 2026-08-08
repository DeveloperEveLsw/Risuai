const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

class FlatStorageQuotaError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'FlatStorageQuotaError';
        this.code = 'SAVE_STORAGE_QUOTA_EXCEEDED';
        this.statusCode = 507;
        Object.assign(this, details);
    }
}

class FlatStorageStore {
    constructor({ rootDir, maxBytes, minFreeBytes, statfs = fsp.statfs }) {
        if (!path.isAbsolute(rootDir)) {
            throw new TypeError('rootDir must be absolute');
        }
        for (const [name, value] of Object.entries({ maxBytes, minFreeBytes })) {
            if (!Number.isSafeInteger(value) || value < 0) {
                throw new TypeError(`${name} must be a non-negative safe integer`);
            }
        }
        this.rootDir = rootDir;
        this.tempDir = path.join(rootDir, '__flat_write_tmp');
        this.maxBytes = maxBytes;
        this.minFreeBytes = minFreeBytes;
        this.statfs = statfs;
        this.tail = Promise.resolve();
    }

    async open() {
        await fsp.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
        await fsp.rm(this.tempDir, { recursive: true, force: true });
        await fsp.mkdir(this.tempDir, { recursive: true, mode: 0o700 });
    }

    runExclusive(operation) {
        const pending = this.tail.then(operation, operation);
        this.tail = pending.catch(() => {});
        return pending;
    }

    assertName(name) {
        if (typeof name !== 'string' || !/^[0-9a-fA-F]+$/.test(name)) {
            throw new TypeError('Flat storage name must be hexadecimal');
        }
    }

    async usage() {
        const entries = await fsp.readdir(this.rootDir, { withFileTypes: true });
        let bytes = 0;
        for (const entry of entries) {
            if (!entry.isFile()) {
                continue;
            }
            const stat = await fsp.stat(path.join(this.rootDir, entry.name));
            bytes += stat.size;
        }
        return bytes;
    }

    async write(name, input) {
        this.assertName(name);
        const data = Buffer.isBuffer(input) ? input : Buffer.from(input);
        return await this.runExclusive(async () => {
            const target = path.join(this.rootDir, name);
            let previousBytes = 0;
            try {
                const previous = await fsp.lstat(target);
                if (!previous.isFile()) {
                    throw new Error('Flat storage target is not a regular file');
                }
                previousBytes = previous.size;
            }
            catch (error) {
                if (error?.code !== 'ENOENT') {
                    throw error;
                }
            }

            const currentBytes = await this.usage();
            const nextBytes = currentBytes - previousBytes + data.byteLength;
            if (nextBytes > this.maxBytes) {
                throw new FlatStorageQuotaError('Server asset storage quota would be exceeded', {
                    currentBytes,
                    nextBytes,
                    maxBytes: this.maxBytes,
                });
            }
            const filesystem = await this.statfs(this.rootDir, { bigint: true });
            const availableBytes = Number(filesystem.bavail * filesystem.bsize);
            // Atomic replacement temporarily needs both old and new files.
            if (availableBytes - data.byteLength < this.minFreeBytes) {
                throw new FlatStorageQuotaError('Server free-space reserve would be exhausted', {
                    availableBytes,
                    incomingBytes: data.byteLength,
                    minFreeBytes: this.minFreeBytes,
                });
            }

            const temporary = path.join(
                this.tempDir,
                `${name}.${crypto.randomBytes(16).toString('hex')}.tmp`,
            );
            let handle;
            try {
                handle = await fsp.open(temporary, 'wx', 0o600);
                await handle.writeFile(data);
                await handle.sync();
                await handle.close();
                handle = null;
                await fsp.rename(temporary, target);
                const directory = await fsp.open(this.rootDir, 'r');
                try {
                    await directory.sync();
                }
                finally {
                    await directory.close();
                }
            }
            finally {
                await handle?.close().catch(() => {});
                await fsp.rm(temporary, { force: true }).catch(() => {});
            }
            return { currentBytes: nextBytes };
        });
    }

    async remove(names) {
        for (const name of names) {
            this.assertName(name);
        }
        return await this.runExclusive(async () => {
            await Promise.all(names.map((name) => fsp.rm(path.join(this.rootDir, name))));
        });
    }
}

module.exports = { FlatStorageQuotaError, FlatStorageStore };
