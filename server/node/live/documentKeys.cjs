function toCharacterDocumentKey(characterId) {
    return `character:${characterId}`;
}

function toChatDocumentKey(characterId, chatId) {
    return `chat:${characterId}:${chatId}`;
}

module.exports = {
    toCharacterDocumentKey,
    toChatDocumentKey,
};
