---
name: oauth-management
description: "OAuth token management for cross-model dispatch — how to run oauth.mjs commands, parse output, handle login/refresh flows"
---

# Authentication Management

Quan ly authentication cho cross-model dispatch. Hien ho tro: **codex** (OpenAI). Tuong lai: gemini, anthropic.

## Khi nao dung

- User yeu cau login provider (OpenAI, Gemini, v.v.)
- Cross-model dispatch can token de goi API
- User muon xem trang thai auth, chuyen account mac dinh

## Storage

Tokens luu tai user-level (share giua cac projects):
- **Linux/macOS:** `~/.config/autodev/oauth/`
- **Windows:** `%APPDATA%\autodev\oauth\`

## Provider: codex (OpenAI)

### Login (PKCE + auto-fallback Device Code)

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/oauth.mjs login [account-name]
```

### Login (Force Device Code)

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/oauth.mjs login --device [account-name]
```

### Logout

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/oauth.mjs logout <account-name>
```

### Liet ke accounts

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/oauth.mjs accounts
```

### Xem status

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/oauth.mjs status [account-name]
```

### Dat default account

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/oauth.mjs default <account-name>
```

### Force refresh token

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/oauth.mjs refresh [account-name]
```

### Get Token (cho cross-model dispatch)

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/oauth.mjs get-token [account-name] [--force-refresh]
```

## Output parsing

Tat ca commands tra ve JSON:
- Thanh cong: `{ "ok": true, "data": { ... } }`
- Loi: `{ "ok": false, "error": "..." }` (tren stderr, exit code 1)

## Account name

- Chi dung `[a-z0-9_-]`, toi da 32 ky tu
- Mac dinh: "default" neu khong chi dinh
- Vi du: "work", "personal", "team-alpha"
