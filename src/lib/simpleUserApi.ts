/**
 * src/lib/simpleUserApi.ts
 *
 * For simple (email+password) users: all Telegram operations go through
 * the Vercel serverless API (Node.js), which holds the persistent admin
 * TG client.  The browser never connects to Telegram directly.
 *
 * Upload strategy:
 *   Files ≤ 3.5 MB  → single POST to /api/simple/upload-chunk
 *   Files  > 3.5 MB → N sequential POSTs to /api/simple/upload-chunk
 *                      (each chunk < 3.5 MB, well under Vercel's 4.5 MB limit)
 *                    → 1 final POST to /api/simple/upload-meta (manifest only)
 */

const API_BASE = import.meta.env.VITE_SIMPLE_API_URL
  ?? (import.meta.env.DEV ? 'http://localhost:3002' : '')

/** 3.5 MB — comfortably under Vercel's 4.5 MB body limit */
const CHUNK_SIZE = 3.5 * 1024 * 1024

function authHeaders(userId: string, sessionToken: string) {
  return {
    'x-user-id': userId,
    'x-session-token': sessionToken,
    // NOTE: Do NOT set Content-Type for multipart — browser must add the boundary
  }
}

// ── Internal SSE reader ────────────────────────────────────────────────────

async function readSSE(
  response: Response,
  onProgress?: (pct: number) => void
): Promise<any> {
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => 'Request failed')
    throw new Error(text)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''

    for (const part of parts) {
      const line = part.trim()
      if (!line.startsWith('data: ')) continue
      let event: any
      try { event = JSON.parse(line.slice(6)) } catch { continue }

      if (event.type === 'progress' && onProgress) {
        onProgress(event.pct)
      } else if (event.type === 'done') {
        if (onProgress) onProgress(100)
        return event
      } else if (event.type === 'error') {
        throw new Error(event.error ?? 'Upload failed')
      }
    }
  }

  throw new Error('Upload stream ended without a completion event')
}

// ── Upload a single chunk (or a small whole file) to /api/simple/upload-chunk

async function uploadOneChunk(
  userId: string,
  sessionToken: string,
  chunkBlob: Blob,
  opts: {
    origName: string
    origSize: number
    origMime: string
    folderId: string | null
    partIndex: number
    totalParts: number
  },
  onProgress?: (pct: number) => void
): Promise<any> {
  const form = new FormData()
  form.append('file', chunkBlob, opts.origName)
  form.append('origName',   opts.origName)
  form.append('origSize',   String(opts.origSize))
  form.append('origMime',   opts.origMime)
  form.append('partIndex',  String(opts.partIndex))
  form.append('totalParts', String(opts.totalParts))
  if (opts.folderId) form.append('folderId', opts.folderId)

  const response = await fetch(`${API_BASE}/api/simple/upload-chunk`, {
    method: 'POST',
    headers: authHeaders(userId, sessionToken),
    body: form,
  })

  return readSSE(response, onProgress)
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function apiListFiles(userId: string, sessionToken: string) {
  const res = await fetch(`${API_BASE}/api/simple/files?userId=${encodeURIComponent(userId)}`, {
    headers: { 'x-user-id': userId, 'x-session-token': sessionToken },
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Failed to list files')
  return data as { files: any[]; folders: any[] }
}

export async function apiCreateFolder(userId: string, sessionToken: string, folderName: string) {
  const res = await fetch(`${API_BASE}/api/simple/folders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user-id': userId, 'x-session-token': sessionToken },
    body: JSON.stringify({ userId, folderName }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Failed to create folder')
  return data
}

/**
 * Upload a file for a simple user.
 *
 * Small files (≤ 3.5 MB): one request → done immediately.
 * Large files (> 3.5 MB): split into ≤ 3.5 MB chunks, upload each
 * sequentially, then register a manifest record with the chunk IDs.
 */
export async function apiUploadFile(
  userId: string,
  sessionToken: string,
  file: File,
  folderId: string | null,
  onProgress?: (pct: number) => void
) {
  const origMime = file.type || 'application/octet-stream'
  const totalParts = Math.ceil(file.size / CHUNK_SIZE)

  if (totalParts <= 1) {
    // ── Single-chunk upload ───────────────────────────────────────────────
    const event = await uploadOneChunk(
      userId, sessionToken,
      file,
      { origName: file.name, origSize: file.size, origMime, folderId, partIndex: 0, totalParts: 1 },
      onProgress
    )
    return { file: event.file }
  }

  // ── Multi-chunk upload ──────────────────────────────────────────────────
  const chunkRecords: any[] = []

  for (let i = 0; i < totalParts; i++) {
    const start = i * CHUNK_SIZE
    const end = Math.min(start + CHUNK_SIZE, file.size)
    const blob = file.slice(start, end)

    const chunkProgress = (pct: number) => {
      // Map this chunk's progress into the overall 0–95% range
      const overall = ((i + pct / 100) / totalParts) * 95
      onProgress?.(Math.round(overall))
    }

    const event = await uploadOneChunk(
      userId, sessionToken,
      blob,
      {
        origName: file.name,
        origSize: file.size,
        origMime,
        folderId,
        partIndex: i,
        totalParts,
      },
      chunkProgress
    )

    chunkRecords.push(event.file)
  }

  // ── Register manifest ─────────────────────────────────────────────────
  onProgress?.(97)

  const firstChunk = chunkRecords[0]
  const manifest = await apiRegisterManifest(userId, sessionToken, {
    name: file.name,
    size: file.size,
    mimeType: origMime,
    folderId,
    messageId: firstChunk.messageId,
    channelId: firstChunk.channelId,
    accessHash: firstChunk.accessHash,
    isChunked: true,
    chunkIds: chunkRecords.map(c => c.id),
  })

  onProgress?.(100)
  return manifest
}

/** Save the manifest for a multi-chunk upload (internal helper). */
async function apiRegisterManifest(
  userId: string,
  sessionToken: string,
  meta: {
    name: string
    size: number
    mimeType: string
    folderId: string | null
    messageId: number
    channelId: string
    accessHash: string | null
    isChunked: boolean
    chunkIds: string[]
  }
) {
  const res = await fetch(`${API_BASE}/api/simple/upload-meta`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-user-id': userId,
      'x-session-token': sessionToken,
    },
    body: JSON.stringify(meta),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Failed to register upload manifest')
  return data as { success: true; file: any }
}

export async function apiDeleteFile(userId: string, sessionToken: string, fileId: string) {
  const res = await fetch(`${API_BASE}/api/simple/files/${fileId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', 'x-user-id': userId, 'x-session-token': sessionToken },
    body: JSON.stringify({ userId }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Failed to delete file')
  return data
}

export async function apiDeleteFolder(userId: string, sessionToken: string, folderId: string) {
  const res = await fetch(`${API_BASE}/api/simple/folders/${folderId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', 'x-user-id': userId, 'x-session-token': sessionToken },
    body: JSON.stringify({ userId }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Failed to delete folder')
  return data
}

export async function apiGetDownloadUrl(userId: string, sessionToken: string, fileId: string) {
  const res = await fetch(
    `${API_BASE}/api/simple/download/${fileId}?userId=${encodeURIComponent(userId)}`,
    { headers: { 'x-user-id': userId, 'x-session-token': sessionToken } }
  )
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Failed to get download URL')
  return data as { url: string; filename: string }
}
