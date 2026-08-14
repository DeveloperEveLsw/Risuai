// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'

const mocks = vi.hoisted(() => {
    const db = {
        autoTranslate: false,
        newImageHandlingBeta: false,
    }
    return {
        db,
        canonical: vi.fn(async (data: string) => `<p>canonical:${data}</p>`),
        readOnly: vi.fn(async (data: string) => `<p>readonly:${data}</p>`),
        trimCanonical: vi.fn((data: string) => data),
        trimReadOnly: vi.fn((data: string) => data),
    }
})

vi.mock('src/ts/stores.svelte', () => ({
    DBState: { db: mocks.db },
}))

vi.mock('src/ts/util', () => ({
    sleep: () => Promise.resolve(),
}))

vi.mock('../../ts/alert', () => ({
    alertError: vi.fn(),
}))

vi.mock('../../ts/parser/parser.svelte', () => ({
    addMetadataToElement: (data: string) => data,
    getDistance: vi.fn(() => 0),
    ParseMarkdown: mocks.canonical,
    ParseMarkdownReadOnlyPresentation: mocks.readOnly,
    postTranslationParse: vi.fn((data: string) => data),
    trimMarkdown: mocks.trimCanonical,
    trimMarkdownReadOnlyPresentation: mocks.trimReadOnly,
}))

vi.mock('../../ts/translator/translator', () => ({
    getLLMCache: vi.fn(async () => null),
    translateHTML: vi.fn(async (data: string) => data),
}))

vi.mock('src/ts/process/modules', () => ({
    getModuleAssets: () => [],
}))

vi.mock('src/ts/storage/database.svelte', () => ({
    getCurrentCharacter: () => ({
        additionalAssets: [],
        prebuiltAssetStyle: '',
    }),
}))

vi.mock('src/ts/globalApi.svelte', () => ({
    getFileSrc: vi.fn(async (path: string) => path),
}))

import ChatBody from './ChatBody.svelte'

const mounted: unknown[] = []

async function renderBody(msgDisplay: string, readOnlyPresentation: boolean) {
    const target = document.createElement('div')
    document.body.appendChild(target)
    mounted.push(mount(ChatBody, {
        target,
        props: {
            msgDisplay,
            role: 'char',
            translated: false,
            translating: false,
            retranslate: false,
            modelShortName: '',
            readOnlyPresentation,
        },
    }))
    await tick()
    return target
}

beforeEach(() => {
    mocks.canonical.mockClear()
    mocks.readOnly.mockClear()
    mocks.trimCanonical.mockClear()
    mocks.trimReadOnly.mockClear()
})

afterEach(async () => {
    await Promise.all(mounted.splice(0).map((component) => unmount(component as never)))
    document.body.replaceChildren()
})

describe('ChatBody runtime presentation isolation', () => {
    it('routes multiple versions on two follower presentations only through the read-only parser', async () => {
        const databaseBefore = structuredClone(mocks.db)
        const versions = ['one', 'two', 'three']

        const targets = []
        for(const follower of ['desktop', 'phone']){
            for(const version of versions){
                targets.push(await renderBody(`${follower}:${version}`, true))
            }
        }

        await vi.waitFor(() => expect(mocks.readOnly).toHaveBeenCalledTimes(6))
        expect(mocks.canonical).not.toHaveBeenCalled()
        expect(mocks.trimCanonical).not.toHaveBeenCalled()
        expect(mocks.trimReadOnly).toHaveBeenCalled()
        expect(targets.map((target) => target.textContent?.trim())).toEqual([
            'readonly:desktop:one',
            'readonly:desktop:two',
            'readonly:desktop:three',
            'readonly:phone:one',
            'readonly:phone:two',
            'readonly:phone:three',
        ])
        expect(mocks.db).toEqual(databaseBefore)
    })

    it('leaves an ordinary canonical message on the original parser', async () => {
        const target = await renderBody('adopted', false)

        await vi.waitFor(() => expect(mocks.canonical).toHaveBeenCalledOnce())
        expect(mocks.readOnly).not.toHaveBeenCalled()
        expect(mocks.trimCanonical).toHaveBeenCalled()
        expect(target.textContent?.trim()).toBe('canonical:adopted')
    })
})
