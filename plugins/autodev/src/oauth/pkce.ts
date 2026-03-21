// src/oauth/pkce.ts — PKCE verifier/challenge generation (RFC 7636)

import { randomBytes, createHash } from 'node:crypto'

/** Base64url encode (RFC 7636 — no padding) */
function base64url(buffer: Buffer): string {
  return buffer.toString('base64url')
}

/**
 * Generate PKCE verifier + challenge pair.
 * Verifier: 96 random bytes -> base64url (128 chars)
 * Challenge: SHA-256(verifier) -> base64url
 */
export function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(96))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/**
 * Generate CSRF state parameter.
 * 32 random bytes -> base64url (43 chars)
 */
export function generateState(): string {
  return base64url(randomBytes(32))
}
