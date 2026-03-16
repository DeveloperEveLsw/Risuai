const path = require('path')
const { existsSync } = require('fs')
const fs = require('fs/promises')
const { createHash } = require('crypto')
const { Pool } = require('pg')
const {
    createStructuredTableRefs,
    ensureStructuredDatabase,
    importStructuredDatabase,
    exportStructuredDatabase
} = require('./structuredDatabase.cjs')

const HEX_REGEX = /^[0-9a-f]+$/i
const IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/

function assertIdentifier(value, label) {
    if (!IDENTIFIER_REGEX.test(value)) {
        throw new Error(`Invalid ${label}: ${value}`)
    }
    return `"${value}"`
}

function sha256(content) {
    return createHash('sha256').update(content).digest('hex')
}

function getStorageGroup(key) {
    if (key.startsWith('database/')) {
        return 'database'
    }
    if (key.startsWith('assets/')) {
        return 'asset'
    }
    if (key.startsWith('temp/')) {
        return 'temp'
    }
    return 'misc'
}

class PostgresStorage {
    constructor({
        connectionString,
        schema = 'public',
        entriesTable = 'risu_storage_entries',
        metadataTable = 'risu_storage_metadata',
        legacySavePath,
        importLegacySave = true,
        ssl
    }) {
        if (!connectionString) {
            throw new Error('DATABASE_URL is required when RISU_STORAGE_DRIVER=postgres')
        }

        this.schemaName = assertIdentifier(schema, 'schema')
        this.entriesTableName = assertIdentifier(entriesTable, 'entries table')
        this.metadataTableName = assertIdentifier(metadataTable, 'metadata table')
        this.entriesTableRef = `${this.schemaName}.${this.entriesTableName}`
        this.metadataTableRef = `${this.schemaName}.${this.metadataTableName}`
        this.structuredRefs = createStructuredTableRefs(this.schemaName)
        this.legacySavePath = legacySavePath
        this.importLegacySave = importLegacySave
        this.pool = new Pool({
            connectionString,
            ssl
        })
    }

    async init() {
        await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.schemaName}`)
        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS ${this.entriesTableRef} (
                storage_key TEXT PRIMARY KEY,
                storage_group TEXT NOT NULL,
                mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
                sha256 TEXT NOT NULL,
                content BYTEA NOT NULL,
                size_bytes BIGINT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `)
        await this.pool.query(`
            CREATE INDEX IF NOT EXISTS risu_storage_entries_group_idx
            ON ${this.entriesTableRef} (storage_group, updated_at DESC)
        `)
        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS ${this.metadataTableRef} (
                meta_key TEXT PRIMARY KEY,
                meta_value TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `)
        await ensureStructuredDatabase(this.pool, this.structuredRefs)

        if (this.importLegacySave) {
            await this.importLegacySaveDirectory()
        }
    }

    async readBuffer(key) {
        const result = await this.pool.query(
            `SELECT content FROM ${this.entriesTableRef} WHERE storage_key = $1`,
            [key]
        )
        return result.rows[0]?.content ?? null
    }

    async writeBuffer(key, value) {
        const content = Buffer.isBuffer(value) ? value : Buffer.from(value)
        await this.pool.query(
            `
                INSERT INTO ${this.entriesTableRef} (
                    storage_key,
                    storage_group,
                    mime_type,
                    sha256,
                    content,
                    size_bytes,
                    updated_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, NOW())
                ON CONFLICT (storage_key)
                DO UPDATE SET
                    storage_group = EXCLUDED.storage_group,
                    mime_type = EXCLUDED.mime_type,
                    sha256 = EXCLUDED.sha256,
                    content = EXCLUDED.content,
                    size_bytes = EXCLUDED.size_bytes,
                    updated_at = NOW()
            `,
            [
                key,
                getStorageGroup(key),
                'application/octet-stream',
                sha256(content),
                content,
                content.length
            ]
        )
    }

    async deleteKey(key) {
        await this.pool.query(
            `DELETE FROM ${this.entriesTableRef} WHERE storage_key = $1`,
            [key]
        )
    }

    async listKeys() {
        const result = await this.pool.query(
            `SELECT storage_key FROM ${this.entriesTableRef} ORDER BY storage_key ASC`
        )
        return result.rows.map((row) => row.storage_key)
    }

    async getSecret(name) {
        const result = await this.pool.query(
            `SELECT meta_value FROM ${this.metadataTableRef} WHERE meta_key = $1`,
            [`secret:${name}`]
        )
        return result.rows[0]?.meta_value ?? ''
    }

    async setSecret(name, value) {
        await this.pool.query(
            `
                INSERT INTO ${this.metadataTableRef} (meta_key, meta_value, updated_at)
                VALUES ($1, $2, NOW())
                ON CONFLICT (meta_key)
                DO UPDATE SET
                    meta_value = EXCLUDED.meta_value,
                    updated_at = NOW()
            `,
            [`secret:${name}`, value]
        )
    }

    async getMetadata(name) {
        const result = await this.pool.query(
            `SELECT meta_value FROM ${this.metadataTableRef} WHERE meta_key = $1`,
            [name]
        )
        return result.rows[0]?.meta_value ?? ''
    }

    async setMetadata(name, value) {
        await this.pool.query(
            `
                INSERT INTO ${this.metadataTableRef} (meta_key, meta_value, updated_at)
                VALUES ($1, $2, NOW())
                ON CONFLICT (meta_key)
                DO UPDATE SET
                    meta_value = EXCLUDED.meta_value,
                    updated_at = NOW()
            `,
            [name, value]
        )
    }

    async importStructuredDatabase(database) {
        await importStructuredDatabase(this.pool, this.structuredRefs, database)
    }

    async exportStructuredDatabase() {
        return await exportStructuredDatabase(this.pool, this.structuredRefs)
    }

    async importLegacySaveDirectory() {
        const imported = await this.getMetadata('system:legacy_save_import_completed')
        if (imported === 'true') {
            return
        }

        if (!this.legacySavePath || !existsSync(this.legacySavePath)) {
            await this.setMetadata('system:legacy_save_import_completed', 'true')
            return
        }

        const entries = await fs.readdir(this.legacySavePath, { withFileTypes: true })
        for (const entry of entries) {
            if (!entry.isFile()) {
                continue
            }

            const fullPath = path.join(this.legacySavePath, entry.name)
            if (entry.name === '__password') {
                await this.setSecret('password', await fs.readFile(fullPath, 'utf-8'))
                continue
            }

            if (entry.name === '__authcode') {
                await this.setSecret('authcode', await fs.readFile(fullPath, 'utf-8'))
                continue
            }

            if (!HEX_REGEX.test(entry.name)) {
                continue
            }

            const storageKey = Buffer.from(entry.name, 'hex').toString('utf-8')
            if (!storageKey) {
                continue
            }

            await this.writeBuffer(storageKey, await fs.readFile(fullPath))
        }

        await this.setMetadata('system:legacy_save_import_completed', 'true')
    }

    async close() {
        await this.pool.end()
    }
}

module.exports = {
    PostgresStorage
}
