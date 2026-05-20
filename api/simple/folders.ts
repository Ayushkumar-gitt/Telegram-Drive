import type { VercelRequest, VercelResponse } from '@vercel/node'
import { Pool } from 'pg'
import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { v4 as uuidv4 } from 'uuid'

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
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-user-id, x-session-token')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const userId = req.headers['x-user-id'] as string
  if (!userId) return res.status(401).json({ error: 'Missing x-user-id header' })

  const db = getPool()
  await ensureTables(db)

  // ── POST /api/simple/folders  (create a folder / Telegram channel)
  if (req.method === 'POST') {
    const { folderName } = req.body ?? {}
    if (!folderName?.trim()) return res.status(400).json({ error: 'folderName required' })

    const client = await getTelegramClient()

    const channelTitle = `SC_${userId}_${folderName.trim()}`.slice(0, 255)
    const result = await client.invoke(
      new Api.channels.CreateChannel({
        title: channelTitle,
        about: `Star Cloud folder for user ${userId}`,
        broadcast: true,
      })
    )

    const channel = (result as any).chats[0]
    const rawId = channel.id.toString()
    const channelId = rawId.startsWith('-100') ? rawId : `-100${rawId}`
    const accessHash = channel.accessHash.toString()
    await client.disconnect()

    const newFolder = {
      id: uuidv4(),
      name: folderName.trim(),
      createdAt: Date.now(),
      channelId,
      accessHash,
    }

    await db.query(
      `INSERT INTO sc_user_folders (id, user_id, name, created_at, channel_id, access_hash)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
      [newFolder.id, userId, newFolder.name, newFolder.createdAt, channelId, accessHash]
    )

    return res.json({ success: true, folder: newFolder })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
