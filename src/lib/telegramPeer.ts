import { TelegramClient, Api } from 'telegram'
import bigInt from 'big-integer'

const getEntityId = (entity: any): string | undefined => entity?.id?.toString()

const getInputPeerId = (inputPeer: any): string | undefined => (
  inputPeer?.channelId ?? inputPeer?.chatId ?? inputPeer?.userId
)?.toString()

export const createInputPeerChannel = (channelId: string, accessHash: string) =>
  new Api.InputPeerChannel({
    channelId: bigInt(channelId),
    accessHash: bigInt(accessHash),
  })

export const resolveTelegramPeer = async (
  client: TelegramClient,
  channelId: string,
  accessHash?: string | null,
  title?: string
) => {
  if (accessHash) {
    return createInputPeerChannel(channelId, accessHash)
  }

  const dialogs = await client.getDialogs({})
  const dialog = dialogs.find((item) => {
    const entityId = getEntityId(item.entity)
    const inputPeerId = getInputPeerId(item.inputEntity)

    return entityId === channelId || inputPeerId === channelId || (title && item.title === title)
  })

  if (dialog?.inputEntity) {
    return dialog.inputEntity
  }

  throw new Error('Could not resolve Telegram channel. Open the channel in Telegram once, then try again.')
}

