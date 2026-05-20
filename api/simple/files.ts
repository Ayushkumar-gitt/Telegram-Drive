import type { VercelRequest, VercelResponse } from '@vercel/node'
import { Pool } from 'pg'
import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-user-id, x-session-token')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const userId = req.headers['x-user-id'] as string
  if (!userId) return res.status(401).json({ error: 'Missing x-user-id header' })

  const db = getPool()
  await ensureTables(db)

  // ── GET /api/simple/files  (list files + folders for a user)
  if (req.method === 'GET') {
    const [filesRes, foldersRes] = await Promise.all([
      db.query(
        `SELECT id, name, size, mime_type AS "mimeType", created_at AS "createdAt",
                folder_id AS "folderId", message_id AS "messageId",
                channel_id AS "channelId", access_hash AS "accessHash",
                is_chunked AS "isChunked", chunk_ids AS "chunkMessageIds"
         FROM sc_user_files WHERE user_id = $1 ORDER BY created_at DESC`,
        [userId]
      ),
      db.query(
        `SELECT id, name, created_at AS "createdAt", channel_id AS "channelId", access_hash AS "accessHash"
         FROM sc_user_folders WHERE user_id = $1 AND name != '__root__' ORDER BY created_at ASC`,
        [userId]
      ),
    ])

    const files = filesRes.rows.map(f => ({
      ...f,
      chunkMessageIds: f.chunkMessageIds ? JSON.parse(f.chunkMessageIds) : undefined,
    }))

    return res.json({ files, folders: foldersRes.rows })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
