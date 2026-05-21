/**
 * src/lib/simpleUserApi.ts
 *
 * API calls for simple (email+password) users.
 *
 * Architecture after egress fix:
 *   UPLOAD:   Browser → Telegram directly (GramJS in browser, zero Railway egress)
 *             Browser → Railway  POST /api/simple/files  (tiny JSON metadata only)
 *   DOWNLOAD: Browser → Telegram directly (GramJS in browser, zero Railway egress)
 *   AUTH:     Browser → Railway  (JSON only, negligible egress)
 *   FOLDERS:  Browser → Railway → Telegram (channel creation, infrequent, ~KB)
 *
 * Railway egress after this change: effectively $0 for file data.
 */

const API_BASE = import.meta.env.VITE_SIMPLE_API_URL ?? ''

function authHeaders(userId: string) {
  return { 'x-user-id': userId }
}

// ── File listing ───────────────────────────────────────────────────────────

export async function apiListFiles(userId: string, _sessionToken?: string) {
  const res = await fetch(`${API_BASE}/api/simple/files`, {
    headers: authHeaders(userId),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Failed to list files')
  return data as { files: any[]; folders: any[] }
}

// ── Root channel ───────────────────────────────────────────────────────────
// Called before uploading so the browser knows which Telegram channel to use.
// Railway only creates the channel if it doesn't exist; after that it's cached.

export async function apiGetRootChannel(userId: string): Promise<{ channelId: string; accessHash: string }> {
  const res = await fetch(`${API_BASE}/api/simple/root-channel`, {
    headers: authHeaders(userId),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Failed to get root channel')
  return data as { channelId: string; accessHash: string }
}

// ── Save file metadata (called AFTER the browser uploads directly to TG) ───

export async function apiSaveFileMeta(userId: string, fileMeta: {
  id: string
  name: string
  size: number
  mimeType: string
  createdAt: number
  folderId: string | null
  messageId: number
  channelId: string
  accessHash?: string
  isChunked?: boolean
  chunkMessageIds?: number[]
}) {
  const res = await fetch(`${API_BASE}/api/simple/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(userId) },
    body: JSON.stringify(fileMeta),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'Failed to save file metadata')
  return data
}

// ── Folders ────────────────────────────────────────────────────────────────

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

// ── Delete ─────────────────────────────────────────────────────────────────

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

// ── Legacy stub (unused — upload is now done via GramJS in Uploader.tsx) ──
// Kept so any import of apiUploadFile doesn't break compilation.
export async function apiUploadFile(
  _userId: string, _sessionToken: string, _file: File,
  _folderId: string | null, _onProgress?: (pct: number) => void
): Promise<{ file: any }> {
  throw new Error('apiUploadFile is deprecated — use uploadFileToTelegram directly in Uploader.tsx')
}
