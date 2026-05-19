import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { TelegramClient } from 'telegram'
import { Api } from 'telegram'
import { Buffer } from 'buffer'

export interface TGFile {
  id: string
  name: string
  size: number
  mimeType: string
  createdAt: number
  folderId: string | null
  messageId: number
  channelId: string
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

  setMetadataChannelId: (id: string) => void
  addFolder: (folder: TGFolder) => void
  addFile: (file: TGFile) => void
  removeFile: (id: string) => void
  removeFolder: (id: string) => void
  syncFromMetadataChannel: (client: TelegramClient) => Promise<void>
  syncToMetadataChannel: (client: TelegramClient) => Promise<void>
}

const SYNC_CHANNEL_NAME = 'TG_Cloud_Storage_Metadata'

export const useFileSystemStore = create<FileSystemState>()(
  persist(
    (set, get) => ({
      files: [],
      folders: [],
      metadataChannelId: null,

      setMetadataChannelId: (id) => set({ metadataChannelId: id }),

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

      syncFromMetadataChannel: async (client: TelegramClient) => {
        try {
          const state = get()
          let channelId = state.metadataChannelId

          if (!channelId) {
            const dialogs = await client.getDialogs({})
            const metadataDialog = dialogs.find(d => d.title === SYNC_CHANNEL_NAME)

            if (metadataDialog) {
              const id = metadataDialog.entity?.id?.toString() || null
              if (id) {
                channelId = id.startsWith('-100') ? id : `-100${id}`
                set({ metadataChannelId: channelId })
              }
            } else {
              const result = await client.invoke(
                new Api.channels.CreateChannel({
                  title: SYNC_CHANNEL_NAME,
                  about: 'Metadata for TG Cloud Storage Web App. Do not delete or modify this channel.',
                  broadcast: true,
                })
              )

              // Add -100 prefix for Telegram channels if it doesn't already have it
              const id = (result as any).chats[0].id.toString()
              const newChannelId = id.startsWith('-100') ? id : `-100${id}`
              channelId = newChannelId
              set({ metadataChannelId: newChannelId })
            }
          }

          if (!channelId) return

          const messages = await client.getMessages(channelId, { limit: 1 })

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

          if (jsonString.length > 4000) {
            const buffer = Buffer.from(jsonString, 'utf-8')
            await client.sendFile(state.metadataChannelId, {
              file: buffer,
              caption: 'metadata.json'
            })
          } else {
             await client.sendMessage(state.metadataChannelId, {
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
