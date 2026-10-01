'use strict'

// Real manual/Lua HTML controls, isolated saves and browser partitions. No
// production data or paid provider is used. Reuse a built dist with SKIP_BUILD.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const harness = require('./browserE2E.cjs')
const { REPOSITORY_ROOT, DATABASE_FILE_NAME, PASSWORD_HASH } = harness.constants
const ID = 'interaction-e2e'
const NAME = 'Interaction E2E'
const CHAT = 'interaction-chat'
let root
let browser

async function run() {
    await harness.buildApplication()
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'risu-interaction-e2e-'))
    harness.setTemporaryRoot(root)
    const database = harness.createSeedDatabase(1)
    database.modules = []
    database.enabledModules = []
    database.plugins = []
    database.pluginV2 = []
    const character = database.characters[0]
    character.chaId = ID
    character.name = NAME
    character.triggerscript = [
        ...['one', 'two', 'three'].map((value) => ({
            comment: value,
            type: 'manual',
            conditions: [],
            effect: [
                {
                    type: 'v2SetVar',
                    var: 'choice',
                    value,
                    valueType: 'value',
                    operator: '=',
                },
            ],
        })),
        {
            comment: 'Lua',
            type: 'manual',
            conditions: [],
            effect: [
                {
                    type: 'triggerlua',
                    code: "function onButtonClick(id, value) if value == 'lua' then setChatVar(id, 'choice', 'lua') end end",
                },
            ],
        },
    ]
    character.chats[0].id = CHAT
    character.chats[0].scriptstate = { $choice: 'none' }
    character.firstMessage =
        '<div id="interaction-state">STATE:{{getvar::choice}}</div>' +
        ['one', 'two', 'three']
            .map(
                (value) =>
                    `<button id="choose-${value}" risu-trigger="${value}">${value}</button>`,
            )
            .join('') +
        '<button id="choose-lua" risu-btn="lua">Lua</button>'
    // A large archived history on the SAME character exercises cloning and
    // saving costs without making hundreds of visible chat bubbles.
    character.chats.push({
        id: 'archive',
        name: 'Archive',
        note: '',
        localLore: [],
        message: Array.from(
            {
                length: Number(
                    process.env.RISU_INTERACTION_ARCHIVE_MESSAGES ?? 12000,
                ),
            },
            (_, index) => ({
                role: 'char',
                chatId: `archive-${index}`,
                data: `Archive ${index} ${'x'.repeat(1000)}`,
            }),
        ),
    })
    database.characterOrder = [ID]
    await fs.mkdir(path.join(root, 'save'))
    await fs.writeFile(path.join(root, 'save', '__password'), PASSWORD_HASH, {
        mode: 0o600,
    })
    const seed = harness.encodeFixtureSave(database)
    await fs.writeFile(path.join(root, 'save', DATABASE_FILE_NAME), seed)
    await fs.symlink(
        path.join(REPOSITORY_ROOT, 'dist'),
        path.join(root, 'dist'),
    )
    const server = await harness.startRisuServer()
    browser = await harness.launchChromium()
    const resident = await browser.createPage({
        width: 1280,
        height: 900,
        name: 'interaction resident',
    })
    const desktop = await browser.createPage({
        width: 1280,
        height: 900,
        name: 'interaction desktop',
    })
    const phone = await browser.createPage({
        width: 390,
        height: 844,
        mobile: true,
        name: 'interaction phone',
    })
    await harness.waitForResident(server, resident)
    await harness.authenticateAndOpenCharacter(
        desktop,
        server.baseUrl,
        ID,
        NAME,
    )
    await harness.authenticateAndOpenCharacter(phone, server.baseUrl, ID, NAME)
    await harness.waitForStableCanonicalRevision(server.baseUrl)
    const initialConflictIds = new Set(
        (await harness.listDatabaseConflicts(server.baseUrl)).map(
            (c) => c.conflictId,
        ),
    )
    const known = new Set(
        (await harness.listCommands(server.baseUrl)).map((c) => c.commandId),
    )
    const results = []
    for (const choice of ['one', 'two', 'three', 'lua']) {
        const clicked = await desktop.evaluate(`(() => {
            const button = document.querySelector('#choose-${choice}');
            if (!button) return null;
            const started = performance.now();
            button.click();
            return { started, pendingImmediately: button.getAttribute('aria-busy') === 'true' };
        })()`)
        assert.ok(clicked, 'HTML control must render')
        const command = await harness.waitForNewCommand(server.baseUrl, known)
        known.add(command.commandId)
        if (process.env.RISU_INTERACTION_EXPECT_PENDING === '1') {
            await desktop.waitFor(
                'document.querySelector(\'button[data-runtime-generation-stop="current-chat"]\') !== null',
                { timeoutMs: 5000, intervalMs: 10 },
            )
            assert.equal(
                await desktop.evaluate(
                    'document.querySelector(\'button[data-runtime-generation-stop="current-chat"] .loadmove\') === null',
                ),
                true,
                'an HTML callback must retain Stop without showing the response-generation spinner',
            )
        }
        const terminal = await harness.waitForTerminal(
            server.baseUrl,
            command.commandId,
        )
        assert.equal(
            terminal.state,
            'completed',
            terminal.error ?? 'interaction failed',
        )
        await desktop.waitFor(
            `document.querySelector('#interaction-state')?.textContent === 'STATE:${choice}'`,
            { timeoutMs: 20000, intervalMs: 25 },
        )
        const domMs = await desktop.evaluate(
            `performance.now() - ${clicked.started}`,
        )
        await phone.waitFor(
            `document.querySelector('#interaction-state')?.textContent === 'STATE:${choice}'`,
            { timeoutMs: 20000, intervalMs: 25 },
        )
        if (process.env.RISU_INTERACTION_EXPECT_PENDING === '1') {
            assert.equal(
                clicked.pendingImmediately,
                true,
                'click feedback must precede persistence/network',
            )
            assert.equal(
                await desktop.evaluate(
                    "document.querySelector('[data-risu-interaction-pending]') === null",
                ),
                true,
            )
        }
        results.push({
            choice,
            pendingImmediately: clicked.pendingImmediately,
            queueMs: terminal.startedAt - terminal.createdAt,
            runMs: terminal.finishedAt - terminal.startedAt,
            commandMs: terminal.finishedAt - terminal.createdAt,
            domMs: Math.round(domMs),
        })
    }
    const final = await harness.loadCanonicalDatabase(server.baseUrl)
    assert.equal(
        final.database.characters.find((c) => c.chaId === ID).chats[0]
            .scriptstate.$choice,
        'lua',
    )
    assert.equal(
        final.database.characters.find((c) => c.chaId === ID).chats[1].message
            .length,
        12000,
    )
    assert.equal(
        (await harness.listCommands(server.baseUrl)).length -
            (known.size - results.length),
        4,
    )
    assert.deepEqual(
        (await harness.listDatabaseConflicts(server.baseUrl)).filter(
            (c) => !initialConflictIds.has(c.conflictId),
        ),
        [],
    )
    console.log('[interaction-browser-e2e] PASS')
    console.log(
        JSON.stringify(
            {
                seedBytes: seed.length,
                startupFixtureConflicts: initialConflictIds.size,
                browsers: ['desktop', 'phone'],
                results,
            },
            null,
            2,
        ),
    )
}

;(async () => {
    try {
        await run()
    } finally {
        await browser?.close()
        await harness.stopAllChildren()
        if (root) {
            assert.ok(
                root.startsWith(
                    path.join(os.tmpdir(), 'risu-interaction-e2e-'),
                ),
            )
            await fs.rm(root, { recursive: true, force: true })
        }
    }
})().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
