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

// ── Internal SSE reader ────────────────────────────────────────────────────

async function readSSE(
  response: Response,
  onProgress?: (pct: number) => void
): Promise<any> {
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => 'Request failed')
    throw new Error(text)
  }

  const reader  = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer    = ''

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
 * Upload a file.
 * Railway has no body size limit — send the whole file in one POST.
 * Progress is streamed back via SSE from the server.
 */
export async function apiUploadFile(
  userId: string,
  _sessionToken: string,
  file: File,
  folderId: string | null,
  onProgress?: (pct: number) => void
) {
  const form = new FormData()
  form.append('file', file, file.name)
  if (folderId) form.append('folderId', folderId)

  const response = await fetch(`${API_BASE}/api/simple/upload`, {
    method: 'POST',
    headers: authHeaders(userId),
    body: form,
  })

  const event = await readSSE(response, onProgress)
  return { file: event.file }
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
