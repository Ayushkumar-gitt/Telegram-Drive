import type { VercelRequest, VercelResponse } from '@vercel/node'
import { Pool } from 'pg'
import { v4 as uuidv4 } from 'uuid'

/**
 * POST /api/simple/upload-meta
 *
 * Registers a multi-chunk upload manifest after all chunk parts have been
 * uploaded via /api/simple/upload-chunk. Saves a single 'manifest' row in
 * sc_user_files with is_chunked=TRUE and chunk_ids pointing to the chunk
 * part records.
 *
 * Body JSON:
 *   {
 *     name: string
 *     size: number          (total original file size)
 *     mimeType: string
 *     folderId: string | null
 *     messageId: number     (first chunk's message ID, for channel reference)
 *     channelId: string
 *     accessHash: string
 *     isChunked: true
 *     chunkIds: string[]    (sc_user_files IDs of the is_chunk_part records)
 *   }
 */

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
  await db.query(`
    ALTER TABLE sc_user_files
      ADD COLUMN IF NOT EXISTS is_chunk_part BOOLEAN DEFAULT FALSE
  `)
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-user-id, x-session-token')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const userId = req.headers['x-user-id'] as string
  if (!userId) return res.status(401).json({ error: 'Missing x-user-id header' })

  const {
    name,
    size,
    mimeType,
    folderId,
    messageId,
    channelId,
    accessHash,
    isChunked,
    chunkIds,        // array of sc_user_files UUIDs for the chunk part records
  } = req.body ?? {}

  if (!name || !messageId || !channelId) {
    return res.status(400).json({ error: 'Missing required fields: name, messageId, channelId' })
  }

  try {
    const db = getPool()
    await ensureTables(db)

    const fileId = uuidv4()

    await db.query(
      `INSERT INTO sc_user_files
         (id, user_id, name, size, mime_type, created_at, folder_id, message_id, channel_id, access_hash, is_chunked, chunk_ids, is_chunk_part)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, FALSE)`,
      [
        fileId,
        userId,
        name,
        size ?? 0,
        mimeType ?? 'application/octet-stream',
        Date.now(),
        folderId ?? null,
        messageId,
        channelId,
        accessHash ?? null,
        isChunked ?? false,
        chunkIds ? JSON.stringify(chunkIds) : null,
      ]
    )

    return res.status(200).json({
      success: true,
      file: {
        id: fileId,
        name,
        size: size ?? 0,
        mimeType: mimeType ?? 'application/octet-stream',
        createdAt: Date.now(),
        folderId: folderId ?? null,
        messageId,
        channelId,
        accessHash: accessHash ?? null,
        isChunked: isChunked ?? false,
        chunkIds: chunkIds ?? null,
      },
    })
  } catch (err: any) {
    console.error('upload-meta error:', err)
    return res.status(500).json({ error: err.message ?? 'Database error' })
  }
}
