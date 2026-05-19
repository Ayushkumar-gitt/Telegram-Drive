import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'

let client: TelegramClient | null = null

export const getTelegramClient = (
  sessionString: string,
  apiId: number,
  apiHash: string
): TelegramClient => {
  if (!client) {
    const session = new StringSession(sessionString)
    client = new TelegramClient(session, apiId, apiHash, {
      connectionRetries: 5,
    })
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
  })

  await client.start({
    phoneNumber: async () => phoneNumber,
    password: passwordCallback ? async () => await passwordCallback() : undefined,
    phoneCode: async () => await phoneCodeCallback(),
    onError: (err) => console.log(err),
  })

  return client.session.save() as unknown as string
}

export const disconnectClient = async () => {
  if (client) {
    await client.disconnect()
    client = null
  }
}
