import { describe, expect, it } from 'vitest'
import {
    applyAssetMimeTypeHint,
    buildAssetDataUri,
    inferAssetMimeType,
} from '../assetMime'

describe('asset MIME inference', () => {
    it.each([
        ['assets/photo.png', 'image/png'],
        ['assets/photo.webp', 'image/webp'],
        ['assets/photo.gif', 'image/gif'],
        ['assets/icon.svg', 'image/svg+xml'],
        ['assets/song.mp3', 'audio/mpeg'],
        ['assets/song.wav', 'audio/wav'],
        ['assets/movie.mp4', 'video/mp4'],
        ['assets/movie.webm', 'video/webm'],
    ])('maps %s to %s', (path, expected) => {
        expect(inferAssetMimeType(path)).toBe(expected)
    })

    it('accepts bare, case-insensitive extensions and ignores URL suffixes', () => {
        expect(inferAssetMimeType('WEBM')).toBe('video/webm')
        expect(inferAssetMimeType('assets/clip.WEBM?revision=3#start')).toBe('video/webm')
    })

    it('preserves the historical PNG fallback for unknown or missing extensions', () => {
        expect(inferAssetMimeType('assets/file.unknown')).toBe('image/png')
        expect(inferAssetMimeType('assets/no-extension')).toBe('image/png')
    })

    it.each([
        ['css', 'text/css'],
        ['ttf', 'font/ttf'],
        ['otf', 'font/otf'],
        ['woff', 'font/woff'],
        ['woff2', 'font/woff2'],
    ])('retags a legacy .png data URI from %s metadata', (extension, mimeType) => {
        expect(applyAssetMimeTypeHint(
            'data:image/png;base64,AAE=',
            extension,
        )).toBe(`data:${mimeType};base64,AAE=`)
    })

    it('does not retag a URL or an unknown metadata extension', () => {
        expect(applyAssetMimeTypeHint('/sw/img/asset', 'css')).toBe('/sw/img/asset')
        expect(applyAssetMimeTypeHint(
            'data:image/webp;base64,AAE=',
            'unknown',
        )).toBe('data:image/webp;base64,AAE=')
    })

    it('builds the no-service-worker data URI with the inferred media type', () => {
        const data = Uint8Array.from([0, 1])
        expect(buildAssetDataUri('assets/sound.wav', data)).toBe('data:audio/wav;base64,AAE=')
        expect(buildAssetDataUri('assets/legacy.unknown', data)).toBe('data:image/png;base64,AAE=')
    })

    it.each([
        ['WAV', Uint8Array.from([
            0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
        ]), 'audio/wav'],
        ['MP4', Uint8Array.from([
            0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
        ]), 'video/mp4'],
        ['WebP', Uint8Array.from([
            0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
        ]), 'image/webp'],
        ['GIF', Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), 'image/gif'],
        ['SVG', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/svg+xml'],
        ['PNG', Uint8Array.from([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]), 'image/png'],
    ])('recovers a legacy %s payload saved under a .png path', (_name, data, expected) => {
        expect(buildAssetDataUri('assets/legacy.png', data)).toMatch(
            new RegExp(`^data:${expected.replace('+', '\\+')};base64,`),
        )
    })
})
