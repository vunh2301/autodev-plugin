// src/oauth/account-manager.ts — Account CRUD with multi-account support and validation

import type { OAuthAccount, AccountRegistry } from './types.js'
import type { TokenStore } from './token-store.js'

/** Valid account name: lowercase alphanumeric, underscore, hyphen. 1-32 chars. */
const ACCOUNT_NAME_REGEX = /^[a-z0-9_-]{1,32}$/

/**
 * Validate and normalize account name.
 * - Lowercase
 * - Only [a-z0-9_-], 1-32 chars
 * - Reject reserved names starting with __
 */
export function validateAccountName(name: string): string {
  const normalized = name.toLowerCase().trim()
  if (!ACCOUNT_NAME_REGEX.test(normalized)) {
    throw new Error(
      `Ten account "${name}" khong hop le. Chi dung [a-z0-9_-], toi da 32 ky tu.`
    )
  }
  if (normalized.startsWith('__')) {
    throw new Error(
      `Ten account khong duoc bat dau bang "__" (reserved).`
    )
  }
  return normalized
}

export class AccountManager {
  private tokenStore: TokenStore

  constructor(tokenStore: TokenStore) {
    this.tokenStore = tokenStore
  }

  /**
   * Add or update an account in the registry.
   * If is_default=true, removes default flag from all other accounts.
   */
  async upsertAccount(account: OAuthAccount): Promise<void> {
    const name = validateAccountName(account.name)
    const registry = await this.tokenStore.loadRegistry()

    // If new account is default, clear default from others
    if (account.is_default) {
      for (const existing of registry.accounts) {
        existing.is_default = false
      }
      registry.default_account = name
    }

    // Find existing or push new
    const idx = registry.accounts.findIndex(a => a.name === name)
    const entry: OAuthAccount = { ...account, name }
    if (idx >= 0) {
      registry.accounts[idx] = entry
    } else {
      registry.accounts.push(entry)
    }

    // If this is the only account, force it as default
    if (registry.accounts.length === 1) {
      registry.accounts[0].is_default = true
      registry.default_account = registry.accounts[0].name
    }

    await this.tokenStore.saveRegistry(registry)
  }

  /**
   * Remove an account from registry + delete credential file.
   * If removing default account, promotes the first remaining account to default.
   */
  async removeAccount(name: string): Promise<boolean> {
    const normalized = validateAccountName(name)
    const registry = await this.tokenStore.loadRegistry()
    const idx = registry.accounts.findIndex(a => a.name === normalized)
    if (idx < 0) return false

    const wasDefault = registry.accounts[idx].is_default
    registry.accounts.splice(idx, 1)

    // Promote next account to default if we removed the default
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

  /**
   * Get the default account name.
   * Priority: registry.default_account -> first account -> throw error.
   */
  async getDefaultAccountName(): Promise<string> {
    const registry = await this.tokenStore.loadRegistry()

    if (registry.default_account) {
      // Verify the account actually exists
      const exists = registry.accounts.some(a => a.name === registry.default_account)
      if (exists) return registry.default_account
    }

    if (registry.accounts.length > 0) {
      return registry.accounts[0].name
    }

    throw new Error(
      'Chua co OAuth account nao. Chay "/autodev_auth codex login" truoc.'
    )
  }

  /**
   * Update the status of an account.
   */
  async updateStatus(name: string, status: OAuthAccount['status']): Promise<void> {
    const normalized = validateAccountName(name)
    const registry = await this.tokenStore.loadRegistry()
    const account = registry.accounts.find(a => a.name === normalized)
    if (!account) {
      throw new Error(`Account "${name}" khong ton tai.`)
    }
    account.status = status
    await this.tokenStore.saveRegistry(registry)
  }

  /**
   * Update last_used timestamp.
   */
  async touchLastUsed(name: string): Promise<void> {
    const normalized = validateAccountName(name)
    const registry = await this.tokenStore.loadRegistry()
    const account = registry.accounts.find(a => a.name === normalized)
    if (account) {
      account.last_used = new Date().toISOString()
      await this.tokenStore.saveRegistry(registry)
    }
  }

  /**
   * Count the number of accounts.
   */
  async count(): Promise<number> {
    const registry = await this.tokenStore.loadRegistry()
    return registry.accounts.length
  }
}
