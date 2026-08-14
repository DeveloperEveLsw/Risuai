'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const {
    RuntimePluginPermissionStore,
    RuntimePluginPermissionStoreError,
} = require('./permissionStore.cjs');

const roots = new Set();

afterEach(async () => {
    await Promise.all([...roots].map((root) => fs.rm(root, { recursive: true, force: true })));
    roots.clear();
});

async function fixture() {
    const temporaryRoot = process.platform === 'linux' ? '/tmp' : os.tmpdir();
    const root = await fs.mkdtemp(path.join(temporaryRoot, 'risu-permissions-'));
    roots.add(root);
    const store = new RuntimePluginPermissionStore({ rootDir: path.join(root, 'store') });
    await store.open();
    return { root, store, storeDir: path.join(root, 'store') };
}

function mode(stat) {
    return stat.mode & 0o777;
}

test('durably stores only exact grants with private filesystem modes', async () => {
    const { store, storeDir } = await fixture();
    const key = JSON.stringify({
        name: 'fixture',
        scriptHash: 'a'.repeat(64),
        capability: 'db',
        policy: 'periodically',
    });

    await store.recordGrant(key, 123_456);
    const reopened = new RuntimePluginPermissionStore({ rootDir: storeDir });
    assert.equal(await reopened.getGrant(key), 123_456);
    assert.equal(await reopened.getGrant(`${key} `), null);
    assert.equal(mode(await fs.stat(storeDir)), 0o700);
    assert.equal(mode(await fs.stat(path.join(storeDir, 'grants.json'))), 0o600);

    const persisted = await fs.readFile(path.join(storeDir, 'grants.json'), 'utf8');
    assert.doesNotMatch(persisted, /Enter provider key|"yes"|"no"/);
});

test('serializes concurrent updates without losing either grant', async () => {
    const { store, storeDir } = await fixture();
    await Promise.all([
        store.recordGrant('permission-a', 100),
        store.recordGrant('permission-b', 200),
    ]);

    const reopened = new RuntimePluginPermissionStore({ rootDir: storeDir });
    assert.equal(await reopened.getGrant('permission-a'), 100);
    assert.equal(await reopened.getGrant('permission-b'), 200);
});

test('fails closed when a persisted permission document is corrupt', async () => {
    const { storeDir } = await fixture();
    await fs.writeFile(path.join(storeDir, 'grants.json'), '{broken', { mode: 0o600 });
    const reopened = new RuntimePluginPermissionStore({ rootDir: storeDir });

    await assert.rejects(
        reopened.getGrant('permission-a'),
        (error) => error instanceof RuntimePluginPermissionStoreError
            && error.code === 'RUNTIME_PLUGIN_PERMISSION_STORE_CORRUPT',
    );
});

test('migrates an exact legacy NodeJson grant without prompting again', async () => {
    const temporaryRoot = process.platform === 'linux' ? '/tmp' : os.tmpdir();
    const root = await fs.mkdtemp(path.join(temporaryRoot, 'risu-permissions-legacy-'));
    roots.add(root);
    const permission = {
        name: 'legacy_plugin',
        scriptHash: 'b'.repeat(64),
        capability: 'provider',
        policy: 'periodically',
    };
    const key = JSON.stringify(permission);
    const legacyAllowedKey = `${permission.scriptHash}_${permission.capability}`;
    const legacyTimestampKey = `${permission.name}_${permission.capability}_lastGrantTime`;
    const writeLegacy = async (logicalKey, value) => {
        const digest = crypto.createHash('sha256').update(logicalKey).digest('hex');
        const storageKey = `plugin-permissions/${digest}`;
        await fs.writeFile(
            path.join(root, Buffer.from(storageKey).toString('hex')),
            JSON.stringify({ schemaVersion: 1, key: logicalKey, value }),
            { mode: 0o600 },
        );
    };
    await writeLegacy(legacyAllowedKey, true);
    await writeLegacy(legacyTimestampKey, 654_321);

    const storeDir = path.join(root, '__runtime_plugin_permissions');
    const store = new RuntimePluginPermissionStore({
        rootDir: storeDir,
        legacyRootDir: root,
    });
    assert.equal(await store.getGrant(key), 654_321);

    await Promise.all([
        ...await fs.readdir(root),
    ].filter((entry) => entry !== '__runtime_plugin_permissions')
        .map((entry) => fs.unlink(path.join(root, entry))));
    const reopened = new RuntimePluginPermissionStore({ rootDir: storeDir });
    assert.equal(await reopened.getGrant(key), 654_321);
});
