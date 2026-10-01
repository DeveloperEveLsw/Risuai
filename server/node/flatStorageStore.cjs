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
        this.usageBytes = null;
        this.usageEpoch = 0;
    }

    async open() {
        await fsp.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
        await fsp.rm(this.tempDir, { recursive: true, force: true });
        await fsp.mkdir(this.tempDir, { recursive: true, mode: 0o700 });
        await this.usage({ refresh: true });
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

    invalidateUsage() {
        this.usageEpoch += 1;
        this.usageBytes = null;
    }

    async scanUsageFromDisk() {
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

    async usage({ refresh = false } = {}) {
        if (!refresh && this.usageBytes !== null) {
            return this.usageBytes;
        }
        // An external database/auth write can invalidate the snapshot while a
        // scan is in flight. Retry until the scan belongs to one stable epoch
        // so a later flat write never publishes an already-stale total.
        while (true) {
            const epoch = this.usageEpoch;
            const bytes = await this.scanUsageFromDisk();
            if (epoch === this.usageEpoch) {
                this.usageBytes = bytes;
                return bytes;
            }
        }
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
            const usageEpoch = this.usageEpoch;
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
                if (usageEpoch === this.usageEpoch) {
                    this.usageBytes = nextBytes;
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
            const currentBytes = await this.usage();
            const usageEpoch = this.usageEpoch;
            let removedBytes = 0;
            for (const name of names) {
                const entry = await fsp.lstat(path.join(this.rootDir, name));
                if (!entry.isFile()) {
                    throw new Error('Flat storage target is not a regular file');
                }
                removedBytes += entry.size;
            }
            await Promise.all(names.map((name) => fsp.rm(path.join(this.rootDir, name))));
            if (usageEpoch === this.usageEpoch) {
                this.usageBytes = Math.max(0, currentBytes - removedBytes);
            }
        });
    }
}

module.exports = { FlatStorageQuotaError, FlatStorageStore };
