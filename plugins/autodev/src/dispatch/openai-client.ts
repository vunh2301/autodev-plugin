// src/dispatch/openai-client.ts — OpenAI HTTP client with OAuth token and retry on 401

import { getAccessToken } from '../oauth/index.js'

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions'

export interface ChatCompletionRequest {
  model: string
  messages: Array<{ role: string; content: string }>
  temperature?: number
  max_tokens?: number
}

export interface ChatCompletionResponse {
  choices: Array<{ message: { role: string; content: string } }>
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

/**
 * Call OpenAI Chat Completions API with OAuth token.
 *
 * Retry logic:
 *   - 401 (token expired/revoked) -> force refresh -> retry ONCE
 *   - 429 (rate limit) -> log warning, respect Retry-After header, do NOT retry
 *   - Other 4xx/5xx -> throw immediately
 *
 * @param request - Chat completion request body
 * @param accountName - OAuth account name (optional, uses default)
 * @param fetchFn - Override fetch for testing
 * @returns Chat completion response
 */
export async function callOpenAI(
  request: ChatCompletionRequest,
  accountName?: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<ChatCompletionResponse> {
  // Get token (auto-refresh if near expiry)
  let token = await getAccessToken(accountName)

  let resp = await fetchFn(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(request),
  })

  // Retry once on 401 with force refresh
  if (resp.status === 401) {
    console.error('[OPENAI] 401 Unauthorized — force refreshing token and retrying...')
    token = await getAccessToken(accountName, true)
    resp = await fetchFn(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(request),
    })
  }

  // Rate limit warning (no retry)
  if (resp.status === 429) {
    const retryAfter = resp.headers.get('Retry-After')
    console.error(
      `[OPENAI] 429 Rate limited.${retryAfter ? ` Retry-After: ${retryAfter}s` : ''}`
    )
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`OpenAI API error: HTTP ${resp.status} — ${text}`)
  }

  return await resp.json() as ChatCompletionResponse
}
