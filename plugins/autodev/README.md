# autodev plugin

Automated development workflow orchestrator for Claude Code.

## Commands

| Command | Purpose |
|---------|---------|
| `/autodev "request"` | Run full pipeline |
| `/autodev-status` | Show workflow status |
| `/stop-autodev` | Pause workflow |
| `/resume-autodev` | Resume workflow |
| `/autodev-retry` | Retry failed tasks |
| `/autodev-cancel` | Cancel workflows |
| `/autodev-dashboard` | Open web dashboard |

## Codex Mode

Run with GPT instead of Claude:

```bash
autodev-codex auth login    # first time
autodev-codex               # start session
```

## Full documentation

See [../../README.md](../../README.md)
