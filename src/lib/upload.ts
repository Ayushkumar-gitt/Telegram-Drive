import { TelegramClient } from 'telegram'
import { v4 as uuidv4 } from 'uuid'
import { type TGFile } from '../store/filesystem'

const CHUNK_SIZE = 1.9 * 1024 * 1024 * 1024 // 1.9 GB

export const uploadFileToTelegram = async (
  client: TelegramClient,
  file: File,
  folderId: string | null,
  channelId: string, // The channel to upload to (either the folder's channel or the root metadata/storage channel)
  onProgress?: (progress: number) => void
): Promise<TGFile> => {

  const uploadId = uuidv4()

  try {
    if (file.size <= CHUNK_SIZE) {
      // Standard upload for files <= 1.9GB

      // The browser's native File object must be passed directly into the API for sendFile
      // as GramJS checks `typeof File !== "undefined" && file instanceof File`
      const result = await client.sendFile(channelId, {
        file: file,
        caption: file.name,
        forceDocument: true,
        workers: 4, // Upload speed optimization: concurrent workers
        progressCallback: (progress: number) => {
          if (onProgress) onProgress(progress * 100)
        }
      })

      const tgFile: TGFile = {
        id: uploadId,
        name: file.name,
        size: file.size,
        mimeType: file.type || 'application/octet-stream',
        createdAt: Date.now(),
        folderId,
        messageId: result.id,
        channelId: channelId,
        isChunked: false
      }

      return tgFile
    } else {
      // File Chunking Logic for > 1.9GB
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
      const chunkMessageIds: number[] = []

      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE
        const end = Math.min(start + CHUNK_SIZE, file.size)
        const chunkBlob = file.slice(start, end)
        const chunkFile = new File([chunkBlob], `${file.name}.part${i + 1}`)

        const result = await client.sendFile(channelId, {
          file: chunkFile,
          caption: `${file.name} (Part ${i + 1}/${totalChunks})`,
          forceDocument: true,
          workers: 4,
          progressCallback: (progress: number) => {
            if (onProgress) {
              const overallProgress = ((i + progress) / totalChunks) * 100
              onProgress(overallProgress)
            }
          }
        })

        chunkMessageIds.push(result.id)
      }

      const tgFile: TGFile = {
        id: uploadId,
        name: file.name,
        size: file.size,
        mimeType: file.type || 'application/octet-stream',
        createdAt: Date.now(),
        folderId,
        messageId: chunkMessageIds[0], // the first part serves as the main reference
        channelId: channelId,
        isChunked: true,
        chunkMessageIds: chunkMessageIds
      }

      return tgFile
    }
  } catch (error) {
    console.error('Upload failed', error)
    throw error
  }
}
