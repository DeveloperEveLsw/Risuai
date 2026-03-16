function deepClone(value) {
    return JSON.parse(JSON.stringify(value ?? null))
}

function createStructuredTableRefs(schemaName) {
    const table = (name) => `${schemaName}."${name}"`
    return {
        appSettings: table('risu_app_settings'),
        personas: table('risu_personas'),
        botPresets: table('risu_bot_presets'),
        modules: table('risu_modules'),
        characters: table('risu_characters'),
        chatFolders: table('risu_character_chat_folders'),
        chats: table('risu_character_chats'),
        chatMessages: table('risu_chat_messages'),
        lorebooks: table('risu_lorebooks'),
        characterAssets: table('risu_character_assets')
    }
}

async function ensureStructuredDatabase(db, refs) {
    await db.query(`
        CREATE TABLE IF NOT EXISTS ${refs.appSettings} (
            singleton_key BOOLEAN PRIMARY KEY DEFAULT TRUE,
            settings_json JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `)
    await db.query(`
        CREATE TABLE IF NOT EXISTS ${refs.personas} (
            persona_id TEXT PRIMARY KEY,
            position INTEGER NOT NULL,
            name TEXT,
            icon TEXT,
            payload JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `)
    await db.query(`
        CREATE TABLE IF NOT EXISTS ${refs.botPresets} (
            preset_id TEXT PRIMARY KEY,
            position INTEGER NOT NULL,
            name TEXT,
            image TEXT,
            payload JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `)
    await db.query(`
        CREATE TABLE IF NOT EXISTS ${refs.modules} (
            module_id TEXT PRIMARY KEY,
            position INTEGER NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT FALSE,
            payload JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `)
    await db.query(`
        CREATE TABLE IF NOT EXISTS ${refs.characters} (
            character_id TEXT PRIMARY KEY,
            position INTEGER NOT NULL,
            kind TEXT NOT NULL,
            name TEXT,
            image TEXT,
            chat_page INTEGER,
            payload JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `)
    await db.query(`
        CREATE TABLE IF NOT EXISTS ${refs.chatFolders} (
            folder_id TEXT PRIMARY KEY,
            character_id TEXT NOT NULL REFERENCES ${refs.characters} (character_id) ON DELETE CASCADE,
            position INTEGER NOT NULL,
            name TEXT,
            color TEXT,
            folded BOOLEAN NOT NULL DEFAULT FALSE,
            payload JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `)
    await db.query(`
        CREATE TABLE IF NOT EXISTS ${refs.chats} (
            chat_id TEXT PRIMARY KEY,
            character_id TEXT NOT NULL REFERENCES ${refs.characters} (character_id) ON DELETE CASCADE,
            position INTEGER NOT NULL,
            name TEXT,
            folder_id TEXT,
            binded_persona TEXT,
            last_date BIGINT,
            payload JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `)
    await db.query(`
        CREATE TABLE IF NOT EXISTS ${refs.chatMessages} (
            message_id TEXT PRIMARY KEY,
            chat_id TEXT NOT NULL REFERENCES ${refs.chats} (chat_id) ON DELETE CASCADE,
            position INTEGER NOT NULL,
            role TEXT,
            name TEXT,
            message_time BIGINT,
            payload JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `)
    await db.query(`
        CREATE TABLE IF NOT EXISTS ${refs.lorebooks} (
            lorebook_id TEXT PRIMARY KEY,
            scope TEXT NOT NULL,
            owner_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            name TEXT,
            payload JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `)
    await db.query(`
        CREATE TABLE IF NOT EXISTS ${refs.characterAssets} (
            asset_ref_id TEXT PRIMARY KEY,
            character_id TEXT NOT NULL REFERENCES ${refs.characters} (character_id) ON DELETE CASCADE,
            asset_key TEXT NOT NULL,
            asset_kind TEXT NOT NULL,
            label TEXT,
            extension TEXT,
            metadata JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `)
}

function toAppSettings(db) {
    const settings = deepClone(db)
    settings.characters = []
    settings.botPresets = []
    settings.personas = []
    settings.loreBook = []
    settings.modules = []
    settings.enabledModules = []
    return settings
}

function getPersonaId(persona, index) {
    return persona?.id || `persona-${index}`
}

function getPresetId(index) {
    return `preset-${index}`
}

function getModuleId(module, index) {
    return module?.id || `module-${index}`
}

function getCharacterId(character, index) {
    return character?.chaId || `character-${index}`
}

function getChatId(characterId, chat, index) {
    return chat?.id || `${characterId}:chat:${index}`
}

function getMessageId(chatId, message, index) {
    return message?.chatId || `${chatId}:message:${index}`
}

function createCharacterPayload(character) {
    const payload = deepClone(character)
    payload.chats = []
    payload.chatFolders = []
    payload.globalLore = []
    return payload
}

function createChatPayload(chat, chatId) {
    const payload = deepClone(chat)
    payload.id = chatId
    payload.message = []
    payload.localLore = []
    return payload
}

function createMessagePayload(message, messageId) {
    const payload = deepClone(message)
    payload.chatId = payload.chatId || messageId
    return payload
}

function collectCharacterAssets(character, characterId) {
    const assets = []
    const addAsset = (assetKey, assetKind, label = '', extension = '', metadata = {}) => {
        if (!assetKey || typeof assetKey !== 'string' || !assetKey.startsWith('assets/')) {
            return
        }
        assets.push({
            assetKey,
            assetKind,
            label,
            extension,
            metadata: deepClone(metadata)
        })
    }

    addAsset(character.image, 'portrait', character.name || '')

    for (const [name, assetKey] of character.emotionImages ?? []) {
        addAsset(assetKey, 'emotion', name)
    }

    for (const [name, assetKey, extension] of character.additionalAssets ?? []) {
        addAsset(assetKey, 'additional', name, extension || '')
    }

    for (const asset of character.ccAssets ?? []) {
        addAsset(asset.uri, asset.type || 'ccAsset', asset.name || '', asset.ext || '', {
            type: asset.type || ''
        })
    }

    return assets.map((asset, index) => ({
        assetRefId: `${characterId}:asset:${index}`,
        ...asset
    }))
}

async function importStructuredDatabase(pool, refs, database) {
    const client = await pool.connect()

    try {
        await client.query('BEGIN')
        await client.query(`
            TRUNCATE TABLE
                ${refs.chatMessages},
                ${refs.chats},
                ${refs.chatFolders},
                ${refs.characterAssets},
                ${refs.characters},
                ${refs.personas},
                ${refs.botPresets},
                ${refs.modules},
                ${refs.lorebooks},
                ${refs.appSettings}
            RESTART IDENTITY
        `)

        await client.query(
            `
                INSERT INTO ${refs.appSettings} (singleton_key, settings_json, updated_at)
                VALUES (TRUE, $1::jsonb, NOW())
            `,
            [JSON.stringify(toAppSettings(database))]
        )

        for (const [index, persona] of (database.personas ?? []).entries()) {
            await client.query(
                `
                    INSERT INTO ${refs.personas} (persona_id, position, name, icon, payload, updated_at)
                    VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
                `,
                [
                    getPersonaId(persona, index),
                    index,
                    persona?.name || '',
                    persona?.icon || '',
                    JSON.stringify(deepClone(persona))
                ]
            )
        }

        for (const [index, preset] of (database.botPresets ?? []).entries()) {
            await client.query(
                `
                    INSERT INTO ${refs.botPresets} (preset_id, position, name, image, payload, updated_at)
                    VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
                `,
                [
                    getPresetId(index),
                    index,
                    preset?.name || `Preset ${index + 1}`,
                    preset?.image || '',
                    JSON.stringify(deepClone(preset))
                ]
            )
        }

        const enabledModules = new Set(database.enabledModules ?? [])
        for (const [index, module] of (database.modules ?? []).entries()) {
            const moduleId = getModuleId(module, index)
            await client.query(
                `
                    INSERT INTO ${refs.modules} (module_id, position, enabled, payload, updated_at)
                    VALUES ($1, $2, $3, $4::jsonb, NOW())
                `,
                [
                    moduleId,
                    index,
                    enabledModules.has(moduleId),
                    JSON.stringify(deepClone(module))
                ]
            )
        }

        for (const [index, lorebook] of (database.loreBook ?? []).entries()) {
            await client.query(
                `
                    INSERT INTO ${refs.lorebooks} (lorebook_id, scope, owner_id, position, name, payload, updated_at)
                    VALUES ($1, 'database', 'database', $2, $3, $4::jsonb, NOW())
                `,
                [
                    `database:lorebook:${index}`,
                    index,
                    lorebook?.name || `Lorebook ${index + 1}`,
                    JSON.stringify(deepClone(lorebook))
                ]
            )
        }

        for (const [characterIndex, character] of (database.characters ?? []).entries()) {
            const characterId = getCharacterId(character, characterIndex)
            await client.query(
                `
                    INSERT INTO ${refs.characters} (
                        character_id,
                        position,
                        kind,
                        name,
                        image,
                        chat_page,
                        payload,
                        updated_at
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
                `,
                [
                    characterId,
                    characterIndex,
                    character?.type === 'group' ? 'group' : 'character',
                    character?.name || '',
                    character?.image || '',
                    character?.chatPage ?? 0,
                    JSON.stringify(createCharacterPayload(character))
                ]
            )

            for (const [folderIndex, folder] of (character.chatFolders ?? []).entries()) {
                const folderId = folder?.id || `${characterId}:folder:${folderIndex}`
                await client.query(
                    `
                        INSERT INTO ${refs.chatFolders} (
                            folder_id,
                            character_id,
                            position,
                            name,
                            color,
                            folded,
                            payload,
                            updated_at
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
                    `,
                    [
                        folderId,
                        characterId,
                        folderIndex,
                        folder?.name || '',
                        folder?.color || '',
                        folder?.folded ?? false,
                        JSON.stringify(deepClone({
                            ...folder,
                            id: folderId
                        }))
                    ]
                )
            }

            if ((character.globalLore ?? []).length > 0) {
                await client.query(
                    `
                        INSERT INTO ${refs.lorebooks} (lorebook_id, scope, owner_id, position, name, payload, updated_at)
                        VALUES ($1, 'character', $2, 0, 'globalLore', $3::jsonb, NOW())
                    `,
                    [
                        `${characterId}:globalLore`,
                        characterId,
                        JSON.stringify(deepClone(character.globalLore))
                    ]
                )
            }

            for (const asset of collectCharacterAssets(character, characterId)) {
                await client.query(
                    `
                        INSERT INTO ${refs.characterAssets} (
                            asset_ref_id,
                            character_id,
                            asset_key,
                            asset_kind,
                            label,
                            extension,
                            metadata,
                            updated_at
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
                    `,
                    [
                        asset.assetRefId,
                        characterId,
                        asset.assetKey,
                        asset.assetKind,
                        asset.label,
                        asset.extension,
                        JSON.stringify(asset.metadata)
                    ]
                )
            }

            for (const [chatIndex, chat] of (character.chats ?? []).entries()) {
                const chatId = getChatId(characterId, chat, chatIndex)
                await client.query(
                    `
                        INSERT INTO ${refs.chats} (
                            chat_id,
                            character_id,
                            position,
                            name,
                            folder_id,
                            binded_persona,
                            last_date,
                            payload,
                            updated_at
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW())
                    `,
                    [
                        chatId,
                        characterId,
                        chatIndex,
                        chat?.name || '',
                        chat?.folderId || null,
                        chat?.bindedPersona || null,
                        chat?.lastDate || null,
                        JSON.stringify(createChatPayload(chat, chatId))
                    ]
                )

                if ((chat.localLore ?? []).length > 0) {
                    await client.query(
                        `
                            INSERT INTO ${refs.lorebooks} (lorebook_id, scope, owner_id, position, name, payload, updated_at)
                            VALUES ($1, 'chat', $2, 0, 'localLore', $3::jsonb, NOW())
                        `,
                        [
                            `${chatId}:localLore`,
                            chatId,
                            JSON.stringify(deepClone(chat.localLore))
                        ]
                    )
                }

                for (const [messageIndex, message] of (chat.message ?? []).entries()) {
                    const messageId = getMessageId(chatId, message, messageIndex)
                    await client.query(
                        `
                            INSERT INTO ${refs.chatMessages} (
                                message_id,
                                chat_id,
                                position,
                                role,
                                name,
                                message_time,
                                payload,
                                updated_at
                            )
                            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
                        `,
                        [
                            messageId,
                            chatId,
                            messageIndex,
                            message?.role || '',
                            message?.name || '',
                            message?.time || null,
                            JSON.stringify(createMessagePayload(message, messageId))
                        ]
                    )
                }
            }
        }

        await client.query('COMMIT')
    } catch (error) {
        await client.query('ROLLBACK')
        throw error
    } finally {
        client.release()
    }
}

function indexBy(rows, keyName) {
    const map = new Map()
    for (const row of rows) {
        const key = row[keyName]
        if (!map.has(key)) {
            map.set(key, [])
        }
        map.get(key).push(row)
    }
    return map
}

async function exportStructuredDatabase(pool, refs) {
    const settingsResult = await pool.query(
        `SELECT settings_json FROM ${refs.appSettings} WHERE singleton_key = TRUE LIMIT 1`
    )
    const settings = settingsResult.rows[0]?.settings_json
    if (!settings) {
        return null
    }

    const [
        personasResult,
        botPresetsResult,
        modulesResult,
        charactersResult,
        foldersResult,
        chatsResult,
        messagesResult,
        lorebooksResult
    ] = await Promise.all([
        pool.query(`SELECT * FROM ${refs.personas} ORDER BY position ASC`),
        pool.query(`SELECT * FROM ${refs.botPresets} ORDER BY position ASC`),
        pool.query(`SELECT * FROM ${refs.modules} ORDER BY position ASC`),
        pool.query(`SELECT * FROM ${refs.characters} ORDER BY position ASC`),
        pool.query(`SELECT * FROM ${refs.chatFolders} ORDER BY position ASC`),
        pool.query(`SELECT * FROM ${refs.chats} ORDER BY position ASC`),
        pool.query(`SELECT * FROM ${refs.chatMessages} ORDER BY position ASC`),
        pool.query(`SELECT * FROM ${refs.lorebooks} ORDER BY scope ASC, position ASC`)
    ])

    const database = deepClone(settings)
    database.personas = personasResult.rows.map((row) => deepClone(row.payload))
    database.botPresets = botPresetsResult.rows.map((row) => deepClone(row.payload))
    database.modules = modulesResult.rows.map((row) => deepClone(row.payload))
    database.enabledModules = modulesResult.rows
        .filter((row) => row.enabled)
        .map((row) => row.module_id)
    database.loreBook = lorebooksResult.rows
        .filter((row) => row.scope === 'database')
        .map((row) => deepClone(row.payload))

    const characterLoreMap = new Map(
        lorebooksResult.rows
            .filter((row) => row.scope === 'character')
            .map((row) => [row.owner_id, deepClone(row.payload)])
    )
    const chatLoreMap = new Map(
        lorebooksResult.rows
            .filter((row) => row.scope === 'chat')
            .map((row) => [row.owner_id, deepClone(row.payload)])
    )
    const foldersByCharacter = indexBy(foldersResult.rows, 'character_id')
    const chatsByCharacter = indexBy(chatsResult.rows, 'character_id')
    const messagesByChat = indexBy(messagesResult.rows, 'chat_id')

    database.characters = charactersResult.rows.map((row) => {
        const character = deepClone(row.payload)
        character.chaId = character.chaId || row.character_id
        character.chats = (chatsByCharacter.get(row.character_id) ?? []).map((chatRow) => {
            const chat = deepClone(chatRow.payload)
            chat.id = chat.id || chatRow.chat_id
            chat.message = (messagesByChat.get(chatRow.chat_id) ?? []).map((messageRow) => deepClone(messageRow.payload))
            chat.localLore = deepClone(chatLoreMap.get(chatRow.chat_id) ?? chat.localLore ?? [])
            return chat
        })
        character.chatFolders = (foldersByCharacter.get(row.character_id) ?? []).map((folderRow) => deepClone(folderRow.payload))
        character.globalLore = deepClone(characterLoreMap.get(row.character_id) ?? character.globalLore ?? [])
        return character
    })

    return database
}

module.exports = {
    createStructuredTableRefs,
    ensureStructuredDatabase,
    importStructuredDatabase,
    exportStructuredDatabase
}
