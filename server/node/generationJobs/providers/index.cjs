const { runAnthropicRequest } = require('./anthropic.cjs');
const { runGoogleRequest } = require('./google.cjs');
const { runOpenAiCompatibleRequest } = require('./openaiCompatible.cjs');

const SERVER_SUPPORTED_PROVIDER_TYPES = new Set([
    'openai-compatible',
    'anthropic',
    'google',
]);

function hasToolUse(body = {}) {
    if (Array.isArray(body?.tools) && body.tools.length > 0) {
        return true;
    }

    if (Array.isArray(body?.messages) && body.messages.some((message) => {
        return message?.role === 'tool' || (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0);
    })) {
        return true;
    }

    if (Array.isArray(body?.input) && body.input.some((item) => item?.type === 'function_call_output')) {
        return true;
    }

    if (Array.isArray(body?.contents) && body.contents.some((entry) => {
        return Array.isArray(entry?.parts) && entry.parts.some((part) => part?.functionCall || part?.functionResponse);
    })) {
        return true;
    }

    if (Array.isArray(body?.tools?.functionDeclarations) && body.tools.functionDeclarations.length > 0) {
        return true;
    }

    return false;
}

function validateProviderRequest(provider) {
    if (!provider?.type || !SERVER_SUPPORTED_PROVIDER_TYPES.has(provider.type)) {
        return `Unsupported provider type: ${provider?.type ?? 'unknown'}`;
    }

    if (!provider?.request?.url) {
        return 'Provider request.url is required';
    }

    if (hasToolUse(provider.request.body ?? {})) {
        return 'Server-owned generation does not support tool-calling requests yet.';
    }

    return null;
}

async function runProviderRequest(provider, handlers) {
    switch (provider.type) {
        case 'openai-compatible':
            return runOpenAiCompatibleRequest(provider.request ?? {}, handlers);
        case 'anthropic':
            return runAnthropicRequest(provider.request ?? {}, handlers);
        case 'google':
            return runGoogleRequest(provider.request ?? {}, handlers);
        default:
            throw new Error(`Unsupported provider type: ${provider.type}`);
    }
}

module.exports = {
    SERVER_SUPPORTED_PROVIDER_TYPES,
    validateProviderRequest,
    runProviderRequest,
};
