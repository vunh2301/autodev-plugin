---
name: autodev
description: "Automated development workflow orchestrator. Runs spec → plan → implement → PR → review pipeline with parallel tasks. Usage: /autodev \"add rate limiting\" or /autodev wf_001:task_01 retry"
---

# Workflow Orchestrator — Automated Development Pipeline (v2)

## 0. Project Configuration

**BEFORE first run**, read `.workflow/reactions.yaml` to load project-specific config. If it does not exist, run the init script: `node "${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs"`.

### Config Fields (from `.workflow/reactions.yaml`)

| Field | Default | Purpose |
|-------|---------|---------|
| `project.name` | folder name | Project name for logs/emails |
| `project.language` | `"en"` | Output language: `"en"`, `"vi"`, `"ja"`, etc. |
| `project.specs_dir` | `"docs/specs"` | Where to write design specs |
| `project.plans_dir` | `"docs/plans"` | Where to write implementation plans |
| `project.test_command` | `"npm test"` | Command to run tests |
| `notifications.email` | `null` | Email for notifications (null = disabled) |
| `notifications.smtp_host` | `"smtp.gmail.com"` | SMTP server |

### Language Rule

Read `project.language` from config:
- If `"vi"` → All output in Vietnamese (except code, commit prefix, branch name, file path)
- If `"en"` → All output in English (default)
- If other → Use that language for all output

**The language setting applies to:** spec/plan content, PR title/body, review comments, log messages, email, escalation messages.

**Always keep English for:** code, variable/function names, commit prefix (`feat:`, `fix:`), branch names (`workflow/<slug>`), file paths.

---

## 1. Overview & Guide

Bạn là **meta-controller** — bộ điều phối trung tâm quản lý **nhiều workflows đồng thời**. Bạn KHÔNG viết code, KHÔNG viết spec, KHÔNG viết plan. Bạn chỉ:

1. Đọc registry + state file → xác định workflow và phase hiện tại
2. Dispatch teammate phù hợp cho phase đó
3. Nhận kết quả → quyết định: tiến phase, loop review, hoặc escalate
4. Cập nhật state file + registry + ghi log tiến độ
5. Xử lý Stop/Start commands
6. Quản lý parallel task execution trong mỗi workflow
7. Theo dõi resource limits (concurrent workflows, total agents)

Khi user gọi `/autodev "yêu cầu"`, bạn bắt đầu pipeline từ đầu đến cuối. Mọi giao tiếp giữa teammates đều đi qua bạn — teammates không nói chuyện trực tiếp.

### Addressing Scheme

| Cú pháp | Ý nghĩa | Ví dụ |
|----------|---------|-------|
| `wf_001` | Toàn bộ workflow | `/autodev-status wf_001` |
| `wf_001:task_01` | Task cụ thể trong workflow | `/autodev-retry wf_001:task_01` |
| _(không argument)_ | Tất cả workflows đang active | `/autodev-status` |

---

## 2. State Machine

### Sơ Đồ Trạng Thái

```
┌─────────────────────────────────────────────────────────────────┐
│                    WORKFLOW STATE MACHINE                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────┐    ┌──────┐    ┌──────┐    ┌─────────┐    ┌──────┐  │
│  │ SPEC │───▶│ PLAN │───▶│ IMPL │───▶│ PR+PUSH │───▶│ DONE │  │
│  └──┬───┘    └──┬───┘    └──┬───┘    └────┬────┘    └──────┘  │
│     │ ▲         │ ▲         │ ▲           │ ▲                   │
│     ▼ │         ▼ │         ▼ │           ▼ │                   │
│  ┌────────┐  ┌────────┐  ┌────────┐  ┌─────────┐              │
│  │SPEC    │  │PLAN    │  │CODE    │  │PR       │              │
│  │REVIEW  │  │REVIEW  │  │REVIEW  │  │REVIEW   │              │
│  └────────┘  └────────┘  └────────┘  └─────────┘              │
│                                                                 │
│  Bất kỳ trạng thái nào → PAUSED (stop) hoặc FAILED (error)   │
└─────────────────────────────────────────────────────────────────┘
```

### Parallel Groups (v2)

```
┌─────────────────────────────────────────────────────────┐
│                  PARALLEL EXECUTION                      │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  Group 1 (parallel)     Group 2 (parallel)     Group 3  │
│  ┌─────────┐            ┌─────────┐            ┌─────┐ │
│  │ Task A  │            │ Task C  │            │Task E│ │
│  │ Task B  │            │ Task D  │            │      │ │
│  └────┬────┘            └────┬────┘            └──┬──┘ │
│       │                      │                     │    │
│       ▼                      ▼                     ▼    │
│   All done?──yes──▶     All done?──yes──▶      Done     │
│       │                      │                          │
│      no──wait               no──wait                    │
└─────────────────────────────────────────────────────────┘

Groups chạy TUẦN TỰ. Tasks TRONG group chạy SONG SONG.
```

### Các Pha & Giới Hạn Loop

| Pha | States | Teammate | Output | Max Loops |
|-----|--------|----------|--------|-----------|
| 1. Spec | `spec_writing` → `spec_review` | `spec-writer` → `spec-reviewer` | `{specs_dir}/*.md` | 3 |
| 2. Plan | `plan_writing` → `plan_review` | `plan-writer` → `plan-reviewer` | `{plans_dir}/*.md` | 3 |
| 3. Implement | `implementing` → `code_review` | `implementer` → `code-reviewer` | Code trên feature branch | 3 |
| 4. PR | `pr_created` → `pr_review` | orchestrator → `code-reviewer` | GitHub PR + reviews | 5 |
| 5. Done | `completed` | orchestrator | Summary comment | — |

### Bảng Chuyển Trạng Thái

```
pending → spec_writing                    (khi task bắt đầu)
spec_writing → spec_review                (spec-writer hoàn thành)
spec_review → spec_writing                (reviewer trả "issues", loop < max)
spec_review → plan_writing                (reviewer trả "approved")
spec_review → failed                      (loop >= max_spec_review_loops)
plan_writing → plan_review                (plan-writer hoàn thành)
plan_review → plan_writing                (reviewer trả "issues", loop < max)
plan_review → implementing                (reviewer trả "approved")
plan_review → failed                      (loop >= max_plan_review_loops)
implementing → code_review                (implementer hoàn thành + tests pass)
code_review → implementing                (reviewer trả REQUEST_CHANGES, loop < max)
code_review → pr_created                  (reviewer trả APPROVE)
code_review → failed                      (loop >= max_code_review_loops)
pr_created → pr_review                    (PR đã tạo, bắt đầu poll)
pr_review → implementing                  (có comment mới cần fix)
pr_review → completed                     (không có comment mới trong 30 phút)
pr_review → failed                        (fix loop >= max_pr_fix_loops)
ANY → paused                              (/stop-autodev)
ANY → failed                              (lỗi không recover được)
```

### Paused By Values (v2)

`paused_by` là **array** — có thể chứa nhiều lý do cùng lúc:

| Giá trị | Khi nào | Cách resume |
|---------|---------|-------------|
| `"command"` | User gọi `/stop-autodev` | `/resume-autodev` |
| `"checkpoint"` | Auto-pause tại checkpoint | `/resume-autodev` |
| `"timeout"` | Task/workflow vượt thời gian | `/resume-autodev` (auto-resolve) |
| `"budget"` | Token budget exceeded | `/resume-autodev --budget +50%` hoặc `--budget unlimited` |
| `"consensus_disagreement"` | Models bất đồng (v2.1) | `/resume-autodev --accept` / `--reject` / `--resolve "..."` |

**Backward compat:** `paused_by` là string → wrap thành array. `null` → `[]`.

### Timers (v2)

Mỗi workflow và task đều track thời gian:

```jsonc
"timers": {
  "workflow_start": "ISO",       // khi workflow bắt đầu
  "current_task_start": "ISO",   // khi task hiện tại bắt đầu
  "current_phase_start": "ISO"   // khi phase hiện tại bắt đầu
}
```

Timers được cập nhật tự động mỗi khi chuyển task hoặc chuyển phase.

---

## 4. Workflow Registry — Quản Lý Đa Workflow (v2)

### Registry File: `.workflow/registry.json`

```jsonc
{
  "version": 2,
  "max_concurrent_workflows": 5,
  "max_total_agents": 10,
  "active_workflows": [
    {
      "wf_id": "wf_20260320_153000",
      "status": "running",         // "running" | "paused" | "completed" | "failed"
      "request_summary": "Thêm rate limiting + caching",
      "created_at": "ISO",
      "updated_at": "ISO",
      "task_count": 3,
      "completed_tasks": 1,
      "active_agents": 2,
      "state_dir": ".workflow/wf_20260320_153000"
    }
  ],
  "global_stats": {
    "total_workflows_run": 0,
    "total_tasks_completed": 0,
    "total_agents_dispatched": 0
  }
}
```

### Registry Operations

**Đọc registry:**
1. Read `.workflow/registry.json`
2. Nếu không tồn tại → tạo mới với defaults
3. Parse JSON — nếu fail → log error, tạo mới

**Ghi registry:**
1. Backup: copy `registry.json` → `registry.backup.json`
2. Ghi nội dung mới (JSON 2-space indent)

**Kiểm tra giới hạn trước khi tạo workflow mới:**
```
running_workflows = active_workflows.filter(w => w.status === "running").length
total_agents = active_workflows.reduce((sum, w) => sum + w.active_agents, 0)

if (running_workflows >= max_concurrent_workflows) → DỪNG, thông báo user
if (total_agents + new_task_count > max_total_agents) → DỪNG, thông báo user
```

**Cập nhật sau mỗi state change:**
- Khi workflow status thay đổi → cập nhật `active_workflows[].status`
- Khi task hoàn thành → cập nhật `completed_tasks`, `global_stats`
- Khi agent dispatch/finish → cập nhật `active_agents`

---

## 5. Task Decomposition — Phân Tách Yêu Cầu

Khi nhận yêu cầu từ user:

1. **Parse requirement** — Tách yêu cầu thành các tasks độc lập
2. **Detect dependencies** — Phân tích xem tasks có phụ thuộc nhau không (VD: "thêm caching" phụ thuộc "thêm rate limiting")
3. **Khai báo `files_touched`** — Mỗi task liệt kê danh sách files dự kiến sẽ sửa
4. **Gán parallel groups** — So sánh `files_touched` giữa các tasks:
   - **Không overlap** → cùng parallel group (chạy song song)
   - **Có overlap** → khác group (chạy tuần tự)
5. **Tạo branch names** — Format: `workflow/<slug>` (VD: `workflow/rate-limiting`)
6. **Gán `depends_on`** — Nếu task B phụ thuộc task A, ghi `"depends_on": ["task_01"]`
7. **Đánh dấu `blocked`** — Tasks có depends_on chưa completed → status `blocked`

### Parallel Group Assignment Algorithm

```
Input: tasks[] với files_touched[]
Output: parallel_groups[]

1. Tạo group_id = 1
2. Cho mỗi task chưa gán group:
   a. Nếu task có depends_on → gán group riêng (sequential)
   b. Nếu task.files_touched overlap với bất kỳ task nào đã gán group hiện tại
      → tạo group mới (group_id++)
   c. Ngược lại → gán vào group hiện tại
3. Kết quả: tasks trong cùng group chạy parallel, groups chạy sequential
```

**Hiển thị decomposition cho user trước khi bắt đầu:**

```
┌──────────────────────────────────────────────────┐
│ Workflow wf_YYYYMMDD_HHMMSS                     │
│                                                   │
│ ═══ Parallel Group 1 ═══                         │
│ Task 1: rate-limiting                            │
│   "Thêm rate limiting cho search API"            │
│   Branch: workflow/rate-limiting                  │
│   Files: src/routes/search.ts, src/middleware/*   │
│                                                   │
│ Task 2: auth-refactor                            │
│   "Refactor auth middleware"                     │
│   Branch: workflow/auth-refactor                 │
│   Files: src/auth/*.ts                           │
│                                                   │
│ ═══ Parallel Group 2 (sau Group 1) ═══          │
│ Task 3: search-caching                           │
│   "Thêm Redis caching cho kết quả tìm"          │
│   Branch: workflow/search-caching                │
│   Files: src/routes/search.ts (overlap!)         │
│   Depends on: task_01                            │
│                                                   │
│ Group 1: 2 tasks chạy song song                 │
│ Group 2: 1 task chạy sau Group 1                 │
│ Bắt đầu...                                      │
└──────────────────────────────────────────────────┘
```

---

## 6. State File Schema — `.workflow/{wf_id}/state.json`

**Path:** `.workflow/{wf_id}/state.json` — mỗi workflow có thư mục riêng.

```jsonc
{
  "version": 2,
  "workflow_id": "wf_YYYYMMDD_HHMMSS",
  "created_at": "ISO",
  "updated_at": "ISO",
  "status": "running|paused|completed|failed",
  "paused_by": [],              // [] | ["command"] | ["checkpoint"] | ["timeout","budget"] | ["consensus_disagreement"]
                                // v2.1: array thay vi string. Backward compat: string → wrap array, null → []
  "original_request": "string",

  // === v2: Parallel Groups ===
  "parallel_groups": [
    {
      "group_id": 1,
      "task_ids": ["task_01", "task_02"],
      "status": "running|completed|failed"    // completed khi TẤT CẢ tasks trong group done
    }
  ],

  // === v2: Files Touched Map ===
  "task_files_touched": {
    "task_01": ["src/routes/search.ts", "src/middleware/rate-limit.ts"],
    "task_02": ["src/auth/session.ts"]
  },

  // === v2: Timers ===
  "timers": {
    "workflow_start": "ISO",
    "current_task_start": "ISO",
    "current_phase_start": "ISO"
  },

  // === v2: Reflect ===
  "reflect": {
    "total_tasks": 0,
    "completed_tasks": 0,
    "failed_tasks": 0,
    "total_phases_run": 0,
    "total_review_loops": 0,
    "total_duration_ms": 0,
    "parallel_groups_used": 0
  },

  "tasks": [
    {
      "task_id": "task_01",
      "slug": "string",
      "title": "string",
      "branch": "workflow/slug",
      "pr_number": null,        // null | number
      "status": "pending|spec_writing|spec_review|plan_writing|plan_review|implementing|code_review|pr_created|pr_review|completed|failed|cancelled|blocked",
      "phase_loop_count": 0,
      "depends_on": [],
      "parallel_group": 1,             // v2: group này thuộc về
      "files_touched": [],             // v2: files task sẽ sửa
      "agent_model": null,             // v2: model đang xử lý task
      "phase_timers": {},              // v2: { "spec_writing": { "start": "ISO", "end": "ISO", "duration_ms": N }, ... }
      "artifacts": {
        "spec": null,           // null | "path"
        "plan": null,           // null | "path"
        "pr_url": null          // null | "url"
      },
      "history": [
        {
          "phase": "string",
          "at": "ISO",
          "result": "string",
          "details": "string",
          "reviewer_model": null,     // OPTIONAL (v2.1) — model ID reviewer
          "writer_model": null,       // OPTIONAL (v2.1) — model ID writer
          "issues_count": 0,          // OPTIONAL (v2.1)
          "escalation": null          // OPTIONAL (v2.1) — { triggered, model, result, new_issues_count }
        }
      ],

      // === v2.1: Cross-Model Review ===
      "cross_model": {                // OPTIONAL — chi co khi cross-model enabled
        "writer_model": null,         // "claude-opus-4" | null
        "reviewer_model": null,       // "gpt-4o" | null
        "escalation_model": null,     // "gemini-2.5-pro" | null
        "pairing_mode": "auto",       // "auto" | "manual"
        "consensus_strategy": null,   // "reviewer_wins" | "writer_wins" | "escalate" | "vote" | null
        "escalation_count": 0,
        "fallback_used": false,
        "fallback_model": null
      },
      "consensus_results": [],        // OPTIONAL — chi co khi consensus used

      // === v2.1: Budget Capping ===
      "budget": {                     // OPTIONAL — chi co khi budget tracking active
        "tokens_used": 0,
        "tokens_limit": null,         // null = unlimited, number = limit
        "status": "OK",              // "OK" | "WARN" | "EXCEEDED"
        "dispatches": [
          // { "phase": "spec_writing", "role": "spec-writer", "model": "claude",
          //   "prompt_tokens": 2100, "completion_tokens": 1800, "total_tokens": 3900,
          //   "has_tool_calls": false, "at": "ISO" }
        ]
      },

      // === v2.1: Incremental Cache ===
      "cache": {                      // OPTIONAL — chi co khi cache active
        "spec_hash": null,            // hash da tinh cho spec lookup
        "spec_cache_hit": false,      // true neu spec lay tu cache
        "plan_hash": null,            // hash da tinh cho plan lookup
        "plan_cache_hit": false,      // true neu plan lay tu cache
        "time_saved_ms": 0            // thoi gian tiet kiem uoc tinh
      }
    }
  ],

  // === v2.1: Cross-Model Stats (workflow-level) ===
  "cross_model_stats": {             // OPTIONAL — chi co khi cross-model enabled
    "total_reviews": 0,
    "cross_model_reviews": 0,        // reviews dung model khac writer
    "same_model_reviews": 0,         // fallback ve cung model
    "issues_found_cross": 0,
    "issues_found_same": 0,
    "escalations_triggered": 0,
    "escalations_caught_issues": 0,  // so lan escalation phat hien issues MOI
    "consensus_overrides": 0
  },

  // === v2.1: Workflow-level Budget ===
  "budget": {                        // OPTIONAL — chi co khi budget tracking active
    "tokens_used": 0,
    "tokens_limit": null,            // null = unlimited
    "status": "OK",                  // "OK" | "WARN" | "EXCEEDED"
    "warn_at_pct": 80,
    "chars_per_token": 4
  },

  // === v2.1: Workflow-level Cache Stats ===
  "cache_stats": {                   // OPTIONAL — chi co khi cache active
    "spec_hits": 0,
    "spec_misses": 0,
    "plan_hits": 0,
    "plan_misses": 0,
    "total_time_saved_ms": 0,
    "cache_enabled": true
  },

  "checkpoints": [
    {
      "id": "cp_NNN",
      "at": "ISO",
      "task_id": "string",
      "phase": "string",
      "message": "string"
    }
  ]
}
```

### Backward Compatibility (v2.1)

Tat ca fields v2.1 (`cross_model`, `budget`, `cache`, `cross_model_stats`, `cache_stats`) deu **OPTIONAL**. State files v2 (khong co cac fields nay) van hoat dong binh thuong.

**Deserialization rules:**
- Khi doc state file thieu `cross_model` → coi nhu cross-model disabled
- Khi doc state file thieu `budget` → auto-init: `{ tokens_used: 0, tokens_limit: null, status: "OK", dispatches: [] }`
- Khi doc state file thieu `cache` → coi nhu cache chua co data
- Khi `paused_by` la string (VD: "timeout") → wrap thanh array `["timeout"]`
- Khi `paused_by` la null → chuyen thanh `[]`
- Khi ghi state file → LUON ghi `paused_by` dang array

---

## 7. State File Operations — Đọc/Ghi/Backup

### Tạo thư mục (per-workflow)
```bash
mkdir -p .workflow/{wf_id}
```

### Ghi state file
**LUÔN backup trước khi ghi:**
1. Đọc `.workflow/{wf_id}/state.json` hiện tại bằng Read tool
2. Ghi nội dung cũ vào `.workflow/{wf_id}/state.backup.json` bằng Write tool
3. Ghi state mới vào `.workflow/{wf_id}/state.json` bằng Write tool (JSON.stringify với 2-space indent)
4. **Cập nhật registry** sau mỗi lần ghi state (Section 4)

### Đọc state file
1. Dùng Read tool đọc `.workflow/{wf_id}/state.json`
2. Parse JSON — nếu parse fail → đọc `.workflow/{wf_id}/state.backup.json` làm fallback

### Lưu ý
- `.workflow/` PHẢI nằm trong `.gitignore` — đây là orchestration state, không phải project artifact
- Artifacts (spec, plan) được commit riêng trong `{docs_dir}/`

### Budget Update sau moi Dispatch (v2.1)

Sau MOI agent dispatch:
1. Do prompt_chars (noi dung prompt gui cho teammate)
2. Nhan response → do response_chars
3. Tinh: `dispatch_tokens = ceil(prompt_chars / chars_per_token) + ceil(response_chars / chars_per_token)`
4. Cap nhat state:
   - `task.budget.tokens_used += dispatch_tokens`
   - `workflow.budget.tokens_used += dispatch_tokens`
   - Append dispatch record vao `task.budget.dispatches[]`
5. Kiem tra budget status (Section 21)
6. Ghi state file (backup truoc)

### Dispatches Truncation

Neu `dispatches[]` > 100 entries → truncate oldest, giu 100 gan nhat.
- Luon giu `retry_boundary` markers (khong xoa boundaries)
- Log warning khi truncation xay ra

### Budget Defaults (khi reactions.yaml khong co section budget)

`tokens_limit = null` (unlimited), `warn_at_pct = 80`, `chars_per_token = 4`
Van TRACK `tokens_used` va `dispatches[]` ngay ca khi limit = null.

---

## 8. Teammate Prompt Templates

### 8.1 spec-writer

**Isolation:** `worktree` | **Mode:** `bypassPermissions`
**Tools:** Read, Write, Edit, Grep, Glob
```
You are a spec writer for {project.name}.

IMPORTANT: Follow the output language setting from project config. Code, commit prefix, branch name, file path always in English.

## Task
Write a technical design spec for: "{task.title}"

## Original user request
{original_request}

## Context
- Read existing specs in {specs_dir}/ to match the project's style
- Pattern: {specs_dir}/YYYY-MM-DD-<topic>-design.md
- Explore the codebase to understand related code (use Grep/Glob)
- If the project has a code intelligence tool (gitnexus, etc.), use it for impact analysis

## Reviewer feedback (if any)
{reviewer_feedback or "First draft — no feedback yet"}

## Output
- Write spec to: {specs_dir}/{date}-{slug}-design.md
- Commit with message: "docs: add {slug} design spec"
- Return the file path when done
```

### 8.2 spec-reviewer

**Isolation:** none (foreground) | **Mode:** `bypassPermissions`
**Tools:** Read, Grep, Glob

```
You are a spec reviewer for {project.name}.

IMPORTANT: Follow the output language setting from project config. Code, commit prefix, branch name, file path always in English.

## Task
Review technical design spec at: {task.artifacts.spec}

## Original user request
{original_request}

## Review criteria
1. Does the spec have all required sections? (Overview, Architecture, API, Error handling, Testing)
2. Are there any missing important edge cases?
3. Does it conflict with the current architecture? (explore codebase to verify)
4. Is it clear, specific, and implementable?

## Output
Return EXACTLY ONE of these formats:
- "approved" — if the spec meets requirements
- "issues: [list of issues]" — if changes needed, each issue clear and actionable
```

### 8.3 plan-writer

**Isolation:** `worktree` | **Mode:** `bypassPermissions`
**Tools:** Read, Write, Edit, Grep, Glob

```
You are a plan writer for {project.name}.

IMPORTANT: Follow the output language setting from project config. Code, commit prefix, branch name, file path always in English.

## Task
Create an implementation plan based on the approved spec: {task.artifacts.spec}

## Original user request
{original_request}

## Context
- Read the approved spec to understand the design
- Explore the codebase to find related code that needs modification
- Pattern: {plans_dir}/YYYY-MM-DD-<topic>.md

## Reviewer feedback (if any)
{reviewer_feedback or "First draft — no feedback yet"}

## Output
- Write plan to: {plans_dir}/{date}-{slug}.md
- Plan must include: files to modify, implementation order, test strategy, risk assessment
- Commit with message: "docs: add {slug} implementation plan"
- Return the file path when done
```

### 8.4 plan-reviewer

**Isolation:** none (foreground) | **Mode:** `bypassPermissions`
**Tools:** Read, Grep, Glob

```
You are a plan reviewer for {project.name}.

IMPORTANT: Follow the output language setting from project config. Code, commit prefix, branch name, file path always in English.

## Task
Review implementation plan at: {task.artifacts.plan}
Based on approved spec: {task.artifacts.spec}

## Review criteria
1. Does the plan cover all requirements from the spec?
2. Is the implementation order logical?
3. Are there missing important test cases?
4. Are all affected files identified?
5. Is the plan feasible and clear enough to implement?

## Output
Return EXACTLY ONE of these formats:
- "approved" — if the plan meets requirements
- "issues: [list of issues]" — if changes needed, each issue clear and actionable
```

### 8.5 implementer

**Isolation:** `worktree` | **Mode:** `bypassPermissions`
**Tools:** Read, Write, Edit, Bash, Grep, Glob

```
You are an implementer for {project.name}.

IMPORTANT: Follow the output language setting from project config. Code, commit prefix, branch name, file path always in English.

## Task
Implement according to the approved plan: {task.artifacts.plan}

## Original user request
{original_request}

## Context
- Read the plan to understand implementation order and files to modify
- Read the spec at {task.artifacts.spec} for detailed design
- Explore existing code before modifying (use Grep/Glob)

## TDD Process
1. Write tests first (or alongside code)
2. Implement code per plan
3. Run tests: `{project.test_command}` (default: `npm test`)
4. Fix until tests pass
5. Commit with appropriate message (feat:, fix:, refactor:...)

## Code reviewer feedback (if any)
{reviewer_feedback or "First implementation — no feedback yet"}

## Output
- Commit all changes
- Ensure tests pass
- Return summary of changes when done
```

### 8.6 code-reviewer

**Isolation:** none (foreground) | **Mode:** `bypassPermissions`
**Tools:** Read, Grep, Glob, Bash (only for `gh` commands)

```
You are a code reviewer for {project.name}.

IMPORTANT: Follow the output language setting from project config. Code, commit prefix, branch name, file path always in English.

## Task
Review code for PR #{task.pr_number} on branch {task.branch}

## Context
- Spec: {task.artifacts.spec}
- Plan: {task.artifacts.plan}
- Check that changes align with the spec and plan

## Review criteria
1. Does the code follow the plan?
2. Are tests complete and passing?
3. Any security issues?
4. Any performance concerns?
5. Is code style consistent with the codebase?

## Output
Post review via gh command:
- `gh pr review {pr_number} --approve --body "..."` — if code is OK
- `gh pr review {pr_number} --request-changes --body "..."` — if fixes needed, list each issue specifically
```

---

## 9. Dispatch Logic — Cách Gọi Teammates

### 9.0 Cross-Model Config Loading (v2.1)

Truoc khi dispatch bat ky reviewer nao, orchestrator doc cross-model config:

1. Doc `cross_model` section tu `.workflow/reactions.yaml` — neu khong ton tai → cross-model **TAT**, dung v2 behavior
2. Doc `.workflow/model-registry.json` — neu khong ton tai → cross-model **TAT**, log warning
3. Neu `enabled: false` → dung v2 behavior
4. Validate config:
   - Kiem tra model existence trong registry — tat ca model IDs trong `review_pairs` va `role_mapping` phai co trong `model-registry.json`
   - Kiem tra writer != reviewer khi enforce=true — moi phase, writer va reviewer phai khac nhau
   - Kiem tra escalation model co capability "escalate" trong registry
   - Kiem tra consensus.min_approvals <= so models available
5. Neu validation fail → log warning, fallback v2 behavior

**Single-model + enforce=true:** Khi chi co 1 model available trong registry:
- Log warning ro rang
- Fallback ve v2 behavior (same-model review)
- Task KHONG fail, KHONG pause — tiep tuc binh thuong

### 9.1 Resource Limit Check Trước Dispatch (v2)

Trước mỗi lần dispatch teammate:

```
1. Đọc registry → đếm total active_agents
2. Nếu total_agents >= max_total_agents → CHỜ (poll 30s) cho đến khi có slot
3. Nếu chờ > 5 phút → pause workflow, thông báo user
4. Dispatch teammate
5. Cập nhật registry: active_agents += 1
6. Khi teammate hoàn thành: active_agents -= 1
```

### 9.2 Worktree teammates (spec-writer, plan-writer, implementer)

Dispatch bằng SendMessage tool:
- `teammate`: tên teammate (VD: `spec-writer`)
- `isolation`: `"worktree"`
- `mode`: `"bypassPermissions"`
- `prompt`: template từ Section 8, thay thế placeholders bằng giá trị thực

### 9.3 Foreground teammates (spec-reviewer, plan-reviewer, code-reviewer)

Dispatch bằng SendMessage tool:
- `teammate`: tên teammate (VD: `spec-reviewer`)
- Không có isolation (chạy foreground)
- `mode`: `"bypassPermissions"`
- `prompt`: template từ Section 8, thay thế placeholders bằng giá trị thực

### 9.4 Placeholder Substitution

Trước khi dispatch, thay thế tất cả placeholders trong prompt template:
- `{task.title}` → title từ state file
- `{original_request}` → original_request từ state file
- `{task.artifacts.spec}` → đường dẫn spec file
- `{task.artifacts.plan}` → đường dẫn plan file
- `{task.branch}` → branch name
- `{task.pr_number}` → PR number
- `{reviewer_feedback}` → feedback từ reviewer (hoặc "Bản nháp đầu tiên")
- `{date}` → ngày hiện tại format YYYY-MM-DD
- `{slug}` → task slug
- `{reviewer_model}` → model ID cua reviewer (VD: "gpt-4o") (v2.1)
- `{writer_model}` → model ID cua writer (VD: "claude-opus-4") (v2.1)
- `{cross_model_enabled}` → "true" hoac "false" (v2.1)

### 9.5 Cross-Model Reviewer Selection (v2.1)

Khi cross-model enabled, thay the reviewer selection logic:

**Model Resolution Order:**
1. **Explicit config** — `cross_model.review_pairs.<phase>.reviewer` trong `reactions.yaml`
2. **Role mapping** — `cross_model.role_mapping.reviewer` trong `reactions.yaml`
3. **Auto-pair** — Chon model khac provider/family voi writer:
   - Filter: model khac writer, co capability "review"
   - Uu tien: khac provider > cung provider khac family > chi phi thap
4. **Fallback** — Dung writer model (same-model review), log warning

**Fallback chain khi reviewer unavailable:**
1. Thu reviewer model chinh → neu fail:
2. Thu escalation model lam reviewer → neu fail:
3. Dung writer model (same-model) → log `fallback_used=true`

**Cap nhat state khi dispatch:** Ghi `cross_model` object vao task (xem Section 6 schema).

### 9.6 Pluggable Agent — Formal Role Mapping (v2)

Đọc `agents.role_mapping` từ `.workflow/reactions.yaml`:

```yaml
agents:
  role_mapping:
    spec-writer: claude-opus-4
    spec-reviewer: gpt-4o
    plan-writer: claude-opus-4
    plan-reviewer: gpt-4o
    implementer: claude-opus-4
    code-reviewer: gpt-4o
    escalation: gemini-2.5-pro
```

**Smart model selection:**
- **Task size nhỏ** (1-2 files) → có thể dùng model nhẹ (haiku)
- **Task size lớn** (3+ files) → dùng model mạnh (opus, gpt-4o)
- **Retry sau failure** → upgrade model (haiku → sonnet → opus)
- **Reflect phase** → dùng model nhẹ (haiku) để tiết kiệm

Nếu không có `reactions.yaml` hoặc không có `role_mapping` → dùng model mặc định của Claude Code.

---

## 10. Review Loop Logic — Vòng Lặp Đánh Giá

Sau mỗi pha "write", dispatch reviewer tương ứng:

```
spec_writing hoàn thành → dispatch spec-reviewer
  ├── Kết quả "approved"
  │     → Cập nhật status → plan_writing
  │     → Lưu checkpoint
  │     → Reset phase_loop_count = 0
  │
  └── Kết quả "issues: [...]"
        → Tăng phase_loop_count += 1
        → Ghi phase_timers[phase].end + duration_ms
        → Kiểm tra: phase_loop_count >= max_loops?
        │   ├── CÓ → Escalate: pause workflow, thông báo user
        │   └── KHÔNG → Dispatch lại writer với reviewer feedback
        → Lưu checkpoint
```

**Áp dụng tương tự cho:** plan_writing/plan_review, implementing/code_review

### Timer Tracking trong Review Loop (v2)

Mỗi khi bắt đầu phase mới:
```jsonc
task.phase_timers[phase] = {
  "start": "ISO",   // NOW
  "end": null,
  "duration_ms": 0
}
```

Mỗi khi kết thúc phase:
```jsonc
task.phase_timers[phase].end = "ISO"  // NOW
task.phase_timers[phase].duration_ms = end - start  // tính ms
```

Cập nhật `timers.current_phase_start` mỗi khi bắt đầu phase mới.

### 10.1 Cross-Model Review Result Handling (v2.1)

Khi cross-model enabled, review loop mo rong them 2 nhanh:

```
Reviewer (Model B) tra ket qua
    |
    +-- APPROVE
    |     |
    |     +-- Reviewer la model nhe (cost_tier="low") VA task phuc tap (>=3 files)?
    |     |     |
    |     |     +-- CO + phase trong escalation.trigger.phases
    |     |     |     → Dispatch Automatic Escalation (Section 18)
    |     |     |
    |     |     +-- KHONG → advance phase (behavior v2)
    |     |
    |     +-- Reviewer khong phai model nhe → advance phase
    |
    +-- REQUEST_CHANGES → Writer (Model A) sua, loop lai (behavior v2)
    |     → phase_loop_count chi tang khi writer sua
    |
    +-- DISAGREE (writer khong dong y voi feedback)
          |
          +-- Phase nam trong escalation.trigger.phases?
          |     +-- CO → Dispatch Escalation (Section 18)
          |     +-- KHONG → Apply consensus.strategy truc tiep
          |
          +-- escalation.enabled = false?
                → Apply consensus.strategy truc tiep
```

**Review history tracking:** Moi review entry ghi them `reviewer_model`, `writer_model`, `issues_count`, `escalation` object.

### 10.2 Loop Count Rules (Cross-Model, v2.1)

`phase_loop_count` **chi dem so lan writer phai sua** — KHONG dem:
- Escalation dispatch
- Fallback model switching
- Consensus voting

**Vi du:** Writer sua 2 lan, xen giua co 1 escalation → `phase_loop_count = 2`

### 10.3 Budget Check trong Review Loop (v2.1)

Moi vong review = 2 dispatches (writer + reviewer). Budget check sau MOI dispatch:

1. Dispatch writer → track tokens → check budget
   → neu EXCEEDED → pause TRUOC khi dispatch reviewer
2. Dispatch reviewer → track tokens → check budget
   → neu EXCEEDED → pause TRUOC iteration tiep

### Giới hạn cứng

```jsonc
{
  "max_spec_review_loops": 3,
  "max_plan_review_loops": 3,
  "max_code_review_loops": 3,
  "max_pr_fix_loops": 5,
  "max_teammate_retries": 1,
  "max_gh_api_retries": 3,
  "pr_poll_interval_sec": 60,
  "pr_poll_no_activity_timeout_min": 30
}
```

---

## 11. Parallel Task Execution — Thực Thi Song Song (v2)

### 11.1 Execution Order

```
CHO MỖI parallel group (tuần tự theo group_id):
    │
    ├── Dispatch TẤT CẢ tasks trong group ĐỒNG THỜI
    │   ├── Task A → worktree riêng → branch riêng
    │   ├── Task B → worktree riêng → branch riêng
    │   └── Task C → worktree riêng → branch riêng
    │
    ├── CHỜ tất cả tasks hoàn thành (hoặc fail)
    │   ├── Nếu TẤT CẢ completed → group completed → tiếp group sau
    │   ├── Nếu có task failed → quyết định:
    │   │   ├── Task failed nhưng không block → tiếp tục tasks khác
    │   │   └── Task failed và block group → pause group
    │   └── Update registry active_agents sau mỗi task xong
    │
    └── Group completed → tiếp parallel group tiếp theo
```

### 11.2 Merge Strategy

Mỗi task trong parallel group:
1. Chạy trên **branch riêng**: `workflow/{slug}`
2. Tạo **PR riêng** cho mỗi task
3. Merge từng PR independently

### 11.3 Conflict Resolution

Khi merge task B (group 2) sau khi group 1 đã merge:
1. `git rebase main` trên branch task B
2. Nếu conflict:
   a. Auto-resolve nếu chỉ là trivial conflicts
   b. Nếu non-trivial → re-dispatch implementer với conflict context
   c. Nếu re-implement cũng fail → pause task, thông báo user

### 11.4 Resource Tracking

```
Trước khi dispatch parallel group:
  needed_agents = group.task_ids.length
  available_agents = max_total_agents - current_active_agents

  Nếu needed_agents > available_agents:
    → Dispatch available_agents tasks trước
    → Khi task xong → dispatch task tiếp (backfill)
    → Log: "Đang chạy {N}/{total} tasks (giới hạn agent)"
```

---

## 12. PR Lifecycle — Vòng Đời Pull Request

Orchestrator tự xử lý PR (không qua teammate):

### Bước 1: Push & Tạo PR
```bash
git push -u origin workflow/{slug}
gh pr create --title "{task.title}" --body "{progress_table}"
```
Lưu `pr_number` vào state file.

### Bước 2: Post Progress Comment (Layer 2)
Tạo comment tiến độ trên PR, lưu comment ID để edit sau:
```bash
gh pr comment {pr_number} --body "## Tiến Độ Workflow — {slug}
| Pha | Trạng Thái | Thời Gian | Loops |
|-----|-----------|-----------|-------|
| Spec | Approved | ... | ... |
| Plan | Approved | ... | ... |
| Implement | Done | ... | ... |
| Code Review (AI) | Đang chạy | — | 1 |

_Cập nhật lần cuối: {timestamp}_"
```

### Bước 3: AI Self-Review
Dispatch `code-reviewer` để review PR.

- Nếu `REQUEST_CHANGES` → dispatch `implementer` để fix → re-review (max 3 loops)
- Nếu `APPROVE` → chuyển sang polling

### Bước 4: Polling External Comments
Sau khi AI approve, bắt đầu poll comments mới:

```bash
gh pr view {pr_number} --json comments,reviews
```

**Poll mỗi 60 giây.** Xử lý:
- **Có comment mới** → dispatch `implementer` để fix → push → reply "Đã fix trong {sha}" → resolve conversation → tiếp tục poll
- **Không có comment mới trong 30 phút** → chuyển sang bước 5

### Bước 5: Hoàn Thành
- Post final summary (Layer 3) lên PR
- Gửi email thông báo (Layer 4)
- Cập nhật task status → `completed`
- Edit progress comment → thêm "HOÀN THÀNH"

---

## 13. Email Notification

**Skip entirely if `notifications.email` is null in config.** Email is optional — never block the workflow.

Send email at important events using `node -e` inline:

Read SMTP settings from `notifications` section in `.workflow/reactions.yaml`:
- `smtp_host` (default: smtp.gmail.com)
- `smtp_port` (default: 587)
- `smtp_secure` (default: false — set true for port 465)
- Credentials from env vars: `SMTP_USER`, `SMTP_PASS`

```bash
node --input-type=module -e "
import { createTransport } from 'nodemailer';
const transporter = createTransport({
  host: process.env.SMTP_HOST || '{notifications.smtp_host}',
  port: parseInt(process.env.SMTP_PORT || '{notifications.smtp_port}'),
  secure: {notifications.smtp_secure},
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});
try {
  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: '{notifications.email}',
    subject: '${SUBJECT}',
    text: '${BODY}'
  });
  console.log('Email sent');
} catch (e) {
  console.error('Email failed:', e.message);
}
"
```

### Các sự kiện trigger email

| Sự kiện | Subject | Body |
|---------|---------|------|
| Workflow bắt đầu | `[Workflow] Bắt đầu: {request_summary}` | Danh sách tasks, branches, phases dự kiến |
| Task escalated | `[Workflow] Cần xử lý: {task} bị chặn` | Chi tiết lỗi, options recovery |
| PR tạo xong | `[Workflow] PR #{N} sẵn sàng review: {task}` | PR URL, tóm tắt thay đổi, trạng thái AI review |
| Workflow hoàn thành | `[Workflow] Xong: {request_summary}` | Full summary (giống Layer 3 PR comment) |
| Workflow thất bại | `[Workflow] Thất bại: {task} tại {phase}` | Chi tiết lỗi, state snapshot |
| Budget warning (80%) | `[Autodev] Budget warning: {wf_id}/{slug} dat {pct}%` | Token usage, breakdown, recovery options (v2.1) |
| Budget exceeded | `[Autodev] Budget exceeded: {wf_id}/{slug} — paused` | Token usage, recovery options (v2.1) |
| Paused (budget+timeout) | `[Autodev] Paused (budget + timeout): {wf_id}/{slug}` | Ca 2 reasons chi tiet (v2.1) |

**Lưu ý:** Nếu SMTP không khả dụng, log warning và tiếp tục — email là nice-to-have, không block workflow.

---

## 14. Terminal Logging — Ghi Log Terminal

### Multi-workflow Separators (v2)

Khi có nhiều workflows chạy đồng thời, dùng separator để phân biệt:

```
── wf_20260320_153000/rate-limiting ──────────────────
[15:30:02] > task_01/rate-limiting: spec_writing bắt đầu
[15:30:45] v task_01/rate-limiting: spec đã viết xong
── wf_20260320_153000/auth-refactor ──────────────────
[15:30:05] > task_02/auth-refactor: spec_writing bắt đầu
[15:30:50] v task_02/auth-refactor: spec đã viết xong
```

### Format chuẩn cho mỗi dòng log

```
[HH:MM:SS] > task_id/slug: message          # Bắt đầu (start)
[HH:MM:SS] v task_id/slug: message          # Thành công (success)
[HH:MM:SS] x task_id/slug: message          # Thất bại (failure)
[HH:MM:SS] # checkpoint message             # Checkpoint
```

### Ví dụ

```
[15:30:02] > task_01/rate-limiting: spec_writing bắt đầu
[15:30:45] v task_01/rate-limiting: spec đã viết xong
[15:30:46] > task_01/rate-limiting: spec_review vòng 1
[15:31:20] x task_01/rate-limiting: spec_review phát hiện 2 vấn đề
[15:31:21] > task_01/rate-limiting: spec_writing (chỉnh sửa)
[15:32:05] v task_01/rate-limiting: spec đã chỉnh sửa
[15:32:06] > task_01/rate-limiting: spec_review vòng 2
[15:32:30] v task_01/rate-limiting: spec APPROVED
[15:32:31] # checkpoint cp_003 đã lưu
```

### Budget Logging (v2.1)

```
[HH:MM:SS] ! wf_id/slug BUDGET WARN: tokens_used/tokens_limit (pct%)
    → Model downgraded to haiku

[HH:MM:SS] x wf_id/slug BUDGET EXCEEDED: tokens_used/tokens_limit
    → Task paused. /autodev-retry --budget +50% | /resume-autodev --budget unlimited

[HH:MM:SS] x wf_id WORKFLOW BUDGET EXCEEDED: tokens_used/tokens_limit
    → Workflow paused. /resume-autodev --budget +50% | --budget unlimited
```

### Cache Logging (v2.1)

```
[HH:MM:SS] * task_id/slug: spec cache HIT (hash: prefix, saved ~Nm)
[HH:MM:SS] * task_id/slug: plan cache MISS — dispatching plan-writer
[HH:MM:SS] + task_id/slug: cached spec (hash: prefix, ttl: Nd)
[HH:MM:SS] ~ cache invalidation: N entries invalidated (reason: git_change)
```

**Ghi log bằng cách output trực tiếp trong conversation** — user thấy real-time.

---

## 15. Checkpoint Logic — Logic Điểm Lưu

### Auto-checkpoint tại các sự kiện

| Sự kiện | Dữ liệu lưu |
|---------|-------------|
| Chuyển pha (spec → plan, plan → impl...) | Task ID, phase mới, artifact paths |
| Mỗi vòng review loop | Loop count, tóm tắt feedback |
| Task hoàn thành | PR URL cuối cùng, summary |
| `/stop-autodev` | Toàn bộ state + `paused_by: "command"` |

### Format checkpoint

```jsonc
{
  "id": "cp_NNN",      // tăng dần: cp_001, cp_002, cp_003...
  "at": "ISO timestamp",
  "task_id": "task_01",
  "phase": "spec_review",
  "message": "Spec đã viết, bắt đầu review vòng 1"
}
```

### Tạo checkpoint

1. Đọc state file hiện tại
2. Tính `cp_NNN` tiếp theo (lấy max id + 1)
3. Append checkpoint vào mảng `checkpoints`
4. Cập nhật `updated_at`
5. Ghi state file (theo quy trình Section 7: backup trước, rồi ghi)
6. Log: `[HH:MM:SS] # checkpoint cp_NNN đã lưu`

---

## 16. Error Handling — Xử Lý Lỗi

### Ma Trận Xử Lý Lỗi

| Loại lỗi | Ví dụ | Tự recovery | Fallback |
|-----------|-------|-------------|----------|
| Teammate crash | Implementer fail giữa chừng | Retry 1 lần cùng prompt | Đánh dấu task `failed`, thông báo user |
| Review deadlock | Reviewer liên tục tìm issues > max loops | — | Pause + escalate với tóm tắt issues chưa resolve |
| Git conflict | Rebase fail trên task branch | Tự `git rebase main` | Pause, hiển thị conflict files |
| Test failure | Tests fail after implement | Dispatch implementer with error output | Retry once with debug context. Then escalate |
| GitHub API failure | `gh pr create` fail | Retry 3 lần exponential backoff (5s, 15s, 45s) | Pause, log error |
| State file corruption | JSON không hợp lệ | — | Fallback sang `state.backup.json` |
| Budget exceeded (v2.1) | tokens_used >= limit | Pause task/workflow | User retry `--budget +50%`, `--budget unlimited`, hoac cancel |
| Cache index corrupt (v2.1) | index.json parse fail | Xoa index.json, tao moi rong | Pipeline tiep tuc binh thuong |
| Cache artifact mat (v2.1) | File khong ton tai khi lookup | Danh dau invalidated=true | MISS, pipeline tiep tuc |
| Cache write fail (v2.1) | Disk full, permission denied | Log warning, bo qua | Pipeline tiep tuc binh thuong |

### Budget Exceeded Recovery (v2.1)

| Option | Command | Hanh vi |
|--------|---------|---------|
| Retry +50% | `--budget +50%` | limit *= 1.5, status → OK, tokens_used giu nguyen |
| Resume unlimited | `--budget unlimited` | limit = null, status → OK |
| Cancel | `/autodev-cancel` | Danh dau cancelled |

Dispatch history (`dispatches[]`) KHONG reset khi retry — chen `retry_boundary` marker.

### Recovery voi nhieu Pause Reasons (v2.1)

| Tinh huong | Command | Ket qua |
|-----------|---------|---------|
| `paused_by: ["budget"]` | `/resume-autodev --budget +50%` | Resolve budget → `paused_by: []` → resumed |
| `paused_by: ["timeout","budget"]` | `/resume-autodev --budget +50%` | Resolve budget only → `paused_by: ["timeout"]` → van paused |
| `paused_by: ["timeout","budget"]` | `/resume-autodev` (khong flag) | Resolve TAT CA → `paused_by: []` → resumed |

### Cache Error Policy (v2.1)

**NGUYEN TAC: Cache failure KHONG BAO GIO fail workflow.**
Moi cache operation (lookup, create, invalidate, evict) deu wrap trong try/catch.
Neu cache loi → log warning → tiep tuc pipeline binh thuong (nhu khong co cache).

### Quy trình Escalation

```
Phát hiện lỗi
    │
    ▼
Có thể tự recover? ──có──▶ retry ──thành công──▶ tiếp tục
    │                                  │
    không                            thất bại
    │                                  │
    ▼                                  ▼
Lưu checkpoint với error context
Đặt task status: "failed"
Output terminal: chi tiết lỗi + options recovery
    /autodev-retry task_01   — retry từ phase tốt cuối
    /resume-autodev          — bỏ qua, chạy task tiếp
    /autodev-cancel task_01  — huỷ task
```

### GitHub API Retry

```
Lần 1: chờ 5 giây → retry
Lần 2: chờ 15 giây → retry
Lần 3: chờ 45 giây → retry
Vẫn fail → pause workflow, log lỗi
```

---

## 17. Conflict Detection — Phát Hiện Xung Đột (v2 Multi-Workflow)

### Kiểm tra khi bắt đầu workflow mới

Trước khi tạo workflow mới, LUÔN kiểm tra:

1. Đọc `.workflow/registry.json` (nếu tồn tại)
2. Đếm running workflows:
   - Nếu `running_count >= max_concurrent_workflows`:
     ```
     ⚠ Đã đạt giới hạn {max_concurrent_workflows} workflows đồng thời.
     Running: {list of wf_ids}

     Sử dụng /stop-autodev {wf_id} hoặc /autodev-cancel {wf_id} trước.
     ```
     → **DỪNG, không tạo workflow mới**
3. Đếm total agents:
   - Nếu `total_agents + new_task_count > max_total_agents`:
     ```
     ⚠ Đã đạt giới hạn {max_total_agents} agents đồng thời.
     Active agents: {count}. Cần thêm: {new_task_count}.

     Chờ tasks hiện tại hoàn thành hoặc tăng max_total_agents trong registry.
     ```
     → **DỪNG**
4. Nếu trong giới hạn → OK, tạo workflow mới

### Kiểm tra branch tồn tại

Trước khi tạo branch cho task:
```bash
git branch --list "workflow/{slug}"
```
Nếu branch đã tồn tại → hỏi user: ghi đè, đổi tên, hoặc huỷ.

### v1 Legacy Check

Nếu thấy `.workflow/state.json` (v1 singleton) mà KHÔNG có `.workflow/registry.json`:
→ Chạy v1 Migration (Section 25) trước khi tiếp tục.

---

## 18. Escalation Engine — Xu Ly Leo Thang (v2.1 Cross-Model)

### 18.1 Khi Nao Escalation Duoc Kich Hoat

**A. Automatic Escalation (reviewer nhe approve task phuc tap):**
- Reviewer co `cost_tier = "low"` (VD: claude-haiku-3.5)
- Task thay doi >= `complexity_threshold` files (mac dinh: 3)
- Phase nam trong `escalation.trigger.phases` (mac dinh: `["code_review"]`)
- → Dispatch escalation model re-review

**B. Disagreement Escalation (writer khong dong y reviewer):**
- Writer tra `DISAGREE` voi feedback cua reviewer
- Phase nam trong `escalation.trigger.phases`
- → Dispatch escalation model lam trong tai

### 18.2 Timeout Check Truoc Khi Escalation

**LUON kiem tra timeout truoc khi dispatch escalation:**

```
remaining_time = phase_timeout - elapsed_time
min_escalation_time = escalation_model.avg_response_time_sec * 1.5
```

Quy tac:
- Neu `remaining_time < 30s` (hard minimum) → **SKIP escalation**
- Neu `remaining_time < min_escalation_time` → **SKIP escalation**
- Khi skip: ap dung `consensus.strategy` truc tiep, log reason

Phase timeouts: `spec_review` 5m, `plan_review` 5m, `code_review` 10m, `escalation` 8m.

### 18.3 Dispatch Escalation

1. Doc escalation model tu config (hoac auto-select model co capability "escalate")
2. Model escalation phai KHAC ca writer VA reviewer
3. Dispatch escalation reviewer voi context: artifact goc + feedback reviewer + response writer (neu DISAGREE)

### 18.4 Xu Ly Ket Qua Escalation

- "approved" (dong y writer) → advance phase, KHONG tang loop_count
- "sides_with_reviewer" → writer phai sua, loop_count++
- "new_issues_found" → writer phai sua TAT CA, loop_count++

### 18.5 Fallback Khi Escalation Model Unavailable

1. Thu escalation model chinh → neu fail:
2. Chon model khac co capability "escalate" tu registry (khac writer VA reviewer)
3. Neu khong co model nao → apply `consensus.strategy` truc tiep, log warning

### 18.6 Cap Nhat State Sau Escalation

Them `escalation` object vao history entry. Cap nhat `cross_model.escalation_count += 1`.

---

## 19. Consensus Handler — Xu Ly Dong Thuan Da Model (v2.1)

### 19.1 Khi Nao Consensus Duoc Kich Hoat

Consensus CHI active khi `cross_model.consensus.enabled = true` trong `reactions.yaml`.
Khi khong ton tai hoac `enabled: false` → single-reviewer mode (behavior v2).

### 19.2 Consensus Check Flow

```
Da co du min_approvals models approve?
    |
    +-- CO → APPROVE, advance phase
    |
    +-- KHONG (co bat dong)
          |
          +-- on_disagreement = "reject"?
          |     → REJECT, writer phai sua tat ca issues
          |
          +-- on_disagreement = "majority"?
          |     → Dem phieu: approve vs reject. Majority thang (>50%). Hoa → "reject"
          |
          +-- on_disagreement = "escalate"?
                → Task status = "paused", paused_by = ["consensus_disagreement"]
                → Notify user, cho /resume-autodev
```

### 19.3 Consensus Pause — Thong Bao User

Hien thi: models bat dong, vote cua tung model, huong dan resume voi `--accept`, `--reject`, `--resolve "..."`.

### 19.4 Luu Consensus Results Vao State

Append vao `task.consensus_results[]` voi: phase, at, strategy, participants, outcome, policy_applied.

---

## 20. Cross-Model Stats & Reflect (v2.1)

### 20.1 Quy Tac Cap Nhat Stats

- `total_reviews++` (luon tang sau moi review dispatch)
- `cross_model_reviews++` neu reviewer != writer model, nguoc lai `same_model_reviews++`
- `issues_found_cross` / `issues_found_same` += issues_count tuong ung
- `escalations_triggered++` LUON khi dispatch escalation
- `escalations_caught_issues++` CHI khi phat hien issues MOI
- `consensus_overrides++` khi escalation override reviewer

### 20.2 Reflect Summary

Output cuoi workflow: total reviews, cross/same breakdown, issues found, escalation effectiveness, consensus overrides.

---

## 21. Budget Engine — Bao Ve Tai Nguyen (v2.1)

### 21.1 Token Estimation

`dispatch_tokens = ceil(prompt_chars / cpt) + ceil(response_chars / cpt)` (default cpt=4)

### 21.2 Budget Enforcement — 4 Muc

| Muc | Dieu kien | Hanh dong |
|-----|-----------|-----------|
| OK | tokens_used < warn_threshold | Khong lam gi |
| WARN | tokens_used >= warn_threshold AND < limit | Log canh bao, tiep tuc |
| EXCEEDED_TASK | task.tokens_used >= task_budget_tokens | Pause task, workflow tiep tuc |
| EXCEEDED_WORKFLOW | workflow.tokens_used >= workflow_budget_tokens | Pause toan bo workflow |

`warn_threshold = limit * warn_at_pct / 100` (default 80%). Kiem tra: workflow budget truoc → task budget sau.

### 21.3 Cross-Model + Budget

- Escalation dispatch tinh vao budget binh thuong
- Budget EXCEEDED → skip escalation, accept ket qua reviewer ban dau
- Budget EXCEEDED giua consensus → cancel remaining, majority vote tren ket qua da co

### 21.4 Budget-Aware Model Selection

- Budget >= 60% task limit → PREFER haiku (downgrade)
- Budget >= 80% task limit → FORCE haiku (bat buoc)
- Exception: retry sau failure VA budget < 80% → van cho upgrade

---

## 22. Timeout Engine — Quản Lý Thời Gian (v2)

### 22.1 Layer 1: Loop Count

Giới hạn cứng cho mỗi phase (đã định nghĩa ở Section 10):
- spec_review: 3 loops
- plan_review: 3 loops
- code_review: 3 loops
- pr_review: 5 fix loops

Vượt → FATAL: task failed.

### 22.2 Layer 2: Per-Phase Timeout

| Phase | Timeout | Mục đích |
|-------|---------|----------|
| spec_writing | 10m | Viết spec |
| spec_review | 5m | Review spec |
| plan_writing | 10m | Viết plan |
| plan_review | 5m | Review plan |
| implementing | 30m | Code implementation |
| code_review | 10m | Review code |
| escalation | 8m | Escalation review |

Vượt → ESCALATE: cảnh báo, thử kết thúc phase.

### 22.3 Layer 3: Per-Task / Per-Workflow Timeout

| Cấp | Timeout mặc định | Có thể override |
|-----|-------------------|-----------------|
| Per-Task | 60 phút | `reactions.yaml: timeouts.task_timeout_min` |
| Per-Workflow | 180 phút | `reactions.yaml: timeouts.workflow_timeout_min` |

Kiểm tra mỗi khi chuyển phase hoặc kết thúc dispatch:
```
elapsed = NOW - timers.current_task_start
if (elapsed > task_timeout) → pause task, paused_by += ["timeout"]

elapsed_wf = NOW - timers.workflow_start
if (elapsed_wf > workflow_timeout) → pause workflow, paused_by += ["timeout"]
```

### 22.4 Layer 4: Budget

Xem Section 21.

### 22.5 Escalation Flow

```
Timeout detected
    │
    ├── 80% threshold → WARN
    │   └── Log cảnh báo: "[HH:MM:SS] ! timeout warning: {phase} đã chạy {elapsed}/{timeout}"
    │   └── Email cảnh báo nếu SMTP available
    │
    ├── 100% threshold → ESCALATE
    │   └── Kết thúc phase hiện tại (accept partial result nếu có)
    │   └── Thử advance sang phase tiếp
    │   └── Nếu không thể → pause task
    │
    └── Task/Workflow timeout → FATAL
        └── Pause task/workflow
        └── paused_by += ["timeout"]
        └── Email thông báo
        └── Log: "[HH:MM:SS] x TIMEOUT FATAL: {level} vượt {timeout}"
```

---

## 23. Reactions Engine — Xử Lý Sự Kiện (v2)

### 23.1 Config: `.workflow/reactions.yaml`

```yaml
reactions:
  ci-failed:
    action: auto-fix
    max_retries: 2
    escalate_after: 2

  changes-requested:
    action: auto-implement
    max_retries: 3
    escalate_after: 3

  approved-and-green:
    action: auto-merge
    require_human_approval: false

  test-failed:
    action: auto-fix-tests
    max_retries: 2
    escalate_after: 2

agents:
  role_mapping:
    spec-writer: claude-opus-4
    spec-reviewer: gpt-4o
    implementer: claude-opus-4
    code-reviewer: gpt-4o
```

### 23.2 Event Processing

**ci-failed:**
1. Đọc CI logs (`gh run view --log-failed`)
2. Dispatch implementer với error context
3. Push fix, trigger CI lại
4. Nếu fail lần 2 → escalate: pause, thông báo user

**changes-requested:**
1. Đọc review comments từ PR
2. Dispatch implementer để fix từng comment
3. Push changes, reply trên mỗi comment
4. Request re-review

**approved-and-green:**
1. Kiểm tra: tất cả CI checks passed + approved
2. Nếu `require_human_approval: false` → auto-merge
3. Nếu `require_human_approval: true` → thông báo user, chờ

**test-failed:**
1. Đọc test output
2. Dispatch implementer với failing test context
3. Push fix
4. Nếu fail lần 2 → escalate

### 23.3 Event Detection

Orchestrator poll sự kiện khi workflow đang chạy:
```bash
# Check CI status
gh pr checks {pr_number}

# Check reviews
gh pr view {pr_number} --json reviews,reviewRequests

# Check test results (from CI)
gh run list --branch {branch} --limit 1 --json status,conclusion
```

---

## 24. Dashboard Integration (v2)

### 24.1 Khởi động (tuỳ chọn)

```bash
npx serve .workflow --cors -l 3456
```

Dashboard là **tuỳ chọn** — workflow KHÔNG phụ thuộc dashboard. Dashboard chỉ đọc dữ liệu.

### 24.2 Data Sources

Dashboard reads:
- `.workflow/registry.json` → danh sách workflows, stats tổng
- `.workflow/{wf_id}/state.json` → chi tiết từng workflow

Qua HTTP fetch:
```
GET http://localhost:3456/registry.json
GET http://localhost:3456/{wf_id}/state.json
```

### 24.3 Thông Tin Hiển Thị

- Danh sách workflows (active, paused, completed, failed)
- Mỗi workflow: tasks, phases, loop counts, timers
- Parallel groups visualization
- Budget usage (nếu có)
- Cache stats (nếu có)
- Real-time updates (poll mỗi 5s)

---

## 25. v1 Migration — Chuyển Đổi Từ v1 (v2)

### 25.1 Phát Hiện v1

Detect v1 khi:
- Tồn tại `.workflow/state.json` (root level, singleton)
- KHÔNG tồn tại `.workflow/registry.json`

### 25.2 Quy Trình Migration

```
1. Đọc .workflow/state.json (v1)
2. Tạo wf_id từ workflow_id hoặc generate mới: wf_YYYYMMDD_HHMMSS
3. mkdir -p .workflow/{wf_id}
4. Copy state.json vào .workflow/{wf_id}/state.json
5. Thêm v2 fields vào state:
   - version: 2
   - parallel_groups: [] (legacy = tất cả sequential)
   - task_files_touched: {}
   - timers: { workflow_start: created_at, ... }
   - reflect: { total_tasks: tasks.length, ... }
   - Mỗi task: parallel_group: 0, files_touched: [], phase_timers: {}
6. Tạo .workflow/registry.json với workflow này
7. Backup .workflow/state.json → .workflow/state.v1.backup.json
8. Xoá .workflow/state.json (root level)
9. Log: "✓ Migrated v1 workflow {wf_id} sang v2 format"
```

### 25.3 Rollback

Nếu migration fail:
1. Giữ nguyên `.workflow/state.json` gốc
2. Xoá thư mục `.workflow/{wf_id}` nếu đã tạo
3. Log error, thông báo user

---

## 26. Incremental Cache (v2.1)

### 26.1 Config Resolution

Doc tu `.workflow/reactions.yaml` section `cache`. Defaults: enabled=true, ttl_days=7, max_entries=100, auto_invalidate_on_git=true, eviction_pct=20, relevant_paths_strategy="auto".

### 26.2 Storage & Hashing

Storage: `.workflow/cache/` (index.json + spec/ + plan/). Hash: SHA-256.

**Spec hash:** normalize(request) + task_slug + git_tree_hash(relevant_paths) + reviewer_feedback_hash + "spec"
**Plan hash:** spec_content_hash + task_slug + git_tree_hash(relevant_paths) + reviewer_feedback_hash + "plan"

Normalization: lowercase, trim, collapse spaces, remove trailing punctuation. KHONG sort words.
Git tree hash: `git ls-tree -r HEAD -- <paths>` | sha256. Committed state only.

### 26.3 Lookup & Create

**Lookup:** check enabled → tinh hash → doc index → tim entry → check TTL → check file → HIT/MISS
**Create:** tinh hash → copy artifact → them entry → LRU eviction

Cache failure KHONG BAO GIO fail workflow — fallback ve v2 behavior.

### 26.4 Invalidation

- Git-based: so sanh git_tree_hash truoc moi lookup va khi workflow bat dau
- TTL: entry.ttl_expires_at < now → invalidated
- Manual: `/autodev cache clear`

### 26.5 LRU Eviction

Khi entries > max_entries: xoa invalidated/expired truoc, roi LRU by last_hit_at.

### 26.6 Cache Commands

`/autodev cache clear` | `clear --task {slug}` | `status` | `disable` | `enable`

### 26.7 Tich Hop vao Main Flow

PHA SPEC va PHA PLAN: Cache lookup truoc → HIT skip phases → MISS pipeline binh thuong → SAU approved: Cache CREATE.

---

## 27. Main Execution Flow — Quy Trình Chạy Chính (v2)

Khi user gọi `/autodev "yêu cầu"`:

```
1. V1 MIGRATION CHECK (Section 25)
   └── Detect .workflow/state.json (v1) → migrate nếu cần

2. ĐỌC REGISTRY (Section 4)
   └── Tạo mới nếu chưa có
   └── Kiểm tra giới hạn concurrent workflows + agents

3. ĐỌC CONFIG (Section 9.6)
   └── Load reactions.yaml → role_mapping, timeouts, budget, cache
   └── Load model-registry.json nếu cross-model enabled

4. PHÂN TÁCH TASKS (Section 5)
   └── Parse requirement → tasks
   └── Khai báo files_touched cho mỗi task
   └── Gán parallel groups
   └── Hiển thị decomposition → chờ user xác nhận

5. TẠO STATE FILE (Section 6, 7)
   └── mkdir -p .workflow/{wf_id}
   └── Ghi state.json với tasks ở status "pending"
   └── Cập nhật registry

6. KHỞI ĐỘNG DASHBOARD (tuỳ chọn, Section 24)
   └── Nếu user muốn → npx serve .workflow --cors

7. GỬI EMAIL "Workflow bắt đầu" (Section 13)

8. CACHE INVALIDATION (Section 26.4)
   └── Kiểm tra git changes → invalidate stale entries

9. CHO MỖI PARALLEL GROUP (tuần tự):
   │
   ├── 9a. Dispatch tasks trong group ĐỒNG THỜI (Section 11):
   │   │
   │   └── CHO MỖI TASK (parallel trong group):
   │       │
   │       ├── Tạo branch: git checkout -b workflow/{slug}
   │       ├── LOG: [HH:MM:SS] > task_id/slug: bắt đầu
   │       ├── Cập nhật timers
   │       │
   │       ├── PHA SPEC (Section 8.1, 8.2, 10):
   │       │   ├── Cache lookup → HIT? skip : dispatch
   │       │   ├── Dispatch spec-writer
   │       │   ├── Dispatch spec-reviewer (cross-model nếu enabled)
   │       │   ├── Loop nếu cần (max 3)
   │       │   ├── Budget check mỗi dispatch
   │       │   ├── Timeout check mỗi phase
   │       │   ├── Cache CREATE nếu approved
   │       │   └── Checkpoint khi approved
   │       │
   │       ├── PHA PLAN (Section 8.3, 8.4, 10):
   │       │   ├── Cache lookup → HIT? skip : dispatch
   │       │   ├── Dispatch plan-writer
   │       │   ├── Dispatch plan-reviewer
   │       │   ├── Loop nếu cần (max 3)
   │       │   ├── Budget check, timeout check
   │       │   ├── Cache CREATE nếu approved
   │       │   └── Checkpoint khi approved
   │       │
   │       ├── PHA IMPLEMENT (Section 8.5, 8.6, 10):
   │       │   ├── Dispatch implementer
   │       │   ├── Dispatch code-reviewer
   │       │   ├── Loop nếu cần (max 3)
   │       │   ├── Budget check, timeout check
   │       │   └── Checkpoint khi approved
   │       │
   │       ├── PHA PR (Section 12):
   │       │   ├── Push + tạo PR
   │       │   ├── Post progress comment
   │       │   ├── AI self-review
   │       │   ├── Poll external comments
   │       │   └── Final summary khi xong
   │       │
   │       └── LOG: [HH:MM:SS] v task_id/slug: HOÀN THÀNH
   │
   ├── 9b. CHỜ tất cả tasks trong group → group completed
   └── 9c. Cập nhật registry + state

10. REFLECT PHASE (Section 28)
    └── Tổng kết: tasks, phases, timers, budget, cache, cross-model

11. GỬI EMAIL "Workflow hoàn thành" (Section 13)

12. HOÀN THÀNH
    └── Cập nhật workflow status → "completed"
    └── Cập nhật registry
```

**Tại BẤT KỲ bước nào:** nếu gặp lỗi → xử lý theo Section 16. Nếu user gọi `/stop-autodev` → lưu checkpoint, pause.

---

## 28. Reflect Phase — Tong Ket Cuoi Workflow (v2 + v2.1)

### 28.1 General Summary

```
═══════════════════════════════════════
  WORKFLOW SUMMARY: {wf_id}
═══════════════════════════════════════
  Request: {original_request}
  Duration: {total_duration}
  Tasks: {completed}/{total} completed
  Parallel groups: {groups_used}
  Review loops: {total_loops}
═══════════════════════════════════════
```

### 28.2 Budget Summary (v2.1)

Token usage per task/phase/model. Cost estimate (neu co pricing config).

### 28.3 Cache Performance (v2.1)

Spec/plan hit rates, thoi gian tiet kiem, entries hien tai.

### 28.4 Cross-Model Summary (v2.1)

Xem Section 20.2.

### 28.5 Per-Task Breakdown

Cho mỗi task: phases run, loop counts, duration, model used, budget consumed.

Cập nhật `reflect` object trong state file với dữ liệu tổng kết.