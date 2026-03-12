class DocumentRepository {
    constructor(pool) {
        this.pool = pool;
    }

    async getDocument(documentType, documentKey, client = this.pool) {
        const result = await client.query(
            `SELECT document_type, document_key, payload, metadata, revision, created_at, updated_at
             FROM risu_documents
             WHERE document_type = $1 AND document_key = $2`,
            [documentType, documentKey]
        );

        if (result.rowCount === 0) {
            return null;
        }

        return result.rows[0];
    }

    async listDocuments(documentType, client = this.pool) {
        const result = await client.query(
            `SELECT document_type, document_key, payload, metadata, revision, created_at, updated_at
             FROM risu_documents
             WHERE document_type = $1
             ORDER BY document_key ASC`,
            [documentType]
        );

        return result.rows;
    }

    async upsertDocument(documentType, documentKey, payload, metadata = {}, client = this.pool) {
        const result = await client.query(
            `INSERT INTO risu_documents (document_type, document_key, payload, metadata)
             VALUES ($1, $2, $3::jsonb, $4::jsonb)
             ON CONFLICT (document_type, document_key)
             DO UPDATE SET
                 payload = EXCLUDED.payload,
                 metadata = EXCLUDED.metadata,
                 revision = risu_documents.revision + 1,
                 updated_at = NOW()
             RETURNING document_type, document_key, payload, metadata, revision, created_at, updated_at`,
            [documentType, documentKey, JSON.stringify(payload ?? {}), JSON.stringify(metadata ?? {})]
        );

        return result.rows[0];
    }

    async compareAndSwapDocument(documentType, documentKey, expectedRevision, payload, metadata = {}, client = this.pool) {
        if (expectedRevision == null) {
            return {
                conflict: true,
                current: await this.getDocument(documentType, documentKey, client),
            };
        }

        const result = await client.query(
            `UPDATE risu_documents
             SET payload = $4::jsonb,
                 metadata = $5::jsonb,
                 revision = revision + 1,
                 updated_at = NOW()
             WHERE document_type = $1
               AND document_key = $2
               AND revision = $3
             RETURNING document_type, document_key, payload, metadata, revision, created_at, updated_at`,
            [documentType, documentKey, expectedRevision, JSON.stringify(payload ?? {}), JSON.stringify(metadata ?? {})]
        );

        if (result.rowCount === 0) {
            return {
                conflict: true,
                current: await this.getDocument(documentType, documentKey, client),
            };
        }

        return {
            conflict: false,
            document: result.rows[0],
        };
    }
}

module.exports = {
    DocumentRepository,
};
