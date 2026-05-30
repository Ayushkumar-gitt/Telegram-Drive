import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'

let client: TelegramClient | null = null
let connectionPromise: Promise<any> | null = null

/** Call this on logout or before creating a new session so the singleton is recreated fresh */
export const resetClient = () => {
  if (client) {
    client.disconnect().catch(() => {})
    client = null
  }
  connectionPromise = null
}

export const getTelegramClient = async (
  sessionString: string,
  apiId: number,
  apiHash: string
): Promise<TelegramClient> => {
  if (!client) {
    const session = new StringSession(sessionString)
    client = new TelegramClient(session, apiId, apiHash, {
      connectionRetries: 5,
      useWSS: true,
    })
  }

  if (!client.connected) {
    if (!connectionPromise) {
      connectionPromise = client.connect().catch(e => {
        connectionPromise = null
        throw e
      })
    }
    await connectionPromise
  }
  return client
}

export const initTelegramClient = async (
  apiId: number,
  apiHash: string,
  phoneNumber: string,
  phoneCodeCallback: () => Promise<string>,
  passwordCallback?: () => Promise<string>
): Promise<string> => {
  const session = new StringSession('')
  client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
    useWSS: true,
  })

  try {
    await client.start({
      phoneNumber: async () => phoneNumber,
      password: passwordCallback ? async () => await passwordCallback() : undefined,
      phoneCode: async () => await phoneCodeCallback(),
      onError: (err) => console.log(err),
    })
  } catch (err: any) {
    // FloodWaitError — Telegram rate-limited this phone number
    const seconds: number =
      err?.seconds ??
      (typeof err?.message === 'string'
        ? parseInt(err.message.match(/(\d+)/)?.[1] ?? '0', 10)
        : 0)

    if (err?.className === 'FloodWaitError' || err?.message?.includes('FLOOD_WAIT') || seconds > 0) {
      const hrs = Math.floor(seconds / 3600)
      const mins = Math.floor((seconds % 3600) / 60)
      const secs = seconds % 60
      const parts = []
      if (hrs > 0) parts.push(`${hrs}h`)
      if (mins > 0) parts.push(`${mins}m`)
      if (secs > 0 || parts.length === 0) parts.push(`${secs}s`)
      throw new Error(
        `Telegram rate limit hit. Too many OTP requests were sent.\n` +
        `Please wait ${parts.join(' ')} before trying again.`
      )
    }
    throw err
  }

  return client.session.save() as unknown as string
}


export const disconnectClient = async () => {
  if (client) {
    await client.disconnect()
    client = null
  }
}
