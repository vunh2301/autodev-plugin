import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// PreCompact hook — inject critical workflow state into context
// so orchestrator can resume after context compaction.

const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const registryFile = join(cwd, '.workflow', 'registry.json');

if (!existsSync(registryFile)) process.exit(0);

try {
  const registry = JSON.parse(readFileSync(registryFile, 'utf-8'));
  const active = (registry.active_workflows || []).filter(
    w => w.status === 'running' || w.status === 'paused'
  );

  if (active.length === 0) process.exit(0);

  const lines = [
    '⚠ AUTODEV WORKFLOW STATE — PRESERVE AFTER COMPACT:',
    ''
  ];

  for (const wf of active) {
    lines.push(`WORKFLOW: ${wf.workflow_id} (${wf.status})`);
    lines.push(`  Request: "${wf.original_request}"`);
    lines.push(`  Progress: ${wf.tasks_completed}/${wf.tasks_total} tasks completed`);

    // Read per-workflow state for task details
    const stateFile = join(cwd, '.workflow', wf.workflow_id, 'state.json');
    if (existsSync(stateFile)) {
      try {
        const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
        for (const task of state.tasks) {
          const marker = task.status === 'completed' ? '✅' :
                         task.status === 'failed' ? '❌' :
                         task.status === 'pending' ? '⬚' : '🔵';
          lines.push(`  ${marker} ${task.task_id} (${task.slug}): ${task.status}`);
        }
      } catch { /* ignore corrupt state */ }
    }
    lines.push('');
  }

  lines.push('ACTION REQUIRED: Read .workflow/registry.json and .workflow/{wf_id}/state.json');
  lines.push('to resume the workflow. Run /resume-autodev or continue dispatching pending tasks.');

  console.log(lines.join('\n'));
} catch {
  // silent fail — precompact is best-effort
}
