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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const userId = req.query.userId as string
  if (!userId) return res.status(400).json({ error: 'userId is required' })

  try {
    const db = getPool()
    const result = await db.query(
      'SELECT api_id, api_hash, phone FROM tg_cloud_users WHERE user_id = $1',
      [userId]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User ID not found' })
    }

    const row = result.rows[0]
    return res.status(200).json({
      apiId: row.api_id,
      apiHash: row.api_hash,
      phone: row.phone,
    })
  } catch (err: any) {
    console.error('lookup error:', err)
    return res.status(500).json({ error: 'Database error. Please try again.' })
  }
}
