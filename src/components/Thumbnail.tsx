import { useState, useEffect } from 'react'
import { type TGFile } from '../store/filesystem'
import { getTelegramClient } from '../lib/telegram'
import { useAuthStore } from '../store/auth'
import { Buffer } from 'buffer'
import { Image as ImageIcon, Video as VideoIcon } from 'lucide-react'

const thumbnailCache = new Map<string, string>()

interface ThumbnailProps {
  file: TGFile
}

export const Thumbnail = ({ file }: ThumbnailProps) => {
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(thumbnailCache.get(file.id) || null)
  const { sessionString, apiId, apiHash, accountType } = useAuthStore()

  useEffect(() => {
    let isMounted = true

    const fetchThumbnail = async () => {
      if (thumbnailUrl) return
      if (!file.mimeType.startsWith('image/') && !file.mimeType.startsWith('video/')) return
      // Simple users don't use browser GramJS — skip thumbnail fetch to avoid WebSocket errors
      if (accountType === 'simple') return
      if (!sessionString || !apiId || !apiHash) return

      try {
        const client = await getTelegramClient(sessionString, apiId, apiHash)

        const peer = Number(file.channelId)
        const messageId = file.isChunked && file.chunkMessageIds ? file.chunkMessageIds[0] : file.messageId
        const messages = await client.getMessages(peer, { ids: [messageId] })

        if (messages.length > 0 && messages[0].media) {
          const buffer = await client.downloadMedia(messages[0], { thumb: 1 })

          if (buffer && isMounted) {
            const blob = new Blob([buffer as Buffer], { type: 'image/jpeg' })
            const url = URL.createObjectURL(blob)
            thumbnailCache.set(file.id, url)
            setThumbnailUrl(url)
          }
        }
      } catch (error) {
        console.error('Failed to load thumbnail for', file.name, error)
      }
    }

    fetchThumbnail()

    return () => {
      isMounted = false
    }
  }, [file, sessionString, apiId, apiHash, thumbnailUrl])

  if (thumbnailUrl) {
    return (
      <img
        src={thumbnailUrl}
        alt={file.name}
        className="w-6 h-6 rounded object-cover flex-shrink-0"
      />
    )
  }

  if (file.mimeType.startsWith('image/')) return <ImageIcon className="w-5 h-5 text-blue-500 flex-shrink-0" />
  if (file.mimeType.startsWith('video/')) return <VideoIcon className="w-5 h-5 text-purple-500 flex-shrink-0" />

  return null
}
