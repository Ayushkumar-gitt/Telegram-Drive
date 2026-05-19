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
import { v4 as uuidv4 } from 'uuid'
import { toast } from 'react-hot-toast'

interface UploaderProps {
  currentFolderId: string | null
}

export const Uploader = ({ currentFolderId }: UploaderProps) => {
  const { tasks, addTask, updateTaskProgress, setTaskStatus, removeTask } = useUploadStore()
  const { sessionString, apiId, apiHash } = useAuthStore()
  const { addFile, syncToMetadataChannel, metadataChannelId, folders } = useFileSystemStore()

  const [isMinimized, setIsMinimized] = useState(false)

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    if (!sessionString || !apiId || !apiHash) return

    const client = await getTelegramClient(sessionString, apiId, apiHash)

    // Determine the channel to upload to
    let targetChannelId = metadataChannelId
    if (currentFolderId) {
      const folder = folders.find(f => f.id === currentFolderId)
      if (folder) targetChannelId = folder.channelId
    }

    if (!targetChannelId) {
      toast.error('Could not determine upload destination')
      return
    }

    for (const file of acceptedFiles) {
      const taskId = uuidv4()
      addTask({
        id: taskId,
        file,
        progress: 0,
        status: 'pending'
      })

      try {
        setTaskStatus(taskId, 'uploading')

        const tgFile = await uploadFileToTelegram(
          client,
          file,
          currentFolderId,
          targetChannelId,
          (progress) => updateTaskProgress(taskId, progress)
        )

        addFile(tgFile)
        setTaskStatus(taskId, 'completed')

        // Sync the new state
        await syncToMetadataChannel(client)

      } catch (error: any) {
        setTaskStatus(taskId, 'error', error.message)
        toast.error(`Failed to upload ${file.name}`)
      }
    }
  }, [sessionString, apiId, apiHash, metadataChannelId, currentFolderId, folders, addTask, setTaskStatus, updateTaskProgress, addFile, syncToMetadataChannel])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    noClick: true, // We will trigger click manually via a button in the UI
    noKeyboard: true
  })

  // Global drag overlay
  const dragOverlay = isDragActive && (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-blue-500/20 backdrop-blur-sm border-4 border-blue-500 border-dashed m-4 rounded-xl pointer-events-none">
      <div className="bg-white dark:bg-gray-800 p-8 rounded-2xl shadow-2xl flex flex-col items-center">
        <UploadCloud className="w-16 h-16 text-blue-500 mb-4" />
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Drop files here to upload</h2>
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

      {/* Upload Manager UI */}
      {tasks.length > 0 && (
        <motion.div
          initial={{ y: 100, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="fixed bottom-6 right-6 w-96 bg-white dark:bg-gray-800 rounded-xl shadow-2xl overflow-hidden z-40 border border-gray-200 dark:border-gray-700 flex flex-col max-h-[500px]"
        >
          <div
            className="flex items-center justify-between p-4 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 cursor-pointer"
            onClick={() => setIsMinimized(!isMinimized)}
          >
            <div>
              <h3 className="font-medium text-sm">Uploads ({activeTasks.length} active)</h3>
              {completedTasks.length > 0 && (
                <p className="text-xs text-gray-500">{completedTasks.length} completed</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  tasks.forEach(t => removeTask(t.id))
                }}
                className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
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
                className="overflow-y-auto p-2 space-y-2"
              >
                {tasks.map(task => (
                  <div key={task.id} className="p-3 bg-gray-50 dark:bg-gray-900/50 rounded-lg flex items-center gap-3">
                    <File className="w-8 h-8 text-blue-500 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-medium truncate pr-2">{task.file.name}</span>
                        {task.status === 'completed' && <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />}
                        {task.status === 'error' && <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" />}
                      </div>

                      <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
                        <span>{filesize(task.file.size)}</span>
                        {task.status === 'uploading' && <span>{Math.round(task.progress)}%</span>}
                        {task.status === 'error' && <span className="text-red-500">Failed</span>}
                      </div>

                      {task.status === 'uploading' && (
                        <div className="h-1.5 w-full bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                          <motion.div
                            className="h-full bg-blue-500"
                            initial={{ width: 0 }}
                            animate={{ width: `${task.progress}%` }}
                          />
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
