# autodev plugin

Automated development workflow orchestrator for Claude Code.

**Pipeline:** spec → plan → implement → PR → review → done

## Commands

| Command | Purpose |
|---------|---------|
| `/autodev "request"` | Run full pipeline |
| `/autodev-status` | Show workflow dashboard |
| `/stop-autodev` | Pause workflow |
| `/resume-autodev` | Resume paused workflow |
| `/autodev-retry` | Retry failed tasks |
| `/autodev-cancel` | Cancel workflows |
| `/autodev-auth codex login` | Login to OpenAI |
| `/autodev-auth codex status` | Show token status |
| `/autodev-auth codex accounts` | List accounts |

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
