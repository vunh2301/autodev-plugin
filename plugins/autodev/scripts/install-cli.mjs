#!/usr/bin/env node
// install-cli.mjs — Install global "autodev-codex" and "autodev-ram" commands
// Usage: node install-cli.mjs

import { writeFileSync, chmodSync } from 'fs'
import { resolve, dirname } from 'path'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Find npm global bin dir
let binDir
try {
  binDir = execSync('npm bin -g', { encoding: 'utf-8' }).trim()
} catch {
  binDir = process.platform === 'win32'
    ? resolve(process.env.APPDATA || '', 'npm')
    : '/usr/local/bin'
}

const commands = [
  { name: 'autodev-codex', script: 'autodev-codex.mjs' },
  { name: 'autodev-ram', script: 'autodev-ram.mjs' },
]

for (const cmd of commands) {
  const scriptPath = resolve(__dirname, cmd.script)
  const binName = process.platform === 'win32' ? `${cmd.name}.cmd` : cmd.name
  const binPath = resolve(binDir, binName)

  if (process.platform === 'win32') {
    writeFileSync(binPath, `@echo off\r\nnode "${scriptPath}" %*\r\n`)
  } else {
    writeFileSync(binPath, `#!/bin/sh\nexec node "${scriptPath}" "$@"\n`)
    chmodSync(binPath, 0o755)
  }

  console.log(`Installed: ${binPath}`)
}

console.log(`
Usage:
  autodev-codex                                    # GPT via Codex OAuth
  autodev-ram --url URL --api-key KEY              # Any provider via API key
  autodev-ram --url URL --api-key KEY --model X    # Smart routing (gpt* = translate, other = direct)
`)
