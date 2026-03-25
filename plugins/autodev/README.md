# autodev plugin

Automated development workflow orchestrator for Claude Code.

**Pipeline:** brainstorm → spec+plan → implement → PR → review → done

## Commands

| Command | Purpose |
|---------|---------|
| `/autodev "request"` | Run full pipeline |
| `/autodev-status` | Show workflow dashboard |
| `/stop-autodev` | Pause workflow |
| `/resume-autodev` | Resume paused workflow |
| `/autodev-retry` | Retry failed tasks |
| `/autodev-cancel` | Cancel workflows |
| `/autodev-dashboard` | Open web dashboard |
| `/autodev-auth codex login` | Login to OpenAI |
| `/autodev-auth codex status` | Show token status |
| `/autodev-auth codex accounts` | List accounts |

## Key Features (v2.3)

- **Brainstorm** — explores codebase before spec, clarifies ambiguous requests
- **Smart merge** — small tasks merge spec+plan, large tasks keep them separate
- **Cross-workflow** — multiple workflows coordinate via SendMessage and shared artifacts
- **Compact resilience** — survives Claude Code context compaction

## Authentication

Cross-model review requires OpenAI OAuth login:

```
/autodev-auth codex login
```

Tokens are stored at user-level (shared across projects):
- **Linux/macOS:** `~/.config/autodev/oauth/`
- **Windows:** `%APPDATA%\autodev\oauth\`

## Requirements

- Claude Code CLI
- `gh` CLI (for PR creation)
- Node.js (for hooks and scripts)

> `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is auto-set by the plugin on startup via SessionStart hook.

## Full documentation

See [../../README.md](../../README.md) for installation, configuration, and usage guide.
