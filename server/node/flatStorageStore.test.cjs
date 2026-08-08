const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const { FlatStorageStore } = require('./flatStorageStore.cjs');

const directories = new Set();
afterEach(async () => {
    await Promise.all([...directories].map((entry) => fsp.rm(entry, { recursive: true, force: true })));
    directories.clear();
});

async function fixture(options = {}) {
    const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'risu-flat-store-'));
    directories.add(rootDir);
    const store = new FlatStorageStore({
        rootDir,
        maxBytes: options.maxBytes ?? 16,
        minFreeBytes: options.minFreeBytes ?? 2,
        statfs: options.statfs ?? (async () => ({ bavail: 1000n, bsize: 4096n })),
    });
    await store.open();
    return { rootDir, store };
}

test('flat asset writes are atomic, quota-aware, and account for replacement bytes', async () => {
    const { rootDir, store } = await fixture();
    await store.write('aa', Buffer.from('12345678'));
    await store.write('aa', Buffer.from('1234'));
    await store.write('bb', Buffer.from('abcdefgh'));
    assert.equal(await store.usage(), 12);
    assert.equal(await fsp.readFile(path.join(rootDir, 'aa'), 'utf8'), '1234');
    await assert.rejects(store.write('cc', Buffer.from('12345')), {
        code: 'SAVE_STORAGE_QUOTA_EXCEEDED',
    });
    assert.equal(await fsp.stat(path.join(rootDir, 'cc')).catch(() => null), null);
});

test('flat asset writes preserve a filesystem free-space reserve', async () => {
    const { store } = await fixture({
        maxBytes: 100,
        minFreeBytes: 8,
        statfs: async () => ({ bavail: 10n, bsize: 1n }),
    });
    await assert.rejects(store.write('aa', Buffer.from('1234')), {
        code: 'SAVE_STORAGE_QUOTA_EXCEEDED',
    });
});
