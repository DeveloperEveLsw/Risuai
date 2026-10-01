const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const { FlatStorageStore } = require('../server/node/flatStorageStore.cjs');

function positiveIntegerEnvironment(name, fallback) {
    const value = process.env[name];
    if (value === undefined || value === '') {
        return fallback;
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new TypeError(`${name} must be a positive safe integer`);
    }
    return parsed;
}

async function seedFiles(rootDir, count, bytes) {
    const batchSize = 64;
    for (let start = 0; start < count; start += batchSize) {
        const batch = [];
        for (let index = start; index < Math.min(count, start + batchSize); index += 1) {
            batch.push(fsp.writeFile(
                path.join(rootDir, index.toString(16).padStart(16, '0')),
                Buffer.alloc(bytes, index % 251),
            ));
        }
        await Promise.all(batch);
    }
}

async function main() {
    const existingFiles = positiveIntegerEnvironment('RISU_BENCH_EXISTING_FILES', 500);
    const writes = positiveIntegerEnvironment('RISU_BENCH_WRITES', 5);
    const bytesPerFile = positiveIntegerEnvironment('RISU_BENCH_BYTES', 128);
    const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'risu-flat-storage-bench-'));

    try {
        await seedFiles(rootDir, existingFiles, bytesPerFile);
        const maxBytes = (existingFiles + writes + 1024) * bytesPerFile;
        const store = new FlatStorageStore({
            rootDir,
            maxBytes,
            minFreeBytes: 0,
        });
        let usageScans = 0;
        const scanUsageFromDisk = store.scanUsageFromDisk.bind(store);
        store.scanUsageFromDisk = async () => {
            usageScans += 1;
            return await scanUsageFromDisk();
        };

        const openStarted = performance.now();
        await store.open();
        const openScanMs = performance.now() - openStarted;
        const scanCountAfterOpen = usageScans;

        const samplesMs = [];
        for (let index = 0; index < writes; index += 1) {
            const started = performance.now();
            await store.write(
                (existingFiles + index).toString(16).padStart(16, '0'),
                Buffer.alloc(bytesPerFile, (index + 17) % 251),
            );
            samplesMs.push(performance.now() - started);
        }

        const hotWriteTotalMs = samplesMs.reduce((sum, value) => sum + value, 0);
        process.stdout.write(`${JSON.stringify({
            platform: `${process.platform}/${process.arch}`,
            node: process.version,
            existingFiles,
            writes,
            bytesPerFile,
            openScanMs: Number(openScanMs.toFixed(1)),
            hotWriteTotalMs: Number(hotWriteTotalMs.toFixed(1)),
            hotWriteMeanMs: Number((hotWriteTotalMs / writes).toFixed(1)),
            usageScansDuringOpen: scanCountAfterOpen,
            usageScansDuringHotWrites: usageScans - scanCountAfterOpen,
            samplesMs: samplesMs.map((value) => Number(value.toFixed(1))),
        })}\n`);
    }
    finally {
        await fsp.rm(rootDir, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
