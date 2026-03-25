---
name: autodev-proxy
description: "Chay mini proxy de dung GPT/Codex thay Claude. Translate Anthropic API → OpenAI API tu dong. Usage: /autodev-proxy [--port 4141] [--model gpt-5.4]"
allowed-tools: Bash, Read
---

# /autodev-proxy — Mini Claude-to-OpenAI Proxy

## Parse arguments

- Khong co arg → port = 4141, model = gpt-5.4
- `--port N` → port = N
- `--model name` → target model
- `--account name` → OAuth account (default: "default")

## Xu ly

1. Kiem tra OAuth status truoc:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oauth.mjs" status
```

Neu chua login → huong dan user chay `/autodev-auth codex login` truoc.

2. Chay proxy server:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/proxy.mjs" --port {port} --target-model {model} --account {account}
```

3. Thong bao user:

```
Proxy dang chay tai: http://localhost:{port}
Model: * → {model}

Cau hinh Claude Code de dung proxy:
  export ANTHROPIC_BASE_URL=http://localhost:{port}
  export ANTHROPIC_API_KEY=proxy

Hoac them vao .claude/settings.json:
  { "env": { "ANTHROPIC_BASE_URL": "http://localhost:{port}", "ANTHROPIC_API_KEY": "proxy" } }

Sau do chay /autodev binh thuong — tat ca agents se dung {model} thay Claude.
```

## Cach hoat dong

```
Claude Code ──Anthropic API──▶ localhost:{port} (proxy)
                                    │
                               Translate request
                               (Anthropic → OpenAI)
                                    │
                               OAuth token tu dong
                                    │
                                    ▼
                           api.openai.com
                                    │
                               Translate response
                               (OpenAI → Anthropic)
                                    │
Claude Code ◀──Anthropic SSE──── localhost:{port}
```

- Tool calls (Read, Write, Edit, Bash...) duoc Claude Code xu ly — proxy chi translate LLM format
- Stream support day du (SSE chunk-by-chunk translation)
- OAuth token tu dong refresh
- Zero dependencies, pure Node.js
