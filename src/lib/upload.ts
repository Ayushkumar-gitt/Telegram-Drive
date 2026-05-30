import { TelegramClient } from 'telegram'
import { Api } from 'telegram'
import { v4 as uuidv4 } from 'uuid'
import { type TGFile } from '../store/filesystem'
// Import Buffer from the 'buffer' package explicitly.
// vite-plugin-node-polyfills redirects this to the SAME polyfill that
// GramJS's `require('buffer')` resolves to in the bundled output.
// This ensures `data instanceof Buffer` in GramJS's serializeBytes()
// (generationHelpers.js:242) passes correctly.
import { Buffer } from 'buffer'

// Also ensure globalThis.Buffer is set — GramJS's CJS code accesses
// Buffer as a global (not via import). If the polyfill's globals injection
// didn't work, this guarantees it.
if (typeof globalThis !== 'undefined' && !(globalThis as unknown as Record<string, unknown>).Buffer) {
  (globalThis as unknown as Record<string, unknown>).Buffer = Buffer
}

/**
 * Telegram allows up to 2GB per file via the Bot/User API.
 * We split into app-level chunks of 2GB (the Telegram max) for our own
 * chunked-file metadata. Files under this size go as a single upload.
 */
const APP_CHUNK_SIZE = 2000 * 1024 * 1024 // ~2 GB per Telegram message

/**
 * NOTE: We do NOT use GramJS's built-in sendFile() at all.
 * GramJS's _fileToMedia() rejects browser File objects — it checks
 * `typeof file == "object"` and tries to cast them as Telegram API
 * media objects, which fails. And even if we used CustomFile, its
 * getFileBuffer() tries to read the entire file into a polyfilled
 * Node Buffer, which fails in the browser for files above ~20 MB.
 *
 * Instead, we implement the upload protocol ourselves:
 *   1. file.slice() to read small chunks on demand
 *   2. Api.upload.SaveBigFilePart / SaveFilePart
 *   3. Api.messages.SendMedia with InputMediaUploadedDocument
 */

/**
 * Returns the appropriate part size in bytes for uploading, matching
 * the Telegram API requirements. Part sizes must be one of:
 *   512 bytes ... 512 KB (powers of 2).
 * Telegram also enforces max 4000 parts for normal files and 8000
 * for "big" files (>10MB).
 */
function getPartSizeBytes(fileSize: number): number {
  if (fileSize < 100 * 1024 * 1024) return 128 * 1024       // 128 KB
  if (fileSize < 750 * 1024 * 1024) return 256 * 1024       // 256 KB
  return 512 * 1024                                          // 512 KB
}

/**
 * Read a slice of a browser File as a Buffer.
 * Uses file.slice() + blob.arrayBuffer() so we never load the whole file.
 * Returns the polyfilled Buffer (same class GramJS uses) so instanceof checks pass.
 */
async function readFileSlice(file: File, start: number, end: number): Promise<Buffer> {
  const blob = file.slice(start, end)
  const ab = await blob.arrayBuffer()
  return Buffer.from(ab)
}

/**
 * Upload a browser File directly to Telegram using the raw MTProto upload
 * API.  This bypasses GramJS's broken `getFileBuffer` / `CustomBuffer` path
 * which fails for files >20 MB in the browser.
 *
 * Returns an InputFileBig or InputFile that can be used with SendMedia.
 */
async function directUploadFile(
  client: TelegramClient,
  file: File,
  onProgress?: (progress: number) => void,
  workers: number = 4
): Promise<Api.InputFile | Api.InputFileBig> {
  const fileSize = file.size
  const isLarge = fileSize > 10 * 1024 * 1024
  const partSize = getPartSizeBytes(fileSize)
  const partCount = Math.ceil(fileSize / partSize)

  // Generate a random file ID (64-bit)
  const { readBigIntFromBuffer, generateRandomBytes } = await import('telegram/Helpers')
  const fileId = readBigIntFromBuffer(generateRandomBytes(8), true, true)

  // Ensure a sender is available
  await client.getSender(client.session.dcId)

  if (workers > partCount) {
    workers = partCount
  }
  if (workers < 1) {
    workers = 1
  }

  let completedParts = 0

  for (let i = 0; i < partCount; i += workers) {
    const batch: Promise<void>[] = []
    let batchEnd = Math.min(i + workers, partCount)

    for (let j = i; j < batchEnd; j++) {
      const start = j * partSize
      const end = Math.min(start + partSize, fileSize)
      if (end <= start) break

      const bytes = await readFileSlice(file, start, end)

      batch.push(
        (async (partIndex: number, partBytes: Uint8Array) => {
          // Retry loop for transient failures
          while (true) {
            let sender
            try {
              sender = await client.getSender(client.session.dcId)
              const request = isLarge
                ? new Api.upload.SaveBigFilePart({
                  fileId,
                  filePart: partIndex,
                  fileTotalParts: partCount,
                  bytes: partBytes,
                })
                : new Api.upload.SaveFilePart({
                  fileId,
                  filePart: partIndex,
                  bytes: partBytes,
                })
              await sender.send(request)
            } catch (err: any) {
              if (sender && !sender.isConnected()) {
                await new Promise(r => setTimeout(r, 1000))
                continue
              }
              if (err?.seconds) {
                // FloodWaitError
                await new Promise(r => setTimeout(r, err.seconds * 1000))
                continue
              }
              throw err
            }
            completedParts++
            if (onProgress) {
              onProgress(completedParts / partCount)
            }
            break
          }
        })(j, bytes)
      )
    }

    await Promise.all(batch)
  }

  if (isLarge) {
    return new Api.InputFileBig({
      id: fileId,
      parts: partCount,
      name: file.name,
    })
  } else {
    return new Api.InputFile({
      id: fileId,
      parts: partCount,
      name: file.name,
      md5Checksum: '',
    })
  }
}

/**
 * Upload a file to Telegram and return the metadata.
 *
 * We bypass GramJS's sendFile / _fileToMedia / uploadFile entirely because:
 *   1. _fileToMedia rejects browser File objects (tries getInputMedia → fails)
 *   2. Even with CustomFile, getFileBuffer reads the entire file into a
 *      polyfilled Node Buffer which breaks for large files in the browser.
 *
 * Instead we implement the upload protocol directly:
 *   - Read small slices from the browser File on-demand (file.slice)
 *   - Upload parts via Api.upload.SaveBigFilePart / SaveFilePart
 *   - Send via Api.messages.SendMedia with InputMediaUploadedDocument
 */
export const uploadFileToTelegram = async (
  client: TelegramClient,
  file: File,
  folderId: string | null,
  channelId: string,
  accessHash: string | null,
  onProgress?: (progress: number) => void
): Promise<TGFile> => {

  const uploadId = uuidv4()

  try {
    // Build the peer for the target channel
    let peer: any = Number(channelId)
    if (accessHash) {
      const BigIntConstructor = (window as any).BigInt || globalThis.BigInt || Number
      peer = new Api.InputPeerChannel({
        channelId: BigIntConstructor(channelId.replace('-100', '')) as any,
        accessHash: BigIntConstructor(accessHash) as any
      })
    }

    if (file.size <= APP_CHUNK_SIZE) {
      // ── Single file upload (up to ~2 GB) ────────────────────────────────
      const inputFile = await directUploadFile(
        client,
        file,
        (progress) => {
          if (onProgress) onProgress(progress * 100)
        },
        4
      )

      // Determine MIME type
      const mimeType = file.type || 'application/octet-stream'

      // Build attributes
      const attributes = [
        new Api.DocumentAttributeFilename({ fileName: file.name })
      ]

      // Send the uploaded file as a message
      const result = await client.invoke(
        new Api.messages.SendMedia({
          peer: peer,
          media: new Api.InputMediaUploadedDocument({
            file: inputFile,
            mimeType: mimeType,
            attributes: attributes,
            forceFile: true,
          }),
          message: file.name,
          randomId: BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)) as any,
        })
      )

      // Extract the message ID from the result
      const messageId = extractMessageId(result)

      return {
        id: uploadId,
        name: file.name,
        size: file.size,
        mimeType: mimeType,
        createdAt: Date.now(),
        folderId,
        messageId,
        channelId: channelId,
        accessHash: accessHash || undefined,
        isChunked: false
      }
    } else {
      // ── App-level chunked upload (files > 2 GB) ─────────────────────────
      const totalChunks = Math.ceil(file.size / APP_CHUNK_SIZE)
      const chunkMessageIds: number[] = []

      for (let i = 0; i < totalChunks; i++) {
        const start = i * APP_CHUNK_SIZE
        const end = Math.min(start + APP_CHUNK_SIZE, file.size)
        const chunkBlob = file.slice(start, end)
        const chunkFile = new File([chunkBlob], `${file.name}.part${i + 1}`, {
          type: file.type || 'application/octet-stream'
        })

        // Each chunk is uploaded using our direct upload
        const inputFile = await directUploadFile(
          client,
          chunkFile,
          (progress) => {
            if (onProgress) {
              const overallProgress = ((i + progress) / totalChunks) * 100
              onProgress(overallProgress)
            }
          },
          4
        )

        const mimeType = file.type || 'application/octet-stream'
        const attributes = [
          new Api.DocumentAttributeFilename({
            fileName: `${file.name}.part${i + 1}`
          })
        ]

        const result = await client.invoke(
          new Api.messages.SendMedia({
            peer: peer,
            media: new Api.InputMediaUploadedDocument({
              file: inputFile,
              mimeType: mimeType,
              attributes: attributes,
              forceFile: true,
            }),
            message: `${file.name} (Part ${i + 1}/${totalChunks})`,
            randomId: BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)) as any,
          })
        )

        chunkMessageIds.push(extractMessageId(result))
      }

      return {
        id: uploadId,
        name: file.name,
        size: file.size,
        mimeType: file.type || 'application/octet-stream',
        createdAt: Date.now(),
        folderId,
        messageId: chunkMessageIds[0],
        channelId: channelId,
        accessHash: accessHash || undefined,
        isChunked: true,
        chunkMessageIds: chunkMessageIds
      }
    }
  } catch (error) {
    console.error('Upload failed', error)
    throw error
  }
}

/**
 * Extract the message ID from a Telegram API result (Updates object).
 */
function extractMessageId(result: any): number {
  // The result from SendMedia is usually an Updates object
  if (result.updates) {
    for (const update of result.updates) {
      if (update.className === 'UpdateMessageID' || update.id !== undefined) {
        // Prefer UpdateNewChannelMessage which has the final message
        if (update.message && update.message.id) {
          return update.message.id
        }
      }
    }
    // Fallback: look for UpdateNewChannelMessage or UpdateNewMessage
    for (const update of result.updates) {
      if (update.message && update.message.id) {
        return update.message.id
      }
    }
  }

  // Direct message result
  if (result.id) {
    return result.id
  }

  // Last resort: try to find any numeric id
  throw new Error('Could not extract message ID from upload result')
}
