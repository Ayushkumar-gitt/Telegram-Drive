import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Play, FileText, Download, Video } from 'lucide-react'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'
import { type TGFile } from '../store/filesystem'
import { getTelegramClient } from '../lib/telegram'
import { useAuthStore } from '../store/auth'
import { Buffer } from 'buffer'

pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

const sessionMediaCache = new Map<string, string>();

const MAX_VIDEO_PREVIEW_SIZE = 20 * 1024 * 1024 // 20 MB
const MAX_PREVIEW_SIZE = 100 * 1024 * 1024 // 100 MB for non-video files

interface FileViewerProps {
  file: TGFile | null
  onClose: () => void
  onDownload?: (file: TGFile) => void
}

export const FileViewer = ({ file, onClose, onDownload }: FileViewerProps) => {
  const { sessionString, apiId, apiHash, userId, accountType } = useAuthStore()
  const [fileUrl, setFileUrl] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [numPages, setNumPages] = useState<number | null>(null)
  const [userRequestedVideoPlay, setUserRequestedVideoPlay] = useState(false)

  useEffect(() => {
    // Reset play state when file changes
    setUserRequestedVideoPlay(false)
    setFileUrl(null)
  }, [file?.id])

  useEffect(() => {
    if (!file) return

    const isVideo = file.mimeType?.startsWith('video/')

    // For videos, don't auto-load anything — wait for user to click play
    if (isVideo && !userRequestedVideoPlay) return

    const loadMedia = async () => {
      if (sessionMediaCache.has(file.id)) {
        setFileUrl(sessionMediaCache.get(file.id) as string)
        return
      }

      // Video size check — only preview if <= 20MB
      if (isVideo && file.size > MAX_VIDEO_PREVIEW_SIZE) return

      // For simple users, stream video directly via URL (no full download needed)
      if (accountType === 'simple' && isVideo) {
        const SIMPLE_API = import.meta.env.DEV ? 'http://localhost:3000' : ''
        setFileUrl(`${SIMPLE_API}/api/simple/download/${file.id}?userId=${userId}`)
        return
      }

      // For telegram users, video preview is disabled (would download entire file to RAM)
      if (accountType === 'telegram' && isVideo) return

      // Non-video files: check general size limit
      if (!isVideo && file.size > MAX_PREVIEW_SIZE) return

      setIsLoading(true)
      try {
        let blob: Blob | null = null

        if (accountType === 'simple') {
          const SIMPLE_API = import.meta.env.DEV ? 'http://localhost:3000' : ''
          const res = await fetch(
            `${SIMPLE_API}/api/simple/download/${file.id}`,
            { headers: { 'x-user-id': userId ?? '' } }
          )
          if (!res.ok) throw new Error(`Server returned ${res.status}`)
          const arrayBuffer = await res.arrayBuffer()
          blob = new Blob([arrayBuffer], { type: file.mimeType || 'application/octet-stream' })

        } else {
          if (!sessionString || !apiId || !apiHash) return
          const client = await getTelegramClient(sessionString, apiId, apiHash)
          let peer: any = Number(file.channelId)
          if (file.accessHash) {
            const BigIntConstructor = (window as any).BigInt || globalThis.BigInt || Number
            const { Api } = await import('telegram')
            peer = new Api.InputPeerChannel({
              channelId: BigIntConstructor(file.channelId.replace('-100', '')) as any,
              accessHash: BigIntConstructor(file.accessHash) as any
            })
          }
          let totalBuffer: Buffer | null = null
          if (file.isChunked && file.chunkMessageIds?.length) {
            const buffers: Buffer[] = []
            for (const messageId of file.chunkMessageIds) {
              const messages = await client.getMessages(peer, { ids: [messageId] })
              if (messages.length > 0 && messages[0].media) {
                const buffer = await client.downloadMedia(messages[0], { workers: 4 } as any)
                if (buffer) buffers.push(Buffer.from(buffer as ArrayBuffer))
              }
            }
            if (buffers.length > 0) totalBuffer = Buffer.concat(buffers)
          } else {
            const messages = await client.getMessages(peer, { ids: [file.messageId] })
            if (messages.length > 0 && messages[0].media) {
              const buffer = await client.downloadMedia(messages[0], { workers: 4 } as any)
              if (buffer) totalBuffer = Buffer.from(buffer as ArrayBuffer)
            }
          }
          if (totalBuffer) blob = new Blob([totalBuffer], { type: file.mimeType })
        }

        if (blob) {
          const url = URL.createObjectURL(blob)
          sessionMediaCache.set(file.id, url)
          setFileUrl(url)
        }
      } catch (error) {
        console.error('Failed to load media', error)
      } finally {
        setIsLoading(false)
      }
    }

    loadMedia()
  }, [file, sessionString, apiId, apiHash, userId, accountType, userRequestedVideoPlay])


  if (!file) return null

  const isImage = file.mimeType.startsWith('image/')
  const isVideo = file.mimeType.startsWith('video/')
  const isAudio = file.mimeType.startsWith('audio/')
  const isPdf = file.mimeType === 'application/pdf'
  const isTooLarge = !isVideo && file.size > MAX_PREVIEW_SIZE
  const isVideoTooLarge = isVideo && file.size > MAX_VIDEO_PREVIEW_SIZE
  const isVideoTelegramNoPreview = isVideo && accountType === 'telegram' && file.size <= MAX_VIDEO_PREVIEW_SIZE

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 p-4"
      >
        {/* Header */}
        <div className="absolute top-0 left-0 right-0 p-3 sm:p-4 flex items-center justify-between bg-gradient-to-b from-black/80 via-black/50 to-transparent z-10 text-white">
          <div className="flex flex-col min-w-0 flex-1 mr-3">
            <span className="font-medium truncate max-w-[60vw] sm:max-w-md text-sm sm:text-base">{file.name}</span>
            <span className="text-xs text-gray-300">{(file.size / 1024 / 1024).toFixed(2)} MB</span>
          </div>
          <div className="flex items-center gap-2 sm:gap-4 flex-shrink-0">
            {fileUrl && (
              <button
                onClick={() => onDownload ? onDownload(file) : undefined}
                className="p-2.5 bg-white/10 hover:bg-white/20 rounded-full transition-colors"
                title="Download"
              >
                <Download className="w-5 h-5" />
              </button>
            )}
            <button
              onClick={onClose}
              className="p-2.5 bg-white/20 hover:bg-white/30 rounded-full transition-colors"
            >
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="w-full h-full flex items-center justify-center mt-12 overflow-hidden">
          {isTooLarge ? (
            <div className="text-white flex flex-col items-center max-w-sm text-center">
              <FileText className="w-16 h-16 mb-4 opacity-50" />
              <p className="mb-2 font-medium">File is too large for web preview</p>
              <p className="text-sm text-gray-400 mb-6">Files over 100MB cannot be streamed reliably in the browser. Please download the file to view it.</p>
              <button
                onClick={() => onDownload && onDownload(file)}
                className="px-6 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors flex items-center gap-2"
              >
                <Download className="w-4 h-4" />
                Download File
              </button>
            </div>
          ) : isVideoTooLarge ? (
            <div className="text-white flex flex-col items-center max-w-sm text-center">
              <Video className="w-16 h-16 mb-4 opacity-50" />
              <p className="mb-2 font-medium">Video too large for preview</p>
              <p className="text-sm text-gray-400 mb-6">Videos over 20MB cannot be previewed in the browser. Please download the file to watch it.</p>
              <button
                onClick={() => onDownload && onDownload(file)}
                className="px-6 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors flex items-center gap-2"
              >
                <Download className="w-4 h-4" />
                Download Video
              </button>
            </div>
          ) : isVideo && !userRequestedVideoPlay && !fileUrl ? (
            // Video play button — user must click to start loading
            <div className="flex flex-col items-center text-white">
              <button
                onClick={() => setUserRequestedVideoPlay(true)}
                className="w-24 h-24 rounded-full bg-white/10 hover:bg-white/20 border-2 border-white/30 flex items-center justify-center transition-all hover:scale-110 mb-6"
              >
                <Play className="w-12 h-12 ml-1" />
              </button>
              <p className="text-lg font-medium mb-1">{file.name}</p>
              <p className="text-sm text-gray-400">{(file.size / 1024 / 1024).toFixed(2)} MB — Click to play</p>
              {isVideoTelegramNoPreview && (
                <p className="text-xs text-yellow-400 mt-3">Video preview is not available. Please download instead.</p>
              )}
            </div>
          ) : isLoading && !fileUrl ? (
            <div className="flex flex-col items-center text-white">
              <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4" />
              <p>Loading media...</p>
            </div>
          ) : fileUrl ? (
            <>
              {isImage && (
                <img
                  src={fileUrl}
                  alt={file.name}
                  className="max-w-full max-h-[85vh] object-contain"
                />
              )}
              {isVideo && (
                <video
                  src={fileUrl}
                  controls
                  autoPlay
                  className="max-w-full max-h-[85vh] rounded-lg shadow-2xl"
                />
              )}
              {isAudio && (
                <div className="bg-gray-800 p-8 rounded-2xl flex flex-col items-center">
                  <Play className="w-16 h-16 text-blue-500 mb-6" />
                  <audio src={fileUrl} controls autoPlay className="w-96" />
                </div>
              )}
              {isPdf && (
                <div className="w-full h-[85vh] overflow-y-auto bg-gray-100 dark:bg-gray-800 rounded-lg flex flex-col items-center py-8">
                  <Document
                    file={fileUrl}
                    onLoadSuccess={({ numPages }) => setNumPages(numPages)}
                    loading={
                      <div className="text-gray-500">Loading PDF...</div>
                    }
                  >
                    {Array.from(new Array(numPages), (_, index) => (
                      <Page
                        key={`page_${index + 1}`}
                        pageNumber={index + 1}
                        renderTextLayer={true}
                        renderAnnotationLayer={true}
                        className="mb-8 shadow-xl"
                        width={Math.min(window.innerWidth * 0.8, 800)}
                      />
                    ))}
                  </Document>
                </div>
              )}
              {!isImage && !isVideo && !isAudio && !isPdf && (
                <div className="text-white flex flex-col items-center">
                  <FileText className="w-16 h-16 mb-4 opacity-50" />
                  <p>Preview not available for this file type.</p>
                  <button
                    onClick={() => onDownload && onDownload(file)}
                    className="mt-4 px-6 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors flex items-center gap-2"
                  >
                    <Download className="w-4 h-4" />
                    Download File
                  </button>
                </div>
              )}
            </>
          ) : isVideoTelegramNoPreview ? (
            <div className="flex flex-col items-center text-neutral-400 p-8 text-center max-w-sm">
              <Play className="w-16 h-16 mb-4 opacity-50" />
              <p className="text-lg mb-2">Video preview is not available.</p>
              <p className="text-sm mb-6">Please download the file to view.</p>
              <button
                onClick={() => onDownload && onDownload(file)}
                className="px-6 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors flex items-center gap-2 text-white"
              >
                <Download className="w-4 h-4" />
                Download Video
              </button>
            </div>
          ) : null}
        </div>
      </motion.div>
    </AnimatePresence>
  )
}
