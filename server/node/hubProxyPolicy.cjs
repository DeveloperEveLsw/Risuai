const HOP_BY_HOP_HEADERS = new Set([
    'connection',
    'content-length',
    'host',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
]);

const FORWARDED_REQUEST_HEADERS = new Set([
    'accept',
    'accept-language',
    'content-type',
    'if-modified-since',
    'if-none-match',
    'range',
    'user-agent',
    'x-risu-api-version',
    'x-risu-debug',
    'x-risu-token',
    'x-risu-update-id',
    'x-risu-username',
    'x-risuai-info',
]);

class HubProxyPolicyError extends Error {
    constructor(message, statusCode = 400) {
        super(message);
        this.name = 'HubProxyPolicyError';
        this.code = 'HUB_PROXY_POLICY_REJECTED';
        this.statusCode = statusCode;
    }
}

function normalizeHubBase(hubUrl) {
    const base = new URL(hubUrl);
    if (base.protocol !== 'https:') {
        throw new TypeError('The Risu hub base URL must use HTTPS');
    }
    return base;
}

function assertSameHubOrigin(candidate, hubUrl) {
    const base = normalizeHubBase(hubUrl);
    const resolved = new URL(candidate, base);
    if (resolved.origin !== base.origin) {
        throw new HubProxyPolicyError('Hub proxy target must stay on the configured Risu hub origin');
    }
    return resolved;
}

function resolveHubRequestTarget(originalUrl, hubUrl, pathHeader) {
    if (pathHeader !== undefined && pathHeader !== null && pathHeader !== '') {
        throw new HubProxyPolicyError('x-risu-node-path is not supported');
    }
    const pathAndQuery = String(originalUrl || '').replace(/^\/hub-proxy(?=\/|\?|$)/, '') || '/';
    return assertSameHubOrigin(pathAndQuery, hubUrl);
}

function resolveHubRedirectTarget(location, previousUrl, hubUrl) {
    if (typeof location !== 'string' || location.length === 0) {
        throw new HubProxyPolicyError('Hub redirect location is missing', 502);
    }
    const resolved = new URL(location, previousUrl);
    return assertSameHubOrigin(resolved, hubUrl);
}

function buildHubRequestHeaders(incomingHeaders, hubUrl) {
    const result = {};
    for (const [rawName, value] of Object.entries(incomingHeaders || {})) {
        const name = rawName.toLowerCase();
        if (
            HOP_BY_HOP_HEADERS.has(name)
            || !FORWARDED_REQUEST_HEADERS.has(name)
            || value === undefined
        ) {
            continue;
        }
        result[name] = Array.isArray(value) ? value.join(', ') : String(value);
    }
    result.origin = normalizeHubBase(hubUrl).origin;
    return result;
}

module.exports = {
    HubProxyPolicyError,
    buildHubRequestHeaders,
    resolveHubRedirectTarget,
    resolveHubRequestTarget,
};
