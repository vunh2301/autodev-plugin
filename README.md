# Autodev — Automated Development Workflow Plugin

A Claude Code plugin that orchestrates the full development pipeline: **brainstorm → spec/plan → implement → review → PR → done**.

## Quick Start

```bash
# Install
claude plugin marketplace add vunh2301/autodev-plugin
claude plugin install autodev

# Run (Claude mode)
/autodev "add user authentication with JWT"

# Run (Codex mode — uses GPT via built-in proxy)
autodev-codex
```

## Two Modes

| | Claude Mode | Codex Mode |
|---|---|---|
| Command | `/autodev "request"` | `autodev-codex` then `/autodev "request"` |
| Backend | Claude API (default) | OpenAI Codex via built-in proxy |
| Auth | claude.ai login | `autodev-codex auth login` |
| Setup | None | One-time: `node install-cli.mjs` |

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

## Codex Mode Setup

```bash
# 1. Install global command (one-time)
node ~/.claude/plugins/cache/autodev-marketplace/autodev/*/scripts/install-cli.mjs

# 2. Login to OpenAI
autodev-codex auth login

# 3. Run
autodev-codex
```

## Configuration

After first run, edit `.workflow/reactions.yaml`:

```yaml
project:
  name: "my-project"
  language: "en"              # en, vi, ja, zh, etc.
  test_command: "npm test"

budget:
  task_budget_tokens: 50000   # null = unlimited
  workflow_budget_tokens: 200000

cache:
  enabled: true
```

## Pipeline

```
BRAINSTORM → SPEC/PLAN → IMPLEMENT → CODE REVIEW → PR → DONE
     │           │ ▲          │ ▲          │ ▲
     │           ▼ │          ▼ │          ▼ │
     │        REVIEW       REVIEW       REVIEW
     │
     └─ Explores codebase, clarifies requirements
```

- **Smart merge**: small tasks (≤2 files) combine spec+plan into one phase
- **Parallel execution**: independent tasks run concurrently
- **Review loops**: max 3 iterations per phase

## File Structure

```
.workflow/                    # Runtime state (gitignored)
├── reactions.yaml            # Project config (edit this)
├── registry.json             # Workflow registry
└── wf_*/state.json           # Per-workflow state

docs/specs/                   # Design specs (committed)
docs/plans/                   # Implementation plans (committed)
```

## Update

```bash
claude plugin marketplace update autodev-marketplace
claude plugin uninstall autodev
claude plugin install autodev
```

## Requirements

- Claude Code CLI
- `gh` CLI (for PR creation)
- Git + Node.js

## License

MIT
