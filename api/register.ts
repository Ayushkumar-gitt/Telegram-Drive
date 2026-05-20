import type { VercelRequest, VercelResponse } from '@vercel/node'
import { Pool } from 'pg'

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

async function ensureTable(db: Pool) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS tg_cloud_users (
      user_id   VARCHAR(20)  PRIMARY KEY,
      api_id    INTEGER      NOT NULL,
      api_hash  TEXT         NOT NULL,
      phone     TEXT         NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { userId, apiId, apiHash, phone } = req.body ?? {}

  if (!userId || !apiId || !apiHash || !phone) {
    return res.status(400).json({ error: 'Missing required fields' })
  }
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(userId)) {
    return res.status(400).json({ error: 'Invalid userId: 3–20 chars, letters/numbers/_ only' })
  }

  try {
    const db = getPool()
    await ensureTable(db)

    // Check if userId already taken by a different phone
    const existing = await db.query(
      'SELECT phone FROM tg_cloud_users WHERE user_id = $1',
      [userId]
    )
    if (existing.rows.length > 0 && existing.rows[0].phone !== phone) {
      return res.status(409).json({ error: 'User ID already taken by another account' })
    }

    // Upsert (same phone = update credentials)
    await db.query(
      `INSERT INTO tg_cloud_users (user_id, api_id, api_hash, phone)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE
         SET api_id = EXCLUDED.api_id,
             api_hash = EXCLUDED.api_hash,
             phone = EXCLUDED.phone`,
      [userId, Number(apiId), apiHash, phone]
    )

    return res.status(200).json({ success: true })
  } catch (err: any) {
    console.error('register error:', err)
    return res.status(500).json({ error: 'Database error. Please try again.' })
  }
}
