const { runProviderRequest, validateProviderRequest } = require('./providers/index.cjs');
const { applyPresetEditOutputRegex } = require('./outputMutators.cjs');

class GenerationRunner {
    constructor({ jobRepository, chatService, eventHub }) {
        this.jobRepository = jobRepository;
        this.chatService = chatService;
        this.eventHub = eventHub;
        this.activeJobs = new Map();
    }

    publishJobEvent(sessionKey, payload) {
        this.eventHub.publish(sessionKey, {
            type: 'job_updated',
            ...payload,
        });
    }

    async queue(job) {
        setImmediate(() => {
            this.run(job.job_id).catch((error) => {
                console.error('[GenerationRunner] job failed', job.job_id, error);
            });
        });
    }

    async cancel(jobId) {
        const active = this.activeJobs.get(jobId);
        if (active) {
            active.abortController.abort();
        }
    }

    async run(jobId) {
        const job = await this.jobRepository.getJob(jobId);
        if (!job) {
            return;
        }

        if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
            return;
        }

        const abortController = new AbortController();
        this.activeJobs.set(jobId, { abortController });

        await this.jobRepository.updateJobStatus(jobId, 'running', {
            startedAt: new Date(),
        });

        const startedEvent = await this.jobRepository.appendEvent(jobId, 'generation_started', {
            jobId,
        });
        await this.chatService.patchChatDocument({
            sessionKey: job.session_key,
            characterId: job.request_payload?.target?.characterId,
            chatId: job.request_payload?.target?.chatId,
            mutate: (chatPayload) => {
                chatPayload.isStreaming = true;
            },
            metadata: {
                activeJobId: jobId,
                lastJobId: jobId,
                lastJobStatus: 'running',
                lastJobError: null,
            },
        });
        this.publishJobEvent(job.session_key, {
            sessionKey: job.session_key,
            jobId,
            status: 'running',
            sequenceNo: startedEvent.sequence_no,
        });

        try {
            const requestPayload = job.request_payload ?? {};
            const provider = requestPayload.provider ?? {};
            const outputMutators = requestPayload.outputMutators ?? {};
            const target = requestPayload.target ?? {};
            const presetEditOutputRegex = Array.isArray(outputMutators.presetEditOutputRegex)
                ? outputMutators.presetEditOutputRegex
                : [];

            const providerError = validateProviderRequest(provider);
            if (providerError) {
                throw new Error(providerError);
            }

            const result = await runProviderRequest(provider, {
                abortSignal: abortController.signal,
                onText: async (textSnapshot) => {
                    const mutatedTextSnapshot = applyPresetEditOutputRegex(textSnapshot, presetEditOutputRegex);
                    const currentJob = await this.jobRepository.getJob(jobId);
                    if (currentJob?.cancel_requested_at) {
                        abortController.abort();
                        throw new Error('cancelled');
                    }

                    const chatUpdate = await this.chatService.patchChatDocument({
                        sessionKey: job.session_key,
                        characterId: target.characterId,
                        chatId: target.chatId,
                        mutate: (chatPayload) => {
                            const messages = this.chatService.constructor.ensureMessageArray(chatPayload);
                            chatPayload.isStreaming = true;
                            const message = messages.find((entry) => entry?.chatId === target.assistantMessageChatId);
                            if (message) {
                                message.data = mutatedTextSnapshot;
                            }
                        },
                        metadata: {
                            activeJobId: jobId,
                            lastJobId: jobId,
                            lastJobStatus: 'running',
                            lastJobError: null,
                        },
                    });

                    const eventRow = await this.jobRepository.appendEvent(jobId, 'text_snapshot', {
                        text: mutatedTextSnapshot,
                        chatRevision: chatUpdate.document?.revision ?? null,
                    });

                    this.publishJobEvent(job.session_key, {
                        sessionKey: job.session_key,
                        jobId,
                        status: 'running',
                        sequenceNo: eventRow.sequence_no,
                        text: mutatedTextSnapshot,
                    });
                },
            });
            const finalText = applyPresetEditOutputRegex(result.finalText, presetEditOutputRegex);

            const completedAt = new Date();
            await this.chatService.patchChatDocument({
                sessionKey: job.session_key,
                characterId: target.characterId,
                chatId: target.chatId,
                mutate: (chatPayload) => {
                    const messages = this.chatService.constructor.ensureMessageArray(chatPayload);
                    chatPayload.isStreaming = false;
                    const message = messages.find((entry) => entry?.chatId === target.assistantMessageChatId);
                    if (message) {
                        message.data = finalText;
                        message.generationInfo = {
                            ...(message.generationInfo ?? {}),
                            model: result.model ?? message.generationInfo?.model,
                        };
                    }
                },
                metadata: {
                    activeJobId: null,
                    lastCompletedJobId: jobId,
                    lastJobId: jobId,
                    lastJobStatus: 'completed',
                    lastJobError: null,
                },
            });

            const updatedJob = await this.jobRepository.updateJobStatus(jobId, 'completed', {
                finishedAt: completedAt,
                resultPayload: {
                    text: finalText,
                    model: result.model,
                },
                errorText: null,
            });

            const completedEvent = await this.jobRepository.appendEvent(jobId, 'generation_completed', {
                text: finalText,
                model: result.model,
            });

            this.publishJobEvent(job.session_key, {
                sessionKey: job.session_key,
                jobId,
                status: updatedJob?.status ?? 'completed',
                sequenceNo: completedEvent.sequence_no,
                text: finalText,
                model: result.model,
            });
        }
        catch (error) {
            const isCancelled = abortController.signal.aborted || `${error?.message ?? error}` === 'cancelled';
            const status = isCancelled ? 'cancelled' : 'failed';
            const finishedAt = new Date();

            await this.chatService.patchChatDocument({
                sessionKey: job.session_key,
                characterId: job.request_payload?.target?.characterId,
                chatId: job.request_payload?.target?.chatId,
                mutate: (chatPayload) => {
                    chatPayload.isStreaming = false;
                },
                metadata: {
                    activeJobId: null,
                    lastJobId: jobId,
                    lastJobStatus: status,
                    lastJobError: status === 'failed' ? `${error?.message ?? error}` : null,
                    ...(status === 'cancelled' ? { lastCancelledJobId: jobId } : {}),
                    ...(status === 'failed' ? { lastFailedJobId: jobId } : {}),
                },
            });

            const updatedJob = await this.jobRepository.updateJobStatus(jobId, status, {
                finishedAt,
                errorText: status === 'failed' ? `${error?.message ?? error}` : null,
                resultPayload: status === 'failed'
                    ? {
                        error: `${error?.message ?? error}`,
                    }
                    : null,
            });

            const eventType = status === 'cancelled' ? 'generation_cancelled' : 'generation_failed';
            const eventRow = await this.jobRepository.appendEvent(jobId, eventType, {
                error: status === 'failed' ? `${error?.message ?? error}` : null,
            });

            this.publishJobEvent(job.session_key, {
                sessionKey: job.session_key,
                jobId,
                status: updatedJob?.status ?? status,
                sequenceNo: eventRow.sequence_no,
                error: status === 'failed' ? `${error?.message ?? error}` : null,
            });
        }
        finally {
            this.activeJobs.delete(jobId);
        }
    }
}

module.exports = {
    GenerationRunner,
};
