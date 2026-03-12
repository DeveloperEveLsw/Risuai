function decodeUint8Array(chunk) {
    return new TextDecoder().decode(chunk);
}

async function* iterateGoogleSse(body, abortSignal) {
    const reader = body.getReader();
    let buffer = '';

    while (true) {
        if (abortSignal?.aborted) {
            throw new Error('aborted');
        }

        const { value, done } = await reader.read();
        if (done) {
            break;
        }

        buffer += decodeUint8Array(value);
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line.startsWith('data:')) {
                continue;
            }

            const payloadText = line.slice(5).trim();
            if (!payloadText || payloadText === '[DONE]') {
                continue;
            }

            let parsed;
            try {
                parsed = JSON.parse(payloadText);
            }
            catch (_error) {
                continue;
            }

            yield parsed;
        }
    }

    const tail = buffer.trim();
    if (!tail.startsWith('data:')) {
        return;
    }

    const payloadText = tail.slice(5).trim();
    if (!payloadText || payloadText === '[DONE]') {
        return;
    }

    try {
        yield JSON.parse(payloadText);
    }
    catch (_error) {
        return;
    }
}

function initGoogleStreamState(state = {}) {
    return {
        thoughts: state.thoughts || '',
        lastThought: state.lastThought || '',
        content: state.content || '',
        toolCalls: Array.isArray(state.toolCalls) ? state.toolCalls : [],
        signText: state.signText || '',
        signFunction: state.signFunction || '',
        usageMetadata: state.usageMetadata || null,
        modelStatus: state.modelStatus || null,
    };
}

function appendGoogleParts(state, parts) {
    for (const part of parts ?? []) {
        if (typeof part?.text === 'string' && part.text.length > 0) {
            state.thoughts += state.lastThought;
            state.lastThought = '';

            if (part.thought) {
                state.lastThought = part.text;
            }
            else {
                state.content += part.text;
            }

            if (part.thoughtSignature) {
                state.signText = part.thoughtSignature;
            }
        }

        if (part?.functionCall) {
            state.toolCalls.push(part.functionCall);
            if (part?.thoughtSignature) {
                state.signFunction = part.thoughtSignature;
            }
        }
    }

    return state;
}

function applyGoogleChunk(state, payload) {
    const parts = payload?.candidates?.[0]?.content?.parts ?? [];
    appendGoogleParts(state, parts);

    if (payload?.usageMetadata) {
        state.usageMetadata = payload.usageMetadata;
    }
    if (payload?.modelStatus) {
        state.modelStatus = payload.modelStatus;
    }

    return state;
}

function serializeGoogleStreamState(state, options = {}) {
    const prefix = options.prefix ? `${options.prefix}\n\n` : '';
    const thoughts = state.thoughts || '';
    const lastThought = state.lastThought || '';
    const content = state.content || '';

    if (options.streamGeminiThoughts) {
        return prefix
            + (thoughts ? `<Thoughts>\n\n${thoughts}\n\n</Thoughts>\n\n` : '')
            + (lastThought ? `${lastThought}\n\n` : '')
            + content;
    }

    return prefix
        + (thoughts + lastThought ? `<Thoughts>\n\n${thoughts + lastThought}\n\n</Thoughts>\n\n` : '')
        + content;
}

function processGoogleTextResponse(items) {
    const thoughts = items.filter((item) => item?.thought).map((item) => item.text).join('\n\n');
    const content = items.filter((item) => !item?.thought).map((item) => item.text).join('\n\n');
    return (thoughts ? `<Thoughts>\n\n${thoughts}\n\n</Thoughts>\n\n` : '') + content;
}

function collectGoogleTextItems(payload, items) {
    const parts = payload?.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
        if (typeof part?.text === 'string' && part.text.length > 0) {
            items.push({
                text: part.text,
                thought: !!part.thought,
            });
        }
    }
    return items;
}

function extractGoogleModel(payload, request) {
    return payload?.modelVersion ?? payload?.model ?? request?.body?.model ?? null;
}

function isGoogleStreamingRequest(request) {
    if (request?.stream === true) {
        return true;
    }

    const url = (request?.url ?? '').toLowerCase();
    return url.includes('alt=sse') || url.includes(':streamgeneratecontent');
}

async function runGoogleRequest(request, handlers) {
    const response = await fetch(request.url, {
        method: request.method ?? 'POST',
        headers: request.headers ?? {},
        body: request.body == null ? undefined : JSON.stringify(request.body),
        signal: handlers.abortSignal,
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || `Upstream error ${response.status}`);
    }

    if (!isGoogleStreamingRequest(request)) {
        const payload = await response.json();
        const payloads = Array.isArray(payload) ? payload : [payload];
        const items = payloads.flatMap((entry) => collectGoogleTextItems(entry, []));
        const text = processGoogleTextResponse(items);
        if (text) {
            await handlers.onText(text);
        }
        const lastPayload = payloads[payloads.length - 1] ?? payload;
        return {
            model: extractGoogleModel(lastPayload, request),
            raw: payload,
            finalText: text,
        };
    }

    if (!response.body) {
        throw new Error('Upstream stream body missing');
    }

    const state = initGoogleStreamState();
    const streamOptions = request?.streamOptions ?? {};

    for await (const chunk of iterateGoogleSse(response.body, handlers.abortSignal)) {
        applyGoogleChunk(state, chunk);
        await handlers.onText(serializeGoogleStreamState(state, streamOptions), chunk);
    }

    return {
        model: null,
        raw: null,
        finalText: serializeGoogleStreamState(state, streamOptions),
    };
}

module.exports = {
    runGoogleRequest,
};
