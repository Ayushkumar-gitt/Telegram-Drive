import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type AccountType = 'simple' | 'telegram'

export interface Profile {
  userId: string
  apiId: number
  apiHash: string
  phone: string
  createdAt: number
}

interface AuthState {
  // Active session
  apiId: number | null
  apiHash: string | null
  sessionString: string | null
  isAuthenticated: boolean
  userId: string | null
  phone: string | null
  /** 'simple' = email+pass user on admin account | 'telegram' = own credentials */
  accountType: AccountType

  // All saved profiles on this device (userId → Profile)
  profiles: Record<string, Profile>

  setCredentials: (apiId: number, apiHash: string, phone: string) => void
  setSessionString: (session: string) => void
  saveProfile: (profile: Profile) => void
  setActiveUser: (userId: string) => void
  getProfile: (userId: string) => Profile | null
  /** Used by simple login: set admin session directly without OTP flow */
  setSimpleSession: (userId: string, adminApiId: number, adminApiHash: string, adminSession: string) => void
  logout: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      apiId: null,
      apiHash: null,
      sessionString: null,
      isAuthenticated: false,
      userId: null,
      phone: null,
      accountType: 'telegram',
      profiles: {},

      setCredentials: (apiId, apiHash, phone) =>
        set({ apiId, apiHash, phone }),

      setSessionString: (sessionString) =>
        set({ sessionString, isAuthenticated: true }),

      saveProfile: (profile) =>
        set((state) => ({
          profiles: { ...state.profiles, [profile.userId]: profile },
          userId: profile.userId,
          phone: profile.phone,
          apiId: profile.apiId,
          apiHash: profile.apiHash,
          accountType: 'telegram',
        })),

      setActiveUser: (userId) => {
        const profile = get().profiles[userId]
        if (profile) {
          set({
            userId: profile.userId,
            apiId: profile.apiId,
            apiHash: profile.apiHash,
            phone: profile.phone,
          })
        }
      },

      setSimpleSession: (userId, adminApiId, adminApiHash, adminSession) =>
        set({
          userId,
          apiId: adminApiId,
          apiHash: adminApiHash,
          sessionString: adminSession,
          isAuthenticated: true,
          accountType: 'simple',
          phone: null,
        }),

      getProfile: (userId) => get().profiles[userId] ?? null,

      logout: () =>
        set({
          apiId: null,
          apiHash: null,
          sessionString: null,
          isAuthenticated: false,
          userId: null,
          phone: null,
          accountType: 'telegram',
          // profiles are intentionally kept so re-login is easy
        }),
    }),
    { name: 'tg-cloud-auth' }
  )
)
