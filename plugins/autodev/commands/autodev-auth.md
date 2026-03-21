---
name: autodev-auth
description: "Quan ly authentication cho cross-model dispatch. Syntax: /autodev-auth <provider> <action> [args]. Providers: codex (OpenAI). Actions: login, logout, status, accounts, default, refresh, get-token."
allowed-tools: Read, Bash, Glob
---

# /autodev-auth — Authentication Management

## Parse arguments

Format: `/autodev-auth <provider> <action> [args...]`

### Supported providers

| Provider | Description | Script |
|----------|-------------|--------|
| `codex` | OpenAI Codex (OAuth PKCE + Device Code) | `${CLAUDE_PLUGIN_ROOT}/scripts/oauth.mjs` |

> Tuong lai: `gemini`, `anthropic`, `github`, v.v.

### Actions

| Action | Args | Mô tả |
|--------|------|-------|
| `login` | `[account-name] [--device]` | Dang nhap. PKCE mac dinh, `--device` force Device Code |
| `logout` | `<account-name>` | Xoa credentials cho account |
| `status` | `[account-name]` | Xem token validity, thoi gian het han |
| `accounts` | | Liet ke tat ca accounts |
| `default` | `<account-name>` | Dat account mac dinh |
| `refresh` | `[account-name]` | Force refresh token |
| `get-token` | `[account-name] [--force-refresh]` | Lay access token cho API call |

---

## Xu ly

### 1. Parse provider va action

```
Input: /autodev-auth codex login work
  → provider = "codex"
  → action = "login"
  → remaining_args = ["work"]

Input: /autodev-auth codex login --device
  → provider = "codex"
  → action = "login"
  → remaining_args = ["--device"]
```

Neu thieu provider hoac action → hien thi usage guide.

### 2. Route to provider script

#### Provider: `codex`

Script: `node "${CLAUDE_PLUGIN_ROOT}/scripts/oauth.mjs" <action> [args...]`

**Login:**
```bash
# PKCE (default — browser redirect)
node "${CLAUDE_PLUGIN_ROOT}/scripts/oauth.mjs" login [account-name]

# Device Code (headless / SSH / force)
node "${CLAUDE_PLUGIN_ROOT}/scripts/oauth.mjs" login --device [account-name]
```

Khi chay login:
- Doc JSON output tu script
- Neu PKCE: browser se mo tu dong. Thong bao user cho callback hoan tat
- Neu Device Code: hien thi URL va code cho user nhap
- Hien thi ket qua thanh cong/that bai

**Logout:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oauth.mjs" logout <account-name>
```

**Status:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oauth.mjs" status [account-name]
```

Hien thi: account name, token validity, thoi gian het han, can refresh khong.

**Accounts:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oauth.mjs" accounts
```

Hien thi danh sach accounts dang table.

**Default:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oauth.mjs" default <account-name>
```

**Refresh:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oauth.mjs" refresh [account-name]
```

**Get-token:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oauth.mjs" get-token [account-name] [--force-refresh]
```

### 3. Output parsing

Tat ca commands tra ve JSON:
- Thanh cong: `{ "ok": true, "data": { ... } }`
- Loi: `{ "ok": false, "error": "..." }` (stderr, exit code 1)

Parse JSON va hien thi ket qua cho user mot cach than thien.

### 4. Provider not found

Neu provider chua duoc ho tro:
```
Provider "{provider}" chua duoc ho tro.
Providers hien co: codex
```

### 5. Storage

Tokens duoc luu tai user-level directory (khong phai trong project):
- **Linux/macOS:** `~/.config/autodev/oauth/`
- **Windows:** `%APPDATA%\autodev\oauth\`

Tokens share duoc giua cac projects — chi can login 1 lan.
