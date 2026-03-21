// src/oauth/engine.ts — OAuthEngine: PKCE + Device Code flows, token refresh, multi-account

import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'
import type {
  OAuthCredentials,
  OAuthAccount,
  LoginResult,
  OAuthEngineOptions,
} from './types.js'
import { BrowserOpenError, PortExhaustedError } from './types.js'
import { generatePKCE, generateState } from './pkce.js'
import { withRefreshLock, acquireLoginLock, releaseLoginLock } from './lock.js'
import { TokenStore } from './token-store.js'
import { AccountManager } from './account-manager.js'
import { startCallbackServerWithRetry } from './callback-server.js'

// --- Constants (spec Section 11) ---
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const CODEX_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const CODEX_SCOPES = 'openid email profile offline_access'
const DEVICE_USER_CODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode'
const DEVICE_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token'
const DEVICE_CALLBACK_URI = 'https://auth.openai.com/deviceauth/callback'
const DEVICE_VERIFY_URL = 'https://auth.openai.com/codex/device'

// --- Defaults ---
const DEFAULT_CALLBACK_PORTS = [1455, 1456, 1457]
const DEFAULT_CALLBACK_PATH = '/auth/callback'
const DEFAULT_CALLBACK_TIMEOUT_MS = 300_000  // 5 min
const DEFAULT_DEVICE_POLL_MS = 5_000         // 5s
const DEFAULT_EXPIRY_BUFFER_MS = 300_000     // 5 min
/** Resolve default storage dir: ~/.config/autodev/oauth (cross-platform) */
function getDefaultStorageDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming'), 'autodev', 'oauth')
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'autodev', 'oauth')
}
const DEFAULT_STORAGE_DIR = getDefaultStorageDir()
const DEVICE_MAX_ATTEMPTS = 720              // 720 * 5s = 1 hour
const REFRESH_MAX_RETRIES = 2
const REFRESH_BACKOFF_MS = [1000, 3000]

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Detect headless environment (no GUI available).
 */
function isHeadlessEnvironment(): boolean {
  // Linux/macOS: no DISPLAY and no Wayland
  if (process.platform !== 'win32') {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return true
  }
  // SSH session
  if (process.env.SSH_CLIENT || process.env.SSH_TTY) return true
  // CI/CD
  if (process.env.CI) return true
  // Docker
  if (process.env.container === 'docker') return true

  return false
}

/**
 * Open URL in the default browser using platform-specific command.
 */
function openBrowserDefault(url: string): void {
  try {
    switch (process.platform) {
      case 'darwin':
        execSync(`open "${url}"`, { stdio: 'ignore' })
        break
      case 'win32':
        execSync(`rundll32 url.dll,FileProtocolHandler "${url}"`, { stdio: 'ignore' })
        break
      default:
        execSync(`xdg-open "${url}"`, { stdio: 'ignore' })
        break
    }
  } catch (err: any) {
    throw new BrowserOpenError(`Khong the mo browser: ${err.message}`)
  }
}

export class OAuthEngine {
  private tokenStore: TokenStore
  private accountManager: AccountManager
  private callbackPorts: number[]
  private callbackPath: string
  private callbackTimeoutMs: number
  private devicePollMs: number
  private expiryBufferMs: number
  private storageDir: string
  private fetchFn: typeof fetch
  private openBrowser: (url: string) => void

  constructor(options?: OAuthEngineOptions) {
    this.storageDir = options?.storage_dir ?? DEFAULT_STORAGE_DIR
    this.callbackPorts = options?.callback_ports ?? DEFAULT_CALLBACK_PORTS
    this.callbackPath = options?.callback_path ?? DEFAULT_CALLBACK_PATH
    this.callbackTimeoutMs = options?.callback_timeout_ms ?? DEFAULT_CALLBACK_TIMEOUT_MS
    this.devicePollMs = options?.device_poll_interval_ms ?? DEFAULT_DEVICE_POLL_MS
    this.expiryBufferMs = options?.expiry_buffer_ms ?? DEFAULT_EXPIRY_BUFFER_MS
    this.fetchFn = options?.fetch_fn ?? globalThis.fetch
    this.openBrowser = options?.open_browser ?? openBrowserDefault

    this.tokenStore = new TokenStore(this.storageDir)
    this.accountManager = new AccountManager(this.tokenStore)
  }

  // ===== LOGIN: PKCE FLOW (Section 4.1) =====

  async loginPKCE(accountName?: string, signal?: AbortSignal): Promise<LoginResult> {
    const name = accountName ?? 'default'

    // 1. Generate PKCE pair
    const { verifier, challenge } = generatePKCE()

    // 2. Generate CSRF state
    const state = generateState()

    // 3. Start callback server with port retry
    const server = await startCallbackServerWithRetry(
      this.callbackPorts,
      this.callbackPath,
      state,
      this.callbackTimeoutMs,
      signal,
    )

    // 4. Build authorize URL
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: CODEX_CLIENT_ID,
      redirect_uri: server.url,
      scope: CODEX_SCOPES,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'login',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
    })
    const authorizeUrl = `${CODEX_AUTHORIZE_URL}?${params}`

    // 5. Open browser
    try {
      this.openBrowser(authorizeUrl)
    } catch (browserErr) {
      server.close()
      throw browserErr instanceof BrowserOpenError
        ? browserErr
        : new BrowserOpenError(`Khong the mo browser: ${browserErr}`)
    }

    // 6. Wait for callback
    const { code } = await server.waitForCode()

    // 7. Exchange code for tokens
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

    const data = await tokenResp.json() as {
      access_token: string
      refresh_token?: string
      expires_in?: number
    }

    // 8. Save credentials
    const creds: OAuthCredentials = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000).toISOString()
        : undefined,
    }
    await this.tokenStore.save(name, creds)

    // 9. Update registry
    const currentCount = await this.accountManager.count()
    await this.accountManager.upsertAccount({
      name,
      status: 'active',
      created_at: new Date().toISOString(),
      is_default: currentCount === 0,
    })

    return { success: true, account_name: name, mode: 'pkce' }
  }

  // ===== LOGIN: DEVICE CODE FLOW (Section 4.2) =====

  async loginDeviceCode(accountName?: string, signal?: AbortSignal): Promise<LoginResult> {
    const name = accountName ?? 'default'

    // 1. Request device code
    const deviceResp = await this.fetchFn(DEVICE_USER_CODE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
    })

    if (!deviceResp.ok) {
      const text = await deviceResp.text().catch(() => '')
      throw new Error(`Device code request failed: HTTP ${deviceResp.status} — ${text}`)
    }

    const deviceData = await deviceResp.json() as {
      device_auth_id: string
      user_code?: string
      usercode?: string
      verification_uri?: string
      interval?: number | string
    }

    // Handle both user_code and usercode field names (OpenAI API inconsistency)
    const user_code = (deviceData.user_code ?? deviceData.usercode ?? '').trim()
    const device_auth_id = deviceData.device_auth_id

    if (!user_code || !device_auth_id) {
      throw new Error('Device flow did not return required fields')
    }

    // 2. Display instructions
    const verifyUrl = deviceData.verification_uri ?? DEVICE_VERIFY_URL
    console.error(`\n  Mo: ${verifyUrl}`)
    console.error(`  Nhap code: ${user_code}\n`)

    // 3. Poll for authorization — parse interval from string or number
    const rawInterval = deviceData.interval
    const parsedInterval = typeof rawInterval === 'string'
      ? parseInt(rawInterval, 10) || 5
      : rawInterval ?? 5
    const pollIntervalMs = parsedInterval * 1000

    for (let attempt = 0; attempt < DEVICE_MAX_ATTEMPTS; attempt++) {
      if (signal?.aborted) throw new Error('Login cancelled')

      await sleep(pollIntervalMs)

      const pollResp = await this.fetchFn(DEVICE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ device_auth_id, user_code }),
      })

      // 403/404 = authorization_pending
      if (pollResp.status === 403 || pollResp.status === 404) {
        continue
      }

      if (!pollResp.ok) {
        throw new Error(`Device poll failed: HTTP ${pollResp.status}`)
      }

      // 4. Got authorization_code + code_verifier
      const { authorization_code, code_verifier } = await pollResp.json() as {
        authorization_code: string
        code_verifier: string
      }

      // 5. Exchange for tokens (same endpoint as PKCE)
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

      const tokenData = await tokenResp.json() as {
        access_token: string
        refresh_token?: string
        expires_in?: number
      }

      // 6. Save + registry
      const creds: OAuthCredentials = {
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

    throw new Error('Device code login timeout — qua 1 gio cho user hoan tat login')
  }

  // ===== LOGIN WITH AUTO-FALLBACK (Section 4.4) =====

  async loginWithFallback(accountName?: string, signal?: AbortSignal): Promise<LoginResult> {
    const name = accountName ?? 'default'
    await acquireLoginLock(name, this.storageDir)

    try {
      // 1. Headless -> Device Code immediately
      if (isHeadlessEnvironment()) {
        console.error('[OAUTH] Phat hien headless environment -> dung Device Code flow')
        return await this.loginDeviceCode(name, signal)
      }

      // 2. Try PKCE flow
      try {
        return await this.loginPKCE(name, signal)
      } catch (err) {
        // 3. Browser open fail -> fallback Device Code IMMEDIATELY
        if (err instanceof BrowserOpenError) {
          console.error('[OAUTH] Khong the mo browser -> chuyen sang Device Code flow')
          return await this.loginDeviceCode(name, signal)
        }

        // 4. All ports busy -> fallback Device Code
        if (err instanceof PortExhaustedError) {
          console.error('[OAUTH] Tat ca port callback bi chiem -> chuyen sang Device Code flow')
          return await this.loginDeviceCode(name, signal)
        }

        // 5. Other errors -> throw
        throw err
      }
    } finally {
      await releaseLoginLock(name, this.storageDir)
    }
  }

  // ===== TOKEN REFRESH (Section 4.3) =====

  private async refreshToken(accountName: string): Promise<OAuthCredentials> {
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
      // Token revoked -> mark account revoked
      if (resp.status === 401 || resp.status === 403) {
        await this.accountManager.updateStatus(accountName, 'revoked')
        throw new Error(`Refresh token da bi thu hoi cho account "${accountName}" — can login lai`)
      }
      throw new Error(`Token refresh failed: HTTP ${resp.status} — ${text}`)
    }

    const data = await resp.json() as {
      access_token: string
      refresh_token?: string
      expires_in?: number
    }

    const updated: OAuthCredentials = {
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

  /**
   * Refresh with retry. Max 2 retries, backoff [1s, 3s].
   * Does NOT retry on 401/403 (token revoked).
   */
  private async refreshWithRetry(accountName: string): Promise<OAuthCredentials> {
    let lastError: Error | null = null
    for (let attempt = 0; attempt <= REFRESH_MAX_RETRIES; attempt++) {
      try {
        return await this.refreshToken(accountName)
      } catch (err: any) {
        lastError = err
        // Don't retry on revoke
        if (err.message?.includes('thu hoi') || err.message?.includes('revoked')) {
          throw err
        }
        if (attempt < REFRESH_MAX_RETRIES) {
          await sleep(REFRESH_BACKOFF_MS[attempt])
        }
      }
    }
    throw lastError!
  }

  // ===== GET ACCESS TOKEN (Section 3.4 + 4.5) =====

  async getAccessToken(accountName?: string, forceRefresh?: boolean): Promise<string> {
    const name = accountName ?? await this.accountManager.getDefaultAccountName()
    const creds = await this.tokenStore.load(name)

    // If token is still valid AND not force refresh -> return immediately
    if (!forceRefresh && !this.tokenStore.isNearExpiry(creds, this.expiryBufferMs)) {
      await this.accountManager.touchLastUsed(name).catch(() => {})
      return creds.access_token
    }

    // Need refresh -> acquire lock to prevent race condition
    const updated = await withRefreshLock(name, async () => {
      // Re-read after acquiring lock — another process may have refreshed
      const freshCreds = await this.tokenStore.load(name)
      if (!forceRefresh && !this.tokenStore.isNearExpiry(freshCreds, this.expiryBufferMs)) {
        return freshCreds // Already refreshed by another process
      }

      return await this.refreshWithRetry(name)
    }, this.storageDir)

    await this.accountManager.touchLastUsed(name).catch(() => {})
    return updated.access_token
  }

  // ===== LOGOUT =====

  async logout(accountName: string): Promise<boolean> {
    return await this.accountManager.removeAccount(accountName)
  }

  // ===== LIST ACCOUNTS =====

  async listAccounts(): Promise<OAuthAccount[]> {
    const registry = await this.tokenStore.loadRegistry()
    return registry.accounts
  }

  // ===== GET STATUS =====

  async getStatus(accountName?: string): Promise<{
    account: OAuthAccount
    token_valid: boolean
    expires_in_seconds?: number
    needs_refresh: boolean
  }> {
    const name = accountName ?? await this.accountManager.getDefaultAccountName()
    const registry = await this.tokenStore.loadRegistry()
    const account = registry.accounts.find(a => a.name === name)

    if (!account) {
      throw new Error(`Account "${name}" khong ton tai.`)
    }

    let tokenValid = false
    let expiresInSeconds: number | undefined
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
      // No credentials file
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

  // ===== SET DEFAULT ACCOUNT =====

  async setDefaultAccount(accountName: string): Promise<void> {
    const registry = await this.tokenStore.loadRegistry()
    const account = registry.accounts.find(a => a.name === accountName)

    if (!account) {
      throw new Error(`Account "${accountName}" khong ton tai. Chay "accounts" de xem danh sach.`)
    }

    // Clear default from all
    for (const a of registry.accounts) {
      a.is_default = false
    }

    account.is_default = true
    registry.default_account = accountName
    await this.tokenStore.saveRegistry(registry)
  }
}
