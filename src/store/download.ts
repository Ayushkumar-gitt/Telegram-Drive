import { create } from 'zustand'

export const downloadControllers = new Map<string, AbortController>()

export interface DownloadTask {
  id: string
  fileName: string
  fileSize: number
  progress: number
  status: 'pending' | 'downloading' | 'completed' | 'error'
  error?: string
}

interface DownloadStore {
  tasks: DownloadTask[]
  addTask: (task: DownloadTask) => void
  updateTaskProgress: (id: string, progress: number) => void
  setTaskStatus: (id: string, status: DownloadTask['status'], error?: string) => void
  removeTask: (id: string) => void
  clearCompleted: () => void
}

export const useDownloadStore = create<DownloadStore>((set) => ({
  tasks: [],
  addTask: (task) => set((state) => ({ tasks: [...state.tasks, task] })),
  updateTaskProgress: (id, progress) => set((state) => ({
    tasks: state.tasks.map(t => t.id === id ? { ...t, progress } : t)
  })),
  setTaskStatus: (id, status, error) => set((state) => ({
    tasks: state.tasks.map(t => t.id === id ? { ...t, status, error } : t)
  })),
  removeTask: (id) => set((state) => ({
    tasks: state.tasks.filter(t => t.id !== id)
  })),
  clearCompleted: () => set((state) => ({
    tasks: state.tasks.filter(t => t.status !== 'completed')
  }))
}))
