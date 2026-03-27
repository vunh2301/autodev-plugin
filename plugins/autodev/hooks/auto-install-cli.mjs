#!/usr/bin/env node
// auto-install-cli.mjs — Auto-install autodev-codex + autodev-ram on first session
// Runs silently on SessionStart. Only installs once.

import { execSync } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(__dirname, '..')

function commandExists(name) {
  try {
    if (process.platform === 'win32') {
      execSync(`where ${name}`, { stdio: 'ignore' })
    } else {
      execSync(`which ${name}`, { stdio: 'ignore' })
    }
    return true
  } catch {
    return false
  }
}

// Only install if either command is missing
if (!commandExists('autodev-codex') || !commandExists('autodev-ram')) {
  try {
    execSync(`node "${resolve(pluginRoot, 'scripts', 'install-cli.mjs')}"`, {
      stdio: 'ignore'
    })
    console.log('[autodev] CLI commands installed (autodev-codex, autodev-ram). Open a new terminal to use.')
  } catch {
    // Silent fail
  }
}
