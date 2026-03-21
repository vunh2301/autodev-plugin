// src/oauth/token-store.ts — Token storage with platform-specific file permissions

import { readFile, writeFile, mkdir, unlink, chmod } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import path from 'node:path'
import { userInfo } from 'node:os'
import type { OAuthCredentials, AccountRegistry } from './types.js'

const DEFAULT_EXPIRY_BUFFER_MS = 300_000 // 5 minutes

/**
 * Warn if storage directory is on a shared/network location.
 */
function warnIfSharedDirectory(storageDir: string): void {
  const resolved = path.resolve(storageDir)
  // UNC path (\\server\share)
  if (resolved.startsWith('\\\\')) {
    console.error('[OAUTH] WARNING: Token storage is on a UNC/network path. Tokens may be accessible to other users.')
    return
  }
  // Linux NFS / network mount heuristics
  if (resolved.startsWith('/net/') || resolved.startsWith('/mnt/') || resolved.includes('/nfs/')) {
    console.error('[OAUTH] WARNING: Token storage appears to be on a network mount. Consider using a local directory.')
  }
}

/**
 * Set file permissions to owner-only read/write.
 * - macOS/Linux: chmod 0o600
 * - Windows: icacls restrict to current user (best-effort, logs warning on failure)
 */
async function secureFilePermissions(filePath: string): Promise<void> {
  if (process.platform === 'win32') {
    try {
      const username = userInfo().username
      execSync(
        `icacls "${filePath}" /inheritance:r /grant:r "${username}:(R,W)"`,
        { stdio: 'ignore' },
      )
    } catch {
      console.error(`[OAUTH] WARNING: Could not set file permissions on ${filePath}. Tokens may be world-readable.`)
    }
  } else {
    try {
      await chmod(filePath, 0o600)
    } catch {
      console.error(`[OAUTH] WARNING: Could not chmod 600 on ${filePath}.`)
    }
  }
}

export class TokenStore {
  private storageDir: string

  constructor(storageDir: string) {
    this.storageDir = storageDir
    warnIfSharedDirectory(storageDir)
  }

  /** Get the path for an account's credential file */
  private credPath(accountName: string): string {
    return path.join(this.storageDir, `${accountName}.json`)
  }

  /** Get the path for the registry file */
  private registryPath(): string {
    return path.join(this.storageDir, 'accounts.json')
  }

  /**
   * Load credentials for an account.
   * @throws if file doesn't exist or is malformed
   */
  async load(accountName: string): Promise<OAuthCredentials> {
    const filePath = this.credPath(accountName)
    try {
      const raw = await readFile(filePath, 'utf-8')
      const creds = JSON.parse(raw) as OAuthCredentials
      if (!creds.access_token) {
        throw new Error(`Credential file cho "${accountName}" thiếu access_token`)
      }
      return creds
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        throw new Error(`Không tìm thấy credentials cho account "${accountName}". Chạy "/autodev_auth codex login ${accountName}" trước.`)
      }
      throw err
    }
  }

  /**
   * Save credentials. Creates directory if needed. Sets file permissions.
   */
  async save(accountName: string, creds: OAuthCredentials): Promise<void> {
    await mkdir(this.storageDir, { recursive: true })
    const filePath = this.credPath(accountName)
    await writeFile(filePath, JSON.stringify(creds, null, 2), 'utf-8')
    await secureFilePermissions(filePath)
  }

  /**
   * Remove credential file for an account.
   * @returns true if file existed and was removed
   */
  async remove(accountName: string): Promise<boolean> {
    try {
      await unlink(this.credPath(accountName))
      return true
    } catch (err: any) {
      if (err.code === 'ENOENT') return false
      throw err
    }
  }

  /**
   * Check if token has expired.
   */
  isExpired(creds: OAuthCredentials): boolean {
    if (!creds.expires_at) return false
    return new Date(creds.expires_at).getTime() <= Date.now()
  }

  /**
   * Check if token is near expiry (within buffer window).
   * Default buffer: 5 minutes.
   */
  isNearExpiry(creds: OAuthCredentials, bufferMs: number = DEFAULT_EXPIRY_BUFFER_MS): boolean {
    if (!creds.expires_at) return false
    return new Date(creds.expires_at).getTime() <= Date.now() + bufferMs
  }

  /**
   * Load account registry. Returns empty registry if file doesn't exist (graceful init).
   */
  async loadRegistry(): Promise<AccountRegistry> {
    try {
      const raw = await readFile(this.registryPath(), 'utf-8')
      return JSON.parse(raw) as AccountRegistry
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return { accounts: [], last_updated: '' }
      }
      throw err
    }
  }

  /**
   * Save account registry.
   */
  async saveRegistry(registry: AccountRegistry): Promise<void> {
    await mkdir(this.storageDir, { recursive: true })
    registry.last_updated = new Date().toISOString()
    await writeFile(this.registryPath(), JSON.stringify(registry, null, 2), 'utf-8')
  }
}
