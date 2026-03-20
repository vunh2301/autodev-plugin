---
name: autodev-retry
description: "Retry a failed task. Usage: /autodev-retry wf_001:task_01 (single task), /autodev-retry wf_001 (all failed tasks)"
---

# /autodev-retry — Retry failed task

## Parse arguments

- No arg → `Need a target. Example: /autodev-retry wf_001:task_01` → STOP
- `wf_001` → retry ALL failed tasks in workflow
- `wf_001:task_01` → retry 1 specific task

## Process

1. **Read registry**
   - Read `.workflow/registry.json`
   - If not found → `No workflows found.` → STOP

2. **Find workflow**
   - Parse `wf_id` (and `task_id` if present) from argument
   - Find workflow in registry, if not found → `Workflow {wf_id} not found` → STOP

3. **Read state**
   - Read `.workflow/{wf_id}/state.json`

4. **Determine tasks to retry**
   - `wf_id:task_id` → find matching task, check `status == "failed"`
     - If not failed → `Task {task_id} is not failed (current: {status})` → STOP
   - `wf_id` → filter all tasks with `status == "failed"`
     - If no failed tasks → `No failed tasks in {wf_id}` → STOP

5. **For each task to retry**:
   a. Find last successful phase in `task.history[]` (scan from end):
      - Entry with `result` of `"done"` or `"approved"`
      - Determine next phase:
        - `spec_writing` (done) → `spec_review`
        - `spec_review` (approved) → `plan_writing`
        - `plan_writing` (done) → `plan_review`
        - `plan_review` (approved) → `implementing`
        - `implementing` (done) → `code_review`
        - `code_review` (approved) → `pr_created`
        - `pr_created` (done) → `pr_review`
      - If NO successful phase found → resume from `spec_writing`
   b. Set `task.status` = next phase
   c. Set `task.phase_loop_count` = 0
   d. Add history entry:
      ```json
      { "phase": "retry", "at": "<ISO now>", "result": "retrying", "details": "Retry from {last_phase}, continuing at {next_phase}" }
      ```

6. **Smart model upgrade**
   - If task failed with default model → suggest: `Task failed with default model. Try upgrading to opus?`
   - Wait for user response before continuing

7. **Update workflow**
   - Set workflow `status: "running"`, `paused_by: []`, `updated_at: <ISO now>`
   - Backup → `.workflow/{wf_id}/state.backup.json`
   - Write `.workflow/{wf_id}/state.json`
   - Update registry entry status → `"running"`
   - Write `registry.json`

8. **Output**

```
RETRY {wf_id}

{wf_id}/{task_id}
  Retry — last phase: {last_phase} → continue: {next_phase}

Switching to /autodev to continue orchestration...
```

9. **Hand off** — invoke `/autodev` skill to continue orchestration

## Notes

- Retry only applies to tasks with `status: "failed"`
- Phase loop count resets to 0 on retry
