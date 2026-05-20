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
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-user-id, x-session-token')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const userId = req.headers['x-user-id'] as string
  if (!userId) return res.status(401).json({ error: 'Missing x-user-id header' })

  const { fileId } = req.query as { fileId: string }

  const db = getPool()
  const fileRes = await db.query(
    'SELECT * FROM sc_user_files WHERE id = $1 AND user_id = $2',
    [fileId, userId]
  )
  if (fileRes.rows.length === 0) {
    return res.status(404).json({ error: 'File not found' })
  }

  const file = fileRes.rows[0]
  const client = await getTelegramClient()

  const peer = new Api.InputPeerChannel({
    channelId: BigInt(file.channel_id.replace('-100', '')),
    accessHash: BigInt(file.access_hash ?? '0'),
  })

  const messages = await client.getMessages(peer, { ids: [file.message_id] })
  if (!messages?.length || !messages[0]) {
    await client.disconnect()
    return res.status(404).json({ error: 'File not found in Telegram' })
  }

  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`)
  res.setHeader('Content-Type', file.mime_type || 'application/octet-stream')

  const buffer = await client.downloadMedia(messages[0], {})
  await client.disconnect()

  if (!buffer) return res.status(500).json({ error: 'Failed to download from Telegram' })

  return res.end(Buffer.from(buffer as any))
}
