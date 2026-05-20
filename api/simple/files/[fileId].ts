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
  res.setHeader('Access-Control-Allow-Methods', 'DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-user-id, x-session-token')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' })

  const userId = req.headers['x-user-id'] as string
  if (!userId) return res.status(401).json({ error: 'Missing x-user-id header' })

  const { fileId } = req.query as { fileId: string }

  const db = getPool()
  await ensureTables(db)

  const fileRes = await db.query(
    `SELECT * FROM sc_user_files WHERE id = $1 AND user_id = $2`,
    [fileId, userId]
  )
  if (fileRes.rows.length === 0) {
    return res.status(404).json({ error: 'File not found' })
  }

  const file = fileRes.rows[0]

  // Try to delete the Telegram message
  try {
    const client = await getTelegramClient()
    const peer = new Api.InputPeerChannel({
      channelId: BigInt(file.channel_id.replace('-100', '')),
      accessHash: BigInt(file.access_hash ?? '0'),
    })
    await client.invoke(new Api.channels.DeleteMessages({ channel: peer, id: [file.message_id] }))
    await client.disconnect()
  } catch (e: any) {
    console.warn('Could not delete TG message:', e.message)
  }

  await db.query('DELETE FROM sc_user_files WHERE id = $1 AND user_id = $2', [fileId, userId])

  return res.json({ success: true })
}
