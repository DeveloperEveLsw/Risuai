const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

class PostgresStorage {
    constructor(options = {}) {
        this.databaseUrl = options.databaseUrl;
        this.schemaFilePath = options.schemaFilePath;
        this.pool = new Pool({
            connectionString: this.databaseUrl,
        });
    }

    get type() {
        return 'postgres';
    }

    async initialize() {
        const schemaSql = fs.readFileSync(this.schemaFilePath, 'utf-8');
        await this.pool.query(schemaSql);
    }

    async getItem(key) {
        const result = await this.pool.query(
            'SELECT value FROM risu_kv_entries WHERE key = $1',
            [key]
        );
        if (result.rowCount === 0) {
            return null;
        }
        return result.rows[0].value;
    }

    async setItem(key, value) {
        await this.pool.query(
            `INSERT INTO risu_kv_entries (key, value)
             VALUES ($1, $2)
             ON CONFLICT (key)
             DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
            [key, value]
        );
    }

    async removeItem(key) {
        await this.pool.query(
            'DELETE FROM risu_kv_entries WHERE key = $1',
            [key]
        );
    }

    async keys() {
        const result = await this.pool.query(
            'SELECT key FROM risu_kv_entries ORDER BY key ASC'
        );
        return result.rows.map((row) => row.key);
    }

    async close() {
        await this.pool.end();
    }
}

module.exports = {
    PostgresStorage,
};
