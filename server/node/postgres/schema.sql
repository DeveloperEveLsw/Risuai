CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS risu_kv_entries (
    key TEXT PRIMARY KEY,
    value BYTEA NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_risu_kv_entries_updated_at
    ON risu_kv_entries (updated_at DESC);

CREATE TABLE IF NOT EXISTS risu_documents (
    id BIGSERIAL PRIMARY KEY,
    document_type TEXT NOT NULL,
    document_key TEXT NOT NULL,
    payload JSONB NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    revision BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (document_type, document_key)
);

CREATE INDEX IF NOT EXISTS idx_risu_documents_type_key
    ON risu_documents (document_type, document_key);

CREATE INDEX IF NOT EXISTS idx_risu_documents_payload
    ON risu_documents
    USING GIN (payload);

CREATE TABLE IF NOT EXISTS risu_assets (
    asset_id TEXT PRIMARY KEY,
    storage_key TEXT NOT NULL UNIQUE,
    mime_type TEXT,
    byte_size BIGINT NOT NULL DEFAULT 0,
    sha256 TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS risu_chat_sessions (
    session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_key TEXT NOT NULL UNIQUE,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS risu_generation_jobs (
    job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_key TEXT NOT NULL,
    device_id TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    result_payload JSONB,
    error_text TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    CONSTRAINT risu_generation_jobs_status_check
        CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_risu_generation_jobs_status
    ON risu_generation_jobs (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_risu_generation_jobs_session_key
    ON risu_generation_jobs (session_key, created_at DESC);

CREATE TABLE IF NOT EXISTS risu_generation_job_events (
    id BIGSERIAL PRIMARY KEY,
    job_id UUID NOT NULL REFERENCES risu_generation_jobs(job_id) ON DELETE CASCADE,
    sequence_no INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (job_id, sequence_no)
);

CREATE INDEX IF NOT EXISTS idx_risu_generation_job_events_job_id
    ON risu_generation_job_events (job_id, sequence_no);
