#!/usr/bin/env node
// autodev-codex — Launch Claude Code with GPT/Codex as backend
//
// Usage:
//   autodev-codex                              # start full GPT session
//   autodev-codex auth login [account]         # login OpenAI
//   autodev-codex auth login --device [account] # login (headless)
//   autodev-codex auth status [account]        # check token status
//   autodev-codex auth logout <account>        # logout
//   autodev-codex auth accounts                # list accounts
//   autodev-codex --model gpt-5.4             # custom model
//   autodev-codex -- --plugin-dir ./my-plugin  # pass args to claude

import { spawn, execSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const oauthScript = resolve(__dirname, 'oauth.mjs')
const proxyScript = resolve(__dirname, 'proxy.mjs')

// ---------------------------------------------------------------------------
// Subcommand: auth
// ---------------------------------------------------------------------------
const firstArg = process.argv[2]

if (firstArg === 'auth') {
  // Forward to oauth.mjs: autodev-codex auth login → node oauth.mjs login
  const oauthArgs = process.argv.slice(3) // everything after "auth"
  if (oauthArgs.length === 0) {
    console.log(`
  autodev-codex auth — Manage OpenAI OAuth

  Commands:
    autodev-codex auth login [account]           Login (PKCE, auto-fallback Device Code)
    autodev-codex auth login --device [account]  Login (force Device Code)
    autodev-codex auth logout <account>          Remove account
    autodev-codex auth status [account]          Check token validity
    autodev-codex auth accounts                  List all accounts
    autodev-codex auth default <account>         Set default account
    autodev-codex auth refresh [account]         Force token refresh
`)
    process.exit(0)
  }

  try {
    const result = execSync(`node "${oauthScript}" ${oauthArgs.join(' ')}`, {
      encoding: 'utf-8',
      stdio: ['inherit', 'pipe', 'inherit'],
      timeout: 300000, // 5 min for login
    })
    // Pretty-print JSON output
    try {
      const parsed = JSON.parse(result.trim())
      if (parsed.ok) {
        console.log(JSON.stringify(parsed.data, null, 2))
      } else {
        console.error('Error:', parsed.error)
        process.exit(1)
      }
    } catch {
      process.stdout.write(result)
    }
  } catch (err) {
    if (err.stderr) process.stderr.write(err.stderr)
    process.exit(err.status || 1)
  }
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Subcommand: help
// ---------------------------------------------------------------------------
if (firstArg === 'help' || firstArg === '--help' || firstArg === '-h') {
  console.log(`
  autodev-codex — Claude Code powered by GPT/Codex

  Usage:
    autodev-codex                         Start full GPT session
    autodev-codex auth <command>          Manage OpenAI OAuth
    autodev-codex --model <name>          Custom model (default: gpt-5.4)
    autodev-codex --exec-model <name>     Model for implementing (default: gpt-5.3-codex)
    autodev-codex --port <N>              Proxy port (default: 4141)
    autodev-codex -- <claude args>        Pass args to Claude Code

  First time? Run:
    autodev-codex auth login
`)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Main: start proxy + claude
// ---------------------------------------------------------------------------
const args = process.argv.slice(2)
function getArg(name, fallback) {
  const i = args.indexOf(name)
  return i !== -1 && i + 1 < args.length ? args[i + 1] : fallback
}

const PORT = getArg('--port', '4141')
const MODEL = getArg('--model', 'gpt-5.4')
const EXEC_MODEL = getArg('--exec-model', 'gpt-5.3-codex')
const ACCOUNT = getArg('--account', 'default')

// Extract claude args (everything after --)
const dashDashIdx = args.indexOf('--')
const claudeArgs = dashDashIdx !== -1 ? args.slice(dashDashIdx + 1) : []

// Check auth first
try {
  const statusOut = execSync(`node "${oauthScript}" status ${ACCOUNT}`, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 5000,
  })
  const status = JSON.parse(statusOut.trim())
  if (!status.ok) {
    console.error(`No OAuth credentials. Run:\n  autodev-codex auth login\n`)
    process.exit(1)
  }
  if (status.data && !status.data.token_valid) {
    console.error(`Token expired. Run:\n  autodev-codex auth login\n`)
    process.exit(1)
  }
} catch {
  // Check OPENAI_API_KEY fallback
  if (!process.env.OPENAI_API_KEY) {
    console.error(`No credentials found. Run:\n  autodev-codex auth login\n\nOr set OPENAI_API_KEY environment variable.\n`)
    process.exit(1)
  }
}

console.log(`
  autodev-codex
  ─────────────────────────────────
  Proxy:    localhost:${PORT}
  Execute:  ${EXEC_MODEL}
  General:  ${MODEL}
  Account:  ${ACCOUNT}
  ─────────────────────────────────
`)

// 1. Start proxy
console.log('Starting proxy...')
const proxy = spawn('node', [
  proxyScript,
  '--port', PORT,
  '--target-model', MODEL,
  '--exec-model', EXEC_MODEL,
  '--account', ACCOUNT,
  '--log', 'quiet',
], {
  stdio: ['ignore', 'pipe', 'pipe'],
})

proxy.stderr.on('data', (d) => {
  const msg = d.toString().trim()
  if (msg) console.error(`[proxy] ${msg}`)
})

// 2. Wait for proxy to be ready
async function waitForProxy(maxRetries = 20) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await fetch(`http://localhost:${PORT}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      return true
    } catch {
      await new Promise(r => setTimeout(r, 300))
    }
  }
  return false
}

// 3. Launch Claude Code
async function main() {
  const ready = await waitForProxy()
  if (!ready) {
    console.error('Proxy failed to start.')
    proxy.kill()
    process.exit(1)
  }

  console.log('Proxy ready. Launching Claude Code...\n')

  const allClaudeArgs = [
    '--system-prompt', `[CODEX MODE] You are running on OpenAI Codex (${EXEC_MODEL} for code, ${MODEL} for general) via autodev-codex proxy. All your API calls go through localhost:${PORT} → chatgpt.com/backend-api/codex/responses. Mention this when asked what model you are.`,
    ...claudeArgs,
  ]

  const claude = spawn('claude', allClaudeArgs, {
    stdio: 'inherit',
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://localhost:${PORT}`,
      CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
      AUTODEV_PROVIDER: 'codex',
      AUTODEV_CODEX_MODEL: MODEL,
      AUTODEV_CODEX_EXEC_MODEL: EXEC_MODEL,
    },
  })

  claude.on('exit', (code) => {
    proxy.kill()
    process.exit(code || 0)
  })

  process.on('SIGINT', () => {
    claude.kill('SIGINT')
    setTimeout(() => { proxy.kill(); process.exit(0) }, 1000)
  })

  process.on('SIGTERM', () => {
    claude.kill(); proxy.kill(); process.exit(0)
  })
}

main().catch(err => {
  console.error('Fatal:', err.message)
  proxy.kill()
  process.exit(1)
})
