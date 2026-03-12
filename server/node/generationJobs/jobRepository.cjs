class GenerationJobRepository {
    constructor(pool) {
        this.pool = pool;
    }

    async createJob(input, client = this.pool) {
        const result = await client.query(
            `INSERT INTO risu_generation_jobs (
                session_key,
                account_id,
                device_id,
                character_id,
                chat_document_key,
                assistant_message_chat_id,
                client_request_id,
                status,
                request_payload_version,
                request_payload,
                result_payload,
                error_text
            )
            VALUES (
                $1, $2, $3, $4, $5, $6, $7,
                COALESCE($8, 'queued'),
                COALESCE($9, 1),
                $10::jsonb,
                $11::jsonb,
                $12
            )
            ON CONFLICT (session_key, client_request_id)
            WHERE client_request_id IS NOT NULL
            DO UPDATE SET updated_at = NOW()
            RETURNING *`,
            [
                input.sessionKey,
                input.accountId ?? null,
                input.deviceId ?? null,
                input.characterId ?? null,
                input.chatDocumentKey ?? null,
                input.assistantMessageChatId ?? null,
                input.clientRequestId ?? null,
                input.status ?? 'queued',
                input.requestPayloadVersion ?? 1,
                JSON.stringify(input.requestPayload ?? {}),
                JSON.stringify(input.resultPayload ?? null),
                input.errorText ?? null,
            ]
        );

        return result.rows[0];
    }

    async getJob(jobId, client = this.pool) {
        const result = await client.query(
            'SELECT * FROM risu_generation_jobs WHERE job_id = $1',
            [jobId]
        );

        return result.rows[0] ?? null;
    }

    async getJobByClientRequest(sessionKey, clientRequestId, client = this.pool) {
        if (!clientRequestId) {
            return null;
        }

        const result = await client.query(
            `SELECT *
             FROM risu_generation_jobs
             WHERE session_key = $1
               AND client_request_id = $2`,
            [sessionKey, clientRequestId]
        );

        return result.rows[0] ?? null;
    }

    async listJobsByStatus(sessionKey, statuses, client = this.pool) {
        const result = await client.query(
            `SELECT *
             FROM risu_generation_jobs
             WHERE session_key = $1
               AND status = ANY($2::text[])
             ORDER BY created_at DESC`,
            [sessionKey, statuses]
        );

        return result.rows;
    }

    async updateJobStatus(jobId, status, patch = {}, client = this.pool) {
        const fields = [
            ['status', status],
            ['result_payload', patch.resultPayload == null ? null : JSON.stringify(patch.resultPayload)],
            ['error_text', patch.errorText ?? null],
            ['started_at', patch.startedAt ?? null],
            ['finished_at', patch.finishedAt ?? null],
            ['cancel_requested_at', patch.cancelRequestedAt ?? null],
        ];

        const result = await client.query(
            `UPDATE risu_generation_jobs
             SET status = $2,
                 result_payload = COALESCE($3::jsonb, result_payload),
                 error_text = $4,
                 started_at = COALESCE($5, started_at),
                 finished_at = COALESCE($6, finished_at),
                 cancel_requested_at = COALESCE($7, cancel_requested_at),
                 updated_at = NOW()
             WHERE job_id = $1
             RETURNING *`,
            [jobId, status, fields[1][1], fields[2][1], fields[3][1], fields[4][1], fields[5][1]]
        );

        return result.rows[0] ?? null;
    }

    async requestCancel(jobId, client = this.pool) {
        const result = await client.query(
            `UPDATE risu_generation_jobs
             SET cancel_requested_at = NOW(),
                 updated_at = NOW(),
                 status = CASE
                     WHEN status IN ('queued', 'running') THEN status
                     ELSE status
                 END
             WHERE job_id = $1
             RETURNING *`,
            [jobId]
        );

        return result.rows[0] ?? null;
    }

    async appendEvent(jobId, eventType, payload = {}, client = this.pool) {
        const sequenceResult = await client.query(
            `SELECT COALESCE(MAX(sequence_no), 0) + 1 AS next_sequence
             FROM risu_generation_job_events
             WHERE job_id = $1`,
            [jobId]
        );

        const sequenceNo = sequenceResult.rows[0].next_sequence;
        const result = await client.query(
            `INSERT INTO risu_generation_job_events (job_id, sequence_no, event_type, payload)
             VALUES ($1, $2, $3, $4::jsonb)
             RETURNING *`,
            [jobId, sequenceNo, eventType, JSON.stringify(payload ?? {})]
        );

        return result.rows[0];
    }

    async listEvents(jobId, afterSequence = 0, client = this.pool) {
        const result = await client.query(
            `SELECT *
             FROM risu_generation_job_events
             WHERE job_id = $1
               AND sequence_no > $2
             ORDER BY sequence_no ASC`,
            [jobId, afterSequence]
        );

        return result.rows;
    }
}

module.exports = {
    GenerationJobRepository,
};
