import { useCallback, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useDropzone } from 'react-dropzone'
import { X, UploadCloud, File, AlertCircle, CheckCircle2 } from 'lucide-react'
import { filesize } from 'filesize'
import { useUploadStore } from '../store/upload'
import { useAuthStore } from '../store/auth'
import { useFileSystemStore } from '../store/filesystem'
import { getTelegramClient } from '../lib/telegram'
import { uploadFileToTelegram } from '../lib/upload'
import { apiUploadFile } from '../lib/simpleUserApi'
import { v4 as uuidv4 } from 'uuid'
import { toast } from 'react-hot-toast'

interface UploaderProps {
  currentFolderId: string | null
}

export const Uploader = ({ currentFolderId }: UploaderProps) => {
  const { tasks, addTask, updateTaskProgress, setTaskStatus, removeTask } = useUploadStore()
  const { sessionString, apiId, apiHash, userId, accountType } = useAuthStore()
  const {
    addFile,
    syncToMetadataChannel,
    syncFromMetadataChannel,
    metadataChannelId,
    metadataAccessHash,
    folders
  } = useFileSystemStore()

  const [isMinimized, setIsMinimized] = useState(false)

  // For telegram users: ensure the metadata channel exists before uploading
  const ensureChannelReady = async (): Promise<{ channelId: string; accessHash: string | null } | null> => {
    if (!sessionString || !apiId || !apiHash) return null
    const client = await getTelegramClient(sessionString, apiId, apiHash)
    if (metadataChannelId) return { channelId: metadataChannelId, accessHash: metadataAccessHash }
    await syncFromMetadataChannel(client)
    const state = useFileSystemStore.getState()
    if (state.metadataChannelId) return { channelId: state.metadataChannelId, accessHash: state.metadataAccessHash }
    return null
  }

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    if (!userId) return

    for (const file of acceptedFiles) {
      const taskId = uuidv4()
      addTask({ id: taskId, file, progress: 0, status: 'pending' })

      try {
        setTaskStatus(taskId, 'uploading')

        if (accountType === 'simple') {
          // ── Simple user: server-side chunked upload (browser never touches Telegram) ─
          // Large files are split into ≤3.5 MB chunks in apiUploadFile before
          // each POST reaches Vercel, so the 4.5 MB body limit is never hit.
          const result = await apiUploadFile(
            userId, userId,
            file,
            currentFolderId,
            (pct) => updateTaskProgress(taskId, pct)
          )
          addFile(result.file)
          setTaskStatus(taskId, 'completed')

        } else {
          // ── Telegram user: upload via browser GramJS ────────────────────
          if (!sessionString || !apiId || !apiHash) { setTaskStatus(taskId, 'error', 'Not authenticated'); continue }

          const rootChannel = await ensureChannelReady()
          if (!rootChannel) { setTaskStatus(taskId, 'error', 'Could not reach storage'); continue }

          const client = await getTelegramClient(sessionString, apiId, apiHash)

          let targetChannelId = rootChannel.channelId
          let targetAccessHash = rootChannel.accessHash
          if (currentFolderId) {
            const currentFolders = useFileSystemStore.getState().folders
            const folder = currentFolders.find(f => f.id === currentFolderId)
            if (folder) { targetChannelId = folder.channelId; targetAccessHash = folder.accessHash }
          }

          const tgFile = await uploadFileToTelegram(
            client, file, currentFolderId,
            targetChannelId, targetAccessHash,
            (pct) => updateTaskProgress(taskId, pct)
          )
          addFile(tgFile)
          setTaskStatus(taskId, 'completed')
          await syncToMetadataChannel(client)
        }

      } catch (error: any) {
        setTaskStatus(taskId, 'error', error.message)
        toast.error(`Failed to upload ${file.name}: ${error.message}`)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, accountType, sessionString, apiId, apiHash, metadataChannelId, metadataAccessHash, currentFolderId, folders])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    noClick: true,
    noKeyboard: true
  })

  const dragOverlay = isDragActive && (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm border-2 border-white/20 border-dashed m-4 rounded-2xl pointer-events-none transition-all">
      <div className="bg-white/90 dark:bg-[#111]/90 backdrop-blur-md p-10 rounded-3xl shadow-2xl flex flex-col items-center border border-neutral-200/50 dark:border-white/10">
        <div className="w-20 h-20 bg-neutral-100 dark:bg-white/10 rounded-full flex items-center justify-center mb-6">
          <UploadCloud className="w-10 h-10 text-black dark:text-white" />
        </div>
        <h2 className="text-2xl font-semibold text-neutral-800 dark:text-neutral-100 mb-2">Drop to upload</h2>
        <p className="text-neutral-500 dark:text-neutral-400 text-sm">Release your files to start uploading</p>
      </div>
    </div>
  )

  const activeTasks = tasks.filter(t => t.status !== 'completed')
  const completedTasks = tasks.filter(t => t.status === 'completed')

  if (tasks.length === 0 && !isDragActive) return (
    <div {...getRootProps()} className="absolute inset-0 pointer-events-none">
      <input {...getInputProps()} id="global-file-input" />
    </div>
  )

  return (
    <>
      <div {...getRootProps()} className="absolute inset-0 pointer-events-none">
        <input {...getInputProps()} id="global-file-input" />
      </div>

      {dragOverlay}

      {tasks.length > 0 && (
        <motion.div
          initial={{ y: 100, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="fixed bottom-6 right-6 w-96 bg-white dark:bg-[#111] rounded-2xl shadow-2xl overflow-hidden z-40 border border-neutral-200 dark:border-white/10 flex flex-col max-h-[500px]"
        >
          <div
            className="flex items-center justify-between p-4 bg-neutral-50/80 dark:bg-[#0a0a0a]/50 backdrop-blur-md border-b border-neutral-200 dark:border-white/10 cursor-pointer"
            onClick={() => setIsMinimized(!isMinimized)}
          >
            <div>
              <h3 className="font-semibold text-sm text-neutral-800 dark:text-neutral-100">Uploads ({activeTasks.length} active)</h3>
              {completedTasks.length > 0 && (
                <p className="text-xs text-neutral-500">{completedTasks.length} completed</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={(e) => { e.stopPropagation(); tasks.forEach(t => removeTask(t.id)) }}
                className="p-1.5 hover:bg-neutral-200 dark:hover:bg-white/10 rounded-lg text-neutral-500 transition-colors"
                title="Clear all"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          <AnimatePresence>
            {!isMinimized && (
              <motion.div
                initial={{ height: 0 }}
                animate={{ height: 'auto' }}
                exit={{ height: 0 }}
                className="overflow-y-auto p-3 space-y-3"
              >
                {tasks.map(task => (
                  <div key={task.id} className="p-3 bg-neutral-50/50 dark:bg-white/5 rounded-xl flex items-center gap-4 border border-neutral-100 dark:border-white/5">
                    <div className="w-10 h-10 bg-neutral-100 dark:bg-white/10 rounded-lg flex items-center justify-center flex-shrink-0">
                      <File className="w-5 h-5 text-black dark:text-white" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-sm font-medium text-neutral-700 dark:text-neutral-200 truncate pr-2">{task.file.name}</span>
                        {task.status === 'completed' && <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />}
                        {task.status === 'error' && <AlertCircle className="w-4 h-4 text-rose-500 flex-shrink-0" />}
                      </div>

                      <div className="flex items-center justify-between text-xs text-neutral-500 mb-2">
                        <span>{filesize(task.file.size)}</span>
                        {task.status === 'uploading' && <span className="text-black dark:text-white font-medium">{Math.round(task.progress)}%</span>}
                        {task.status === 'error' && <span className="text-rose-500">{task.error === 'Cancelled' ? 'Cancelled' : 'Failed'}</span>}
                      </div>

                      {task.status === 'uploading' && (
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-full bg-neutral-200 dark:bg-white/10 rounded-full overflow-hidden">
                            <motion.div
                              className="h-full bg-black dark:bg-white"
                              initial={{ width: 0 }}
                              animate={{ width: `${task.progress}%` }}
                            />
                          </div>
                          <button
                            onClick={(e) => { e.stopPropagation(); setTaskStatus(task.id, 'error', 'Cancelled') }}
                            className="p-1 text-neutral-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10 rounded-md transition-colors"
                            title="Cancel upload"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </>
  )
}
