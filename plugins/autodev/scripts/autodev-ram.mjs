#!/usr/bin/env node
// autodev-ram — Launch Claude Code via ramclouds provider
//
// Smart routing:
//   model = gpt*  → proxy translate (Anthropic → OpenAI Chat Completions) → ramclouds
//   model = other → direct passthrough (Anthropic format) → ramclouds
//
// Usage:
//   autodev-ram                                    # start with default config
//   autodev-ram --url https://api.ramclouds.com    # custom endpoint
//   autodev-ram --api-key sk-xxx                   # API key (or set RAMCLOUDS_API_KEY)
//   autodev-ram --model gpt-5.4                    # GPT model (goes through translate)
//   autodev-ram --model claude-sonnet-4            # Claude model (goes direct)
//   autodev-ram -- --plugin-dir ./my-plugin        # pass args to claude

import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2)
function getArg(name, fallback) {
  const i = args.indexOf(name)
  return i !== -1 && i + 1 < args.length ? args[i + 1] : fallback
}

const firstArg = args[0]

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------
if (firstArg === 'help' || firstArg === '--help' || firstArg === '-h') {
  console.log(`
  autodev-ram — Claude Code powered by ramclouds

  Usage:
    autodev-ram                                    Start session
    autodev-ram --url https://api.ramclouds.com    Custom endpoint
    autodev-ram --api-key sk-xxx                   API key
    autodev-ram --model gpt-5.4                    Use GPT (translate mode)
    autodev-ram --model claude-sonnet-4            Use Claude (direct mode)
    autodev-ram -- <claude args>                   Pass args to Claude Code

  Environment variables:
    RAMCLOUDS_API_KEY    API key (alternative to --api-key)
    RAMCLOUDS_URL        Endpoint URL (alternative to --url)

  Routing:
    model starts with "gpt", "o1", "o3", "o4"
      → Proxy translates Anthropic → OpenAI Chat Completions → ramclouds
    model is anything else
      → Proxy passes through Anthropic format directly → ramclouds
`)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PROXY_PORT = getArg('--port', '4142')
const PROXY_URL = `http://localhost:${PROXY_PORT}`
const TARGET_URL = getArg('--url', process.env.RAMCLOUDS_URL || '')
const API_KEY = getArg('--api-key', process.env.RAMCLOUDS_API_KEY || '')
const TARGET_MODEL = getArg('--model', 'gpt-5.4')
const LOG_LEVEL = getArg('--log', 'info')

if (!TARGET_URL) {
  console.error(`
  Error: No endpoint URL provided.

  Set via:
    autodev-ram --url https://api.ramclouds.com/v1/messages
    or: export RAMCLOUDS_URL=https://api.ramclouds.com/v1/messages
`)
  process.exit(1)
}

if (!API_KEY) {
  console.error(`
  Error: No API key provided.

  Set via:
    autodev-ram --api-key sk-xxx
    or: export RAMCLOUDS_API_KEY=sk-xxx
`)
  process.exit(1)
}

// Extract claude args (everything after --)
const dashDashIdx = args.indexOf('--')
const claudeArgs = dashDashIdx !== -1 ? args.slice(dashDashIdx + 1) : []

// ---------------------------------------------------------------------------
// Proxy management
// ---------------------------------------------------------------------------
async function checkProxy() {
  try {
    await fetch(`${PROXY_URL}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(3000),
    })
    return true
  } catch {
    return false
  }
}

function startProxy() {
  const proxyScript = resolve(__dirname, 'proxy.mjs')
  const proxyArgs = [
    '--port', PROXY_PORT,
    '--provider', 'openai-compat',
    '--target-url', TARGET_URL,
    '--api-key', API_KEY,
    '--target-model', TARGET_MODEL,
    '--log', LOG_LEVEL,
  ]

  const child = spawn('node', [proxyScript, ...proxyArgs], {
    stdio: ['ignore', 'pipe', 'inherit'],
    detached: false,
  })
  child.unref()
  return child
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const isGpt = /^(gpt|o[134])/.test(TARGET_MODEL)
  const mode = isGpt ? 'translate' : 'direct'

  let proxyOk = await checkProxy()

  if (!proxyOk) {
    console.log('  Starting proxy...')
    startProxy()

    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500))
      proxyOk = await checkProxy()
      if (proxyOk) break
    }

    if (!proxyOk) {
      console.error(`  Proxy failed to start on ${PROXY_URL}`)
      process.exit(1)
    }
  }

  console.log(`
  autodev-ram
  ─────────────────────────────────
  Proxy:     ${PROXY_URL}
  Endpoint:  ${TARGET_URL}
  Model:     ${TARGET_MODEL}
  Mode:      ${mode} (${isGpt ? 'Anthropic→OpenAI translate' : 'Anthropic direct passthrough'})
  ─────────────────────────────────
`)

  console.log('Launching Claude Code...\n')

  const systemPrompt = isGpt
    ? `[RAMCLOUDS GPT MODE] Running on ramclouds provider. Model: ${TARGET_MODEL}. API calls translated: Anthropic → OpenAI Chat Completions → ${TARGET_URL}. Full tool access.`
    : `[RAMCLOUDS DIRECT MODE] Running on ramclouds provider. Model: ${TARGET_MODEL}. API calls forwarded in Anthropic format to ${TARGET_URL}. Full tool access.`

  const claude = spawn('claude', [
    '--system-prompt', systemPrompt,
    ...claudeArgs,
  ], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: PROXY_URL,
      AUTODEV_PROVIDER: 'ramclouds',
      AUTODEV_PROVIDER_MODE: mode,
    },
  })

  claude.on('exit', (code) => process.exit(code || 0))
  process.on('SIGINT', () => { claude.kill('SIGINT'); setTimeout(() => process.exit(0), 1000) })
  process.on('SIGTERM', () => { claude.kill(); process.exit(0) })
}

main().catch(err => { console.error(err); process.exit(1) })
