import { appendFileSync } from 'fs';

// SessionStart hook — auto-set required env vars via $CLAUDE_ENV_FILE
// This enables Agent Teams (named agents + SendMessage) without user config.

const envFile = process.env.CLAUDE_ENV_FILE;
if (!envFile) process.exit(0);

try {
  appendFileSync(envFile, 'export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1\n');
} catch {
  // silent fail — env file may not be writable in some contexts
}
