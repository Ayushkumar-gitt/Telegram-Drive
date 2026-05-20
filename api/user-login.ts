import type { VercelRequest, VercelResponse } from '@vercel/node'
import { Pool } from 'pg'
import { createHash } from 'crypto'

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

function hashPassword(password: string): string {
  return createHash('sha256').update(password + (process.env.PASSWORD_SALT || 'starcloud-salt')).digest('hex')
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { email, password } = req.body ?? {}

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' })
  }

  if (!process.env.ADMIN_API_ID || !process.env.ADMIN_API_HASH || !process.env.ADMIN_SESSION_STRING) {
    return res.status(500).json({ error: 'Admin Telegram account not configured. Contact the administrator.' })
  }

  try {
    const db = getPool()
    const result = await db.query(
      'SELECT user_id, password_hash FROM sc_simple_users WHERE email = $1',
      [email.toLowerCase()]
    )

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'No account found with this email.' })
    }

    const row = result.rows[0]
    const expectedHash = hashPassword(password)

    if (row.password_hash !== expectedHash) {
      return res.status(401).json({ error: 'Incorrect password.' })
    }

    // Return admin credentials — client will use these to connect to Telegram
    return res.status(200).json({
      userId: row.user_id,
      adminApiId: Number(process.env.ADMIN_API_ID),
      adminApiHash: process.env.ADMIN_API_HASH,
      adminSessionString: process.env.ADMIN_SESSION_STRING,
    })
  } catch (err: any) {
    console.error('user-login error:', err)
    return res.status(500).json({ error: 'Database error. Please try again.' })
  }
}
