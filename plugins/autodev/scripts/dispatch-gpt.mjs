#!/usr/bin/env node

// scripts/dispatch-gpt.mjs — Standalone GPT dispatch script for autodev cross-model review
// Usage: node dispatch-gpt.mjs --prompt-file <path> --output-file <path> [options]
//
// Options:
//   --prompt-file <path>   Input prompt JSON file (required)
//   --output-file <path>   Output response JSON file (required)
//   --account <name>       OAuth account name (optional)
//   --timeout <ms>         API call timeout in ms (default: 120000)
//   --base-url <url>       API endpoint URL (default: https://api.openai.com/v1/chat/completions)
//                          Supports any OpenAI-compatible provider (e.g. local LLM, Azure, etc.)
//   --api-key-env <name>   Env var name for API key fallback (default: OPENAI_API_KEY)
//
// Exit codes:
//   0 = success (response written to output file)
//   1 = no credentials (OAuth fail + no API key)
//   2 = API error (non-2xx after retries, 403, 429)
//   3 = timeout (AbortController abort)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve oauth.mjs — same directory as this script (both live in plugin scripts/)
function resolveOAuthScript() {
  const sameDirPath = resolve(__dirname, 'oauth.mjs');
  try {
    readFileSync(sameDirPath, { flag: 'r' });
    return sameDirPath;
  } catch { /* not found */ }
  return null;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) {
      args[argv[i]] = argv[i + 1];
      i++; // skip value
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Token acquisition — OAuth first, then OPENAI_API_KEY fallback
// ---------------------------------------------------------------------------
function getToken(account, apiKeyEnv) {
  // Try OAuth first
  const oauthScript = resolveOAuthScript();
  if (oauthScript) {
    try {
      const accountArg = account ? ` ${account}` : '';
      const result = execSync(`node "${oauthScript}" get-token${accountArg}`, {
        encoding: 'utf-8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const parsed = JSON.parse(result.trim());
      if (parsed.ok && parsed.data?.token) {
        return { token: parsed.data.token, source: 'oauth' };
      }
    } catch (err) {
      console.error('[dispatch-gpt] OAuth token fail:', err.message);
    }
  } else {
    console.error('[dispatch-gpt] oauth.mjs not found — skipping OAuth');
  }

  // Fallback: API key from env var (configurable via --api-key-env)
  const envName = apiKeyEnv || 'OPENAI_API_KEY';
  const apiKey = process.env[envName];
  if (apiKey) {
    console.error(`[dispatch-gpt] Fallback to ${envName}`);
    return { token: apiKey, source: 'api_key' };
  }

  // No credentials
  return null;
}

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------
function writeOutput(filePath, result) {
  const out = resolve(filePath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(result.response, null, 2), 'utf-8');
  try {
    if (process.platform !== 'win32') execSync(`chmod 600 "${out}"`);
  } catch { /* ignore */ }
}

function writeError(filePath, reason) {
  if (!filePath) return;
  const out = resolve(filePath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ error: true, reason }, null, 2), 'utf-8');
  try {
    if (process.platform !== 'win32') execSync(`chmod 600 "${out}"`);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// API call with retry + timeout
// ---------------------------------------------------------------------------
const DEFAULT_BASE_URL = 'https://api.openai.com/v1/chat/completions';

async function callAPI(prompt, tokenInfo, timeoutMs, outputFile, account, baseUrl, apiKeyEnv) {
  const url = baseUrl || DEFAULT_BASE_URL;
  const startTime = Date.now();

  async function doFetch(token) {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(prompt),
        signal: controller.signal,
      });
      clearTimeout(tid);
      return resp;
    } catch (err) {
      clearTimeout(tid);
      if (err.name === 'AbortError') {
        writeError(outputFile, 'timeout');
        console.error('[dispatch-gpt] Timeout after', timeoutMs, 'ms');
        process.exit(3);
      }
      throw err;
    }
  }

  let resp = await doFetch(tokenInfo.token);

  // 401 — force refresh + retry once
  if (resp.status === 401 && tokenInfo.source === 'oauth') {
    console.error('[dispatch-gpt] 401 — force refresh token');
    const refreshed = getToken(account, apiKeyEnv);
    if (refreshed) {
      resp = await doFetch(refreshed.token);
    }
  }

  // 403 — distinguish scope vs revoked
  if (resp.status === 403) {
    const body = await resp.text();
    const isScope = body.includes('scope') || body.includes('insufficient_scope');
    const reason = isScope ? 'forbidden_scope' : 'forbidden_revoked';
    console.error(`[dispatch-gpt] 403: ${isScope ? 'OAuth scope khong du' : 'Token bi revoke'}`);
    writeError(outputFile, reason);
    process.exit(2);
  }

  // 5xx — retry once (respect Retry-After)
  if (resp.status >= 500) {
    const retryAfter = resp.headers.get('Retry-After');
    const waitMs = retryAfter
      ? Math.min(parseInt(retryAfter, 10) * 1000, 30000)
      : 3000;
    console.error(`[dispatch-gpt] ${resp.status} — retry sau ${waitMs}ms`);
    await new Promise(r => setTimeout(r, waitMs));
    resp = await doFetch(tokenInfo.token);
  }

  // 429 — rate limited, no retry
  if (resp.status === 429) {
    console.error('[dispatch-gpt] 429 rate limited');
    writeError(outputFile, 'rate_limited');
    process.exit(2);
  }

  // Any non-2xx after retry — exit 2
  if (!resp.ok) {
    console.error(`[dispatch-gpt] HTTP ${resp.status}`);
    writeError(outputFile, `http_${resp.status}`);
    process.exit(2);
  }

  const data = await resp.json();
  const latencyMs = Date.now() - startTime;

  return {
    response: data,
    usage: data.usage || {},
    latency_ms: latencyMs,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv);
  const promptFile = args['--prompt-file'];
  const outputFile = args['--output-file'];
  const account = args['--account'] || null;
  const timeoutMs = parseInt(args['--timeout'], 10) || 120000;
  const baseUrl = args['--base-url'] || process.env.DISPATCH_GPT_BASE_URL || DEFAULT_BASE_URL;
  const apiKeyEnv = args['--api-key-env'] || null;

  if (!promptFile || !outputFile) {
    console.error('[dispatch-gpt] Usage: --prompt-file <path> --output-file <path> [--base-url <url>] [--api-key-env <name>] [--account <name>] [--timeout <ms>]');
    process.exit(1);
  }

  // 1. Read prompt JSON
  let prompt;
  try {
    prompt = JSON.parse(readFileSync(resolve(promptFile), 'utf-8'));
  } catch (err) {
    console.error('[dispatch-gpt] Cannot read prompt file:', err.message);
    writeError(outputFile, 'invalid_prompt');
    process.exit(2);
  }

  // 2. Get token
  console.error(`[dispatch-gpt] API: ${baseUrl}`);
  const tokenInfo = getToken(account, apiKeyEnv);
  if (!tokenInfo) {
    console.error('[dispatch-gpt] No credentials available');
    writeError(outputFile, 'no_credentials');
    process.exit(1);
  }

  // 3. Call API with retry
  const result = await callAPI(prompt, tokenInfo, timeoutMs, outputFile, account, baseUrl, apiKeyEnv);

  // 4. Write response
  writeOutput(outputFile, result);
  console.log(JSON.stringify({ ok: true, usage: result.usage, latency_ms: result.latency_ms }));
  process.exit(0);
}

main().catch(err => {
  console.error('[dispatch-gpt] Fatal:', err.message);
  process.exit(2);
});
