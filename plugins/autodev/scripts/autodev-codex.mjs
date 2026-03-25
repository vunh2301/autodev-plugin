#!/usr/bin/env node
// autodev-codex — Launch Claude Code with GPT/Codex as backend
// Usage: node autodev-codex.mjs [--port 4141] [--model gpt-5.4] [-- claude args...]
//
// What it does:
//   1. Starts proxy server (Claude API → OpenAI API translation)
//   2. Waits for proxy to be ready
//   3. Launches Claude Code with ANTHROPIC_BASE_URL pointing to proxy
//   4. When Claude Code exits, stops proxy

import { spawn, execSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Parse args
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

const proxyScript = resolve(__dirname, 'proxy.mjs')

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
      const resp = await fetch(`http://localhost:${PORT}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      // Any response (even 400) means proxy is up
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
    console.error('Proxy failed to start. Check OAuth: /autodev-auth codex login')
    proxy.kill()
    process.exit(1)
  }

  console.log('Proxy ready. Launching Claude Code...\n')

  const claude = spawn('claude', claudeArgs, {
    stdio: 'inherit',
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://localhost:${PORT}`,
      ANTHROPIC_API_KEY: 'proxy',
    },
  })

  claude.on('exit', (code) => {
    proxy.kill()
    process.exit(code || 0)
  })

  // Handle Ctrl+C
  process.on('SIGINT', () => {
    claude.kill('SIGINT')
    setTimeout(() => {
      proxy.kill()
      process.exit(0)
    }, 1000)
  })

  process.on('SIGTERM', () => {
    claude.kill()
    proxy.kill()
    process.exit(0)
  })
}

main().catch(err => {
  console.error('Fatal:', err.message)
  proxy.kill()
  process.exit(1)
})
