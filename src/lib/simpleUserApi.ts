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

/**
 * Register a file that has already been uploaded directly from the browser
 * to Telegram. This only sends tiny metadata JSON to Vercel — the file bytes
 * never pass through the serverless function, so there is no 4.5 MB limit.
 */
export async function apiRegisterUpload(
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
    chunkMessageIds?: number[]
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
  if (!res.ok) throw new Error(data.error ?? 'Failed to register upload')
  return data as { success: true; file: any }
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
