---
name: stop-autodev
description: "Stop a running workflow. Usage: /stop-autodev (all), /stop-autodev wf_001 (one workflow), /stop-autodev wf_001:task_01 (one task)"
---

# /stop-autodev — Stop running workflow

## Parse arguments

- No arg → target = ALL running workflows
- `wf_001` → target = 1 workflow
- `wf_001:task_01` → target = 1 task in workflow

## Process

1. **Read registry**
   - Read `.workflow/registry.json`
   - If not found → `No workflows running.` → STOP

2. **Determine targets**
   - No arg → filter all workflows with `status: "running"` from registry
   - `wf_id` → find matching workflow
   - `wf_id:task_id` → find matching workflow + task

3. **For each workflow target**:
   a. Read `.workflow/{wf_id}/state.json`
   b. If target is a specific task → only set that task `status: "paused"`
   c. If target is workflow → set all running tasks to `status: "paused"`
   d. Set workflow `status: "paused"`, `paused_by: ["command"]`, `updated_at: <ISO now>`
   e. Create checkpoint:
      ```json
      { "id": "cp_NNN", "at": "<ISO now>", "task_id": "<task>", "phase": "<phase>", "message": "Stopped by /stop-autodev" }
      ```
   f. Backup → write state file
   g. Update registry entry

4. **Write updated registry.json**

5. **Output**

```
STOP-AUTODEV

{wf_id}/{slug}
  ⏸ Stopped — {N} tasks paused
  Task 1 ({slug}): {phase} (loop {count}/{max})
  Task 2 ({slug}): {status}
  Checkpoint: {cp_id} saved

─────────────────────────────────

Use /resume-autodev to continue.
```

## Notes

- If workflow already paused → skip, output: `{wf_id} already paused.`
- This skill does NOT invoke the orchestrator after stopping
