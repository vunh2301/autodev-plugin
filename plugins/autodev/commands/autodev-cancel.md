---
name: autodev-cancel
description: "Cancel workflow or task. Usage: /autodev-cancel (all, requires confirmation), /autodev-cancel wf_001, /autodev-cancel wf_001:task_01"
---

# /autodev-cancel — Cancel workflow or task

## Parse arguments

- No arg → cancel ALL workflows (requires confirmation)
- `wf_001` → cancel 1 workflow
- `wf_001:task_01` → cancel 1 task in workflow

## Process

1. **Read registry**
   - Read `.workflow/registry.json`
   - If not found → `No workflows to cancel.` → STOP

2. **If NO arg** — cancel all:
   a. Request confirmation: `⚠ Cancel ALL {N} workflows? Type 'yes' to confirm.`
   b. If user does NOT confirm → `Cancelled operation.` → STOP
   c. If confirmed:
      - For each workflow in registry:
        - Read `.workflow/{wf_id}/state.json`
        - For each task with a branch → `git branch -D workflow/{slug}` (ignore error)
        - Delete folder: `rm -rf .workflow/{wf_id}/`
      - Delete `.workflow/registry.json`
      - Try deleting `.workflow/` if empty: `rmdir .workflow 2>/dev/null`
   d. Output:
   ```
   CANCEL-ALL
     Cancelled {N} workflows
     Branches deleted: {list or "none"}
     Registry deleted.
   ```

3. **If `wf_id`** — cancel 1 workflow:
   a. Find workflow in registry, if not found → `Workflow {wf_id} not found` → STOP
   b. Read `.workflow/{wf_id}/state.json`
   c. For each task with a branch → `git branch -D workflow/{slug}` (ignore error)
   d. Delete folder: `rm -rf .workflow/{wf_id}/`
   e. Remove entry from registry, write `registry.json`
   f. If registry empty → delete `registry.json` too
   g. Output:
   ```
   Cancelled workflow {wf_id} — {N} tasks cancelled
   Branches deleted: {list}
   ```

4. **If `wf_id:task_id`** — cancel 1 task:
   a. Find workflow + task, if not found → `{wf_id}:{task_id} not found` → STOP
   b. If task already `completed` → `Task already completed, nothing to cancel.` → STOP
   c. If task already `cancelled` → `Task already cancelled.` → STOP
   d. Set `task.status = "cancelled"`
   e. Add history entry: `{ "phase": "cancel", "at": "<ISO now>", "result": "cancelled", "details": "Cancelled by /autodev-cancel" }`
   f. Clean branch: `git branch -D workflow/{slug}` (ignore error)
   g. Check: if ALL tasks are cancelled/completed → set workflow `status: "cancelled"`, update registry
   h. Write `.workflow/{wf_id}/state.json` + `registry.json`
   i. Output:
   ```
   Cancelled task {task_id} ({slug})
   Branch deleted: workflow/{slug}
   ```

## Notes

- Always clean branches before deleting state
- Use `2>/dev/null` or ignore errors for git branch -D
- Do NOT delete merged code — only delete branches and state files
