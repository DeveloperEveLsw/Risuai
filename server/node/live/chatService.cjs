const { toChatDocumentKey } = require('./documentKeys.cjs');

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

class LiveChatService {
    constructor(documentRepository, eventPublisher) {
        this.documentRepository = documentRepository;
        this.eventPublisher = eventPublisher;
    }

    async ensureChatDocument({ sessionKey, characterId, chatId, chatSnapshot, metadata = {}, client }) {
        const documentKey = toChatDocumentKey(characterId, chatId);
        let document = await this.documentRepository.getDocument('chat', documentKey, client);

        if (!document) {
            document = await this.documentRepository.upsertDocument(
                'chat',
                documentKey,
                clone(chatSnapshot ?? { id: chatId, message: [] }),
                {
                    sessionKey,
                    characterId,
                    chatId,
                    ...metadata,
                },
                client
            );
        }

        return document;
    }

    async patchChatDocument({ sessionKey, characterId, chatId, expectedRevision, mutate, metadata = {}, client, publish = true }) {
        const documentKey = toChatDocumentKey(characterId, chatId);
        const current = await this.documentRepository.getDocument('chat', documentKey, client);
        if (!current) {
            return {
                conflict: true,
                current: null,
                documentKey,
            };
        }

        const nextPayload = clone(current.payload ?? {});
        mutate(nextPayload);

        const result = await this.documentRepository.compareAndSwapDocument(
            'chat',
            documentKey,
            expectedRevision ?? current.revision,
            nextPayload,
            {
                ...(current.metadata ?? {}),
                sessionKey,
                characterId,
                chatId,
                ...metadata,
            },
            client
        );

        if (result.conflict) {
            return {
                ...result,
                documentKey,
            };
        }

        if (publish) {
            this.publishChatUpdated(sessionKey, result.document);
        }
        return {
            conflict: false,
            document: result.document,
            documentKey,
        };
    }

    publishChatUpdated(sessionKey, document) {
        if (!this.eventPublisher || !document) {
            return;
        }

        this.eventPublisher.publish(sessionKey, {
            type: 'chat_updated',
            chatKey: document.document_key,
            revision: document.revision,
            payload: document.payload,
            metadata: document.metadata,
            updatedAt: document.updated_at,
        });
    }

    static ensureMessageArray(chatPayload) {
        if (!Array.isArray(chatPayload.message)) {
            chatPayload.message = [];
        }

        return chatPayload.message;
    }
}

module.exports = {
    LiveChatService,
};
