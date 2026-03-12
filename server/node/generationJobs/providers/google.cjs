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
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';

        for (const part of parts) {
            const lines = part
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean);

            for (const line of lines) {
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
    }
}

function serializeGoogleText(state) {
    if (!state.thoughts) {
        return state.content;
    }
    return `<Thoughts>\n\n${state.thoughts}\n\n</Thoughts>\n\n${state.content}`;
}

function applyGoogleParts(state, parts) {
    for (const part of parts) {
        if (typeof part?.text !== 'string' || part.text.length === 0) {
            continue;
        }

        if (part?.thought) {
            state.thoughts += part.text;
            continue;
        }

        state.content += part.text;
    }

    return state;
}

function extractGoogleParts(payload) {
    return payload?.candidates?.[0]?.content?.parts ?? [];
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
        const state = applyGoogleParts({ thoughts: '', content: '' }, extractGoogleParts(payload));
        const text = serializeGoogleText(state);
        if (text) {
            await handlers.onText(text);
        }
        return {
            model: payload?.modelVersion ?? null,
            raw: payload,
            finalText: text,
        };
    }

    if (!response.body) {
        throw new Error('Upstream stream body missing');
    }

    const state = {
        thoughts: '',
        content: '',
    };

    for await (const chunk of iterateGoogleSse(response.body, handlers.abortSignal)) {
        applyGoogleParts(state, extractGoogleParts(chunk));
        await handlers.onText(serializeGoogleText(state), chunk);
    }

    return {
        model: null,
        raw: null,
        finalText: serializeGoogleText(state),
    };
}

module.exports = {
    runGoogleRequest,
};
