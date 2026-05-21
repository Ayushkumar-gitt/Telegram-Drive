/**
 * src/lib/simpleUserApi.ts
 *
 * All API calls for simple (email+password) users go to the Railway server.
 * The server is a persistent Node.js Express process with:
 *   - No request body size limit
 *   - No execution timeout
 *   - One persistent Telegram client (no per-request reconnects)
 *
 * Upload: sends the full file in one multipart POST.
 *         Railway has no body-size limit — this just works for any file size.
 * Download: server streams directly from Telegram using iterDownload.
 */

// In production (Railway) the server serves both the frontend and the API
// from the same origin, so no base URL is needed.
// In local dev, set VITE_SIMPLE_API_URL=http://localhost:3000 (or 3002).
const API_BASE = import.meta.env.VITE_SIMPLE_API_URL ?? ''

function authHeaders(userId: string) {
  return {
    'x-user-id': userId,
    // session token not needed — userId is the identity on the server
  }
}

// ── Two-phase upload with real progress ────────────────────────────────────
//
// Phase 1 (0 → 50 %): Browser → Railway server
//   Uses XMLHttpRequest.upload.onprogress — fires as bytes leave your device.
//   fetch() has no equivalent API, which is why the progress bar was silent.
//
// Phase 2 (50 → 100 %): Railway server → Telegram
//   The server responds with an SSE stream (text/event-stream).
//   Each "data: {type:'progress', pct:N}" event maps to this phase.
//   Server progress 0–100 is remapped to 50–100 in the UI.

function parseSSEChunk(chunk: string): Array<{ type: string; [k: string]: any }> {
  const events: Array<{ type: string; [k: string]: any }> = []
  for (const part of chunk.split('\n\n')) {
    const line = part.trim()
    if (!line.startsWith('data: ')) continue
    try { events.push(JSON.parse(line.slice(6))) } catch { /* skip malformed */ }
  }
  return events
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function apiListFiles(userId: string, _sessionToken?: string) {
  const res = await fetch(`${API_BASE}/api/simple/files`, {
    headers: authHeaders(userId),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Failed to list files')
  return data as { files: any[]; folders: any[] }
}

export async function apiCreateFolder(userId: string, _sessionToken: string, folderName: string) {
  const res = await fetch(`${API_BASE}/api/simple/folders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(userId) },
    body: JSON.stringify({ folderName }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Failed to create folder')
  return data
}

/**
 * Upload a file using XHR so we get real upload progress.
 *
 * Progress mapping:
 *   0 – 50 %  →  bytes leaving the browser  (xhr.upload.onprogress)
 *  50 – 100 % →  server relaying to Telegram (SSE events in XHR response)
 */
export function apiUploadFile(
  userId: string,
  _sessionToken: string,
  file: File,
  folderId: string | null,
  onProgress?: (pct: number) => void
): Promise<{ file: any }> {
  return new Promise((resolve, reject) => {
    const form = new FormData()
    form.append('file', file, file.name)
    if (folderId) form.append('folderId', folderId)

    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${API_BASE}/api/simple/upload`)
    xhr.setRequestHeader('x-user-id', userId)

    // ── Phase 1: browser → server (real network bytes) ──────────────────
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable || !onProgress) return
      // Map 0–100% of the network upload → 0–50% of the UI bar
      const pct = Math.round((e.loaded / e.total) * 50)
      onProgress(pct)
    }

    // ── Phase 2: server → Telegram (SSE events in the response body) ────
    let sseBuffer = ''

    xhr.onprogress = () => {
      // responseText grows as SSE chunks arrive; process the new portion
      const newText = xhr.responseText.slice(sseBuffer.length)
      sseBuffer = xhr.responseText

      for (const event of parseSSEChunk(newText)) {
        if (event.type === 'progress' && onProgress) {
          // Server reports 0–100 for its Telegram upload; map to 50–99 in UI
          const pct = 50 + Math.round((event.pct / 100) * 49)
          onProgress(pct)
        } else if (event.type === 'done') {
          if (onProgress) onProgress(100)
          resolve({ file: event.file })
        } else if (event.type === 'error') {
          reject(new Error(event.error ?? 'Upload failed'))
        }
      }
    }

    xhr.onload = () => {
      // Final parse in case the last SSE chunk arrived with onload
      for (const event of parseSSEChunk(xhr.responseText.slice(sseBuffer.length))) {
        if (event.type === 'done') { if (onProgress) onProgress(100); resolve({ file: event.file }); return }
        if (event.type === 'error') { reject(new Error(event.error ?? 'Upload failed')); return }
      }
      // If we never got a 'done' event, treat as error
      if (xhr.status !== 200) reject(new Error(`Upload failed (HTTP ${xhr.status})`))
    }

    xhr.onerror = () => reject(new Error('Network error during upload'))
    xhr.ontimeout = () => reject(new Error('Upload timed out'))

    xhr.send(form)
  })
}

export async function apiDeleteFile(userId: string, _sessionToken: string, fileId: string) {
  const res = await fetch(`${API_BASE}/api/simple/files/${fileId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...authHeaders(userId) },
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Failed to delete file')
  return data
}

export async function apiDeleteFolder(userId: string, _sessionToken: string, folderId: string) {
  const res = await fetch(`${API_BASE}/api/simple/folders/${folderId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...authHeaders(userId) },
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Failed to delete folder')
  return data
}

/**
 * Returns the URL to stream-download a file through the Railway server.
 * The browser hits this URL directly; the server proxies bytes from Telegram.
 */
export function apiGetDownloadUrl(userId: string, fileId: string): string {
  return `${API_BASE}/api/simple/download/${fileId}?_uid=${encodeURIComponent(userId)}`
}
