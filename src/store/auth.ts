import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface AuthState {
  apiId: number | null
  apiHash: string | null
  sessionString: string | null
  isAuthenticated: boolean
  setCredentials: (apiId: number, apiHash: string) => void
  setSessionString: (session: string) => void
  logout: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      apiId: null,
      apiHash: null,
      sessionString: null,
      isAuthenticated: false,
      setCredentials: (apiId, apiHash) => set({ apiId, apiHash }),
      setSessionString: (sessionString) => set({ sessionString, isAuthenticated: true }),
      logout: () => set({ apiId: null, apiHash: null, sessionString: null, isAuthenticated: false }),
    }),
    {
      name: 'tg-cloud-auth',
    }
  )
)
