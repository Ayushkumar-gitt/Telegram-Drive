import React, { useState, useMemo, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useFileSystemStore, type TGFile, type TGFolder } from '../store/filesystem'
import { useAuthStore } from '../store/auth'
import { useDownloadStore } from '../store/download'
import { getTelegramClient, resetClient } from '../lib/telegram'
import { apiListFiles, apiCreateFolder, apiTrashItem, apiRestoreItem, apiListTrash, apiEmptyTrash, apiMoveFile, apiCreateShareLink, apiGetStats, apiUploadFromUrl } from '../lib/simpleUserApi'
import { format } from 'date-fns'
import { filesize } from 'filesize'
import {
  Folder as FolderIcon,
  File as FileIcon,
  FileText as PdfIcon,
  Plus,
  ArrowLeft,
  Search,
  LogOut,
  FolderPlus,
  Download as DownloadIcon,
  Trash2 as TrashIcon,
  User,
  LayoutGrid,
  List as ListIcon,
  Menu,
  X,
  Share2,
  Image as ImageIcon,
  BarChart3,
  CheckSquare,
  Square,
  Copy,
  RotateCcw,
  Trash,
  Globe
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
  const [drawerOpen, setDrawerOpen] = useState(false)

  // New feature state
  type TabType = 'files' | 'gallery' | 'trash' | 'stats'
  const [activeTab, setActiveTab] = useState<TabType>('files')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null)
  const [trashFiles, setTrashFiles] = useState<any[]>([])
  const [trashFolders, setTrashFolders] = useState<any[]>([])
  const [shareModalFile, setShareModalFile] = useState<TGFile | null>(null)
  const [shareLink, setShareLink] = useState<string | null>(null)
  const [urlUploadOpen, setUrlUploadOpen] = useState(false)
  const [uploadUrl, setUploadUrl] = useState('')
  const [urlUploadProgress, setUrlUploadProgress] = useState<number | null>(null)
  const [stats, setStats] = useState<any>(null)

  const parentRef = useRef<HTMLDivElement>(null)

  // Initialize: load file list
  // Simple users: load from Railway server DB (lightweight JSON, zero TG connection needed)
  // Telegram users: connect to TG and sync from metadata channel
  // TG connection for simple users happens lazily on first upload/download (in Uploader)
  useEffect(() => {
    if (accountType === 'simple') {
      if (!userId) return
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
    } else if (sessionString && apiId && apiHash) {
      getTelegramClient(sessionString, apiId, apiHash).then(client => {
        syncFromMetadataChannel(client)
      })
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
      if (accountType === 'simple') {
        // Simple user: download via server with progress via ReadableStream
        if (!userId) return
        const SIMPLE_API = import.meta.env.DEV ? 'http://localhost:3000' : ''
        const resp = await fetch(`${SIMPLE_API}/api/simple/download/${file.id}`, {
          headers: { 'x-user-id': userId },
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

      } else {
        // Telegram user: download via browser GramJS with progress callback
        if (!sessionString || !apiId || !apiHash) throw new Error('Not authenticated')
        const { downloadFileFromTelegram } = await import('../lib/download')
        const client = await getTelegramClient(sessionString, apiId, apiHash)
        await downloadFileFromTelegram(client, file, (pct) => updateDownloadProgress(taskId, pct))
      }

      setDownloadStatus(taskId, 'completed')
    } catch (err: any) {
      setDownloadStatus(taskId, 'error', err.message)
      toast.error(`Download failed: ${err.message}`)
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
  const handleDrop = async (fileId: string, targetFolderId: string | null) => {
    if (!userId) return
    try {
      if (accountType === 'simple') {
        await apiMoveFile(userId, fileId, targetFolderId)
        const data = await apiListFiles(userId, userId)
        useFileSystemStore.getState().setFilesAndFolders(data.files, data.folders.filter((f: any) => f.id !== '__root__'))
      } else {
        // For TG users, update local state
        const { files: allFiles } = useFileSystemStore.getState()
        useFileSystemStore.setState({ files: allFiles.map(f => f.id === fileId ? { ...f, folderId: targetFolderId } : f) })
        if (sessionString && apiId && apiHash) {
          const client = await getTelegramClient(sessionString, apiId, apiHash)
          await syncToMetadataChannel(client)
        }
      }
      toast.success('File moved')
    } catch { toast.error('Move failed') }
    setDragOverFolderId(null)
  }

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
          if (isFolder) useFileSystemStore.getState().trashFolder(id)
          else useFileSystemStore.getState().trashFile(id)
        } else {
          if (isFolder) useFileSystemStore.getState().trashFolder(id)
          else useFileSystemStore.getState().trashFile(id)
        }
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
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 64, // Height of list item
    overscan: 5,
  })

  const getFileIcon = (file: TGFile) => {
    if (file.mimeType.startsWith('image/') || file.mimeType.startsWith('video/')) {
      return <Thumbnail file={file} />
    }
    if (file.mimeType === 'application/pdf') return <PdfIcon className="w-5 h-5 text-red-500 flex-shrink-0" />
    return <FileIcon className="w-5 h-5 text-gray-500 flex-shrink-0" />
  }

  return (
    <div className="h-screen flex flex-col bg-neutral-50 dark:bg-[#050505] text-black dark:text-white font-sans">
      {/* Header */}
      <header className="bg-white/80 dark:bg-[#0a0a0a]/80 backdrop-blur-md border-b border-neutral-200 dark:border-white/10 p-4 sticky top-0 z-20">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-2 sm:gap-4">
          <div className="flex items-center gap-2 sm:gap-4 min-w-0">
            {currentFolderId && (
              <button
                onClick={() => setCurrentFolderId(null)}
                className="p-2 hover:bg-neutral-100 dark:hover:bg-white/10 rounded-full transition-colors text-neutral-500 hover:text-black dark:hover:text-white flex-shrink-0"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
            )}
            <h1 className="text-lg sm:text-xl font-bold tracking-tight truncate">
              {currentFolderId
                ? folders.find(f => f.id === currentFolderId)?.name
                : 'Cloud Space'}
            </h1>
          </div>

          <div className="flex-1 max-w-xl relative hidden sm:block">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-neutral-400" />
            <input
              type="text"
              placeholder={currentFolderId ? 'Search in this folder...' : 'Search files...'}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 bg-neutral-100 dark:bg-white/5 border border-transparent dark:border-white/5 rounded-xl focus:ring-2 focus:ring-neutral-200 dark:focus:ring-white/20 focus:border-transparent outline-none transition-all placeholder:text-neutral-400"
            />
          </div>


          {selectedIds.size > 0 && activeTab === 'files' && (
            <div className="flex items-center gap-2 bg-black dark:bg-white text-white dark:text-black px-4 py-2 rounded-xl shadow-lg animate-in fade-in slide-in-from-top-4 absolute top-4 left-1/2 -translate-x-1/2 z-50">
              <span className="font-medium text-sm">{selectedIds.size} selected</span>
              <div className="w-px h-4 bg-white/20 dark:bg-black/20 mx-2" />
              <button onClick={handleBulkDownload} className="p-1 hover:bg-white/20 dark:hover:bg-black/20 rounded transition-colors" title="Download Selected"><DownloadIcon className="w-4 h-4" /></button>
              <button onClick={handleBulkDelete} className="p-1 hover:bg-white/20 dark:hover:bg-black/20 rounded transition-colors" title="Trash Selected"><TrashIcon className="w-4 h-4" /></button>
              <button onClick={() => setSelectedIds(new Set())} className="p-1 hover:bg-white/20 dark:hover:bg-black/20 rounded transition-colors" title="Clear Selection"><X className="w-4 h-4" /></button>
            </div>
          )}

          <div className="flex items-center gap-2 sm:gap-3">
            <div className="hidden md:flex items-center bg-neutral-100 dark:bg-white/10 p-1 rounded-lg">
              <button
                onClick={() => setViewMode('grid')}
                className={`p-1.5 rounded-md transition-all ${viewMode === 'grid' ? 'bg-white dark:bg-white/20 shadow-sm text-black dark:text-white' : 'text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-white'}`}
                title="Grid View"
              >
                <LayoutGrid className="w-4 h-4" />
              </button>
              <button
                onClick={() => setViewMode('list')}
                className={`p-1.5 rounded-md transition-all ${viewMode === 'list' ? 'bg-white dark:bg-white/20 shadow-sm text-black dark:text-white' : 'text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-white'}`}
                title="List View"
              >
                <ListIcon className="w-4 h-4" />
              </button>
            </div>

            {!currentFolderId && (
              <button
                onClick={() => setIsCreatingFolder(true)}
                className="hidden sm:flex p-2.5 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-white/10 rounded-xl transition-colors items-center gap-2"
              >
                <FolderPlus className="w-5 h-5" />
                <span className="hidden lg:inline">New Folder</span>
              </button>
            )}
            <button
              onClick={() => document.getElementById('global-file-input')?.click()}
              className="bg-black dark:bg-white hover:bg-neutral-800 dark:hover:bg-neutral-200 text-white dark:text-black px-3 sm:px-4 py-2.5 rounded-xl transition-colors shadow-sm flex items-center gap-2 font-medium"
            >
              <Plus className="w-5 h-5" />
              <span className="hidden sm:inline">Upload</span>
            </button>
            {userId && (
              <div className="hidden lg:flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium bg-neutral-100 dark:bg-white/10 text-neutral-600 dark:text-neutral-300 border border-neutral-200 dark:border-white/10">
                <User className="w-4 h-4" />
                {userId}
              </div>
            )}
            <button
              onClick={handleLogout}
              className="hidden sm:flex p-2.5 text-neutral-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-xl transition-colors ml-1"
              title="Logout"
            >
              <LogOut className="w-5 h-5" />
            </button>
            {/* Mobile hamburger */}
            <button
              onClick={() => setDrawerOpen(true)}
              className="sm:hidden p-2.5 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-white/10 rounded-xl transition-colors"
            >
              <Menu className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Mobile search bar — below header row */}
        <div className="sm:hidden mt-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400" />
            <input
              type="text"
              placeholder={currentFolderId ? 'Search in this folder...' : 'Search files...'}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-2 bg-neutral-100 dark:bg-white/5 border border-transparent dark:border-white/5 rounded-xl focus:ring-2 focus:ring-neutral-200 dark:focus:ring-white/20 outline-none transition-all placeholder:text-neutral-400 text-sm"
            />
          </div>
        </div>
      </header>

      {/* Mobile Drawer */}
      <AnimatePresence>
        {drawerOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/50 z-40"
              onClick={() => setDrawerOpen(false)}
            />
            <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 30, stiffness: 300 }}
              className="fixed top-0 right-0 h-full w-72 bg-white dark:bg-[#111] border-l border-neutral-200 dark:border-white/10 z-50 flex flex-col shadow-2xl"
            >
              <div className="flex items-center justify-between p-4 border-b border-neutral-200 dark:border-white/10">
                <h2 className="font-semibold text-lg">Menu</h2>
                <button onClick={() => setDrawerOpen(false)} className="p-2 hover:bg-neutral-100 dark:hover:bg-white/10 rounded-xl transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex-1 p-4 space-y-2">
                <div className="block sm:hidden mb-6">
                  <SidebarNav activeTab={activeTab} setActiveTab={(t: TabType) => { setActiveTab(t); setDrawerOpen(false) }} onUrlUpload={() => { setUrlUploadOpen(true); setDrawerOpen(false) }} />
                </div>

                {userId && (
                  <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-neutral-100 dark:bg-white/5 border border-neutral-200 dark:border-white/10 mb-4">
                    <User className="w-5 h-5 text-neutral-500" />
                    <span className="font-medium text-sm truncate">{userId}</span>
                  </div>
                )}

                {!currentFolderId && (
                  <button
                    onClick={() => { setDrawerOpen(false); setIsCreatingFolder(true) }}
                    className="w-full flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-neutral-100 dark:hover:bg-white/10 transition-colors text-left"
                  >
                    <FolderPlus className="w-5 h-5 text-neutral-500" />
                    <span className="font-medium text-sm">New Folder</span>
                  </button>
                )}

                <button
                  onClick={() => { setDrawerOpen(false); setViewMode(viewMode === 'grid' ? 'list' : 'grid') }}
                  className="w-full flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-neutral-100 dark:hover:bg-white/10 transition-colors text-left"
                >
                  {viewMode === 'grid' ? <ListIcon className="w-5 h-5 text-neutral-500" /> : <LayoutGrid className="w-5 h-5 text-neutral-500" />}
                  <span className="font-medium text-sm">{viewMode === 'grid' ? 'List View' : 'Grid View'}</span>
                </button>
              </div>

              <div className="p-4 border-t border-neutral-200 dark:border-white/10">
                <button
                  onClick={() => { setDrawerOpen(false); handleLogout() }}
                  className="w-full flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-red-50 dark:hover:bg-red-500/10 text-red-500 transition-colors text-left"
                >
                  <LogOut className="w-5 h-5" />
                  <span className="font-medium text-sm">Logout</span>
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Layout Wrapper */}
      <div className="flex flex-1 overflow-hidden max-w-7xl mx-auto w-full">
        {/* Sidebar */}
        <aside className="hidden sm:flex flex-col w-64 border-r border-neutral-200 dark:border-white/10 p-4 gap-2 overflow-y-auto">
          <SidebarNav activeTab={activeTab} setActiveTab={setActiveTab} onUrlUpload={() => setUrlUploadOpen(true)} />
        </aside>

        {/* Main Content Area */}
        <main className="flex-1 overflow-hidden flex flex-col p-4 relative">

          {/* Create Folder Modal */}
          <AnimatePresence>
            {isCreatingFolder && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
              >
                <motion.div
                  initial={{ scale: 0.95 }}
                  animate={{ scale: 1 }}
                  exit={{ scale: 0.95 }}
                  className="bg-white dark:bg-[#111] rounded-2xl p-6 w-full max-w-md shadow-2xl border border-neutral-200 dark:border-white/10"
                >
                  <h2 className="text-xl font-semibold mb-4">Create New Folder</h2>
                  <form onSubmit={handleCreateFolder}>
                    <input
                      type="text"
                      autoFocus
                      value={newFolderName}
                      onChange={(e) => setNewFolderName(e.target.value)}
                      placeholder="Folder name"
                      className="w-full px-4 py-3 border border-neutral-200 dark:border-white/10 rounded-xl bg-neutral-50 dark:bg-[#0a0a0a] focus:ring-2 focus:ring-neutral-200 dark:focus:ring-white/20 outline-none mb-6 transition-all"
                    />
                    <div className="flex justify-end gap-3">
                      <button
                        type="button"
                        onClick={() => setIsCreatingFolder(false)}
                        className="px-5 py-2.5 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-white/5 rounded-xl transition-colors font-medium"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={!newFolderName.trim()}
                        className="px-5 py-2.5 bg-black dark:bg-white text-white dark:text-black hover:bg-neutral-800 dark:hover:bg-neutral-200 disabled:opacity-50 rounded-xl transition-colors font-medium shadow-sm"
                      >
                        Create
                      </button>
                    </div>
                  </form>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>

          {activeTab === 'files' && (
            <>
              {/* List Header */}
              {viewMode === 'list' && (
                <div className="grid grid-cols-[1fr_120px_150px_60px] gap-4 px-6 py-3 text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wider border-b border-neutral-200 dark:border-white/5">
                  <div>Name</div>
                  <div>Size</div>
                  <div>Date modified</div>
                  <div></div>
                </div>
              )}

              {/* Virtualized Grid/List */}
              <div ref={parentRef} className="flex-1 overflow-auto">
                {items.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-neutral-400 space-y-4">
                    <CloudUploadIcon className="w-16 h-16 opacity-20" />
                    <p>This folder is empty</p>
                  </div>
                ) : viewMode === 'list' ? (
                  <div
                    style={{
                      height: `${virtualizer.getTotalSize()}px`,
                      width: '100%',
                      position: 'relative',
                    }}
                  >
                    {virtualizer.getVirtualItems().map((virtualRow) => {
                      const item = items[virtualRow.index]
                      const isFolder = item.type === 'folder'

                      return (
                        <div
                          key={virtualRow.key}
                          style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            height: `${virtualRow.size}px`,
                            transform: `translateY(${virtualRow.start}px)`,
                          }}
                        >
                          <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            className="group h-full"
                          >
                            <div
                              onClick={() => {
                                if (selectedIds.size > 0) toggleSelect(item.id)
                                else isFolder ? setCurrentFolderId(item.id) : setViewingFile(item as TGFile)
                              }}
                              draggable
                              onDragStart={(e) => { e.dataTransfer.setData('text/plain', item.id) }}
                              onDragOver={(e) => { if (isFolder) { e.preventDefault(); setDragOverFolderId(item.id) } }}
                              onDragLeave={() => { if (isFolder) setDragOverFolderId(null) }}
                              onDrop={(e) => { if (isFolder) { e.preventDefault(); handleDrop(e.dataTransfer.getData('text/plain'), item.id) } }}
                              className={`grid grid-cols-[1fr_120px_150px_60px] gap-4 items-center px-6 h-full border-b transition-colors cursor-pointer ${dragOverFolderId === item.id ? 'bg-blue-50 dark:bg-blue-500/10 border-blue-200' : 'border-neutral-100 dark:border-white/5 hover:bg-neutral-100/50 dark:hover:bg-white/5'} ${selectedIds.has(item.id) ? 'bg-neutral-100 dark:bg-white/10' : ''}`}
                            >
                              <div className="flex items-center gap-3 overflow-hidden">
                                <button onClick={(e) => { e.stopPropagation(); toggleSelect(item.id) }} className="text-neutral-400 hover:text-black dark:hover:text-white transition-colors">
                                  {selectedIds.has(item.id) ? <CheckSquare className="w-5 h-5 text-black dark:text-white" /> : <Square className="w-5 h-5" />}
                                </button>
                                {isFolder ? (
                                  <FolderIcon className="w-6 h-6 text-black dark:text-white flex-shrink-0" fill="currentColor" fillOpacity={0.1} />
                                ) : (
                                  getFileIcon(item as TGFile)
                                )}
                                <span className="truncate font-medium text-sm">{item.name}</span>
                              </div>
                              <div className="text-sm text-neutral-500 dark:text-neutral-400">
                                {isFolder ? '--' : filesize((item as TGFile).size)}
                              </div>
                              <div className="text-sm text-neutral-500 dark:text-neutral-400">
                                {item.createdAt ? format(new Date(item.createdAt), 'MMM d, yyyy') : '--'}
                              </div>
                              <div className="flex justify-end gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                                {!isFolder && (
                                  <>
                                    <button
                                      onClick={(e) => { e.stopPropagation(); handleShare(item as TGFile) }}
                                      className="p-2 hover:bg-neutral-200 dark:hover:bg-white/10 rounded-lg text-neutral-600 dark:text-neutral-400 transition-all"
                                      title="Share"
                                    >
                                      <Share2 className="w-4 h-4" />
                                    </button>
                                    <button
                                      onClick={(e) => { e.stopPropagation(); handleDownload(item as TGFile) }}
                                      className="p-2 hover:bg-neutral-200 dark:hover:bg-white/10 rounded-lg text-neutral-600 dark:text-neutral-400 transition-all"
                                      title="Download"
                                    >
                                      <DownloadIcon className="w-4 h-4" />
                                    </button>
                                  </>
                                )}
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleDelete(item, isFolder) }}
                                  className="p-2 hover:bg-red-50 dark:hover:bg-red-500/10 text-red-500 rounded-lg transition-all"
                                  title="Delete"
                                >
                                  <TrashIcon className="w-4 h-4" />
                                </button>
                              </div>
                            </div>
                          </motion.div>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 p-4">
                    {items.map((item) => {
                      const isFolder = item.type === 'folder'
                      return (
                        <motion.div
                          key={item.id}
                          initial={{ opacity: 0, scale: 0.95 }}
                          animate={{ opacity: 1, scale: 1 }}
                          draggable
                          onDragStart={(e: any) => { e.dataTransfer.setData('text/plain', item.id) }}
                          onDragOver={(e: any) => { if (isFolder) { e.preventDefault(); setDragOverFolderId(item.id) } }}
                          onDragLeave={() => { if (isFolder) setDragOverFolderId(null) }}
                          onDrop={(e: any) => { if (isFolder) { e.preventDefault(); handleDrop(e.dataTransfer.getData('text/plain'), item.id) } }}
                          onClick={() => {
                            if (selectedIds.size > 0) toggleSelect(item.id)
                            else isFolder ? setCurrentFolderId(item.id) : setViewingFile(item as TGFile)
                          }}
                          className={`group relative border rounded-2xl p-4 flex flex-col items-center gap-3 cursor-pointer hover:shadow-lg transition-all ${dragOverFolderId === item.id ? 'bg-blue-50 dark:bg-blue-500/10 border-blue-200' : 'bg-white dark:bg-[#111] border-neutral-200 dark:border-white/10'} ${selectedIds.has(item.id) ? 'ring-2 ring-black dark:ring-white' : ''}`}
                        >
                          <button onClick={(e) => { e.stopPropagation(); toggleSelect(item.id) }} className={`absolute top-3 left-3 z-10 transition-opacity ${selectedIds.has(item.id) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                            {selectedIds.has(item.id) ? <CheckSquare className="w-5 h-5 text-black dark:text-white" /> : <Square className="w-5 h-5 text-neutral-400" />}
                          </button>
                          <div className="w-16 h-16 flex items-center justify-center">
                            {isFolder ? (
                              <FolderIcon className="w-16 h-16 text-black dark:text-white" fill="currentColor" fillOpacity={0.1} />
                            ) : (
                              getFileIcon(item as TGFile)
                            )}
                          </div>
                          <div className="w-full text-center">
                            <p className="text-sm font-medium truncate">{item.name}</p>
                            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                              {isFolder ? (item.createdAt ? format(new Date(item.createdAt), 'MMM d') : '--') : filesize((item as TGFile).size)}
                            </p>
                          </div>

                          {/* Action buttons overlay for grid */}
                          <div className="absolute top-2 right-2 flex flex-col gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                            {!isFolder && (
                              <button
                                onClick={(e) => { e.stopPropagation(); handleDownload(item as TGFile) }}
                                className="p-1.5 bg-white/90 dark:bg-[#111]/90 hover:bg-neutral-100 dark:hover:bg-white/10 backdrop-blur shadow-sm rounded-lg text-neutral-600 dark:text-neutral-300 transition-all"
                                title="Download"
                              >
                                <DownloadIcon className="w-4 h-4" />
                              </button>
                            )}
                            <button
                              onClick={(e) => { e.stopPropagation(); handleShare(item as TGFile) }}
                              className="p-1.5 bg-white/90 dark:bg-[#111]/90 hover:bg-neutral-100 dark:hover:bg-white/10 backdrop-blur shadow-sm rounded-lg text-neutral-600 dark:text-neutral-300 transition-all"
                              title="Share"
                            >
                              <Share2 className="w-4 h-4" />
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleDelete(item, isFolder) }}
                              className="p-1.5 bg-white/90 dark:bg-[#111]/90 hover:bg-red-50 dark:hover:bg-red-500/10 backdrop-blur shadow-sm rounded-lg text-red-500 transition-all"
                              title="Delete"
                            >
                              <TrashIcon className="w-4 h-4" />
                            </button>
                          </div>
                        </motion.div>
                      )
                    })}
                  </div>
                )}
              </div>
            </>
          )}

          {/* ── Gallery Tab ── */}
          {activeTab === 'gallery' && (
            <div className="flex-1 overflow-auto grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
              {mediaFiles.length === 0 ? (
                <div className="col-span-full flex flex-col items-center justify-center text-neutral-400 py-20">
                  <ImageIcon className="w-16 h-16 opacity-20 mb-4" />
                  <p>No media files found</p>
                </div>
              ) : (
                mediaFiles.map((file) => (
                  <div key={file.id} onClick={() => { setViewingFile(file) }} className="aspect-square bg-neutral-100 dark:bg-[#111] rounded-2xl overflow-hidden cursor-pointer hover:shadow-lg transition-all relative group">
                    <Thumbnail file={file} className="w-full h-full object-cover" />
                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
                      <button onClick={(e) => { e.stopPropagation(); handleDownload(file) }} className="p-2 bg-white/90 text-black rounded-lg mx-1 shadow-md hover:bg-white transition-all"><DownloadIcon className="w-5 h-5" /></button>
                      <button onClick={(e) => { e.stopPropagation(); handleShare(file) }} className="p-2 bg-white/90 text-black rounded-lg mx-1 shadow-md hover:bg-white transition-all"><Share2 className="w-5 h-5" /></button>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* ── Trash Tab ── */}
          {activeTab === 'trash' && (
            <div className="flex-1 overflow-auto">
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-xl font-bold">Trash</h2>
                {(trashFiles.length > 0 || trashFolders.length > 0) && (
                  <button onClick={handleEmptyTrash} className="px-4 py-2 bg-red-50 text-red-500 rounded-xl hover:bg-red-100 transition-colors font-medium text-sm">
                    Empty Trash
                  </button>
                )}
              </div>
              {trashFiles.length === 0 && trashFolders.length === 0 ? (
                <div className="flex flex-col items-center justify-center text-neutral-400 py-20">
                  <Trash className="w-16 h-16 opacity-20 mb-4" />
                  <p>Trash is empty</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {[...trashFolders.map(f => ({ ...f, type: 'folder' })), ...trashFiles.map(f => ({ ...f, type: 'file' }))].map(item => (
                    <div key={item.id} className="flex items-center justify-between p-4 bg-white dark:bg-[#111] border border-neutral-200 dark:border-white/10 rounded-xl">
                      <div className="flex items-center gap-3">
                        {item.type === 'folder' ? <FolderIcon className="w-5 h-5 text-neutral-500" /> : <FileIcon className="w-5 h-5 text-neutral-500" />}
                        <span className="font-medium text-sm">{item.name}</span>
                      </div>
                      <button onClick={() => handleRestore(item.id, item.type)} className="p-2 text-neutral-500 hover:text-black dark:hover:text-white transition-colors" title="Restore">
                        <RotateCcw className="w-5 h-5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Stats Tab ── */}
          {activeTab === 'stats' && stats && (
            <div className="flex-1 overflow-auto space-y-6">
              <h2 className="text-xl font-bold">Storage Dashboard</h2>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="p-6 bg-white dark:bg-[#111] border border-neutral-200 dark:border-white/10 rounded-2xl">
                  <p className="text-sm text-neutral-500">Total Size</p>
                  <p className="text-2xl font-bold mt-1">{filesize(stats.totalSize)}</p>
                </div>
                <div className="p-6 bg-white dark:bg-[#111] border border-neutral-200 dark:border-white/10 rounded-2xl">
                  <p className="text-sm text-neutral-500">Total Files</p>
                  <p className="text-2xl font-bold mt-1">{stats.totalFiles}</p>
                </div>
                <div className="p-6 bg-white dark:bg-[#111] border border-neutral-200 dark:border-white/10 rounded-2xl">
                  <p className="text-sm text-neutral-500">Total Folders</p>
                  <p className="text-2xl font-bold mt-1">{stats.totalFolders}</p>
                </div>
              </div>
              <h3 className="font-semibold text-lg mt-8">Breakdown by Type</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {stats.byType.map((t: any) => (
                  <div key={t.category} className="p-4 bg-white dark:bg-[#111] border border-neutral-200 dark:border-white/10 rounded-xl flex justify-between items-center">
                    <div>
                      <p className="font-medium text-sm">{t.category}</p>
                      <p className="text-xs text-neutral-500 mt-1">{t.count} files</p>
                    </div>
                    <p className="font-semibold text-sm">{filesize(t.size)}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </main>
      </div>

      <Uploader currentFolderId={currentFolderId} />
      <DownloadBar />

      <FileViewer
        file={viewingFile}
        onClose={() => setViewingFile(null)}
      />

      {/* ── Share Modal ── */}
      <AnimatePresence>
        {shareModalFile && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} exit={{ scale: 0.95 }} className="bg-white dark:bg-[#111] rounded-2xl p-6 w-full max-w-md shadow-2xl border border-neutral-200 dark:border-white/10">
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-xl font-semibold">Share File</h2>
                <button onClick={() => { setShareModalFile(null); setShareLink(null) }} className="p-2 hover:bg-neutral-100 dark:hover:bg-white/10 rounded-xl"><X className="w-5 h-5" /></button>
              </div>
              <p className="text-sm text-neutral-500 mb-4">
                Anyone with this link can preview and download <strong>{shareModalFile.name}</strong>. No account required.
              </p>
              {shareLink ? (
                <div className="flex items-center gap-2">
                  <input readOnly value={shareLink} className="flex-1 px-3 py-2.5 bg-neutral-100 dark:bg-white/5 border border-transparent rounded-xl text-sm outline-none" />
                  <button onClick={() => { navigator.clipboard.writeText(shareLink); toast.success('Copied') }} className="p-2.5 bg-black dark:bg-white text-white dark:text-black rounded-xl hover:opacity-80 transition-opacity"><Copy className="w-5 h-5" /></button>
                </div>
              ) : (
                <button onClick={() => handleShare(shareModalFile)} className="w-full py-3 bg-black dark:bg-white text-white dark:text-black rounded-xl font-medium hover:opacity-80 transition-opacity">Generate Link</button>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── URL Upload Modal ── */}
      <AnimatePresence>
        {urlUploadOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} exit={{ scale: 0.95 }} className="bg-white dark:bg-[#111] rounded-2xl p-6 w-full max-w-md shadow-2xl border border-neutral-200 dark:border-white/10">
              <h2 className="text-xl font-semibold mb-4">Upload from URL</h2>
              <input type="url" value={uploadUrl} onChange={(e) => setUploadUrl(e.target.value)} placeholder="https://example.com/file.mp4" className="w-full px-4 py-3 border border-neutral-200 dark:border-white/10 rounded-xl bg-neutral-50 dark:bg-[#0a0a0a] focus:ring-2 focus:ring-neutral-200 dark:focus:ring-white/20 outline-none mb-6 text-sm" />
              {urlUploadProgress !== null && (
                <div className="w-full bg-neutral-200 dark:bg-white/10 h-2 rounded-full mb-6 overflow-hidden">
                  <div className="bg-black dark:bg-white h-full transition-all duration-300" style={{ width: `${urlUploadProgress}%` }} />
                </div>
              )}
              <div className="flex justify-end gap-3">
                <button onClick={() => setUrlUploadOpen(false)} className="px-5 py-2.5 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-white/5 rounded-xl transition-colors font-medium text-sm">Cancel</button>
                <button onClick={handleUrlUpload} disabled={!uploadUrl.trim() || urlUploadProgress !== null} className="px-5 py-2.5 bg-black dark:bg-white text-white dark:text-black hover:bg-neutral-800 dark:hover:bg-neutral-200 disabled:opacity-50 rounded-xl transition-colors font-medium text-sm">Upload</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

const CloudUploadIcon = (props: any) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
    <path d="M12 12v9" />
    <path d="m16 16-4-4-4 4" />
  </svg>
)

const SidebarNav = ({ activeTab, setActiveTab, onUrlUpload }: any) => (
  <div className="space-y-1">
    <button onClick={() => setActiveTab('files')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${activeTab === 'files' ? 'bg-neutral-100 dark:bg-white/10 font-medium' : 'hover:bg-neutral-50 dark:hover:bg-white/5 text-neutral-600 dark:text-neutral-400'}`}><FolderIcon className="w-5 h-5" /> <span className="text-sm">Files</span></button>
    <button onClick={() => setActiveTab('gallery')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${activeTab === 'gallery' ? 'bg-neutral-100 dark:bg-white/10 font-medium' : 'hover:bg-neutral-50 dark:hover:bg-white/5 text-neutral-600 dark:text-neutral-400'}`}><ImageIcon className="w-5 h-5" /> <span className="text-sm">Gallery</span></button>
    <button onClick={() => setActiveTab('trash')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${activeTab === 'trash' ? 'bg-neutral-100 dark:bg-white/10 font-medium' : 'hover:bg-neutral-50 dark:hover:bg-white/5 text-neutral-600 dark:text-neutral-400'}`}><Trash className="w-5 h-5" /> <span className="text-sm">Trash</span></button>
    <button onClick={() => setActiveTab('stats')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${activeTab === 'stats' ? 'bg-neutral-100 dark:bg-white/10 font-medium' : 'hover:bg-neutral-50 dark:hover:bg-white/5 text-neutral-600 dark:text-neutral-400'}`}><BarChart3 className="w-5 h-5" /> <span className="text-sm">Storage Stats</span></button>
    <div className="pt-4 mt-4 border-t border-neutral-200 dark:border-white/10">
      <button onClick={onUrlUpload} className="w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-colors hover:bg-neutral-50 dark:hover:bg-white/5 text-neutral-600 dark:text-neutral-400"><Globe className="w-5 h-5" /> <span className="text-sm">Upload from URL</span></button>
    </div>
  </div>
)
