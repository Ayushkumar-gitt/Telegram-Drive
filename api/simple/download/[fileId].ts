import type { VercelRequest, VercelResponse } from '@vercel/node'
import { Pool } from 'pg'
import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'

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

  try {
    const peer = new Api.InputPeerChannel({
      channelId: BigInt(file.channel_id.replace('-100', '')),
      accessHash: BigInt(file.access_hash ?? '0'),
    })

    const messages = await client.getMessages(peer, { ids: [file.message_id] })
    if (!messages?.length || !messages[0]) {
      return res.status(404).json({ error: 'File not found in Telegram' })
    }

    const msg = messages[0]
    const media = msg.media

    if (!media) {
      return res.status(404).json({ error: 'No media attached to message' })
    }

    // Set response headers before streaming starts
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(file.name)}"`
    )
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream')
    if (file.size) {
      res.setHeader('Content-Length', String(file.size))
    }
    res.status(200)

    // Stream chunks (512 KB at a time) directly into the response.
    // iterDownload accepts a Message/Document/media object and
    // never loads the full file into memory — fixes the RAM limit error.
    for await (const chunk of client.iterDownload({
      file: media as any,
      requestSize: 512 * 1024, // 512 KB per Telegram request
    })) {
      res.write(chunk)
    }

    res.end()
  } catch (err: any) {
    console.error('download stream error:', err)
    if (!res.headersSent) {
      res.status(500).json({ error: err.message ?? 'Download failed' })
    } else {
      res.end()
    }
  } finally {
    await client.disconnect()
  }
}
