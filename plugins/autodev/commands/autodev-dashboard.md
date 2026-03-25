---
name: autodev-dashboard
description: "Mo dashboard web de xem tien trinh workflows. Chay: /autodev-dashboard [--port 3456]"
allowed-tools: Bash, Read
---

# /autodev-dashboard — Mo Dashboard Web

## Parse arguments

- Khong co arg → port = 3456
- `--port N` → port = N

## Xu ly

1. Chay dashboard server:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dashboard.mjs" --port {port} --dir .workflow
```

Server chay background. Thong bao user:

```
Dashboard dang chay tai: http://localhost:{port}
Mo browser de xem tien trinh workflows.
Nhan Ctrl+C trong terminal dashboard de dung.
```

2. Mo browser (best-effort):

```bash
# macOS
open http://localhost:{port}

# Windows
rundll32 url.dll,FileProtocolHandler "http://localhost:{port}"

# Linux
xdg-open http://localhost:{port}
```

3. Dashboard tu dong cap nhat khi workflow state thay doi (SSE + file watch).

## Features

- Xem tat ca workflows va tasks dang chay
- Progress bars cho tung task va workflow
- Budget tracking (tokens used / limit)
- Task status badges (brainstorming, writing, review, implementing, PR, done, failed)
- Reflect summary khi workflow hoan thanh
- Live update qua SSE — khong can refresh trang
- Dark theme, responsive
