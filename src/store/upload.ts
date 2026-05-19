import { create } from 'zustand'

interface UploadTask {
  id: string
  file: File
  progress: number
  status: 'pending' | 'uploading' | 'completed' | 'error'
  error?: string
}

interface UploadStore {
  tasks: UploadTask[]
  addTask: (task: UploadTask) => void
  updateTaskProgress: (id: string, progress: number) => void
  setTaskStatus: (id: string, status: UploadTask['status'], error?: string) => void
  removeTask: (id: string) => void
  clearCompleted: () => void
}

export const useUploadStore = create<UploadStore>((set) => ({
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
