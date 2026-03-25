#!/usr/bin/env node
// proxy.mjs — Full Claude-to-Codex proxy for autodev
// Extracted from aiproxy: Anthropic Messages API ↔ OpenAI Responses API
// Endpoint: https://chatgpt.com/backend-api/codex/responses
//
// Usage: node proxy.mjs [--port 4141] [--target-model gpt-5.4] [--account default]

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
const CODEX_API_URL = getArg('--target-url', 'https://chatgpt.com/backend-api/codex/responses')
const LOG_LEVEL = getArg('--log', 'info')

// Model mapping: Claude model → Codex model
// Opus (heavy lifting) → exec model, others → general model
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
let cachedToken = null
let cachedTokenExpiry = 0

function getToken() {
  // Check cache (5 min buffer)
  if (cachedToken && Date.now() < cachedTokenExpiry - 300_000) return cachedToken

  const oauthScript = resolve(__dirname, 'oauth.mjs')
  try { readFileSync(oauthScript, { flag: 'r' }) } catch {
    const key = process.env.OPENAI_API_KEY
    if (key) return key
    throw new Error('No oauth.mjs and no OPENAI_API_KEY')
  }

  try {
    const result = execSync(
      `node "${oauthScript}" get-token ${ACCOUNT}`,
      { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    const parsed = JSON.parse(result.trim())
    if (parsed.ok && parsed.data?.token) {
      cachedToken = parsed.data.token
      cachedTokenExpiry = Date.now() + 3600_000 // 1 hour
      return cachedToken
    }
  } catch (err) { log('info', 'OAuth fail:', err.message) }

  const key = process.env.OPENAI_API_KEY
  if (key) return key
  throw new Error('No credentials — run: autodev-codex auth login')
}

function extractAccountId(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    return payload?.['https://api.openai.com/auth']?.chatgpt_account_id
  } catch { return undefined }
}

// ---------------------------------------------------------------------------
// Utils (from aiproxy translator/utils.ts)
// ---------------------------------------------------------------------------
function stripCacheControl(obj) {
  if (obj === null || obj === undefined || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map(item => stripCacheControl(item))
  const result = {}
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'cache_control') continue
    result[key] = stripCacheControl(value)
  }
  return result
}

// ---------------------------------------------------------------------------
// Skill directive rewriting (from aiproxy clients/claude-cli.ts)
// Non-Claude models follow "You must run" literally → rewrite to optional
// ---------------------------------------------------------------------------
const MANDATORY_SKILL_RE = /You must run the Skill\(([^)]*)\) tool\./g
const SKILL_INJECTION_COMMENT_RE = /<!--\s*skillInjection:.*?-->/gs

function rewriteSkillDirectives(text) {
  return text
    .replace(MANDATORY_SKILL_RE, (_match, skillName) =>
      `The skill "${skillName}" is available if relevant to the current task.`)
    .replace(SKILL_INJECTION_COMMENT_RE, '')
    .replace(/\n{3,}/g, '\n\n')
}

function rewriteSkillDirectivesInBody(body) {
  if (!body || typeof body !== 'object') return body
  const result = { ...body }

  // Rewrite in system prompt
  if (typeof result.system === 'string') {
    result.system = rewriteSkillDirectives(result.system)
  } else if (Array.isArray(result.system)) {
    result.system = result.system.map(p =>
      p.type === 'text' && typeof p.text === 'string'
        ? { ...p, text: rewriteSkillDirectives(p.text) }
        : p)
  }

  // Rewrite in messages
  if (Array.isArray(result.messages)) {
    result.messages = result.messages.map(msg => {
      if (typeof msg.content === 'string') {
        return { ...msg, content: rewriteSkillDirectives(msg.content) }
      }
      if (Array.isArray(msg.content)) {
        return {
          ...msg,
          content: msg.content.map(part =>
            part.type === 'text' && typeof part.text === 'string'
              ? { ...part, text: rewriteSkillDirectives(part.text) }
              : part),
        }
      }
      return msg
    })
  }

  return result
}

function safeParse(str, fallback = {}) {
  try { return JSON.parse(str) } catch { return fallback }
}

function dedupSkillCalls(input) {
  const callIdToSkill = new Map()
  for (const item of input) {
    if (item.type === 'function_call' && item.name === 'Skill') {
      try {
        const args = JSON.parse(item.arguments)
        if (args.skill) callIdToSkill.set(item.call_id, args.skill)
      } catch {}
    }
  }
  const seenSkills = new Set()
  const duplicateCallIds = new Set()
  for (const item of input) {
    if (item.type === 'function_call_output') {
      const skillName = callIdToSkill.get(item.call_id)
      if (skillName) {
        if (seenSkills.has(skillName)) duplicateCallIds.add(item.call_id)
        else seenSkills.add(skillName)
      }
    }
  }
  if (duplicateCallIds.size > 0) {
    for (let i = input.length - 1; i >= 0; i--) {
      if (input[i].call_id && duplicateCallIds.has(input[i].call_id)) input.splice(i, 1)
    }
  }
}

// ---------------------------------------------------------------------------
// Translate: Anthropic Messages → Responses API (hub format)
// From aiproxy translator/to-hub/anthropic-messages.ts
// ---------------------------------------------------------------------------
function anthropicToHub(body) {
  const raw = { ...body }
  const messages = Array.isArray(raw.messages) ? raw.messages : []

  let instructions
  if (raw.system !== undefined) {
    if (typeof raw.system === 'string') instructions = raw.system
    else if (Array.isArray(raw.system)) {
      instructions = raw.system.filter(p => p.type === 'text').map(p => p.text || '').join('\n')
    }
  }

  const input = []
  let callIdCounter = 0

  for (const msg of messages) {
    const role = msg.role
    const contentParts = Array.isArray(msg.content)
      ? msg.content
      : typeof msg.content === 'string'
        ? [{ type: 'text', text: msg.content }]
        : []

    if (role === 'system') {
      const text = contentParts.filter(p => p.type === 'text').map(p => p.text).join('\n')
      if (text) instructions = instructions ? instructions + '\n' + text : text
      continue
    }

    if (role === 'user') {
      let userContent = []
      const flushUserContent = () => {
        if (userContent.length > 0) { input.push({ role: 'user', content: userContent }); userContent = [] }
      }

      for (const part of contentParts) {
        if (part.type === 'tool_result') {
          flushUserContent()
          input.push({
            type: 'function_call_output',
            call_id: part.tool_use_id,
            output: typeof part.content === 'string' ? part.content : JSON.stringify(part.content),
          })
        } else if (part.type === 'text') {
          userContent.push({ type: 'input_text', text: part.text })
        } else if (part.type === 'image') {
          const source = part.source
          const imageUrl = source.type === 'url' ? source.url : `data:${source.media_type};base64,${source.data}`
          userContent.push({ type: 'input_image', image_url: imageUrl })
        }
      }
      flushUserContent()

    } else if (role === 'assistant') {
      const assistantContent = []
      const pendingFunctionCalls = []

      for (const part of contentParts) {
        if (part.type === 'tool_use') {
          const name = (typeof part.name === 'string' && part.name) ? part.name : 'unknown_function'
          const callId = (typeof part.id === 'string' && part.id) ? part.id : `call_${name}_${callIdCounter++}`
          pendingFunctionCalls.push({
            type: 'function_call',
            call_id: callId,
            name,
            arguments: typeof part.input === 'string' ? part.input : JSON.stringify(part.input),
          })
        } else if (part.type === 'text') {
          assistantContent.push({ type: 'output_text', text: part.text })
        }
      }

      if (assistantContent.length > 0) input.push({ role: 'assistant', content: assistantContent })
      for (const fc of pendingFunctionCalls) input.push(fc)
    }
  }

  // Dedup repeated Skill tool calls
  dedupSkillCalls(input)

  // Inject placeholder outputs for unmatched function calls
  const functionCallIds = new Set()
  const functionOutputIds = new Set()
  for (const item of input) {
    if (item.type === 'function_call') functionCallIds.add(item.call_id)
    else if (item.type === 'function_call_output') functionOutputIds.add(item.call_id)
  }
  for (const callId of functionCallIds) {
    if (!functionOutputIds.has(callId)) {
      input.push({ type: 'function_call_output', call_id: callId, output: '[No response received]' })
    }
  }

  // Convert tools
  let tools
  if (Array.isArray(raw.tools) && raw.tools.length > 0) {
    tools = raw.tools
      .map(t => {
        const name = typeof t.name === 'string' ? t.name : ''
        if (!name) return null
        return stripCacheControl({
          type: 'function',
          name,
          description: t.description,
          parameters: t.input_schema || t.parameters || {},
        })
      })
      .filter(t => t !== null)
  }

  // Map model
  const model = MODEL_MAP[raw.model] || TARGET_MODEL

  const result = {
    model,
    input: stripCacheControl(input),
    store: false,
    stream: true, // Codex always streams
  }

  if (instructions !== undefined) result.instructions = instructions
  if (tools) result.tools = tools

  return result
}

// ---------------------------------------------------------------------------
// Codex body preparation (from aiproxy providers/codex.ts)
// ---------------------------------------------------------------------------
const ALLOWED_FIELDS = new Set([
  'model', 'instructions', 'input', 'stream', 'store',
  'tools', 'tool_choice', 'previous_response_id',
  'reasoning', 'text', 'truncation', 'metadata',
  'parallel_tool_calls',
])

function prepareCodexBody(body) {
  const out = {}
  for (const key of Object.keys(body)) {
    if (ALLOWED_FIELDS.has(key)) out[key] = body[key]
  }
  if (out.instructions === undefined) out.instructions = ''
  out.stream = true
  out.store = false
  return out
}

// ---------------------------------------------------------------------------
// Stream translator: Responses API SSE → Claude SSE
// From aiproxy translator/stream/responses-to-claude.ts
// ---------------------------------------------------------------------------
function claudeFrame(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
}

function parseResponsesFrame(frame) {
  for (const line of frame.split('\n')) {
    if (line.startsWith('data: ')) {
      try { return JSON.parse(line.slice(6)) } catch { return null }
    }
  }
  return null
}

class ResponsesToClaudeStream {
  constructor(requestModel) {
    this.requestModel = requestModel
    this.responseId = ''
    this.textBuf = ''
    this.contentIndex = 0
    this.blockCounter = 0
    this.toolBlockStartEmitted = false
    this.inputTokenEstimate = 0
    this._inputTokens = 0
    this._outputTokens = 0
    this.completedTools = []
    // Tool state
    this.toolId = ''
    this.toolName = ''
    this.argBuf = ''
    this.blockType = 'none'
    // Skill dedup
    this.loadedSkills = new Set()
    this.bufferingSkillCall = false
  }

  translateChunk(frame) {
    const d = parseResponsesFrame(frame)
    if (!d) return []
    const type = d.type

    switch (type) {
      case 'response.created': return this.handleCreated(d)
      case 'response.output_item.added': return this.handleOutputItemAdded(d)
      case 'response.content_part.added': return this.handleContentPartAdded(d)
      case 'response.output_text.delta': return this.handleTextDelta(d)
      case 'response.output_text.done': return []
      case 'response.content_part.done': return this.handleContentPartDone()
      case 'response.output_item.done': return []
      case 'response.function_call_arguments.delta': return this.handleFnArgsDelta(d)
      case 'response.function_call_arguments.done': return this.handleFnArgsDone(d)
      case 'response.completed': return this.handleCompleted(d)
      default: return []
    }
  }

  handleCreated(d) {
    const resp = d.response || {}
    this.responseId = resp.id || ''
    return [{
      frame: claudeFrame('message_start', {
        type: 'message_start',
        message: {
          id: this.responseId,
          type: 'message',
          role: 'assistant',
          content: [],
          model: resp.model || this.requestModel,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: this.inputTokenEstimate, output_tokens: 0 },
        },
      }),
    }]
  }

  handleOutputItemAdded(d) {
    const item = d.item
    if (item?.type === 'function_call') {
      this.toolId = item.call_id || ''
      this.toolName = item.name || ''
      this.blockType = 'tool_use'
      this.argBuf = ''
      this.toolBlockStartEmitted = false
      this.bufferingSkillCall = this.toolName === 'Skill' && this.loadedSkills.size > 0
      this.contentIndex = this.blockCounter++
    }
    return []
  }

  handleContentPartAdded(d) {
    const part = d.part
    if (part?.type === 'output_text') {
      this.blockType = 'text'
      this.textBuf = ''
      this.contentIndex = this.blockCounter++
      return [{
        frame: claudeFrame('content_block_start', {
          type: 'content_block_start',
          index: this.contentIndex,
          content_block: { type: 'text', text: '' },
        }),
      }]
    }
    return []
  }

  handleTextDelta(d) {
    const delta = d.delta
    this.textBuf += delta
    return [{
      frame: claudeFrame('content_block_delta', {
        type: 'content_block_delta',
        index: this.contentIndex,
        delta: { type: 'text_delta', text: delta },
      }),
    }]
  }

  handleContentPartDone() {
    if (this.blockType === 'text') {
      this.blockType = 'none'
      return [{
        frame: claudeFrame('content_block_stop', {
          type: 'content_block_stop',
          index: this.contentIndex,
        }),
      }]
    }
    return []
  }

  handleFnArgsDelta(d) {
    const delta = d.delta
    const chunks = []

    if (this.blockType !== 'tool_use') {
      this.blockType = 'tool_use'
      this.argBuf = ''
      this.contentIndex = this.blockCounter++
    }

    if (this.bufferingSkillCall) {
      this.argBuf += delta
      return []
    }

    if (!this.toolBlockStartEmitted) {
      this.toolBlockStartEmitted = true
      chunks.push({
        frame: claudeFrame('content_block_start', {
          type: 'content_block_start',
          index: this.contentIndex,
          content_block: { type: 'tool_use', id: this.toolId, name: this.toolName },
        }),
      })
    }

    this.argBuf += delta
    chunks.push({
      frame: claudeFrame('content_block_delta', {
        type: 'content_block_delta',
        index: this.contentIndex,
        delta: { type: 'input_json_delta', partial_json: delta },
      }),
    })
    return chunks
  }

  handleFnArgsDone(d) {
    const callId = d.call_id || this.toolId
    const name = d.name || this.toolName
    const args = d.arguments || this.argBuf

    // Handle buffered Skill call dedup
    if (this.bufferingSkillCall) {
      this.bufferingSkillCall = false
      let isDuplicate = false
      try {
        const parsed = JSON.parse(args)
        if (parsed.skill && this.loadedSkills.has(parsed.skill)) isDuplicate = true
      } catch {}

      if (isDuplicate) {
        this.blockType = 'none'; this.argBuf = ''; this.toolId = ''; this.toolName = ''
        this.toolBlockStartEmitted = false; this.blockCounter--
        return []
      }

      // Not duplicate — emit full buffered content
      const emitChunks = []
      emitChunks.push({ frame: claudeFrame('content_block_start', {
        type: 'content_block_start', index: this.contentIndex,
        content_block: { type: 'tool_use', id: callId, name },
      })})
      emitChunks.push({ frame: claudeFrame('content_block_delta', {
        type: 'content_block_delta', index: this.contentIndex,
        delta: { type: 'input_json_delta', partial_json: args },
      })})
      emitChunks.push({ frame: claudeFrame('content_block_stop', {
        type: 'content_block_stop', index: this.contentIndex,
      })})
      this.completedTools.push({ callId, name, arguments: args })
      this.blockType = 'none'; this.argBuf = ''; this.toolBlockStartEmitted = false
      return emitChunks
    }

    const chunks = []

    if (!this.toolBlockStartEmitted) {
      this.toolBlockStartEmitted = true
      this.contentIndex = this.blockCounter++
      if (callId) this.toolId = callId
      if (name) this.toolName = name
      this.blockType = 'tool_use'
      chunks.push({ frame: claudeFrame('content_block_start', {
        type: 'content_block_start', index: this.contentIndex,
        content_block: { type: 'tool_use', id: callId, name },
      })})
    }

    if (!this.argBuf) {
      chunks.push({ frame: claudeFrame('content_block_delta', {
        type: 'content_block_delta', index: this.contentIndex,
        delta: { type: 'input_json_delta', partial_json: args || '{}' },
      })})
    }

    chunks.push({ frame: claudeFrame('content_block_stop', {
      type: 'content_block_stop', index: this.contentIndex,
    })})

    this.completedTools.push({ callId, name, arguments: args })
    this.toolId = ''; this.toolName = ''; this.argBuf = ''
    this.blockType = 'none'; this.toolBlockStartEmitted = false
    return chunks
  }

  handleCompleted(d) {
    const resp = d.response || {}
    const usage = resp.usage || {}

    let stopReason
    if (this.completedTools.length > 0) stopReason = 'tool_use'
    else if (resp.stop_reason === 'max_tokens') stopReason = 'max_tokens'
    else stopReason = 'end_turn'

    this._inputTokens = usage.input_tokens || this.inputTokenEstimate
    this._outputTokens = usage.output_tokens || 0

    return [
      { frame: claudeFrame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason },
        usage: { output_tokens: this._outputTokens },
      })},
      { frame: claudeFrame('message_stop', { type: 'message_stop' }), isComplete: true },
    ]
  }
}

// ---------------------------------------------------------------------------
// Proxy handler
// ---------------------------------------------------------------------------
async function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  if (req.method !== 'POST' || !req.url.includes('/v1/messages')) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found. Use POST /v1/messages' }))
    return
  }

  let rawBody = ''
  for await (const chunk of req) rawBody += chunk

  let body
  try { body = JSON.parse(rawBody) } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Invalid JSON' }))
    return
  }

  const requestModel = body.model || 'claude-sonnet-4'
  const mappedModel = MODEL_MAP[requestModel] || TARGET_MODEL

  log('info', `${requestModel} → ${mappedModel} | tools=${(body.tools || []).length}`)

  // Get token
  let token
  try { token = getToken() } catch (err) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: err.message } }))
    return
  }

  // Rewrite skill directives before translation (from aiproxy claude-cli adapter)
  const rewrittenBody = rewriteSkillDirectivesInBody(body)

  // Translate: Anthropic → Hub (Responses API format)
  const hubRequest = anthropicToHub(rewrittenBody)

  // Prepare body for Codex endpoint
  const codexBody = prepareCodexBody(hubRequest)

  // Build headers (from aiproxy providers/codex.ts)
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'Originator': 'codex_cli_rs',
  }
  const accountId = extractAccountId(token)
  if (accountId) headers['Chatgpt-Account-Id'] = accountId

  log('debug', `→ ${CODEX_API_URL} model=${codexBody.model}`)

  // Forward to Codex
  try {
    let upstream = await fetch(CODEX_API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(codexBody),
    })

    // 401 retry with fresh token
    if (upstream.status === 401) {
      log('info', '401 — refreshing token')
      cachedToken = null
      try {
        const freshToken = getToken()
        headers['Authorization'] = `Bearer ${freshToken}`
        const freshAccountId = extractAccountId(freshToken)
        if (freshAccountId) headers['Chatgpt-Account-Id'] = freshAccountId
        upstream = await fetch(CODEX_API_URL, { method: 'POST', headers, body: JSON.stringify(codexBody) })
      } catch {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'Token refresh failed' } }))
        return
      }
    }

    if (!upstream.ok) {
      const errText = await upstream.text()
      log('info', `Codex error: ${upstream.status} ${errText.slice(0, 300)}`)

      // Detect specific error types for clear messaging
      let errorType = 'api_error'
      let errorMsg = errText.slice(0, 500)

      if (upstream.status === 429) {
        errorType = 'rate_limit_error'
        errorMsg = '[codex] Rate limited. Codex usage quota exceeded — wait or upgrade plan.'
        log('info', 'RATE LIMITED — Codex quota exceeded')
      } else if (upstream.status === 402 || errText.includes('quota') || errText.includes('billing') || errText.includes('insufficient_quota')) {
        errorType = 'rate_limit_error'
        errorMsg = '[codex] Token quota exhausted. Check your OpenAI Codex plan usage.'
        log('info', 'QUOTA EXHAUSTED')
      } else if (upstream.status === 403 && errText.includes('scope')) {
        errorType = 'authentication_error'
        errorMsg = '[codex] OAuth scope insufficient. Run: autodev-codex auth login'
        log('info', 'SCOPE ERROR')
      } else if (upstream.status >= 500) {
        errorMsg = `[codex] Server error (${upstream.status}). Codex API may be down.`
      }

      res.writeHead(upstream.status >= 500 ? 500 : upstream.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: errorType, message: errorMsg } }))
      return
    }

    // Stream translate: Responses API SSE → Claude SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })

    const translator = new ResponsesToClaudeStream(requestModel)
    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()

    // SSE frame buffer — from aiproxy base-provider.ts
    // Accumulates partial text, yields only complete frames on \n\n boundaries
    let bufParts = []
    function pushBuffer(chunk) {
      if (!chunk) return []
      bufParts.push(chunk)
      const buffer = bufParts.join('')
      const frames = []
      let remaining = buffer
      let idx
      while ((idx = remaining.indexOf('\n\n')) !== -1) {
        frames.push(remaining.slice(0, idx + 2))
        remaining = remaining.slice(idx + 2)
      }
      bufParts = remaining ? [remaining] : []
      return frames
    }
    function flushBuffer() {
      if (bufParts.length === 0) return null
      const leftover = bufParts.join('')
      bufParts = []
      return leftover.trim() ? leftover : null
    }

    let streamCompleted = false

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        const frames = pushBuffer(text)

        for (const frame of frames) {
          const chunks = translator.translateChunk(frame)
          for (const chunk of chunks) {
            res.write(chunk.frame)
            if (chunk.isComplete) streamCompleted = true
          }
        }
      }

      // Flush any remaining partial frame
      const leftover = flushBuffer()
      if (leftover) {
        const chunks = translator.translateChunk(leftover)
        for (const chunk of chunks) {
          res.write(chunk.frame)
          if (chunk.isComplete) streamCompleted = true
        }
      }

      // Fallback: if stream ended without response.completed
      if (!streamCompleted) {
        log('debug', 'Stream ended without response.completed — emitting closing frames')
        const stopReason = translator.completedTools.length > 0 ? 'tool_use' : 'end_turn'
        res.write(claudeFrame('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: stopReason },
          usage: { output_tokens: translator._outputTokens || 0 },
        }))
        res.write(claudeFrame('message_stop', { type: 'message_stop' }))
      }
    } catch (err) {
      log('info', 'Stream error:', err.message)
      // Emit closing frames on error
      res.write(claudeFrame('message_delta', {
        type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 },
      }))
      res.write(claudeFrame('message_stop', { type: 'message_stop' }))
    }

    res.end()

  } catch (err) {
    log('info', 'Fetch error:', err.message)
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `Upstream error: ${err.message}` } }))
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = createServer(handleRequest)

server.listen(PORT, '127.0.0.1', () => {
  console.log(`
  Autodev Proxy — Claude → Codex Translation
  ─────────────────────────────────────────────
  Listening:    http://localhost:${PORT}
  Target:       ${CODEX_API_URL}
  Execute:      opus → ${EXEC_MODEL}
  General:      * → ${TARGET_MODEL}
  Account:      ${ACCOUNT}

  Configure Claude Code:
    export ANTHROPIC_BASE_URL=http://localhost:${PORT}
    export ANTHROPIC_API_KEY=proxy

  Or just run: autodev-codex
  ─────────────────────────────────────────────
`)
})
