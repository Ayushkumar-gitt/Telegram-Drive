/**
 * Local development API server.
 * Mirrors the Vercel serverless functions in /api/ so you can run
 * `npm run dev:api` alongside `npm run dev` for local testing.
 *
 * Reads DATABASE_URL from .env.local
 */

require('dotenv').config({ path: '.env.local' })

const express = require('express')
const cors = require('cors')
const { Pool } = require('pg')

const app = express()
app.use(cors())
app.use(express.json())

// ── DB pool ────────────────────────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  console.error('\n❌  DATABASE_URL is not set in .env.local')
  console.error('    Create .env.local and add:')
  console.error('    DATABASE_URL=postgresql://user:pass@host/db?sslmode=require\n')
  process.exit(1)
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

const crypto = require('crypto')

function hashPassword(password) {
  const salt = process.env.PASSWORD_SALT || 'starcloud-salt'
  return crypto.createHash('sha256').update(password + salt).digest('hex')
}

async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tg_cloud_users (
      user_id    VARCHAR(20)  PRIMARY KEY,
      api_id     INTEGER      NOT NULL,
      api_hash   TEXT         NOT NULL,
      phone      TEXT         NOT NULL,
      created_at TIMESTAMPTZ  DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sc_simple_users (
      user_id       VARCHAR(30)  PRIMARY KEY,
      email         TEXT         UNIQUE NOT NULL,
      password_hash TEXT         NOT NULL,
      created_at    TIMESTAMPTZ  DEFAULT NOW()
    )
  `)
}

// ── POST /api/register (Telegram users) ───────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { userId, apiId, apiHash, phone } = req.body ?? {}

  if (!userId || !apiId || !apiHash || !phone) {
    return res.status(400).json({ error: 'Missing required fields' })
  }
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(userId)) {
    return res.status(400).json({ error: 'Invalid userId: 3–20 chars, letters/numbers/_ only' })
  }

  try {
    await ensureTables()

    // Check if userId already exists
    const existingId = await pool.query(
      'SELECT user_id FROM tg_cloud_users WHERE user_id = $1', [userId]
    )
    if (existingId.rows.length > 0) {
      return res.status(409).json({ error: 'Account already exists with this User ID. Please go to Sign In.' })
    }

    // Check if phone number already registered
    const existingPhone = await pool.query(
      'SELECT user_id FROM tg_cloud_users WHERE phone = $1', [phone]
    )
    if (existingPhone.rows.length > 0) {
      return res.status(409).json({ error: `Account already exists with this phone number (User ID: ${existingPhone.rows[0].user_id}). Please go to Sign In.` })
    }

    await pool.query(
      `INSERT INTO tg_cloud_users (user_id, api_id, api_hash, phone) VALUES ($1, $2, $3, $4)`,
      [userId, Number(apiId), apiHash, phone]
    )

    console.log(`✅  Registered TG user: ${userId}`)
    return res.status(200).json({ success: true })
  } catch (err) {
    console.error('register error:', err.message)
    return res.status(500).json({ error: 'Database error. Check your DATABASE_URL.' })
  }
})

// ── GET /api/lookup (Telegram users) ──────────────────────────────────────
app.get('/api/lookup', async (req, res) => {
  const { userId } = req.query

  if (!userId) {
    return res.status(400).json({ error: 'userId is required' })
  }

  try {
    await ensureTables()

    const result = await pool.query(
      'SELECT api_id, api_hash, phone FROM tg_cloud_users WHERE user_id = $1',
      [userId]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User ID not found' })
    }

    const row = result.rows[0]
    console.log(`🔍  Lookup: ${userId}`)
    return res.status(200).json({
      apiId: row.api_id,
      apiHash: row.api_hash,
      phone: row.phone,
    })
  } catch (err) {
    console.error('lookup error:', err.message)
    return res.status(500).json({ error: 'Database error. Check your DATABASE_URL.' })
  }
})

// ── POST /api/user-register (Simple email+pass users) ─────────────────────
app.post('/api/user-register', async (req, res) => {
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
  if (!process.env.ADMIN_API_ID || !process.env.ADMIN_API_HASH || !process.env.ADMIN_SESSION_STRING) {
    return res.status(500).json({ error: 'Admin Telegram account not configured. Set ADMIN_API_ID, ADMIN_API_HASH, ADMIN_SESSION_STRING in .env.local' })
  }

  try {
    await ensureTables()

    const existingId = await pool.query('SELECT user_id FROM sc_simple_users WHERE user_id = $1', [userId])
    if (existingId.rows.length > 0) {
      return res.status(409).json({ error: 'This User ID is already taken. Please choose another.' })
    }

    const existingEmail = await pool.query('SELECT user_id FROM sc_simple_users WHERE email = $1', [email.toLowerCase()])
    if (existingEmail.rows.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists.' })
    }

    await pool.query(
      `INSERT INTO sc_simple_users (user_id, email, password_hash) VALUES ($1, $2, $3)`,
      [userId, email.toLowerCase(), hashPassword(password)]
    )

    console.log(`✅  Registered simple user: ${userId} (${email})`)
    return res.status(200).json({ success: true, userId })
  } catch (err) {
    console.error('user-register error:', err.message)
    return res.status(500).json({ error: 'Database error.' })
  }
})

// ── POST /api/user-login (Simple email+pass users) ────────────────────────
app.post('/api/user-login', async (req, res) => {
  const { email, password } = req.body ?? {}

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' })
  }
  if (!process.env.ADMIN_API_ID || !process.env.ADMIN_API_HASH || !process.env.ADMIN_SESSION_STRING) {
    return res.status(500).json({ error: 'Admin Telegram account not configured. Set ADMIN_API_ID, ADMIN_API_HASH, ADMIN_SESSION_STRING in .env.local' })
  }

  try {
    await ensureTables()

    const result = await pool.query(
      'SELECT user_id, password_hash FROM sc_simple_users WHERE email = $1',
      [email.toLowerCase()]
    )

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'No account found with this email.' })
    }

    const row = result.rows[0]
    if (row.password_hash !== hashPassword(password)) {
      return res.status(401).json({ error: 'Incorrect password.' })
    }

    console.log(`🔑  Simple login: ${row.user_id}`)
    return res.status(200).json({
      userId: row.user_id,
      adminApiId: Number(process.env.ADMIN_API_ID),
      adminApiHash: process.env.ADMIN_API_HASH,
      adminSessionString: process.env.ADMIN_SESSION_STRING,
    })
  } catch (err) {
    console.error('user-login error:', err.message)
    return res.status(500).json({ error: 'Database error.' })
  }
})

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = 3001
app.listen(PORT, () => {
  console.log(`\n🚀  API server running at http://localhost:${PORT}`)
  console.log('    /api/register       POST  (Telegram users)')
  console.log('    /api/lookup         GET   (Telegram users)')
  console.log('    /api/user-register  POST  (Simple email+pass users)')
  console.log('    /api/user-login     POST  (Simple email+pass users)\n')
})

