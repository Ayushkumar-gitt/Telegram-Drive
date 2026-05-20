/**
 * admin-tg-server.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Separate ESM server that handles all Telegram operations for simple users.
 * Runs alongside api-server.cjs on port 3002.
 *
 * The admin TelegramClient is created once and kept connected.
 * All operations (list files, upload, download, create folder, delete) go
 * through this server — the browser never connects to Telegram directly.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { config } from 'dotenv'
config({ path: '.env.local' })
import express from 'express'
import cors from 'cors'
import multer from 'multer'
import { readFile, writeFile, unlink } from 'fs/promises'
import { existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { v4 as uuidv4 } from 'uuid'
import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const TMP_DIR = join(__dir, '.tmp-uploads')
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true })

const app = express()
app.use(cors({
  origin: '*',
  allowedHeaders: ['Content-Type', 'x-user-id', 'x-session-token'],
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
}))
app.use(express.json())

const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 GB
})

// ── Per-user metadata stored in memory + persisted to a JSON file ─────────
// Structure: { [userId]: { files: TGFile[], folders: TGFolder[] } }
const META_FILE = join(__dir, '.simple-user-meta.json')

async function loadMeta() {
  try {
    const raw = await readFile(META_FILE, 'utf-8')
    return JSON.parse(raw)
  } catch { return {} }
}
async function saveMeta(meta) {
  await writeFile(META_FILE, JSON.stringify(meta, null, 2), 'utf-8')
}

// ── Admin Telegram client ─────────────────────────────────────────────────
let adminClient = null

async function getAdminClient() {
  if (adminClient?.connected) return adminClient

  const apiId  = Number(process.env.ADMIN_API_ID)
  const apiHash = process.env.ADMIN_API_HASH
  const sessionStr = process.env.ADMIN_SESSION_STRING

  if (!apiId || !apiHash || !sessionStr) {
    throw new Error('Admin Telegram credentials not configured in .env.local')
  }

  console.log('🔌  Connecting admin Telegram client…')
  const session = new StringSession(sessionStr)
  adminClient = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 10,
    retryDelay: 2000,
    autoReconnect: true,
    useWSS: false,  // Node.js uses TCP, not WebSocket
  })
  await adminClient.connect()
  console.log('✅  Admin Telegram client connected')
  return adminClient
}

// Middleware: verify x-user-id header
function requireUser(req, res, next) {
  const userId = req.headers['x-user-id']
  if (!userId) return res.status(401).json({ error: 'Missing x-user-id header' })
  req.userId = userId
  next()
}

// ── GET /api/simple/files ─────────────────────────────────────────────────
app.get('/api/simple/files', requireUser, async (req, res) => {
  try {
    const meta = await loadMeta()
    const userMeta = meta[req.userId] ?? { files: [], folders: [] }
    return res.json(userMeta)
  } catch (err) {
    console.error('list files error:', err)
    return res.status(500).json({ error: err.message })
  }
})

// ── POST /api/simple/folders ──────────────────────────────────────────────
app.post('/api/simple/folders', requireUser, async (req, res) => {
  const { folderName } = req.body ?? {}
  if (!folderName?.trim()) return res.status(400).json({ error: 'folderName required' })

  try {
    const client = await getAdminClient()

    // Create a Telegram channel for this folder, namespaced by userId
    const channelTitle = `SC_${req.userId}_${folderName.trim()}`.slice(0, 255)
    const result = await client.invoke(
      new Api.channels.CreateChannel({
        title: channelTitle,
        about: `Star Cloud folder for user ${req.userId}`,
        broadcast: true,
      })
    )

    const channel = result.chats[0]
    const rawId = channel.id.toString()
    const channelId = rawId.startsWith('-100') ? rawId : `-100${rawId}`
    const accessHash = channel.accessHash.toString()

    const newFolder = {
      id: uuidv4(),
      name: folderName.trim(),
      createdAt: Date.now(),
      channelId,
      accessHash,
    }

    const meta = await loadMeta()
    if (!meta[req.userId]) meta[req.userId] = { files: [], folders: [] }
    meta[req.userId].folders.push(newFolder)
    await saveMeta(meta)

    return res.json({ success: true, folder: newFolder })
  } catch (err) {
    console.error('create folder error:', err)
    return res.status(500).json({ error: err.message })
  }
})

// ── POST /api/simple/upload ───────────────────────────────────────────────
// Streams real Telegram upload progress back as Server-Sent Events (SSE).
// The client reads the stream and updates the progress bar with actual %,
// not a simulation. Final event contains the saved file metadata.
app.post('/api/simple/upload', requireUser, upload.single('file'), async (req, res) => {
  const tmpPath = req.file?.path

  // ── Set up SSE streaming ─────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()  // send headers immediately so the browser opens the stream

  const send = (data) => {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`)
      // flush() is injected by compression middleware if present;
      // call it if available so events aren't held in a buffer.
      if (typeof res.flush === 'function') res.flush()
    } catch {}
  }

  try {
    const { folderId } = req.body ?? {}
    if (!req.file) { send({ type: 'error', error: 'No file provided' }); return res.end() }

    const client = await getAdminClient()
    const meta = await loadMeta()
    if (!meta[req.userId]) meta[req.userId] = { files: [], folders: [] }

    // Determine target channel
    let targetChannelId = null
    let targetAccessHash = null

    if (folderId) {
      const folder = meta[req.userId].folders.find(f => f.id === folderId)
      if (!folder) { send({ type: 'error', error: 'Folder not found' }); return res.end() }
      targetChannelId = folder.channelId
      targetAccessHash = folder.accessHash
    } else {
      const rootChannelName = `StarCloud_Meta_${req.userId}`
      let rootFolder = meta[req.userId].folders.find(f => f.name === '__root__')

      if (!rootFolder) {
        const dialogs = await client.getDialogs({})
        const existing = dialogs.find(d => d.title === rootChannelName)
        if (existing?.entity) {
          const id = existing.entity.id.toString()
          targetChannelId = id.startsWith('-100') ? id : `-100${id}`
          targetAccessHash = existing.entity.accessHash?.toString() ?? null
        } else {
          const result = await client.invoke(
            new Api.channels.CreateChannel({
              title: rootChannelName,
              about: `Star Cloud storage for user ${req.userId}`,
              broadcast: true,
            })
          )
          const ch = result.chats[0]
          const rawId = ch.id.toString()
          targetChannelId = rawId.startsWith('-100') ? rawId : `-100${rawId}`
          targetAccessHash = ch.accessHash.toString()
        }
        rootFolder = { id: '__root__', name: '__root__', channelId: targetChannelId, accessHash: targetAccessHash }
        meta[req.userId].folders.push(rootFolder)
        await saveMeta(meta)
      } else {
        targetChannelId = rootFolder.channelId
        targetAccessHash = rootFolder.accessHash
      }
    }

    const BigIntC = global.BigInt || Number
    const peer = new Api.InputPeerChannel({
      channelId: BigIntC(targetChannelId.replace('-100', '')),
      accessHash: BigIntC(targetAccessHash ?? '0'),
    })

    const mimeType = req.file.mimetype || 'application/octet-stream'
    const originalName = req.file.originalname

    const { CustomFile } = await import('telegram/client/uploads.js')
    const customFile = new CustomFile(originalName, req.file.size, tmpPath)

    // ── Upload with real progress streaming ──────────────────────────────────
    // GramJS calls progressCallback(fraction) after each 512 KB part is sent.
    let lastPct = 0
    const result = await client.sendFile(peer, {
      file: customFile,
      caption: originalName,
      forceDocument: true,
      workers: 4,
      progressCallback: (fraction) => {
        const pct = Math.round(fraction * 100)
        if (pct > lastPct) {  // only send when it actually advances
          lastPct = pct
          send({ type: 'progress', pct })
        }
      },
    })

    const messageId = result?.id ?? 0
    const newFile = {
      id: uuidv4(),
      name: originalName,
      size: req.file.size,
      mimeType,
      createdAt: Date.now(),
      folderId: folderId || null,
      messageId,
      channelId: targetChannelId,
      accessHash: targetAccessHash,
      isChunked: false,
    }

    meta[req.userId].files.push(newFile)
    await saveMeta(meta)
    unlink(tmpPath).catch(() => {})

    // Send the completed file as the final SSE event
    send({ type: 'done', file: newFile })
    res.end()

  } catch (err) {
    console.error('upload error:', err)
    if (tmpPath) unlink(tmpPath).catch(() => {})
    send({ type: 'error', error: err.message })
    res.end()
  }
})

// ── DELETE /api/simple/files/:fileId ─────────────────────────────────────
app.delete('/api/simple/files/:fileId', requireUser, async (req, res) => {
  try {
    const meta = await loadMeta()
    const userMeta = meta[req.userId]
    if (!userMeta) return res.status(404).json({ error: 'User not found' })

    const file = userMeta.files.find(f => f.id === req.params.fileId)
    if (!file) return res.status(404).json({ error: 'File not found' })

    // Try to delete the Telegram message
    try {
      const client = await getAdminClient()
      const BigIntC = global.BigInt || Number
      const peer = new Api.InputPeerChannel({
        channelId: BigIntC(file.channelId.replace('-100', '')),
        accessHash: BigIntC(file.accessHash ?? '0'),
      })
      await client.invoke(new Api.channels.DeleteMessages({ channel: peer, id: [file.messageId] }))
    } catch (e) {
      console.warn('Could not delete TG message:', e.message)
    }

    userMeta.files = userMeta.files.filter(f => f.id !== req.params.fileId)
    await saveMeta(meta)
    return res.json({ success: true })
  } catch (err) {
    console.error('delete file error:', err)
    return res.status(500).json({ error: err.message })
  }
})

// ── DELETE /api/simple/folders/:folderId ─────────────────────────────────
app.delete('/api/simple/folders/:folderId', requireUser, async (req, res) => {
  try {
    const meta = await loadMeta()
    const userMeta = meta[req.userId]
    if (!userMeta) return res.status(404).json({ error: 'User not found' })

    const folder = userMeta.folders.find(f => f.id === req.params.folderId)
    if (!folder) return res.status(404).json({ error: 'Folder not found' })

    // Remove files in this folder from metadata
    userMeta.files = userMeta.files.filter(f => f.folderId !== req.params.folderId)
    userMeta.folders = userMeta.folders.filter(f => f.id !== req.params.folderId)
    await saveMeta(meta)
    return res.json({ success: true })
  } catch (err) {
    console.error('delete folder error:', err)
    return res.status(500).json({ error: err.message })
  }
})

// ── GET /api/simple/download/:fileId ─────────────────────────────────────
app.get('/api/simple/download/:fileId', requireUser, async (req, res) => {
  try {
    const meta = await loadMeta()
    const userMeta = meta[req.userId]
    if (!userMeta) return res.status(404).json({ error: 'User not found' })

    const file = userMeta.files.find(f => f.id === req.params.fileId)
    if (!file) return res.status(404).json({ error: 'File not found' })

    const client = await getAdminClient()
    const BigIntC = global.BigInt || Number
    const peer = new Api.InputPeerChannel({
      channelId: BigIntC(file.channelId.replace('-100', '')),
      accessHash: BigIntC(file.accessHash ?? '0'),
    })

    const messages = await client.getMessages(peer, { ids: [file.messageId] })
    if (!messages?.length || !messages[0]) {
      return res.status(404).json({ error: 'File not found in Telegram' })
    }

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`)
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream')

    const buffer = await client.downloadMedia(messages[0], {})
    if (!buffer) return res.status(500).json({ error: 'Failed to download from Telegram' })

    return res.end(Buffer.from(buffer))
  } catch (err) {
    console.error('download error:', err)
    return res.status(500).json({ error: err.message })
  }
})

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = 3002

// Pre-connect admin client on startup
getAdminClient()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n⭐  Admin TG server running at http://localhost:${PORT}`)
      console.log('    /api/simple/files         GET')
      console.log('    /api/simple/folders       POST')
      console.log('    /api/simple/upload        POST')
      console.log('    /api/simple/download/:id  GET')
      console.log('    /api/simple/files/:id     DELETE')
      console.log('    /api/simple/folders/:id   DELETE\n')
    })
  })
  .catch(err => {
    console.error('❌  Failed to connect admin Telegram client:', err.message)
    console.error('    Make sure ADMIN_API_ID, ADMIN_API_HASH, ADMIN_SESSION_STRING are set in .env.local')
    process.exit(1)
  })
