import React, { useState, useMemo, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useFileSystemStore, type TGFile, type TGFolder } from '../store/filesystem'
import { useAuthStore } from '../store/auth'
import { useDownloadStore } from '../store/download'
import { getTelegramClient, resetClient } from '../lib/telegram'
import { apiListFiles, apiCreateFolder, apiTrashItem, apiRestoreItem, apiListTrash, apiEmptyTrash, apiCreateShareLink, apiGetStats, apiUploadFromUrl, apiRenameFile, apiSuggestName, apiSuggestNameFromImage } from '../lib/simpleUserApi'
import { format } from 'date-fns'
import { filesize } from 'filesize'
import {
  Folder as FolderIcon,
  File as FileIcon,
  FileText as PdfIcon,
  Plus,
  ArrowLeft,
  Search,
  Download as DownloadIcon,
  Trash2 as TrashIcon,
  LayoutGrid,
  List as ListIcon,
  X,
  Image as ImageIcon,
  BarChart3,
  Copy,
  RotateCcw,
  Trash,
  Cloud,
  CheckSquare,
  Square,
  LogOut,
  FolderPlus,
  Pencil,
  Sparkles,
  Type,
  Wand2,
  Loader2
} from 'lucide-react'
import { Api } from 'telegram'
import { v4 as uuidv4 } from 'uuid'
import { toast } from 'react-hot-toast'
import { useNavigate } from 'react-router-dom'
import { Uploader } from '../components/Uploader'
import { DownloadBar } from '../components/DownloadBar'
import { FileViewer } from '../components/FileViewer'
import { Thumbnail } from '../components/Thumbnail'

export const Dashboard = () => {
  const navigate = useNavigate()
  const { sessionString, apiId, apiHash, userId, logout, accountType } = useAuthStore()
  const {
    files,
    folders,
    addFolder,
    syncFromMetadataChannel,
    syncToMetadataChannel,
    clearForNewSession,
    metadataChannelId
  } = useFileSystemStore()

  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [isCreatingFolder, setIsCreatingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [viewingFile, setViewingFile] = useState<TGFile | null>(null)
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')

  const [recentFileIds, setRecentFileIds] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('recentFileIds') || '[]') } catch { return [] }
  })
  
  const handleFileOpen = (file: TGFile) => {
    setViewingFile(file)
    setRecentFileIds(prev => {
      const updated = [file.id, ...prev.filter(id => id !== file.id)].slice(0, 3)
      localStorage.setItem('recentFileIds', JSON.stringify(updated))
      return updated
    })
  }

  // New feature state
  type TabType = 'overview' | 'files' | 'gallery' | 'trash' | 'stats'
  const [activeTab, setActiveTab] = useState<TabType>('overview')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())


  const [trashFiles, setTrashFiles] = useState<any[]>([])
  const [trashFolders, setTrashFolders] = useState<any[]>([])
  const [shareModalFile, setShareModalFile] = useState<TGFile | null>(null)
  const [shareLink, setShareLink] = useState<string | null>(null)
  const [urlUploadOpen, setUrlUploadOpen] = useState(false)
  const [uploadUrl, setUploadUrl] = useState('')
  const [urlUploadProgress, setUrlUploadProgress] = useState<number | null>(null)
  const [stats, setStats] = useState<any>(null)
  const [isInitializing, setIsInitializing] = useState(true)

  // ── Rename state ──
  const [renameFile, setRenameFile] = useState<TGFile | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [isAISuggesting, setIsAISuggesting] = useState(false)

  // ── OCR / Extract Text state ──
  const [ocrFile, setOcrFile] = useState<TGFile | null>(null)
  const [ocrText, setOcrText] = useState('')
  const [isExtracting, setIsExtracting] = useState(false)

  // Initialize: load file list
  // Simple users: load from Railway server DB (lightweight JSON, zero TG connection needed)
  // Telegram users: connect to TG and sync from metadata channel
  // TG connection for simple users happens lazily on first upload/download (in Uploader)
  useEffect(() => {
    if (accountType === 'simple') {
      if (!userId) {
        setIsInitializing(false)
        return
      }
      apiListFiles(userId, userId)
        .then(data => {
          const { setFilesAndFolders } = useFileSystemStore.getState() as any
          if (setFilesAndFolders) {
            setFilesAndFolders(data.files, data.folders.filter((f: any) => f.id !== '__root__'))
          } else {
            data.files.forEach((f: any) => useFileSystemStore.getState().addFile(f))
            data.folders
              .filter((f: any) => f.id !== '__root__')
              .forEach((f: any) => useFileSystemStore.getState().addFolder(f))
          }
        })
        .catch(err => console.error('Failed to load files:', err))
        .finally(() => setIsInitializing(false))
    } else if (sessionString && apiId && apiHash) {
      getTelegramClient(sessionString, apiId, apiHash).then(client => {
        syncFromMetadataChannel(client).finally(() => setIsInitializing(false))
      })
    } else {
      setIsInitializing(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountType, userId, sessionString, apiId, apiHash])

  const handleLogout = () => {
    clearForNewSession()   // wipe file list so next user starts clean
    resetClient()          // disconnect the TG client singleton
    logout()
    navigate('/login')
  }

  const handleCreateFolder = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newFolderName.trim()) return

    try {
      if (accountType === 'simple') {
        // ── Simple user: create folder via server API ─────────────────────
        if (!userId) return
        const result = await apiCreateFolder(userId, userId, newFolderName.trim())
        useFileSystemStore.getState().addFolder(result.folder)
      } else {
        // ── Telegram user: create channel via browser GramJS ──────────────
        if (!sessionString || !apiId || !apiHash) return
        const client = await getTelegramClient(sessionString, apiId, apiHash)
        if (!metadataChannelId) await syncFromMetadataChannel(client)

        const result = await client.invoke(
          new Api.channels.CreateChannel({
            title: `TGC_${newFolderName.trim()}`,
            about: `Folder: ${newFolderName.trim()} | User: ${userId}`,
            broadcast: true,
          })
        )
        const channel = (result as any).chats[0]
        const rawId = channel.id.toString()
        const channelId = rawId.startsWith('-100') ? rawId : `-100${rawId}`
        const newFolder: TGFolder = {
          id: uuidv4(),
          name: newFolderName.trim(),
          createdAt: Date.now(),
          channelId,
          accessHash: channel.accessHash.toString()
        }
        addFolder(newFolder)
        await syncToMetadataChannel(client)
      }

      setIsCreatingFolder(false)
      setNewFolderName('')
      toast.success('Folder created')
    } catch (error: any) {
      console.error(error)
      toast.error(error?.message ?? 'Failed to create folder')
    }
  }

  // ── Shared download handler (with progress tracking) ─────────────────────
  const { addTask: addDownloadTask, updateTaskProgress: updateDownloadProgress, setTaskStatus: setDownloadStatus } = useDownloadStore()
  
  const handleDownload = async (file: TGFile) => {
    const taskId = uuidv4()
    addDownloadTask({ id: taskId, fileName: file.name, fileSize: file.size, progress: 0, status: 'pending' })
    setDownloadStatus(taskId, 'downloading')

    try {
      const controller = new AbortController()
      const { downloadControllers } = await import('../store/download')
      downloadControllers.set(taskId, controller)

      if (accountType === 'simple') {
        // Simple user: download via server with progress via ReadableStream
        if (!userId) return
        const SIMPLE_API = import.meta.env.DEV ? 'http://localhost:3000' : ''
        const resp = await fetch(`${SIMPLE_API}/api/simple/download/${file.id}`, {
          headers: { 'x-user-id': userId },
          signal: controller.signal
        })
        if (!resp.ok) throw new Error('Download failed')

        const contentLength = Number(resp.headers.get('content-length') || file.size)
        const reader = resp.body?.getReader()
        if (!reader) throw new Error('ReadableStream not supported')

        const chunks: Uint8Array[] = []
        let received = 0
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
          received += value.length
          updateDownloadProgress(taskId, (received / contentLength) * 100)
        }

        const blob = new Blob(chunks as BlobPart[], { type: file.mimeType || 'application/octet-stream' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url; a.download = file.name
        document.body.appendChild(a); a.click()
        setTimeout(() => { URL.revokeObjectURL(url); a.remove() }, 1000)

        setDownloadStatus(taskId, 'completed')
        downloadControllers.delete(taskId)

      } else {
        // Telegram user: download via browser GramJS with progress callback
        if (!sessionString || !apiId || !apiHash) throw new Error('Not authenticated')
        const { downloadFileFromTelegram } = await import('../lib/download')
        const client = await getTelegramClient(sessionString, apiId, apiHash)
        await downloadFileFromTelegram(client, file, (pct) => updateDownloadProgress(taskId, pct), controller.signal)
        setDownloadStatus(taskId, 'completed')
        downloadControllers.delete(taskId)
      }
    } catch (error: any) {
      const { downloadControllers } = await import('../store/download')
      if (error.name === 'AbortError' || error.message === 'Cancelled') {
        setDownloadStatus(taskId, 'error', 'Cancelled')
      } else {
        setDownloadStatus(taskId, 'error')
        toast.error('Download failed: ' + error.message)
      }
      downloadControllers.delete(taskId)
    }
  }

  // ── Shared delete handler ─────────────────────────────────────────────────
  const handleDelete = async (item: any, isFolder: boolean) => {
    if (!confirm(`Move this ${isFolder ? 'folder' : 'file'} to trash?`)) return
    try {
      if (accountType === 'simple') {
        if (!userId) return
        await apiTrashItem(userId, item.id, isFolder ? 'folder' : 'file')
        if (isFolder) useFileSystemStore.getState().trashFolder(item.id)
        else useFileSystemStore.getState().trashFile(item.id)
      } else {
        if (isFolder) useFileSystemStore.getState().trashFolder(item.id)
        else useFileSystemStore.getState().trashFile(item.id)
        if (sessionString && apiId && apiHash) {
          const client = await getTelegramClient(sessionString, apiId, apiHash)
          await syncToMetadataChannel(client)
        }
      }
      toast.success(`${isFolder ? 'Folder' : 'File'} moved to trash`)
    } catch (err: any) {
      toast.error(err.message ?? 'Delete failed')
    }
  }

  // ── Trash handlers ───────────────────────────────────────────────────────
  const loadTrash = async () => {
    if (!userId) return
    if (accountType === 'simple') {
      try {
        const data = await apiListTrash(userId)
        setTrashFiles(data.files); setTrashFolders(data.folders)
      } catch { toast.error('Failed to load trash') }
    } else {
      const state = useFileSystemStore.getState()
      setTrashFiles(state.files.filter(f => f.isTrashed))
      setTrashFolders(state.folders.filter(f => f.isTrashed))
    }
  }

  const handleRestore = async (id: string, type: 'file' | 'folder') => {
    if (!userId) return
    try {
      if (accountType === 'simple') {
        await apiRestoreItem(userId, id, type)
        // Reload main files
        const data = await apiListFiles(userId, userId)
        useFileSystemStore.getState().setFilesAndFolders(data.files, data.folders.filter((f: any) => f.id !== '__root__'))
      } else {
        if (type === 'folder') useFileSystemStore.getState().restoreFolder(id)
        else useFileSystemStore.getState().restoreFile(id)
        if (sessionString && apiId && apiHash) {
          const client = await getTelegramClient(sessionString, apiId, apiHash)
          await syncToMetadataChannel(client)
        }
      }
      toast.success('Restored')
      loadTrash()
    } catch { toast.error('Failed to restore') }
  }

  const handleEmptyTrash = async () => {
    if (!userId || !confirm('Permanently delete everything in trash?')) return
    try {
      if (accountType === 'simple') {
        await apiEmptyTrash(userId)
      } else {
        const state = useFileSystemStore.getState()
        const trashedFiles = state.files.filter(f => f.isTrashed)

        if (sessionString && apiId && apiHash && trashedFiles.length > 0) {
          const client = await getTelegramClient(sessionString, apiId, apiHash)
          const { Api } = await import('telegram')
          const BigIntConstructor = (window as any).BigInt || globalThis.BigInt || Number

          const byChannel: Record<string, number[]> = {}
          for (const f of trashedFiles) {
            const key = `${f.channelId}:${f.accessHash}`
            if (!byChannel[key]) byChannel[key] = []
            byChannel[key].push(f.messageId)
            if (f.isChunked && f.chunkMessageIds) {
              byChannel[key].push(...f.chunkMessageIds)
            }
          }

          for (const [key, msgIds] of Object.entries(byChannel)) {
            const [channelId, accessHash] = key.split(':')
            const peer = new Api.InputPeerChannel({
              channelId: BigIntConstructor(channelId.replace('-100', '')) as any,
              accessHash: BigIntConstructor(accessHash || '0') as any
            })
            await client.invoke(new Api.channels.DeleteMessages({ channel: peer, id: msgIds }))
          }
          state.emptyTrash()
          await syncToMetadataChannel(client)
        } else {
          state.emptyTrash()
          if (sessionString && apiId && apiHash) {
            const client = await getTelegramClient(sessionString, apiId, apiHash)
            await syncToMetadataChannel(client)
          }
        }
      }
      setTrashFiles([]); setTrashFolders([])
      toast.success('Trash emptied')
    } catch (err: any) { toast.error('Failed to empty trash') }
  }

  // ── Share handler ────────────────────────────────────────────────────────
  const handleShare = async (file: TGFile) => {
    if (!userId) return
    try {
      if (accountType === 'simple') {
        const data = await apiCreateShareLink(userId, file.id)
        const link = `${window.location.origin}/share/${data.linkId}`
        setShareLink(link); setShareModalFile(file)
      } else {
        // For Telegram users: create a server-backed share link
        if (!sessionString || !apiId || !apiHash) { toast.error('Not authenticated'); return }
        const SIMPLE_API = import.meta.env.DEV ? 'http://localhost:3000' : ''
        const res = await fetch(`${SIMPLE_API}/api/tg/share`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: file.name,
            fileSize: file.size,
            mimeType: file.mimeType,
            channelId: file.channelId,
            accessHash: file.accessHash,
            messageId: file.messageId,
            isChunked: file.isChunked || false,
            chunkMessageIds: file.chunkMessageIds || null,
            sessionString,
            apiId,
            apiHash,
          })
        })
        if (!res.ok) throw new Error('Failed to create share link')
        const data = await res.json()
        const link = `${window.location.origin}/share/${data.linkId}`
        setShareLink(link); setShareModalFile(file)
      }
    } catch { toast.error('Failed to create share link') }
  }

  // ── Move file (drag & drop) ──────────────────────────────────────────────


  const handleUrlUpload = async () => {
    if (!userId || !uploadUrl.trim()) return
    setUrlUploadProgress(0)
    try {
      if (accountType === 'simple') {
        const result = await apiUploadFromUrl(userId, uploadUrl.trim(), currentFolderId, (pct) => setUrlUploadProgress(pct))
        useFileSystemStore.getState().addFile(result.file)
        toast.success('File uploaded from URL')
        setUrlUploadOpen(false); setUploadUrl(''); setUrlUploadProgress(null)
      } else {
        // Proxy through server to bypass CORS, then upload via GramJS
        const SIMPLE_API = import.meta.env.DEV ? 'http://localhost:3000' : ''
        const proxyUrl = `${SIMPLE_API}/api/simple/proxy-url?url=${encodeURIComponent(uploadUrl.trim())}&userId=${userId}`
        const res = await fetch(proxyUrl, { headers: { 'x-user-id': userId } })
        if (!res.ok) throw new Error('Failed to proxy URL download')

        const blob = await res.blob()
        const cd = res.headers.get('content-disposition')
        let fileName = uploadUrl.split('/').pop()?.split('?')[0] || 'file'
        if (cd) {
          const m = cd.match(/filename[*]?=['"]?([^;'"\n]+)/)
          if (m) fileName = decodeURIComponent(m[1])
        }

        const file = new File([blob], fileName, { type: blob.type })
        if (!sessionString || !apiId || !apiHash) throw new Error('Not authenticated')

        setUrlUploadProgress(10)

        const { uploadFileToTelegram } = await import('../lib/upload')
        const { getTelegramClient } = await import('../lib/telegram')
        const client = await getTelegramClient(sessionString, apiId, apiHash)

        const state = useFileSystemStore.getState()
        let targetChannelId = state.metadataChannelId!
        let targetAccessHash = state.metadataAccessHash!

        if (currentFolderId) {
          const folder = state.folders.find(f => f.id === currentFolderId)
          if (folder) { targetChannelId = folder.channelId; targetAccessHash = folder.accessHash }
        }

        const tgFile = await uploadFileToTelegram(
          client, file, currentFolderId,
          targetChannelId, targetAccessHash,
          (pct) => setUrlUploadProgress(10 + Math.floor(pct * 0.9))
        )

        useFileSystemStore.getState().addFile(tgFile)
        await syncToMetadataChannel(client)
        toast.success('File uploaded from URL')
        setUrlUploadOpen(false); setUploadUrl(''); setUrlUploadProgress(null)
      }
    } catch (err: any) {
      toast.error(err.message || 'URL upload failed')
      setUrlUploadProgress(null)
    }
  }

  // ── Stats ────────────────────────────────────────────────────────────────
  const loadStats = async () => {
    if (!userId) return
    try {
      if (accountType === 'simple') {
        setStats(await apiGetStats(userId))
      } else {
        const filesToCount = files.filter(f => !f.isTrashed)
        const foldersToCount = folders.filter(f => !f.isTrashed)
        const totalSize = filesToCount.reduce((acc, f) => acc + (f.size || 0), 0)

        const byType: Record<string, { count: number, size: number }> = {
          'Images': { count: 0, size: 0 },
          'Videos': { count: 0, size: 0 },
          'Audio': { count: 0, size: 0 },
          'PDFs': { count: 0, size: 0 },
          'Archives': { count: 0, size: 0 },
          'Other': { count: 0, size: 0 }
        }

        filesToCount.forEach(f => {
          const m = f.mimeType || ''
          let cat = 'Other'
          if (m.startsWith('image/')) cat = 'Images'
          else if (m.startsWith('video/')) cat = 'Videos'
          else if (m.startsWith('audio/')) cat = 'Audio'
          else if (m === 'application/pdf') cat = 'PDFs'
          else if (m.includes('zip') || m.includes('rar') || m.includes('tar') || m.includes('7z')) cat = 'Archives'

          byType[cat].count++
          byType[cat].size += (f.size || 0)
        })

        setStats({
          totalSize,
          totalFiles: filesToCount.length,
          totalFolders: foldersToCount.length,
          byType: Object.entries(byType).filter(([_, v]) => v.count > 0).map(([category, stats]) => ({ category, ...stats }))
        })
      }
    } catch { toast.error('Failed to load stats') }
  }

  // ── Rename handler ──────────────────────────────────────────────────────
  const openRenameModal = (file: TGFile) => {
    setRenameFile(file)
    setRenameValue(file.name)
    setIsAISuggesting(false)
  }

  const handleRename = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!renameFile || !renameValue.trim() || !userId) return
    try {
      if (accountType === 'simple') {
        await apiRenameFile(userId, renameFile.id, renameValue.trim())
      }
      useFileSystemStore.getState().renameFile(renameFile.id, renameValue.trim())
      if (accountType === 'telegram' && sessionString && apiId && apiHash) {
        const client = await getTelegramClient(sessionString, apiId, apiHash)
        await syncToMetadataChannel(client)
      }
      toast.success('File renamed')
      setRenameFile(null)
    } catch (err: any) {
      toast.error(err.message ?? 'Rename failed')
    }
  }

  const handleAISuggestName = async () => {
    if (!renameFile || !userId) return
    setIsAISuggesting(true)
    try {
      const isImage = renameFile.mimeType?.startsWith('image/')
      let result: { suggestedName: string }
      if (isImage && accountType === 'simple') {
        // For images on simple accounts, use vision-based analysis
        result = await apiSuggestNameFromImage(userId, renameFile.id, renameFile.name)
      } else {
        result = await apiSuggestName(userId, renameFile.name, renameFile.mimeType, renameFile.size)
      }
      setRenameValue(result.suggestedName)
      toast.success('AI suggested a name!')
    } catch (err: any) {
      toast.error(err.message ?? 'AI suggestion failed')
    } finally {
      setIsAISuggesting(false)
    }
  }

  // ── OCR / Extract Text handler ──────────────────────────────────────────
  const handleExtractText = async (file: TGFile) => {
    setOcrFile(file)
    setOcrText('')
    setIsExtracting(true)
    try {
      // We need the image URL. Check the session cache first, otherwise download it.
      let imageUrl: string | null = null

      if (accountType === 'simple') {
        const SIMPLE_API = import.meta.env.DEV ? 'http://localhost:3000' : ''
        imageUrl = `${SIMPLE_API}/api/simple/download/${file.id}?userId=${userId}`
      } else {
        // For telegram users, download via GramJS
        if (!sessionString || !apiId || !apiHash) throw new Error('Not authenticated')
        const client = await getTelegramClient(sessionString, apiId, apiHash)
        let peer: any = Number(file.channelId)
        if (file.accessHash) {
          const BigIntConstructor = (window as any).BigInt || globalThis.BigInt || Number
          const { Api: TgApi } = await import('telegram')
          peer = new TgApi.InputPeerChannel({
            channelId: BigIntConstructor(file.channelId.replace('-100', '')) as any,
            accessHash: BigIntConstructor(file.accessHash) as any
          })
        }
        const messages = await client.getMessages(peer, { ids: [file.messageId] })
        if (messages.length > 0 && messages[0].media) {
          const buffer = await client.downloadMedia(messages[0], { workers: 4 } as any)
          if (buffer) {
            const { Buffer: Buf } = await import('buffer')
            const blob = new Blob([Buf.from(buffer as ArrayBuffer)], { type: file.mimeType })
            imageUrl = URL.createObjectURL(blob)
          }
        }
      }

      if (!imageUrl) throw new Error('Could not load image for OCR')

      const Tesseract = await import('tesseract.js')
      const result = await Tesseract.recognize(imageUrl, 'eng', {
        logger: (m: any) => {
          if (m.status === 'recognizing text' && m.progress) {
            // Progress is 0-1
          }
        }
      })
      setOcrText(result.data.text || 'No text detected in this image.')
    } catch (err: any) {
      console.error('OCR error:', err)
      setOcrText('Failed to extract text: ' + (err.message || 'Unknown error'))
    } finally {
      setIsExtracting(false)
    }
  }

  // ── Multi-select ─────────────────────────────────────────────────────────
  const toggleSelect = (id: string) => {
    setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  const handleBulkDelete = async () => {
    if (!userId || selectedIds.size === 0) return
    if (!confirm(`Move ${selectedIds.size} items to trash?`)) return
    for (const id of selectedIds) {
      try {
        const isFolder = folders.some(f => f.id === id)
        if (accountType === 'simple') {
          await apiTrashItem(userId, id, isFolder ? 'folder' : 'file')
        }
        if (isFolder) useFileSystemStore.getState().trashFolder(id)
        else useFileSystemStore.getState().trashFile(id)
      } catch { }
    }
    if (accountType === 'telegram' && sessionString && apiId && apiHash) {
      const client = await getTelegramClient(sessionString, apiId, apiHash)
      await syncToMetadataChannel(client)
    }
    setSelectedIds(new Set())
    toast.success('Items moved to trash')
  }

  const handleBulkDownload = () => {
    const filesToDl = files.filter(f => selectedIds.has(f.id))
    filesToDl.forEach(f => handleDownload(f))
    setSelectedIds(new Set())
  }
  // ── Tab change effect ────────────────────────────────────────────────────
  useEffect(() => {
    if (activeTab === 'trash') loadTrash()
    if (activeTab === 'stats') loadStats()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab])


  // ── Gallery media files ──────────────────────────────────────────────────
  const mediaFiles = useMemo(() => files.filter(f => !f.isTrashed && (f.mimeType?.startsWith('image/') || f.mimeType?.startsWith('video/'))), [files])


  // Filter items
  const items = useMemo(() => {
    let filteredFolders = folders.filter(f => !f.isTrashed)
    let filteredFiles = files.filter(f => !f.isTrashed)

    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      filteredFolders = []  // Don't show folders in search results
      // When inside a folder, search only files in that folder
      const scopedFiles = currentFolderId
        ? filteredFiles.filter(f => f.folderId === currentFolderId)
        : filteredFiles
      filteredFiles = scopedFiles.filter(f => f.name.toLowerCase().includes(q))
    } else {
      filteredFiles = filteredFiles.filter(f => f.folderId === currentFolderId)
      filteredFolders = currentFolderId ? [] : filteredFolders
    }

    // Add a type flag so we don't have to guess based on 'accessHash'
    const foldersWithType = filteredFolders.map(f => ({ ...f, type: 'folder' }))
    const filesWithType = filteredFiles.map(f => ({ ...f, type: 'file' }))

    return [...foldersWithType, ...filesWithType]
  }, [files, folders, currentFolderId, searchQuery])

  // Virtualizer for high performance grid


  const getFileIcon = (file: TGFile) => {
    if (file.mimeType.startsWith('image/') || file.mimeType.startsWith('video/')) {
      return <Thumbnail file={file} />
    }
    if (file.mimeType === 'application/pdf') return <PdfIcon className="w-5 h-5 text-red-500 flex-shrink-0" />
    return <FileIcon className="w-5 h-5 text-gray-500 flex-shrink-0" />
  }


  // Derived state for the redesign
  const recentOpenedFiles = useMemo(() => {
    const fileMap = new Map(files.map(f => [f.id, f]))
    const recent = recentFileIds.map(id => fileMap.get(id)).filter(Boolean) as TGFile[]
    if (recent.length > 0) return recent
    return [...files].filter(f => !f.isTrashed).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 3)
  }, [files, recentFileIds])

  const newFilesList = useMemo(() => {
    return [...files].filter(f => !f.isTrashed).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 4)
  }, [files])

  const sharedFilesList = useMemo(() => {
    // Just showing some files as "Shared" for UI purposes
    return [...files].filter(f => !f.isTrashed).slice(0, 6)
  }, [files])

  return (
    <div className="h-screen flex bg-[#0A0D14] text-white font-sans overflow-hidden">
      
      {/* ── Left Sidebar ── */}
      <aside className="hidden md:flex w-64 bg-[#0A0D14] border-r border-white/5 flex-col flex-shrink-0">
        <div className="p-6">
          <h1 className="text-2xl font-bold tracking-tighter text-[#5A62FB] flex items-center gap-2">
            <Cloud className="w-6 h-6" />
            Cloud Space
          </h1>
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-4 no-scrollbar">
          <div className="mb-6">
            <button 
              onClick={() => { setActiveTab('overview'); setCurrentFolderId(null) }}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${activeTab === 'overview' ? 'text-[#5A62FB] bg-[#5A62FB]/10 font-medium' : 'text-neutral-400 hover:text-white hover:bg-white/5'}`}
            >
              <LayoutGrid className="w-5 h-5" />
              My drive
            </button>
          </div>

          <div className="mb-6">
            <p className="px-4 text-xs font-bold text-neutral-500 tracking-wider mb-2">FILES</p>
            <div className="space-y-1">
              <button onClick={() => { setActiveTab('files'); setCurrentFolderId(null) }} className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-xl transition-colors ${activeTab === 'files' && !currentFolderId ? 'text-white bg-white/5 font-medium' : 'text-neutral-400 hover:text-white hover:bg-white/5'}`}><FolderIcon className="w-4 h-4" /> Dashboard files</button>
              <button onClick={() => setActiveTab('gallery')} className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-xl transition-colors ${activeTab === 'gallery' ? 'text-white bg-white/5 font-medium' : 'text-neutral-400 hover:text-white hover:bg-white/5'}`}><ImageIcon className="w-4 h-4" /> Gallery</button>
              <button onClick={() => setActiveTab('trash')} className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-xl transition-colors ${activeTab === 'trash' ? 'text-white bg-white/5 font-medium' : 'text-neutral-400 hover:text-white hover:bg-white/5'}`}><Trash className="w-4 h-4" /> Trash</button>
              <button onClick={() => setActiveTab('stats')} className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-xl transition-colors ${activeTab === 'stats' ? 'text-white bg-white/5 font-medium' : 'text-neutral-400 hover:text-white hover:bg-white/5'}`}><BarChart3 className="w-4 h-4" /> Storage Stats</button>
            </div>
          </div>

          <div>
            <p className="px-4 text-xs font-bold text-neutral-500 tracking-wider mb-2 flex items-center justify-between">
              MY PLACES
              <button onClick={() => setIsCreatingFolder(true)} className="hover:text-white transition-colors"><Plus className="w-3.5 h-3.5" /></button>
            </p>
            <div className="space-y-1">
              {folders.filter(f => !f.isTrashed).map(folder => (
                <button 
                  key={folder.id}
                  onClick={() => { setActiveTab('files'); setCurrentFolderId(folder.id) }}
                  className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-xl transition-colors truncate ${currentFolderId === folder.id ? 'text-white bg-white/5 font-medium' : 'text-neutral-400 hover:text-white hover:bg-white/5'}`}
                >
                  <FolderIcon className="w-4 h-4 flex-shrink-0" /> 
                  <span className="truncate text-sm">{folder.name}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="p-4 mt-auto border-t border-white/5">
          <div className="flex items-center gap-3 px-2 py-2">
            <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-[#5A62FB] to-purple-500 flex items-center justify-center text-white font-bold flex-shrink-0 shadow-lg">
              {userId ? userId.charAt(0).toUpperCase() : 'U'}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold truncate text-white">{userId || 'User'}</p>
              <button onClick={handleLogout} className="text-xs text-neutral-500 hover:text-red-400 transition-colors">Logout</button>
            </div>
          </div>
        </div>
      </aside>

      {/* ── Main Content Area ── */}
      <main className="flex-1 flex flex-col overflow-hidden bg-[#11141D] md:rounded-tl-3xl shadow-2xl relative pb-20 md:pb-0">
        
        {/* Top Header Row */}
        <div className="flex flex-col md:flex-row md:items-center justify-between p-6 md:p-8 pb-4 gap-4">
          <div className="flex items-center justify-between md:justify-start w-full md:w-auto gap-3 text-neutral-500">
            {/* Mobile: Cloud Space branding on left */}
            <div className="md:hidden flex items-center gap-1.5">
              <Cloud className="w-4 h-4 text-[#5A62FB]" />
              <span className="text-sm font-bold tracking-tight text-[#5A62FB]">Cloud Space</span>
            </div>
            <button onClick={() => setCurrentFolderId(null)} className={`p-1.5 rounded-lg transition-colors ${currentFolderId ? 'hover:bg-white/10 text-white' : 'opacity-50 cursor-not-allowed'}`}>
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div className="md:hidden flex items-center gap-3">
              <button onClick={() => setIsCreatingFolder(true)} className="p-1.5 text-neutral-400 hover:text-white transition-colors" title="Create Folder">
                <FolderPlus className="w-5 h-5" />
              </button>
              <div className="flex items-center gap-2 bg-white/5 border border-white/5 rounded-full pl-1 pr-3 py-1">
                <div className="w-6 h-6 rounded-full bg-gradient-to-tr from-[#5A62FB] to-purple-500 flex items-center justify-center text-white text-xs font-bold shadow-sm">
                  {userId ? userId.charAt(0).toUpperCase() : 'U'}
                </div>
                <span className="text-sm font-medium text-white truncate max-w-[100px]">{userId || 'User'}</span>
              </div>
              <button onClick={handleLogout} className="p-1.5 text-neutral-400 hover:text-white transition-colors" title="Logout">
                <LogOut className="w-5 h-5" />
              </button>
            </div>
          </div>
          
          <div className="flex items-center gap-4 w-full md:w-auto">
            <button 
              onClick={() => document.getElementById('global-file-input')?.click()}
              className="hidden md:block px-6 py-2.5 bg-[#5A62FB] hover:bg-[#4d54d6] text-white text-sm font-medium rounded-full shadow-[0_0_15px_rgba(90,98,251,0.3)] transition-all active:scale-95 whitespace-nowrap"
            >
              UPLOAD NEW FILE
            </button>
            
            <div className="relative w-full md:w-64">
              <input
                type="text"
                placeholder="Search your content"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-[#1A1D27] text-sm text-white placeholder-neutral-500 rounded-full pl-5 pr-10 py-2.5 outline-none focus:ring-1 focus:ring-[#5A62FB] transition-all"
              />
              <button className="absolute right-1 top-1 p-1.5 bg-[#5A62FB] rounded-full text-white">
                <Search className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        {/* Dynamic Content Area based on Tab & State */}
        <div className="flex-1 overflow-y-auto px-8 pb-8 no-scrollbar">
          
          {isInitializing ? (
            <div className="flex flex-col items-center justify-center h-full py-32 text-center animate-in fade-in duration-500">
              <div className="w-12 h-12 border-4 border-[#5A62FB] border-t-transparent rounded-full animate-spin mb-4 mx-auto" />
              <p className="text-neutral-400">Loading your drive...</p>
            </div>
          ) : activeTab === 'overview' && !searchQuery ? (
            /* ── Redesigned Dashboard Root View ── */
            <div className="space-y-10 animate-in fade-in duration-500">
              
              {/* Recently Used (Files) */}
              {recentOpenedFiles.length > 0 && (
                <section>
                  <h2 className="text-lg font-semibold mb-4 text-white/90">Recently used</h2>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {recentOpenedFiles.map((file, idx) => (
                      <div 
                        key={file.id} 
                        onClick={() => handleFileOpen(file)}
                        className={`p-6 rounded-3xl cursor-pointer transition-transform hover:scale-[1.02] active:scale-[0.98] ${idx === 0 ? 'bg-[#5A62FB] text-white shadow-[0_8px_30px_rgba(90,98,251,0.2)]' : 'bg-[#1A1D27] text-white hover:bg-[#202430]'}`}
                      >
                        <div className="flex justify-between items-start mb-8">
                           <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${idx === 0 ? 'bg-white/20 text-white' : 'bg-[#5A62FB]/10 text-[#5A62FB]'}`}>
                             {getFileIcon(file)}
                           </div>
                        </div>
                        <p className={`text-xs font-semibold mb-1 tracking-wider ${idx === 0 ? 'text-white/60' : 'text-neutral-500'}`}>FILE</p>
                        <h3 className="text-xl font-semibold truncate">{file.name}</h3>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* New Files List */}
              {newFilesList.length > 0 && (
                <section>
                  <div className="flex justify-between items-center mb-4">
                    <h2 className="text-lg font-semibold text-white/90">New files</h2>
                  </div>
                  <div className="bg-[#1A1D27] rounded-3xl overflow-hidden">
                    {newFilesList.map((file, i) => (
                      <div 
                        key={file.id} 
                        onClick={() => selectedIds.size > 0 ? toggleSelect(file.id) : handleFileOpen(file)}
                        className={`grid grid-cols-[auto_1fr_auto] md:grid-cols-[auto_1fr_100px_120px_80px_auto] gap-4 items-center px-4 md:px-6 py-4 cursor-pointer transition-colors group ${selectedIds.has(file.id) ? 'bg-[#5A62FB]/10' : 'hover:bg-[#202430]'} ${i !== newFilesList.length - 1 ? 'border-b border-white/5' : ''}`}
                      >
                        <div className="flex items-center gap-3">
                          <button onClick={(e) => { e.stopPropagation(); toggleSelect(file.id) }} className={`opacity-0 group-hover:opacity-100 transition-opacity ${selectedIds.has(file.id) ? 'opacity-100 text-[#5A62FB]' : 'text-neutral-500 hover:text-white'}`}>
                            {selectedIds.has(file.id) ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                          </button>
                          <div className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center flex-shrink-0">
                            {getFileIcon(file)}
                          </div>
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate text-white">{file.name}</p>
                        </div>
                        <div className="text-sm text-neutral-500 hidden sm:block truncate">
                          {file.mimeType.split('/')[1] || 'Unknown'}
                        </div>
                        <div className="text-sm text-neutral-500 hidden md:block">
                          {file.createdAt ? format(new Date(file.createdAt), 'dd.MM.yyyy') : '--'}
                        </div>
                        <div className="text-xs font-semibold px-2 py-1 rounded bg-white/5 text-neutral-400 hidden lg:block text-center truncate">
                          .{file.name.split('.').pop()?.toLowerCase() || 'file'}
                        </div>
                        <div className="flex items-center gap-1 opacity-0 hover:opacity-100 transition-opacity" style={{ opacity: 1 /* Always visible on hover not working inline easily, using group */ }}>
                           {/* Using standard buttons for actions */}
                           <button onClick={(e) => { e.stopPropagation(); openRenameModal(file) }} className="p-1.5 text-neutral-400 hover:text-[#5A62FB] transition-colors" title="Rename"><Pencil className="w-4 h-4" /></button>
                           <button onClick={(e) => { e.stopPropagation(); handleDownload(file) }} className="p-1.5 text-neutral-400 hover:text-white transition-colors"><DownloadIcon className="w-4 h-4" /></button>
                           <button onClick={(e) => { e.stopPropagation(); handleDelete(file, false) }} className="p-1.5 text-neutral-400 hover:text-red-400 transition-colors"><TrashIcon className="w-4 h-4" /></button>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Shared with me (Grid) */}
              {sharedFilesList.length > 0 && (
                <section>
                  <div className="flex justify-between items-center mb-4">
                    <h2 className="text-lg font-semibold text-white/90">Shared with me</h2>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
                    {sharedFilesList.map(file => (
                      <div 
                        key={file.id} 
                        onClick={() => selectedIds.size > 0 ? toggleSelect(file.id) : handleFileOpen(file)}
                        className={`p-4 rounded-2xl cursor-pointer transition-colors flex flex-col items-center justify-center aspect-square group relative border ${selectedIds.has(file.id) ? 'bg-[#5A62FB]/10 border-[#5A62FB]/30' : 'bg-[#1A1D27] hover:bg-[#202430] border-transparent hover:border-white/5'}`}
                      >
                         <button onClick={(e) => { e.stopPropagation(); toggleSelect(file.id) }} className={`absolute top-2 left-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity ${selectedIds.has(file.id) ? 'opacity-100 text-[#5A62FB]' : 'text-neutral-500 hover:text-white'}`}>
                           {selectedIds.has(file.id) ? <CheckSquare className="w-5 h-5" /> : <Square className="w-5 h-5 bg-black/20 rounded" />}
                         </button>
                         <div className="w-12 h-12 mb-3 rounded-xl bg-white/5 flex items-center justify-center text-neutral-400">
                           {getFileIcon(file)}
                         </div>
                         <p className="text-xs font-medium text-center truncate w-full text-neutral-300">{file.name}</p>
                         
                         <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1 z-20">
                           <button onClick={(e) => { e.stopPropagation(); handleDownload(file) }} className="p-1.5 bg-black/40 backdrop-blur-md text-white rounded-lg hover:bg-black/60 shadow-sm border border-white/10"><DownloadIcon className="w-4 h-4" /></button>
                         </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          ) : activeTab === 'files' || activeTab === 'overview' ? (
            /* ── Folder Contents / Search Results ── */
            <div className="animate-in fade-in">
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-xl font-bold">
                  {searchQuery ? 'Search Results' : (currentFolderId ? folders.find(f => f.id === currentFolderId)?.name : 'Dashboard files')}
                </h2>
                <div className="flex gap-2">
                  <button onClick={() => setViewMode('grid')} className={`p-2 rounded-lg transition-colors ${viewMode === 'grid' ? 'bg-[#5A62FB] text-white' : 'bg-white/5 text-neutral-400 hover:text-white'}`}><LayoutGrid className="w-4 h-4" /></button>
                  <button onClick={() => setViewMode('list')} className={`p-2 rounded-lg transition-colors ${viewMode === 'list' ? 'bg-[#5A62FB] text-white' : 'bg-white/5 text-neutral-400 hover:text-white'}`}><ListIcon className="w-4 h-4" /></button>
                </div>
              </div>
              
              {items.length === 0 ? (
                <div className="flex flex-col items-center justify-center text-neutral-500 py-20">
                  <FolderIcon className="w-16 h-16 opacity-20 mb-4" />
                  <p>Nothing here yet</p>
                </div>
              ) : viewMode === 'list' ? (
                <div className="bg-[#1A1D27] rounded-2xl overflow-hidden">
                  <div className="grid grid-cols-[auto_1fr_auto] md:grid-cols-[auto_1fr_100px_150px_auto] gap-4 px-6 py-3 text-xs font-semibold text-neutral-500 uppercase tracking-wider border-b border-white/5">
                    <div className="w-5"></div>
                    <div>Name</div>
                    <div>Size</div>
                    <div>Date</div>
                    <div></div>
                  </div>
                  {items.map(item => {
                    const isFolder = item.type === 'folder'
                    return (
                      <div 
                        key={item.id}
                        onClick={() => selectedIds.size > 0 ? toggleSelect(item.id) : isFolder ? setCurrentFolderId(item.id) : handleFileOpen(item as TGFile)}
                        className={`grid grid-cols-[auto_1fr_auto] md:grid-cols-[auto_1fr_100px_150px_auto] gap-4 items-center px-6 py-3 border-b border-white/5 transition-colors cursor-pointer group ${selectedIds.has(item.id) ? 'bg-[#5A62FB]/10' : 'hover:bg-[#202430]'}`}
                      >
                         <div className="flex items-center gap-3">
                           <button onClick={(e) => { e.stopPropagation(); toggleSelect(item.id) }} className={`opacity-0 group-hover:opacity-100 transition-opacity ${selectedIds.has(item.id) ? 'opacity-100 text-[#5A62FB]' : 'text-neutral-500 hover:text-white'}`}>
                             {selectedIds.has(item.id) ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                           </button>
                           <div className="w-5 flex justify-center">
                              {isFolder ? <FolderIcon className="w-5 h-5 text-neutral-400" /> : getFileIcon(item as TGFile)}
                           </div>
                         </div>
                         <div className="truncate font-medium text-sm text-white/90">{item.name}</div>
                         <div className="text-sm text-neutral-500 hidden md:block">{isFolder ? '--' : filesize((item as TGFile).size)}</div>
                         <div className="text-sm text-neutral-500 hidden md:block">{item.createdAt ? format(new Date(item.createdAt), 'dd.MM.yyyy') : '--'}</div>
                          <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                             {!isFolder && <button onClick={(e) => { e.stopPropagation(); openRenameModal(item as TGFile) }} className="p-1.5 text-neutral-400 hover:text-[#5A62FB]" title="Rename"><Pencil className="w-4 h-4" /></button>}
                             {!isFolder && <button onClick={(e) => { e.stopPropagation(); handleDownload(item as TGFile) }} className="p-1.5 text-neutral-400 hover:text-white"><DownloadIcon className="w-4 h-4" /></button>}
                             <button onClick={(e) => { e.stopPropagation(); handleDelete(item, isFolder) }} className="p-1.5 text-neutral-400 hover:text-red-400"><TrashIcon className="w-4 h-4" /></button>
                         </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                  {items.map(item => {
                    const isFolder = item.type === 'folder'
                    return (
                      <div 
                        key={item.id}
                        onClick={() => selectedIds.size > 0 ? toggleSelect(item.id) : isFolder ? setCurrentFolderId(item.id) : handleFileOpen(item as TGFile)}
                        className={`p-4 rounded-2xl cursor-pointer transition-colors flex flex-col items-center justify-center aspect-square group relative border ${selectedIds.has(item.id) ? 'bg-[#5A62FB]/10 border-[#5A62FB]/30' : 'bg-[#1A1D27] hover:bg-[#202430] border-transparent hover:border-white/5'}`}
                      >
                         <button onClick={(e) => { e.stopPropagation(); toggleSelect(item.id) }} className={`absolute top-2 left-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity ${selectedIds.has(item.id) ? 'opacity-100 text-[#5A62FB]' : 'text-neutral-500 hover:text-white'}`}>
                           {selectedIds.has(item.id) ? <CheckSquare className="w-5 h-5" /> : <Square className="w-5 h-5 bg-black/20 rounded" />}
                         </button>
                         <div className="w-12 h-12 mb-3 rounded-xl bg-white/5 flex items-center justify-center text-neutral-400">
                           {isFolder ? <FolderIcon className="w-6 h-6" /> : getFileIcon(item as TGFile)}
                         </div>
                         <p className="text-xs font-medium text-center truncate w-full text-neutral-300">{item.name}</p>
                         <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col gap-1 z-20">
                           {!isFolder && <button onClick={(e) => { e.stopPropagation(); handleDownload(item as TGFile) }} className="p-1.5 bg-black/40 backdrop-blur-md text-white rounded-lg hover:bg-black/60 shadow-sm border border-white/10"><DownloadIcon className="w-4 h-4" /></button>}
                           <button onClick={(e) => { e.stopPropagation(); handleDelete(item, isFolder) }} className="p-1.5 bg-black/40 backdrop-blur-md text-red-400 rounded-lg hover:bg-black/60 shadow-sm border border-white/10"><TrashIcon className="w-4 h-4" /></button>
                         </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          ) : activeTab === 'gallery' ? (
             <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
              {mediaFiles.length === 0 ? (
                <div className="col-span-full flex flex-col items-center justify-center text-neutral-500 py-20">
                  <ImageIcon className="w-16 h-16 opacity-20 mb-4" />
                  <p>No media files found</p>
                </div>
              ) : (
                mediaFiles.map((file) => (
                  <div key={file.id} onClick={() => handleFileOpen(file)} className="aspect-square bg-[#1A1D27] rounded-2xl overflow-hidden cursor-pointer hover:ring-2 hover:ring-[#5A62FB] transition-all relative group">
                    <Thumbnail file={file} className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end p-3">
                      <p className="text-white text-xs truncate mb-2">{file.name}</p>
                      <div className="flex gap-2">
                        {file.mimeType?.startsWith('image/') && <button onClick={(e) => { e.stopPropagation(); handleExtractText(file) }} className="p-1.5 bg-white/20 backdrop-blur text-white rounded hover:bg-white/40 transition-colors" title="Extract Text (OCR)"><Type className="w-4 h-4" /></button>}
                        <button onClick={(e) => { e.stopPropagation(); openRenameModal(file) }} className="p-1.5 bg-white/20 backdrop-blur text-white rounded hover:bg-white/40 transition-colors" title="Rename"><Pencil className="w-4 h-4" /></button>
                        <button onClick={(e) => { e.stopPropagation(); handleDownload(file) }} className="p-1.5 bg-white/20 backdrop-blur text-white rounded hover:bg-white/40 transition-colors"><DownloadIcon className="w-4 h-4" /></button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : activeTab === 'trash' ? (
             <div className="animate-in fade-in">
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-xl font-bold">Trash</h2>
                {(trashFiles.length > 0 || trashFolders.length > 0) && (
                  <button onClick={handleEmptyTrash} className="px-4 py-2 bg-red-500/10 text-red-400 rounded-xl hover:bg-red-500/20 transition-colors font-medium text-sm">
                    Empty Trash
                  </button>
                )}
              </div>
              {trashFiles.length === 0 && trashFolders.length === 0 ? (
                <div className="flex flex-col items-center justify-center text-neutral-500 py-20">
                  <Trash className="w-16 h-16 opacity-20 mb-4" />
                  <p>Trash is empty</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {[...trashFolders.map(f => ({ ...f, type: 'folder' })), ...trashFiles.map(f => ({ ...f, type: 'file' }))].map(item => (
                    <div key={item.id} className="flex items-center justify-between p-4 bg-[#1A1D27] rounded-xl hover:bg-[#202430] transition-colors">
                      <div className="flex items-center gap-3">
                        {item.type === 'folder' ? <FolderIcon className="w-5 h-5 text-neutral-400" /> : <FileIcon className="w-5 h-5 text-neutral-400" />}
                        <span className="font-medium text-sm text-white/90">{item.name}</span>
                      </div>
                      <button onClick={() => handleRestore(item.id, item.type as any)} className="p-2 text-neutral-400 hover:text-[#5A62FB] transition-colors" title="Restore">
                        <RotateCcw className="w-5 h-5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : activeTab === 'stats' && stats ? (
             <div className="animate-in fade-in space-y-8">
              <h2 className="text-xl font-bold">Storage Stats</h2>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
                <div className="p-6 bg-[#1A1D27] rounded-3xl">
                  <div className="w-10 h-10 rounded-full bg-[#5A62FB]/10 flex items-center justify-center mb-4">
                    <Cloud className="w-5 h-5 text-[#5A62FB]" />
                  </div>
                  <p className="text-sm text-neutral-400">Total Size</p>
                  <p className="text-3xl font-bold mt-1 text-white">{filesize(stats.totalSize)}</p>
                </div>
                <div className="p-6 bg-[#1A1D27] rounded-3xl">
                   <div className="w-10 h-10 rounded-full bg-emerald-500/10 flex items-center justify-center mb-4">
                    <FileIcon className="w-5 h-5 text-emerald-500" />
                  </div>
                  <p className="text-sm text-neutral-400">Total Files</p>
                  <p className="text-3xl font-bold mt-1 text-white">{stats.totalFiles}</p>
                </div>
                <div className="p-6 bg-[#1A1D27] rounded-3xl">
                   <div className="w-10 h-10 rounded-full bg-amber-500/10 flex items-center justify-center mb-4">
                    <FolderIcon className="w-5 h-5 text-amber-500" />
                  </div>
                  <p className="text-sm text-neutral-400">Total Folders</p>
                  <p className="text-3xl font-bold mt-1 text-white">{stats.totalFolders}</p>
                </div>
              </div>
              
              <h3 className="font-semibold text-lg text-white/90">Breakdown by Type</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {stats.byType.map((t: any) => (
                  <div key={t.category} className="p-4 bg-[#1A1D27] rounded-2xl flex justify-between items-center border border-transparent hover:border-white/5 transition-colors">
                    <div>
                      <p className="font-medium text-sm text-white">{t.category}</p>
                      <p className="text-xs text-neutral-500 mt-1">{t.count} files</p>
                    </div>
                    <p className="font-semibold text-sm text-white/80">{filesize(t.size)}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

        </div>
      </main>

      {/* Global Components */}
      <Uploader currentFolderId={currentFolderId} />
      <DownloadBar />

      <FileViewer
        file={viewingFile}
        onClose={() => setViewingFile(null)}
        onDownload={handleDownload}
        onExtractText={handleExtractText}
      />

      {/* ── Create Folder Modal ── */}
      <AnimatePresence>
        {isCreatingFolder && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} exit={{ scale: 0.95 }} className="bg-[#1A1D27] rounded-3xl p-6 w-full max-w-md shadow-2xl border border-white/5">
              <h2 className="text-xl font-bold mb-4 text-white">Create New Folder</h2>
              <form onSubmit={handleCreateFolder}>
                <input type="text" autoFocus value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)} placeholder="Folder name" className="w-full px-4 py-3 border border-white/10 rounded-xl bg-[#0A0D14] text-white focus:ring-2 focus:ring-[#5A62FB] outline-none mb-6 transition-all" />
                <div className="flex justify-end gap-3">
                  <button type="button" onClick={() => setIsCreatingFolder(false)} className="px-5 py-2.5 text-neutral-400 hover:text-white hover:bg-white/5 rounded-xl transition-colors font-medium">Cancel</button>
                  <button type="submit" disabled={!newFolderName.trim()} className="px-5 py-2.5 bg-[#5A62FB] text-white hover:bg-[#4d54d6] disabled:opacity-50 rounded-xl transition-colors font-medium shadow-sm">Create</button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Share Modal ── */}
      <AnimatePresence>
        {shareModalFile && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} exit={{ scale: 0.95 }} className="bg-[#1A1D27] rounded-3xl p-6 w-full max-w-md shadow-2xl border border-white/5">
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-xl font-bold text-white">Share File</h2>
                <button onClick={() => { setShareModalFile(null); setShareLink(null) }} className="p-2 text-neutral-400 hover:text-white hover:bg-white/10 rounded-xl transition-colors"><X className="w-5 h-5" /></button>
              </div>
              <p className="text-sm text-neutral-400 mb-6 leading-relaxed">
                Anyone with this link can preview and download <strong className="text-white">{shareModalFile.name}</strong>. No account required.
              </p>
              {shareLink ? (
                <div className="flex flex-col gap-4">
                  <div className="flex items-center gap-2">
                    <input readOnly value={shareLink} className="flex-1 px-4 py-3 bg-[#0A0D14] border border-white/5 rounded-xl text-sm text-white outline-none" />
                    <button onClick={() => { navigator.clipboard.writeText(shareLink); toast.success('Copied') }} className="p-3 bg-[#5A62FB] text-white rounded-xl hover:bg-[#4d54d6] transition-colors"><Copy className="w-5 h-5" /></button>
                  </div>
                  <button onClick={() => { setShareModalFile(null); setShareLink(null) }} className="w-full py-3 bg-white/5 text-white rounded-xl font-medium hover:bg-white/10 transition-colors">Close</button>
                </div>
              ) : (
                <button onClick={() => handleShare(shareModalFile)} className="w-full py-3 bg-[#5A62FB] text-white rounded-xl font-medium hover:bg-[#4d54d6] transition-colors shadow-lg shadow-[#5A62FB]/20">Generate Link</button>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── URL Upload Modal ── */}
      <AnimatePresence>
        {urlUploadOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} exit={{ scale: 0.95 }} className="bg-[#1A1D27] rounded-3xl p-6 w-full max-w-md shadow-2xl border border-white/5">
              <h2 className="text-xl font-bold mb-4 text-white">Upload from URL</h2>
              <input type="url" value={uploadUrl} onChange={(e) => setUploadUrl(e.target.value)} placeholder="https://example.com/file.mp4" className="w-full px-4 py-3 border border-white/10 rounded-xl bg-[#0A0D14] focus:ring-2 focus:ring-[#5A62FB] outline-none mb-6 text-sm text-white" />
              {urlUploadProgress !== null && (
                <div className="w-full bg-white/10 h-2 rounded-full mb-6 overflow-hidden">
                  <div className="bg-[#5A62FB] h-full transition-all duration-300" style={{ width: `${urlUploadProgress}%` }} />
                </div>
              )}
              <div className="flex justify-end gap-3">
                <button onClick={() => setUrlUploadOpen(false)} className="px-5 py-2.5 text-neutral-400 hover:text-white hover:bg-white/5 rounded-xl transition-colors font-medium text-sm">Cancel</button>
                <button onClick={handleUrlUpload} disabled={!uploadUrl.trim() || urlUploadProgress !== null} className="px-5 py-2.5 bg-[#5A62FB] text-white hover:bg-[#4d54d6] disabled:opacity-50 rounded-xl transition-colors font-medium text-sm shadow-sm">Upload</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Rename Modal ── */}
      <AnimatePresence>
        {renameFile && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[200] p-4">
            <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} exit={{ scale: 0.95 }} className="bg-[#1A1D27] rounded-3xl p-4 sm:p-6 w-full max-w-md shadow-2xl border border-white/5">
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-xl font-bold text-white flex items-center gap-2">
                  <Pencil className="w-5 h-5 text-[#5A62FB]" />
                  Rename File
                </h2>
                <button onClick={() => setRenameFile(null)} className="p-2 text-neutral-400 hover:text-white hover:bg-white/10 rounded-xl transition-colors"><X className="w-5 h-5" /></button>
              </div>
              <form onSubmit={handleRename}>
                <div className="relative mb-4">
                  <input
                    type="text"
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    placeholder="Enter new filename"
                    className="w-full px-4 py-3 pr-12 border border-white/10 rounded-xl bg-[#0A0D14] text-white focus:ring-2 focus:ring-[#5A62FB] outline-none transition-all"
                  />
                </div>
                <button
                  type="button"
                  onClick={handleAISuggestName}
                  disabled={isAISuggesting}
                  className="w-full mb-4 px-4 py-3 bg-gradient-to-r from-[#5A62FB]/10 to-purple-500/10 border border-[#5A62FB]/20 rounded-xl text-sm font-medium text-[#5A62FB] hover:from-[#5A62FB]/20 hover:to-purple-500/20 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {isAISuggesting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      AI is thinking...
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4" />
                      Suggest Name with AI
                    </>
                  )}
                </button>
                {renameFile.mimeType?.startsWith('image/') && accountType === 'simple' && (
                  <p className="text-xs text-neutral-500 mb-4 text-center">
                    <Wand2 className="w-3 h-3 inline mr-1" />
                    AI will analyze the image content to suggest a descriptive name
                  </p>
                )}
                <div className="flex justify-end gap-3">
                  <button type="button" onClick={() => setRenameFile(null)} className="px-5 py-2.5 text-neutral-400 hover:text-white hover:bg-white/5 rounded-xl transition-colors font-medium">Cancel</button>
                  <button type="submit" disabled={!renameValue.trim() || renameValue === renameFile.name} className="px-5 py-2.5 bg-[#5A62FB] text-white hover:bg-[#4d54d6] disabled:opacity-50 rounded-xl transition-colors font-medium shadow-sm">Save</button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── OCR Text Extraction Modal ── */}
      <AnimatePresence>
        {ocrFile && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[200] p-4">
            <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} exit={{ scale: 0.95 }} className="bg-[#1A1D27] rounded-3xl p-4 sm:p-6 w-full max-w-lg shadow-2xl border border-white/5 max-h-[85vh] flex flex-col">
              <div className="flex justify-between items-center mb-4 flex-shrink-0">
                <h2 className="text-xl font-bold text-white flex items-center gap-2">
                  <Type className="w-5 h-5 text-emerald-400" />
                  Extract Text
                </h2>
                <button onClick={() => { setOcrFile(null); setOcrText('') }} className="p-2 text-neutral-400 hover:text-white hover:bg-white/10 rounded-xl transition-colors"><X className="w-5 h-5" /></button>
              </div>
              <p className="text-sm text-neutral-400 mb-4 flex-shrink-0">
                Extracting text from <strong className="text-white">{ocrFile.name}</strong>
              </p>
              {isExtracting ? (
                <div className="flex flex-col items-center justify-center py-12">
                  <div className="relative mb-6">
                    <div className="w-16 h-16 border-4 border-emerald-500/20 rounded-full" />
                    <div className="absolute inset-0 w-16 h-16 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                  </div>
                  <p className="text-neutral-400 text-sm">Analyzing image with OCR...</p>
                  <p className="text-neutral-500 text-xs mt-1">This may take a few seconds</p>
                </div>
              ) : (
                <div className="flex flex-col flex-1 min-h-0">
                  <div className="flex-1 overflow-y-auto bg-[#0A0D14] rounded-xl p-4 mb-4 border border-white/5">
                    <pre className="text-sm text-neutral-200 whitespace-pre-wrap font-mono leading-relaxed">{ocrText}</pre>
                  </div>
                  <div className="flex gap-3 flex-shrink-0">
                    <button
                      onClick={() => { navigator.clipboard.writeText(ocrText); toast.success('Copied to clipboard!') }}
                      className="flex-1 py-3 bg-emerald-500/10 text-emerald-400 rounded-xl font-medium hover:bg-emerald-500/20 transition-colors flex items-center justify-center gap-2"
                    >
                      <Copy className="w-4 h-4" /> Copy Text
                    </button>
                    <button
                      onClick={() => { setOcrFile(null); setOcrText('') }}
                      className="flex-1 py-3 bg-white/5 text-white rounded-xl font-medium hover:bg-white/10 transition-colors"
                    >
                      Close
                    </button>
                  </div>
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Bulk Actions Bar ── */}
      <AnimatePresence>
        {selectedIds.size > 0 && (
          <motion.div initial={{ y: 100, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 100, opacity: 0 }} className="fixed bottom-24 md:bottom-6 left-1/2 -translate-x-1/2 bg-[#5A62FB] text-white px-6 py-4 rounded-full shadow-2xl flex items-center gap-6 z-50">
            <span className="font-semibold">{selectedIds.size} items selected</span>
            <div className="flex items-center gap-3 border-l border-white/20 pl-6">
              <button onClick={handleBulkDownload} className="flex items-center gap-2 hover:text-white/80 transition-colors">
                <DownloadIcon className="w-4 h-4" /> Download
              </button>
              <button onClick={handleBulkDelete} className="flex items-center gap-2 hover:text-white/80 transition-colors">
                <TrashIcon className="w-4 h-4" /> Delete
              </button>
              <button onClick={() => setSelectedIds(new Set())} className="p-1.5 hover:bg-white/10 rounded-full transition-colors ml-2">
                <X className="w-4 h-4" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Mobile Bottom Navigation ── */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 bg-[#0A0D14] border-t border-white/5 flex justify-around items-center px-2 pb-6 pt-2 z-50">
        <button onClick={() => { setActiveTab('overview'); setCurrentFolderId(null) }} className={`flex flex-col items-center gap-1 p-2 ${activeTab === 'overview' ? 'text-[#5A62FB]' : 'text-neutral-500'}`}>
          <LayoutGrid className="w-5 h-5" />
          <span className="text-[10px] font-medium">Drive</span>
        </button>
        <button onClick={() => { setActiveTab('files') }} className={`flex flex-col items-center gap-1 p-2 ${activeTab === 'files' ? 'text-[#5A62FB]' : 'text-neutral-500'}`}>
          <FolderIcon className="w-5 h-5" />
          <span className="text-[10px] font-medium">Files</span>
        </button>
        <div className="relative -top-5">
          <button onClick={() => document.getElementById('global-file-input')?.click()} className="w-14 h-14 bg-[#5A62FB] text-white rounded-full flex items-center justify-center shadow-[0_8px_30px_rgba(90,98,251,0.4)] border-4 border-[#11141D] active:scale-95 transition-transform">
            <Plus className="w-6 h-6" />
          </button>
        </div>
        <button onClick={() => { setActiveTab('gallery') }} className={`flex flex-col items-center gap-1 p-2 ${activeTab === 'gallery' ? 'text-[#5A62FB]' : 'text-neutral-500'}`}>
          <ImageIcon className="w-5 h-5" />
          <span className="text-[10px] font-medium">Gallery</span>
        </button>
        <button onClick={() => { setActiveTab('trash') }} className={`flex flex-col items-center gap-1 p-2 ${activeTab === 'trash' ? 'text-[#5A62FB]' : 'text-neutral-500'}`}>
          <Trash className="w-5 h-5" />
          <span className="text-[10px] font-medium">Trash</span>
        </button>
      </div>

    </div>
  )
}

