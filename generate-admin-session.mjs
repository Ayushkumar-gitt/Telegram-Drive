/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Star Cloud — Admin Session Generator
 * ─────────────────────────────────────────────────────────────────────────────
 *  Run ONCE to generate your ADMIN_SESSION_STRING for .env.local
 *
 *  Usage:
 *    node generate-admin-session.mjs
 *
 *  It will prompt for your Telegram API ID, API Hash, phone number, and OTP.
 *  After success it prints the session string — paste it into .env.local
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import * as readline from 'readline'

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const ask = (q) => new Promise(resolve => rl.question(q, resolve))

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════╗')
  console.log('║   Star Cloud — Admin Session String Generator        ║')
  console.log('╚══════════════════════════════════════════════════════╝\n')
  console.log('Get your API_ID and API_HASH from https://my.telegram.org\n')

  const apiId   = parseInt(await ask('Enter your Telegram API ID:   '), 10)
  const apiHash = (await ask('Enter your Telegram API Hash: ')).trim()
  const phone   = (await ask('Enter your phone number (+91...): ')).trim()

  console.log('\n⏳  Connecting to Telegram...')

  const session = new StringSession('')
  const client  = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
    useWSS: true,
  })

  await client.start({
    phoneNumber:  async () => phone,
    phoneCode:    async () => {
      const code = await ask('\n📱  Enter the OTP sent to your Telegram app: ')
      return code.trim()
    },
    password:     async () => {
      const pw = await ask('🔐  Enter your 2FA password (leave blank if none): ')
      return pw.trim()
    },
    onError: (err) => console.error('Error:', err.message),
  })

  const sessionString = client.session.save()

  console.log('\n✅  Success! Copy the line below into your .env.local file:\n')
  console.log('─'.repeat(60))
  console.log(`ADMIN_SESSION_STRING=${sessionString}`)
  console.log('─'.repeat(60))
  console.log('\nAlso make sure these are set in .env.local:')
  console.log(`ADMIN_API_ID=${apiId}`)
  console.log(`ADMIN_API_HASH=${apiHash}`)
  console.log('\n⚠️  Keep this session string secret — it grants full access to your Telegram account.\n')

  await client.disconnect()
  rl.close()
}

main().catch(err => {
  console.error('\n❌  Failed:', err.message)
  process.exit(1)
})
