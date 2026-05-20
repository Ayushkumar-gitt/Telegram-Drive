import type { VercelRequest, VercelResponse } from '@vercel/node'
import { Pool } from 'pg'
import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { v4 as uuidv4 } from 'uuid'
import formidable from 'formidable'
import { createReadStream } from 'fs'
import { unlink } from 'fs/promises'

// Vercel functions need explicit body parser disabled for multipart
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
  await db.query(`
    CREATE TABLE IF NOT EXISTS sc_user_files (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      name         TEXT NOT NULL,
      size         BIGINT,
      mime_type    TEXT,
      created_at   BIGINT,
      folder_id    TEXT,
      message_id   INT,
      channel_id   TEXT,
      access_hash  TEXT,
      is_chunked   BOOLEAN DEFAULT FALSE,
      chunk_ids    TEXT
    )
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
  const form = formidable({ maxFileSize: 2 * 1024 * 1024 * 1024, keepExtensions: true })
  return new Promise((resolve, reject) => {
    form.parse(req as any, (err, fields, files) => {
      if (err) reject(err)
      else resolve({ fields, files })
    })
  })
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-user-id, x-session-token')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const userId = req.headers['x-user-id'] as string
  if (!userId) return res.status(401).json({ error: 'Missing x-user-id header' })

  // Set up SSE streaming
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('X-Accel-Buffering', 'no')

  const send = (data: object) => {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    } catch {}
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
    const folderId = Array.isArray(fields.folderId) ? fields.folderId[0] : fields.folderId

    const db = getPool()
    await ensureTables(db)

    // Determine target channel
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
      // Use or create root channel
      const rootRes = await db.query(
        `SELECT channel_id, access_hash FROM sc_user_folders WHERE user_id = $1 AND name = '__root__'`,
        [userId]
      )
      if (rootRes.rows.length > 0) {
        targetChannelId = rootRes.rows[0].channel_id
        targetAccessHash = rootRes.rows[0].access_hash
      } else {
        // Create a root channel for this user
        const client = await getTelegramClient()
        const rootChannelName = `StarCloud_Meta_${userId}`
        const result = await client.invoke(
          new Api.channels.CreateChannel({
            title: rootChannelName,
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

    const client = await getTelegramClient()
    const peer = new Api.InputPeerChannel({
      channelId: BigInt(targetChannelId.replace('-100', '')),
      accessHash: BigInt(targetAccessHash ?? '0'),
    })

    const mimeType = uploadedFile.mimetype ?? 'application/octet-stream'
    const originalName = uploadedFile.originalFilename ?? uploadedFile.newFilename

    // Import CustomFile from GramJS for server-side file upload
    const { CustomFile } = await import('telegram/client/uploads.js')
    const customFile = new CustomFile(originalName, uploadedFile.size ?? 0, tmpPath)

    send({ type: 'progress', pct: 1 })

    let lastPct = 0
    const result = await client.sendFile(peer, {
      file: customFile,
      caption: originalName,
      forceDocument: true,
      workers: 4,
      progressCallback: (fraction: number) => {
        const pct = Math.round(fraction * 100)
        if (pct > lastPct) {
          lastPct = pct
          send({ type: 'progress', pct })
        }
      },
    })

    await client.disconnect()

    const messageId = (result as any)?.id ?? 0
    const fileId = uuidv4()

    await db.query(
      `INSERT INTO sc_user_files
         (id, user_id, name, size, mime_type, created_at, folder_id, message_id, channel_id, access_hash, is_chunked)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, FALSE)`,
      [
        fileId,
        userId,
        originalName,
        uploadedFile.size ?? 0,
        mimeType,
        Date.now(),
        folderId ?? null,
        messageId,
        targetChannelId,
        targetAccessHash,
      ]
    )

    if (tmpPath) await unlink(tmpPath).catch(() => {})

    send({
      type: 'done',
      file: {
        id: fileId,
        name: originalName,
        size: uploadedFile.size,
        mimeType,
        createdAt: Date.now(),
        folderId: folderId ?? null,
        messageId,
        channelId: targetChannelId,
        accessHash: targetAccessHash,
        isChunked: false,
      },
    })
    res.end()
  } catch (err: any) {
    console.error('upload error:', err)
    if (tmpPath) await unlink(tmpPath).catch(() => {})
    send({ type: 'error', error: err.message ?? 'Upload failed' })
    res.end()
  }
}
