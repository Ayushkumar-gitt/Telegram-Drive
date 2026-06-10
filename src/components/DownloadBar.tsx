import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Download, CheckCircle2, AlertCircle, File } from 'lucide-react'
import { filesize } from 'filesize'
import { useDownloadStore, downloadControllers } from '../store/download'

export const DownloadBar = () => {
  const { tasks, removeTask } = useDownloadStore()
  const [isMinimized, setIsMinimized] = useState(false)

  const activeTasks = tasks.filter(t => t.status !== 'completed')
  const completedTasks = tasks.filter(t => t.status === 'completed')

  if (tasks.length === 0) return null

  return (
    <motion.div
      initial={{ y: 100, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      className="fixed bottom-24 md:bottom-6 left-4 md:left-6 w-[calc(100%-2rem)] md:w-96 bg-white dark:bg-[#111] rounded-2xl shadow-2xl overflow-hidden z-[60] border border-neutral-200 dark:border-white/10 flex flex-col max-h-[400px] md:max-h-[500px]"
    >
      <div
        className="flex items-center justify-between p-4 bg-neutral-50/80 dark:bg-[#0a0a0a]/50 backdrop-blur-md border-b border-neutral-200 dark:border-white/10 cursor-pointer"
        onClick={() => setIsMinimized(!isMinimized)}
      >
        <div className="flex items-center gap-2">
          <Download className="w-4 h-4 text-blue-500" />
          <div>
            <h3 className="font-semibold text-sm text-neutral-800 dark:text-neutral-100">Downloads ({activeTasks.length} active)</h3>
            {completedTasks.length > 0 && (
              <p className="text-xs text-neutral-500">{completedTasks.length} completed</p>
            )}
          </div>
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
                    <span className="text-sm font-medium text-neutral-700 dark:text-neutral-200 truncate pr-2">{task.fileName}</span>
                    {task.status === 'completed' && <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />}
                    {task.status === 'error' && <AlertCircle className="w-4 h-4 text-rose-500 flex-shrink-0" />}
                  </div>

                  <div className="flex items-center justify-between text-xs text-neutral-500 mb-2">
                    <span>{filesize(task.fileSize)}</span>
                    {task.status === 'downloading' && <span className="text-black dark:text-white font-medium">{Math.round(task.progress)}%</span>}
                    {task.status === 'error' && <span className="text-rose-500">Failed</span>}
                    {task.status === 'completed' && <span className="text-emerald-500">Done</span>}
                  </div>

                  {task.status === 'downloading' && (
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-full bg-neutral-200 dark:bg-white/10 rounded-full overflow-hidden">
                        <motion.div
                          className="h-full bg-blue-500"
                          initial={{ width: 0 }}
                          animate={{ width: `${task.progress}%` }}
                        />
                      </div>
                      <button
                        onClick={(e) => { 
                          e.stopPropagation()
                          const ctrl = downloadControllers.get(task.id)
                          if (ctrl) {
                            ctrl.abort()
                          } else {
                            useDownloadStore.getState().setTaskStatus(task.id, 'error', 'Cancelled')
                          }
                        }}
                        className="p-1 text-neutral-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10 rounded-md transition-colors"
                        title="Cancel download"
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
  )
}
