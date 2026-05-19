import { TelegramClient } from 'telegram'
import { CustomFile } from 'telegram/client/uploads'
import { v4 as uuidv4 } from 'uuid'
import { type TGFile } from '../store/filesystem'
import { Buffer } from 'buffer'

const CHUNK_SIZE = 100 * 1024 * 1024 // 100 MB

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

      // The browser's native File object is sometimes problematic.
      // But GramJS's `CustomFile` can accept an array buffer.
      let uploadFile: any = file
      if (typeof window !== 'undefined') {
        const buffer = await file.arrayBuffer()
        uploadFile = new CustomFile(file.name, file.size, "", Buffer.from(buffer))
      }

      // Use Number() to convert the string ID to a number so GramJS resolves it properly
      const peer = Number(channelId)

      const result = await client.sendFile(peer, {
        file: uploadFile,
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
        let uploadChunkFile: any = chunkFile
        if (typeof window !== 'undefined') {
          const buffer = await chunkFile.arrayBuffer()
          uploadChunkFile = new CustomFile(chunkFile.name, chunkFile.size, "", Buffer.from(buffer))
        }

        const peer = Number(channelId)
        const result = await client.sendFile(peer, {
          file: uploadChunkFile,
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
