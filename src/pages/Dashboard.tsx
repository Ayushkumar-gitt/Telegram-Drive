import React, { useState, useMemo, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useFileSystemStore, type TGFile, type TGFolder } from '../store/filesystem'
import { useAuthStore } from '../store/auth'
import { getTelegramClient, resetClient } from '../lib/telegram'
import { apiListFiles, apiCreateFolder, apiDeleteFile, apiDeleteFolder } from '../lib/simpleUserApi'
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
  List as ListIcon
} from 'lucide-react'
import { Api } from 'telegram'
import { v4 as uuidv4 } from 'uuid'
import { toast } from 'react-hot-toast'
import { useNavigate } from 'react-router-dom'
import { Uploader } from '../components/Uploader'
import { FileViewer } from '../components/FileViewer'
import { Thumbnail } from '../components/Thumbnail'

export const Dashboard = () => {
  const navigate = useNavigate()
  const { sessionString, apiId, apiHash, userId, logout, accountType } = useAuthStore()
  const {
    files,
    folders,
    addFolder,
    removeFile,
    removeFolder,
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

  const parentRef = useRef<HTMLDivElement>(null)

  // Initialize TG client and sync — only for telegram users
  // Simple users load their file list from the server API
  useEffect(() => {
    if (accountType === 'simple') {
      if (!userId) return
      apiListFiles(userId, userId)
        .then(data => {
          // Merge server state into local store
          const { setFilesAndFolders } = useFileSystemStore.getState() as any
          if (setFilesAndFolders) {
            setFilesAndFolders(data.files, data.folders.filter((f: any) => f.id !== '__root__'))
          } else {
            // Fallback: set individually
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

  // ── Shared download handler ───────────────────────────────────────────────
  const handleDownload = async (file: TGFile) => {
    if (accountType === 'simple') {
      if (!userId) return
      const SIMPLE_API = import.meta.env.DEV ? 'http://localhost:3002' : ''
      const a = document.createElement('a')
      a.href = `${SIMPLE_API}/api/simple/download/${file.id}?userId=${encodeURIComponent(userId)}`
      a.download = file.name
      // Set headers via fetch + blob (XHR required for custom headers)
      toast.promise(
        fetch(`${SIMPLE_API}/api/simple/download/${file.id}?userId=${encodeURIComponent(userId)}`, {
          headers: { 'x-user-id': userId, 'x-session-token': userId }
        })
          .then(r => r.blob())
          .then(blob => {
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url; a.download = file.name
            a.click()
            URL.revokeObjectURL(url)
          }),
        { loading: 'Downloading…', success: 'Download complete', error: 'Download failed' }
      )
    } else {
      if (!sessionString || !apiId || !apiHash) return
      const { downloadFileFromTelegram } = await import('../lib/download')
      const client = await getTelegramClient(sessionString, apiId, apiHash)
      toast.promise(
        downloadFileFromTelegram(client, file),
        { loading: 'Downloading...', success: 'Download complete', error: 'Download failed' }
      )
    }
  }

  // ── Shared delete handler ─────────────────────────────────────────────────
  const handleDelete = async (item: any, isFolder: boolean) => {
    if (!confirm(`Delete this ${isFolder ? 'folder' : 'file'}?`)) return
    try {
      if (accountType === 'simple') {
        if (!userId) return
        if (isFolder) {
          await apiDeleteFolder(userId, userId, item.id)
          removeFolder(item.id)
        } else {
          await apiDeleteFile(userId, userId, item.id)
          removeFile(item.id)
        }
      } else {
        if (isFolder) removeFolder(item.id)
        else removeFile(item.id)
        if (sessionString && apiId && apiHash) {
          const client = await getTelegramClient(sessionString, apiId, apiHash)
          await syncToMetadataChannel(client)
        }
      }
      toast.success(`${isFolder ? 'Folder' : 'File'} deleted`)
    } catch (err: any) {
      toast.error(err.message ?? 'Delete failed')
    }
  }


  // Filter items
  const items = useMemo(() => {
    let filteredFolders = folders
    let filteredFiles = files

    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      filteredFolders = folders.filter(f => f.name.toLowerCase().includes(q))
      filteredFiles = files.filter(f => f.name.toLowerCase().includes(q))
    } else {
      filteredFiles = files.filter(f => f.folderId === currentFolderId)
      filteredFolders = currentFolderId ? [] : folders
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
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            {currentFolderId && (
              <button
                onClick={() => setCurrentFolderId(null)}
                className="p-2 hover:bg-neutral-100 dark:hover:bg-white/10 rounded-full transition-colors text-neutral-500 hover:text-black dark:hover:text-white"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
            )}
            <h1 className="text-xl font-bold tracking-tight">
              {currentFolderId
                ? folders.find(f => f.id === currentFolderId)?.name
                : 'Star Cloud'}
            </h1>
          </div>

          <div className="flex-1 max-w-xl relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-neutral-400" />
            <input
              type="text"
              placeholder="Search files and folders..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 bg-neutral-100 dark:bg-white/5 border border-transparent dark:border-white/5 rounded-xl focus:ring-2 focus:ring-neutral-200 dark:focus:ring-white/20 focus:border-transparent outline-none transition-all placeholder:text-neutral-400"
            />
          </div>

          <div className="flex items-center gap-3">
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
                className="p-2.5 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-white/10 rounded-xl transition-colors flex items-center gap-2"
              >
                <FolderPlus className="w-5 h-5" />
                <span className="hidden sm:inline">New Folder</span>
              </button>
            )}
            <button
              onClick={() => document.getElementById('global-file-input')?.click()}
              className="bg-black dark:bg-white hover:bg-neutral-800 dark:hover:bg-neutral-200 text-white dark:text-black px-4 py-2.5 rounded-xl transition-colors shadow-sm flex items-center gap-2 font-medium"
            >
              <Plus className="w-5 h-5" />
              <span className="hidden sm:inline">Upload</span>
            </button>
            {userId && (
              <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium bg-neutral-100 dark:bg-white/10 text-neutral-600 dark:text-neutral-300 border border-neutral-200 dark:border-white/10">
                <User className="w-4 h-4" />
                {userId}
              </div>
            )}
            <button
              onClick={handleLogout}
              className="p-2.5 text-neutral-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-xl transition-colors ml-1"
              title="Logout"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 overflow-hidden flex flex-col max-w-7xl mx-auto w-full p-4">

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
                      onClick={() => isFolder ? setCurrentFolderId(item.id) : setViewingFile(item as TGFile)}
                      className="grid grid-cols-[1fr_120px_150px_60px] gap-4 items-center px-6 h-full border-b border-neutral-100 dark:border-white/5 hover:bg-neutral-100/50 dark:hover:bg-white/5 cursor-pointer transition-colors"
                    >
                      <div className="flex items-center gap-3 overflow-hidden">
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
                        {format(item.createdAt, 'MMM d, yyyy')}
                      </div>
                      <div className="flex justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      {!isFolder && (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDownload(item as TGFile) }}
                            className="p-2 hover:bg-neutral-200 dark:hover:bg-white/10 rounded-lg text-neutral-600 dark:text-neutral-400 transition-all"
                            title="Download"
                          >
                            <DownloadIcon className="w-4 h-4" />
                          </button>
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
                    onClick={() => isFolder ? setCurrentFolderId(item.id) : setViewingFile(item as TGFile)}
                    className="group relative bg-white dark:bg-[#111] border border-neutral-200 dark:border-white/10 rounded-2xl p-4 flex flex-col items-center gap-3 cursor-pointer hover:shadow-lg dark:hover:border-white/30 transition-all"
                  >
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
                        {isFolder ? format(item.createdAt, 'MMM d') : filesize((item as TGFile).size)}
                      </p>
                    </div>

                    {/* Action buttons overlay for grid */}
                    <div className="absolute top-2 right-2 flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
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
      </main>

      <Uploader currentFolderId={currentFolderId} />

      <FileViewer
        file={viewingFile}
        onClose={() => setViewingFile(null)}
      />
    </div>
  )
}

const CloudUploadIcon = (props: any) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/>
    <path d="M12 12v9"/>
    <path d="m16 16-4-4-4 4"/>
  </svg>
)
