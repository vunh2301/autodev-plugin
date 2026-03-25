import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const registryFile = join(cwd, '.workflow', 'registry.json');

// Show provider indicator
const provider = process.env.AUTODEV_PROVIDER;
if (provider === 'codex') {
  const model = process.env.AUTODEV_CODEX_MODEL || 'gpt-5.4';
  const execModel = process.env.AUTODEV_CODEX_EXEC_MODEL || 'gpt-5.3-codex';
  console.log(`[codex] Provider: OpenAI Codex | General: ${model} | Execute: ${execModel}`);
}

// v2: đọc registry thay vì singleton state.json
if (!existsSync(registryFile)) {
  // Fallback v1: check singleton state.json
  const v1State = join(cwd, '.workflow', 'state.json');
  if (existsSync(v1State)) {
    try {
      const state = JSON.parse(readFileSync(v1State, 'utf-8'));
      if (state.status === 'paused' || state.status === 'running') {
        console.log(`⏸ Workflow v1 đang chờ: ${state.workflow_id} (${state.status})`);
        console.log('Dùng /resume-autodev để tiếp tục, hoặc /autodev-cancel để huỷ.');
      }
    } catch {
      console.log('⚠ File .workflow/state.json bị lỗi. Dùng /autodev-cancel để dọn dẹp.');
    }
  }
  process.exit(0);
}

// v2: đọc registry
try {
  const registry = JSON.parse(readFileSync(registryFile, 'utf-8'));
  const active = (registry.active_workflows || []).filter(
    w => w.status === 'paused' || w.status === 'running'
  );

  if (active.length === 0) process.exit(0);

  const lines = [`⏸ ${active.length} workflow(s) đang chờ:`];

  for (const wf of active) {
    lines.push(`  ${wf.workflow_id} (${wf.status}) — ${wf.original_request}`);
    lines.push(`    Tasks: ${wf.tasks_completed}/${wf.tasks_total} completed, ${wf.current_agents} agents`);

    // Đọc per-workflow state cho task details
    const stateFile = join(cwd, '.workflow', wf.workflow_id, 'state.json');
    if (existsSync(stateFile)) {
      try {
        const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
        const activeTasks = state.tasks
          .filter(t => !['completed', 'pending', 'cancelled'].includes(t.status))
          .map(t => `      - ${t.task_id} (${t.slug}): ${t.status}`)
          .join('\n');
        if (activeTasks) lines.push(activeTasks);
      } catch { /* ignore corrupt state */ }
    }
  }

  lines.push('');
  lines.push('Dùng /resume-autodev để tiếp tục, /autodev-status để xem chi tiết, hoặc /autodev-cancel để huỷ.');
  console.log(lines.join('\n'));
} catch {
  console.log('⚠ File .workflow/registry.json bị lỗi. Dùng /autodev-cancel để dọn dẹp.');
}