import type { Database } from './database.svelte'
import type { toSaveType } from './risuSave'

const blockKeys = new Set([
    'characters',
    'botPresets',
    'modules',
    'loadouts',
    'plugins',
    'pluginCustomStorage',
])

/** Detach only blocks the incremental encoder will read. Unchanged character
 * descriptors remain borrowed and must not be mutated or serialized by callers.
 * A full encoder reload still uses a complete, detached database snapshot.
 */
export function snapshotDatabaseForSave(
    database: Database,
    changes: toSaveType,
    snapshot: <T>(value: T) => T,
    hasCharacterBlock: (id: string) => boolean,
): { database: Database; characterIds: ReadonlySet<string> } {
    const root: Record<string, unknown> = {}
    for (const key of Object.keys(database)) {
        if (!blockKeys.has(key)) root[key] = database[key]
    }
    const result = snapshot(root) as unknown as Database
    const characterIds = new Set(changes.character)
    result.characters = database.characters.map((character) => {
        if (!hasCharacterBlock(character.chaId))
            characterIds.add(character.chaId)
        return characterIds.has(character.chaId)
            ? snapshot(character)
            : character
    })
    result.botPresets = changes.botPreset
        ? snapshot(database.botPresets)
        : database.botPresets
    result.modules = changes.modules
        ? snapshot(database.modules)
        : database.modules
    result.loadouts = changes.loadouts
        ? snapshot(database.loadouts)
        : database.loadouts
    result.plugins = changes.plugins
        ? snapshot(database.plugins)
        : database.plugins
    result.pluginCustomStorage = changes.pluginCustomStorage
        ? snapshot(database.pluginCustomStorage)
        : database.pluginCustomStorage
    return { database: result, characterIds }
}
