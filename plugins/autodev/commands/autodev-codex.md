---
name: autodev-codex
description: Setup và chạy Codex mode (GPT qua proxy). Lần đầu sẽ tự cài global command.
allowed-tools: Bash, Read, Write
---

# /autodev-codex

Lệnh này giúp setup và chạy Codex mode (dùng GPT thay Claude qua built-in proxy).

## Bước 1: Kiểm tra global command

Chạy:
```bash
which autodev-codex 2>/dev/null || where autodev-codex 2>NUL
```

## Bước 2: Nếu CHƯA có

Tự động install bằng cách chạy `install-cli.mjs` từ plugin:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/install-cli.mjs"
```

Sau đó thông báo:
```
✅ autodev-codex đã được cài đặt!

Cách dùng:
  autodev-codex              # Mở Claude Code session qua GPT proxy
  autodev-codex auth login   # Login OpenAI (lần đầu)
  autodev-codex --model X    # Chọn model

⚠ Cần mở terminal MỚI hoặc chạy: source ~/.bashrc
```

## Bước 3: Nếu ĐÃ có

Thông báo:
```
✅ autodev-codex đã cài sẵn.

Cách dùng:
  autodev-codex              # Mở Claude Code session qua GPT proxy
  autodev-codex auth login   # Login OpenAI
  autodev-codex --model X    # Chọn model
```

## Bước 4: Nếu user truyền args

`/autodev-codex auth login` → chạy trực tiếp:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/autodev-codex.mjs" auth login
```

`/autodev-codex` (không args) → hướng dẫn user thoát session hiện tại và chạy `autodev-codex` từ terminal vì cần restart Claude Code với proxy env vars.
