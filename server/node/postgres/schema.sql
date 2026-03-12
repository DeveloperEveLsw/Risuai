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
    account_id TEXT,
    device_id TEXT,
    character_id TEXT,
    chat_document_key TEXT,
    assistant_message_chat_id TEXT,
    client_request_id TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    request_payload_version INTEGER NOT NULL DEFAULT 1,
    request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    result_payload JSONB,
    error_text TEXT,
    cancel_requested_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    CONSTRAINT risu_generation_jobs_status_check
        CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled'))
);

ALTER TABLE risu_generation_jobs
    ADD COLUMN IF NOT EXISTS account_id TEXT,
    ADD COLUMN IF NOT EXISTS device_id TEXT,
    ADD COLUMN IF NOT EXISTS character_id TEXT,
    ADD COLUMN IF NOT EXISTS chat_document_key TEXT,
    ADD COLUMN IF NOT EXISTS assistant_message_chat_id TEXT,
    ADD COLUMN IF NOT EXISTS client_request_id TEXT,
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'queued',
    ADD COLUMN IF NOT EXISTS request_payload_version INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS result_payload JSONB,
    ADD COLUMN IF NOT EXISTS error_text TEXT,
    ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_risu_generation_jobs_status
    ON risu_generation_jobs (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_risu_generation_jobs_session_key
    ON risu_generation_jobs (session_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_risu_generation_jobs_account_id
    ON risu_generation_jobs (account_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_risu_generation_jobs_client_request
    ON risu_generation_jobs (session_key, client_request_id)
    WHERE client_request_id IS NOT NULL;

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
