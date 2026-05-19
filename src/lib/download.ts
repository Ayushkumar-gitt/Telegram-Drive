import { TelegramClient } from 'telegram'
import { type TGFile } from '../store/filesystem'
import { Buffer } from 'buffer'

export const downloadFileFromTelegram = async (
  client: TelegramClient,
  file: TGFile,
  onProgress?: (progress: number) => void
) => {
  try {
    let totalBuffer: Buffer

    if (file.isChunked && file.chunkMessageIds && file.chunkMessageIds.length > 0) {
      const buffers: Buffer[] = []
      const totalChunks = file.chunkMessageIds.length

      for (let i = 0; i < totalChunks; i++) {
        const messageId = file.chunkMessageIds[i]
        const peer = Number(file.channelId)
        const messages = await client.getMessages(peer, { ids: [messageId] })

        if (messages.length === 0 || !messages[0].media) {
          throw new Error(`Chunk ${i + 1} not found in Telegram`)
        }

        const buffer = await client.downloadMedia(messages[0], {
          progressCallback: (downloaded: any, total: any) => {
            if (onProgress && total) {
              const chunkProgress = Number(downloaded) / Number(total)
              const overallProgress = ((i + chunkProgress) / totalChunks) * 100
              onProgress(overallProgress)
            }
          }
        })

        if (!buffer) throw new Error(`Failed to download chunk ${i + 1}`)
        buffers.push(buffer as Buffer)
      }

      totalBuffer = Buffer.concat(buffers)
    } else {
      // 1. Fetch message metadata
      const peer = Number(file.channelId)
      const messages = await client.getMessages(peer, { ids: [file.messageId] })
      if (messages.length === 0 || !messages[0].media) {
        throw new Error('File not found in Telegram')
      }

      // 2. Download media
      const buffer = await client.downloadMedia(messages[0], {
        progressCallback: (downloaded: any, total: any) => {
          if (onProgress && total) {
            const progress = Number(downloaded) / Number(total)
            onProgress(progress * 100)
          }
        }
      })

      if (!buffer) {
        throw new Error('Failed to download media buffer')
      }

      totalBuffer = buffer as Buffer
    }

    // 3. Trigger download in browser
    const blob = new Blob([totalBuffer], { type: file.mimeType })
    const url = URL.createObjectURL(blob)

    const a = document.createElement('a')
    a.href = url
    a.download = file.name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)

    setTimeout(() => URL.revokeObjectURL(url), 1000)

    return true
  } catch (error) {
    console.error('Download error:', error)
    throw error
  }
}
