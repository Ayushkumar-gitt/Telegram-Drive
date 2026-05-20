import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { TelegramClient } from 'telegram'
import { Api } from 'telegram'
import { Buffer } from 'buffer'
import { useAuthStore } from './auth'

export interface TGFile {
  id: string
  name: string
  size: number
  mimeType: string
  createdAt: number
  folderId: string | null
  messageId: number
  channelId: string
  accessHash?: string
  thumbnailMessageId?: number
  isChunked?: boolean
  chunkMessageIds?: number[]
}

export interface TGFolder {
  id: string
  name: string
  createdAt: number
  channelId: string
  accessHash: string
}

export interface FileSystemState {
  files: TGFile[]
  folders: TGFolder[]
  metadataChannelId: string | null
  metadataAccessHash: string | null

  setMetadataChannelId: (id: string, accessHash?: string) => void
  addFolder: (folder: TGFolder) => void
  addFile: (file: TGFile) => void
  removeFile: (id: string) => void
  removeFolder: (id: string) => void
  /** Call this on login/logout to wipe cached state so the next sync picks the correct user channel */
  clearForNewSession: () => void
  /** Bulk-load state from server (used by simple users) */
  setFilesAndFolders: (files: TGFile[], folders: TGFolder[]) => void
  syncFromMetadataChannel: (client: TelegramClient) => Promise<void>
  syncToMetadataChannel: (client: TelegramClient) => Promise<void>
}

const SYNC_CHANNEL_NAME = 'TG_Cloud_Storage_Metadata'
// For simple users on admin account: each user gets their own namespaced channel
function getMetadataChannelName(): string {
  const { accountType, userId } = useAuthStore.getState()
  if (accountType === 'simple' && userId) {
    return `StarCloud_Meta_${userId}`
  }
  return SYNC_CHANNEL_NAME
}

export const useFileSystemStore = create<FileSystemState>()(
  persist(
    (set, get) => ({
      files: [],
      folders: [],
      metadataChannelId: null,
      metadataAccessHash: null,

      setMetadataChannelId: (id, accessHash) => set({ metadataChannelId: id, metadataAccessHash: accessHash || null }),

      addFolder: (folder) => set((state) => ({
        folders: [...state.folders, folder]
      })),

      addFile: (file) => set((state) => ({
        files: [...state.files, file]
      })),

      removeFile: (id) => set((state) => ({
        files: state.files.filter(f => f.id !== id)
      })),

      removeFolder: (id) => set((state) => ({
        folders: state.folders.filter(f => f.id !== id),
        files: state.files.filter(f => f.folderId !== id)
      })),

      clearForNewSession: () => set({
        files: [],
        folders: [],
        metadataChannelId: null,
        metadataAccessHash: null,
      }),

      setFilesAndFolders: (files, folders) => set({ files, folders }),

      syncFromMetadataChannel: async (client: TelegramClient) => {
        try {
          const state = get()
          let channelId = state.metadataChannelId
          let accessHash = state.metadataAccessHash

          // Even if we have channelId, we might not have it in the GramJS entity cache on page reload.
          // By calling getDialogs if we don't have an accessHash, we force GramJS to populate its entity cache.
          if (!channelId || !accessHash) {
            const dialogs = await client.getDialogs({})
            const metadataDialog = dialogs.find(d => d.title === getMetadataChannelName())

            if (metadataDialog && metadataDialog.entity) {
              const id = metadataDialog.entity.id?.toString() || null
              const ah = (metadataDialog.entity as any).accessHash?.toString()
              if (id) {
                channelId = id.startsWith('-100') ? id : `-100${id}`
                accessHash = ah
                set({ metadataChannelId: channelId, metadataAccessHash: ah })
              }
            } else {
              const result = await client.invoke(
                new Api.channels.CreateChannel({
                  title: getMetadataChannelName(),
                  about: 'Metadata for Star Cloud storage. Do not delete or modify this channel.',
                  broadcast: true,
                })
              )

              const chat = (result as any).chats[0]
              const id = chat.id.toString()
              const ah = chat.accessHash?.toString()
              const newChannelId = id.startsWith('-100') ? id : `-100${id}`
              channelId = newChannelId
              accessHash = ah
              set({ metadataChannelId: newChannelId, metadataAccessHash: ah })
            }
          }

          if (!channelId) return

          let peer: any = Number(channelId)
          if (accessHash) {
            // Reconstruct the InputPeerChannel so GramJS doesn't fail on cache miss
            const BigIntConstructor = (window as any).BigInt || globalThis.BigInt || Number
            peer = new Api.InputPeerChannel({
              channelId: BigIntConstructor(channelId.replace('-100', '')) as any,
              accessHash: BigIntConstructor(accessHash) as any
            })
          }

          const messages = await client.getMessages(peer, { limit: 1 })

          if (messages.length > 0) {
            const msg = messages[0]
            let jsonText = msg.text

            if (msg.media && msg.document) {
              try {
                const buffer = await client.downloadMedia(msg)
                if (buffer) {
                  jsonText = Buffer.from(buffer as ArrayBuffer).toString('utf-8')
                }
              } catch (e) {
                console.error('Failed to download metadata document', e)
              }
            }

            if (jsonText) {
              try {
                if (jsonText !== 'metadata.json') {
                  const parsedState = JSON.parse(jsonText)
                  if (parsedState.files && parsedState.folders) {
                    set({
                      files: parsedState.files,
                      folders: parsedState.folders
                    })
                    console.log('Successfully synced state from Telegram')
                  }
                }
              } catch (e) {
                console.error('Failed to parse metadata JSON', e)
              }
            }
          }
        } catch (error) {
          console.error('Failed to sync from metadata channel', error)
        }
      },

      syncToMetadataChannel: async (client: TelegramClient) => {
        try {
          const state = get()
          if (!state.metadataChannelId) return

          const stateToSync = {
            files: state.files,
            folders: state.folders,
            updatedAt: Date.now()
          }

          const jsonString = JSON.stringify(stateToSync)

          let peer: any = Number(state.metadataChannelId)
          if (state.metadataAccessHash) {
            const BigIntConstructor = (window as any).BigInt || globalThis.BigInt || Number
            peer = new Api.InputPeerChannel({
              channelId: BigIntConstructor(state.metadataChannelId.replace('-100', '')) as any,
              accessHash: BigIntConstructor(state.metadataAccessHash) as any
            })
          }
          if (jsonString.length > 4000) {
            const buffer = Buffer.from(jsonString, 'utf-8')
            await client.sendFile(peer, {
              file: buffer,
              caption: 'metadata.json'
            })
          } else {
             await client.sendMessage(peer, {
              message: jsonString
            })
          }
        } catch (error) {
          console.error('Failed to sync to metadata channel', error)
        }
      }
    }),
    {
      name: 'tg-cloud-fs',
    }
  )
)
