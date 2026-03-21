import { readdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const worktreesDir = join(cwd, '.claude', 'worktrees');

if (!existsSync(worktreesDir)) process.exit(0);

try {
  const dirs = readdirSync(worktreesDir);
  if (dirs.length === 0) process.exit(0);

  for (const dir of dirs) {
    const wtPath = join(worktreesDir, dir);
    try {
      execSync(`git worktree remove "${wtPath}" --force`, { cwd, stdio: 'ignore' });
    } catch {
      // worktree already removed from git, just delete folder
      rmSync(wtPath, { recursive: true, force: true });
    }
  }

  // Prune stale worktree references
  execSync('git worktree prune', { cwd, stdio: 'ignore' });

  // Remove empty worktrees dir
  const remaining = readdirSync(worktreesDir);
  if (remaining.length === 0) {
    rmSync(worktreesDir, { recursive: true, force: true });
  }

  console.log(`🟣 ▸ Cleaned ${dirs.length} worktree(s)`);
} catch {
  // silent fail — cleanup is best-effort
}