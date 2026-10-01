'use strict'

// Seed acceptance tests in the same self-contained block format that the
// Node runtime saves. msgpackr 1.10.1's Node encoder calls utf8Write with an
// out-of-range length under Node 24; browser encoding is unaffected.
function encodeFixtureSave(database) {
    const block = (type, name, value) => {
        const nameBytes = Buffer.from(name)
        const data = Buffer.from(JSON.stringify(value))
        const header = Buffer.alloc(7 + nameBytes.length)
        header[0] = type
        header[2] = nameBytes.length
        nameBytes.copy(header, 3)
        header.writeUInt32LE(data.length, 3 + nameBytes.length)
        return Buffer.concat([header, data])
    }
    const {
        characters = [],
        botPresets = [],
        modules = [],
        loadouts = [],
        plugins = [],
        pluginCustomStorage = {},
        ...root
    } = database
    return Buffer.concat([
        Buffer.from('RISUSAVE\0'),
        block(1, 'root', root),
        block(4, 'preset', botPresets),
        block(5, 'modules', modules),
        block(10, 'loadouts', loadouts),
        block(9, 'plugins', plugins),
        block(11, 'pluginStorage', pluginCustomStorage),
        ...characters.map((character) => block(2, character.chaId, character)),
        block(0, 'config', { version: 1 }),
    ])
}

module.exports = { encodeFixtureSave }
