'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const STORE_SCHEMA_VERSION = 1;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

class RuntimePluginPermissionStoreError extends Error {
    constructor(message, code = 'RUNTIME_PLUGIN_PERMISSION_STORE_ERROR') {
        super(message);
        this.name = 'RuntimePluginPermissionStoreError';
        this.code = code;
    }
}

function permissionKeyDigest(key) {
    if (typeof key !== 'string' || key.length === 0 || key.length > 4_096) {
        throw new TypeError('permission key must be a non-empty bounded string');
    }
    return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

async function syncDirectory(directory) {
    let handle;
    try {
        handle = await fs.open(directory, 'r');
        await handle.sync();
    }
    catch (error) {
        if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(error?.code)) {
            throw error;
        }
    }
    finally {
        await handle?.close().catch(() => {});
    }
}

class RuntimePluginPermissionStore {
    constructor(options = {}) {
        if (typeof options.rootDir !== 'string' || options.rootDir.trim() === '') {
            throw new TypeError('rootDir is required');
        }
        this.rootDir = path.resolve(options.rootDir);
        this.filePath = path.join(this.rootDir, 'grants.json');
        this.legacyRootDir = typeof options.legacyRootDir === 'string'
            ? path.resolve(options.legacyRootDir)
            : null;
        this.grants = new Map();
        this.openPromise = null;
        this.mutation = Promise.resolve();
    }

    async open() {
        if (this.openPromise) {
            return await this.openPromise;
        }
        this.openPromise = this.#open();
        try {
            await this.openPromise;
        }
        catch (error) {
            this.openPromise = null;
            throw error;
        }
        return this;
    }

    async #open() {
        await fs.mkdir(this.rootDir, { recursive: true, mode: DIRECTORY_MODE });
        const directoryStat = await fs.lstat(this.rootDir);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
            throw new RuntimePluginPermissionStoreError(
                'Permission store root must be a real directory',
                'RUNTIME_PLUGIN_PERMISSION_STORE_UNSAFE_PATH',
            );
        }
        await fs.chmod(this.rootDir, DIRECTORY_MODE);

        let encoded;
        try {
            encoded = await fs.readFile(this.filePath, 'utf8');
        }
        catch (error) {
            if (error?.code === 'ENOENT') {
                return;
            }
            throw error;
        }
        const fileStat = await fs.lstat(this.filePath);
        if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
            throw new RuntimePluginPermissionStoreError(
                'Permission store file must be a regular file',
                'RUNTIME_PLUGIN_PERMISSION_STORE_UNSAFE_PATH',
            );
        }
        await fs.chmod(this.filePath, FILE_MODE);

        let document;
        try {
            document = JSON.parse(encoded);
        }
        catch {
            throw new RuntimePluginPermissionStoreError(
                'Permission store is not valid JSON',
                'RUNTIME_PLUGIN_PERMISSION_STORE_CORRUPT',
            );
        }
        if (document?.schemaVersion !== STORE_SCHEMA_VERSION
            || !document.grants
            || typeof document.grants !== 'object'
            || Array.isArray(document.grants)) {
            throw new RuntimePluginPermissionStoreError(
                'Permission store has an unsupported schema',
                'RUNTIME_PLUGIN_PERMISSION_STORE_CORRUPT',
            );
        }
        const restored = new Map();
        for (const [digest, grant] of Object.entries(document.grants)) {
            if (!/^[a-f0-9]{64}$/.test(digest)
                || !grant
                || typeof grant !== 'object'
                || typeof grant.key !== 'string'
                || permissionKeyDigest(grant.key) !== digest
                || !Number.isSafeInteger(grant.grantedAt)
                || grant.grantedAt <= 0) {
                throw new RuntimePluginPermissionStoreError(
                    'Permission store contains an invalid grant',
                    'RUNTIME_PLUGIN_PERMISSION_STORE_CORRUPT',
                );
            }
            restored.set(digest, { key: grant.key, grantedAt: grant.grantedAt });
        }
        this.grants = restored;
    }

    async getGrant(key) {
        await this.open();
        const grant = this.grants.get(permissionKeyDigest(key));
        if (grant?.key === key) {
            return grant.grantedAt;
        }
        const legacyGrant = await this.#readLegacyGrant(key);
        if (legacyGrant === null) {
            return null;
        }
        await this.recordGrant(key, legacyGrant);
        return legacyGrant;
    }

    async #readLegacyGrant(key) {
        if (!this.legacyRootDir) {
            return null;
        }
        let permission;
        try {
            permission = JSON.parse(key);
        }
        catch {
            return null;
        }
        if (!permission
            || typeof permission.name !== 'string'
            || typeof permission.scriptHash !== 'string'
            || typeof permission.capability !== 'string'
            || !['persistent', 'periodically'].includes(permission.policy)) {
            return null;
        }
        // The pre-broker V3 implementation keyed the durable allow bit by the
        // script digest and capability only. Its periodic timestamp used the
        // plugin name and capability (without the script digest). Preserve
        // those exact historical shapes so an upgrade does not unexpectedly
        // re-prompt every existing Node installation.
        const legacyAllowedKey = `${permission.scriptHash}_${permission.capability}`;
        const transitionalAllowedKey = `${permission.name}_${permission.scriptHash}_${permission.capability}`;
        const allowed = await this.#readLegacyValue(legacyAllowedKey)
            ?? await this.#readLegacyValue(transitionalAllowedKey);
        if (allowed?.value !== true) {
            return null;
        }
        if (permission.policy === 'periodically') {
            const legacyTimestampKey = `${permission.name}_${permission.capability}_lastGrantTime`;
            const transitionalTimestampKey = `${transitionalAllowedKey}_lastGrantTime`;
            const timestamp = await this.#readLegacyValue(legacyTimestampKey)
                ?? await this.#readLegacyValue(transitionalTimestampKey);
            return Number.isSafeInteger(timestamp?.value) && timestamp.value > 0
                ? timestamp.value
                : null;
        }
        return Math.max(1, Math.floor(allowed.mtimeMs));
    }

    async #readLegacyValue(logicalKey) {
        const innerKey = crypto.createHash('sha256').update(logicalKey, 'utf8').digest('hex');
        const storageKey = `plugin-permissions/${innerKey}`;
        const legacyPath = path.join(
            this.legacyRootDir,
            Buffer.from(storageKey, 'utf8').toString('hex'),
        );
        let encoded;
        let stat;
        try {
            [encoded, stat] = await Promise.all([
                fs.readFile(legacyPath, 'utf8'),
                fs.lstat(legacyPath),
            ]);
        }
        catch (error) {
            if (error?.code === 'ENOENT') {
                return null;
            }
            throw error;
        }
        if (!stat.isFile() || stat.isSymbolicLink()) {
            throw new RuntimePluginPermissionStoreError(
                'Legacy permission entry must be a regular file',
                'RUNTIME_PLUGIN_PERMISSION_STORE_UNSAFE_PATH',
            );
        }
        let stored;
        try {
            stored = JSON.parse(encoded);
        }
        catch {
            return null;
        }
        if (stored?.schemaVersion !== 1 || stored.key !== logicalKey || !('value' in stored)) {
            return null;
        }
        return { value: stored.value, mtimeMs: stat.mtimeMs };
    }

    async recordGrant(key, grantedAt) {
        if (!Number.isSafeInteger(grantedAt) || grantedAt <= 0) {
            throw new TypeError('grantedAt must be a positive safe integer');
        }
        await this.open();
        const digest = permissionKeyDigest(key);
        const operation = this.mutation.then(async () => {
            // Stage the new map separately. Readers must continue seeing the
            // previous durable snapshot until fsync+rename has succeeded.
            const nextGrants = new Map(this.grants);
            nextGrants.set(digest, { key, grantedAt });
            await this.#persist(nextGrants);
            this.grants = nextGrants;
            return grantedAt;
        });
        this.mutation = operation.catch(() => {});
        return await operation;
    }

    async #persist(sourceGrants) {
        const grants = {};
        for (const digest of [...sourceGrants.keys()].sort()) {
            grants[digest] = sourceGrants.get(digest);
        }
        const temporaryPath = path.join(
            this.rootDir,
            `.grants.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
        );
        let handle;
        try {
            handle = await fs.open(temporaryPath, 'wx', FILE_MODE);
            await handle.writeFile(`${JSON.stringify({
                schemaVersion: STORE_SCHEMA_VERSION,
                grants,
            })}\n`, 'utf8');
            await handle.sync();
            await handle.close();
            handle = null;
            await fs.rename(temporaryPath, this.filePath);
            await fs.chmod(this.filePath, FILE_MODE);
            await syncDirectory(this.rootDir);
        }
        catch (error) {
            await handle?.close().catch(() => {});
            await fs.unlink(temporaryPath).catch(() => {});
            throw error;
        }
    }
}

module.exports = {
    RuntimePluginPermissionStore,
    RuntimePluginPermissionStoreError,
    permissionKeyDigest,
};
