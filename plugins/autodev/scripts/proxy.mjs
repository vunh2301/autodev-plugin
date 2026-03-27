#!/usr/bin/env node
// proxy.mjs — Full Claude-to-Codex proxy for autodev
// Cloned from aiproxy: full translator pipeline (all formats)
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
const LOG_LEVEL = getArg('--log', 'info')

// Provider mode: "codex" (OAuth + Responses API) or "openai-compat" (API key + Chat Completions)
const PROVIDER_MODE = getArg('--provider', 'codex')
const TARGET_URL = getArg('--target-url',
  PROVIDER_MODE === 'codex'
    ? 'https://chatgpt.com/backend-api/codex/responses'
    : 'https://api.openai.com/v1/chat/completions'
)
const API_KEY = getArg('--api-key', process.env.OPENAI_API_KEY || '')

// Model mapping: Claude model → target model
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
// OAuth token (from providers/codex.ts + oauth.mjs integration)
// ---------------------------------------------------------------------------
let cachedToken = null
let cachedTokenExpiry = 0

function getToken() {
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
      cachedTokenExpiry = Date.now() + 3600_000
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

// ===========================================================================
//  TRANSLATOR — Types (from translator/types.ts)
// ===========================================================================

function createInitialStreamState() {
  return {
    blockType: 'none',
    blockIndex: -1,
    currentOutputIndex: 0,
    toolId: '',
    toolName: '',
    argBuf: '',
    completedTools: [],
  }
}

// ===========================================================================
//  TRANSLATOR — Utils (from translator/utils.ts)
// ===========================================================================

/**
 * Recursively remove `cache_control` from objects and arrays.
 * Codex rejects cache_control on tools AND content parts.
 */
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

/** Ensure tool has type: "function". Upstream rejects null/missing type. */
function normalizeToolType(tool) {
  return { ...tool, type: tool.type || 'function' }
}

/** Convert string content to [{type: "input_text", text}] array. */
function contentToArray(content) {
  if (content === null || content === undefined) return []
  if (typeof content === 'string') return [{ type: 'input_text', text: content }]
  if (Array.isArray(content)) return content
  return []
}

/** Shallow copy an object to avoid mutating the original request body. */
function shallowCopyBody(body) {
  if (body === null || body === undefined || typeof body !== 'object') return {}
  return { ...body }
}

/**
 * Dedup repeated Skill tool calls in hub input array.
 * Keeps the first full output for each skill name, removes subsequent pairs.
 */
function dedupSkillCalls(input) {
  const callIdToSkill = new Map()
  for (const item of input) {
    if (item.type === 'function_call' && item.name === 'Skill') {
      try {
        const args = JSON.parse(item.arguments)
        if (args.skill) callIdToSkill.set(item.call_id, args.skill)
      } catch { /* ignore parse errors */ }
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

/**
 * Safely parse a JSON string, returning a fallback value on failure.
 */
function safeParse(str, fallback = {}) {
  try { return JSON.parse(str) } catch { return fallback }
}

// ===========================================================================
//  TO-HUB — Anthropic Messages → Hub (from translator/to-hub/anthropic-messages.ts)
// ===========================================================================

function anthropicToHub(body) {
  const raw = shallowCopyBody(body)
  const messages = Array.isArray(raw.messages) ? raw.messages : []

  let instructions
  if (raw.system !== undefined) {
    if (typeof raw.system === 'string') {
      instructions = raw.system
    } else if (Array.isArray(raw.system)) {
      instructions = raw.system
        .filter(p => p.type === 'text')
        .map(p => p.text)
        .join('\n')
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
          const imageUrl = source.type === 'url'
            ? source.url
            : `data:${source.media_type};base64,${source.data}`
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
            type: 'function_call', call_id: callId, name,
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

  let tools
  if (Array.isArray(raw.tools) && raw.tools.length > 0) {
    tools = raw.tools
      .map(t => {
        const name = typeof t.name === 'string' ? t.name : ''
        if (!name) return null
        return stripCacheControl({ type: 'function', name, description: t.description, parameters: t.input_schema })
      })
      .filter(t => t !== null)
  }

  const result = { model: raw.model, input: stripCacheControl(input), store: false }
  if (instructions !== undefined) result.instructions = instructions
  if (tools) result.tools = tools
  if (raw.stream !== undefined) result.stream = raw.stream
  if (raw.max_tokens !== undefined) result.max_tokens = raw.max_tokens
  if (raw.temperature !== undefined) result.temperature = raw.temperature
  if (raw.top_p !== undefined) result.top_p = raw.top_p
  return result
}

// ===========================================================================
//  TO-HUB — Chat Completions → Hub (from translator/to-hub/chat-completions.ts)
// ===========================================================================

function chatToHub(body) {
  const raw = shallowCopyBody(body)
  const messages = Array.isArray(raw.messages) ? raw.messages : []

  const input = []
  let instructions

  for (const msg of messages) {
    const role = msg.role

    if (role === 'system' || role === 'developer') {
      const text = typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.filter(p => p.type === 'text').map(p => p.text).join('\n')
          : ''
      instructions = instructions ? instructions + '\n' + text : text
    } else if (role === 'user') {
      const content = convertChatContent(msg.content)
      input.push({ role: 'user', content })
    } else if (role === 'assistant') {
      const toolCalls = msg.tool_calls
      const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0
      if (msg.content !== null && msg.content !== undefined) {
        const content = convertChatContent(msg.content, 'assistant')
        if (content.length > 0) input.push({ role: 'assistant', content })
      }
      if (hasToolCalls) {
        for (const tc of toolCalls) {
          const fn = tc.function || {}
          const name = (typeof fn.name === 'string' && fn.name) ? fn.name : 'unknown_function'
          const callId = (typeof tc.id === 'string' && tc.id) ? tc.id : `call_${name}_${Date.now()}`
          input.push({
            type: 'function_call', call_id: callId, name,
            arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? '{}'),
          })
        }
      }
    } else if (role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id,
        output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      })
    }
  }

  dedupSkillCalls(input)

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

  let tools
  if (Array.isArray(raw.tools) && raw.tools.length > 0) {
    tools = raw.tools
      .map(t => {
        const fn = t.function ?? t
        const name = typeof fn.name === 'string' ? fn.name : ''
        if (!name) return null
        return stripCacheControl({ type: 'function', name, description: fn.description, parameters: fn.parameters })
      })
      .filter(t => t !== null)
  }

  const result = { model: raw.model, input: stripCacheControl(input), store: false }
  if (instructions !== undefined) result.instructions = instructions
  if (tools) result.tools = tools
  if (raw.stream !== undefined) result.stream = raw.stream
  if (raw.max_tokens !== undefined) result.max_tokens = raw.max_tokens
  if (raw.temperature !== undefined) result.temperature = raw.temperature
  if (raw.top_p !== undefined) result.top_p = raw.top_p
  return result
}

function convertChatContent(content, role = 'user') {
  if (content === null || content === undefined) return []
  const textType = role === 'assistant' ? 'output_text' : 'input_text'
  if (typeof content === 'string') return [{ type: textType, text: content }]
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (part.type === 'text') return { type: textType, text: part.text }
        if (part.type === 'image_url') return { type: 'input_image', image_url: part.image_url?.url }
        return null
      })
      .filter(p => p !== null)
  }
  return []
}

// ===========================================================================
//  TO-HUB — Gemini → Hub (from translator/to-hub/gemini.ts)
// ===========================================================================

function geminiToHub(body) {
  const raw = shallowCopyBody(body)
  const contents = Array.isArray(raw.contents) ? raw.contents : []

  let instructions
  if (raw.systemInstruction) {
    const parts = Array.isArray(raw.systemInstruction.parts) ? raw.systemInstruction.parts : []
    const text = parts.map(p => p.text).filter(Boolean).join('\n')
    if (text) instructions = text
  }

  const input = []
  let functionCallIndex = 0
  let orphanIndex = 0
  const pendingCallIdsByName = new Map()

  for (const c of contents) {
    const role = c.role
    const parts = Array.isArray(c.parts) ? c.parts : []
    const hubRole = role === 'model' ? 'assistant' : role
    const contentParts = []
    const deferredItems = []

    for (const part of parts) {
      if (part.text !== undefined) {
        const textType = hubRole === 'assistant' ? 'output_text' : 'input_text'
        contentParts.push({ type: textType, text: part.text })
      } else if (part.inlineData) {
        const dataUrl = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`
        contentParts.push({ type: 'input_image', image_url: dataUrl })
      } else if (part.functionCall) {
        const fc = part.functionCall
        const name = (typeof fc.name === 'string' && fc.name) ? fc.name : 'unknown_function'
        const callId = `${name}_${functionCallIndex++}`
        const queue = pendingCallIdsByName.get(name) ?? []
        queue.push(callId)
        pendingCallIdsByName.set(name, queue)
        deferredItems.push({
          type: 'function_call', call_id: callId, name,
          arguments: JSON.stringify(fc.args),
        })
      } else if (part.functionResponse) {
        const fr = part.functionResponse
        const name = (typeof fr.name === 'string' && fr.name) ? fr.name : 'unknown_function'
        const queue = pendingCallIdsByName.get(name)
        const callId = (queue && queue.length > 0)
          ? queue.shift()
          : `${name}_orphan_${orphanIndex++}`
        deferredItems.push({
          type: 'function_call_output', call_id: callId,
          output: JSON.stringify(fr.response),
        })
      }
    }

    if (contentParts.length > 0) input.push({ role: hubRole, content: contentParts })
    for (const item of deferredItems) input.push(item)
  }

  let tools
  if (Array.isArray(raw.tools) && raw.tools.length > 0) {
    const flatTools = []
    for (const toolGroup of raw.tools) {
      const declarations = Array.isArray(toolGroup.functionDeclarations) ? toolGroup.functionDeclarations : []
      for (const decl of declarations) {
        const name = typeof decl.name === 'string' ? decl.name : ''
        if (!name) continue
        flatTools.push(stripCacheControl({
          type: 'function', name, description: decl.description, parameters: decl.parameters,
        }))
      }
    }
    if (flatTools.length > 0) tools = flatTools
  }

  const result = { model: raw.model, input: stripCacheControl(input), store: false }
  if (instructions !== undefined) result.instructions = instructions
  if (tools) result.tools = tools
  if (raw.stream !== undefined) result.stream = raw.stream
  const gc = raw.generationConfig ?? {}
  if (gc.maxOutputTokens !== undefined) result.max_tokens = gc.maxOutputTokens
  if (gc.temperature !== undefined) result.temperature = gc.temperature
  if (gc.topP !== undefined) result.top_p = gc.topP
  return result
}

// ===========================================================================
//  FROM-HUB — Hub → Anthropic Messages (from translator/from-hub/anthropic-messages.ts)
// ===========================================================================

function pushMessage(messages, role, content) {
  const last = messages.at(-1)
  if (last && last.role === role) {
    last.content = [...last.content, ...content]
  } else {
    messages.push({ role, content })
  }
}

function hubToAnthropic(hub) {
  const messages = []
  const input = hub.input ?? []
  let i = 0

  while (i < input.length) {
    const item = input[i]

    if ('role' in item && item.role === 'user') {
      const content = item.content.map(c => {
        if (c.type === 'input_text') return { type: 'text', text: c.text }
        if (c.type === 'input_image') return { type: 'image', source: parseAnthropicImageUrl(c.image_url) }
        return c
      })
      pushMessage(messages, 'user', content)
      i++
    } else if ('role' in item && item.role === 'assistant') {
      const content = item.content.map(c => {
        if (c.type === 'input_text' || c.type === 'output_text') return { type: 'text', text: c.text }
        return c
      })
      pushMessage(messages, 'assistant', content)
      i++
    } else if ('type' in item && item.type === 'function_call') {
      const toolUseBlocks = []
      while (i < input.length) {
        const fc = input[i]
        if (!fc.type || fc.type !== 'function_call') break
        toolUseBlocks.push({
          type: 'tool_use', id: fc.call_id, name: fc.name,
          input: safeParse(fc.arguments),
        })
        i++
      }
      pushMessage(messages, 'assistant', toolUseBlocks)
    } else if ('type' in item && item.type === 'function_call_output') {
      const toolResults = []
      while (i < input.length) {
        const fco = input[i]
        if (!fco.type || fco.type !== 'function_call_output') break
        toolResults.push({ type: 'tool_result', tool_use_id: fco.call_id, content: fco.output })
        i++
      }
      pushMessage(messages, 'user', toolResults)
    } else {
      i++
    }
  }

  let tools
  if (hub.tools && hub.tools.length > 0) {
    tools = hub.tools.map(t => ({
      name: t.name, description: t.description, input_schema: t.parameters ?? {},
    }))
  }

  const result = {
    model: hub.model, messages, stream: hub.stream,
    max_tokens: (hub.max_tokens != null && hub.max_tokens > 0) ? hub.max_tokens : 8192,
  }
  if (hub.instructions !== undefined) result.system = hub.instructions
  if (tools) result.tools = tools
  if (hub.temperature !== undefined) result.temperature = hub.temperature
  if (hub.top_p !== undefined) result.top_p = hub.top_p
  return result
}

function parseAnthropicImageUrl(url) {
  const match = url.match(/^data:([^;]+);base64,(.+)$/)
  if (match) return { type: 'base64', media_type: match[1], data: match[2] }
  return { type: 'url', url }
}

// ===========================================================================
//  FROM-HUB — Hub → Chat Completions (from translator/from-hub/chat-completions.ts)
// ===========================================================================

function hubToChat(hub) {
  const messages = []
  const input = hub.input ?? []

  if (hub.instructions !== undefined) {
    messages.push({ role: 'system', content: hub.instructions })
  }

  let i = 0
  while (i < input.length) {
    const item = input[i]

    if ('role' in item && item.role === 'user') {
      let content
      if (item.content.length === 1 && item.content[0].type === 'input_text') {
        content = item.content[0].text
      } else {
        content = item.content.map(c => {
          if (c.type === 'input_text') return { type: 'text', text: c.text }
          if (c.type === 'input_image') return { type: 'image_url', image_url: { url: c.image_url } }
          return c
        })
      }
      messages.push({ role: 'user', content })
      i++
    } else if ('role' in item && item.role === 'developer') {
      let content
      if (item.content.length === 1 && item.content[0].type === 'input_text') {
        content = item.content[0].text
      } else {
        content = item.content.map(c => {
          if (c.type === 'input_text') return { type: 'text', text: c.text }
          return c
        })
      }
      messages.push({ role: 'developer', content })
      i++
    } else if ('role' in item && item.role === 'assistant') {
      let content
      const first = item.content[0]
      if (item.content.length === 1 && (first.type === 'input_text' || first.type === 'output_text')) {
        content = first.text
      } else {
        content = item.content.map(c => {
          if (c.type === 'input_text' || c.type === 'output_text') return { type: 'text', text: c.text }
          return c
        })
      }
      messages.push({ role: 'assistant', content })
      i++
    } else if ('type' in item && item.type === 'function_call') {
      const toolCalls = []
      while (i < input.length) {
        const fc = input[i]
        if (!fc.type || fc.type !== 'function_call') break
        toolCalls.push({ id: fc.call_id, type: 'function', function: { name: fc.name, arguments: fc.arguments } })
        i++
      }
      const prev = messages[messages.length - 1]
      if (prev && prev.role === 'assistant' && !prev.tool_calls) {
        prev.tool_calls = toolCalls
      } else {
        messages.push({ role: 'assistant', tool_calls: toolCalls })
      }
    } else if ('type' in item && item.type === 'function_call_output') {
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: item.output })
      i++
    } else {
      i++
    }
  }

  let tools
  if (hub.tools && hub.tools.length > 0) {
    tools = hub.tools.map(t => ({
      type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }

  const result = { model: hub.model, messages }
  if (tools) result.tools = tools
  if (hub.stream !== undefined) result.stream = hub.stream
  if (hub.max_tokens !== undefined) result.max_tokens = hub.max_tokens
  if (hub.temperature !== undefined) result.temperature = hub.temperature
  if (hub.top_p !== undefined) result.top_p = hub.top_p
  return result
}

// ===========================================================================
//  FROM-HUB — Hub → Codex (from translator/from-hub/codex.ts)
// ===========================================================================

const CODEX_UNSUPPORTED_FIELDS = [
  'temperature', 'top_p', 'seed', 'max_tokens',
  'frequency_penalty', 'presence_penalty', 'context_management', 'truncation',
]

function hubToCodex(hub) {
  const cleaned = stripCacheControl({ ...hub })
  for (const field of CODEX_UNSUPPORTED_FIELDS) delete cleaned[field]
  cleaned.store = false
  return cleaned
}

// ===========================================================================
//  FROM-HUB — Hub → Gemini (from translator/from-hub/gemini.ts)
// ===========================================================================

function hubToGemini(hub) {
  const contents = []
  const input = hub.input ?? []
  const functionNameMap = buildGeminiFunctionNameMap(input)

  let i = 0
  while (i < input.length) {
    const item = input[i]

    if ('role' in item && item.role === 'user') {
      const parts = item.content.map(c => {
        if (c.type === 'input_text') return { text: c.text }
        if (c.type === 'input_image') {
          const parsed = parseGeminiDataUrl(c.image_url)
          if (parsed) return { inlineData: { mimeType: parsed.mimeType, data: parsed.data } }
          return { text: `[image: ${c.image_url}]` }
        }
        return c
      })
      contents.push({ role: 'user', parts })
      i++
    } else if ('role' in item && item.role === 'assistant') {
      const parts = item.content.map(c => {
        if (c.type === 'input_text' || c.type === 'output_text') return { text: c.text }
        return c
      })
      contents.push({ role: 'model', parts })
      i++
    } else if ('type' in item && item.type === 'function_call') {
      const parts = []
      while (i < input.length) {
        const fc = input[i]
        if (!fc.type || fc.type !== 'function_call') break
        parts.push({ functionCall: { name: fc.name, args: safeParse(fc.arguments) } })
        i++
      }
      contents.push({ role: 'model', parts })
    } else if ('type' in item && item.type === 'function_call_output') {
      const parts = []
      while (i < input.length) {
        const fco = input[i]
        if (!fco.type || fco.type !== 'function_call_output') break
        const callName = functionNameMap.get(fco.call_id) ?? 'unknown_function'
        const PARSE_FAILED = Symbol()
        const parsed = safeParse(fco.output, PARSE_FAILED)
        let response
        if (parsed !== PARSE_FAILED && typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          response = parsed
        } else if (parsed !== PARSE_FAILED) {
          response = { result: parsed }
        } else {
          response = { result: fco.output }
        }
        parts.push({ functionResponse: { name: callName, response } })
        i++
      }
      contents.push({ role: 'user', parts })
    } else {
      i++
    }
  }

  let tools
  if (hub.tools && hub.tools.length > 0) {
    const functionDeclarations = hub.tools.map(t => ({
      name: t.name, description: t.description, parameters: t.parameters,
    }))
    tools = [{ functionDeclarations }]
  }

  const result = { model: hub.model, contents }
  if (hub.instructions !== undefined) result.systemInstruction = { parts: [{ text: hub.instructions }] }
  if (tools) result.tools = tools
  const generationConfig = {}
  if (hub.temperature !== undefined) generationConfig.temperature = hub.temperature
  if (hub.top_p !== undefined) generationConfig.topP = hub.top_p
  if (hub.max_tokens !== undefined) generationConfig.maxOutputTokens = hub.max_tokens
  if (Object.keys(generationConfig).length > 0) result.generationConfig = generationConfig
  return result
}

function buildGeminiFunctionNameMap(input) {
  const map = new Map()
  for (const item of input) {
    if (item.type === 'function_call' && typeof item.call_id === 'string' && typeof item.name === 'string') {
      map.set(item.call_id, item.name)
    }
  }
  return map
}

function parseGeminiDataUrl(url) {
  const match = url.match(/^data:([^;]+);base64,(.+)$/)
  if (match) return { mimeType: match[1], data: match[2] }
  return null
}

// ===========================================================================
//  Request Translator Factory (from translator/hub.ts)
// ===========================================================================

function createRequestTranslator() {
  return {
    toHub(body, from) {
      switch (from) {
        case 'openai-chat': return chatToHub(body)
        case 'anthropic-messages': return anthropicToHub(body)
        case 'gemini': return geminiToHub(body)
        case 'openai-responses': return shallowCopyBody(body)
      }
    },
    fromHub(hub, to) {
      switch (to) {
        case 'anthropic-messages': return hubToAnthropic(hub)
        case 'gemini': return hubToGemini(hub)
        case 'openai-responses': return hubToCodex(hub)
        case 'openai-chat': return hubToChat(hub)
      }
    },
  }
}

// ===========================================================================
//  STREAM — Claude → Responses (from translator/stream/claude-to-responses.ts)
// ===========================================================================

function parseClaudeFrame(frame) {
  let event = ''
  let dataStr = ''
  for (const line of frame.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7).trim()
    else if (line.startsWith('data: ')) dataStr = line.slice(6)
  }
  if (!dataStr) return null
  try { return { event, data: JSON.parse(dataStr) } } catch { return null }
}

function responsesFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

class ClaudeToResponsesStream {
  constructor() {
    this.state = createInitialStreamState()
    this.messageId = ''
    this.model = ''
    this.inputTokens = 0
    this.outputTokens = 0
    this.stopReason = ''
    this.textBuf = ''
    this.fullText = ''
    this.outputIndex = 0
  }

  translateChunk(frame) {
    const parsed = parseClaudeFrame(frame)
    if (!parsed) return []
    const d = parsed.data
    const type = d.type
    switch (type) {
      case 'message_start': return this._handleMessageStart(d)
      case 'content_block_start': return this._handleContentBlockStart(d)
      case 'content_block_delta': return this._handleContentBlockDelta(d)
      case 'content_block_stop': return this._handleContentBlockStop()
      case 'message_delta': return this._handleMessageDelta(d)
      case 'message_stop': return this._handleMessageStop()
      default: return []
    }
  }
  completedToolCalls() { return [...this.state.completedTools] }
  completedText() { return this.fullText }
  completedTokens() { return { input: this.inputTokens, output: this.outputTokens } }
  abort() {
    const partial = [...this.state.completedTools]
    if (this.state.blockType === 'tool_use' && this.state.toolId) {
      partial.push({ callId: this.state.toolId, name: this.state.toolName, arguments: this.state.argBuf })
    }
    const closingFrames = [responsesFrame({
      type: 'response.completed',
      response: { id: this.messageId || 'aborted', status: 'incomplete', model: this.model, usage: { input_tokens: this.inputTokens, output_tokens: this.outputTokens } },
    })]
    return { partialToolCalls: partial, lastBlockType: this.state.blockType, closingFrames }
  }
  reset() {
    this.state = createInitialStreamState(); this.messageId = ''; this.model = ''
    this.inputTokens = 0; this.outputTokens = 0; this.stopReason = ''
    this.textBuf = ''; this.fullText = ''; this.outputIndex = 0
  }

  _handleMessageStart(d) {
    const msg = d.message || {}
    this.messageId = msg.id || ''; this.model = msg.model || ''
    const usage = msg.usage
    if (usage) this.inputTokens = usage.input_tokens || 0
    return [{ frame: responsesFrame({ type: 'response.created', response: { id: this.messageId, status: 'in_progress', model: this.model } }) }]
  }
  _handleContentBlockStart(d) {
    this.state.blockIndex = d.index
    const block = d.content_block; const blockType = block.type
    const currentOutputIndex = this.outputIndex++
    if (blockType === 'text') {
      this.state.blockType = 'text'; this.state.currentOutputIndex = currentOutputIndex; this.textBuf = ''
      return [
        { frame: responsesFrame({ type: 'response.output_item.added', output_index: currentOutputIndex, item: { type: 'message', role: 'assistant' } }) },
        { frame: responsesFrame({ type: 'response.content_part.added', output_index: currentOutputIndex, content_index: this.state.blockIndex, part: { type: 'output_text', text: '' } }) },
      ]
    }
    if (blockType === 'tool_use') {
      this.state.blockType = 'tool_use'; this.state.currentOutputIndex = currentOutputIndex
      this.state.toolId = block.id || ''; this.state.toolName = block.name || ''; this.state.argBuf = ''
      return [{ frame: responsesFrame({ type: 'response.output_item.added', output_index: currentOutputIndex, item: { type: 'function_call', call_id: this.state.toolId, name: this.state.toolName } }) }]
    }
    if (blockType === 'thinking') {
      this.state.blockType = 'thinking'; this.state.currentOutputIndex = currentOutputIndex
      return [{ frame: responsesFrame({ type: 'response.reasoning.added', output_index: currentOutputIndex, content_index: this.state.blockIndex }) }]
    }
    return []
  }
  _handleContentBlockDelta(d) {
    const delta = d.delta; const deltaType = delta.type
    if (deltaType === 'text_delta') {
      this.textBuf += delta.text; this.fullText += delta.text
      return [{ frame: responsesFrame({ type: 'response.output_text.delta', output_index: this.state.currentOutputIndex, content_index: this.state.blockIndex, delta: delta.text }) }]
    }
    if (deltaType === 'input_json_delta') {
      this.state.argBuf += delta.partial_json
      return [{ frame: responsesFrame({ type: 'response.function_call_arguments.delta', output_index: this.state.currentOutputIndex, content_index: this.state.blockIndex, delta: delta.partial_json }) }]
    }
    if (deltaType === 'thinking_delta') {
      return [{ frame: responsesFrame({ type: 'response.reasoning.delta', output_index: this.state.currentOutputIndex, content_index: this.state.blockIndex, delta: delta.thinking }) }]
    }
    return []
  }
  _handleContentBlockStop() {
    const bt = this.state.blockType
    if (bt === 'text') {
      const chunks = [
        { frame: responsesFrame({ type: 'response.output_text.done', output_index: this.state.currentOutputIndex, content_index: this.state.blockIndex, text: this.textBuf }) },
        { frame: responsesFrame({ type: 'response.content_part.done', output_index: this.state.currentOutputIndex, content_index: this.state.blockIndex, part: { type: 'output_text', text: this.textBuf } }) },
        { frame: responsesFrame({ type: 'response.output_item.done', output_index: this.state.currentOutputIndex, item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: this.textBuf }] } }) },
      ]
      this.state.blockType = 'none'; this.textBuf = ''; return chunks
    }
    if (bt === 'tool_use') {
      const chunks = [
        { frame: responsesFrame({ type: 'response.function_call_arguments.done', output_index: this.state.currentOutputIndex, content_index: this.state.blockIndex, arguments: this.state.argBuf, call_id: this.state.toolId, name: this.state.toolName }) },
        { frame: responsesFrame({ type: 'response.output_item.done', output_index: this.state.currentOutputIndex, item: { type: 'function_call', call_id: this.state.toolId, name: this.state.toolName, arguments: this.state.argBuf } }) },
      ]
      this.state.completedTools.push({ callId: this.state.toolId, name: this.state.toolName, arguments: this.state.argBuf })
      this.state.toolId = ''; this.state.toolName = ''; this.state.argBuf = ''; this.state.blockType = 'none'
      return chunks
    }
    if (bt === 'thinking') {
      const chunks = [
        { frame: responsesFrame({ type: 'response.reasoning.done', output_index: this.state.currentOutputIndex, content_index: this.state.blockIndex }) },
        { frame: responsesFrame({ type: 'response.output_item.done', output_index: this.state.currentOutputIndex, item: { type: 'reasoning' } }) },
      ]
      this.state.blockType = 'none'; return chunks
    }
    this.state.blockType = 'none'; return []
  }
  _handleMessageDelta(d) {
    if (d.delta?.stop_reason) this.stopReason = d.delta.stop_reason
    if (d.usage?.output_tokens) this.outputTokens = d.usage.output_tokens
    return []
  }
  _handleMessageStop() {
    let stopReason = 'stop'
    if (this.stopReason === 'end_turn') stopReason = 'stop'
    else if (this.stopReason === 'max_tokens') stopReason = 'max_tokens'
    else if (this.stopReason === 'tool_use') stopReason = 'stop'
    else if (this.stopReason === 'stop_sequence') stopReason = 'stop'
    return [{
      frame: responsesFrame({ type: 'response.completed', response: { id: this.messageId, status: 'completed', model: this.model, stop_reason: stopReason, usage: { input_tokens: this.inputTokens, output_tokens: this.outputTokens } } }),
      isComplete: true,
    }]
  }
}

// ===========================================================================
//  STREAM — Claude → Chat (from translator/stream/claude-to-chat.ts)
// ===========================================================================

function chatSSEFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}
function doneSSEFrame() {
  return 'data: [DONE]\n\n'
}

class ClaudeToChatStream {
  constructor() {
    this.state = createInitialStreamState()
    this.messageId = ''; this.model = ''; this.inputTokens = 0; this.outputTokens = 0
    this.stopReason = ''; this.textBuf = ''; this.fullText = ''
    this.emittedRole = false; this.toolIndex = 0; this.toolSlots = new Map()
  }
  translateChunk(frame) {
    const parsed = parseClaudeFrame(frame)
    if (!parsed) return []
    const d = parsed.data; const type = d.type
    switch (type) {
      case 'message_start': return this._handleMessageStart(d)
      case 'content_block_start': return this._handleContentBlockStart(d)
      case 'content_block_delta': return this._handleContentBlockDelta(d)
      case 'content_block_stop': return this._handleContentBlockStop()
      case 'message_delta': return this._handleMessageDelta(d)
      case 'message_stop': return this._handleMessageStop()
      default: return []
    }
  }
  completedToolCalls() { return [...this.state.completedTools] }
  completedText() { return this.fullText }
  completedTokens() { return { input: this.inputTokens, output: this.outputTokens } }
  abort() {
    const partial = [...this.state.completedTools]
    if (this.state.blockType === 'tool_use' && this.state.toolId) {
      partial.push({ callId: this.state.toolId, name: this.state.toolName, arguments: this.state.argBuf })
    }
    return {
      partialToolCalls: partial, lastBlockType: this.state.blockType,
      closingFrames: [
        chatSSEFrame({ id: this.messageId || 'aborted', object: 'chat.completion.chunk', model: this.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        doneSSEFrame(),
      ],
    }
  }
  reset() {
    this.state = createInitialStreamState(); this.messageId = ''; this.model = ''
    this.inputTokens = 0; this.outputTokens = 0; this.stopReason = ''
    this.textBuf = ''; this.fullText = ''; this.emittedRole = false
    this.toolIndex = 0; this.toolSlots = new Map()
  }
  _ensureRole() {
    if (this.emittedRole) return []
    this.emittedRole = true
    return [{ frame: chatSSEFrame({ id: this.messageId, object: 'chat.completion.chunk', model: this.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }) }]
  }
  _handleMessageStart(d) {
    const msg = d.message || {}; this.messageId = msg.id || ''; this.model = msg.model || ''
    if (msg.usage) this.inputTokens = msg.usage.input_tokens || 0
    return []
  }
  _handleContentBlockStart(d) {
    const block = d.content_block; const blockType = block.type; this.state.blockIndex = d.index
    if (blockType === 'text') { this.state.blockType = 'text'; this.textBuf = ''; return this._ensureRole() }
    if (blockType === 'tool_use') {
      this.state.blockType = 'tool_use'; this.state.toolId = block.id || ''; this.state.toolName = block.name || ''; this.state.argBuf = ''
      const idx = this.toolIndex++; this.toolSlots.set(idx, { index: idx, id: this.state.toolId, name: this.state.toolName, argBuf: '' })
      const chunks = this._ensureRole()
      chunks.push({ frame: chatSSEFrame({ id: this.messageId, object: 'chat.completion.chunk', model: this.model, choices: [{ index: 0, delta: { tool_calls: [{ index: idx, id: this.state.toolId, type: 'function', function: { name: this.state.toolName, arguments: '' } }] }, finish_reason: null }] }) })
      return chunks
    }
    if (blockType === 'thinking') this.state.blockType = 'thinking'
    return []
  }
  _handleContentBlockDelta(d) {
    const delta = d.delta; const deltaType = delta.type
    if (deltaType === 'text_delta') {
      this.textBuf += delta.text; this.fullText += delta.text
      return [{ frame: chatSSEFrame({ id: this.messageId, object: 'chat.completion.chunk', model: this.model, choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }] }) }]
    }
    if (deltaType === 'input_json_delta') {
      this.state.argBuf += delta.partial_json
      const slotIdx = this.toolIndex - 1; const slot = this.toolSlots.get(slotIdx); if (slot) slot.argBuf += delta.partial_json
      return [{ frame: chatSSEFrame({ id: this.messageId, object: 'chat.completion.chunk', model: this.model, choices: [{ index: 0, delta: { tool_calls: [{ index: slotIdx, function: { arguments: delta.partial_json } }] }, finish_reason: null }] }) }]
    }
    return []
  }
  _handleContentBlockStop() {
    if (this.state.blockType === 'tool_use') {
      this.state.completedTools.push({ callId: this.state.toolId, name: this.state.toolName, arguments: this.state.argBuf })
      this.state.toolId = ''; this.state.toolName = ''; this.state.argBuf = ''
    }
    this.state.blockType = 'none'; return []
  }
  _handleMessageDelta(d) {
    if (d.delta?.stop_reason) this.stopReason = d.delta.stop_reason
    if (d.usage?.output_tokens) this.outputTokens = d.usage.output_tokens
    return []
  }
  _handleMessageStop() {
    const hasTools = this.state.completedTools.length > 0
    const finishPayload = { id: this.messageId, object: 'chat.completion.chunk', model: this.model, choices: [{ index: 0, delta: {}, finish_reason: hasTools ? 'tool_calls' : 'stop' }] }
    if (this.inputTokens || this.outputTokens) finishPayload.usage = { prompt_tokens: this.inputTokens, completion_tokens: this.outputTokens }
    return [{ frame: chatSSEFrame(finishPayload) }, { frame: doneSSEFrame(), isComplete: true }]
  }
}

// ===========================================================================
//  STREAM — Responses → Claude (from translator/stream/responses-to-claude.ts)
// ===========================================================================

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
  constructor() {
    this.state = createInitialStreamState()
    this.responseId = ''; this.textBuf = ''; this.contentIndex = 0
    this.blockCounter = 0; this.toolBlockStartEmitted = false
    this.inputTokenEstimate = 0; this._inputTokens = 0; this._outputTokens = 0
    this.loadedSkills = new Set(); this.bufferingSkillCall = false
  }

  setInputTokenEstimate(count) { this.inputTokenEstimate = count }
  setLoadedSkills(skills) { this.loadedSkills = skills }

  translateChunk(frame) {
    const d = parseResponsesFrame(frame)
    if (!d) return []
    const type = d.type
    switch (type) {
      case 'response.created': return this._handleCreated(d)
      case 'response.output_item.added': return this._handleOutputItemAdded(d)
      case 'response.content_part.added': return this._handleContentPartAdded(d)
      case 'response.output_text.delta': return this._handleTextDelta(d)
      case 'response.output_text.done': return []
      case 'response.content_part.done': return this._handleContentPartDone()
      case 'response.output_item.done': return []
      case 'response.function_call_arguments.delta': return this._handleFnArgsDelta(d)
      case 'response.function_call_arguments.done': return this._handleFnArgsDone(d)
      case 'response.completed': return this._handleCompleted(d)
      default: return []
    }
  }
  completedToolCalls() { return [...this.state.completedTools] }
  completedText() { return this.textBuf }
  completedTokens() { return { input: this._inputTokens, output: this._outputTokens } }
  abort() {
    const partial = [...this.state.completedTools]
    if (this.state.blockType === 'tool_use' && this.state.toolId) {
      partial.push({ callId: this.state.toolId, name: this.state.toolName, arguments: this.state.argBuf })
    }
    return {
      partialToolCalls: partial, lastBlockType: this.state.blockType,
      closingFrames: [
        claudeFrame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } }),
        claudeFrame('message_stop', { type: 'message_stop' }),
      ],
    }
  }
  reset() {
    this.state = createInitialStreamState(); this.responseId = ''; this.textBuf = ''
    this.contentIndex = 0; this.blockCounter = 0; this.toolBlockStartEmitted = false
  }

  _handleCreated(d) {
    const resp = d.response || {}; this.responseId = resp.id || ''
    return [{ frame: claudeFrame('message_start', { type: 'message_start', message: { id: this.responseId, type: 'message', role: 'assistant', content: [], model: resp.model || '', stop_reason: null, stop_sequence: null, usage: { input_tokens: this.inputTokenEstimate, output_tokens: 0 } } }) }]
  }
  _handleOutputItemAdded(d) {
    const item = d.item
    if (item?.type === 'function_call') {
      this.state.toolId = item.call_id || ''; this.state.toolName = item.name || ''
      this.state.blockType = 'tool_use'; this.state.argBuf = ''; this.toolBlockStartEmitted = false
      this.bufferingSkillCall = this.state.toolName === 'Skill' && this.loadedSkills.size > 0
      this.contentIndex = this.blockCounter++
    }
    return []
  }
  _handleContentPartAdded(d) {
    const part = d.part
    if (part?.type === 'output_text') {
      this.state.blockType = 'text'; this.textBuf = ''; this.contentIndex = this.blockCounter++
      return [{ frame: claudeFrame('content_block_start', { type: 'content_block_start', index: this.contentIndex, content_block: { type: 'text', text: '' } }) }]
    }
    return []
  }
  _handleTextDelta(d) {
    this.textBuf += d.delta
    return [{ frame: claudeFrame('content_block_delta', { type: 'content_block_delta', index: this.contentIndex, delta: { type: 'text_delta', text: d.delta } }) }]
  }
  _handleContentPartDone() {
    if (this.state.blockType === 'text') {
      this.state.blockType = 'none'
      return [{ frame: claudeFrame('content_block_stop', { type: 'content_block_stop', index: this.contentIndex }) }]
    }
    return []
  }
  _handleFnArgsDelta(d) {
    const delta = d.delta; const chunks = []
    if (this.state.blockType !== 'tool_use') {
      this.state.blockType = 'tool_use'; this.state.argBuf = ''; this.contentIndex = this.blockCounter++
    }
    if (this.bufferingSkillCall) { this.state.argBuf += delta; return [] }
    if (!this.toolBlockStartEmitted) {
      this.toolBlockStartEmitted = true
      chunks.push({ frame: claudeFrame('content_block_start', { type: 'content_block_start', index: this.contentIndex, content_block: { type: 'tool_use', id: this.state.toolId, name: this.state.toolName } }) })
    }
    this.state.argBuf += delta
    chunks.push({ frame: claudeFrame('content_block_delta', { type: 'content_block_delta', index: this.contentIndex, delta: { type: 'input_json_delta', partial_json: delta } }) })
    return chunks
  }
  _handleFnArgsDone(d) {
    const callId = d.call_id || this.state.toolId
    const name = d.name || this.state.toolName
    const args = d.arguments || this.state.argBuf

    if (this.bufferingSkillCall) {
      this.bufferingSkillCall = false
      let isDuplicate = false
      try { const parsed = JSON.parse(args); if (parsed.skill && this.loadedSkills.has(parsed.skill)) isDuplicate = true } catch {}
      if (isDuplicate) {
        this.state.blockType = 'none'; this.state.argBuf = ''; this.state.toolId = ''; this.state.toolName = ''
        this.toolBlockStartEmitted = false; this.blockCounter--; return []
      }
      const emitChunks = []
      emitChunks.push({ frame: claudeFrame('content_block_start', { type: 'content_block_start', index: this.contentIndex, content_block: { type: 'tool_use', id: callId, name } }) })
      emitChunks.push({ frame: claudeFrame('content_block_delta', { type: 'content_block_delta', index: this.contentIndex, delta: { type: 'input_json_delta', partial_json: args } }) })
      emitChunks.push({ frame: claudeFrame('content_block_stop', { type: 'content_block_stop', index: this.contentIndex }) })
      this.state.completedTools.push({ callId, name, arguments: args })
      this.state.blockType = 'none'; this.state.argBuf = ''; this.toolBlockStartEmitted = false
      return emitChunks
    }

    const chunks = []
    if (!this.toolBlockStartEmitted) {
      this.toolBlockStartEmitted = true; this.contentIndex = this.blockCounter++
      if (callId) this.state.toolId = callId; if (name) this.state.toolName = name; this.state.blockType = 'tool_use'
      chunks.push({ frame: claudeFrame('content_block_start', { type: 'content_block_start', index: this.contentIndex, content_block: { type: 'tool_use', id: callId, name } }) })
    }
    if (!this.state.argBuf) {
      chunks.push({ frame: claudeFrame('content_block_delta', { type: 'content_block_delta', index: this.contentIndex, delta: { type: 'input_json_delta', partial_json: args || '{}' } }) })
    }
    chunks.push({ frame: claudeFrame('content_block_stop', { type: 'content_block_stop', index: this.contentIndex }) })
    this.state.completedTools.push({ callId, name, arguments: args })
    this.state.toolId = ''; this.state.toolName = ''; this.state.argBuf = ''
    this.state.blockType = 'none'; this.toolBlockStartEmitted = false
    return chunks
  }
  _handleCompleted(d) {
    const resp = d.response || {}; const usage = resp.usage
    const upstreamStopReason = resp.stop_reason
    let stopReason
    if (this.state.completedTools.length > 0) stopReason = 'tool_use'
    else if (upstreamStopReason === 'max_tokens') stopReason = 'max_tokens'
    else stopReason = 'end_turn'
    if (usage) { this._inputTokens = usage.input_tokens || this.inputTokenEstimate; this._outputTokens = usage.output_tokens || 0 }
    return [
      { frame: claudeFrame('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: usage?.output_tokens || 0 } }) },
      { frame: claudeFrame('message_stop', { type: 'message_stop' }), isComplete: true },
    ]
  }
}

// ===========================================================================
//  STREAM — Chat → Responses (from translator/stream/chat-to-responses.ts)
// ===========================================================================

function parseChatFrame(frame) {
  for (const line of frame.split('\n')) {
    if (line.startsWith('data: ')) {
      const payload = line.slice(6).trim()
      if (payload === '[DONE]') return null
      try { return JSON.parse(payload) } catch { return null }
    }
  }
  return null
}

class ChatToResponsesStream {
  constructor() {
    this.state = createInitialStreamState()
    this.chatId = ''; this.model = ''; this.textBuf = ''
    this.emittedCreated = false; this.emittedTextItem = false
    this.inputTokens = 0; this.outputTokens = 0; this.toolSlots = new Map()
  }
  translateChunk(frame) {
    const d = parseChatFrame(frame)
    if (!d) return []
    if (!this.chatId && d.id) this.chatId = d.id
    if (!this.model && d.model) this.model = d.model
    const usage = d.usage
    if (usage) { if (usage.prompt_tokens) this.inputTokens = usage.prompt_tokens; if (usage.completion_tokens) this.outputTokens = usage.completion_tokens }
    const choices = d.choices; if (!choices || choices.length === 0) return []
    const choice = choices[0]; const delta = choice.delta; const finishReason = choice.finish_reason
    const chunks = []
    if (!this.emittedCreated) {
      this.emittedCreated = true
      chunks.push({ frame: responsesFrame({ type: 'response.created', response: { id: this.chatId, status: 'in_progress', model: this.model } }) })
    }
    if (delta) {
      const content = delta.content
      if (content !== undefined && content !== null) {
        if (!this.emittedTextItem) {
          this.emittedTextItem = true
          chunks.push({ frame: responsesFrame({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant' } }) })
          chunks.push({ frame: responsesFrame({ type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } }) })
        }
        if (content.length > 0) {
          this.textBuf += content
          chunks.push({ frame: responsesFrame({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: content }) })
        }
      }
      const toolCalls = delta.tool_calls
      if (toolCalls) {
        for (const tc of toolCalls) {
          const idx = tc.index; const fn = tc.function
          let slot = this.toolSlots.get(idx)
          if (!slot) { slot = { index: idx, id: tc.id || '', name: fn?.name || '', argBuf: '' }; this.toolSlots.set(idx, slot); this.state.blockType = 'tool_use' }
          if (tc.id) slot.id = tc.id; if (fn?.name) slot.name = fn.name
          if (slot.id && slot.name && !slot.addedEmitted) {
            slot.addedEmitted = true
            chunks.push({ frame: responsesFrame({ type: 'response.output_item.added', output_index: idx, item: { type: 'function_call', call_id: slot.id, name: slot.name } }) })
          }
          if (fn?.arguments !== undefined) {
            slot.argBuf += fn.arguments
            chunks.push({ frame: responsesFrame({ type: 'response.function_call_arguments.delta', output_index: idx, content_index: idx, delta: fn.arguments }) })
          }
        }
      }
    }
    if (finishReason) {
      if (this.emittedTextItem) {
        chunks.push({ frame: responsesFrame({ type: 'response.output_text.done', output_index: 0, content_index: 0, text: this.textBuf }) })
        chunks.push({ frame: responsesFrame({ type: 'response.content_part.done', output_index: 0, content_index: 0, part: { type: 'output_text', text: this.textBuf } }) })
      }
      if (this.toolSlots.size > 0) {
        for (const [idx, slot] of [...this.toolSlots.entries()].sort((a, b) => a[0] - b[0])) {
          chunks.push({ frame: responsesFrame({ type: 'response.function_call_arguments.done', output_index: idx, content_index: idx, arguments: slot.argBuf, call_id: slot.id, name: slot.name }) })
          this.state.completedTools.push({ callId: slot.id, name: slot.name, arguments: slot.argBuf })
        }
      }
      let stopReason
      if (this.state.completedTools.length > 0) stopReason = 'tool_calls'
      else if (finishReason === 'length') stopReason = 'max_tokens'
      else stopReason = 'end_turn'
      chunks.push({ frame: responsesFrame({ type: 'response.completed', response: { id: this.chatId, status: 'completed', model: this.model, stop_reason: stopReason, usage: { input_tokens: this.inputTokens, output_tokens: this.outputTokens } } }), isComplete: true })
    }
    return chunks
  }
  completedToolCalls() { return [...this.state.completedTools] }
  completedText() { return this.textBuf }
  completedTokens() { return { input: this.inputTokens, output: this.outputTokens } }
  abort() {
    const partial = [...this.state.completedTools]
    for (const slot of this.toolSlots.values()) { if (slot.argBuf || slot.id) partial.push({ callId: slot.id, name: slot.name, arguments: slot.argBuf }) }
    return { partialToolCalls: partial, lastBlockType: this.state.blockType, closingFrames: [responsesFrame({ type: 'response.completed', response: { id: this.chatId || 'aborted', status: 'incomplete', model: this.model, usage: { input_tokens: this.inputTokens, output_tokens: this.outputTokens } } })] }
  }
  reset() {
    this.state = createInitialStreamState(); this.chatId = ''; this.model = ''; this.textBuf = ''
    this.emittedCreated = false; this.emittedTextItem = false; this.inputTokens = 0; this.outputTokens = 0; this.toolSlots = new Map()
  }
}

// ===========================================================================
//  STREAM — Responses → Chat (from translator/stream/responses-to-chat.ts)
// ===========================================================================

class ResponsesToChatStream {
  constructor() {
    this.state = createInitialStreamState()
    this.responseId = ''; this.model = ''; this.emittedRole = false
    this.toolIndex = 0; this.toolSlots = new Map(); this.textBuf = ''
    this.inputTokens = 0; this.outputTokens = 0
  }
  translateChunk(frame) {
    const d = parseResponsesFrame(frame); if (!d) return []
    const type = d.type
    switch (type) {
      case 'response.created': { const resp = d.response || {}; this.responseId = resp.id || ''; this.model = resp.model || ''; return [] }
      case 'response.output_text.delta': return this._handleTextDelta(d)
      case 'response.output_item.added': return this._handleOutputItemAdded(d)
      case 'response.function_call_arguments.delta': return this._handleFnArgsDelta(d)
      case 'response.function_call_arguments.done': return this._handleFnArgsDone(d)
      case 'response.completed': return this._handleCompleted(d)
      default: return []
    }
  }
  completedToolCalls() { return [...this.state.completedTools] }
  completedText() { return this.textBuf }
  completedTokens() { return { input: this.inputTokens, output: this.outputTokens } }
  abort() {
    const partial = [...this.state.completedTools]
    for (const slot of this.toolSlots.values()) { if (slot.argBuf || slot.id) partial.push({ callId: slot.id, name: slot.name, arguments: slot.argBuf }) }
    return { partialToolCalls: partial, lastBlockType: this.state.blockType }
  }
  reset() {
    this.state = createInitialStreamState(); this.responseId = ''; this.model = ''; this.emittedRole = false
    this.toolIndex = 0; this.toolSlots = new Map(); this.textBuf = ''
  }
  _handleOutputItemAdded(d) {
    const item = d.item; if (!item) return []
    if (item.type === 'function_call') {
      const outputIndex = typeof d.output_index === 'number' ? d.output_index : this.toolIndex
      if (outputIndex >= this.toolIndex) this.toolIndex = outputIndex + 1
      const slot = { index: outputIndex, id: item.call_id || '', name: item.name || '', argBuf: '' }
      this.toolSlots.set(outputIndex, slot); this.state.blockType = 'tool_use'
      const chunks = []
      if (!this.emittedRole) {
        this.emittedRole = true
        chunks.push({ frame: chatSSEFrame({ id: this.responseId, object: 'chat.completion.chunk', model: this.model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }) })
      }
      chunks.push({ frame: chatSSEFrame({ id: this.responseId, object: 'chat.completion.chunk', model: this.model, choices: [{ index: 0, delta: { tool_calls: [{ index: outputIndex, id: slot.id, type: 'function', function: { name: slot.name, arguments: '' } }] }, finish_reason: null }] }) })
      return chunks
    }
    return []
  }
  _handleTextDelta(d) {
    const delta = d.delta; this.textBuf += delta; const chunks = []
    if (!this.emittedRole) {
      this.emittedRole = true; this.state.blockType = 'text'
      chunks.push({ frame: chatSSEFrame({ id: this.responseId, object: 'chat.completion.chunk', model: this.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }) })
    }
    chunks.push({ frame: chatSSEFrame({ id: this.responseId, object: 'chat.completion.chunk', model: this.model, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] }) })
    return chunks
  }
  _handleFnArgsDelta(d) {
    const argDelta = d.delta
    const outputIndex = typeof d.output_index === 'number' ? d.output_index : this.toolIndex - 1
    const slotIdx = outputIndex >= 0 ? outputIndex : 0; const slot = this.toolSlots.get(slotIdx); if (slot) slot.argBuf += argDelta
    return [{ frame: chatSSEFrame({ id: this.responseId, object: 'chat.completion.chunk', model: this.model, choices: [{ index: 0, delta: { tool_calls: [{ index: slotIdx, function: { arguments: argDelta } }] }, finish_reason: null }] }) }]
  }
  _handleFnArgsDone(d) {
    const callId = d.call_id || ''; const name = d.name || ''; const args = d.arguments || ''
    this.state.completedTools.push({ callId, name, arguments: args })
    const outputIndex = typeof d.output_index === 'number' ? d.output_index : -1
    const slotByIndex = outputIndex >= 0 ? this.toolSlots.get(outputIndex) : undefined
    const slotByCallId = callId ? [...this.toolSlots.values()].find(s => s.id === callId) : undefined
    const slotByName = !slotByCallId && name ? [...this.toolSlots.values()].find(s => s.name === name && !s.argBuf) : undefined
    const slot = slotByIndex ?? slotByCallId ?? slotByName
    if (slot && slot.id !== callId) {
      slot.id = callId; slot.name = name
      return [{ frame: chatSSEFrame({ id: this.responseId, object: 'chat.completion.chunk', model: this.model, choices: [{ index: 0, delta: { tool_calls: [{ index: slot.index, id: callId, type: 'function', function: { name, arguments: args } }] }, finish_reason: null }] }) }]
    }
    if (!slot) {
      const idx = this.toolIndex++; this.toolSlots.set(idx, { index: idx, id: callId, name, argBuf: args }); this.state.blockType = 'tool_use'
      return [{ frame: chatSSEFrame({ id: this.responseId, object: 'chat.completion.chunk', model: this.model, choices: [{ index: 0, delta: { tool_calls: [{ index: idx, id: callId, type: 'function', function: { name, arguments: args } }] }, finish_reason: null }] }) }]
    }
    return []
  }
  _handleCompleted(d) {
    const resp = d.response || {}; const usage = resp.usage; const hasTools = this.state.completedTools.length > 0
    const finishPayload = { id: this.responseId, object: 'chat.completion.chunk', model: this.model, choices: [{ index: 0, delta: {}, finish_reason: hasTools ? 'tool_calls' : 'stop' }] }
    if (usage) { this.inputTokens = usage.input_tokens || 0; this.outputTokens = usage.output_tokens || 0; finishPayload.usage = { prompt_tokens: this.inputTokens, completion_tokens: this.outputTokens } }
    return [{ frame: chatSSEFrame(finishPayload) }, { frame: doneSSEFrame(), isComplete: true }]
  }
}

// ===========================================================================
//  STREAM — Gemini → Responses (from translator/stream/gemini-to-responses.ts)
// ===========================================================================

function mapGeminiFinishReason(reason, hasToolCalls) {
  if (hasToolCalls) return 'tool_calls'
  if (!reason) return 'end_turn'
  switch (reason) {
    case 'STOP': return 'end_turn'; case 'MAX_TOKENS': return 'max_tokens'; case 'SAFETY': return 'content_filter'
    default: return 'end_turn'
  }
}

class GeminiToResponsesStream {
  constructor() {
    this.completedTools = []; this.isFirstFrame = true; this.textBlockStarted = false
    this.accumulatedText = ''; this.inputTokens = 0; this.outputTokens = 0
    this.toolCallCounter = 0; this.responseId = ''
  }
  translateChunk(frame) {
    const d = parseResponsesFrame(frame); if (!d) return [] // Gemini also uses data: prefix
    const chunks = []
    if (this.isFirstFrame) {
      this.isFirstFrame = false; this.responseId = `gemini_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      chunks.push({ frame: responsesFrame({ type: 'response.created', response: { id: this.responseId, status: 'in_progress' } }) })
    }
    const usage = d.usageMetadata
    if (usage) { if (usage.promptTokenCount) this.inputTokens = usage.promptTokenCount; if (usage.candidatesTokenCount) this.outputTokens = usage.candidatesTokenCount }
    const candidates = d.candidates; if (!candidates || candidates.length === 0) return chunks
    const candidate = candidates[0]; const content = candidate.content; const finishReason = candidate.finishReason
    if (content?.parts) {
      for (const part of content.parts) {
        if (typeof part.text === 'string') {
          if (!this.textBlockStarted) {
            this.textBlockStarted = true
            chunks.push({ frame: responsesFrame({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant' } }) })
            chunks.push({ frame: responsesFrame({ type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } }) })
          }
          this.accumulatedText += part.text
          chunks.push({ frame: responsesFrame({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: part.text }) })
        } else if (part.functionCall) {
          const fc = part.functionCall; const name = fc.name
          const args = typeof fc.args === 'string' ? fc.args : JSON.stringify(fc.args ?? {})
          const callId = `gemini_call_${this.toolCallCounter}`; const outputIndex = this.toolCallCounter++
          chunks.push({ frame: responsesFrame({ type: 'response.output_item.added', output_index: outputIndex, item: { type: 'function_call', call_id: callId, name } }) })
          if (args) chunks.push({ frame: responsesFrame({ type: 'response.function_call_arguments.delta', output_index: outputIndex, content_index: outputIndex, call_id: callId, delta: args }) })
          chunks.push({ frame: responsesFrame({ type: 'response.function_call_arguments.done', output_index: outputIndex, content_index: outputIndex, call_id: callId, name, arguments: args }) })
          this.completedTools.push({ callId, name, arguments: args })
        }
      }
    }
    if (finishReason) {
      if (this.textBlockStarted) {
        chunks.push({ frame: responsesFrame({ type: 'response.output_text.done', output_index: 0, content_index: 0, text: this.accumulatedText }) })
        chunks.push({ frame: responsesFrame({ type: 'response.content_part.done', output_index: 0, content_index: 0, part: { type: 'output_text', text: this.accumulatedText } }) })
        chunks.push({ frame: responsesFrame({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', role: 'assistant', text: this.accumulatedText } }) })
      }
      chunks.push({ frame: responsesFrame({ type: 'response.completed', response: { id: this.responseId, status: 'completed', stop_reason: mapGeminiFinishReason(finishReason, this.completedTools.length > 0), usage: { input_tokens: this.inputTokens, output_tokens: this.outputTokens } } }), isComplete: true })
    }
    return chunks
  }
  completedToolCalls() { return [...this.completedTools] }
  completedText() { return this.accumulatedText }
  completedTokens() { return { input: this.inputTokens, output: this.outputTokens } }
  abort() { return { partialToolCalls: [...this.completedTools], lastBlockType: 'none' } }
  reset() { this.completedTools = []; this.isFirstFrame = true; this.textBlockStarted = false; this.accumulatedText = ''; this.inputTokens = 0; this.outputTokens = 0; this.toolCallCounter = 0; this.responseId = '' }
}

// ===========================================================================
//  STREAM — Responses → Gemini (from translator/stream/responses-to-gemini.ts)
// ===========================================================================

function mapResponsesStopReason(reason) {
  if (!reason) return 'STOP'
  switch (reason) { case 'stop': return 'STOP'; case 'max_tokens': return 'MAX_TOKENS'; case 'content_filter': return 'SAFETY'; default: return 'STOP' }
}

function geminiSSEFrame(payload) { return `data: ${JSON.stringify(payload)}\n\n` }

class ResponsesToGeminiStream {
  constructor() { this.completedTools = []; this.textBuf = ''; this.inputTokens = 0; this.outputTokens = 0 }
  translateChunk(frame) {
    const d = parseResponsesFrame(frame); if (!d) return []; const type = d.type
    switch (type) {
      case 'response.created': return []
      case 'response.output_text.delta': {
        this.textBuf += d.delta
        return [{ frame: geminiSSEFrame({ candidates: [{ content: { parts: [{ text: d.delta }], role: 'model' } }] }) }]
      }
      case 'response.function_call_arguments.done': {
        const name = d.name; const argsStr = d.arguments; const callId = d.call_id || ''
        let argsObj; try { argsObj = JSON.parse(argsStr) } catch { argsObj = {} }
        this.completedTools.push({ callId, name, arguments: argsStr })
        return [{ frame: geminiSSEFrame({ candidates: [{ content: { parts: [{ functionCall: { name, args: argsObj } }], role: 'model' } }] }) }]
      }
      case 'response.completed': {
        const resp = d.response || {}; const usage = resp.usage
        if (usage) { this.inputTokens = usage.input_tokens || 0; this.outputTokens = usage.output_tokens || 0 }
        return [{ frame: geminiSSEFrame({ candidates: [{ content: { parts: [], role: 'model' }, finishReason: mapResponsesStopReason(resp.stop_reason) }], usageMetadata: { promptTokenCount: this.inputTokens, candidatesTokenCount: this.outputTokens } }), isComplete: true }]
      }
      default: return []
    }
  }
  completedToolCalls() { return [...this.completedTools] }
  completedText() { return this.textBuf }
  completedTokens() { return { input: this.inputTokens, output: this.outputTokens } }
  abort() { return { partialToolCalls: [...this.completedTools], lastBlockType: 'none' } }
  reset() { this.completedTools = []; this.textBuf = '' }
}

// ===========================================================================
//  STREAM — Passthrough (from translator/stream/passthrough.ts)
// ===========================================================================

class PassthroughStream {
  constructor(opts) {
    this.tools = []; this.currentTool = null; this.textBuf = ''
    this.inputTokens = 0; this.outputTokens = 0
    this.skipAccumulate = opts?.skipAccumulate ?? false
  }
  translateChunk(frame) {
    if (!frame.trim()) return []
    let isComplete = false
    for (const line of frame.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === 'data: [DONE]') { isComplete = true; continue }
      if (!line.startsWith('data: ')) continue
      try {
        const d = JSON.parse(line.slice(6))
        if (this.skipAccumulate) { isComplete = isComplete || this._isCompletionEvent(d) }
        else { this._accumulateFromEvent(d); isComplete = isComplete || this._isCompletionEvent(d) }
      } catch {}
    }
    return [{ frame, isComplete }]
  }
  completedToolCalls() { this._finalizeCurrentTool(); return [...this.tools] }
  completedText() { return this.textBuf }
  completedTokens() { return { input: this.inputTokens, output: this.outputTokens } }
  abort() { this._finalizeCurrentTool(); return { partialToolCalls: [...this.tools], lastBlockType: this.currentTool ? 'tool_use' : 'text' } }
  reset() { this.tools = []; this.currentTool = null; this.textBuf = ''; this.inputTokens = 0; this.outputTokens = 0 }
  _accumulateFromEvent(d) {
    const type = d.type
    if (type === 'content_block_start') {
      const block = d.content_block
      if (block?.type === 'tool_use') { this._finalizeCurrentTool(); this.currentTool = { callId: String(block.id ?? ''), name: String(block.name ?? ''), argsBuf: '' } }
    } else if (type === 'content_block_delta') {
      const delta = d.delta
      if (delta?.type === 'input_json_delta' && this.currentTool) this.currentTool.argsBuf += String(delta.partial_json ?? '')
      else if (delta?.type === 'text_delta') this.textBuf += String(delta.text ?? '')
    } else if (type === 'content_block_stop') { this._finalizeCurrentTool() }
    const choices = d.choices
    if (choices?.[0]) {
      const choice = choices[0]; const delta = choice.delta
      if (delta) {
        if (typeof delta.content === 'string') this.textBuf += delta.content
        const tcDeltas = delta.tool_calls
        if (tcDeltas) {
          for (const tc of tcDeltas) {
            const fn = tc.function
            if (fn?.name) { this._finalizeCurrentTool(); this.currentTool = { callId: String(tc.id ?? ''), name: String(fn.name), argsBuf: String(fn.arguments ?? '') } }
            else if (fn?.arguments && this.currentTool) this.currentTool.argsBuf += String(fn.arguments)
          }
        }
      }
      if (choice.finish_reason) this._finalizeCurrentTool()
    }
    if (type === 'message_start') { const usage = d.message?.usage; if (usage?.input_tokens) this.inputTokens = usage.input_tokens }
    if (type === 'message_delta') { const usage = d.usage; if (usage?.output_tokens) this.outputTokens = usage.output_tokens; if (usage?.input_tokens && !this.inputTokens) this.inputTokens = usage.input_tokens }
    if (d.usage && typeof d.usage === 'object' && !type) { if (d.usage.prompt_tokens) this.inputTokens = d.usage.prompt_tokens; if (d.usage.completion_tokens) this.outputTokens = d.usage.completion_tokens }
    if (type === 'response.completed') { const usage = d.response?.usage; if (usage?.input_tokens) this.inputTokens = usage.input_tokens; if (usage?.output_tokens) this.outputTokens = usage.output_tokens }
    if (type === 'response.function_call_arguments.done') { this.tools.push({ callId: String(d.call_id ?? d.item_id ?? ''), name: String(d.name ?? ''), arguments: String(d.arguments ?? '') }) }
    else if (type === 'response.output_text.delta') { this.textBuf += String(d.delta ?? '') }
  }
  _finalizeCurrentTool() {
    if (this.currentTool) { this.tools.push({ callId: this.currentTool.callId, name: this.currentTool.name, arguments: this.currentTool.argsBuf }); this.currentTool = null }
  }
  _isCompletionEvent(d) {
    if (d.type === 'response.completed') return true; if (d.type === 'message_stop') return true
    if (d.candidates?.[0]?.finishReason) return true; if (d.choices?.[0]?.finish_reason) return true
    return false
  }
}

// ===========================================================================
//  STREAM — ComposedStream + Factory (from translator/stream/factory.ts)
// ===========================================================================

class ComposedStream {
  constructor(stage1, stage2) { this.stage1 = stage1; this.stage2 = stage2 }
  translateChunk(frame) {
    const intermediate = this.stage1.translateChunk(frame); const results = []
    for (const chunk of intermediate) {
      const translated = this.stage2.translateChunk(chunk.frame); results.push(...translated)
      if (translated.length === 0 && chunk.isComplete) results.push({ frame: '', isComplete: true })
    }
    return results
  }
  completedToolCalls() { return this.stage1.completedToolCalls() }
  completedText() { return this.stage1.completedText() }
  completedTokens() { return this.stage1.completedTokens() }
  abort() { const s1 = this.stage1.abort(); this.stage2.abort(); return s1 }
  reset() { this.stage1.reset(); this.stage2.reset() }
}

function getDirectTranslator(from, to) {
  if (from === 'anthropic-messages' && to === 'openai-responses') return new ClaudeToResponsesStream()
  if (from === 'anthropic-messages' && to === 'openai-chat') return new ClaudeToChatStream()
  if (from === 'openai-responses' && to === 'anthropic-messages') return new ResponsesToClaudeStream()
  if (from === 'openai-chat' && to === 'openai-responses') return new ChatToResponsesStream()
  if (from === 'openai-responses' && to === 'openai-chat') return new ResponsesToChatStream()
  if (from === 'gemini' && to === 'openai-responses') return new GeminiToResponsesStream()
  if (from === 'openai-responses' && to === 'gemini') return new ResponsesToGeminiStream()
  return null
}

function createStreamTranslator(from, to) {
  if (from === to) return new PassthroughStream()
  const direct = getDirectTranslator(from, to)
  if (direct) return direct
  const toHub = getDirectTranslator(from, 'openai-responses')
  const fromHub = getDirectTranslator('openai-responses', to)
  if (toHub && fromHub) return new ComposedStream(toHub, fromHub)
  throw new Error(`No stream translator for ${from} → ${to}`)
}

// ===========================================================================
//  SSE Frame Buffer (from providers/base-provider.ts)
// ===========================================================================

function createSSEFrameBuffer() {
  let parts = []; let totalLength = 0
  function push(chunk) {
    if (!chunk) return []
    parts.push(chunk); totalLength += chunk.length
    const buffer = parts.join(''); const frames = []; let remaining = buffer; let idx
    while ((idx = remaining.indexOf('\n\n')) !== -1) {
      frames.push(remaining.slice(0, idx + 2)); remaining = remaining.slice(idx + 2)
    }
    parts = remaining.length > 0 ? [remaining] : []; totalLength = remaining.length
    return frames
  }
  function flush() {
    if (totalLength === 0) return null
    const remaining = parts.join(''); parts = []; totalLength = 0; return remaining
  }
  return { push, flush }
}

// ===========================================================================
//  Codex Body Preparation (from providers/codex.ts)
// ===========================================================================

const CODEX_ALLOWED_FIELDS = new Set([
  'model', 'instructions', 'input', 'stream', 'store',
  'tools', 'tool_choice', 'previous_response_id',
  'reasoning', 'text', 'truncation', 'metadata', 'parallel_tool_calls',
])

function prepareCodexBody(body) {
  const out = {}
  for (const key of Object.keys(body)) {
    if (CODEX_ALLOWED_FIELDS.has(key)) out[key] = body[key]
  }
  if (out.instructions === undefined) out.instructions = ''
  out.stream = true; out.store = false
  return out
}

// ===========================================================================
//  Skill Directive Rewriting (from clients/claude-cli.ts)
// ===========================================================================

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
  if (typeof result.system === 'string') {
    result.system = rewriteSkillDirectives(result.system)
  } else if (Array.isArray(result.system)) {
    result.system = result.system.map(p =>
      p.type === 'text' && typeof p.text === 'string'
        ? { ...p, text: rewriteSkillDirectives(p.text) } : p)
  }
  if (Array.isArray(result.messages)) {
    result.messages = result.messages.map(msg => {
      if (typeof msg.content === 'string') return { ...msg, content: rewriteSkillDirectives(msg.content) }
      if (Array.isArray(msg.content)) {
        return { ...msg, content: msg.content.map(part =>
          part.type === 'text' && typeof part.text === 'string'
            ? { ...part, text: rewriteSkillDirectives(part.text) } : part) }
      }
      return msg
    })
  }
  return result
}

// ===========================================================================
//  Helper functions
// ===========================================================================

function extractLoadedSkills(body) {
  const skills = new Set()
  if (!body || typeof body !== 'object') return skills
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type === 'tool_use' && part.name === 'Skill') {
        try { if (typeof part.input?.skill === 'string') skills.add(part.input.skill) } catch {}
      }
    }
  }
  return skills
}

function estimateInputTokens(body) {
  if (!body || typeof body !== 'object') return 0
  return Math.max(1, Math.ceil(JSON.stringify(body).length / 4))
}

// ===========================================================================
//  Exports (for use by autodev-codex.mjs or other scripts)
// ===========================================================================

export {
  createRequestTranslator,
  createStreamTranslator,
  createSSEFrameBuffer,
  ResponsesToClaudeStream,
  ClaudeToResponsesStream,
  ClaudeToChatStream,
  ChatToResponsesStream,
  ResponsesToChatStream,
  GeminiToResponsesStream,
  ResponsesToGeminiStream,
  PassthroughStream,
  ComposedStream,
  anthropicToHub,
  chatToHub,
  geminiToHub,
  hubToAnthropic,
  hubToChat,
  hubToCodex,
  hubToGemini,
  stripCacheControl,
  dedupSkillCalls,
  safeParse,
  shallowCopyBody,
  contentToArray,
  normalizeToolType,
  rewriteSkillDirectives,
  rewriteSkillDirectivesInBody,
  prepareCodexBody,
  extractLoadedSkills,
  estimateInputTokens,
}

// ===========================================================================
//  HTTP Proxy Handler
// ===========================================================================

async function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  // Handle count_tokens endpoint — return fake response
  if (req.url.includes('/count_tokens')) {
    let ctBody = ''
    for await (const chunk of req) ctBody += chunk
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ input_tokens: Math.ceil((ctBody.length || 100) / 4) }))
    return
  }

  if (req.method !== 'POST' || !req.url.includes('/v1/messages')) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found. Use POST /v1/messages' }))
    return
  }

  let rawBody = ''
  for await (const chunk of req) rawBody += chunk

  let body
  try { body = JSON.parse(rawBody || '{}') } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Invalid JSON' }))
    return
  }

  // Skip empty/invalid requests
  if (!body.model || !body.messages) {
    log('debug', 'Empty request — returning empty response')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      id: 'msg_empty', type: 'message', role: 'assistant',
      content: [{ type: 'text', text: '' }],
      model: body.model || 'unknown', stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    }))
    return
  }

  const requestModel = body.model || 'claude-sonnet-4'
  const mappedModel = MODEL_MAP[requestModel] || TARGET_MODEL

  log('info', `${requestModel} → ${mappedModel} | tools=${(body.tools || []).length} | msgs=${(body.messages || []).length} | provider=${PROVIDER_MODE}`)

  // --- Resolve auth token ---
  let token
  if (PROVIDER_MODE === 'openai-compat') {
    // API key mode: from --api-key or env
    token = API_KEY || process.env.OPENAI_API_KEY
    if (!token) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'No API key. Set --api-key or OPENAI_API_KEY env var.' } }))
      return
    }
  } else {
    // Codex OAuth mode
    try { token = getToken() } catch (err) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: err.message } }))
      return
    }
  }

  // Rewrite skill directives before translation
  const rewrittenBody = rewriteSkillDirectivesInBody(body)

  // --- Determine if model needs GPT translate pipeline ---
  const needsTranslate = mappedModel.startsWith('gpt') || mappedModel.startsWith('o1') || mappedModel.startsWith('o3') || mappedModel.startsWith('o4')

  if (PROVIDER_MODE === 'openai-compat' && !needsTranslate) {
    // ====== DIRECT MODE: non-GPT model, Anthropic-compatible endpoint ======
    // Forward as-is (Anthropic format) to the target URL
    const directBody = { ...rewrittenBody, model: mappedModel, stream: true }
    const directHeaders = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-api-key': token,
      'anthropic-version': '2023-06-01',
    }

    log('debug', `→ DIRECT ${TARGET_URL} model=${mappedModel}`)

    try {
      const upstream = await fetch(TARGET_URL, {
        method: 'POST', headers: directHeaders, body: JSON.stringify(directBody),
      })

      if (!upstream.ok) {
        const errText = await upstream.text()
        log('info', `Direct error: ${upstream.status} ${errText.slice(0, 300)}`)
        res.writeHead(upstream.status >= 500 ? 500 : upstream.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: errText.slice(0, 500) } }))
        return
      }

      // Pass through SSE as-is (already Anthropic format)
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })
      const reader = upstream.body.getReader()
      const decoder = new TextDecoder()
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read()
          if (done) { res.end(); return }
          res.write(decoder.decode(value, { stream: true }))
        }
      }
      await pump()
    } catch (err) {
      log('info', `Direct fetch error: ${err.message}`)
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: err.message } }))
      }
    }
    return
  }

  // ====== TRANSLATE MODE: GPT model or Codex provider ======
  // Translate: Anthropic → Hub (Responses API format)
  const hubRequest = anthropicToHub(rewrittenBody)
  hubRequest.model = mappedModel

  if (LOG_LEVEL === 'debug') {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const debugDir = '.workflow/proxy-debug'
    mkdirSync(debugDir, { recursive: true })
    const ts = Date.now()
    writeFileSync(`${debugDir}/${ts}-req-anthropic.json`, JSON.stringify(body, null, 2))
    writeFileSync(`${debugDir}/${ts}-req-hub.json`, JSON.stringify(hubRequest, null, 2))
  }

  // Determine upstream format and URL
  let upstreamUrl, upstreamBody, upstreamHeaders, streamFormat

  if (PROVIDER_MODE === 'codex') {
    // Codex Responses API
    upstreamUrl = TARGET_URL
    upstreamBody = prepareCodexBody(hubRequest)
    upstreamHeaders = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'Originator': 'codex_cli_rs',
    }
    const accountId = extractAccountId(token)
    if (accountId) upstreamHeaders['Chatgpt-Account-Id'] = accountId
    streamFormat = 'openai-responses'
  } else {
    // OpenAI Chat Completions (for GPT models on custom endpoints)
    upstreamUrl = TARGET_URL
    upstreamBody = hubToChat(hubRequest)
    upstreamBody.model = mappedModel
    upstreamBody.stream = true
    upstreamHeaders = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    }
    streamFormat = 'openai-chat'
  }

  log('debug', `→ ${upstreamUrl} model=${upstreamBody.model} format=${streamFormat}`)

  try {
    let upstream = await fetch(upstreamUrl, {
      method: 'POST', headers: upstreamHeaders, body: JSON.stringify(upstreamBody),
    })

    // 401 retry (Codex OAuth only)
    if (upstream.status === 401 && PROVIDER_MODE === 'codex') {
      log('info', '401 — refreshing token')
      cachedToken = null
      try {
        const freshToken = getToken()
        upstreamHeaders['Authorization'] = `Bearer ${freshToken}`
        const freshAccountId = extractAccountId(freshToken)
        if (freshAccountId) upstreamHeaders['Chatgpt-Account-Id'] = freshAccountId
        upstream = await fetch(upstreamUrl, { method: 'POST', headers: upstreamHeaders, body: JSON.stringify(upstreamBody) })
      } catch {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'Token refresh failed' } }))
        return
      }
    }

    if (!upstream.ok) {
      const errText = await upstream.text()
      log('info', `Upstream error: ${upstream.status} ${errText.slice(0, 300)}`)

      let errorType = 'api_error'
      let errorMsg = errText.slice(0, 500)
      if (upstream.status === 429) {
        errorType = 'rate_limit_error'
        errorMsg = 'Rate limited — wait or check plan quota.'
      } else if (upstream.status === 402 || errText.includes('quota') || errText.includes('billing')) {
        errorType = 'rate_limit_error'
        errorMsg = 'Token quota exhausted.'
      } else if (upstream.status >= 500) {
        errorMsg = `Server error (${upstream.status}). API may be down.`
      }

      res.writeHead(upstream.status >= 500 ? 500 : upstream.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: errorType, message: errorMsg } }))
      return
    }

    // Stream translate: upstream format → Anthropic SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })

    const translator = createStreamTranslator(streamFormat, 'anthropic-messages')
    if (translator.setInputTokenEstimate) translator.setInputTokenEstimate(estimateInputTokens(body))
    if (translator.setLoadedSkills) translator.setLoadedSkills(extractLoadedSkills(body))

    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    const frameBuffer = createSSEFrameBuffer()

    let streamCompleted = false

    try {
      while (true) {
        const { done, value } = await reader.read()

        if (done) {
          const trailing = decoder.decode()
          if (trailing) frameBuffer.push(trailing)
          const remaining = frameBuffer.flush()
          if (remaining !== null) {
            const normalized = remaining.endsWith('\n\n') ? remaining : remaining + '\n\n'
            const chunks = translator.translateChunk(normalized)
            for (const chunk of chunks) {
              res.write(chunk.frame)
              if (chunk.isComplete) streamCompleted = true
            }
          }
          break
        }

        const text = decoder.decode(value, { stream: true })
        const frames = frameBuffer.push(text)

        for (const frame of frames) {
          const chunks = translator.translateChunk(frame)
          for (const chunk of chunks) {
            res.write(chunk.frame)
            if (chunk.isComplete) streamCompleted = true
          }
        }
      }

      // Fallback: if stream ended without response.completed
      if (!streamCompleted) {
        log('debug', 'Stream ended without response.completed — emitting closing frames')
        const stopReason = translator.completedToolCalls?.().length > 0 ? 'tool_use' : 'end_turn'
        res.write(claudeFrame('message_delta', {
          type: 'message_delta', delta: { stop_reason: stopReason },
          usage: { output_tokens: translator.completedTokens?.().output || 0 },
        }))
        res.write(claudeFrame('message_stop', { type: 'message_stop' }))
      }
    } catch (err) {
      log('info', 'Stream error:', err.message)
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

// ===========================================================================
//  Server
// ===========================================================================

const server = createServer(handleRequest)

server.listen(PORT, '127.0.0.1', () => {
  console.log(`
  Autodev Proxy — Claude → Codex Translation (Full Pipeline)
  ─────────────────────────────────────────────────────────────
  Listening:    http://localhost:${PORT}
  Target:       ${CODEX_API_URL}
  Execute:      opus → ${EXEC_MODEL}
  General:      * → ${TARGET_MODEL}
  Account:      ${ACCOUNT}
  Translators:  anthropic ↔ responses ↔ chat ↔ gemini (all paths)

  Configure Claude Code:
    export ANTHROPIC_BASE_URL=http://localhost:${PORT}
    export ANTHROPIC_API_KEY=proxy

  Or just run: autodev-codex
  ─────────────────────────────────────────────────────────────
`)
})
