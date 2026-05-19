import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Play, FileText, Download } from 'lucide-react'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'
import { type TGFile } from '../store/filesystem'
import { getTelegramClient } from '../lib/telegram'
import { useAuthStore } from '../store/auth'
import { Buffer } from 'buffer'

// Load worker locally to avoid third-party requests
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

interface FileViewerProps {
  file: TGFile | null
  onClose: () => void
}

export const FileViewer = ({ file, onClose }: FileViewerProps) => {
  const { sessionString, apiId, apiHash } = useAuthStore()
  const [fileUrl, setFileUrl] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [numPages, setNumPages] = useState<number | null>(null)

  useEffect(() => {
    if (!file || !sessionString || !apiId || !apiHash) return

    const loadMedia = async () => {
      // Very simple size limit check to prevent browser crash from buffering into RAM
      // In a real robust implementation, we would write a ServiceWorker proxy
      // that intercepts requests and streams chunks natively.
      const MAX_PREVIEW_SIZE = 100 * 1024 * 1024 // 100 MB
      if (file.size > MAX_PREVIEW_SIZE) {
        return // We will show a download prompt instead
      }

      setIsLoading(true)
      try {
        const client = await getTelegramClient(sessionString, apiId, apiHash)

        let totalBuffer: Buffer | null = null

        const peer = Number(file.channelId)

        if (file.isChunked && file.chunkMessageIds && file.chunkMessageIds.length > 0) {
          const buffers: Buffer[] = []
          for (const messageId of file.chunkMessageIds) {
            const messages = await client.getMessages(peer, { ids: [messageId] })
            if (messages.length > 0 && messages[0].media) {
              const buffer = await client.downloadMedia(messages[0], {
                workers: 4
              } as any)
              if (buffer) buffers.push(Buffer.from(buffer as ArrayBuffer))
            }
          }
          if (buffers.length > 0) totalBuffer = Buffer.concat(buffers)
        } else {
          // Fetch the message containing the file
          const messages = await client.getMessages(peer, { ids: [file.messageId] })
          if (messages.length > 0 && messages[0].media) {
            const buffer = await client.downloadMedia(messages[0], {
              workers: 4
            } as any)
            if (buffer) totalBuffer = Buffer.from(buffer as ArrayBuffer)
          }
        }

        if (totalBuffer) {
          const blob = new Blob([totalBuffer], { type: file.mimeType })
          const url = URL.createObjectURL(blob)
          setFileUrl(url)
        }
      } catch (error) {
        console.error('Failed to load media', error)
      } finally {
        setIsLoading(false)
      }
    }

    loadMedia()

    return () => {
      if (fileUrl) {
        URL.revokeObjectURL(fileUrl)
      }
    }
  }, [file, sessionString, apiId, apiHash])

  if (!file) return null

  const isImage = file.mimeType.startsWith('image/')
  const isVideo = file.mimeType.startsWith('video/')
  const isAudio = file.mimeType.startsWith('audio/')
  const isPdf = file.mimeType === 'application/pdf'
  const isTooLarge = file.size > 100 * 1024 * 1024

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 p-4"
      >
        {/* Header */}
        <div className="absolute top-0 left-0 right-0 p-4 flex items-center justify-between bg-gradient-to-b from-black/50 to-transparent z-10 text-white">
          <div className="flex flex-col">
            <span className="font-medium truncate max-w-md">{file.name}</span>
            <span className="text-xs text-gray-300">{(file.size / 1024 / 1024).toFixed(2)} MB</span>
          </div>
          <div className="flex items-center gap-4">
            {fileUrl && (
              <a
                href={fileUrl}
                download={file.name}
                className="p-2 hover:bg-white/10 rounded-full transition-colors"
                title="Download"
              >
                <Download className="w-5 h-5" />
              </a>
            )}
            <button
              onClick={onClose}
              className="p-2 hover:bg-white/10 rounded-full transition-colors"
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
                onClick={() => {
                  // Trigger download
                  import('../lib/download').then(async ({ downloadFileFromTelegram }) => {
                    if (sessionString && apiId && apiHash) {
                      const client = await getTelegramClient(sessionString, apiId, apiHash)
                      downloadFileFromTelegram(client, file)
                    }
                  })
                }}
                className="px-6 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors flex items-center gap-2"
              >
                <Download className="w-4 h-4" />
                Download File
              </button>
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
                  <a
                    href={fileUrl}
                    download={file.name}
                    className="mt-4 px-6 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors flex items-center gap-2"
                  >
                    <Download className="w-4 h-4" />
                    Download File
                  </a>
                </div>
              )}
            </>
          ) : null}
        </div>
      </motion.div>
    </AnimatePresence>
  )
}
