import type { VercelRequest, VercelResponse } from '@vercel/node'
import { Pool } from 'pg'
import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { v4 as uuidv4 } from 'uuid'
import formidable from 'formidable'
import { unlink } from 'fs/promises'

/**
 * POST /api/simple/upload-chunk
 *
 * Receives a single file chunk (≤ 3.5 MB) from the browser, uploads it to
 * Telegram server-side, and saves a record in Postgres.
 *
 * For single-file uploads (totalParts === 1): record is a normal file.
 * For multi-chunk uploads (totalParts > 1): record is marked is_chunk_part=true
 *   so it's hidden from the file listing but retrievable for assembly.
 *
 * Form fields:
 *   file        - the chunk blob
 *   folderId    - optional folder ID (only used for part 0)
 *   partIndex   - 0-based index of this chunk
 *   totalParts  - total number of chunks in this upload
 *   origName    - original filename (before .partN suffix)
 *   origSize    - original file's total byte size
 *   origMime    - original file's MIME type
 *
 * Returns SSE: { type: 'progress', pct } … { type: 'done', file: {...} }
 */

export const config = { api: { bodyParser: false } }

let pool: Pool | null = null
function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  }
  return pool
}

async function ensureTables(db: Pool) {
  // Base table (idempotent)
  await db.query(`
    CREATE TABLE IF NOT EXISTS sc_user_files (
      id             TEXT PRIMARY KEY,
      user_id        TEXT NOT NULL,
      name           TEXT NOT NULL,
      size           BIGINT,
      mime_type      TEXT,
      created_at     BIGINT,
      folder_id      TEXT,
      message_id     INT,
      channel_id     TEXT,
      access_hash    TEXT,
      is_chunked     BOOLEAN DEFAULT FALSE,
      chunk_ids      TEXT,
      is_chunk_part  BOOLEAN DEFAULT FALSE
    )
  `)
  // Safe migration: add column if the table already existed without it
  await db.query(`
    ALTER TABLE sc_user_files
      ADD COLUMN IF NOT EXISTS is_chunk_part BOOLEAN DEFAULT FALSE
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS sc_user_folders (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      name         TEXT NOT NULL,
      created_at   BIGINT,
      channel_id   TEXT,
      access_hash  TEXT
    )
  `)
}

async function getTelegramClient(): Promise<TelegramClient> {
  const apiId = Number(process.env.ADMIN_API_ID)
  const apiHash = process.env.ADMIN_API_HASH!
  const sessionStr = process.env.ADMIN_SESSION_STRING!
  const session = new StringSession(sessionStr)
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
    retryDelay: 1000,
    autoReconnect: true,
  })
  await client.connect()
  return client
}

function parseForm(req: VercelRequest): Promise<{ fields: formidable.Fields; files: formidable.Files }> {
  // Max 4 MB per chunk (well under Vercel's 4.5 MB limit)
  const form = formidable({ maxFileSize: 4 * 1024 * 1024, keepExtensions: true })
  return new Promise((resolve, reject) => {
    form.parse(req as any, (err, fields, files) => {
      if (err) reject(err)
      else resolve({ fields, files })
    })
  })
}

function field(fields: formidable.Fields, key: string): string | undefined {
  const v = fields[key]
  return Array.isArray(v) ? v[0] : v
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-user-id, x-session-token')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const userId = req.headers['x-user-id'] as string
  if (!userId) return res.status(401).json({ error: 'Missing x-user-id header' })

  // SSE setup
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('X-Accel-Buffering', 'no')

  const send = (data: object) => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`) } catch {}
  }

  let tmpPath: string | undefined

  try {
    const { fields, files } = await parseForm(req)
    const uploadedFile = Array.isArray(files.file) ? files.file[0] : files.file
    if (!uploadedFile) {
      send({ type: 'error', error: 'No file provided' })
      return res.end()
    }

    tmpPath = uploadedFile.filepath

    const partIndex  = parseInt(field(fields, 'partIndex')  ?? '0', 10)
    const totalParts = parseInt(field(fields, 'totalParts') ?? '1', 10)
    const origName   = field(fields, 'origName') ?? uploadedFile.originalFilename ?? uploadedFile.newFilename
    const origSize   = parseInt(field(fields, 'origSize') ?? String(uploadedFile.size ?? 0), 10)
    const origMime   = field(fields, 'origMime') ?? uploadedFile.mimetype ?? 'application/octet-stream'
    const folderId   = field(fields, 'folderId') ?? null

    const isChunkPart = totalParts > 1

    const db = getPool()
    await ensureTables(db)

    // ── Resolve target channel ──────────────────────────────────────────────
    let targetChannelId: string
    let targetAccessHash: string

    if (folderId) {
      const folderRes = await db.query(
        'SELECT channel_id, access_hash FROM sc_user_folders WHERE id = $1 AND user_id = $2',
        [folderId, userId]
      )
      if (folderRes.rows.length === 0) {
        send({ type: 'error', error: 'Folder not found' })
        return res.end()
      }
      targetChannelId = folderRes.rows[0].channel_id
      targetAccessHash = folderRes.rows[0].access_hash
    } else {
      const rootRes = await db.query(
        `SELECT channel_id, access_hash FROM sc_user_folders WHERE user_id = $1 AND name = '__root__'`,
        [userId]
      )
      if (rootRes.rows.length > 0) {
        targetChannelId = rootRes.rows[0].channel_id
        targetAccessHash = rootRes.rows[0].access_hash
      } else {
        // Create root channel for this user
        const client = await getTelegramClient()
        const result = await client.invoke(
          new Api.channels.CreateChannel({
            title: `StarCloud_Meta_${userId}`,
            about: `Star Cloud storage for user ${userId}`,
            broadcast: true,
          })
        )
        const ch = (result as any).chats[0]
        const rawId = ch.id.toString()
        targetChannelId = rawId.startsWith('-100') ? rawId : `-100${rawId}`
        targetAccessHash = ch.accessHash.toString()
        await db.query(
          `INSERT INTO sc_user_folders (id, user_id, name, created_at, channel_id, access_hash)
           VALUES ($1, $2, '__root__', $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
          [uuidv4(), userId, Date.now(), targetChannelId, targetAccessHash]
        )
        await client.disconnect()
      }
    }

    // ── Upload chunk to Telegram ────────────────────────────────────────────
    const client = await getTelegramClient()
    const peer = new Api.InputPeerChannel({
      channelId: BigInt(targetChannelId.replace('-100', '')),
      accessHash: BigInt(targetAccessHash ?? '0'),
    })

    // Use the chunk's actual filename for the Telegram caption
    const chunkDisplayName = isChunkPart
      ? `${origName}.part${partIndex + 1}`
      : origName

    const { CustomFile } = await import('telegram/client/uploads.js')
    const customFile = new CustomFile(
      chunkDisplayName,
      uploadedFile.size ?? 0,
      tmpPath
    )

    send({ type: 'progress', pct: 5 })

    let lastPct = 5
    const result = await client.sendFile(peer, {
      file: customFile,
      caption: chunkDisplayName,
      forceDocument: true,
      workers: 2,
      progressCallback: (fraction: number) => {
        const pct = 5 + Math.round(fraction * 90)
        if (pct > lastPct) { lastPct = pct; send({ type: 'progress', pct }) }
      },
    })

    await client.disconnect()

    const messageId = (result as any)?.id ?? 0
    const fileId = uuidv4()

    // ── Persist to Postgres ─────────────────────────────────────────────────
    // For a chunk part, store the CHUNK size (not the original file size).
    // For a single-file upload, store the actual file size.
    const storedSize = isChunkPart ? (uploadedFile.size ?? 0) : origSize
    const storedName = isChunkPart ? chunkDisplayName : origName
    const storedMime = origMime

    await db.query(
      `INSERT INTO sc_user_files
         (id, user_id, name, size, mime_type, created_at, folder_id,
          message_id, channel_id, access_hash, is_chunked, is_chunk_part)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, FALSE, $11)`,
      [
        fileId, userId, storedName, storedSize, storedMime,
        Date.now(), folderId ?? null,
        messageId, targetChannelId, targetAccessHash,
        isChunkPart,
      ]
    )

    if (tmpPath) await unlink(tmpPath).catch(() => {})

    send({
      type: 'done',
      file: {
        id: fileId,
        name: storedName,
        origName,
        size: storedSize,
        origSize,
        mimeType: storedMime,
        createdAt: Date.now(),
        folderId: folderId ?? null,
        messageId,
        channelId: targetChannelId,
        accessHash: targetAccessHash,
        isChunked: false,
        isChunkPart,
      },
    })
    res.end()
  } catch (err: any) {
    console.error('upload-chunk error:', err)
    if (tmpPath) await unlink(tmpPath).catch(() => {})
    send({ type: 'error', error: err.message ?? 'Upload failed' })
    res.end()
  }
}
