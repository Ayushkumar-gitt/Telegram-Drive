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

async function ensureTable(db: Pool) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS sc_simple_users (
      user_id      VARCHAR(30)  PRIMARY KEY,
      email        TEXT         UNIQUE NOT NULL,
      password_hash TEXT        NOT NULL,
      created_at   TIMESTAMPTZ  DEFAULT NOW()
    )
  `)
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { userId, email, password } = req.body ?? {}

  if (!userId || !email || !password) {
    return res.status(400).json({ error: 'Missing required fields' })
  }
  if (!/^[a-zA-Z0-9_]{3,30}$/.test(userId)) {
    return res.status(400).json({ error: 'User ID: 3–30 chars, letters/numbers/underscore only' })
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' })
  }

  // Verify admin credentials are configured
  if (!process.env.ADMIN_API_ID || !process.env.ADMIN_API_HASH || !process.env.ADMIN_SESSION_STRING) {
    return res.status(500).json({ error: 'Admin Telegram account not configured. Contact the administrator.' })
  }

  try {
    const db = getPool()
    await ensureTable(db)

    // Check userId uniqueness
    const existingId = await db.query('SELECT user_id FROM sc_simple_users WHERE user_id = $1', [userId])
    if (existingId.rows.length > 0) {
      return res.status(409).json({ error: 'This User ID is already taken. Please choose another.' })
    }

    // Check email uniqueness
    const existingEmail = await db.query('SELECT user_id FROM sc_simple_users WHERE email = $1', [email.toLowerCase()])
    if (existingEmail.rows.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists.' })
    }

    const passwordHash = hashPassword(password)

    await db.query(
      `INSERT INTO sc_simple_users (user_id, email, password_hash) VALUES ($1, $2, $3)`,
      [userId, email.toLowerCase(), passwordHash]
    )

    return res.status(200).json({ success: true, userId })
  } catch (err: any) {
    console.error('user-register error:', err)
    return res.status(500).json({ error: 'Database error. Please try again.' })
  }
}
