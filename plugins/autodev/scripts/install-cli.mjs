#!/usr/bin/env node
// install-cli.mjs — Install global "autodev-codex" command
// Usage: node install-cli.mjs

import { writeFileSync, chmodSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const scriptPath = resolve(__dirname, 'autodev-codex.mjs')

// Find npm global bin dir
let binDir
try {
  binDir = execSync('npm bin -g', { encoding: 'utf-8' }).trim()
} catch {
  binDir = process.platform === 'win32'
    ? resolve(process.env.APPDATA || '', 'npm')
    : '/usr/local/bin'
}

const binName = process.platform === 'win32' ? 'autodev-codex.cmd' : 'autodev-codex'
const binPath = resolve(binDir, binName)

if (process.platform === 'win32') {
  writeFileSync(binPath, `@echo off\r\nnode "${scriptPath}" %*\r\n`)
} else {
  writeFileSync(binPath, `#!/bin/sh\nexec node "${scriptPath}" "$@"\n`)
  chmodSync(binPath, 0o755)
}

console.log(`Installed: ${binPath}`)
console.log(`\nUsage:\n  autodev-codex                    # full GPT session\n  autodev-codex --model gpt-5.4    # custom model\n`)
