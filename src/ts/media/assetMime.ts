import { Buffer } from 'buffer'

const assetMimeTypes: Record<string, string> = {
    png: 'image/png',
    apng: 'image/apng',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    avif: 'image/avif',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    opus: 'audio/ogg',
    flac: 'audio/flac',
    aac: 'audio/aac',
    m4a: 'audio/mp4',
    mp4: 'video/mp4',
    m4p: 'video/mp4',
    m4v: 'video/mp4',
    webm: 'video/webm',
    ogv: 'video/ogg',
    avi: 'video/x-msvideo',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',
    css: 'text/css',
    ttf: 'font/ttf',
    otf: 'font/otf',
    woff: 'font/woff',
    woff2: 'font/woff2',
}

function getAssetExtension(pathOrExtension: string) {
    const normalized = pathOrExtension
        .trim()
        .toLowerCase()
        .split(/[?#]/, 1)[0]
        .replace(/\\/g, '/')
    const basename = normalized.substring(normalized.lastIndexOf('/') + 1)
    const dotIndex = basename.lastIndexOf('.')
    return dotIndex === -1 ? basename : basename.substring(dotIndex + 1)
}

/** Infer a browser media type from either a stored asset path or a bare
 * extension. Existing callers historically treated unknown assets as PNG, so
 * that remains the default fallback. */
export function inferAssetMimeType(pathOrExtension: string, fallback = 'image/png') {
    return assetMimeTypes[getAssetExtension(pathOrExtension)] ?? fallback
}

/** Apply authoritative asset metadata to a no-service-worker data URI. This
 * repairs legacy module assets whose bytes were stored under a .png key while
 * leaving service-worker, remote and Tauri URLs untouched. */
export function applyAssetMimeTypeHint(source: string, pathOrExtension: string) {
    const mimeType = inferAssetMimeType(pathOrExtension, '')
    if (!mimeType || !source.startsWith('data:')) {
        return source
    }
    return source.replace(
        /^data:[^;,]+(?=;base64,)/i,
        `data:${mimeType}`,
    )
}

function hasBytes(data: Uint8Array, offset: number, expected: number[]) {
    return expected.every((value, index) => data[offset + index] === value)
}

function sniffAssetMimeType(data: Uint8Array) {
    if (hasBytes(data, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
        return 'image/png'
    }
    if (hasBytes(data, 0, [0xff, 0xd8, 0xff])) {
        return 'image/jpeg'
    }
    if (
        hasBytes(data, 0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])
        || hasBytes(data, 0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
    ) {
        return 'image/gif'
    }
    if (hasBytes(data, 0, [0x52, 0x49, 0x46, 0x46])) {
        if (hasBytes(data, 8, [0x57, 0x45, 0x42, 0x50])) {
            return 'image/webp'
        }
        if (hasBytes(data, 8, [0x57, 0x41, 0x56, 0x45])) {
            return 'audio/wav'
        }
        if (hasBytes(data, 8, [0x41, 0x56, 0x49, 0x20])) {
            return 'video/x-msvideo'
        }
    }
    if (hasBytes(data, 0, [0x4f, 0x67, 0x67, 0x53])) {
        return 'audio/ogg'
    }
    if (hasBytes(data, 0, [0x66, 0x4c, 0x61, 0x43])) {
        return 'audio/flac'
    }
    if (
        hasBytes(data, 0, [0x49, 0x44, 0x33])
        || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0)
    ) {
        return 'audio/mpeg'
    }
    if (hasBytes(data, 0, [0x1a, 0x45, 0xdf, 0xa3])) {
        // WebM and Matroska share EBML. Legacy module paths discarded the
        // extension, while WebM is the browser-native format accepted by Risu.
        return 'video/webm'
    }
    if (hasBytes(data, 4, [0x66, 0x74, 0x79, 0x70])) {
        const brand = String.fromCharCode(...data.subarray(8, 12))
        if (brand === 'avif' || brand === 'avis') {
            return 'image/avif'
        }
        if (brand === 'M4A ' || brand === 'M4B ') {
            return 'audio/mp4'
        }
        return 'video/mp4'
    }

    const textHeader = new TextDecoder().decode(data.subarray(0, 1024)).trimStart()
    if (/^(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(textHeader)) {
        return 'image/svg+xml'
    }
    return null
}

export function buildAssetDataUri(path: string, data: Uint8Array) {
    const pathMimeType = inferAssetMimeType(path)
    // Legacy .risum imports retained the original metadata extension but saved
    // every payload under a .png key. Only fallback/PNG paths need sniffing;
    // newly saved assets keep their explicit extension and remain path-driven.
    const mimeType = pathMimeType === 'image/png'
        ? sniffAssetMimeType(data) ?? pathMimeType
        : pathMimeType
    return `data:${mimeType};base64,${Buffer.from(data).toString('base64')}`
}
