import React, { useState, useMemo, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useFileSystemStore, type TGFile, type TGFolder } from '../store/filesystem'
import { useAuthStore } from '../store/auth'
import { getTelegramClient } from '../lib/telegram'
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
  Trash2 as TrashIcon
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
  const { sessionString, apiId, apiHash, logout } = useAuthStore()
  const {
    files,
    folders,
    addFolder,
    removeFile,
    removeFolder,
    syncFromMetadataChannel,
    syncToMetadataChannel
  } = useFileSystemStore()

  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [isCreatingFolder, setIsCreatingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [viewingFile, setViewingFile] = useState<TGFile | null>(null)

  const parentRef = useRef<HTMLDivElement>(null)

  // Initialize TG client and sync
  useEffect(() => {
    if (sessionString && apiId && apiHash) {
      getTelegramClient(sessionString, apiId, apiHash).then(client => {
        syncFromMetadataChannel(client)
      })
    }
  }, [sessionString, apiId, apiHash, syncFromMetadataChannel])

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  const handleCreateFolder = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newFolderName.trim() || !sessionString || !apiId || !apiHash) return

    try {
      const client = await getTelegramClient(sessionString, apiId, apiHash)

      // Create a private channel in Telegram to act as the folder
      const result = await client.invoke(
        new Api.channels.CreateChannel({
          title: `TGC_${newFolderName}`,
          about: `Folder: ${newFolderName}`,
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
        channelId: channelId,
        accessHash: channel.accessHash.toString()
      }

      addFolder(newFolder)
      await syncToMetadataChannel(client)

      setIsCreatingFolder(false)
      setNewFolderName('')
      toast.success('Folder created')
    } catch (error) {
      console.error(error)
      toast.error('Failed to create folder')
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
    <div className="h-screen flex flex-col bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100">
      {/* Header */}
      <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 p-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            {currentFolderId && (
              <button
                onClick={() => setCurrentFolderId(null)}
                className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-full transition-colors"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
            )}
            <h1 className="text-xl font-semibold">
              {currentFolderId
                ? folders.find(f => f.id === currentFolderId)?.name
                : 'My Cloud'}
            </h1>
          </div>

          <div className="flex-1 max-w-xl relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
            <input
              type="text"
              placeholder="Search files and folders..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-gray-100 dark:bg-gray-700 border-none rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
            />
          </div>

          <div className="flex items-center gap-2">
            {!currentFolderId && (
              <button
                onClick={() => setIsCreatingFolder(true)}
                className="p-2 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors flex items-center gap-2"
              >
                <FolderPlus className="w-5 h-5" />
                <span className="hidden sm:inline">New Folder</span>
              </button>
            )}
            <button
              onClick={() => document.getElementById('global-file-input')?.click()}
              className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg transition-colors flex items-center gap-2"
            >
              <Plus className="w-5 h-5" />
              <span className="hidden sm:inline">Upload</span>
            </button>
            <button
              onClick={handleLogout}
              className="p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors ml-2"
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
                className="bg-white dark:bg-gray-800 rounded-xl p-6 w-full max-w-md shadow-xl"
              >
                <h2 className="text-xl font-semibold mb-4">Create New Folder</h2>
                <form onSubmit={handleCreateFolder}>
                  <input
                    type="text"
                    autoFocus
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    placeholder="Folder name"
                    className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-transparent focus:ring-2 focus:ring-blue-500 outline-none mb-6"
                  />
                  <div className="flex justify-end gap-3">
                    <button
                      type="button"
                      onClick={() => setIsCreatingFolder(false)}
                      className="px-4 py-2 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={!newFolderName.trim()}
                      className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white rounded-lg transition-colors"
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
        <div className="grid grid-cols-[1fr_120px_150px_40px] gap-4 px-4 py-2 text-sm font-medium text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
          <div>Name</div>
          <div>Size</div>
          <div>Date modified</div>
          <div></div>
        </div>

        {/* Virtualized Grid/List */}
        <div ref={parentRef} className="flex-1 overflow-auto">
          {items.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-gray-500 space-y-4">
              <CloudUploadIcon className="w-16 h-16 opacity-20" />
              <p>This folder is empty</p>
            </div>
          ) : (
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
                      layoutId={item.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="group h-full"
                    >
                    <div
                      onClick={() => isFolder ? setCurrentFolderId(item.id) : setViewingFile(item as TGFile)}
                      className="grid grid-cols-[1fr_120px_150px_40px] gap-4 items-center px-4 h-full border-b border-gray-100 dark:border-gray-800 hover:bg-blue-50 dark:hover:bg-blue-900/20 cursor-pointer transition-colors"
                    >
                      <div className="flex items-center gap-3 overflow-hidden">
                        {isFolder ? (
                          <FolderIcon className="w-6 h-6 text-blue-500 flex-shrink-0" fill="currentColor" fillOpacity={0.2} />
                        ) : (
                          getFileIcon(item as TGFile)
                        )}
                        <span className="truncate font-medium">{item.name}</span>
                      </div>
                      <div className="text-sm text-gray-500">
                        {isFolder ? '--' : filesize((item as TGFile).size)}
                      </div>
                      <div className="text-sm text-gray-500">
                        {format(item.createdAt, 'MMM d, yyyy')}
                      </div>
                      <div className="flex justify-end gap-1">
                        {!isFolder && (
                          <button
                            onClick={async (e) => {
                              e.stopPropagation();
                              if (!sessionString || !apiId || !apiHash) return;
                              const { downloadFileFromTelegram } = await import('../lib/download');
                              const client = await getTelegramClient(sessionString, apiId, apiHash);
                              toast.promise(
                                downloadFileFromTelegram(client, item as TGFile),
                                {
                                  loading: 'Downloading...',
                                  success: 'Download complete',
                                  error: 'Download failed'
                                }
                              );
                            }}
                            className="p-2 opacity-0 group-hover:opacity-100 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-full transition-all"
                            title="Download"
                          >
                            <DownloadIcon className="w-4 h-4" />
                          </button>
                        )}
                        <button
                          onClick={async (e) => {
                            e.stopPropagation();
                            if (!confirm(`Are you sure you want to delete this ${isFolder ? 'folder' : 'file'}?`)) return;
                            if (isFolder) {
                              removeFolder(item.id);
                            } else {
                              removeFile(item.id);
                            }
                            if (sessionString && apiId && apiHash) {
                              const client = await getTelegramClient(sessionString, apiId, apiHash);
                              await syncToMetadataChannel(client);
                            }
                            toast.success(`${isFolder ? 'Folder' : 'File'} deleted`);
                          }}
                          className="p-2 opacity-0 group-hover:opacity-100 hover:bg-red-100 dark:hover:bg-red-900/20 text-red-500 rounded-full transition-all"
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
