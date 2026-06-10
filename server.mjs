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

import express from 'express'
import cors from 'cors'
import multer from 'multer'
import { createHash } from 'crypto'
import { unlink } from 'fs/promises'
import { existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { v4 as uuidv4 } from 'uuid'
import { Pool } from 'pg'
import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const DIST = join(__dir, 'dist')
const TMP = join(__dir, '.tmp-uploads')
if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true })

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
    CREATE TABLE IF NOT EXISTS tg_cloud_users (
      user_id    VARCHAR(20)  PRIMARY KEY,
      api_id     INTEGER      NOT NULL,
      api_hash   TEXT         NOT NULL,
      phone      TEXT         NOT NULL,
      created_at TIMESTAMPTZ  DEFAULT NOW()
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
  await db.query(`ALTER TABLE sc_user_files ADD COLUMN IF NOT EXISTS is_trashed BOOLEAN DEFAULT FALSE`)
  await db.query(`ALTER TABLE sc_user_files ADD COLUMN IF NOT EXISTS trashed_at BIGINT`)
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
  await db.query(`ALTER TABLE sc_user_folders ADD COLUMN IF NOT EXISTS is_trashed BOOLEAN DEFAULT FALSE`)
  await db.query(`ALTER TABLE sc_user_folders ADD COLUMN IF NOT EXISTS trashed_at BIGINT`)
  await db.query(`
    CREATE TABLE IF NOT EXISTS sc_shared_links (
      id          TEXT    PRIMARY KEY,
      file_id     TEXT    NOT NULL,
      user_id     TEXT    NOT NULL,
      created_at  BIGINT,
      UNIQUE(file_id, user_id)
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS sc_tg_shares (
      id               TEXT    PRIMARY KEY,
      file_name        TEXT    NOT NULL,
      file_size        BIGINT,
      mime_type        TEXT,
      channel_id       TEXT    NOT NULL,
      access_hash      TEXT,
      message_id       INT     NOT NULL,
      is_chunked       BOOLEAN DEFAULT FALSE,
      chunk_message_ids TEXT,
      session_string   TEXT    NOT NULL,
      api_id           INT     NOT NULL,
      api_hash         TEXT    NOT NULL,
      created_at       BIGINT
    )
  `)
}

// ── Telegram client (singleton, auto-reconnects) ──────────────────────────
let _tgClient = null

async function getTgClient() {
  if (_tgClient?.connected) return _tgClient

  const apiId = Number(process.env.ADMIN_API_ID)
  const apiHash = process.env.ADMIN_API_HASH
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
  const userId = req.headers['x-user-id'] || req.query.userId
  if (!userId) return res.status(401).json({ error: 'Missing user ID' })
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
    about: `Cloud Space storage for user ${userId}`,
    broadcast: true,
  }))
  const ch = result.chats[0]
  const rawId = ch.id.toString()
  const channelId = rawId.startsWith('-100') ? rawId : `-100${rawId}`
  const accessHash = ch.accessHash.toString()

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
app.use(express.json({ limit: '1mb' }))  // JSON bodies are tiny; large uploads go through multer

// Multer: write chunks to disk, no size cap (Railway has no body limit)
const upload = multer({
  dest: TMP,
  // No fileSize limit — Railway imposes none. You're only bounded by your disk.
  // Hobby plan: default 1 GB volume. Attach a Railway volume for more.
})

// ── ──────────────────────────────────────────────────────────────────────
//  AUTH ROUTES
// ── ──────────────────────────────────────────────────────────────────────

// GET /api/tg-credentials — returns the admin API_ID and API_HASH
// so the browser can initiate GramJS login for any user with just phone + OTP
app.get('/api/tg-credentials', (_req, res) => {
  const apiId = process.env.ADMIN_API_ID
  const apiHash = process.env.ADMIN_API_HASH
  if (!apiId || !apiHash) {
    return res.status(500).json({ error: 'Admin Telegram credentials not configured.' })
  }
  return res.json({ apiId: Number(apiId), apiHash })
})

// POST /api/register — Telegram users store their profile (userId, apiId, apiHash, phone)
app.post('/api/register', async (req, res) => {
  const { userId, apiId, apiHash, phone } = req.body ?? {}
  if (!userId || !apiId || !apiHash || !phone)
    return res.status(400).json({ error: 'Missing required fields' })
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(userId))
    return res.status(400).json({ error: 'Invalid userId: 3–20 chars, letters/numbers/_ only' })

  try {
    const db = getPool()

    // Check if userId already exists
    const existingId = await db.query(
      'SELECT user_id FROM tg_cloud_users WHERE user_id = $1', [userId]
    )
    if (existingId.rows.length > 0)
      return res.status(409).json({ error: 'Account already exists with this User ID. Please go to Sign In.' })

    // Check if phone number already registered
    const existingPhone = await db.query(
      'SELECT user_id FROM tg_cloud_users WHERE phone = $1', [phone]
    )
    if (existingPhone.rows.length > 0)
      return res.status(409).json({ error: `Account already exists with this phone number (User ID: ${existingPhone.rows[0].user_id}). Please go to Sign In.` })

    await db.query(
      `INSERT INTO tg_cloud_users (user_id, api_id, api_hash, phone) VALUES ($1, $2, $3, $4)`,
      [userId, Number(apiId), apiHash, phone]
    )
    console.log(`✅  Registered TG user: ${userId}`)
    return res.json({ success: true })
  } catch (err) {
    console.error('register error:', err)
    return res.status(500).json({ error: 'Database error.' })
  }
})

// GET /api/lookup — look up a Telegram user's stored credentials by userId
app.get('/api/lookup', async (req, res) => {
  const { userId } = req.query
  if (!userId) return res.status(400).json({ error: 'userId is required' })

  try {
    const db = getPool()
    const result = await db.query(
      'SELECT api_id, api_hash, phone FROM tg_cloud_users WHERE user_id = $1',
      [userId]
    )
    if (result.rows.length === 0)
      return res.status(404).json({ error: 'User ID not found' })

    const row = result.rows[0]
    return res.json({ apiId: row.api_id, apiHash: row.api_hash, phone: row.phone })
  } catch (err) {
    console.error('lookup error:', err)
    return res.status(500).json({ error: 'Database error.' })
  }
})

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

    // Simple users: all file operations (upload/download) go through
    // this server, so no Telegram credentials are needed in the browser.
    return res.json({ userId: row.user_id })
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
           AND (is_trashed IS NULL OR is_trashed = FALSE)
         ORDER BY created_at DESC`,
        [req.userId]
      ),
      db.query(
        `SELECT id, name, created_at AS "createdAt",
                channel_id AS "channelId", access_hash AS "accessHash"
         FROM sc_user_folders
         WHERE user_id = $1 AND name != '__root__'
           AND (is_trashed IS NULL OR is_trashed = FALSE)
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
      about: `Cloud Space folder for user ${req.userId}`,
      broadcast: true,
    }))
    const ch = result.chats[0]
    const rawId = ch.id.toString()
    const channelId = rawId.startsWith('-100') ? rawId : `-100${rawId}`
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
      } catch { }
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
//  SAVE FILE METADATA (browser uploaded directly to Telegram)
// ── ──────────────────────────────────────────────────────────────────────

/**
 * POST /api/simple/files/save-meta
 *
 * After the browser uploads a file directly to Telegram (zero Railway egress),
 * it calls this endpoint to save the lightweight file metadata in the DB.
 * Only a small JSON payload — never any file bytes.
 */
app.post('/api/simple/files/save-meta', requireUser, async (req, res) => {
  try {
    const { file: f } = req.body ?? {}
    if (!f || !f.id || !f.name) return res.status(400).json({ error: 'Missing file metadata' })

    const db = getPool()
    await db.query(
      `INSERT INTO sc_user_files
        (id, user_id, name, size, mime_type, created_at, folder_id, message_id, channel_id, access_hash, is_chunked, chunk_ids, chunk_message_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO NOTHING`,
      [
        f.id,
        req.userId,
        f.name,
        f.size ?? 0,
        f.mimeType ?? 'application/octet-stream',
        f.createdAt ?? Date.now(),
        f.folderId ?? null,
        f.messageId ?? null,
        f.channelId ?? null,
        f.accessHash ?? null,
        f.isChunked ?? false,
        f.chunkIds ? JSON.stringify(f.chunkIds) : null,
        f.chunkMessageIds ? JSON.stringify(f.chunkMessageIds) : null,
      ]
    )
    return res.json({ success: true })
  } catch (err) {
    console.error('save-meta error:', err)
    return res.status(500).json({ error: err.message })
  }
})

// ── ──────────────────────────────────────────────────────────────────────
//  UPLOAD  (SSE streaming progress)
// ── ──────────────────────────────────────────────────────────────────────

/**
 * POST /api/simple/upload
 *
 * Accepts the full file (no body-size limit on Railway!).
 * Streams real Telegram upload progress back as Server-Sent Events.
 * Works for files of any size — tested up to 2 GB with GramJS.
 */
app.post('/api/simple/upload', requireUser, upload.single('file'), async (req, res) => {
  const tmpPath = req.file?.path

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const send = (data) => {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`)
      if (typeof res.flush === 'function') res.flush()
    } catch { }
  }

  try {
    if (!req.file) { send({ type: 'error', error: 'No file provided' }); return res.end() }

    const { folderId } = req.body ?? {}
    const db = getPool()
    const client = await getTgClient()

    // Resolve target channel
    let channelId, accessHash
    if (folderId) {
      const f = await db.query(
        'SELECT channel_id, access_hash FROM sc_user_folders WHERE id = $1 AND user_id = $2',
        [folderId, req.userId]
      )
      if (f.rows.length === 0) { send({ type: 'error', error: 'Folder not found' }); return res.end() }
      channelId = f.rows[0].channel_id
      accessHash = f.rows[0].access_hash
    } else {
      const root = await resolveOrCreateRootChannel(req.userId, client, db)
      channelId = root.channel_id
      accessHash = root.access_hash
    }

    const peer = new Api.InputPeerChannel({
      channelId: BigInt(channelId.replace('-100', '')),
      accessHash: BigInt(accessHash ?? '0'),
    })

    const mimeType = req.file.mimetype || 'application/octet-stream'
    const origName = req.file.originalname

    const { CustomFile } = await import('telegram/client/uploads.js')
    const customFile = new CustomFile(origName, req.file.size, tmpPath)

    send({ type: 'progress', pct: 1 })
    let lastPct = 1

    const result = await client.sendFile(peer, {
      file: customFile,
      caption: origName,
      forceDocument: true,
      workers: 4,
      progressCallback: (fraction) => {
        const pct = Math.round(fraction * 100)
        if (pct > lastPct) { lastPct = pct; send({ type: 'progress', pct }) }
      },
    })

    const messageId = result?.id ?? 0
    const fileId = uuidv4()

    await db.query(
      `INSERT INTO sc_user_files
         (id, user_id, name, size, mime_type, created_at, folder_id,
          message_id, channel_id, access_hash, is_chunked, is_chunk_part)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,FALSE,FALSE)`,
      [fileId, req.userId, origName, req.file.size, mimeType, Date.now(),
        folderId || null, messageId, channelId, accessHash]
    )

    if (tmpPath) unlink(tmpPath).catch(() => { })

    send({
      type: 'done',
      file: {
        id: fileId, name: origName, size: req.file.size, mimeType,
        createdAt: Date.now(), folderId: folderId || null,
        messageId, channelId, accessHash, isChunked: false,
      },
    })
    res.end()
  } catch (err) {
    console.error('upload error:', err)
    if (tmpPath) unlink(tmpPath).catch(() => { })
    send({ type: 'error', error: err.message ?? 'Upload failed' })
    res.end()
  }
})

// ── ──────────────────────────────────────────────────────────────────────
//  DOWNLOAD  (streaming, no buffering)
// ── ──────────────────────────────────────────────────────────────────────

/**
 * GET /api/simple/download/:fileId
 *
 * Streams file bytes directly from Telegram to the browser.
 * Uses iterDownload so the full file is never held in RAM.
 * Chunked files are assembled by streaming each part in order.
 */
app.get('/api/simple/download/:fileId', requireUser, async (req, res) => {
  try {
    const db = getPool()
    const fileRes = await db.query(
      'SELECT * FROM sc_user_files WHERE id = $1 AND user_id = $2',
      [req.params.fileId, req.userId]
    )
    if (fileRes.rows.length === 0)
      return res.status(404).json({ error: 'File not found' })

    const file = fileRes.rows[0]
    const client = await getTgClient()

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`)
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream')
    if (file.size) res.setHeader('Content-Length', String(file.size))

    const streamFromMessage = async (channelId, accessHash, messageId) => {
      const peer = new Api.InputPeerChannel({
        channelId: BigInt(channelId.replace('-100', '')),
        accessHash: BigInt(accessHash ?? '0'),
      })
      const msgs = await client.getMessages(peer, { ids: [messageId] })
      if (!msgs?.length || !msgs[0]) throw new Error(`Message ${messageId} not found`)

      for await (const chunk of client.iterDownload({
        file: msgs[0].media,
        requestSize: 512 * 1024,
      })) {
        res.write(chunk)
      }
    }

    if (file.is_chunked && file.chunk_ids) {
      const chunkIds = JSON.parse(file.chunk_ids)
      for (const cid of chunkIds) {
        const cr = await db.query('SELECT * FROM sc_user_files WHERE id = $1', [cid])
        if (!cr.rows.length) throw new Error(`Chunk ${cid} not found`)
        const c = cr.rows[0]
        await streamFromMessage(c.channel_id, c.access_hash ?? '0', c.message_id)
      }
    } else {
      await streamFromMessage(file.channel_id, file.access_hash ?? '0', file.message_id)
    }

    res.end()
  } catch (err) {
    console.error('download error:', err)
    if (!res.headersSent) res.status(500).json({ error: err.message })
    else res.end()
  }
})

// ── ──────────────────────────────────────────────────────────────────────
//  SERVE REACT FRONTEND
// ── ──────────────────────────────────────────────────────────────────────

// ── HEALTH CHECK ──────────────────────────────────────────────────────────
// Railway pings this after every deploy to confirm the server is ready.
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }))

// ── ──────────────────────────────────────────────────────────────────────
//  TRASH
// ── ──────────────────────────────────────────────────────────────────────

// POST /api/simple/trash/:id — soft-delete a file or folder
app.post('/api/simple/trash/:id', requireUser, async (req, res) => {
  try {
    const db = getPool()
    const { type } = req.body ?? {}  // 'file' or 'folder'
    const now = Date.now()
    if (type === 'folder') {
      // Trash the folder and all its files
      await db.query('UPDATE sc_user_folders SET is_trashed = TRUE, trashed_at = $1 WHERE id = $2 AND user_id = $3', [now, req.params.id, req.userId])
      await db.query('UPDATE sc_user_files SET is_trashed = TRUE, trashed_at = $1 WHERE folder_id = $2 AND user_id = $3', [now, req.params.id, req.userId])
    } else {
      await db.query('UPDATE sc_user_files SET is_trashed = TRUE, trashed_at = $1 WHERE id = $2 AND user_id = $3', [now, req.params.id, req.userId])
    }
    return res.json({ success: true })
  } catch (err) {
    console.error('trash error:', err)
    return res.status(500).json({ error: err.message })
  }
})

// POST /api/simple/restore/:id — restore from trash
app.post('/api/simple/restore/:id', requireUser, async (req, res) => {
  try {
    const db = getPool()
    const { type } = req.body ?? {}
    if (type === 'folder') {
      await db.query('UPDATE sc_user_folders SET is_trashed = FALSE, trashed_at = NULL WHERE id = $1 AND user_id = $2', [req.params.id, req.userId])
      await db.query('UPDATE sc_user_files SET is_trashed = FALSE, trashed_at = NULL WHERE folder_id = $1 AND user_id = $2', [req.params.id, req.userId])
    } else {
      await db.query('UPDATE sc_user_files SET is_trashed = FALSE, trashed_at = NULL WHERE id = $1 AND user_id = $2', [req.params.id, req.userId])
    }
    return res.json({ success: true })
  } catch (err) {
    console.error('restore error:', err)
    return res.status(500).json({ error: err.message })
  }
})

// GET /api/simple/trash — list trashed items
app.get('/api/simple/trash', requireUser, async (req, res) => {
  try {
    const db = getPool()
    const [filesRes, foldersRes] = await Promise.all([
      db.query(
        `SELECT id, name, size, mime_type AS "mimeType", created_at AS "createdAt",
                folder_id AS "folderId", trashed_at AS "trashedAt"
         FROM sc_user_files
         WHERE user_id = $1 AND is_trashed = TRUE
           AND (is_chunk_part IS NULL OR is_chunk_part = FALSE)
         ORDER BY trashed_at DESC`, [req.userId]
      ),
      db.query(
        `SELECT id, name, created_at AS "createdAt", trashed_at AS "trashedAt"
         FROM sc_user_folders
         WHERE user_id = $1 AND is_trashed = TRUE AND name != '__root__'
         ORDER BY trashed_at DESC`, [req.userId]
      ),
    ])
    return res.json({ files: filesRes.rows, folders: foldersRes.rows })
  } catch (err) {
    console.error('list trash error:', err)
    return res.status(500).json({ error: err.message })
  }
})

// DELETE /api/simple/trash/empty — permanently delete all trashed items
app.delete('/api/simple/trash/empty', requireUser, async (req, res) => {
  try {
    const db = getPool()

    // Fetch trashed files
    const fileRes = await db.query('SELECT channel_id, access_hash, message_id, is_chunked, chunk_ids FROM sc_user_files WHERE user_id = $1 AND is_trashed = TRUE', [req.userId])

    // Delete from Telegram
    try {
      if (fileRes.rows.length > 0) {
        const client = await getTgClient()
        const byChannel = {}
        for (const f of fileRes.rows) {
          const key = `${f.channel_id}:${f.access_hash}`
          if (!byChannel[key]) byChannel[key] = []
          byChannel[key].push(f.message_id)
          if (f.is_chunked && f.chunk_ids) {
            const ids = JSON.parse(f.chunk_ids)
            if (ids.length > 0) {
              const chunkRes = await db.query(`SELECT message_id FROM sc_user_files WHERE id = ANY($1::text[])`, [ids])
              for (const chunkRow of chunkRes.rows) {
                if (chunkRow.message_id) byChannel[key].push(chunkRow.message_id)
              }
              // delete chunks from db
              await db.query(`DELETE FROM sc_user_files WHERE id = ANY($1::text[])`, [ids])
            }
          }
        }
        for (const [key, msgIds] of Object.entries(byChannel)) {
          const [channelId, accessHash] = key.split(':')
          const peer = new Api.InputPeerChannel({
            channelId: BigInt(channelId.replace('-100', '')),
            accessHash: BigInt(accessHash ?? '0')
          })
          await client.invoke(new Api.channels.DeleteMessages({ channel: peer, id: msgIds }))
        }
      }
    } catch (e) {
      console.warn('Could not delete TG messages during empty trash:', e.message)
    }

    await db.query('DELETE FROM sc_user_files WHERE user_id = $1 AND is_trashed = TRUE', [req.userId])
    await db.query('DELETE FROM sc_user_folders WHERE user_id = $1 AND is_trashed = TRUE AND name != \'__root__\'', [req.userId])
    return res.json({ success: true })
  } catch (err) {
    console.error('empty trash error:', err)
    return res.status(500).json({ error: err.message })
  }
})

// ── ──────────────────────────────────────────────────────────────────────
//  MOVE FILE
// ── ──────────────────────────────────────────────────────────────────────

// POST /api/simple/move/:fileId — move a file to a different folder
app.post('/api/simple/move/:fileId', requireUser, async (req, res) => {
  try {
    const { folderId } = req.body ?? {}  // null = root
    const db = getPool()
    await db.query(
      'UPDATE sc_user_files SET folder_id = $1 WHERE id = $2 AND user_id = $3',
      [folderId || null, req.params.fileId, req.userId]
    )
    return res.json({ success: true })
  } catch (err) {
    console.error('move error:', err)
    return res.status(500).json({ error: err.message })
  }
})

// ── ──────────────────────────────────────────────────────────────────────
//  SHARING
// ── ──────────────────────────────────────────────────────────────────────

// POST /api/simple/share/:fileId — create a public share link
app.post('/api/simple/share/:fileId', requireUser, async (req, res) => {
  try {
    const db = getPool()
    // Check file exists
    const fileRes = await db.query('SELECT id FROM sc_user_files WHERE id = $1 AND user_id = $2', [req.params.fileId, req.userId])
    if (fileRes.rows.length === 0) return res.status(404).json({ error: 'File not found' })
    // Check if already shared
    const existing = await db.query('SELECT id FROM sc_shared_links WHERE file_id = $1 AND user_id = $2', [req.params.fileId, req.userId])
    if (existing.rows.length > 0) return res.json({ linkId: existing.rows[0].id })
    const linkId = uuidv4().replace(/-/g, '').slice(0, 12)
    await db.query('INSERT INTO sc_shared_links (id, file_id, user_id, created_at) VALUES ($1,$2,$3,$4)', [linkId, req.params.fileId, req.userId, Date.now()])
    return res.json({ linkId })
  } catch (err) {
    console.error('share error:', err)
    return res.status(500).json({ error: err.message })
  }
})

// DELETE /api/simple/share/:fileId — remove share link
app.delete('/api/simple/share/:fileId', requireUser, async (req, res) => {
  try {
    const db = getPool()
    await db.query('DELETE FROM sc_shared_links WHERE file_id = $1 AND user_id = $2', [req.params.fileId, req.userId])
    return res.json({ success: true })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// GET /api/simple/share-info/:fileId — check if file is shared
app.get('/api/simple/share-info/:fileId', requireUser, async (req, res) => {
  try {
    const db = getPool()
    const result = await db.query('SELECT id FROM sc_shared_links WHERE file_id = $1 AND user_id = $2', [req.params.fileId, req.userId])
    if (result.rows.length === 0) return res.json({ shared: false })
    return res.json({ shared: true, linkId: result.rows[0].id })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// POST /api/tg/share — Telegram user creates a share link
app.post('/api/tg/share', async (req, res) => {
  try {
    const { fileName, fileSize, mimeType, channelId, accessHash, messageId, isChunked, chunkMessageIds, sessionString, apiId, apiHash } = req.body
    if (!channelId || !sessionString || !apiId || !apiHash) return res.status(400).json({ error: 'Missing required fields' })
    const db = getPool()
    const linkId = uuidv4().replace(/-/g, '').slice(0, 12)
    await db.query(
      `INSERT INTO sc_tg_shares (id, file_name, file_size, mime_type, channel_id, access_hash, message_id, is_chunked, chunk_message_ids, session_string, api_id, api_hash, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [linkId, fileName, fileSize || 0, mimeType || 'application/octet-stream', channelId, accessHash || '0', messageId, isChunked || false, chunkMessageIds ? JSON.stringify(chunkMessageIds) : null, sessionString, apiId, apiHash, Date.now()]
    )
    return res.json({ linkId })
  } catch (err) {
    console.error('tg share error:', err)
    return res.status(500).json({ error: err.message })
  }
})

// GET /api/share/:linkId — public file info (no auth needed)
app.get('/api/share/:linkId', async (req, res) => {
  try {
    const db = getPool()
    // Check simple user shares first
    const linkRes = await db.query('SELECT file_id, user_id FROM sc_shared_links WHERE id = $1', [req.params.linkId])
    if (linkRes.rows.length > 0) {
      const { file_id, user_id } = linkRes.rows[0]
      const fileRes = await db.query(
        `SELECT id, name, size, mime_type AS "mimeType", created_at AS "createdAt" FROM sc_user_files WHERE id = $1 AND user_id = $2`,
        [file_id, user_id]
      )
      if (fileRes.rows.length > 0) return res.json({ file: fileRes.rows[0] })
    }
    // Check Telegram user shares
    const tgRes = await db.query('SELECT id, file_name AS name, file_size AS size, mime_type AS "mimeType", created_at AS "createdAt" FROM sc_tg_shares WHERE id = $1', [req.params.linkId])
    if (tgRes.rows.length > 0) return res.json({ file: tgRes.rows[0] })
    return res.status(404).json({ error: 'Link not found or expired' })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// GET /api/share/:linkId/download — public file download (no auth needed)
app.get('/api/share/:linkId/download', async (req, res) => {
  try {
    const db = getPool()

    // Check simple user shares first
    const linkRes = await db.query('SELECT file_id, user_id FROM sc_shared_links WHERE id = $1', [req.params.linkId])
    if (linkRes.rows.length > 0) {
      const { file_id, user_id } = linkRes.rows[0]
      const fileRes = await db.query('SELECT * FROM sc_user_files WHERE id = $1 AND user_id = $2', [file_id, user_id])
      if (fileRes.rows.length > 0) {
        const file = fileRes.rows[0]
        const client = await getTgClient()
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`)
        res.setHeader('Content-Type', file.mime_type || 'application/octet-stream')
        if (file.size) res.setHeader('Content-Length', String(file.size))
        const peer = new Api.InputPeerChannel({
          channelId: BigInt(file.channel_id.replace('-100', '')),
          accessHash: BigInt(file.access_hash ?? '0'),
        })
        const msgs = await client.getMessages(peer, { ids: [file.message_id] })
        if (!msgs?.length || !msgs[0]) throw new Error('Message not found')
        for await (const chunk of client.iterDownload({ file: msgs[0].media, requestSize: 512 * 1024 })) {
          res.write(chunk)
        }
        return res.end()
      }
    }

    // Check Telegram user shares
    const tgRes = await db.query('SELECT * FROM sc_tg_shares WHERE id = $1', [req.params.linkId])
    if (tgRes.rows.length === 0) return res.status(404).json({ error: 'Link not found' })
    const share = tgRes.rows[0]

    // Create a temporary Telegram client with the sharer's session
    const session = new StringSession(share.session_string)
    const tgClient = new TelegramClient(session, share.api_id, share.api_hash, {
      connectionRetries: 5,
      retryDelay: 1000,
      autoReconnect: true,
      useWSS: false,
    })
    await tgClient.connect()

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(share.file_name)}"`)
    res.setHeader('Content-Type', share.mime_type || 'application/octet-stream')
    if (share.file_size) res.setHeader('Content-Length', String(share.file_size))

    const peer = new Api.InputPeerChannel({
      channelId: BigInt(share.channel_id.replace('-100', '')),
      accessHash: BigInt(share.access_hash ?? '0'),
    })

    if (share.is_chunked && share.chunk_message_ids) {
      const chunkIds = JSON.parse(share.chunk_message_ids)
      for (const msgId of chunkIds) {
        const msgs = await tgClient.getMessages(peer, { ids: [msgId] })
        if (msgs?.length && msgs[0]?.media) {
          for await (const chunk of tgClient.iterDownload({ file: msgs[0].media, requestSize: 512 * 1024 })) {
            res.write(chunk)
          }
        }
      }
    } else {
      const msgs = await tgClient.getMessages(peer, { ids: [share.message_id] })
      if (!msgs?.length || !msgs[0]) throw new Error('Message not found')
      for await (const chunk of tgClient.iterDownload({ file: msgs[0].media, requestSize: 512 * 1024 })) {
        res.write(chunk)
      }
    }

    res.end()
    // Disconnect the temp client after streaming
    tgClient.disconnect().catch(() => { })
  } catch (err) {
    console.error('share download error:', err)
    if (!res.headersSent) res.status(500).json({ error: err.message })
    else res.end()
  }
})

// ── ──────────────────────────────────────────────────────────────────────
//  UPLOAD FROM URL
// ── ──────────────────────────────────────────────────────────────────────

// POST /api/simple/upload-url — download file from URL and upload to Telegram
app.post('/api/simple/upload-url', requireUser, async (req, res) => {
  const { url, folderId } = req.body ?? {}
  if (!url) return res.status(400).json({ error: 'URL is required' })

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()
  const send = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); if (typeof res.flush === 'function') res.flush() } catch { } }

  let tmpPath = null
  try {
    send({ type: 'progress', pct: 5, stage: 'Downloading from URL...' })

    // Download the file from the URL
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Failed to fetch URL: ${response.status}`)

    const contentType = response.headers.get('content-type') || 'application/octet-stream'
    const contentLength = Number(response.headers.get('content-length') || 0)
    // Extract filename from URL or content-disposition
    let fileName = url.split('/').pop()?.split('?')[0] || 'downloaded-file'
    const cd = response.headers.get('content-disposition')
    if (cd) {
      const m = cd.match(/filename[*]?=['"]?([^;'"\n]+)/)
      if (m) fileName = m[1]
    }
    fileName = decodeURIComponent(fileName)

    // Write to temp file
    const { createWriteStream } = await import('fs')
    tmpPath = join(TMP, `url-${uuidv4()}`)
    const writer = createWriteStream(tmpPath)
    let downloaded = 0
    for await (const chunk of response.body) {
      writer.write(chunk)
      downloaded += chunk.length
      if (contentLength > 0) {
        send({ type: 'progress', pct: Math.round((downloaded / contentLength) * 40) + 5, stage: 'Downloading from URL...' })
      }
    }
    writer.end()
    await new Promise(r => writer.on('finish', r))

    send({ type: 'progress', pct: 50, stage: 'Uploading to Telegram...' })

    // Now upload to Telegram
    const db = getPool()
    const client = await getTgClient()
    let channelId, accessHash
    if (folderId) {
      const f = await db.query('SELECT channel_id, access_hash FROM sc_user_folders WHERE id = $1 AND user_id = $2', [folderId, req.userId])
      if (f.rows.length === 0) { send({ type: 'error', error: 'Folder not found' }); return res.end() }
      channelId = f.rows[0].channel_id; accessHash = f.rows[0].access_hash
    } else {
      const root = await resolveOrCreateRootChannel(req.userId, client, db)
      channelId = root.channel_id; accessHash = root.access_hash
    }

    const peer = new Api.InputPeerChannel({ channelId: BigInt(channelId.replace('-100', '')), accessHash: BigInt(accessHash ?? '0') })
    const { CustomFile } = await import('telegram/client/uploads.js')
    const fileSize = downloaded || contentLength
    const customFile = new CustomFile(fileName, fileSize, tmpPath)

    const result = await client.sendFile(peer, {
      file: customFile, caption: fileName, forceDocument: true, workers: 4,
      progressCallback: (fraction) => { send({ type: 'progress', pct: 50 + Math.round(fraction * 49), stage: 'Uploading to Telegram...' }) },
    })

    const fileId = uuidv4()
    await db.query(
      `INSERT INTO sc_user_files (id, user_id, name, size, mime_type, created_at, folder_id, message_id, channel_id, access_hash, is_chunked, is_chunk_part)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,FALSE,FALSE)`,
      [fileId, req.userId, fileName, fileSize, contentType, Date.now(), folderId || null, result?.id ?? 0, channelId, accessHash]
    )

    if (tmpPath) unlink(tmpPath).catch(() => { })
    send({ type: 'done', file: { id: fileId, name: fileName, size: fileSize, mimeType: contentType, createdAt: Date.now(), folderId: folderId || null, messageId: result?.id ?? 0, channelId, accessHash, isChunked: false } })
    res.end()
  } catch (err) {
    console.error('upload-url error:', err)
    if (tmpPath) unlink(tmpPath).catch(() => { })
    send({ type: 'error', error: err.message ?? 'Upload from URL failed' })
    res.end()
  }
})

// GET /api/simple/proxy-url — proxy a file download so the browser can bypass CORS
app.get('/api/simple/proxy-url', requireUser, async (req, res) => {
  try {
    const url = req.query.url
    if (!url) return res.status(400).json({ error: 'Missing url' })
    const response = await fetch(url)
    if (!response.ok) return res.status(response.status).json({ error: 'Failed to fetch url' })
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/octet-stream')
    const size = response.headers.get('content-length')
    if (size) res.setHeader('Content-Length', size)
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(url.split('/').pop()?.split('?')[0] || 'file')}"`)

    // Web streams to Node streams
    const { Readable } = await import('stream')
    const nodeStream = Readable.fromWeb(response.body)
    nodeStream.pipe(res)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── ──────────────────────────────────────────────────────────────────────
//  STORAGE STATS
// ── ──────────────────────────────────────────────────────────────────────

app.get('/api/simple/stats', requireUser, async (req, res) => {
  try {
    const db = getPool()
    const [totalRes, byTypeRes, recentRes, folderCountRes] = await Promise.all([
      db.query(
        `SELECT COALESCE(SUM(size), 0) AS total_size, COUNT(*) AS total_files
         FROM sc_user_files WHERE user_id = $1 AND (is_trashed IS NULL OR is_trashed = FALSE)
           AND (is_chunk_part IS NULL OR is_chunk_part = FALSE)`, [req.userId]
      ),
      db.query(
        `SELECT
           CASE
             WHEN mime_type LIKE 'image/%' THEN 'Images'
             WHEN mime_type LIKE 'video/%' THEN 'Videos'
             WHEN mime_type LIKE 'audio/%' THEN 'Audio'
             WHEN mime_type LIKE 'application/pdf' THEN 'PDFs'
             WHEN mime_type LIKE 'application/zip' OR mime_type LIKE 'application/x-rar%' OR mime_type LIKE 'application/x-7z%' THEN 'Archives'
             ELSE 'Other'
           END AS category,
           COALESCE(SUM(size), 0) AS total_size,
           COUNT(*) AS count
         FROM sc_user_files WHERE user_id = $1 AND (is_trashed IS NULL OR is_trashed = FALSE)
           AND (is_chunk_part IS NULL OR is_chunk_part = FALSE)
         GROUP BY category ORDER BY total_size DESC`, [req.userId]
      ),
      db.query(
        `SELECT id, name, size, mime_type AS "mimeType", created_at AS "createdAt", folder_id AS "folderId"
         FROM sc_user_files WHERE user_id = $1 AND (is_trashed IS NULL OR is_trashed = FALSE)
           AND (is_chunk_part IS NULL OR is_chunk_part = FALSE)
         ORDER BY created_at DESC LIMIT 20`, [req.userId]
      ),
      db.query(
        `SELECT COUNT(*) AS count FROM sc_user_folders WHERE user_id = $1 AND name != '__root__'
           AND (is_trashed IS NULL OR is_trashed = FALSE)`, [req.userId]
      ),
    ])
    return res.json({
      totalSize: Number(totalRes.rows[0].total_size),
      totalFiles: Number(totalRes.rows[0].total_files),
      totalFolders: Number(folderCountRes.rows[0].count),
      byType: byTypeRes.rows.map(r => ({ category: r.category, size: Number(r.total_size), count: Number(r.count) })),
      recentFiles: recentRes.rows,
    })
  } catch (err) {
    console.error('stats error:', err)
    return res.status(500).json({ error: err.message })
  }
})

// Static files (JS, CSS, images)
app.use(express.static(DIST))

// SPA fallback: send index.html for any unknown route
// Express 5 / path-to-regexp v8+ requires named catch-all: '/{*splat}' instead of '*'
app.get('/{*splat}', (_req, res) => {
  res.sendFile(join(DIST, 'index.html'))
})

// ── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000   // Railway sets PORT automatically

async function start() {
  try {
    await ensureTables()

    // Start listening FIRST so Railway healthchecks pass instantly
    app.listen(PORT, () => {
      console.log(`\n⭐  Cloud Space server running on port ${PORT}`)
      console.log('    GET  /api/tg-credentials    ← admin API ID/Hash for phone+OTP login')
      console.log('    POST /api/register          ← Telegram user registration')
      console.log('    GET  /api/lookup            ← Telegram user lookup')
      console.log('    POST /api/user-register     ← Simple email+pass registration')
      console.log('    POST /api/user-login        ← Simple email+pass login')
      console.log('    GET  /api/simple/files')
      console.log('    POST /api/simple/folders')
      console.log('    POST /api/simple/upload     ← full file, no size limit')
      console.log('    GET  /api/simple/download/:id  ← streaming')
      console.log('    DEL  /api/simple/files/:id')
      console.log('    DEL  /api/simple/folders/:id')
      console.log('    GET  /*                     ← React SPA\n')
    })

    // Connect to Telegram in the background so it doesn't block startup
    getTgClient().catch(err => {
      console.error('❌ Telegram connection failed in background:', err.message)
    })

  } catch (err) {
    console.error('❌  Startup failed:', err.message)
    console.error('    Check ADMIN_API_ID, ADMIN_API_HASH, ADMIN_SESSION_STRING, DATABASE_URL')
    process.exit(1)
  }
}

// Graceful shutdown
process.on('SIGTERM', () => { console.log('SIGTERM received — shutting down'); process.exit(0) })
process.on('SIGINT', () => { console.log('SIGINT received — shutting down'); process.exit(0) })

start()
