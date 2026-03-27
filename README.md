# Autodev — Automated Development Workflow Plugin

A Claude Code plugin that orchestrates the full development pipeline: **brainstorm → spec/plan → implement → review → PR → done**.

## Quick Start

```bash
# Install plugin
claude plugin marketplace add vunh2301/autodev-plugin
claude plugin install autodev

# Run (opens Claude Code, autodev-codex/autodev-ram auto-installed on first session)
/autodev "add user authentication with JWT"
```

## Three Modes

| Mode | Command | Backend | Auth |
|------|---------|---------|------|
| **Claude** | `/autodev "..."` | Claude API | claude.ai login |
| **Codex** | `autodev-codex` | GPT via Codex OAuth | `autodev-codex auth login` |
| **RAM** | `autodev-ram` | Any provider via API key | `autodev-ram auth` |

## Codex Mode (GPT via OpenAI)

```bash
# 1. Login OpenAI (one-time)
autodev-codex auth login

# 2. Start session
autodev-codex
```

All Claude Code requests go through GPT. Full tool access.

## RAM Mode (Any Provider)

```bash
# 1. Setup credentials (one-time, saved to ~/.config/autodev/ram.json)
autodev-ram auth
#   → Enter API URL
#   → Enter API Key
#   → Enter default model (default: gpt-5.4)

# 2. Start session
autodev-ram                            # uses saved config
autodev-ram --model claude-opus-4      # override model
```

**Smart routing** — model name determines the pipeline:
- `gpt*`, `o1*`, `o3*`, `o4*` → translate (Anthropic → OpenAI format → provider)
- anything else → direct passthrough (Anthropic format → provider)

## Commands

| Command | Description |
|---------|-------------|
| `/autodev "request"` | Start a new workflow |
| `/autodev-status` | Show workflow status |
| `/stop-autodev` | Pause workflow |
| `/resume-autodev` | Resume paused workflow |
| `/autodev-retry wf_001:task_01` | Retry a failed task |
| `/autodev-cancel` | Cancel workflow |
| `/autodev-dashboard` | Open web dashboard |

## Configuration

After first run, edit `.workflow/reactions.yaml`:

```yaml
project:
  name: "my-project"
  language: "en"
  test_command: "npm test"

budget:
  task_budget_tokens: 50000
  workflow_budget_tokens: 200000

cache:
  enabled: true
```

## Pipeline

```
BRAINSTORM → SPEC/PLAN → IMPLEMENT → CODE REVIEW → UI/UX REVIEW → PR → DONE
     │           │ ▲          │ ▲          │ ▲          │ ▲
     │           ▼ │          ▼ │          ▼ │          ▼ │
     │        REVIEW       REVIEW       REVIEW       FIX
     │
     └─ Explores codebase, invokes skills (ui-ux-pro-max, etc.)
```

- **Smart merge**: small tasks (≤2 files) combine spec+plan
- **Parallel execution**: independent tasks run concurrently
- **UI/UX review**: skill-based + browser visual check (if playwright available)

## File Structure

```
.workflow/                    # Runtime state (gitignored)
├── reactions.yaml            # Project config
├── registry.json             # Workflow registry
└── wf_*/state.json           # Per-workflow state

~/.config/autodev/            # User-level config
├── ram.json                  # RAM mode credentials
└── oauth/                    # Codex OAuth tokens

docs/specs/                   # Design specs (committed)
docs/plans/                   # Implementation plans (committed)
```

## Update

```bash
claude plugin marketplace update autodev-marketplace
claude plugin uninstall autodev
claude plugin install autodev
```

## Troubleshooting

**`autodev-codex: command not found`**
```bash
# Mở Claude Code bình thường 1 lần (auto-install chạy khi startup)
claude
# Hoặc cài thủ công:
node ~/.claude/plugins/cache/autodev-marketplace/autodev/*/scripts/install-cli.mjs
```

**Claude vẫn dùng Anthropic API thay vì proxy**
```bash
# Check proxy đang chạy:
curl http://localhost:4141/health
# → {"status":"ok","provider":"codex","target_model":"gpt-5.4",...}

# Check env:
echo $ANTHROPIC_BASE_URL
# → http://localhost:4141  ✅ (đúng)
# → (trống)                ❌ (chạy lại autodev-codex hoặc autodev-ram)
```

**Auth conflict warning**
```bash
# Nếu thấy: "Both a token (claude.ai) and an API key are set"
claude /logout    # logout claude.ai trước
autodev-codex     # rồi chạy lại
```

**RAM mode: "Not configured"**
```bash
autodev-ram auth  # setup URL + API key (lưu vĩnh viễn)
```

## Requirements

- Claude Code CLI
- `gh` CLI (for PR creation)
- Git + Node.js

## License

MIT
