/**
 * src/lib/simpleUserApi.ts
 *
 * For simple (email+password) users: all Telegram operations go through
 * the api-server (Node.js) which holds the persistent admin TG client.
 * The browser never connects to Telegram directly.
 */

const API_BASE = import.meta.env.VITE_SIMPLE_API_URL
  ?? (import.meta.env.DEV ? 'http://localhost:3002' : '')

function authHeaders(userId: string, sessionToken: string) {
  return {
    'Content-Type': 'application/json',
    'x-user-id': userId,
    'x-session-token': sessionToken,
  }
}

export async function apiListFiles(userId: string, sessionToken: string) {
  const res = await fetch(`${API_BASE}/api/simple/files?userId=${encodeURIComponent(userId)}`, {
    headers: authHeaders(userId, sessionToken),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Failed to list files')
  return data as { files: any[]; folders: any[] }
}

export async function apiCreateFolder(userId: string, sessionToken: string, folderName: string) {
  const res = await fetch(`${API_BASE}/api/simple/folders`, {
    method: 'POST',
    headers: authHeaders(userId, sessionToken),
    body: JSON.stringify({ userId, folderName }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Failed to create folder')
  return data
}

export async function apiUploadFile(
  userId: string,
  sessionToken: string,
  file: File,
  folderId: string | null,
  onProgress?: (pct: number) => void
) {
  const form = new FormData()
  form.append('file', file)
  form.append('userId', userId)
  if (folderId) form.append('folderId', folderId)

  // The server streams real GramJS upload progress as SSE events.
  // We use fetch + ReadableStream (not EventSource, which only supports GET).
  const response = await fetch(`${API_BASE}/api/simple/upload`, {
    method: 'POST',
    headers: {
      'x-user-id': userId,
      'x-session-token': sessionToken,
      // Do NOT set Content-Type — browser must set it with the multipart boundary
    },
    body: form,
  })

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => 'Upload failed')
    throw new Error(text)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })

    // SSE events are separated by double newlines
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''  // keep incomplete last chunk

    for (const part of parts) {
      const line = part.trim()
      if (!line.startsWith('data: ')) continue

      let event: any
      try { event = JSON.parse(line.slice(6)) } catch { continue }

      if (event.type === 'progress' && onProgress) {
        onProgress(event.pct)           // real % from GramJS progressCallback
      } else if (event.type === 'done') {
        if (onProgress) onProgress(100)
        return event                    // { success: true, file: {...} }
      } else if (event.type === 'error') {
        throw new Error(event.error ?? 'Upload failed')
      }
    }
  }

  throw new Error('Upload stream ended without a completion event')
}

export async function apiDeleteFile(userId: string, sessionToken: string, fileId: string) {
  const res = await fetch(`${API_BASE}/api/simple/files/${fileId}`, {
    method: 'DELETE',
    headers: authHeaders(userId, sessionToken),
    body: JSON.stringify({ userId }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Failed to delete file')
  return data
}

export async function apiDeleteFolder(userId: string, sessionToken: string, folderId: string) {
  const res = await fetch(`${API_BASE}/api/simple/folders/${folderId}`, {
    method: 'DELETE',
    headers: authHeaders(userId, sessionToken),
    body: JSON.stringify({ userId }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Failed to delete folder')
  return data
}

export async function apiGetDownloadUrl(userId: string, sessionToken: string, fileId: string) {
  const res = await fetch(
    `${API_BASE}/api/simple/download/${fileId}?userId=${encodeURIComponent(userId)}`,
    { headers: authHeaders(userId, sessionToken) }
  )
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Failed to get download URL')
  return data as { url: string; filename: string }
}
