---
name: resume-autodev
description: "Resume a paused workflow. Supports v1 migration, multi-workflow (wf_id/wf_id:task_id). Usage: /resume-autodev or /resume-autodev wf_001"
---

# /resume-autodev — Resume paused workflow

## Process

1. **Detect v1 vs v2**
   - Check `.workflow/registry.json` exists?
     - **YES** → v2 mode → step 2a
     - **NO** → check `.workflow/state.json` exists?
       - **YES** → v1 detected → run **v1 Migration** (see autodev.md Section 25) → after migration → v2 mode → step 2a
       - **NO** → try `.workflow/state.backup.json`
       - If neither exists → output: `"No workflow found."` → STOP

2. **Parse argument (v2 multi-workflow)**
   - If argument matches `wf_*:task_*` → parse `wf_id` + `task_id`
   - If argument matches `wf_*` → parse `wf_id`, `task_id` = null (resume entire workflow)
   - If argument matches `task_*` → `wf_id` = null (auto-find), `task_id` = argument
   - If argument is a flag (`--accept`, `--reject`, `--resolve`, `--budget`) → save flags
   - If no argument → `wf_id` = null, `task_id` = null (auto-find)

3. **Find workflow (v2)**
   - Read `.workflow/registry.json`
   - If `wf_id` specified → find in `active_workflows[]`
   - If `wf_id` = null → find first workflow with `status` of `"paused"` or `"failed"`
     - If multiple workflows paused → list all, ask user to choose
   - If none found → `"No workflow needs resuming."` → STOP

4. **Read state file**
   - Read `.workflow/{wf_id}/state.json`
   - Fallback to `.workflow/{wf_id}/state.backup.json`

5. **Check status**
   - If `"running"` → `"Workflow already running. Use /autodev-status to check."` → STOP
   - If `"completed"` → `"Workflow already completed."` → STOP

6. **Find task to resume**
   - If `task_id` specified → find matching task
   - If no `task_id` → find first task not in `["pending", "completed", "cancelled", "blocked"]`

7. **Determine resume strategy**
   - Phase ending in `_review` → "Continue review loop — will dispatch reviewer again"
   - Phase is `implementing` → "Continue implementation — check code progress"
   - Phase is `spec_writing` / `plan_writing` → check if artifact exists → adjust strategy
   - **Paused by consensus** → check `--accept`/`--reject`/`--resolve` flags
   - **Paused by budget** → check `--budget +50%` or `--budget unlimited` flags
   - **Paused by timeout** → auto-resolve timeout reason

8. **Get nearest checkpoint** (if any)

9. **Update state**
   - Resolve paused_by reasons (remove handled ones, keep unhandled)
   - If `paused_by` empty → set `status: "running"`
   - Update `timers.current_task_start`

10. **Backup and write**
    - Backup → write state → update registry

11. **Output resume info**

```
▶ Resuming workflow {wf_id}
Task: {task_id} ({slug})
Phase: {phase}
Loop: {phase_loop_count}/{max}
Nearest checkpoint: {checkpoint_id} — {checkpoint_message}
Strategy: {strategy description}
```

12. **Hand off** — invoke `/autodev` to continue orchestration
