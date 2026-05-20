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

/**
 * Download one Telegram message's media and stream it into `res`.
 * Uses iterDownload so the whole file is never buffered in RAM.
 */
async function streamTelegramMedia(
  client: TelegramClient,
  channelId: string,
  accessHash: string,
  messageId: number,
  res: VercelResponse
): Promise<void> {
  const peer = new Api.InputPeerChannel({
    channelId: BigInt(channelId.replace('-100', '')),
    accessHash: BigInt(accessHash ?? '0'),
  })

  const messages = await client.getMessages(peer, { ids: [messageId] })
  if (!messages?.length || !messages[0]) {
    throw new Error(`Message ${messageId} not found in Telegram`)
  }

  const media = messages[0].media
  if (!media) throw new Error('No media in message')

  for await (const chunk of client.iterDownload({
    file: media as any,
    requestSize: 512 * 1024, // 512 KB per request
  })) {
    res.write(chunk)
  }
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

  // ── Look up the file record ─────────────────────────────────────────────
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
    // Set response headers before streaming
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(file.name)}"`
    )
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream')
    if (file.size) res.setHeader('Content-Length', String(file.size))
    res.status(200)

    if (file.is_chunked && file.chunk_ids) {
      // ── Chunked file: stream each chunk in order ────────────────────────
      let chunkIds: string[]
      try {
        chunkIds = JSON.parse(file.chunk_ids)
      } catch {
        throw new Error('Corrupt chunk_ids metadata')
      }

      for (const chunkId of chunkIds) {
        const chunkRes = await db.query(
          'SELECT * FROM sc_user_files WHERE id = $1',
          [chunkId]
        )
        if (chunkRes.rows.length === 0) {
          throw new Error(`Chunk record ${chunkId} not found`)
        }
        const chunk = chunkRes.rows[0]
        await streamTelegramMedia(
          client,
          chunk.channel_id,
          chunk.access_hash ?? '0',
          chunk.message_id,
          res
        )
      }
    } else {
      // ── Single-file download ────────────────────────────────────────────
      await streamTelegramMedia(
        client,
        file.channel_id,
        file.access_hash ?? '0',
        file.message_id,
        res
      )
    }

    res.end()
  } catch (err: any) {
    console.error('download error:', err)
    if (!res.headersSent) {
      res.status(500).json({ error: err.message ?? 'Download failed' })
    } else {
      res.end()
    }
  } finally {
    await client.disconnect()
  }
}
