import { readFileSync, existsSync } from 'fs';
import { join, basename } from 'path';

const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const registryFile = join(cwd, '.workflow', 'registry.json');
const projectName = basename(cwd);

// v2: read registry instead of singleton state.json
if (!existsSync(registryFile)) {
  // Fallback v1: check singleton state.json
  const v1State = join(cwd, '.workflow', 'state.json');
  if (existsSync(v1State)) {
    try {
      const state = JSON.parse(readFileSync(v1State, 'utf-8'));
      if (state.status === 'paused' || state.status === 'running') {
        console.log(`⏸ Workflow v1 detected: ${state.workflow_id} (${state.status})`);
        console.log('Use /resume-autodev to continue, or /autodev-cancel to discard.');
      }
    } catch {
      console.log('⚠ File .workflow/state.json is corrupt. Use /autodev-cancel to clean up.');
    }
  }
  process.exit(0);
}

// v2: read registry
try {
  const registry = JSON.parse(readFileSync(registryFile, 'utf-8'));
  const active = (registry.active_workflows || []).filter(
    w => w.status === 'paused' || w.status === 'running'
  );

  if (active.length === 0) process.exit(0);

  const lines = [`⏸ ${active.length} workflow(s) active in ${projectName}:`];

  for (const wf of active) {
    const summary = wf.request_summary || wf.original_request || '(no description)';
    lines.push(`  ${wf.wf_id || wf.workflow_id} (${wf.status}) — ${summary}`);
    lines.push(`    Tasks: ${wf.completed_tasks || 0}/${wf.task_count || '?'} completed`);

    // Read per-workflow state for task details
    const stateDir = wf.state_dir || (wf.wf_id || wf.workflow_id);
    const stateFile = join(cwd, '.workflow', stateDir, 'state.json');
    if (existsSync(stateFile)) {
      try {
        const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
        const activeTasks = (state.tasks || [])
          .filter(t => !['completed', 'pending', 'cancelled'].includes(t.status))
          .map(t => `      - ${t.task_id} (${t.slug}): ${t.status}`)
          .join('\n');
        if (activeTasks) lines.push(activeTasks);
      } catch { /* ignore corrupt state */ }
    }
  }

  lines.push('');
  lines.push('Use /resume-autodev to continue, /autodev-status for details, or /autodev-cancel to discard.');
  console.log(lines.join('\n'));
} catch {
  console.log('⚠ File .workflow/registry.json is corrupt. Use /autodev-cancel to clean up.');
}
