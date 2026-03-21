// src/oauth/types.ts — Shared types and error classes for Codex OAuth Client

/** Normalized credential information for one OAuth account */
export interface OAuthCredentials {
  access_token: string
  refresh_token?: string
  /** ISO 8601 — when the access token expires */
  expires_at?: string
  /** ISO 8601 — last time the token was refreshed */
  last_refresh?: string
  /** Email linked to the OpenAI account */
  email?: string
  /** OpenAI account ID */
  account_id?: string
}

/** One account entry in the registry */
export interface OAuthAccount {
  /** User-chosen account name (e.g. "work", "personal") */
  name: string
  /** Email used to login */
  email?: string
  status: 'active' | 'expired' | 'revoked' | 'pending'
  /** ISO 8601 */
  created_at: string
  /** ISO 8601 */
  last_used?: string
  /** Whether this is the default account when none is specified */
  is_default: boolean
}

/** Account registry file structure */
export interface AccountRegistry {
  accounts: OAuthAccount[]
  default_account?: string
  /** ISO 8601 */
  last_updated: string
}

/** Login result returned by OAuthEngine login methods */
export interface LoginResult {
  success: boolean
  account_name: string
  email?: string
  error?: string
  mode: 'pkce' | 'device_code'
}

/** Options for OAuthEngine constructor */
export interface OAuthEngineOptions {
  /** Directory to store OAuth data. Default: ~/.config/autodev/oauth */
  storage_dir?: string
  /** Ports to try for PKCE callback server. Default: [1455, 1456, 1457] */
  callback_ports?: number[]
  /** Path for callback. Default: '/auth/callback' */
  callback_path?: string
  /** Timeout waiting for callback (ms). Default: 300000 (5 min) */
  callback_timeout_ms?: number
  /** Device code poll interval (ms). Default: 5000 */
  device_poll_interval_ms?: number
  /** Buffer before considering token "near expiry" (ms). Default: 300000 (5 min) */
  expiry_buffer_ms?: number
  /** Override fetch for testing */
  fetch_fn?: typeof fetch
  /** Override browser open for testing */
  open_browser?: (url: string) => void
}

/** Thrown when browser cannot be opened (headless, SSH, etc.) */
export class BrowserOpenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrowserOpenError'
  }
}

/** Thrown when all callback ports are already in use */
export class PortExhaustedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PortExhaustedError'
  }
}
