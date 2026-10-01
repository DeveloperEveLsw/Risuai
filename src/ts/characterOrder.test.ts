import { describe, expect, it } from 'vitest'
import { reconcileCharacterOrderInPlace } from './characterOrder'

describe('reconcileCharacterOrderInPlace', () => {
    it('preserves folder identity while dropping stale entries and appending active characters', () => {
        const folder = { data: ['a', 'missing', 'trash'], name: 'folder' }
        const order: Array<string | typeof folder | null> = [
            folder,
            'a',
            'missing',
            null,
            { data: [], name: 'empty' },
        ]

        reconcileCharacterOrderInPlace([
            { chaId: 'a' },
            { chaId: 'b' },
            { chaId: 'trash', trashTime: 1 },
            { chaId: '§temp' },
        ], order)

        expect(order).toEqual([folder, 'a', 'b'])
        expect(folder.data).toEqual(['a'])
    })

    it('uses linear membership sets instead of array includes on large catalogs', () => {
        const size = 10_000
        const order = Array.from({ length: size }, (_, index) => `character-${index}`)
        Object.defineProperty(order, 'includes', {
            value: () => {
                throw new Error('quadratic includes membership is forbidden')
            },
        })
        const characters = Array.from({ length: size + 1 }, (_, index) => ({
            chaId: `character-${index}`,
        }))

        reconcileCharacterOrderInPlace(characters, order)

        expect(order).toHaveLength(size + 1)
        expect(order.at(-1)).toBe(`character-${size}`)
    })
})
