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
  accessHash: string | null, // Access hash if available
  onProgress?: (progress: number) => void
): Promise<TGFile> => {

  const uploadId = uuidv4()

  try {
    let peer: any = Number(channelId)
    if (accessHash) {
      const BigIntConstructor = (window as any).BigInt || globalThis.BigInt || Number
      const { Api } = await import('telegram')
      peer = new Api.InputPeerChannel({
        channelId: BigIntConstructor(channelId.replace('-100', '')) as any,
        accessHash: BigIntConstructor(accessHash) as any
      })
    }

    if (file.size <= CHUNK_SIZE) {
      // Standard upload for files <= 1.9GB

      // The browser's native File object is sometimes problematic.
      // But GramJS's `CustomFile` can accept an array buffer.
      let uploadFile: any = file
      if (typeof window !== 'undefined') {
        const buffer = await file.arrayBuffer()
        const nodeBuffer = Buffer.from(buffer)
        // Passing an empty string for path causes gramjs to throw the buffer error in some environments when parsing `filePath || buffer`.
        // We explicitly set buffer in the CustomFile.
        const customFile = new CustomFile(file.name, file.size, "", nodeBuffer)
        customFile.buffer = nodeBuffer // Force buffer assignment just in case constructor fails to map it.
        uploadFile = customFile
      }

      // Passing maxBufferSize forces gramjs to bypass the logic where it falls back to
      // node `fs` functions internally which causes the 'CustomBuffer options' failure.
      const result = await client.sendFile(peer, {
        file: uploadFile,
        caption: file.name,
        forceDocument: true,
        workers: 4, // Upload speed optimization: concurrent workers
        maxBufferSize: CHUNK_SIZE + 1024,
        progressCallback: (progress: number) => {
          if (onProgress) onProgress(progress * 100)
        }
      } as any)

      const tgFile: TGFile = {
        id: uploadId,
        name: file.name,
        size: file.size,
        mimeType: file.type || 'application/octet-stream',
        createdAt: Date.now(),
        folderId,
        messageId: result.id,
        channelId: channelId,
        accessHash: accessHash || undefined,
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
          const nodeBuffer = Buffer.from(buffer)
          const customFile = new CustomFile(chunkFile.name, chunkFile.size, "", nodeBuffer)
          customFile.buffer = nodeBuffer
          uploadChunkFile = customFile
        }

        // Send maxBufferSize larger than CHUNK_SIZE so gramjs uses our buffer
        const result = await client.sendFile(peer, {
          file: uploadChunkFile,
          caption: `${file.name} (Part ${i + 1}/${totalChunks})`,
          forceDocument: true,
          workers: 4,
          maxBufferSize: CHUNK_SIZE + 1024,
          progressCallback: (progress: number) => {
            if (onProgress) {
              const overallProgress = ((i + progress) / totalChunks) * 100
              onProgress(overallProgress)
            }
          }
        } as any)

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
        accessHash: accessHash || undefined,
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
