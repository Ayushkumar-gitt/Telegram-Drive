import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { Download, FileText, Image, Video, Music, File, AlertCircle, Eye, Cloud, Loader2 } from 'lucide-react'

const API_BASE = import.meta.env.DEV ? 'http://localhost:3000' : ''

interface SharedFileInfo {
  name: string
  size: number
  mimeType: string
  createdAt?: number
}

const getFileIcon = (mimeType: string) => {
  if (mimeType.startsWith('image/')) return <Image className="w-10 h-10" />
  if (mimeType.startsWith('video/')) return <Video className="w-10 h-10" />
  if (mimeType.startsWith('audio/')) return <Music className="w-10 h-10" />
  if (mimeType === 'application/pdf') return <FileText className="w-10 h-10" />
  return <File className="w-10 h-10" />
}

const getFileColor = (mimeType: string) => {
  if (mimeType.startsWith('image/')) return 'from-pink-500 to-rose-600'
  if (mimeType.startsWith('video/')) return 'from-purple-500 to-indigo-600'
  if (mimeType.startsWith('audio/')) return 'from-emerald-500 to-teal-600'
  if (mimeType === 'application/pdf') return 'from-red-500 to-orange-600'
  return 'from-blue-500 to-cyan-600'
}

const formatSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

const getExtension = (name: string) => {
  const parts = name.split('.')
  return parts.length > 1 ? parts.pop()!.toUpperCase() : ''
}

export const SharePage = () => {
  const { linkId } = useParams<{ linkId: string }>()
  const [file, setFile] = useState<SharedFileInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [downloading, setDownloading] = useState(false)

  useEffect(() => {
    if (!linkId) return
    setLoading(true)
    fetch(`${API_BASE}/api/share/${linkId}`)
      .then(res => {
        if (!res.ok) throw new Error('Link not found or expired')
        return res.json()
      })
      .then(data => {
        setFile(data.file)
        setLoading(false)
      })
      .catch(err => {
        setError(err.message)
        setLoading(false)
      })
  }, [linkId])

  const downloadUrl = `${API_BASE}/api/share/${linkId}/download`

  const isImage = file?.mimeType?.startsWith('image/')
  const isVideo = file?.mimeType?.startsWith('video/')
  const isAudio = file?.mimeType?.startsWith('audio/')
  // Only allow preview for files under 50MB
  const canPreview = file && (isImage || isVideo || isAudio) && file.size < 50 * 1024 * 1024

  const handleDownload = () => {
    setDownloading(true)
    // Use an anchor click for download
    const a = document.createElement('a')
    a.href = downloadUrl
    a.download = file?.name || 'download'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    // Reset after a delay
    setTimeout(() => setDownloading(false), 3000)
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-10 h-10 text-white/50 animate-spin" />
          <p className="text-white/40 text-sm">Loading shared file...</p>
        </div>
      </div>
    )
  }

  if (error || !file) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white/5 border border-white/10 rounded-2xl p-8 text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-red-500/10 flex items-center justify-center">
            <AlertCircle className="w-8 h-8 text-red-400" />
          </div>
          <h1 className="text-xl font-semibold text-white mb-2">File Not Found</h1>
          <p className="text-white/50 text-sm">
            This share link has expired, been removed, or never existed.
          </p>
          <a
            href="/"
            className="inline-block mt-6 px-6 py-2.5 bg-white/10 hover:bg-white/15 text-white rounded-xl text-sm transition-colors"
          >
            Go to Cloud Space
          </a>
        </div>
      </div>
    )
  }

  const ext = getExtension(file.name)
  const colorGradient = getFileColor(file.mimeType)

  return (
    <div className="min-h-screen bg-[#0a0a0a] flex flex-col">
      {/* Background gradient decoration */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className={`absolute -top-40 -right-40 w-96 h-96 rounded-full bg-gradient-to-br ${colorGradient} opacity-[0.04] blur-3xl`} />
        <div className={`absolute -bottom-40 -left-40 w-96 h-96 rounded-full bg-gradient-to-tr ${colorGradient} opacity-[0.03] blur-3xl`} />
      </div>

      {/* Header */}
      <header className="relative z-10 border-b border-white/5 bg-black/30 backdrop-blur-xl">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
          <a href="/" className="flex items-center gap-2 text-white hover:opacity-80 transition-opacity">
            <Cloud className="w-5 h-5" />
            <span className="font-semibold text-sm">Cloud Space</span>
          </a>
          <span className="text-xs text-white/30">Shared File</span>
        </div>
      </header>

      {/* Content */}
      <main className="relative z-10 flex-1 flex items-center justify-center p-4 sm:p-8">
        <div className="max-w-lg w-full">
          {/* File card */}
          <div className="bg-white/[0.03] border border-white/[0.08] rounded-2xl overflow-hidden shadow-2xl">
            {/* Preview section */}
            {previewing && canPreview ? (
              <div className="bg-black/50 p-4">
                {isImage && (
                  <img
                    src={downloadUrl}
                    alt={file.name}
                    className="max-w-full max-h-[60vh] mx-auto rounded-lg object-contain"
                  />
                )}
                {isVideo && (
                  <video
                    src={downloadUrl}
                    controls
                    autoPlay
                    className="max-w-full max-h-[60vh] mx-auto rounded-lg"
                  />
                )}
                {isAudio && (
                  <div className="py-8 flex flex-col items-center gap-4">
                    <div className={`w-20 h-20 rounded-2xl bg-gradient-to-br ${colorGradient} flex items-center justify-center text-white`}>
                      <Music className="w-10 h-10" />
                    </div>
                    <audio src={downloadUrl} controls autoPlay className="w-full max-w-sm" />
                  </div>
                )}
              </div>
            ) : null}

            {/* File info */}
            <div className="p-6 sm:p-8">
              <div className="flex items-start gap-4 mb-6">
                {/* File icon */}
                <div className={`flex-shrink-0 w-14 h-14 rounded-xl bg-gradient-to-br ${colorGradient} flex items-center justify-center text-white shadow-lg`}>
                  {getFileIcon(file.mimeType)}
                </div>

                {/* File details */}
                <div className="flex-1 min-w-0">
                  <h1 className="text-white font-semibold text-lg truncate" title={file.name}>
                    {file.name}
                  </h1>
                  <div className="flex items-center gap-3 mt-1">
                    <span className="text-white/40 text-sm">{formatSize(file.size)}</span>
                    {ext && (
                      <span className={`text-xs px-2 py-0.5 rounded-full bg-gradient-to-r ${colorGradient} text-white font-medium`}>
                        {ext}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Action buttons */}
              <div className="flex flex-col gap-3">
                <button
                  onClick={handleDownload}
                  disabled={downloading}
                  className={`w-full py-3.5 px-6 rounded-xl font-medium text-white bg-gradient-to-r ${colorGradient} hover:opacity-90 active:scale-[0.98] transition-all flex items-center justify-center gap-2 shadow-lg disabled:opacity-60`}
                >
                  {downloading ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      Starting download...
                    </>
                  ) : (
                    <>
                      <Download className="w-5 h-5" />
                      Download File
                    </>
                  )}
                </button>

                {canPreview && (
                  <button
                    onClick={() => setPreviewing(!previewing)}
                    className="w-full py-3 px-6 rounded-xl font-medium text-white/70 bg-white/5 hover:bg-white/10 border border-white/10 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
                  >
                    <Eye className="w-5 h-5" />
                    {previewing ? 'Hide Preview' : 'Preview File'}
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Footer note */}
          <p className="text-center text-white/20 text-xs mt-6">
            Shared via Cloud Space — Unlimited cloud storage powered by Telegram
          </p>
        </div>
      </main>
    </div>
  )
}
