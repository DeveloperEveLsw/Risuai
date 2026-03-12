const path = require('path');
const { FileStorage } = require('./fileStorage.cjs');
const { PostgresStorage } = require('./postgresStorage.cjs');

function resolveStorageDriver() {
    const explicitDriver = (process.env.RISU_STORAGE_DRIVER || '').trim().toLowerCase();

    if (explicitDriver === 'postgres') {
        return 'postgres';
    }

    return 'file';
}

function createStorageBackend(options = {}) {
    const driver = resolveStorageDriver();

    if (driver === 'postgres') {
        const databaseUrl = process.env.RISU_DATABASE_URL || process.env.DATABASE_URL;
        if (!databaseUrl) {
            throw new Error('RISU_STORAGE_DRIVER=postgres requires RISU_DATABASE_URL or DATABASE_URL');
        }

        return new PostgresStorage({
            databaseUrl,
            schemaFilePath: path.join(process.cwd(), 'server/node/postgres/schema.sql'),
        });
    }

    return new FileStorage({
        savePath: options.savePath,
    });
}

module.exports = {
    createStorageBackend,
};
