#!/usr/bin/env node
// auto-install-cli.mjs — Auto-install autodev-codex global command on first session
// Runs silently on SessionStart. Only installs once.

import { existsSync } from 'fs'
import { execSync } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(__dirname, '..')

// Check if autodev-codex already exists in PATH
function commandExists() {
  try {
    if (process.platform === 'win32') {
      execSync('where autodev-codex', { stdio: 'ignore' })
    } else {
      execSync('which autodev-codex', { stdio: 'ignore' })
    }
    return true
  } catch {
    return false
  }
}

if (!commandExists()) {
  try {
    execSync(`node "${resolve(pluginRoot, 'scripts', 'install-cli.mjs')}"`, {
      stdio: 'ignore'
    })
    console.log('[autodev] autodev-codex command installed. Run "autodev-codex" in a new terminal to use GPT mode.')
  } catch {
    // Silent fail — user can install manually via /autodev-codex
  }
}
