const path = require('path')
const { FileStorage } = require('./fileStorage.cjs')
const { PostgresStorage } = require('./postgresStorage.cjs')

function readBool(name, defaultValue) {
    const value = process.env[name]
    if (value === undefined) {
        return defaultValue
    }
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

function createStorage() {
    const driver = (process.env.RISU_STORAGE_DRIVER || (process.env.DATABASE_URL ? 'postgres' : 'fs')).toLowerCase()
    const legacySavePath = path.join(process.cwd(), 'save')

    if (driver === 'postgres') {
        return {
            driver,
            storage: new PostgresStorage({
                connectionString: process.env.DATABASE_URL,
                schema: process.env.RISU_DB_SCHEMA || 'public',
                legacySavePath,
                importLegacySave: readBool('RISU_STORAGE_IMPORT_FROM_SAVE', true),
                ssl: readBool('DATABASE_SSL', false)
                    ? { rejectUnauthorized: readBool('DATABASE_SSL_REJECT_UNAUTHORIZED', true) }
                    : undefined
            })
        }
    }

    return {
        driver: 'fs',
        storage: new FileStorage({
            savePath: legacySavePath
        })
    }
}

module.exports = {
    createStorage
}
