const assert = require('node:assert/strict');
const test = require('node:test');

const {
    buildHubRequestHeaders,
    resolveHubRedirectTarget,
    resolveHubRequestTarget,
} = require('./hubProxyPolicy.cjs');

const HUB = 'https://sv.risuai.xyz';

test('hub request paths and relative redirects stay on the fixed origin', () => {
    assert.equal(
        resolveHubRequestTarget('/hub-proxy/realm/search?cache=30', HUB).href,
        'https://sv.risuai.xyz/realm/search?cache=30',
    );
    assert.equal(
        resolveHubRedirectTarget('/resource/next', 'https://sv.risuai.xyz/resource/one', HUB).href,
        'https://sv.risuai.xyz/resource/next',
    );
});

test('arbitrary targets, protocol-relative paths, and cross-origin redirects are rejected', () => {
    assert.throws(
        () => resolveHubRequestTarget('/hub-proxy/x', HUB, 'http%3A%2F%2F169.254.169.254%2F'),
        /not supported/,
    );
    assert.throws(
        () => resolveHubRequestTarget('/hub-proxy//127.0.0.1/admin', HUB),
        /configured Risu hub origin/,
    );
    assert.throws(
        () => resolveHubRedirectTarget('http://192.168.1.1/', HUB, HUB),
        /configured Risu hub origin/,
    );
});

test('authentication, cookies, forwarded addresses, and hop-by-hop headers never leave the server', () => {
    assert.deepEqual(buildHubRequestHeaders({
        accept: 'application/json',
        authorization: 'Bearer attacker-value',
        connection: 'keep-alive',
        cookie: 'private=session',
        'proxy-authorization': 'secret',
        'risu-auth': 'signed-device-token',
        'x-forwarded-for': '127.0.0.1',
        'x-risu-token': 'hub-account-token',
    }, HUB), {
        accept: 'application/json',
        origin: 'https://sv.risuai.xyz',
        'x-risu-token': 'hub-account-token',
    });
});
