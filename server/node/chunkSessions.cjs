const path = require('path')
const os = require('os')
const fs = require('fs/promises')
const { existsSync, mkdirSync } = require('fs')
const { randomUUID } = require('crypto')

const DEFAULT_TTL_MS = 1000 * 60 * 60
const DEFAULT_CHUNK_SIZE = 1024 * 1024 * 64
const MIN_CHUNK_SIZE = 1024 * 256
const MAX_CHUNK_SIZE = 1024 * 1024 * 96

function createSessionError(message, statusCode) {
    const error = new Error(message)
    error.statusCode = statusCode
    return error
}

function normalizeChunkSize(value) {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) {
        return DEFAULT_CHUNK_SIZE
    }
    return Math.max(MIN_CHUNK_SIZE, Math.min(MAX_CHUNK_SIZE, Math.floor(parsed)))
}

class ChunkSessionStore {
    constructor({
        rootDir = path.join(os.tmpdir(), 'risuai-node-chunks'),
        ttlMs = DEFAULT_TTL_MS
    } = {}) {
        this.rootDir = rootDir
        this.ttlMs = ttlMs
    }

    async ensureRootDir() {
        if (!existsSync(this.rootDir)) {
            mkdirSync(this.rootDir, { recursive: true })
        }
    }

    metaPath(id) {
        return path.join(this.rootDir, `${id}.json`)
    }

    dataPath(id) {
        return path.join(this.rootDir, `${id}.bin`)
    }

    async cleanupExpired() {
        await this.ensureRootDir()
        const entries = await fs.readdir(this.rootDir).catch(() => [])
        const now = Date.now()

        for (const entry of entries) {
            if (!entry.endsWith('.json')) {
                continue
            }

            const id = entry.slice(0, -5)
            try {
                const meta = await this.loadMeta(id)
                if ((meta.updatedAt || meta.createdAt || 0) + this.ttlMs < now) {
                    await this.cleanupSession(id)
                }
            } catch (error) {
                await this.cleanupSession(id)
            }
        }
    }

    async loadMeta(id) {
        await this.ensureRootDir()
        try {
            return JSON.parse(await fs.readFile(this.metaPath(id), 'utf-8'))
        } catch (error) {
            if (error.code === 'ENOENT') {
                throw createSessionError('Chunk session not found', 404)
            }
            throw error
        }
    }

    async saveMeta(id, meta) {
        await this.ensureRootDir()
        meta.updatedAt = Date.now()
        await fs.writeFile(this.metaPath(id), JSON.stringify(meta), 'utf-8')
        return meta
    }

    async cleanupSession(id) {
        await Promise.all([
            fs.rm(this.metaPath(id)).catch((error) => {
                if (error.code !== 'ENOENT') {
                    throw error
                }
            }),
            fs.rm(this.dataPath(id)).catch((error) => {
                if (error.code !== 'ENOENT') {
                    throw error
                }
            })
        ])
    }

    async createUploadSession({
        purpose,
        key = '',
        size = 0,
        chunkSize
    }) {
        await this.cleanupExpired()
        const normalizedChunkSize = normalizeChunkSize(chunkSize)
        const totalChunks = Math.max(1, Math.ceil(size / normalizedChunkSize))
        const id = randomUUID()
        const meta = {
            id,
            kind: 'upload',
            purpose,
            key,
            size,
            chunkSize: normalizedChunkSize,
            totalChunks,
            nextIndex: 0,
            receivedSize: 0,
            createdAt: Date.now(),
            updatedAt: Date.now()
        }

        await this.saveMeta(id, meta)
        await fs.writeFile(this.dataPath(id), Buffer.alloc(0))
        return meta
    }

    async appendUploadChunk(id, index, chunk) {
        const meta = await this.loadMeta(id)
        if (meta.kind !== 'upload') {
            throw createSessionError('Upload session required', 400)
        }
        if (index !== meta.nextIndex) {
            throw createSessionError(`Unexpected chunk index ${index}, expected ${meta.nextIndex}`, 409)
        }
        if (index >= meta.totalChunks) {
            throw createSessionError('Chunk index out of range', 400)
        }

        const asBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        await fs.appendFile(this.dataPath(id), asBuffer)
        meta.nextIndex += 1
        meta.receivedSize += asBuffer.length
        await this.saveMeta(id, meta)
        return meta
    }

    async finalizeUpload(id) {
        const meta = await this.loadMeta(id)
        if (meta.kind !== 'upload') {
            throw createSessionError('Upload session required', 400)
        }
        if (meta.nextIndex !== meta.totalChunks) {
            throw createSessionError(`Upload incomplete (${meta.nextIndex}/${meta.totalChunks})`, 409)
        }

        const data = await fs.readFile(this.dataPath(id))
        if (meta.size && data.length !== meta.size) {
            throw createSessionError(
                `Uploaded size mismatch: expected ${meta.size}, received ${data.length}`,
                409
            )
        }

        await this.cleanupSession(id)
        return {
            meta,
            data
        }
    }

    async createDownloadSession({
        purpose,
        key = '',
        data,
        contentType = 'application/octet-stream',
        chunkSize
    }) {
        await this.cleanupExpired()
        const asBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
        const normalizedChunkSize = normalizeChunkSize(chunkSize)
        const id = randomUUID()
        const meta = {
            id,
            kind: 'download',
            purpose,
            key,
            size: asBuffer.length,
            chunkSize: normalizedChunkSize,
            totalChunks: Math.max(1, Math.ceil(asBuffer.length / normalizedChunkSize)),
            contentType,
            createdAt: Date.now(),
            updatedAt: Date.now()
        }

        await this.saveMeta(id, meta)
        await fs.writeFile(this.dataPath(id), asBuffer)
        return meta
    }

    async readDownloadChunk(id, index) {
        const meta = await this.loadMeta(id)
        if (meta.kind !== 'download') {
            throw createSessionError('Download session required', 400)
        }
        if (index < 0 || index >= meta.totalChunks) {
            throw createSessionError('Chunk index out of range', 400)
        }

        const start = index * meta.chunkSize
        const end = Math.min(meta.size, start + meta.chunkSize)
        const length = Math.max(0, end - start)
        const fileHandle = await fs.open(this.dataPath(id), 'r')

        try {
            const chunk = Buffer.alloc(length)
            if (length > 0) {
                await fileHandle.read(chunk, 0, length, start)
            }
            await this.saveMeta(id, meta)
            return {
                meta,
                chunk
            }
        } finally {
            await fileHandle.close()
        }
    }
}

module.exports = {
    ChunkSessionStore,
    DEFAULT_CHUNK_SIZE
}
