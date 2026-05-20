import type { VercelRequest, VercelResponse } from '@vercel/node'
import { Pool } from 'pg'

let pool: Pool | null = null
function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  }
  return pool
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-user-id, x-session-token')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' })

  const userId = req.headers['x-user-id'] as string
  if (!userId) return res.status(401).json({ error: 'Missing x-user-id header' })

  const { folderId } = req.query as { folderId: string }

  const db = getPool()

  const folderRes = await db.query(
    'SELECT id FROM sc_user_folders WHERE id = $1 AND user_id = $2',
    [folderId, userId]
  )
  if (folderRes.rows.length === 0) {
    return res.status(404).json({ error: 'Folder not found' })
  }

  // Remove all files in the folder and the folder itself
  await db.query('DELETE FROM sc_user_files WHERE folder_id = $1 AND user_id = $2', [folderId, userId])
  await db.query('DELETE FROM sc_user_folders WHERE id = $1 AND user_id = $2', [folderId, userId])

  return res.json({ success: true })
}
