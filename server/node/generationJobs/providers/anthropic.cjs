function decodeUint8Array(chunk) {
    return new TextDecoder().decode(chunk);
}

async function* iterateAnthropicSse(body, abortSignal) {
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

function appendAnthropicDelta(state, chunk) {
    if (chunk?.type !== 'content_block_delta') {
        return state;
    }

    if (chunk?.delta?.type === 'text' || chunk?.delta?.type === 'text_delta') {
        if (state.thinking) {
            state.text += '</Thoughts>\n\n';
            state.thinking = false;
        }
        state.text += chunk?.delta?.text ?? '';
    }

    if (chunk?.delta?.type === 'thinking' || chunk?.delta?.type === 'thinking_delta') {
        if (!state.thinking) {
            state.text += '<Thoughts>\n';
            state.thinking = true;
        }
        state.text += chunk?.delta?.thinking ?? '';
    }

    if (chunk?.delta?.type === 'redacted_thinking') {
        if (!state.thinking) {
            state.text += '<Thoughts>\n';
            state.thinking = true;
        }
        state.text += '\n{{redacted_thinking}}\n';
    }

    return state;
}

function finalizeAnthropicText(state) {
    if (state.thinking) {
        return `${state.text}</Thoughts>`;
    }
    return state.text;
}

function extractAnthropicPayloadText(payload) {
    const content = Array.isArray(payload?.content) ? payload.content : [];
    let text = '';
    let thinking = false;

    for (const item of content) {
        if (item?.type === 'text') {
            if (thinking) {
                text += '</Thoughts>\n\n';
                thinking = false;
            }
            text += item?.text ?? '';
        }

        if (item?.type === 'thinking') {
            if (!thinking) {
                text += '<Thoughts>\n';
                thinking = true;
            }
            text += item?.thinking ?? '';
        }

        if (item?.type === 'redacted_thinking') {
            if (!thinking) {
                text += '<Thoughts>\n';
                thinking = true;
            }
            text += '\n{{redacted_thinking}}\n';
        }
    }

    return thinking ? `${text}</Thoughts>` : text;
}

async function runAnthropicRequest(request, handlers) {
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

    if (!request.stream) {
        const payload = await response.json();
        const text = extractAnthropicPayloadText(payload);
        if (text) {
            await handlers.onText(text);
        }
        return {
            model: payload?.model ?? request.body?.model ?? null,
            raw: payload,
            finalText: text,
        };
    }

    if (!response.body) {
        throw new Error('Upstream stream body missing');
    }

    const state = {
        text: '',
        thinking: false,
    };

    for await (const chunk of iterateAnthropicSse(response.body, handlers.abortSignal)) {
        appendAnthropicDelta(state, chunk);
        await handlers.onText(finalizeAnthropicText(state), chunk);
    }

    return {
        model: request.body?.model ?? null,
        raw: null,
        finalText: finalizeAnthropicText(state),
    };
}

module.exports = {
    runAnthropicRequest,
};
