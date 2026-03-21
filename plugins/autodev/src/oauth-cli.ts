// src/oauth-cli.ts — CLI entry point for oauth.mjs commands
// Bundled into scripts/oauth.mjs — run with: node scripts/oauth.mjs <command> [args]

import { OAuthEngine } from './oauth/engine.js'

const [,, command, ...args] = process.argv
const engine = new OAuthEngine()

async function main(): Promise<void> {
  let result: unknown

  switch (command) {
    case 'login': {
      const useDevice = args.includes('--device')
      const name = args.filter(a => !a.startsWith('--'))[0] ?? 'default'
      result = useDevice
        ? await engine.loginDeviceCode(name)
        : await engine.loginWithFallback(name)
      break
    }

    case 'logout': {
      if (!args[0]) {
        throw new Error('Can chi dinh ten account. Vi du: oauth logout work')
      }
      const removed = await engine.logout(args[0])
      result = { removed, account: args[0] }
      break
    }

    case 'accounts': {
      result = await engine.listAccounts()
      break
    }

    case 'status': {
      result = await engine.getStatus(args[0])
      break
    }

    case 'default': {
      if (!args[0]) {
        throw new Error('Can chi dinh ten account. Vi du: oauth default work')
      }
      await engine.setDefaultAccount(args[0])
      result = { default_account: args[0] }
      break
    }

    case 'refresh': {
      await engine.getAccessToken(args[0], true)
      result = { message: 'Token da refresh' }
      break
    }

    case 'get-token': {
      const forceRefresh = args.includes('--force-refresh')
      const name = args.filter(a => !a.startsWith('--'))[0]
      const token = await engine.getAccessToken(name, forceRefresh)
      result = { token }
      break
    }

    default:
      throw new Error(
        `Unknown command: ${command ?? '(none)'}. ` +
        `Commands: login, logout, accounts, status, default, refresh, get-token`
      )
  }

  process.stdout.write(JSON.stringify({ ok: true, data: result }))
}

main().catch(err => {
  process.stderr.write(JSON.stringify({ ok: false, error: String(err) }))
  process.exit(1)
})
