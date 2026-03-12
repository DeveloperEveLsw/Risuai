function sanitizeRegexFlags(flag, allowMetaActions) {
    let normalized = allowMetaActions ? (flag || 'g') : ((flag || '').replace(/<(.+?)>/g, '') || 'g');
    normalized = normalized.trim().replace(/[^dgimsuvy]/g, '');
    normalized = normalized.split('').filter((value, index, array) => array.indexOf(value) === index).join('');
    return normalized.length > 0 ? normalized : 'u';
}

function isServerSafePresetEditOutputRegex(script) {
    if (!script || script.type !== 'editoutput') {
        return false;
    }

    if (typeof script.in !== 'string' || typeof script.out !== 'string') {
        return false;
    }

    if (script.ableFlag && typeof script.flag === 'string' && script.flag.includes('<')) {
        return false;
    }

    if (script.out.startsWith('@@')) {
        return false;
    }

    if (script.in.includes('{{') || script.out.includes('{{')) {
        return false;
    }

    return true;
}

function normalizeReplacement(script) {
    let replacement = script.out.replaceAll('$n', '\n').replaceAll('{{data}}', '$&');
    if (replacement.endsWith('>')) {
        replacement += '\n';
    }
    return replacement;
}

function applyPresetEditOutputRegex(text, scripts) {
    let nextText = text ?? '';

    for (const script of scripts ?? []) {
        if (!isServerSafePresetEditOutputRegex(script) || script.in === '') {
            continue;
        }

        try {
            const regex = new RegExp(script.in, sanitizeRegexFlags(script.flag, !!script.ableFlag));
            nextText = nextText.replace(regex, normalizeReplacement(script));
        }
        catch (error) {
            console.error('[GenerationRunner] Failed to apply preset editoutput regex', error);
        }
    }

    return nextText;
}

module.exports = {
    applyPresetEditOutputRegex,
    isServerSafePresetEditOutputRegex,
};
