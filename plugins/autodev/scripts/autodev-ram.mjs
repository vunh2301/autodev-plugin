#!/usr/bin/env node
// autodev-ram — Launch Claude Code via any OpenAI-compatible provider
//
// Smart routing:
//   model = gpt*  → proxy translate (Anthropic → OpenAI Chat Completions)
//   model = other → direct passthrough (Anthropic format)
//
// Usage:
//   autodev-ram auth                              # setup API key + URL (saved)
//   autodev-ram                                   # start (default: gpt-5.4)
//   autodev-ram --model claude-opus-4             # use Claude model (direct)
//   autodev-ram -- --plugin-dir ./my-plugin       # pass args to claude

import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createInterface } from 'node:readline'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Config file: ~/.config/autodev/ram.json
// ---------------------------------------------------------------------------
const configDir = process.platform === 'win32'
  ? resolve(process.env.APPDATA || '', 'autodev')
  : resolve(process.env.HOME || '', '.config', 'autodev')
const configPath = resolve(configDir, 'ram.json')

function loadConfig() {
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'))
  } catch {
    return {}
  }
}

function saveConfig(cfg) {
  mkdirSync(configDir, { recursive: true })
  writeFileSync(configPath, JSON.stringify(cfg, null, 2))
}

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()) }))
}

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
// Subcommand: auth
// ---------------------------------------------------------------------------
if (firstArg === 'auth') {
  const cfg = loadConfig()

  console.log('\n  autodev-ram auth — Setup provider credentials\n')

  if (cfg.url) console.log(`  Current URL:  ${cfg.url}`)
  if (cfg.api_key) console.log(`  Current Key:  ${cfg.api_key.slice(0, 8)}...${cfg.api_key.slice(-4)}`)
  if (cfg.model) console.log(`  Current Model: ${cfg.model}`)
  console.log()

  const url = await ask('  API URL (enter to keep current): ')
  const key = await ask('  API Key (enter to keep current): ')
  const model = await ask('  Default model [gpt-5.4] (enter to keep current): ')

  if (url) cfg.url = url
  if (key) cfg.api_key = key
  if (model) cfg.model = model

  saveConfig(cfg)
  console.log(`\n  Saved to ${configPath}`)
  console.log('  Run "autodev-ram" to start.\n')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------
if (firstArg === 'help' || firstArg === '--help' || firstArg === '-h') {
  console.log(`
  autodev-ram — Claude Code powered by any provider

  Setup:
    autodev-ram auth                   Setup API key + URL (one-time, saved)

  Usage:
    autodev-ram                        Start session (default: gpt-5.4)
    autodev-ram --model claude-opus-4  Use specific model
    autodev-ram -- <claude args>       Pass args to Claude Code

  Routing (automatic):
    gpt* / o1* / o3* / o4*  → translate (Anthropic → OpenAI format)
    anything else            → direct passthrough (Anthropic format)

  Config: ${configPath}
`)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Resolve config: args > env > saved config
// ---------------------------------------------------------------------------
const cfg = loadConfig()
const PROXY_PORT = getArg('--port', '4142')
const PROXY_URL = `http://localhost:${PROXY_PORT}`
const TARGET_URL = getArg('--url', process.env.RAMCLOUDS_URL || cfg.url || '')
const API_KEY = getArg('--api-key', process.env.RAMCLOUDS_API_KEY || cfg.api_key || '')
const TARGET_MODEL = getArg('--model', cfg.model || 'gpt-5.4')
const LOG_LEVEL = getArg('--log', 'info')

if (!TARGET_URL || !API_KEY) {
  console.error(`
  Not configured. Run first:

    autodev-ram auth
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
  Mode:      ${mode}
  ─────────────────────────────────
`)

  console.log('Launching Claude Code...\n')

  const claude = spawn('claude', [
    '--system-prompt', `[RAM MODE] Provider: ramclouds | Model: ${TARGET_MODEL} | Mode: ${mode}. Full tool access.`,
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
