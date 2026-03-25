#!/usr/bin/env node
// dashboard.mjs — Autodev workflow dashboard server
// Run: node scripts/dashboard.mjs [--port 3456] [--dir .workflow]

import { createServer } from 'node:http'
import { readFileSync, existsSync, readdirSync, statSync, watch } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

// Parse args
const args = process.argv.slice(2)
function getArg(name, fallback) {
  const i = args.indexOf(name)
  return i !== -1 && i + 1 < args.length ? args[i + 1] : fallback
}
const port = parseInt(getArg('--port', '3456'))
const workflowDir = resolve(getArg('--dir', '.workflow'))

// SSE clients
const sseClients = new Set()

// Watch .workflow/ for changes → push SSE
if (existsSync(workflowDir)) {
  try {
    watch(workflowDir, { recursive: true }, () => {
      for (const res of sseClients) {
        try { res.write(`data: refresh\n\n`) } catch { sseClients.delete(res) }
      }
    })
  } catch { /* recursive watch not supported on all platforms */ }
}

function readJSON(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch { return null }
}

function getWorkflowData() {
  const registry = readJSON(join(workflowDir, 'registry.json'))
  if (!registry) return { registry: null, workflows: [] }

  const workflows = (registry.active_workflows || []).map(wf => {
    const stateFile = join(workflowDir, wf.wf_id || wf.workflow_id, 'state.json')
    const state = readJSON(stateFile)
    return { ...wf, state }
  })

  return { registry, workflows }
}

function getReactionsConfig() {
  const paths = [
    join(workflowDir, 'reactions.yaml'),
    join(workflowDir, 'reactions.yml'),
  ]
  for (const p of paths) {
    if (existsSync(p)) return readFileSync(p, 'utf-8')
  }
  return null
}

// Serve
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`)

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  // Routes
  if (url.pathname === '/api/data') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(getWorkflowData()))
    return
  }

  if (url.pathname === '/api/config') {
    const config = getReactionsConfig()
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(config || '# No config found')
    return
  }

  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })
    res.write(`data: connected\n\n`)
    sseClients.add(res)
    req.on('close', () => sseClients.delete(res))
    return
  }

  // Dashboard HTML
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const htmlPath = join(__dirname, '..', 'templates', 'dashboard.html')
    if (existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(readFileSync(htmlPath, 'utf-8'))
    } else {
      res.writeHead(404)
      res.end('dashboard.html not found')
    }
    return
  }

  res.writeHead(404)
  res.end('Not Found')
})

server.listen(port, '127.0.0.1', () => {
  console.log(`\n  Autodev Dashboard: http://localhost:${port}`)
  console.log(`  Watching: ${workflowDir}`)
  console.log(`  Press Ctrl+C to stop\n`)
})
