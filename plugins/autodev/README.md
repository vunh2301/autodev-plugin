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

## Requirements

Set in your project's `.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

## Full documentation

See [../../README.md](../../README.md) for installation, configuration, and usage guide.
