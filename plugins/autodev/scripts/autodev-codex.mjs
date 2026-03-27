#!/usr/bin/env node
// autodev-codex — Launch Claude Code via aiproxy (Codex backend)
//
// Requires: aiproxy running (turbo-proxy / cli-ai-proxy-min)
//
// Usage:
//   autodev-codex                              # start (aiproxy on localhost:2300)
//   autodev-codex --proxy http://localhost:2300 # custom aiproxy URL
//   autodev-codex auth login [account]         # login OpenAI (via oauth.mjs)
//   autodev-codex auth status [account]        # check token status
//   autodev-codex auth accounts                # list accounts
//   autodev-codex -- --plugin-dir ./my-plugin  # pass args to claude

import { spawn, execSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const oauthScript = resolve(__dirname, 'oauth.mjs')

// ---------------------------------------------------------------------------
// Subcommand: auth
// ---------------------------------------------------------------------------
const firstArg = process.argv[2]

if (firstArg === 'auth') {
  const oauthArgs = process.argv.slice(3)
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
      timeout: 300000,
    })
    try {
      const parsed = JSON.parse(result.trim())
      if (parsed.ok) console.log(JSON.stringify(parsed.data, null, 2))
      else { console.error('Error:', parsed.error); process.exit(1) }
    } catch { process.stdout.write(result) }
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
  autodev-codex — Claude Code powered by GPT/Codex via aiproxy

  Prerequisites:
    1. aiproxy (turbo-proxy) running on localhost:2300
    2. Codex provider configured in aiproxy config.yaml

  Usage:
    autodev-codex                             Start Codex session
    autodev-codex --proxy http://host:port    Custom aiproxy URL
    autodev-codex auth <command>              Manage OpenAI OAuth
    autodev-codex -- <claude args>            Pass args to Claude Code

  First time?
    1. Start aiproxy
    2. autodev-codex auth login
    3. autodev-codex
`)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Main: connect to aiproxy + launch claude
// ---------------------------------------------------------------------------
const args = process.argv.slice(2)
function getArg(name, fallback) {
  const i = args.indexOf(name)
  return i !== -1 && i + 1 < args.length ? args[i + 1] : fallback
}

const PROXY_PORT = getArg('--port', '4141')
const PROXY_URL = getArg('--proxy', `http://localhost:${PROXY_PORT}`)

// Extract claude args (everything after --)
const dashDashIdx = args.indexOf('--')
const claudeArgs = dashDashIdx !== -1 ? args.slice(dashDashIdx + 1) : []

// Check if proxy is already running
async function checkProxy() {
  try {
    const resp = await fetch(`${PROXY_URL}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(3000),
    })
    // Any response (even 400/404) means proxy is running
    return true
  } catch {
    return false
  }
}

// Start proxy.mjs as a background process
function startProxy() {
  const proxyScript = resolve(__dirname, 'proxy.mjs')
  const proxyArgs = ['--port', PROXY_PORT]

  // Forward --target-model, --exec-model, --account, --target-url, --log if provided
  for (const flag of ['--target-model', '--exec-model', '--account', '--target-url', '--log']) {
    const val = getArg(flag, null)
    if (val) proxyArgs.push(flag, val)
  }

  const child = spawn('node', [proxyScript, ...proxyArgs], {
    stdio: ['ignore', 'pipe', 'ignore'],
    detached: false,
  })

  child.unref()
  return child
}

async function main() {
  let proxyOk = await checkProxy()
  let proxyChild = null

  if (!proxyOk) {
    console.log('  Starting proxy...')
    proxyChild = startProxy()

    // Wait for proxy to be ready (up to 10s)
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500))
      proxyOk = await checkProxy()
      if (proxyOk) break
    }

    if (!proxyOk) {
      console.error(`
  Proxy failed to start on ${PROXY_URL}
  Check: node ${resolve(__dirname, 'proxy.mjs')} --port ${PROXY_PORT}
`)
      process.exit(1)
    }
  }

  console.log(`
  autodev-codex
  ─────────────────────────────────
  Proxy:    ${PROXY_URL} (built-in)
  Mode:     Full Codex via proxy
  ─────────────────────────────────
`)

  console.log('Launching Claude Code...\n')

  const allClaudeArgs = [
    '--system-prompt', `[CODEX MODE] You are running on OpenAI Codex via proxy (${PROXY_URL}). All API calls are translated: Anthropic Messages → OpenAI Responses API → Codex. You have full tool access. Mention this when asked what model you are.`,
    ...claudeArgs,
  ]

  const claude = spawn('claude', allClaudeArgs, {
    stdio: 'inherit',
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: PROXY_URL,
      CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
      AUTODEV_PROVIDER: 'codex',
    },
  })

  claude.on('exit', (code) => {
    process.exit(code || 0)
  })

  process.on('SIGINT', () => {
    claude.kill('SIGINT')
    setTimeout(() => process.exit(0), 1000)
  })

  process.on('SIGTERM', () => {
    claude.kill()
    process.exit(0)
  })
}

main().catch(err => {
  console.error('Fatal:', err.message)
  process.exit(1)
})
