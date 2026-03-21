---
name: oauth
description: "OAuth management for OpenAI cross-model dispatch — login, logout, multi-account, token management"
---

# OAuth Management

Quan ly OAuth cho OpenAI (Codex) — login, logout, multi-account, token management.

## Khi nao dung

- User yeu cau login OpenAI / quan ly OAuth accounts
- Cross-model dispatch can token de goi GPT API
- User muon xem trang thai OAuth, chuyen account mac dinh

## Login (PKCE + auto-fallback Device Code)

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/oauth.mjs login [account-name]
```

Doc JSON output. Neu PKCE: browser se mo, thong bao cho user cho callback. Neu headless/SSH: tu dong chuyen sang Device Code — hien thi URL + code cho user nhap.

## Login (Force Device Code)

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/oauth.mjs login --device [account-name]
```

Hien thi URL va code. Huong dan user mo URL va nhap code.

## Logout

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/oauth.mjs logout <account-name>
```

## Liet ke accounts

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/oauth.mjs accounts
```

## Xem status

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/oauth.mjs status [account-name]
```

Hien thi thong tin account, token validity, thoi gian het han.

## Dat default account

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/oauth.mjs default <account-name>
```

## Force refresh token

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/oauth.mjs refresh [account-name]
```

## Get Token (cho cross-model dispatch)

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/oauth.mjs get-token [account-name] [--force-refresh]
```

Dung output token cho `Authorization: Bearer` header khi goi OpenAI API.

## Output parsing

Tat ca commands tra ve JSON:
- Thanh cong: `{ "ok": true, "data": { ... } }`
- Loi: `{ "ok": false, "error": "..." }` (tren stderr, exit code 1)

## Account name

- Chi dung `[a-z0-9_-]`, toi da 32 ky tu
- Mac dinh: "default" neu khong chi dinh
- Vi du: "work", "personal", "team-alpha"
