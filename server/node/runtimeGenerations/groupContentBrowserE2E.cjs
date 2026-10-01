'use strict';

/**
 * Real Chromium compatibility matrix for a two-speaker group chat.
 *
 * The low-level Node/CDP harness is shared with browserE2E.cjs, while this
 * file owns only its isolated database, provider behavior and assertions.
 * Neither executable reads a running Risu installation.
 *
 * Run:
 *   node server/node/runtimeGenerations/groupContentBrowserE2E.cjs
 *
 * Set RISU_BROWSER_E2E_SKIP_BUILD=1 to reuse an already-built dist directory.
 * Set RISU_BROWSER_E2E_CHROMIUM=/path/to/chromium to override auto-detection.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const harness = require('./browserE2E.cjs');

const {
    REPOSITORY_ROOT,
    DATABASE_FILE_NAME,
    CLEAR_PASSWORD,
    PASSWORD_HASH,
} = harness.constants;

const GROUP_ID = 'group-content-e2e';
const GROUP_CHAT_ID = 'group-content-chat';
const GROUP_NAME = 'Group Content E2E';
const SPEAKER_A_ID = 'group-speaker-alice';
const SPEAKER_A_NAME = 'Group Alice';
const SPEAKER_B_ID = 'group-speaker-bob';
const SPEAKER_B_NAME = 'Group Bob';
const MODULE_ID = 'group-content-module';
const MODULE_NAME = 'Group Content Compatibility Module';
const INPUT_TEXT = 'GROUP_INPUT';
const MODULE_INPUT_SUFFIX = '::MODULE_INPUT_OK';
const MODULE_LORE_MARKER = 'MODULE_LORE_OK';
const MODULE_START_MARKER = 'MODULE_START_OK';
const MODULE_LUA_EDIT_SUFFIX = ' module-lua-edit-ok';
const MODULE_REGEX_SUFFIX = ' module-regex-ok';
const MODULE_OUTPUT_SUFFIX = ' module-output-ok';
const MODULE_BUTTON_PAYLOAD = 'GROUP_MODULE_BUTTON';
const MODULE_BUTTON_MARKER = 'MODULE_BUTTON_CANONICAL_OK';
const MODULE_BACKGROUND_ID = 'group-module-background-marker';
const MODULE_BUTTON_ID = 'group-module-lua-button';
const SPEAKER_DIRECTIVE = 'GROUP_SPEAKER_DIRECTIVE';
const GROUP_HISTORY_TAG = 'GROUP_OTHER';
const PROVIDER_EXPECTED_SPEAKERS = [
    SPEAKER_A_ID,
    SPEAKER_B_ID,
    SPEAKER_A_ID,
    SPEAKER_B_ID,
    SPEAKER_A_ID,
    SPEAKER_B_ID,
    SPEAKER_A_ID,
];

let temporaryRoot = null;
let mockProvider = null;
let cdp = null;
let risuServer = null;

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createGate() {
    let release;
    let released = false;
    const promise = new Promise((resolve) => {
        release = () => {
            if (!released) {
                released = true;
                resolve();
            }
        };
    });
    return { promise, release, get released() { return released; } };
}

function providerPhase(index) {
    if (index < 2) return 'SEND';
    if (index < 4) return 'REROLL';
    return 'AUTO';
}

function providerSpeaker(index) {
    return PROVIDER_EXPECTED_SPEAKERS[index] ?? SPEAKER_A_ID;
}

function speakerLabel(speakerId) {
    return speakerId === SPEAKER_A_ID ? 'ALICE' : 'BOB';
}

function providerPartial(index) {
    return `Group ${providerPhase(index).toLowerCase()} ${speakerLabel(providerSpeaker(index)).toLowerCase()} partial`;
}

function providerRawFinal(index) {
    const button = index === 5
        ? ` <button id="${MODULE_BUTTON_ID}" risu-btn="${MODULE_BUTTON_PAYLOAD}">Run Group Module Lua</button>`
        : '';
    return `Group ${providerPhase(index).toLowerCase()} ${speakerLabel(providerSpeaker(index)).toLowerCase()} final${button}`;
}

function canonicalProviderOutput(index) {
    return `${providerPartial(index)} ${providerRawFinal(index)}`
        + MODULE_LUA_EDIT_SUFFIX
        + MODULE_REGEX_SUFFIX
        + MODULE_OUTPUT_SUFFIX;
}

function createCompatibilityModule() {
    const lua = `
listenEdit('editOutput', function(id, value, meta)
    if string.find(value, ${JSON.stringify(MODULE_LUA_EDIT_SUFFIX)}, 1, true) then
        return value
    end
    return value .. ${JSON.stringify(MODULE_LUA_EDIT_SUFFIX)}
end)

function onStart(id)
    setChatVarChanged(id, 'module_start_seen', 'true')
end

function onOutput(id)
    local index = getChatLength(id) - 1
    local value = getChatData(id, index)
    if not string.find(value, ${JSON.stringify(MODULE_OUTPUT_SUFFIX)}, 1, true) then
        setChat(id, index, value .. ${JSON.stringify(MODULE_OUTPUT_SUFFIX)})
    end
end

function onButtonClick(id, value)
    if value == ${JSON.stringify(MODULE_BUTTON_PAYLOAD)} then
        addChat(id, 'char', ${JSON.stringify(MODULE_BUTTON_MARKER)})
    end
end
`;

    return {
        id: MODULE_ID,
        name: MODULE_NAME,
        description: 'Exercises lore, input, start, output, regex, Lua button and background compatibility.',
        lowLevelAccess: false,
        lorebook: [{
            key: '',
            secondkey: '',
            insertorder: 100,
            comment: 'Always-active group module lore marker',
            content: MODULE_LORE_MARKER,
            mode: 'constant',
            alwaysActive: true,
            selective: false,
        }],
        regex: [{
            comment: 'Group input marker in the provider prompt',
            type: 'editprocess',
            in: escapeRegex(INPUT_TEXT),
            out: `${INPUT_TEXT}${MODULE_INPUT_SUFFIX}`,
            ableFlag: true,
            flag: 'u',
        }, {
            comment: 'Final module regex marker after the Lua editOutput hook',
            type: 'editoutput',
            in: `${escapeRegex(MODULE_LUA_EDIT_SUFFIX)}$`,
            out: `${MODULE_LUA_EDIT_SUFFIX}${MODULE_REGEX_SUFFIX}`,
            ableFlag: true,
            flag: 'u',
        }],
        trigger: [{
            comment: 'Module Lua compatibility and start prompt fixture',
            type: 'start',
            conditions: [],
            effect: [{
                type: 'triggerlua',
                code: lua,
            }, {
                type: 'systemprompt',
                location: 'start',
                value: MODULE_START_MARKER,
            }],
        }],
        backgroundEmbedding: `<div id="${MODULE_BACKGROUND_ID}">${MODULE_NAME} active</div>`,
    };
}

function normalizeSpeaker(character, id, name) {
    character.type = 'character';
    character.chaId = id;
    character.name = name;
    character.systemPrompt = `${SPEAKER_DIRECTIVE}::{{char}}\n{{original}}`;
    character.desc = `${name} is a deterministic group compatibility fixture.`;
    character.firstMessage = `${name} ready.`;
    character.chats = [{
        id: `${id}-unused-chat`,
        message: [],
        note: '',
        name: `${name} unused chat`,
        localLore: [],
        fmIndex: -1,
    }];
    character.chatPage = 0;
    character.globalLore = [];
    character.customscript = [];
    character.triggerscript = [];
    character.modules = [];
    character.lastInteraction = 1_700_000_000_000;
    return character;
}

function createSeedDatabase(providerPort) {
    const database = harness.createSeedDatabase(providerPort);
    const speakerA = normalizeSpeaker(
        structuredClone(database.characters[0]),
        SPEAKER_A_ID,
        SPEAKER_A_NAME,
    );
    const speakerB = normalizeSpeaker(
        structuredClone(database.characters[1]),
        SPEAKER_B_ID,
        SPEAKER_B_NAME,
    );
    const group = structuredClone(speakerA);
    group.type = 'group';
    group.chaId = GROUP_ID;
    group.name = GROUP_NAME;
    group.firstMessage = '';
    group.chats = [{
        id: GROUP_CHAT_ID,
        message: [],
        note: '',
        name: 'Two-speaker compatibility chat',
        localLore: [],
        modules: [MODULE_ID],
        fmIndex: -1,
    }];
    group.chatPage = 0;
    group.characters = [SPEAKER_A_ID, SPEAKER_B_ID];
    group.characterTalks = [1, 1];
    group.characterActive = [true, true];
    group.orderByOrder = true;
    group.autoMode = false;
    group.useCharacterLore = true;
    group.oneAtTime = false;
    group.globalLore = [];
    group.customscript = [];
    group.modules = [];
    group.viewScreen = 'none';
    group.lastInteraction = 1_700_000_000_000;

    database.characters = [group, speakerA, speakerB];
    database.characterOrder = [GROUP_ID, SPEAKER_A_ID, SPEAKER_B_ID];
    database.modules = [createCompatibilityModule()];
    database.enabledModules = [];
    database.moduleIntergration = '';
    database.plugins = [];
    database.pluginV2 = [];
    database.mainPrompt = 'Write exactly one response for {{char}}.';
    database.groupTemplate = `<${GROUP_HISTORY_TAG} speaker="{{char}}">{{slot}}</${GROUP_HISTORY_TAG}>`;
    database.groupOtherBotRole = 'user';
    database.useStreaming = true;
    database.streamingDisplayOptimizationMode = 'off';
    database.swipe = true;
    database.sideMenuRerollButton = true;
    database.useAutoSuggestions = false;
    database.playMessage = false;
    return database;
}

async function createIsolatedFixture(providerPort) {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'risu-group-content-e2e-'));
    const resolvedRoot = await fs.realpath(temporaryRoot);
    const realTemp = await fs.realpath(os.tmpdir());
    assert.ok(
        resolvedRoot.startsWith(`${realTemp}${path.sep}`),
        'group browser E2E fixture must live below the operating-system temp directory',
    );
    const savePath = path.join(temporaryRoot, 'save');
    await fs.mkdir(savePath, { recursive: true });
    await fs.writeFile(path.join(savePath, '__password'), PASSWORD_HASH, { mode: 0o600 });
    await fs.writeFile(
        path.join(savePath, DATABASE_FILE_NAME),
        harness.encodeFixtureSave(createSeedDatabase(providerPort)),
    );
    await fs.symlink(path.join(REPOSITORY_ROOT, 'dist'), path.join(temporaryRoot, 'dist'), 'dir');
    harness.setTemporaryRoot(temporaryRoot);
}

function inferPromptSpeaker(body) {
    for (const message of body.messages ?? []) {
        const content = String(message?.content ?? '');
        if (content.includes(`${SPEAKER_DIRECTIVE}::${SPEAKER_A_NAME}`)) return SPEAKER_A_ID;
        if (content.includes(`${SPEAKER_DIRECTIVE}::${SPEAKER_B_NAME}`)) return SPEAKER_B_ID;
    }
    return null;
}

async function startMockProvider() {
    const requests = [];
    const server = http.createServer(async (request, response) => {
        if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
            response.writeHead(404).end();
            return;
        }
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        let body;
        try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        }
        catch {
            response.writeHead(400).end();
            return;
        }

        const index = requests.length;
        const partialGate = createGate();
        const completionGate = createGate();
        const record = {
            index,
            body,
            inferredSpeaker: inferPromptSpeaker(body),
            expectedSpeaker: providerSpeaker(index),
            partial: providerPartial(index),
            rawFinal: providerRawFinal(index),
            partialSent: false,
            completed: false,
            aborted: false,
            partialGate,
            completionGate,
            releasePartial: partialGate.release,
            releaseCompletion: completionGate.release,
        };
        requests.push(record);

        response.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
        });
        response.flushHeaders();
        response.once('close', () => {
            if (!record.completed) record.aborted = true;
            partialGate.release();
            completionGate.release();
        });

        await partialGate.promise;
        if (response.destroyed || record.aborted) return;
        harness.writeSse(response, record.partial);
        record.partialSent = true;

        await completionGate.promise;
        if (response.destroyed || record.aborted) return;
        harness.writeSse(response, ` ${record.rawFinal}`);
        harness.writeSse(response, '', 'stop');
        response.write('data: [DONE]\n\n');
        record.completed = true;
        response.end();
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return {
        server,
        port: server.address().port,
        requests,
        async close() {
            for (const request of requests) {
                request.releasePartial();
                request.releaseCompletion();
            }
            server.closeAllConnections?.();
            await new Promise((resolve) => server.close(resolve));
        },
    };
}

function getGroupChat(database) {
    const group = database.characters.find((candidate) => candidate.chaId === GROUP_ID);
    assert.ok(group, 'canonical database must retain the group fixture');
    const chat = group.chats.find((candidate) => candidate.id === GROUP_CHAT_ID);
    assert.ok(chat, 'canonical database must retain the group fixture chat');
    return chat;
}

async function waitForProviderRequest(index) {
    return harness.eventually(
        () => mockProvider.requests[index] ?? false,
        { timeoutMs: 20_000, intervalMs: 50 },
    );
}

function assertProviderRequest(record, index) {
    assert.equal(record.index, index);
    assert.equal(record.body.stream, true, `provider request ${index} must use streaming`);
    assert.equal(
        record.inferredSpeaker,
        PROVIDER_EXPECTED_SPEAKERS[index],
        `provider request ${index} must contain the current speaker directive`,
    );
    const contents = (record.body.messages ?? []).map((message) => String(message?.content ?? ''));
    const countOccurrences = (marker) => contents.reduce(
        (count, content) => count + content.split(marker).length - 1,
        0,
    );
    const currentName = record.expectedSpeaker === SPEAKER_A_ID ? SPEAKER_A_NAME : SPEAKER_B_NAME;
    const otherName = record.expectedSpeaker === SPEAKER_A_ID ? SPEAKER_B_NAME : SPEAKER_A_NAME;
    assert.equal(
        countOccurrences(`${SPEAKER_DIRECTIVE}::${currentName}`),
        1,
        `provider request ${index} must contain exactly one current-speaker directive`,
    );
    assert.equal(
        countOccurrences(`${SPEAKER_DIRECTIVE}::${otherName}`),
        0,
        `provider request ${index} must not contain the other speaker directive`,
    );
    assert.equal(countOccurrences(MODULE_LORE_MARKER), 1, `provider request ${index} must include module lore exactly once`);
    assert.equal(countOccurrences(MODULE_START_MARKER), 1, `provider request ${index} must include the module start prompt exactly once`);
    assert.equal(
        countOccurrences(`${INPUT_TEXT}${MODULE_INPUT_SUFFIX}`),
        1,
        `provider request ${index} must include the module input-processing marker exactly once`,
    );
}

async function completeProviderRequest(index, { observePartial } = {}) {
    const record = await waitForProviderRequest(index);
    assertProviderRequest(record, index);
    record.releasePartial();
    await harness.eventually(() => record.partialSent, { timeoutMs: 10_000, intervalMs: 25 });
    if (observePartial) await observePartial(record);
    record.releaseCompletion();
    await harness.eventually(() => record.completed, { timeoutMs: 10_000, intervalMs: 25 });
    return record;
}

async function waitForCanonical(baseUrl, predicate, label) {
    return harness.eventually(async () => {
        const snapshot = await harness.loadCanonicalDatabase(baseUrl);
        return predicate(getGroupChat(snapshot.database), snapshot.database)
            ? snapshot
            : false;
    }, { timeoutMs: 20_000, intervalMs: 100 }).catch((error) => {
        throw new Error(`Canonical database did not reach ${label}: ${error.message}`);
    });
}

async function clickFirst(page, selector, label) {
    const clicked = await page.evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return false;
        element.click();
        return true;
    })()`);
    assert.equal(clicked, true, `${page.name} could not click ${label}`);
}

async function waitForViewerAdoption(page, commandId) {
    await page.waitFor(
        `document.querySelector(${JSON.stringify(
            `.runtime-assistant-output-presentation[data-runtime-command-id="${commandId}"]`,
        )}) === null
            && document.querySelector('button[data-runtime-generation-stop="current-chat"]') === null`,
        { timeoutMs: 15_000, intervalMs: 50 },
    );
}

async function openAdditionalChatMenu(page) {
    const opened = await page.evaluate(`(() => {
        const input = document.querySelector('textarea.text-input-area');
        const buttons = input?.parentElement
            ? [...input.parentElement.querySelectorAll(':scope > button')]
            : [];
        const menuButton = buttons.at(-1);
        if (!menuButton) return false;
        menuButton.click();
        return true;
    })()`);
    assert.equal(opened, true, `${page.name} could not open the additional chat menu`);
}

async function clickChatMenuText(page, labels) {
    const clicked = await page.evaluate(`(() => {
        const labels = ${JSON.stringify(labels)};
        const option = [...document.querySelectorAll('div.flex.items-center.cursor-pointer')]
            .find((element) => labels.includes(element.textContent.trim()));
        if (!option) return false;
        option.click();
        return true;
    })()`);
    assert.equal(clicked, true, `${page.name} could not click chat menu option ${labels.join('/')}`);
}

async function newCommandForAction(baseUrl, knownIds, action) {
    const command = await harness.waitForNewCommand(baseUrl, knownIds);
    assert.equal(command.action, action, `expected a ${action} runtime command`);
    knownIds.add(command.commandId);
    return command;
}

function assertSpeakerSlice(messages, start, requestIndexes, label) {
    const slice = messages.slice(start, start + requestIndexes.length);
    assert.deepEqual(
        slice.map((message) => ({
            role: message.role,
            saying: message.saying,
            data: message.data,
        })),
        requestIndexes.map((index) => ({
            role: 'char',
            saying: providerSpeaker(index),
            data: canonicalProviderOutput(index),
        })),
        label,
    );
}

async function runScenario() {
    await harness.buildApplication();
    mockProvider = await startMockProvider();
    await createIsolatedFixture(mockProvider.port);
    risuServer = await harness.startRisuServer();
    cdp = await harness.launchChromium();

    const resident = await cdp.createPage({ width: 1280, height: 900, name: 'group resident' });
    const desktop = await cdp.createPage({ width: 1280, height: 900, name: 'group desktop' });
    const phone = await cdp.createPage({ width: 390, height: 844, mobile: true, name: 'group phone' });

    try {
        await harness.waitForResident(risuServer, resident);
        await harness.authenticateAndOpenCharacter(
            desktop,
            risuServer.baseUrl,
            GROUP_ID,
            GROUP_NAME,
        );
        assert.equal(await desktop.evaluate('location.search'), '', 'desktop must remain a follower');
        assert.equal(await resident.evaluate("new URL(location.href).searchParams.get('risu-runtime')"), 'executor');
        assert.notEqual(desktop.browserContextId, phone.browserContextId);

        await desktop.waitFor(
            `document.querySelector('#${MODULE_BACKGROUND_ID}') !== null`,
            { timeoutMs: 15_000 },
        );
        const initialRevision = await harness.waitForStableCanonicalRevision(risuServer.baseUrl);
        const initialConflictIds = new Set(
            (await harness.listDatabaseConflicts(risuServer.baseUrl)).map((conflict) => conflict.conflictId),
        );
        const knownCommandIds = new Set(
            (await harness.listCommands(risuServer.baseUrl)).map((command) => command.commandId),
        );

        await desktop.setInput('textarea.text-input-area', INPUT_TEXT);
        await desktop.clickSelector('.button-icon-send');
        const sendCommand = await newCommandForAction(risuServer.baseUrl, knownCommandIds, 'send');
        const firstRequest = await waitForProviderRequest(0);
        assertProviderRequest(firstRequest, 0);
        firstRequest.releasePartial();
        await harness.eventually(() => firstRequest.partialSent, { timeoutMs: 10_000, intervalMs: 25 });
        await desktop.waitFor(
            `(document.body?.innerText ?? '').includes(${JSON.stringify(firstRequest.partial)})`,
            { timeoutMs: 10_000, intervalMs: 50 },
        );

        // The phone enters after the first speaker is already streaming. It
        // must attach to that command instead of creating another provider call.
        await harness.authenticateAndOpenCharacter(
            phone,
            risuServer.baseUrl,
            GROUP_ID,
            GROUP_NAME,
        );
        await phone.waitFor(
            `document.querySelector('button[data-runtime-generation-stop="current-chat"]') !== null`,
            { timeoutMs: 20_000, intervalMs: 50 },
        );
        await harness.eventually(() => phone.runtimeOutputFrames.some((frame) => (
            frame.commandId === sendCommand.commandId
            && frame.messages.some((message) => message.data.includes(firstRequest.partial))
        )), { timeoutMs: 15_000, intervalMs: 50 });
        const phoneObservedFirstPartial = await harness.eventually(async () => (
            await phone.evaluate(
                `(document.body?.innerText ?? '').includes(${JSON.stringify(firstRequest.partial)})`,
            )
        ), { timeoutMs: 5_000, intervalMs: 50 }).catch(() => false);
        if (!phoneObservedFirstPartial) {
            const partialDom = await phone.evaluate(`({
                assistantCount: document.querySelectorAll('.runtime-assistant-output-presentation').length,
                containers: [...document.querySelectorAll('.chat-message-container')].map((element) => ({
                    text: element.innerText,
                    html: element.outerHTML.slice(0, 2000),
                })),
            })`);
            firstRequest.releaseCompletion();
            throw new Error(`Phone received the group partial frame but did not render it: ${JSON.stringify(partialDom)}`);
        }
        assert.equal(mockProvider.requests.length, 1, 'phone adoption must not duplicate speaker A');
        firstRequest.releaseCompletion();
        await harness.eventually(() => firstRequest.completed, { timeoutMs: 10_000, intervalMs: 25 });

        const secondRequest = await waitForProviderRequest(1);
        assertProviderRequest(secondRequest, 1);
        assert.ok(
            (secondRequest.body.messages ?? []).some((message) => String(message?.content ?? '').includes(
                `<${GROUP_HISTORY_TAG} speaker="${SPEAKER_A_NAME}">`,
            )),
            'speaker B prompt must identify the prior non-speaker group message',
        );
        secondRequest.releasePartial();
        await harness.eventually(() => secondRequest.partialSent, { timeoutMs: 10_000, intervalMs: 25 });
        await phone.waitFor(
            `(document.body?.innerText ?? '').includes(${JSON.stringify(secondRequest.partial)})`,
            { timeoutMs: 15_000, intervalMs: 50 },
        );
        const multiSpeakerFrame = await harness.eventually(() => phone.runtimeOutputFrames.find(
            (frame) => frame.commandId === sendCommand.commandId
                && frame.messages.length >= 2
                && frame.messages.some((message) => message.data.includes(secondRequest.partial)),
        ) ?? false, { timeoutMs: 15_000, intervalMs: 50 });
        assert.equal(
            new Set(multiSpeakerFrame.messages.map((message) => message.messageIndex)).size,
            multiSpeakerFrame.messages.length,
            'streamed group output must retain distinct canonical message indexes',
        );
        secondRequest.releaseCompletion();
        const sendTerminal = await harness.waitForTerminal(risuServer.baseUrl, sendCommand.commandId);
        assert.equal(sendTerminal.state, 'completed', sendTerminal.error ?? 'group send failed');
        await harness.eventually(() => secondRequest.completed, { timeoutMs: 10_000, intervalMs: 25 });

        const afterSend = await waitForCanonical(risuServer.baseUrl, (chat) => (
            chat.message.length === 3
            && chat.message[2]?.data === canonicalProviderOutput(1)
        ), 'the two-speaker send');
        const sendMessages = getGroupChat(afterSend.database).message;
        assert.deepEqual(
            { role: sendMessages[0].role, data: sendMessages[0].data },
            { role: 'user', data: INPUT_TEXT },
            'module input processing must affect the provider prompt, not rewrite canonical user text',
        );
        assertSpeakerSlice(sendMessages, 1, [0, 1], 'canonical send must preserve Alice/Bob saying identities');
        assert.equal(getGroupChat(afterSend.database).scriptstate?.$module_start_seen, 'true');
        assert.equal(mockProvider.requests.length, 2, 'one group send must make exactly two provider calls');
        for (const page of [desktop, phone]) {
            await page.waitFor(
                `(document.body?.innerText ?? '').includes(${JSON.stringify(providerRawFinal(1))})`,
                { timeoutMs: 15_000 },
            );
            await waitForViewerAdoption(page, sendCommand.commandId);
        }

        // A reroll replaces the complete two-speaker slice and calls each
        // speaker once. It must not append a second copy of either response.
        await clickFirst(phone, '.button-icon-reroll', 'group reroll');
        const rerollCommand = await newCommandForAction(risuServer.baseUrl, knownCommandIds, 'reroll');
        await completeProviderRequest(2);
        await completeProviderRequest(3);
        const rerollTerminal = await harness.waitForTerminal(risuServer.baseUrl, rerollCommand.commandId);
        assert.equal(rerollTerminal.state, 'completed', rerollTerminal.error ?? 'group reroll failed');
        const afterReroll = await waitForCanonical(risuServer.baseUrl, (chat) => (
            chat.message.length === 3
            && chat.message[2]?.data === canonicalProviderOutput(3)
        ), 'the two-speaker reroll');
        assertSpeakerSlice(
            getGroupChat(afterReroll.database).message,
            1,
            [2, 3],
            'reroll must replace the entire old group response slice',
        );
        assert.equal(mockProvider.requests.length, 4, 'group reroll must add exactly two provider calls');
        for (const page of [desktop, phone]) {
            await waitForViewerAdoption(page, rerollCommand.commandId);
        }

        // Swipe-left unreroll is a resident history operation. Both viewers
        // adopt the restored old slice and the provider count remains fixed.
        await clickFirst(desktop, '.button-icon-unreroll', 'group unreroll');
        const unrerollCommand = await newCommandForAction(risuServer.baseUrl, knownCommandIds, 'unreroll');
        const unrerollTerminal = await harness.waitForTerminal(risuServer.baseUrl, unrerollCommand.commandId);
        assert.equal(unrerollTerminal.state, 'completed');
        const afterUnreroll = await waitForCanonical(risuServer.baseUrl, (chat) => (
            chat.message.length === 3
            && chat.message[2]?.data === canonicalProviderOutput(1)
        ), 'the restored pre-reroll group slice');
        assertSpeakerSlice(
            getGroupChat(afterUnreroll.database).message,
            1,
            [0, 1],
            'unreroll must restore both original speaker responses',
        );
        assert.equal(mockProvider.requests.length, 4, 'unreroll must not call the provider');
        for (const page of [desktop, phone]) {
            await page.waitFor(
                `(document.body?.innerText ?? '').includes(${JSON.stringify(providerRawFinal(1))})
                    && !(document.body?.innerText ?? '').includes(${JSON.stringify(providerRawFinal(3))})`,
                { timeoutMs: 15_000 },
            );
            await waitForViewerAdoption(page, unrerollCommand.commandId);
        }

        // Auto mode completes one Alice/Bob iteration, then the next Alice
        // request is held and cancelled. This gives the loop a deterministic
        // terminal boundary without pretending it is a one-shot action.
        await openAdditionalChatMenu(phone);
        await clickChatMenuText(phone, ['Auto Mode', '자동 모드']);
        const autoCommand = await newCommandForAction(risuServer.baseUrl, knownCommandIds, 'auto');
        await completeProviderRequest(4);
        await completeProviderRequest(5);
        const heldAutoRequest = await waitForProviderRequest(6);
        assertProviderRequest(heldAutoRequest, 6);
        await phone.waitFor(
            `document.querySelector('button[data-runtime-generation-stop="current-chat"]') !== null`,
            { timeoutMs: 10_000 },
        );
        await phone.clickSelector('button[data-runtime-generation-stop="current-chat"]');
        const autoTerminal = await harness.waitForTerminal(risuServer.baseUrl, autoCommand.commandId);
        assert.equal(autoTerminal.state, 'cancelled');
        await harness.eventually(() => heldAutoRequest.aborted, { timeoutMs: 10_000, intervalMs: 50 });
        assert.equal(heldAutoRequest.partialSent, false, 'cancelled next auto iteration must not emit a partial');
        assert.equal(mockProvider.requests.length, 7, 'auto must use two calls plus one intentionally cancelled next iteration');
        const afterAuto = await waitForCanonical(risuServer.baseUrl, (chat) => (
            chat.message.some((message) => message.data === canonicalProviderOutput(4))
            && chat.message.some((message) => message.data === canonicalProviderOutput(5))
        ), 'one complete auto-mode speaker pair');
        const autoMessages = getGroupChat(afterAuto.database).message;
        assert.deepEqual(
            autoMessages.map((message) => ({
                role: message.role,
                saying: message.saying ?? null,
                data: message.data,
            })),
            [
                { role: 'user', saying: null, data: INPUT_TEXT },
                { role: 'char', saying: SPEAKER_A_ID, data: canonicalProviderOutput(0) },
                { role: 'char', saying: SPEAKER_B_ID, data: canonicalProviderOutput(1) },
                { role: 'char', saying: SPEAKER_A_ID, data: canonicalProviderOutput(4) },
                { role: 'char', saying: SPEAKER_B_ID, data: canonicalProviderOutput(5) },
            ],
            'cancelled auto must retain exactly one complete Alice/Bob pair and no third placeholder',
        );
        for (const page of [desktop, phone]) {
            await waitForViewerAdoption(page, autoCommand.commandId);
        }

        // The module-produced button is clicked in the actual group message
        // DOM. The callback runs once in the resident and both viewers adopt
        // the one canonical marker without any provider request.
        for (const page of [desktop, phone]) {
            await page.waitFor(
                `document.querySelector('#${MODULE_BUTTON_ID}[risu-btn="${MODULE_BUTTON_PAYLOAD}"]') !== null`,
                { timeoutMs: 15_000 },
            );
        }
        const buttonCountBefore = (await harness.listCommands(risuServer.baseUrl))
            .filter((command) => command.action === 'lua-button').length;
        await clickFirst(phone, `#${MODULE_BUTTON_ID}`, 'group module Lua button');
        const buttonCommand = await newCommandForAction(risuServer.baseUrl, knownCommandIds, 'lua-button');
        const buttonTerminal = await harness.waitForTerminal(risuServer.baseUrl, buttonCommand.commandId);
        assert.equal(buttonTerminal.state, 'completed', buttonTerminal.error ?? 'group module Lua button failed');
        const afterButton = await waitForCanonical(risuServer.baseUrl, (chat) => (
            chat.message.filter((message) => message.data === MODULE_BUTTON_MARKER).length === 1
        ), 'one canonical module Lua button marker');
        for (const page of [desktop, phone]) {
            await page.waitFor(
                `(document.body?.innerText ?? '').includes(${JSON.stringify(MODULE_BUTTON_MARKER)})`,
                { timeoutMs: 15_000 },
            );
        }
        assert.equal(
            (await harness.listCommands(risuServer.baseUrl))
                .filter((command) => command.action === 'lua-button').length,
            buttonCountBefore + 1,
            'one DOM click must create exactly one resident Lua button command',
        );
        assert.equal(mockProvider.requests.length, 7, 'module Lua button must not call the provider');

        // Disable the chat-scoped module through its real UI. The background
        // embedding must disappear on both devices rather than leaking a
        // stale module DOM after the effective module set becomes empty.
        for (const page of [desktop, phone]) {
            await page.waitFor(
                `document.querySelector('#${MODULE_BACKGROUND_ID}') !== null`,
                { timeoutMs: 15_000 },
            );
        }
        await openAdditionalChatMenu(desktop);
        await clickChatMenuText(desktop, ['Modules', '모듈']);
        await desktop.waitFor(
            `[...document.querySelectorAll('span')].some((span) => span.textContent.trim() === ${JSON.stringify(MODULE_NAME)})`,
            { timeoutMs: 10_000 },
        );
        const disabledModule = await desktop.evaluate(`(() => {
            const label = [...document.querySelectorAll('span')]
                .find((span) => span.textContent.trim() === ${JSON.stringify(MODULE_NAME)});
            const row = label?.closest('div.pl-3.py-3');
            const button = row?.querySelector('button:not([aria-labelledby="disabled"])');
            if (!button) return false;
            button.click();
            return true;
        })()`);
        assert.equal(disabledModule, true, 'desktop could not disable the chat-scoped module');
        await waitForCanonical(risuServer.baseUrl, (chat) => (
            Array.isArray(chat.modules) && !chat.modules.includes(MODULE_ID)
        ), 'the disabled chat-scoped module');
        for (const page of [desktop, phone]) {
            await page.waitFor(
                `document.querySelector('#${MODULE_BACKGROUND_ID}') === null`,
                { timeoutMs: 15_000 },
            );
        }

        const finalSnapshot = await harness.loadCanonicalDatabase(risuServer.baseUrl);
        const finalChat = getGroupChat(finalSnapshot.database);
        assert.deepEqual(
            finalChat.message.map((message) => ({
                role: message.role,
                saying: message.saying ?? null,
                data: message.data,
            })),
            [
                { role: 'user', saying: null, data: INPUT_TEXT },
                { role: 'char', saying: SPEAKER_A_ID, data: canonicalProviderOutput(0) },
                { role: 'char', saying: SPEAKER_B_ID, data: canonicalProviderOutput(1) },
                { role: 'char', saying: SPEAKER_A_ID, data: canonicalProviderOutput(4) },
                { role: 'char', saying: SPEAKER_B_ID, data: canonicalProviderOutput(5) },
                { role: 'char', saying: null, data: MODULE_BUTTON_MARKER },
            ],
            'final canonical transcript must contain only the restored send, one auto pair and one Lua marker',
        );
        const chatIds = finalChat.message.map((message) => message.chatId);
        assert.equal(
            chatIds.every((chatId) => typeof chatId === 'string' && chatId !== ''),
            true,
            'every canonical group message must have a nonempty ID',
        );
        assert.equal(
            new Set(chatIds).size,
            finalChat.message.length,
            'all canonical group messages must have unique IDs',
        );
        const generatedAssistants = finalChat.message.filter((message) => (
            message.role === 'char'
            && (message.saying === SPEAKER_A_ID || message.saying === SPEAKER_B_ID)
        ));
        assert.equal(generatedAssistants.length, 4, 'the final transcript must contain exactly four generated speaker messages');
        const generationIds = generatedAssistants.map((message) => message.generationInfo?.generationId);
        assert.equal(
            generationIds.every((generationId) => typeof generationId === 'string' && generationId !== ''),
            true,
            'every generated speaker message must have a nonempty generation ID',
        );
        assert.equal(new Set(generationIds).size, generationIds.length);

        assert.equal(mockProvider.requests.length, PROVIDER_EXPECTED_SPEAKERS.length);
        mockProvider.requests.forEach((request, index) => assertProviderRequest(request, index));
        assert.deepEqual(
            mockProvider.requests.map((request) => request.inferredSpeaker),
            PROVIDER_EXPECTED_SPEAKERS,
            'provider calls must follow Alice/Bob for send, reroll and one auto iteration',
        );

        const scenarioCommands = (await harness.listCommands(risuServer.baseUrl))
            .filter((command) => knownCommandIds.has(command.commandId));
        assert.deepEqual(
            scenarioCommands.map((command) => command.action).sort(),
            ['auto', 'lua-button', 'reroll', 'send', 'unreroll'].sort(),
        );
        assert.deepEqual(
            scenarioCommands.map((command) => command.state).sort(),
            ['cancelled', 'completed', 'completed', 'completed', 'completed'].sort(),
        );
        assert.equal(
            scenarioCommands.filter((command) => ['queued', 'running'].includes(command.state)).length,
            0,
        );
        const finalConflicts = await harness.listDatabaseConflicts(risuServer.baseUrl);
        assert.deepEqual(
            finalConflicts.filter((conflict) => !initialConflictIds.has(conflict.conflictId)),
            [],
            'two-device group adoption and module interactions must create zero database conflicts',
        );

        console.log('[group-content-browser-e2e] PASS');
        console.log(JSON.stringify({
            isolatedRoot: temporaryRoot,
            initialRevision,
            finalRevision: finalSnapshot.revision,
            groupId: GROUP_ID,
            chatId: GROUP_CHAT_ID,
            providerSpeakerSequence: mockProvider.requests.map((request) => request.inferredSpeaker),
            providerRequests: mockProvider.requests.length,
            streamedPartialObservedOnPhone: true,
            multiSpeakerOutputFrameMessages: multiSpeakerFrame.messages.length,
            canonicalSayings: finalChat.message.map((message) => message.saying ?? null),
            rerollWholeSlice: true,
            unrerollProviderRequests: 0,
            autoCompletedSpeakerPairs: 1,
            autoNextRequestCancelledBeforePartial: true,
            moduleCompatibility: ['lore', 'input', 'start', 'lua-edit-output', 'regex', 'output', 'lua-button', 'background-disable'],
            luaButtonCommands: 1,
            newDatabaseConflicts: 0,
            commandStates: Object.fromEntries(scenarioCommands.map((command) => [command.action, command.state])),
        }, null, 2));
    }
    catch (error) {
        const browserStates = await Promise.all([resident, desktop, phone].map(async (page) => ({
            name: page.name,
            href: await page.evaluate('location.href').catch(() => null),
            bodyText: await page.evaluate('(document.body?.innerText ?? "").slice(0, 4000)').catch(() => null),
            hasStop: await page.evaluate(
                'document.querySelector(\'button[data-runtime-generation-stop="current-chat"]\') !== null',
            ).catch(() => null),
            runtimeOutputFrames: page.runtimeOutputFrames,
        })));
        const commandStates = risuServer
            ? await harness.listCommands(risuServer.baseUrl).catch(() => [])
            : [];
        const diagnostics = [resident, desktop, phone]
            .flatMap((page) => page.diagnostics.map((line) => `[${page.name}] ${line}`));
        throw new Error([
            error.stack ?? String(error),
            diagnostics.length ? `Browser diagnostics:\n${diagnostics.join('\n')}` : '',
            `Browser states:\n${JSON.stringify(browserStates, null, 2)}`,
            `Runtime commands:\n${JSON.stringify(commandStates, null, 2)}`,
            risuServer?.output?.length ? `Server output:\n${risuServer.output.join('')}` : '',
            mockProvider?.requests?.length
                ? `Provider requests:\n${JSON.stringify(mockProvider.requests.map((request) => ({
                    index: request.index,
                    inferredSpeaker: request.inferredSpeaker,
                    expectedSpeaker: request.expectedSpeaker,
                    partialSent: request.partialSent,
                    completed: request.completed,
                    aborted: request.aborted,
                    messages: request.body.messages,
                })), null, 2)}`
                : '',
        ].filter(Boolean).join('\n\n'));
    }
    finally {
        await Promise.all([
            resident.disposeContext().catch(() => {}),
            desktop.disposeContext().catch(() => {}),
            phone.disposeContext().catch(() => {}),
        ]);
        await harness.stopChild(risuServer?.child);
        risuServer = null;
    }
}

async function cleanup() {
    if (cdp) {
        await cdp.close().catch(() => {});
        cdp = null;
    }
    await harness.stopAllChildren();
    if (mockProvider) {
        await mockProvider.close().catch(() => {});
        mockProvider = null;
    }
    if (temporaryRoot && process.env.RISU_BROWSER_E2E_KEEP !== '1') {
        const resolved = path.resolve(temporaryRoot);
        const prefix = `${path.resolve(os.tmpdir())}${path.sep}risu-group-content-e2e-`;
        assert.ok(resolved.startsWith(prefix), `refusing to remove non-group-E2E path: ${resolved}`);
        await fs.rm(resolved, { recursive: true, force: true });
    }
}

(async () => {
    try {
        await runScenario();
    }
    finally {
        await cleanup();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
