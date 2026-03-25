# Autodev — Automated Development Workflow Plugin

A Claude Code plugin that orchestrates the full development pipeline: **brainstorm → spec+plan → implement → PR → review → done**.

## Features

- **Brainstorm phase** (v2.3) — explores codebase before writing specs, clarifies ambiguous requests
- **Smart merge** (v2.3) — small tasks (≤2 files) merge spec+plan into one phase, large tasks keep them separate
- **Multi-task parallel execution** — split requirements into independent tasks, run them concurrently on separate branches
- **Review loops** — automatic write → review → revise cycles with configurable max iterations
- **Cross-model review** (v2.1) — writer uses one LLM, reviewer uses another for higher-quality feedback
- **Cross-workflow communication** (v2.3) — multiple workflows can coordinate via SendMessage and shared artifacts
- **Budget tracking** (v2.1) — token/request usage monitoring per task/phase/model with cost estimates
- **Incremental cache** (v2.1) — cache specs and plans to skip redundant work
- **Multi-workflow** — run multiple workflows simultaneously with resource limits
- **Checkpoint & resume** — pause/resume at any point, survives session restarts and context compaction
- **OAuth cross-model dispatch** — login to OpenAI for GPT review without API keys

## Quick Start

### 1. Install the plugin

```bash
# Step 1: Add the marketplace (one-time)
claude plugin marketplace add vunh2301/autodev-plugin

# Step 2: Install
claude plugin install autodev
```

**Alternative — load directly (no install):**

```bash
# Clone and use --plugin-dir flag
git clone https://github.com/vunh2301/autodev-plugin.git ~/.claude/plugins/local/autodev-plugin
claude --plugin-dir ~/.claude/plugins/local/autodev-plugin
```

### 2. Initialize in your project

```bash
cd /path/to/your/project
node ~/.claude/plugins/local/autodev-plugin/scripts/init.mjs \
  --name "my-project" \
  --language "en" \
  --specs-dir "docs/specs" \
  --plans-dir "docs/plans"
```

This creates:
- `.workflow/reactions.yaml` — main config
- `.workflow/model-registry.json` — available LLM models
- `docs/specs/` and `docs/plans/` directories
- `.workflow/` added to `.gitignore`

### 3. Run your first workflow

```
/autodev "add user authentication with JWT"
```

## Commands

| Command | Description |
|---------|-------------|
| `/autodev "request"` | Start a new workflow |
| `/autodev-status` | Show workflow status dashboard |
| `/autodev-status wf_001` | Show status for specific workflow |
| `/stop-autodev` | Pause all running workflows |
| `/stop-autodev wf_001` | Pause specific workflow |
| `/resume-autodev` | Resume paused workflow |
| `/resume-autodev wf_001` | Resume specific workflow |
| `/autodev-retry wf_001:task_01` | Retry a failed task |
| `/autodev-cancel` | Cancel all workflows |
| `/autodev-cancel wf_001` | Cancel specific workflow |
| `/autodev-proxy` | Start proxy to use GPT/Codex instead of Claude |
| `/autodev-dashboard` | Open web dashboard (live progress, budget, tasks) |
| `/autodev-auth codex login` | Login to OpenAI (PKCE + auto-fallback Device Code) |
| `/autodev-auth codex status` | Show OAuth token status |
| `/autodev-auth codex accounts` | List OAuth accounts |

## Configuration

Edit `.workflow/reactions.yaml` in your project:

```yaml
project:
  name: "my-project"
  language: "en"          # en, vi, ja, zh, etc.
  specs_dir: "docs/specs"
  plans_dir: "docs/plans"
  test_command: "npm test"

notifications:
  email: null             # Set email to enable notifications

agents:
  role_mapping:
    spec-writer: default
    spec-reviewer: default
    implementer: default
    code-reviewer: default
```

### Cross-Model Review

Enable different LLMs for writer vs. reviewer roles:

```yaml
cross_model:
  enabled: true
  role_mapping:
    writer: "claude-opus-4"
    reviewer: "gpt-5.4"
    escalation: "gemini-2.5-pro"
```

### Budget Limits

Set token budgets and pricing for cost estimates:

```yaml
budget:
  task_budget_tokens: 50000
  workflow_budget_tokens: 200000
  warn_at_pct: 80
  # pricing:  # USD per 1M tokens — enables cost estimates in summary
  #   claude-opus-4:    { prompt: 15.00, completion: 75.00 }
  #   gpt-5.4:           { prompt: 2.50,  completion: 10.00 }
```

## Pipeline

```
┌───────────┐    ┌──────────────┐    ┌──────┐    ┌─────────┐    ┌──────┐
│ BRAINSTORM│───▶│ SPEC+PLAN(*) │───▶│ IMPL │───▶│ PR+PUSH │───▶│ DONE │
└───────────┘    └──────┬───────┘    └──┬───┘    └────┬────┘    └──────┘
                        │ ▲              │ ▲           │ ▲
                        ▼ │              ▼ │           ▼ │
                    ┌────────┐       ┌────────┐   ┌─────────┐
                    │SPEC/   │       │CODE    │   │PR       │
                    │PLAN    │       │REVIEW  │   │REVIEW   │
                    │REVIEW  │       └────────┘   └─────────┘
                    └────────┘

(*) Smart Merge: task ≤2 files → spec+plan merged into 1 phase
                 task ≥3 files → spec then plan separately
```

Each phase has a configurable review loop (default max: 3 iterations).

## File Structure

```
.workflow/                    # Runtime state (gitignored)
├── registry.json             # Multi-workflow registry
├── reactions.yaml            # Project config
├── model-registry.json       # Available LLM models
├── shared/                   # Cross-workflow signals & artifacts
├── cache/                    # Spec/plan cache (v2.1)
└── wf_YYYYMMDD_HHMMSS/      # Per-workflow state
    ├── state.json
    └── state.backup.json

~/.config/autodev/oauth/      # OAuth tokens (user-level, shared across projects)
├── accounts.json             # Account registry
└── default.json              # Credentials for "default" account

docs/specs/                   # Design specs (committed)
docs/plans/                   # Implementation plans (committed)
```

> **Windows:** OAuth tokens are stored in `%APPDATA%\autodev\oauth\`

## Update

```bash
# Step 1: Pull latest marketplace data
claude plugin marketplace update autodev-marketplace

# Step 2: Reinstall to get new version
claude plugin uninstall autodev
claude plugin install autodev

# Step 3: Restart Claude Code to apply
```

> **Note:** `claude plugin update autodev` currently has a bug with marketplace-sourced plugins. Use uninstall + install instead.

Your `.workflow/reactions.yaml` config is **never overwritten** by updates — only plugin commands/hooks change.

## Requirements

- Claude Code CLI
- `gh` CLI (for PR creation/review)
- Git
- Node.js (for init script and hooks)
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (auto-set by plugin on startup)

## License

MIT
