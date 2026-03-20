---
name: autodev-status
description: "Show current workflow status. Lists tasks, phases, loop counts, checkpoints. Usage: /autodev-status or /autodev-status wf_001"
---

# /autodev-status — Show workflow status

## Process

1. **Read state file**
   - Read `.workflow/registry.json` → list all workflows
   - If argument provided → filter to that `wf_id`
   - If no registry → try `.workflow/state.json` (v1 fallback)
   - If nothing exists → output: `"No workflows found."` → STOP

2. **For each workflow**, read `.workflow/{wf_id}/state.json`

3. **Calculate progress per task**
   - Map `task.status` → percentage:
     - `pending` → 0%
     - `spec_writing`, `spec_review` → 20%
     - `plan_writing`, `plan_review` → 40%
     - `implementing`, `code_review` → 60%
     - `pr_created`, `pr_review` → 80%
     - `completed` → 100%
     - `failed`, `cancelled`, `blocked` → special display (see step 4)

4. **Create progress bar per task**
   - 10 characters, each = 10%
   - Filled: `█`, Empty: `░`
   - Example: 60% → `[██████░░░░]`
   - If `failed` → `[██FAILED██]`
   - If `cancelled` → `[CANCELLED─]`
   - If `blocked` → `[░░BLOCKED░]`

5. **Get last checkpoint**
   - Total checkpoints in `checkpoints[]`
   - Last checkpoint: last element of array

6. **Output dashboard**

```
┌────────────────────────────────────────────────────────┐
│ Workflow: {workflow_id}                                │
│ Status: {status}                                       │
│ Started: {created_at}                                  │
│ Updated: {updated_at}                                  │
│ Request: {original_request (truncate if > 60 chars)}   │
│                                                        │
│ Task 1: {slug}              [{progress_bar}] {pct}%   │
│   Phase: {status} (loop {phase_loop_count}/{max})     │
│   Branch: {branch}                                     │
│   PR: #{pr_number} or "—"                              │
│   Depends: {depends_on[] or "none"}                    │
│                                                        │
│ ... (repeat for all tasks)                             │
│                                                        │
│ Overall: [{overall_bar}] {overall_pct}%                │
│                                                        │
│ Checkpoints: {count} saved                             │
│ Last: {last checkpoint message}                        │
│                                                        │
│ Budget: {tokens_used} / {tokens_limit} ({pct}%)        │
│   [{budget_bar}] {budget_status}                       │
│   ├── task_01: {t_used} / {t_limit} ({t_pct}%) {s}    │
│   └── task_02: {t_used} / {t_limit} ({t_pct}%) {s}    │
│                                                        │
│ (If limit = null: "Budget: {tokens_used} tokens        │
│  (unlimited)")                                         │
└────────────────────────────────────────────────────────┘
```

Notes:
- `max` loop default = 3 if not specified
- `overall_pct` = average of all tasks (skip cancelled)
- If `status` is `"paused"` → add: `"⏸ Workflow paused. Use /resume-autodev to continue."`
- If `status` is `"failed"` → add: `"✗ Workflow failed. Use /autodev-retry {task_id} to retry."`

### Budget & Pause Reasons (v2.1)

- Read `workflow.budget` and `task.budget` from state file
- If `budget` field missing (old state) → display "Budget: no data"
- If `paused_by` contains `"budget"` → add: `"Workflow paused (budget exceeded). /resume-autodev --budget +50% or --budget unlimited"`
- If `paused_by` contains `"consensus_disagreement"` → add: `"Workflow paused (consensus disagreement). /resume-autodev --accept | --reject | --resolve"`

## Notes

- This skill is READ-ONLY, does NOT write files
- Does not change state
- Always display ALL tasks, including pending
