/**
 * server.mjs  —  Railway production server
 * ──────────────────────────────────────────────────────────────────────────
 * Single Express process that handles EVERYTHING:
 *   • Serves the built React frontend (dist/)
 *   • All /api/* routes (auth, files, folders, upload, download)
 *   • One persistent Telegram client — never reconstructed per-request
 *
 * Railway gives us:
 *   ✅  No request-body size limit (only your RAM limits you)
 *   ✅  No execution-time limit (long uploads/downloads work fine)
 *   ✅  Persistent process (one TG client, always connected)
 *   ✅  Real filesystem for temp files (/tmp)
 *   ✅  Free HTTPS domain (*.up.railway.app)
 *
 * Pricing reality check (Hobby plan, $5/month):
 *   • 8 GB RAM / 8 vCPU max per service
 *   • $5 of usage included — a small always-on server costs ~$2–4/month
 *   • No body-size limit enforced by Railway (HTTP/HTTPS, no proxy cap)
 *   • No execution timeout
 * ──────────────────────────────────────────────────────────────────────────
 */

import { config } from 'dotenv'
config({ path: '.env.local' })  // local dev; Railway uses env vars directly

import express    from 'express'
import cors       from 'cors'
import { createHash }           from 'crypto'
import { join, dirname }        from 'path'
import { fileURLToPath }        from 'url'
import { v4 as uuidv4 }         from 'uuid'
import { Pool }                 from 'pg'
import { TelegramClient, Api }  from 'telegram'
import { StringSession }        from 'telegram/sessions/index.js'

const __dir  = dirname(fileURLToPath(import.meta.url))

// ── Postgres ──────────────────────────────────────────────────────────────
let _pool = null
function getPool() {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 10,
    })
  }
  return _pool
}

async function ensureTables() {
  const db = getPool()
  await db.query(`
    CREATE TABLE IF NOT EXISTS sc_simple_users (
      user_id       VARCHAR(30)  PRIMARY KEY,
      email         TEXT         UNIQUE NOT NULL,
      password_hash TEXT         NOT NULL,
      created_at    TIMESTAMPTZ  DEFAULT NOW()
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS sc_user_files (
      id             TEXT    PRIMARY KEY,
      user_id        TEXT    NOT NULL,
      name           TEXT    NOT NULL,
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
  await db.query(`ALTER TABLE sc_user_files ADD COLUMN IF NOT EXISTS is_chunk_part BOOLEAN DEFAULT FALSE`)
  await db.query(`
    CREATE TABLE IF NOT EXISTS sc_user_folders (
      id           TEXT    PRIMARY KEY,
      user_id      TEXT    NOT NULL,
      name         TEXT    NOT NULL,
      created_at   BIGINT,
      channel_id   TEXT,
      access_hash  TEXT
    )
  `)
}

// ── Telegram client (singleton, auto-reconnects) ──────────────────────────
let _tgClient = null

async function getTgClient() {
  if (_tgClient?.connected) return _tgClient

  const apiId     = Number(process.env.ADMIN_API_ID)
  const apiHash   = process.env.ADMIN_API_HASH
  const sessionStr = process.env.ADMIN_SESSION_STRING

  if (!apiId || !apiHash || !sessionStr) {
    throw new Error('Admin Telegram credentials not set. Add ADMIN_API_ID, ADMIN_API_HASH, ADMIN_SESSION_STRING as Railway environment variables.')
  }

  console.log('🔌  Connecting Telegram client…')
  const session = new StringSession(sessionStr)
  _tgClient = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 10,
    retryDelay: 2000,
    autoReconnect: true,
    useWSS: false,          // Node.js uses TCP — faster, no WebSocket issues
  })
  await _tgClient.connect()
  console.log('✅  Telegram client connected')
  return _tgClient
}

// ── Helpers ───────────────────────────────────────────────────────────────
function hashPassword(password) {
  return createHash('sha256')
    .update(password + (process.env.PASSWORD_SALT || 'starcloud-salt'))
    .digest('hex')
}

function requireUser(req, res, next) {
  const userId = req.headers['x-user-id']
  if (!userId) return res.status(401).json({ error: 'Missing x-user-id header' })
  req.userId = userId
  next()
}

async function resolveOrCreateRootChannel(userId, client, db) {
  const root = await db.query(
    `SELECT channel_id, access_hash FROM sc_user_folders WHERE user_id = $1 AND name = '__root__'`,
    [userId]
  )
  if (root.rows.length > 0) return root.rows[0]

  const result = await client.invoke(new Api.channels.CreateChannel({
    title: `StarCloud_Meta_${userId}`,
    about: `Star Cloud storage for user ${userId}`,
    broadcast: true,
  }))
  const ch = result.chats[0]
  const rawId = ch.id.toString()
  const channelId   = rawId.startsWith('-100') ? rawId : `-100${rawId}`
  const accessHash  = ch.accessHash.toString()

  await db.query(
    `INSERT INTO sc_user_folders (id, user_id, name, created_at, channel_id, access_hash)
     VALUES ($1, $2, '__root__', $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
    [uuidv4(), userId, Date.now(), channelId, accessHash]
  )
  return { channel_id: channelId, access_hash: accessHash }
}

// ── Express setup ─────────────────────────────────────────────────────────
const app = express()

app.use(cors({
  origin: '*',
  allowedHeaders: ['Content-Type', 'x-user-id', 'x-session-token', 'Authorization'],
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
}))
app.use(express.json({ limit: '1mb' }))  // All bodies are tiny JSON — no file uploads here

// ── ──────────────────────────────────────────────────────────────────────
//  AUTH ROUTES
// ── ──────────────────────────────────────────────────────────────────────

// POST /api/user-register
app.post('/api/user-register', async (req, res) => {
  const { userId, email, password } = req.body ?? {}
  if (!userId || !email || !password)
    return res.status(400).json({ error: 'Missing required fields' })
  if (!/^[a-zA-Z0-9_]{3,30}$/.test(userId))
    return res.status(400).json({ error: 'User ID: 3–30 chars, letters/numbers/underscore only' })
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' })
  if (!process.env.ADMIN_API_ID)
    return res.status(500).json({ error: 'Admin Telegram account not configured.' })

  try {
    const db = getPool()
    const existId = await db.query('SELECT user_id FROM sc_simple_users WHERE user_id = $1', [userId])
    if (existId.rows.length > 0)
      return res.status(409).json({ error: 'This User ID is already taken.' })
    const existEmail = await db.query('SELECT user_id FROM sc_simple_users WHERE email = $1', [email.toLowerCase()])
    if (existEmail.rows.length > 0)
      return res.status(409).json({ error: 'An account with this email already exists.' })

    await db.query(
      `INSERT INTO sc_simple_users (user_id, email, password_hash) VALUES ($1, $2, $3)`,
      [userId, email.toLowerCase(), hashPassword(password)]
    )
    return res.json({ success: true, userId })
  } catch (err) {
    console.error('register error:', err)
    return res.status(500).json({ error: 'Database error.' })
  }
})

// POST /api/user-login
app.post('/api/user-login', async (req, res) => {
  const { email, password } = req.body ?? {}
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password are required' })
  if (!process.env.ADMIN_API_ID)
    return res.status(500).json({ error: 'Admin Telegram account not configured.' })

  try {
    const db = getPool()
    const result = await db.query(
      'SELECT user_id, password_hash FROM sc_simple_users WHERE email = $1',
      [email.toLowerCase()]
    )
    if (result.rows.length === 0)
      return res.status(401).json({ error: 'No account found with this email.' })

    const row = result.rows[0]
    if (row.password_hash !== hashPassword(password))
      return res.status(401).json({ error: 'Incorrect password.' })

    // Return admin TG credentials so the browser can upload/download
    // DIRECTLY to Telegram — bypassing Railway entirely for file data.
    // This eliminates Railway egress charges on uploads/downloads.
    return res.json({
      userId:             row.user_id,
      adminApiId:         Number(process.env.ADMIN_API_ID),
      adminApiHash:       process.env.ADMIN_API_HASH,
      adminSessionString: process.env.ADMIN_SESSION_STRING,
    })
  } catch (err) {
    console.error('login error:', err)
    return res.status(500).json({ error: 'Database error.' })
  }
})

// ── ──────────────────────────────────────────────────────────────────────
//  FILE & FOLDER ROUTES
// ── ──────────────────────────────────────────────────────────────────────

// GET /api/simple/files
app.get('/api/simple/files', requireUser, async (req, res) => {
  try {
    const db = getPool()
    const [filesRes, foldersRes] = await Promise.all([
      db.query(
        `SELECT id, name, size, mime_type AS "mimeType", created_at AS "createdAt",
                folder_id AS "folderId", message_id AS "messageId",
                channel_id AS "channelId", access_hash AS "accessHash",
                is_chunked AS "isChunked", chunk_ids AS "chunkIds"
         FROM sc_user_files
         WHERE user_id = $1
           AND (is_chunk_part IS NULL OR is_chunk_part = FALSE)
         ORDER BY created_at DESC`,
        [req.userId]
      ),
      db.query(
        `SELECT id, name, created_at AS "createdAt",
                channel_id AS "channelId", access_hash AS "accessHash"
         FROM sc_user_folders
         WHERE user_id = $1 AND name != '__root__'
         ORDER BY created_at DESC`,
        [req.userId]
      ),
    ])
    return res.json({ files: filesRes.rows, folders: foldersRes.rows })
  } catch (err) {
    console.error('list files error:', err)
    return res.status(500).json({ error: err.message })
  }
})

// GET /api/simple/root-channel  — ensure root storage channel exists & return its coords
// Called by the browser before uploading so it knows which TG channel to send to.
app.get('/api/simple/root-channel', requireUser, async (req, res) => {
  try {
    const client = await getTgClient()
    const db = getPool()
    const channel = await resolveOrCreateRootChannel(req.userId, client, db)
    return res.json({
      channelId:  channel.channel_id,
      accessHash: channel.access_hash,
    })
  } catch (err) {
    console.error('root-channel error:', err)
    return res.status(500).json({ error: err.message })
  }
})

// POST /api/simple/files  — save file metadata after a direct browser→Telegram upload
// The browser uploads the file bytes directly to Telegram (zero Railway egress),
// then POSTs only the tiny metadata record here so we persist it in the DB.
app.post('/api/simple/files', requireUser, async (req, res) => {
  const { id, name, size, mimeType, createdAt, folderId,
          messageId, channelId, accessHash, isChunked, chunkMessageIds } = req.body ?? {}
  if (!id || !name || !messageId || !channelId)
    return res.status(400).json({ error: 'id, name, messageId, channelId are required' })
  try {
    const db = getPool()
    await db.query(
      `INSERT INTO sc_user_files
         (id, user_id, name, size, mime_type, created_at, folder_id,
          message_id, channel_id, access_hash, is_chunked, chunk_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO NOTHING`,
      [
        id, req.userId, name, size ?? 0, mimeType ?? 'application/octet-stream',
        createdAt ?? Date.now(), folderId ?? null,
        messageId, channelId, accessHash ?? null,
        isChunked ?? false,
        chunkMessageIds ? JSON.stringify(chunkMessageIds) : null,
      ]
    )
    return res.json({ ok: true, id })
  } catch (err) {
    console.error('save-file-meta error:', err)
    return res.status(500).json({ error: err.message })
  }
})

// POST /api/simple/folders  — create folder + Telegram channel
app.post('/api/simple/folders', requireUser, async (req, res) => {
  const { folderName } = req.body ?? {}
  if (!folderName?.trim()) return res.status(400).json({ error: 'folderName required' })

  try {
    const client = await getTgClient()
    const db = getPool()

    const channelTitle = `SC_${req.userId}_${folderName.trim()}`.slice(0, 255)
    const result = await client.invoke(new Api.channels.CreateChannel({
      title: channelTitle,
      about: `Star Cloud folder for user ${req.userId}`,
      broadcast: true,
    }))
    const ch = result.chats[0]
    const rawId = ch.id.toString()
    const channelId  = rawId.startsWith('-100') ? rawId : `-100${rawId}`
    const accessHash = ch.accessHash.toString()

    const newFolder = { id: uuidv4(), name: folderName.trim(), createdAt: Date.now(), channelId, accessHash }
    await db.query(
      `INSERT INTO sc_user_folders (id, user_id, name, created_at, channel_id, access_hash) VALUES ($1,$2,$3,$4,$5,$6)`,
      [newFolder.id, req.userId, newFolder.name, newFolder.createdAt, channelId, accessHash]
    )
    return res.json({ success: true, folder: newFolder })
  } catch (err) {
    console.error('create folder error:', err)
    return res.status(500).json({ error: err.message })
  }
})

// DELETE /api/simple/folders/:folderId
app.delete('/api/simple/folders/:folderId', requireUser, async (req, res) => {
  try {
    const db = getPool()
    const folderRes = await db.query(
      'SELECT id FROM sc_user_folders WHERE id = $1 AND user_id = $2',
      [req.params.folderId, req.userId]
    )
    if (folderRes.rows.length === 0)
      return res.status(404).json({ error: 'Folder not found' })

    await db.query('DELETE FROM sc_user_files WHERE folder_id = $1 AND user_id = $2', [req.params.folderId, req.userId])
    await db.query('DELETE FROM sc_user_folders WHERE id = $1 AND user_id = $2', [req.params.folderId, req.userId])
    return res.json({ success: true })
  } catch (err) {
    console.error('delete folder error:', err)
    return res.status(500).json({ error: err.message })
  }
})

// DELETE /api/simple/files/:fileId
app.delete('/api/simple/files/:fileId', requireUser, async (req, res) => {
  try {
    const db = getPool()
    const fileRes = await db.query(
      'SELECT * FROM sc_user_files WHERE id = $1 AND user_id = $2',
      [req.params.fileId, req.userId]
    )
    if (fileRes.rows.length === 0)
      return res.status(404).json({ error: 'File not found' })

    const file = fileRes.rows[0]

    // Delete chunk parts too (if chunked)
    if (file.is_chunked && file.chunk_ids) {
      try {
        const ids = JSON.parse(file.chunk_ids)
        // Delete chunk part DB records; Telegram messages are cleaned up below
        await db.query(`DELETE FROM sc_user_files WHERE id = ANY($1::text[])`, [ids])
      } catch {}
    }

    // Delete the Telegram message (best-effort)
    try {
      const client = await getTgClient()
      const peer = new Api.InputPeerChannel({
        channelId: BigInt(file.channel_id.replace('-100', '')),
        accessHash: BigInt(file.access_hash ?? '0'),
      })
      await client.invoke(new Api.channels.DeleteMessages({ channel: peer, id: [file.message_id] }))
    } catch (e) {
      console.warn('Could not delete TG message:', e.message)
    }

    await db.query('DELETE FROM sc_user_files WHERE id = $1 AND user_id = $2', [req.params.fileId, req.userId])
    return res.json({ success: true })
  } catch (err) {
    console.error('delete file error:', err)
    return res.status(500).json({ error: err.message })
  }
})

// ── ──────────────────────────────────────────────────────────────────────
//  HEALTH CHECK  (Railway pings this to confirm server is ready)
// ── ──────────────────────────────────────────────────────────────────────
//
// NOTE: Upload and download routes have been REMOVED intentionally.
// File bytes never touch Railway — the browser uploads/downloads
// directly to Telegram via GramJS (MTProto WebSocket from browser).
// Railway only handles tiny JSON: auth, metadata, folder ops.
// This eliminates Railway egress charges on file data entirely.
//
// Frontend is served from Cloudflare Pages (free, unlimited bandwidth).
// Railway is a pure JSON API server — egress cost is effectively $0.

// ── Health check ──────────────────────────────────────────────────────────
// Railway pings this after every deploy to confirm the server is ready.
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }))

// ── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000   // Railway sets PORT automatically

async function start() {
  try {
    await ensureTables()
    await getTgClient()  // pre-connect on startup so first request is instant

    app.listen(PORT, () => {
      console.log(`\n⭐  Star Cloud API server running on port ${PORT}`)
      console.log('    Architecture: Browser ↔ Telegram directly (zero Railway egress for files)')
      console.log('    POST /api/user-register       — register')
      console.log('    POST /api/user-login           — login (returns TG creds for direct access)')
      console.log('    GET  /api/simple/files         — list files + folders')
      console.log('    GET  /api/simple/root-channel  — get/create root TG channel')
      console.log('    POST /api/simple/files         — save file metadata after direct TG upload')
      console.log('    POST /api/simple/folders       — create folder')
      console.log('    DEL  /api/simple/files/:id     — delete file')
      console.log('    DEL  /api/simple/folders/:id   — delete folder')
      console.log('    GET  /api/health               — healthcheck\n')
    })
  } catch (err) {
    console.error('❌  Startup failed:', err.message)
    console.error('    Check ADMIN_API_ID, ADMIN_API_HASH, ADMIN_SESSION_STRING, DATABASE_URL')
    process.exit(1)
  }
}

// Graceful shutdown
process.on('SIGTERM', () => { console.log('SIGTERM received — shutting down'); process.exit(0) })
process.on('SIGINT',  () => { console.log('SIGINT received — shutting down');  process.exit(0) })

start()
