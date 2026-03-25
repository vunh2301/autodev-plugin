#!/usr/bin/env node
// proxy.mjs — Mini Claude-to-OpenAI proxy for autodev
// Translates Anthropic Messages API → OpenAI Chat Completions API
// Usage: node proxy.mjs [--port 4141] [--target-model gpt-5.4] [--account default]
//
// Then configure Claude Code:
//   ANTHROPIC_BASE_URL=http://localhost:4141
//   ANTHROPIC_API_KEY=dummy  (proxy handles auth via OAuth)

import { createServer } from 'node:http'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)
function getArg(name, fallback) {
  const i = argv.indexOf(name)
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : fallback
}

const PORT = parseInt(getArg('--port', '4141'))
const TARGET_MODEL = getArg('--target-model', 'gpt-5.4')
const EXEC_MODEL = getArg('--exec-model', 'gpt-5.3-codex')
const ACCOUNT = getArg('--account', 'default')
const OPENAI_URL = getArg('--target-url', 'https://api.openai.com/v1/chat/completions')
const LOG_LEVEL = getArg('--log', 'info') // 'debug' | 'info' | 'quiet'

// Model mapping: Anthropic model names → OpenAI model names
// Opus (heavy lifting / implementing) → codex model
// Others → general model
const MODEL_MAP = {
  'claude-opus-4': EXEC_MODEL,
  'claude-opus-4-6': EXEC_MODEL,
  'claude-sonnet-4': TARGET_MODEL,
  'claude-sonnet-4-5': TARGET_MODEL,
  'claude-sonnet-4-6': TARGET_MODEL,
  'claude-haiku-4-5': TARGET_MODEL,
  'claude-haiku-4-5-20251001': TARGET_MODEL,
}

function log(level, ...args) {
  if (LOG_LEVEL === 'quiet') return
  if (level === 'debug' && LOG_LEVEL !== 'debug') return
  console.error(`[proxy] ${args.join(' ')}`)
}

// ---------------------------------------------------------------------------
// OAuth token
// ---------------------------------------------------------------------------
function getToken() {
  const oauthScript = resolve(__dirname, 'oauth.mjs')
  try {
    readFileSync(oauthScript, { flag: 'r' })
  } catch {
    // No oauth.mjs — try env var
    const key = process.env.OPENAI_API_KEY
    if (key) return key
    throw new Error('No oauth.mjs found and no OPENAI_API_KEY set')
  }

  try {
    const result = execSync(
      `node "${oauthScript}" get-token ${ACCOUNT}`,
      { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    const parsed = JSON.parse(result.trim())
    if (parsed.ok && parsed.data?.token) return parsed.data.token
  } catch (err) {
    log('info', 'OAuth fail:', err.message)
  }

  const key = process.env.OPENAI_API_KEY
  if (key) return key
  throw new Error('No credentials — run /autodev-auth codex login')
}

// ---------------------------------------------------------------------------
// Translate: Anthropic Messages → OpenAI Chat Completions
// ---------------------------------------------------------------------------
function translateRequest(body) {
  const messages = []

  // System prompt
  if (body.system) {
    const systemText = typeof body.system === 'string'
      ? body.system
      : Array.isArray(body.system)
        ? body.system.map(b => b.text || '').join('\n')
        : ''
    if (systemText) messages.push({ role: 'system', content: systemText })
  }

  // Messages
  for (const msg of body.messages || []) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      // Content can be string or array of blocks
      if (typeof msg.content === 'string') {
        messages.push({ role: msg.role, content: msg.content })
        continue
      }

      if (!Array.isArray(msg.content)) {
        messages.push({ role: msg.role, content: String(msg.content || '') })
        continue
      }

      // Process content blocks
      const textParts = []
      const toolCalls = []
      const toolResults = []

      for (const block of msg.content) {
        if (block.type === 'text') {
          textParts.push(block.text)
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: typeof block.input === 'string'
                ? block.input
                : JSON.stringify(block.input),
            },
          })
        } else if (block.type === 'tool_result') {
          const resultContent = typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map(c => c.text || '').join('\n')
              : JSON.stringify(block.content || '')
          toolResults.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: resultContent,
          })
        }
      }

      // Assistant message with tool calls
      if (msg.role === 'assistant') {
        const m = {}
        m.role = 'assistant'
        if (textParts.length) m.content = textParts.join('\n')
        else m.content = null
        if (toolCalls.length) m.tool_calls = toolCalls
        messages.push(m)
      } else {
        // User message
        if (textParts.length) {
          messages.push({ role: 'user', content: textParts.join('\n') })
        }
        // Tool results become separate tool messages
        for (const tr of toolResults) {
          messages.push(tr)
        }
      }
    }
  }

  // Tools
  let tools
  if (body.tools && body.tools.length > 0) {
    tools = body.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || t.parameters || {},
      },
    }))
  }

  // Map model
  const model = MODEL_MAP[body.model] || TARGET_MODEL

  const req = {
    model,
    messages,
    stream: body.stream !== false,
    max_tokens: body.max_tokens || 4096,
  }
  if (body.temperature != null) req.temperature = body.temperature
  if (body.top_p != null) req.top_p = body.top_p
  if (tools) req.tools = tools

  return req
}

// ---------------------------------------------------------------------------
// Translate: OpenAI SSE → Anthropic SSE (streaming)
// ---------------------------------------------------------------------------
function createStreamTranslator(res, requestModel) {
  const msgId = 'msg_' + Math.random().toString(36).slice(2, 14)
  let contentIndex = 0
  let currentToolCall = null
  let toolCallArgs = ''
  let inputTokens = 0
  let outputTokens = 0
  let started = false

  function send(event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  function startMessage() {
    if (started) return
    started = true
    send('message_start', {
      type: 'message_start',
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: requestModel,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
  }

  function startContentBlock(type, extra = {}) {
    send('content_block_start', {
      type: 'content_block_start',
      index: contentIndex,
      content_block: { type, ...extra },
    })
  }

  function stopContentBlock() {
    send('content_block_stop', {
      type: 'content_block_stop',
      index: contentIndex,
    })
    contentIndex++
  }

  return {
    processChunk(chunk) {
      // Parse OpenAI SSE chunk
      const lines = chunk.split('\n')
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const payload = line.slice(6).trim()
        if (payload === '[DONE]') {
          // Finish any open tool call
          if (currentToolCall) {
            let parsedInput = {}
            try { parsedInput = JSON.parse(toolCallArgs) } catch { parsedInput = { raw: toolCallArgs } }
            send('content_block_delta', {
              type: 'content_block_delta',
              index: contentIndex,
              delta: { type: 'input_json_delta', partial_json: toolCallArgs },
            })
            stopContentBlock()
            currentToolCall = null
            toolCallArgs = ''
          }

          // Message stop
          send('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: outputTokens },
          })
          send('message_stop', { type: 'message_stop' })
          return
        }

        let data
        try { data = JSON.parse(payload) } catch { continue }

        // Usage info
        if (data.usage) {
          inputTokens = data.usage.prompt_tokens || inputTokens
          outputTokens = data.usage.completion_tokens || outputTokens
        }

        const delta = data.choices?.[0]?.delta
        const finishReason = data.choices?.[0]?.finish_reason
        if (!delta && !finishReason) continue

        startMessage()

        // Text content
        if (delta?.content) {
          // Close tool call if was open
          if (currentToolCall) {
            stopContentBlock()
            currentToolCall = null
            toolCallArgs = ''
          }

          // Start text block if first text
          if (contentIndex === 0 || currentToolCall !== null) {
            startContentBlock('text', { text: '' })
          }

          send('content_block_delta', {
            type: 'content_block_delta',
            index: contentIndex,
            delta: { type: 'text_delta', text: delta.content },
          })
        }

        // Tool calls
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.id) {
              // New tool call — close previous text block if open
              if (contentIndex > 0 && !currentToolCall) {
                stopContentBlock()
              } else if (currentToolCall) {
                stopContentBlock()
              }

              currentToolCall = { id: tc.id, name: tc.function?.name || '' }
              toolCallArgs = tc.function?.arguments || ''
              startContentBlock('tool_use', { id: tc.id, name: currentToolCall.name, input: {} })
            } else if (tc.function?.arguments) {
              toolCallArgs += tc.function.arguments
              send('content_block_delta', {
                type: 'content_block_delta',
                index: contentIndex,
                delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
              })
            }
          }
        }

        // Finish
        if (finishReason) {
          if (currentToolCall) {
            stopContentBlock()
            currentToolCall = null
          } else if (started) {
            stopContentBlock()
          }

          const stopReason = finishReason === 'tool_calls' ? 'tool_use'
            : finishReason === 'length' ? 'max_tokens'
            : 'end_turn'

          send('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: outputTokens },
          })
          send('message_stop', { type: 'message_stop' })
        }
      }
    },

    ensureStarted() {
      startMessage()
      startContentBlock('text', { text: '' })
    },
  }
}

// ---------------------------------------------------------------------------
// Translate: OpenAI → Anthropic (non-streaming)
// ---------------------------------------------------------------------------
function translateResponse(openaiResp, requestModel) {
  const choice = openaiResp.choices?.[0]
  if (!choice) {
    return {
      id: 'msg_' + Math.random().toString(36).slice(2, 14),
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
      model: requestModel,
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    }
  }

  const content = []
  if (choice.message?.content) {
    content.push({ type: 'text', text: choice.message.content })
  }
  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input = {}
      try { input = JSON.parse(tc.function.arguments) } catch { input = { raw: tc.function.arguments } }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      })
    }
  }
  if (content.length === 0) {
    content.push({ type: 'text', text: '' })
  }

  const stopReason = choice.finish_reason === 'tool_calls' ? 'tool_use'
    : choice.finish_reason === 'length' ? 'max_tokens'
    : 'end_turn'

  return {
    id: 'msg_' + Math.random().toString(36).slice(2, 14),
    type: 'message',
    role: 'assistant',
    content,
    model: requestModel,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openaiResp.usage?.prompt_tokens || 0,
      output_tokens: openaiResp.usage?.completion_tokens || 0,
    },
  }
}

// ---------------------------------------------------------------------------
// Proxy handler
// ---------------------------------------------------------------------------
async function handleRequest(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  // Only handle POST to /v1/messages
  if (req.method !== 'POST' || !req.url.includes('/v1/messages')) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found. Use POST /v1/messages' }))
    return
  }

  // Read body
  let rawBody = ''
  for await (const chunk of req) rawBody += chunk

  let body
  try { body = JSON.parse(rawBody) } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Invalid JSON' }))
    return
  }

  const requestModel = body.model || 'claude-sonnet-4'
  const isStream = body.stream !== false

  log('info', `${requestModel} → ${TARGET_MODEL} | stream=${isStream} | tools=${(body.tools || []).length}`)
  log('debug', `messages: ${(body.messages || []).length}`)

  // Get OAuth token
  let token
  try {
    token = getToken()
  } catch (err) {
    log('info', 'Auth error:', err.message)
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'authentication_error', message: err.message },
    }))
    return
  }

  // Translate request
  const openaiReq = translateRequest(body)

  // Forward to OpenAI
  try {
    const upstream = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(openaiReq),
    })

    if (!upstream.ok) {
      const errText = await upstream.text()
      log('info', `OpenAI error: ${upstream.status} ${errText.slice(0, 200)}`)

      // 401 — retry with fresh token
      if (upstream.status === 401) {
        try {
          const freshToken = getToken()
          const retry = await fetch(OPENAI_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${freshToken}`,
            },
            body: JSON.stringify(openaiReq),
          })
          if (!retry.ok) {
            const retryErr = await retry.text()
            res.writeHead(retry.status, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              type: 'error',
              error: { type: 'api_error', message: retryErr },
            }))
            return
          }
          // Continue with retry response
          return handleUpstreamResponse(retry, res, isStream, requestModel)
        } catch {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            type: 'error',
            error: { type: 'authentication_error', message: 'Token refresh failed' },
          }))
          return
        }
      }

      res.writeHead(upstream.status >= 500 ? 500 : upstream.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: errText.slice(0, 500) },
      }))
      return
    }

    await handleUpstreamResponse(upstream, res, isStream, requestModel)

  } catch (err) {
    log('info', 'Fetch error:', err.message)
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'api_error', message: `Upstream error: ${err.message}` },
    }))
  }
}

async function handleUpstreamResponse(upstream, res, isStream, requestModel) {
  if (isStream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })

    const translator = createStreamTranslator(res, requestModel)

    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // Process complete lines
        const lines = buffer.split('\n')
        buffer = lines.pop() // Keep incomplete line
        if (lines.length) {
          translator.processChunk(lines.join('\n'))
        }
      }
      // Process remaining
      if (buffer.trim()) translator.processChunk(buffer)
    } catch (err) {
      log('info', 'Stream error:', err.message)
    }

    res.end()
  } else {
    const data = await upstream.json()
    const anthropicResp = translateResponse(data, requestModel)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(anthropicResp))
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = createServer(handleRequest)

server.listen(PORT, '127.0.0.1', () => {
  console.log(`
  Autodev Proxy — Claude → OpenAI Translation
  ─────────────────────────────────────────────
  Listening:    http://localhost:${PORT}
  Target:       ${OPENAI_URL}
  Execute:      opus → ${EXEC_MODEL}
  General:      * → ${TARGET_MODEL}
  Account:      ${ACCOUNT}

  Configure Claude Code:
    export ANTHROPIC_BASE_URL=http://localhost:${PORT}
    export ANTHROPIC_API_KEY=proxy

  Or in .claude/settings.json:
    { "env": { "ANTHROPIC_BASE_URL": "http://localhost:${PORT}", "ANTHROPIC_API_KEY": "proxy" } }
  ─────────────────────────────────────────────
`)
})
