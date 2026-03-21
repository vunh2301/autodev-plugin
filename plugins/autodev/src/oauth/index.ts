// src/oauth/index.ts — Public API with fallback chain (OAuth -> API key -> error)

import { OAuthEngine } from './engine.js'

// Singleton instance, lazy-initialized
let engine: OAuthEngine | null = null

/**
 * Get access token for OpenAI API.
 *
 * Fallback chain:
 *   1. OAuth token (from .workflow/oauth/) — auto-refresh if needed
 *   2. Environment variable OPENAI_API_KEY
 *   3. Throw error with actionable message
 *
 * @param accountName - OAuth account name. Undefined = default account.
 * @param forceRefresh - When true, force refresh even if not near expiry.
 * @returns Bearer token string (OAuth access_token or API key)
 */
export async function getAccessToken(accountName?: string, forceRefresh?: boolean): Promise<string> {
  // 1. Try OAuth token
  try {
    if (!engine) engine = new OAuthEngine()
    return await engine.getAccessToken(accountName, forceRefresh)
  } catch {
    // OAuth not available — try fallback
  }

  // 2. Try env var
  const apiKey = process.env.OPENAI_API_KEY
  if (apiKey) return apiKey

  // 3. Fail
  throw new Error(
    'Khong co OpenAI credentials. Chay "/autodev oauth login" hoac set OPENAI_API_KEY.'
  )
}

// Re-export types for consumers
export type { OAuthCredentials, OAuthAccount, LoginResult } from './types.js'
export { OAuthEngine } from './engine.js'
