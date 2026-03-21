#!/usr/bin/env node
// scripts/build-oauth.mjs — Bundle TypeScript source into scripts/oauth.mjs
// Uses only Node.js built-in modules. No external dependencies.
//
// Strategy: Read all .ts source files, strip TypeScript syntax (type annotations,
// interfaces, etc.), resolve imports, and concatenate into a single self-contained .mjs.
//
// Since we cannot use esbuild/tsup (no external deps), we inline the modules
// manually by reading source files and transforming them.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = resolve(__dirname, '..')

const SRC_DIR = join(ROOT, 'src')
const OUT_FILE = join(ROOT, 'scripts', 'oauth.mjs')

// Ordered list of source files (dependency order)
const SOURCE_FILES = [
  'oauth/types.ts',
  'oauth/pkce.ts',
  'oauth/lock.ts',
  'oauth/token-store.ts',
  'oauth/account-manager.ts',
  'oauth/callback-server.ts',
  'oauth/engine.ts',
  'oauth/index.ts',
  'dispatch/openai-client.ts',
  'oauth-cli.ts',
]

/**
 * Strip TypeScript-specific syntax to produce valid JavaScript.
 * This is a simplified transform — handles the patterns used in our codebase.
 */
function stripTypeScript(code) {
  let result = code

  // Remove import type statements entirely
  result = result.replace(/^import\s+type\s+\{[^}]*\}\s+from\s+['"][^'"]*['"]\s*;?\s*$/gm, '')

  // Remove all import statements (we inline everything)
  result = result.replace(/^import\s+\{[^}]*\}\s+from\s+['"][^'"]*['"]\s*;?\s*$/gm, '')
  result = result.replace(/^import\s+\w+\s+from\s+['"][^'"]*['"]\s*;?\s*$/gm, '')
  result = result.replace(/^import\s+\*\s+as\s+\w+\s+from\s+['"][^'"]*['"]\s*;?\s*$/gm, '')

  // Remove export type statements
  result = result.replace(/^export\s+type\s+\{[^}]*\}\s+from\s+['"][^'"]*['"]\s*;?\s*$/gm, '')

  // Remove 'export' keyword from declarations (we handle scope manually)
  result = result.replace(/^export\s+(class|function|async function|const|let|var|interface|type|enum)/gm, '$1')

  // Remove interface blocks
  result = result.replace(/^interface\s+\w+[^{]*\{[^}]*\}/gm, '')
  // Multi-line interfaces
  result = result.replace(/^interface\s+\w+[^{]*\{[\s\S]*?^}/gm, '')

  // Remove type aliases
  result = result.replace(/^type\s+\w+\s*=\s*[^;]*;/gm, '')

  // Remove 'satisfies Type' expressions
  result = result.replace(/\s+satisfies\s+\w+/g, '')

  // Remove type assertions (as Type)
  result = result.replace(/\s+as\s+\{[^}]*\}/g, '')
  result = result.replace(/\s+as\s+(?:any|string|number|boolean|unknown|void|never)\b/g, '')
  result = result.replace(/\s+as\s+[A-Z]\w+(?:\[\])?/g, '')

  // Remove type annotations from parameters and variables
  // `: Type` patterns — be careful not to remove object property values
  result = result.replace(/(\w)\s*:\s*(?:string|number|boolean|void|any|unknown|never)(?:\s*\[\])?\s*([,)=\n{])/g, '$1$2')
  result = result.replace(/(\w)\s*\?:\s*(?:string|number|boolean|void|any|unknown|never)(?:\s*\[\])?\s*([,)=\n{])/g, '$1$2')

  // Remove return type annotations
  result = result.replace(/\):\s*Promise<[^>]+>/g, ')')
  result = result.replace(/\):\s*(?:string|number|boolean|void|any|unknown|never)(?:\s*\[\])?\s*\{/g, ') {')

  // Remove generic type parameters from function calls
  result = result.replace(/<(?:string|number|boolean|void|any|unknown|never|[A-Z]\w*)(?:\s*\[\])?>/g, '')

  // Remove 'declare' statements
  result = result.replace(/^declare\s+.*/gm, '')

  // Clean up empty lines
  result = result.replace(/\n{3,}/g, '\n\n')

  return result
}

function build() {
  console.log('Building oauth.mjs...')

  const parts = [
    '#!/usr/bin/env node',
    '// oauth.mjs — Codex OAuth Client (auto-generated, do not edit)',
    '// Generated: ' + new Date().toISOString(),
    '',
    "import { randomBytes, createHash } from 'node:crypto'",
    "import { readFile, writeFile, mkdir, unlink, stat, chmod } from 'node:fs/promises'",
    "import { execSync } from 'node:child_process'",
    "import path from 'node:path'",
    "import { userInfo } from 'node:os'",
    "import { createServer } from 'node:http'",
    "import { URL } from 'node:url'",
    '',
  ]

  for (const file of SOURCE_FILES) {
    const filePath = join(SRC_DIR, file)
    try {
      const raw = readFileSync(filePath, 'utf-8')
      const stripped = stripTypeScript(raw)
      parts.push(`// ===== ${file} =====`)
      parts.push(stripped)
      parts.push('')
    } catch (err) {
      console.error(`Warning: Could not read ${filePath}: ${err.message}`)
    }
  }

  mkdirSync(dirname(OUT_FILE), { recursive: true })
  writeFileSync(OUT_FILE, parts.join('\n'), 'utf-8')
  console.log(`Written: ${OUT_FILE}`)
  console.log('Done.')
}

build()
