function decodeUint8Array(chunk) {
    return new TextDecoder().decode(chunk);
}

async function* iterateOpenAiSse(body, abortSignal) {
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
                if (payloadText === '[DONE]') {
                    return;
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

function extractTextFromChunk(chunk) {
    const choices = Array.isArray(chunk?.choices) ? chunk.choices : [];
    const choice = choices[0];
    if (!choice) {
        if (chunk?.type === 'response.output_text.delta' && typeof chunk?.delta === 'string') {
            return chunk.delta;
        }
        if (chunk?.type === 'response.output_text.done' && typeof chunk?.text === 'string') {
            return chunk.text;
        }
        return '';
    }

    if (typeof choice?.delta?.content === 'string') {
        return choice.delta.content;
    }

    if (Array.isArray(choice?.delta?.content)) {
        return choice.delta.content
            .map((item) => item?.text ?? '')
            .join('');
    }

    if (typeof choice?.message?.content === 'string') {
        return choice.message.content;
    }

    if (Array.isArray(choice?.message?.content)) {
        return choice.message.content
            .map((item) => item?.text ?? '')
            .join('');
    }

    return '';
}

function extractTextFromResponsePayload(payload) {
    const output = Array.isArray(payload?.output) ? payload.output : [];
    return output
        .filter((entry) => entry?.type === 'message')
        .flatMap((entry) => Array.isArray(entry?.content) ? entry.content : [])
        .filter((entry) => entry?.type === 'output_text')
        .map((entry) => entry?.text ?? '')
        .join('');
}

async function runOpenAiCompatibleRequest(request, handlers) {
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
        const text = extractTextFromChunk(payload) || extractTextFromResponsePayload(payload);
        if (text) {
            await handlers.onText(text);
        }
        return {
            model: payload.model ?? request.body?.model ?? null,
            raw: payload,
            finalText: text,
        };
    }

    if (!response.body) {
        throw new Error('Upstream stream body missing');
    }

    let fullText = '';
    for await (const chunk of iterateOpenAiSse(response.body, handlers.abortSignal)) {
        const text = extractTextFromChunk(chunk);
        if (!text) {
            continue;
        }

        fullText += text;
        await handlers.onText(fullText, chunk);
    }

    return {
        model: request.body?.model ?? null,
        raw: null,
        finalText: fullText,
    };
}

module.exports = {
    runOpenAiCompatibleRequest,
};
