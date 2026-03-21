#!/usr/bin/env node
// oauth.mjs — Codex OAuth Client (standalone bundle)
// Run: node scripts/oauth.mjs <command> [args]

import { randomBytes, createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, unlink, stat, chmod } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import path from 'node:path'
import { userInfo } from 'node:os'
import { createServer } from 'node:http'
import { URL } from 'node:url'

// ===== types.ts =====

class BrowserOpenError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BrowserOpenError'
  }
}

class PortExhaustedError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PortExhaustedError'
  }
}

// ===== pkce.ts =====

function base64url(buffer) {
  return buffer.toString('base64url')
}

function generatePKCE() {
  const verifier = base64url(randomBytes(96))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

function generateState() {
  return base64url(randomBytes(32))
}

// ===== lock.ts =====

const DEFAULT_LOCK_DIR = '.workflow/oauth'
const LOCK_TIMEOUT_MS = 30000
const LOCK_RETRY_MS = 100
const LOCK_MAX_RETRIES = 50
const LOGIN_LOCK_TIMEOUT_MS = 600000

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function withRefreshLock(accountName, fn, lockDir = DEFAULT_LOCK_DIR) {
  const lockPath = path.join(lockDir, `.refresh-lock-${accountName}`)
  await mkdir(lockDir, { recursive: true })

  let acquired = false
  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    try {
      await writeFile(lockPath, JSON.stringify({
        pid: process.pid,
        created_at: new Date().toISOString(),
      }), { flag: 'wx' })
      acquired = true
      break
    } catch (err) {
      if (err.code !== 'EEXIST') throw err

      try {
        const lockStat = await stat(lockPath)
        const age = Date.now() - lockStat.mtimeMs
        if (age > LOCK_TIMEOUT_MS) {
          await unlink(lockPath).catch(() => {})
          continue
        }
      } catch {
        continue
      }

      if (attempt < LOCK_MAX_RETRIES - 1) {
        await sleep(LOCK_RETRY_MS)
      }
    }
  }

  if (!acquired) {
    throw new Error(
      `Could not acquire refresh lock for "${accountName}" after ${LOCK_MAX_RETRIES} attempts (5s).`
    )
  }

  try {
    return await fn()
  } finally {
    await unlink(lockPath).catch(() => {})
  }
}

async function acquireLoginLock(accountName, lockDir = DEFAULT_LOCK_DIR) {
  const lockPath = path.join(lockDir, `.login-lock-${accountName}`)
  await mkdir(lockDir, { recursive: true })

  try {
    await writeFile(lockPath, JSON.stringify({
      pid: process.pid,
      created_at: new Date().toISOString(),
    }), { flag: 'wx' })
  } catch (err) {
    if (err.code !== 'EEXIST') throw err

    try {
      const lockStat = await stat(lockPath)
      const age = Date.now() - lockStat.mtimeMs
      if (age > LOGIN_LOCK_TIMEOUT_MS) {
        await unlink(lockPath).catch(() => {})
        await writeFile(lockPath, JSON.stringify({
          pid: process.pid,
          created_at: new Date().toISOString(),
        }), { flag: 'wx' })
        return
      }
    } catch {
      await writeFile(lockPath, JSON.stringify({
        pid: process.pid,
        created_at: new Date().toISOString(),
      }), { flag: 'wx' })
      return
    }

    throw new Error(
      `Login dang chay cho account "${accountName}". Cho hoan tat hoac xoa lock file: ${lockPath}`
    )
  }
}

async function releaseLoginLock(accountName, lockDir = DEFAULT_LOCK_DIR) {
  const lockPath = path.join(lockDir, `.login-lock-${accountName}`)
  await unlink(lockPath).catch(() => {})
}

// ===== token-store.ts =====

function warnIfSharedDirectory(storageDir) {
  const resolved = path.resolve(storageDir)
  if (resolved.startsWith('\\\\')) {
    console.error('[OAUTH] WARNING: Token storage is on a UNC/network path.')
    return
  }
  if (resolved.startsWith('/net/') || resolved.startsWith('/mnt/') || resolved.includes('/nfs/')) {
    console.error('[OAUTH] WARNING: Token storage appears to be on a network mount.')
  }
}

async function secureFilePermissions(filePath) {
  if (process.platform === 'win32') {
    try {
      const username = userInfo().username
      execSync(
        `icacls "${filePath}" /inheritance:r /grant:r "${username}:(R,W)"`,
        { stdio: 'ignore' },
      )
    } catch {
      console.error(`[OAUTH] WARNING: Could not set file permissions on ${filePath}.`)
    }
  } else {
    try {
      await chmod(filePath, 0o600)
    } catch {
      console.error(`[OAUTH] WARNING: Could not chmod 600 on ${filePath}.`)
    }
  }
}

const DEFAULT_EXPIRY_BUFFER_MS = 300000

class TokenStore {
  constructor(storageDir = '.workflow/oauth') {
    this.storageDir = storageDir
    warnIfSharedDirectory(storageDir)
  }

  credPath(accountName) {
    return path.join(this.storageDir, `${accountName}.json`)
  }

  registryPath() {
    return path.join(this.storageDir, 'accounts.json')
  }

  async load(accountName) {
    const filePath = this.credPath(accountName)
    try {
      const raw = await readFile(filePath, 'utf-8')
      const creds = JSON.parse(raw)
      if (!creds.access_token) {
        throw new Error(`Credential file cho "${accountName}" thieu access_token`)
      }
      return creds
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error(`Khong tim thay credentials cho account "${accountName}". Chay "/autodev oauth login ${accountName}" truoc.`)
      }
      throw err
    }
  }

  async save(accountName, creds) {
    await mkdir(this.storageDir, { recursive: true })
    const filePath = this.credPath(accountName)
    await writeFile(filePath, JSON.stringify(creds, null, 2), 'utf-8')
    await secureFilePermissions(filePath)
  }

  async remove(accountName) {
    try {
      await unlink(this.credPath(accountName))
      return true
    } catch (err) {
      if (err.code === 'ENOENT') return false
      throw err
    }
  }

  isExpired(creds) {
    if (!creds.expires_at) return false
    return new Date(creds.expires_at).getTime() <= Date.now()
  }

  isNearExpiry(creds, bufferMs = DEFAULT_EXPIRY_BUFFER_MS) {
    if (!creds.expires_at) return false
    return new Date(creds.expires_at).getTime() <= Date.now() + bufferMs
  }

  async loadRegistry() {
    try {
      const raw = await readFile(this.registryPath(), 'utf-8')
      return JSON.parse(raw)
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { accounts: [], last_updated: '' }
      }
      throw err
    }
  }

  async saveRegistry(registry) {
    await mkdir(this.storageDir, { recursive: true })
    registry.last_updated = new Date().toISOString()
    await writeFile(this.registryPath(), JSON.stringify(registry, null, 2), 'utf-8')
  }
}

// ===== account-manager.ts =====

const ACCOUNT_NAME_REGEX = /^[a-z0-9_-]{1,32}$/

function validateAccountName(name) {
  const normalized = name.toLowerCase().trim()
  if (!ACCOUNT_NAME_REGEX.test(normalized)) {
    throw new Error(`Ten account "${name}" khong hop le. Chi dung [a-z0-9_-], toi da 32 ky tu.`)
  }
  if (normalized.startsWith('__')) {
    throw new Error(`Ten account khong duoc bat dau bang "__" (reserved).`)
  }
  return normalized
}

class AccountManager {
  constructor(tokenStore) {
    this.tokenStore = tokenStore
  }

  async upsertAccount(account) {
    const name = validateAccountName(account.name)
    const registry = await this.tokenStore.loadRegistry()

    if (account.is_default) {
      for (const existing of registry.accounts) {
        existing.is_default = false
      }
      registry.default_account = name
    }

    const idx = registry.accounts.findIndex(a => a.name === name)
    const entry = { ...account, name }
    if (idx >= 0) {
      registry.accounts[idx] = entry
    } else {
      registry.accounts.push(entry)
    }

    if (registry.accounts.length === 1) {
      registry.accounts[0].is_default = true
      registry.default_account = registry.accounts[0].name
    }

    await this.tokenStore.saveRegistry(registry)
  }

  async removeAccount(name) {
    const normalized = validateAccountName(name)
    const registry = await this.tokenStore.loadRegistry()
    const idx = registry.accounts.findIndex(a => a.name === normalized)
    if (idx < 0) return false

    const wasDefault = registry.accounts[idx].is_default
    registry.accounts.splice(idx, 1)

    if (wasDefault && registry.accounts.length > 0) {
      registry.accounts[0].is_default = true
      registry.default_account = registry.accounts[0].name
    } else if (registry.accounts.length === 0) {
      registry.default_account = undefined
    }

    await this.tokenStore.saveRegistry(registry)
    await this.tokenStore.remove(normalized)
    return true
  }

  async getDefaultAccountName() {
    const registry = await this.tokenStore.loadRegistry()
    if (registry.default_account) {
      const exists = registry.accounts.some(a => a.name === registry.default_account)
      if (exists) return registry.default_account
    }
    if (registry.accounts.length > 0) {
      return registry.accounts[0].name
    }
    throw new Error('Chua co OAuth account nao. Chay "/autodev oauth login" truoc.')
  }

  async updateStatus(name, status) {
    const normalized = validateAccountName(name)
    const registry = await this.tokenStore.loadRegistry()
    const account = registry.accounts.find(a => a.name === normalized)
    if (!account) {
      throw new Error(`Account "${name}" khong ton tai.`)
    }
    account.status = status
    await this.tokenStore.saveRegistry(registry)
  }

  async touchLastUsed(name) {
    const normalized = validateAccountName(name)
    const registry = await this.tokenStore.loadRegistry()
    const account = registry.accounts.find(a => a.name === normalized)
    if (account) {
      account.last_used = new Date().toISOString()
      await this.tokenStore.saveRegistry(registry)
    }
  }

  async count() {
    const registry = await this.tokenStore.loadRegistry()
    return registry.accounts.length
  }
}

// ===== callback-server.ts =====

const SUCCESS_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>OAuth Login</title></head>
<body style="font-family:system-ui;text-align:center;padding-top:80px">
  <h2>Login thanh cong!</h2>
  <p>Ban co the dong tab nay.</p>
</body>
</html>`

function errorHTML(msg) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>OAuth Error</title></head>
<body style="font-family:system-ui;text-align:center;padding-top:80px">
  <h2>Login that bai</h2>
  <p>${msg}</p>
</body>
</html>`
}

function startCallbackServer(options) {
  const { port, callbackPath, expectedState, signal, timeoutMs } = options

  return new Promise((resolveServer, rejectServer) => {
    let codeResolve = null
    let codeReject = null
    let timeoutHandle = null
    let settled = false

    const server = createServer((req, res) => {
      if (!req.url) {
        res.writeHead(400)
        res.end('Bad request')
        return
      }

      const url = new URL(req.url, `http://127.0.0.1:${port}`)
      if (url.pathname !== callbackPath) {
        res.writeHead(404)
        res.end('Not found')
        return
      }

      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')

      if (state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(errorHTML('State mismatch — co the la CSRF attack.'))
        if (!settled && codeReject) {
          settled = true
          codeReject(new Error('CSRF state mismatch on callback'))
          cleanup()
        }
        return
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(errorHTML('Khong nhan duoc authorization code.'))
        if (!settled && codeReject) {
          settled = true
          codeReject(new Error('No authorization code in callback'))
          cleanup()
        }
        return
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(SUCCESS_HTML)
      if (!settled && codeResolve) {
        settled = true
        codeResolve({ code })
        cleanup()
      }
    })

    function cleanup() {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
        timeoutHandle = null
      }
      server.close(() => {})
    }

    if (signal) {
      if (signal.aborted) {
        rejectServer(new Error('Callback server aborted before start'))
        return
      }
      signal.addEventListener('abort', () => {
        if (!settled) {
          settled = true
          if (codeReject) codeReject(new Error('Callback cancelled'))
          cleanup()
        }
      }, { once: true })
    }

    server.on('error', (err) => {
      rejectServer(err)
    })

    server.listen(port, '127.0.0.1', () => {
      const callbackUrl = `http://127.0.0.1:${port}${callbackPath}`

      resolveServer({
        url: callbackUrl,

        waitForCode() {
          return new Promise((resolve, reject) => {
            codeResolve = resolve
            codeReject = reject

            timeoutHandle = setTimeout(() => {
              if (!settled) {
                settled = true
                reject(new Error(`Callback timeout sau ${timeoutMs / 1000}s`))
                cleanup()
              }
            }, timeoutMs)
          })
        },

        close() {
          if (!settled) {
            settled = true
          }
          cleanup()
        },
      })
    })
  })
}

async function startCallbackServerWithRetry(ports, callbackPath, expectedState, timeoutMs, signal) {
  for (let i = 0; i < ports.length; i++) {
    try {
      return await startCallbackServer({
        port: ports[i],
        callbackPath,
        expectedState,
        signal,
        timeoutMs,
      })
    } catch (err) {
      if (err.code === 'EADDRINUSE' && i < ports.length - 1) {
        continue
      }
      if (err.code === 'EADDRINUSE') {
        throw new PortExhaustedError(
          `Tat ca port callback (${ports.join(', ')}) deu bi chiem.`
        )
      }
      throw err
    }
  }
  throw new PortExhaustedError('No ports to try')
}

// ===== engine.ts =====

const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const CODEX_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const CODEX_SCOPES = 'openid email profile offline_access'
const DEVICE_USER_CODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode'
const DEVICE_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token'
const DEVICE_CALLBACK_URI = 'https://auth.openai.com/deviceauth/callback'
const DEVICE_VERIFY_URL = 'https://auth.openai.com/codex/device'

const DEFAULT_CALLBACK_PORTS = [1455, 1456, 1457]
const DEFAULT_CALLBACK_PATH = '/auth/callback'
const DEFAULT_CALLBACK_TIMEOUT_MS = 300000
const DEFAULT_DEVICE_POLL_MS = 5000
const ENGINE_DEFAULT_EXPIRY_BUFFER_MS = 300000
const DEFAULT_STORAGE_DIR = '.workflow/oauth'
const DEVICE_MAX_ATTEMPTS = 720
const REFRESH_MAX_RETRIES = 2
const REFRESH_BACKOFF_MS = [1000, 3000]

function isHeadlessEnvironment() {
  if (process.platform !== 'win32') {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return true
  }
  if (process.env.SSH_CLIENT || process.env.SSH_TTY) return true
  if (process.env.CI) return true
  if (process.env.container === 'docker') return true
  return false
}

function openBrowserDefault(url) {
  try {
    switch (process.platform) {
      case 'darwin':
        execSync(`open "${url}"`, { stdio: 'ignore' })
        break
      case 'win32':
        execSync(`start "" "${url}"`, { stdio: 'ignore', shell: 'cmd.exe' })
        break
      default:
        execSync(`xdg-open "${url}"`, { stdio: 'ignore' })
        break
    }
  } catch (err) {
    throw new BrowserOpenError(`Khong the mo browser: ${err.message}`)
  }
}

class OAuthEngine {
  constructor(options) {
    const opts = options || {}
    this.storageDir = opts.storage_dir || DEFAULT_STORAGE_DIR
    this.callbackPorts = opts.callback_ports || DEFAULT_CALLBACK_PORTS
    this.callbackPath = opts.callback_path || DEFAULT_CALLBACK_PATH
    this.callbackTimeoutMs = opts.callback_timeout_ms || DEFAULT_CALLBACK_TIMEOUT_MS
    this.devicePollMs = opts.device_poll_interval_ms || DEFAULT_DEVICE_POLL_MS
    this.expiryBufferMs = opts.expiry_buffer_ms || ENGINE_DEFAULT_EXPIRY_BUFFER_MS
    this.fetchFn = opts.fetch_fn || globalThis.fetch
    this.openBrowser = opts.open_browser || openBrowserDefault

    this.tokenStore = new TokenStore(this.storageDir)
    this.accountManager = new AccountManager(this.tokenStore)
  }

  // LOGIN: PKCE FLOW
  async loginPKCE(accountName, signal) {
    const name = accountName || 'default'
    const { verifier, challenge } = generatePKCE()
    const state = generateState()

    const server = await startCallbackServerWithRetry(
      this.callbackPorts,
      this.callbackPath,
      state,
      this.callbackTimeoutMs,
      signal,
    )

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: CODEX_CLIENT_ID,
      redirect_uri: server.url,
      scope: CODEX_SCOPES,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'login',
    })
    const authorizeUrl = `${CODEX_AUTHORIZE_URL}?${params}`

    try {
      this.openBrowser(authorizeUrl)
    } catch (browserErr) {
      server.close()
      throw browserErr instanceof BrowserOpenError
        ? browserErr
        : new BrowserOpenError(`Khong the mo browser: ${browserErr}`)
    }

    const { code } = await server.waitForCode()

    const tokenResp = await this.fetchFn(CODEX_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: server.url,
        client_id: CODEX_CLIENT_ID,
        code_verifier: verifier,
      }).toString(),
    })

    if (!tokenResp.ok) {
      const text = await tokenResp.text().catch(() => '')
      throw new Error(`Token exchange failed: HTTP ${tokenResp.status} — ${text}`)
    }

    const data = await tokenResp.json()

    const creds = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000).toISOString()
        : undefined,
    }
    await this.tokenStore.save(name, creds)

    const currentCount = await this.accountManager.count()
    await this.accountManager.upsertAccount({
      name,
      status: 'active',
      created_at: new Date().toISOString(),
      is_default: currentCount === 0,
    })

    return { success: true, account_name: name, mode: 'pkce' }
  }

  // LOGIN: DEVICE CODE FLOW
  async loginDeviceCode(accountName, signal) {
    const name = accountName || 'default'

    const deviceResp = await this.fetchFn(DEVICE_USER_CODE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
    })

    if (!deviceResp.ok) {
      const text = await deviceResp.text().catch(() => '')
      throw new Error(`Device code request failed: HTTP ${deviceResp.status} — ${text}`)
    }

    const { device_auth_id, user_code, verification_uri, interval } = await deviceResp.json()

    const verifyUrl = verification_uri || DEVICE_VERIFY_URL
    console.error(`\n  Mo: ${verifyUrl}`)
    console.error(`  Nhap code: ${user_code}\n`)

    const pollIntervalMs = (interval || 5) * 1000

    for (let attempt = 0; attempt < DEVICE_MAX_ATTEMPTS; attempt++) {
      if (signal?.aborted) throw new Error('Login cancelled')

      await sleep(pollIntervalMs)

      const pollResp = await this.fetchFn(DEVICE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ device_auth_id, user_code }),
      })

      if (pollResp.status === 403 || pollResp.status === 404) {
        continue
      }

      if (!pollResp.ok) {
        throw new Error(`Device poll failed: HTTP ${pollResp.status}`)
      }

      const { authorization_code, code_verifier } = await pollResp.json()

      const tokenResp = await this.fetchFn(CODEX_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: CODEX_CLIENT_ID,
          code: authorization_code,
          redirect_uri: DEVICE_CALLBACK_URI,
          code_verifier,
        }).toString(),
      })

      if (!tokenResp.ok) {
        const text = await tokenResp.text().catch(() => '')
        throw new Error(`Token exchange failed: HTTP ${tokenResp.status} — ${text}`)
      }

      const tokenData = await tokenResp.json()

      const creds = {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: tokenData.expires_in
          ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
          : undefined,
      }
      await this.tokenStore.save(name, creds)

      const currentCount = await this.accountManager.count()
      await this.accountManager.upsertAccount({
        name,
        status: 'active',
        created_at: new Date().toISOString(),
        is_default: currentCount === 0,
      })

      return { success: true, account_name: name, mode: 'device_code' }
    }

    throw new Error('Device code login timeout — qua 1 gio cho')
  }

  // LOGIN WITH AUTO-FALLBACK
  async loginWithFallback(accountName, signal) {
    const name = accountName || 'default'
    await acquireLoginLock(name, this.storageDir)

    try {
      if (isHeadlessEnvironment()) {
        console.error('[OAUTH] Phat hien headless environment -> dung Device Code flow')
        return await this.loginDeviceCode(name, signal)
      }

      try {
        return await this.loginPKCE(name, signal)
      } catch (err) {
        if (err instanceof BrowserOpenError) {
          console.error('[OAUTH] Khong the mo browser -> chuyen sang Device Code flow')
          return await this.loginDeviceCode(name, signal)
        }
        if (err instanceof PortExhaustedError) {
          console.error('[OAUTH] Tat ca port callback bi chiem -> chuyen sang Device Code flow')
          return await this.loginDeviceCode(name, signal)
        }
        throw err
      }
    } finally {
      await releaseLoginLock(name, this.storageDir)
    }
  }

  // TOKEN REFRESH
  async refreshToken(accountName) {
    const creds = await this.tokenStore.load(accountName)

    if (!creds.refresh_token) {
      throw new Error(`Account "${accountName}" khong co refresh token — can login lai`)
    }

    const resp = await this.fetchFn(CODEX_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        client_id: CODEX_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: creds.refresh_token,
        scope: CODEX_SCOPES,
      }).toString(),
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      if (resp.status === 401 || resp.status === 403) {
        await this.accountManager.updateStatus(accountName, 'revoked')
        throw new Error(`Refresh token da bi thu hoi cho account "${accountName}" — can login lai`)
      }
      throw new Error(`Token refresh failed: HTTP ${resp.status} — ${text}`)
    }

    const data = await resp.json()

    const updated = {
      ...creds,
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? creds.refresh_token,
      expires_at: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000).toISOString()
        : creds.expires_at,
      last_refresh: new Date().toISOString(),
    }

    await this.tokenStore.save(accountName, updated)
    return updated
  }

  async refreshWithRetry(accountName) {
    let lastError = null
    for (let attempt = 0; attempt <= REFRESH_MAX_RETRIES; attempt++) {
      try {
        return await this.refreshToken(accountName)
      } catch (err) {
        lastError = err
        if (err.message?.includes('thu hoi') || err.message?.includes('revoked')) {
          throw err
        }
        if (attempt < REFRESH_MAX_RETRIES) {
          await sleep(REFRESH_BACKOFF_MS[attempt])
        }
      }
    }
    throw lastError
  }

  // GET ACCESS TOKEN
  async getAccessToken(accountName, forceRefresh) {
    const name = accountName || await this.accountManager.getDefaultAccountName()
    const creds = await this.tokenStore.load(name)

    if (!forceRefresh && !this.tokenStore.isNearExpiry(creds, this.expiryBufferMs)) {
      await this.accountManager.touchLastUsed(name).catch(() => {})
      return creds.access_token
    }

    const updated = await withRefreshLock(name, async () => {
      const freshCreds = await this.tokenStore.load(name)
      if (!forceRefresh && !this.tokenStore.isNearExpiry(freshCreds, this.expiryBufferMs)) {
        return freshCreds
      }
      return await this.refreshWithRetry(name)
    }, this.storageDir)

    await this.accountManager.touchLastUsed(name).catch(() => {})
    return updated.access_token
  }

  // LOGOUT
  async logout(accountName) {
    return await this.accountManager.removeAccount(accountName)
  }

  // LIST ACCOUNTS
  async listAccounts() {
    const registry = await this.tokenStore.loadRegistry()
    return registry.accounts
  }

  // GET STATUS
  async getStatus(accountName) {
    const name = accountName || await this.accountManager.getDefaultAccountName()
    const registry = await this.tokenStore.loadRegistry()
    const account = registry.accounts.find(a => a.name === name)

    if (!account) {
      throw new Error(`Account "${name}" khong ton tai.`)
    }

    let tokenValid = false
    let expiresInSeconds
    let needsRefresh = false

    try {
      const creds = await this.tokenStore.load(name)
      tokenValid = !this.tokenStore.isExpired(creds)
      needsRefresh = this.tokenStore.isNearExpiry(creds, this.expiryBufferMs)

      if (creds.expires_at) {
        expiresInSeconds = Math.max(0, Math.floor(
          (new Date(creds.expires_at).getTime() - Date.now()) / 1000
        ))
      }
    } catch {
      tokenValid = false
      needsRefresh = true
    }

    return {
      account,
      token_valid: tokenValid,
      expires_in_seconds: expiresInSeconds,
      needs_refresh: needsRefresh,
    }
  }

  // SET DEFAULT ACCOUNT
  async setDefaultAccount(accountName) {
    const registry = await this.tokenStore.loadRegistry()
    const account = registry.accounts.find(a => a.name === accountName)

    if (!account) {
      throw new Error(`Account "${accountName}" khong ton tai.`)
    }

    for (const a of registry.accounts) {
      a.is_default = false
    }

    account.is_default = true
    registry.default_account = accountName
    await this.tokenStore.saveRegistry(registry)
  }
}

// ===== oauth-cli.ts =====

const [,, command, ...args] = process.argv
const engine = new OAuthEngine()

async function main() {
  let result

  switch (command) {
    case 'login': {
      const useDevice = args.includes('--device')
      const name = args.filter(a => !a.startsWith('--'))[0] || 'default'
      result = useDevice
        ? await engine.loginDeviceCode(name)
        : await engine.loginWithFallback(name)
      break
    }

    case 'logout': {
      if (!args[0]) {
        throw new Error('Can chi dinh ten account. Vi du: oauth logout work')
      }
      const removed = await engine.logout(args[0])
      result = { removed, account: args[0] }
      break
    }

    case 'accounts': {
      result = await engine.listAccounts()
      break
    }

    case 'status': {
      result = await engine.getStatus(args[0])
      break
    }

    case 'default': {
      if (!args[0]) {
        throw new Error('Can chi dinh ten account. Vi du: oauth default work')
      }
      await engine.setDefaultAccount(args[0])
      result = { default_account: args[0] }
      break
    }

    case 'refresh': {
      await engine.getAccessToken(args[0], true)
      result = { message: 'Token da refresh' }
      break
    }

    case 'get-token': {
      const forceRefresh = args.includes('--force-refresh')
      const name = args.filter(a => !a.startsWith('--'))[0]
      const token = await engine.getAccessToken(name, forceRefresh)
      result = { token }
      break
    }

    default:
      throw new Error(
        `Unknown command: ${command || '(none)'}. ` +
        `Commands: login, logout, accounts, status, default, refresh, get-token`
      )
  }

  process.stdout.write(JSON.stringify({ ok: true, data: result }))
}

main().catch(err => {
  process.stderr.write(JSON.stringify({ ok: false, error: String(err) }))
  process.exit(1)
})
