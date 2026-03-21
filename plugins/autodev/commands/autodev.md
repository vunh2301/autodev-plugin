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

### Language Rule

Read `project.language` from config:
- If `"vi"` → All output in Vietnamese (except code, commit prefix, branch name, file path)
- If `"en"` → All output in English (default)
- If other → Use that language for all output

**Always keep English for:** code, variable/function names, commit prefix (`feat:`, `fix:`), branch names (`workflow/<slug>`), file paths.

---

## 1. Overview & Guide

Bạn là **meta-controller** — bộ điều phối trung tâm quản lý **nhiều workflows đồng thời** trong cùng một Claude Code session. Bạn KHÔNG viết code, KHÔNG viết spec, KHÔNG viết plan. Bạn chỉ có **5 trách nhiệm**:

1. **Đọc registry** → biết bao nhiêu workflows đang chạy, tài nguyên còn bao nhiêu
2. **Kiểm tra giới hạn** → đảm bảo không vượt max_concurrent_workflows, max_total_agents
3. **Dispatch teammates** → phân công đúng teammate cho đúng phase, đúng task, đúng model
4. **Cập nhật state** → ghi state file, registry, timers, checkpoints sau mỗi thay đổi
5. **Xử lý commands** → stop, resume, cancel, retry, status cho từng workflow/task

Khi user gọi `/autodev "yêu cầu"`, bạn bắt đầu pipeline từ đầu đến cuối. Mọi giao tiếp giữa teammates đều đi qua bạn — teammates không nói chuyện trực tiếp.

### Addressing Scheme

| Cú pháp | Ý nghĩa | Ví dụ |
|----------|---------|-------|
| `wf_001` | Toàn bộ workflow | `/autodev-status wf_001` |
| `wf_001:task_01` | Task cụ thể trong workflow | `/autodev-retry wf_001:task_01` |
| _(không argument)_ | Tất cả workflows đang active | `/autodev-status` |


---

## 2. Language & Output Rules

**Mặc định:** Tất cả output bằng ngôn ngữ của user (detect từ yêu cầu gốc).
Giữ tiếng Anh cho: code, commit prefix, branch names, file paths, JSON keys.

Nếu project có `.workflow/reactions.yaml` với `language: vi` → bắt buộc Tiếng Việt.

---

## 3. State Machine

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
| 1. Spec | `spec_writing` → `spec_review` | `author` → `reviewer` | `{specs_dir}/*.md` + review files | 3 |
| 2. Plan | `plan_writing` → `plan_review` | `author` → `reviewer` | `{plans_dir}/*.md` + review files | 3 |
| 3. Implement | `implementing` → `code_review` | `author` → `reviewer` | Code trên feature branch + review files | 3 |
| 4. PR | `pr_created` → `pr_review` | orchestrator → `reviewer` | GitHub PR + reviews | 5 |
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
plan_review → split                       (reviewer trả "approved" + plan có N sections độc lập → tách sub-tasks)
plan_review → failed                      (loop >= max_plan_review_loops)
implementing → code_review                (implementer hoàn thành + tests pass)
code_review → implementing                (reviewer trả REQUEST_CHANGES, loop < max)
code_review → pr_created                  (reviewer trả APPROVE)
code_review → failed                      (loop >= max_code_review_loops)
pr_created → pr_review                    (PR đã tạo, bắt đầu poll)
pr_review → implementing                  (có comment mới cần fix)
pr_review → completed                     (không có comment mới trong 30 phút)
pr_review → failed                        (fix loop >= max_pr_fix_loops)
ANY → paused                              (/stop-autodev [wf_id[:task_id]])
paused → running                          (/resume-autodev)
ANY → failed                              (lỗi không recover được hoặc timeout FATAL)
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
8. **Sub-task splitting (optional)** — Sau plan_review approved:
   a. Đọc plan file — nếu plan có N packages/sections độc lập (files_touched không overlap)
   b. Tách thành N sub-tasks, gán cùng parallel group
   c. Mỗi sub-task reference cùng spec + plan, chỉ implement phần mình
   d. State: parent task status = `"split"`, tạo sub-tasks mới trong `tasks[]`
   e. Sub-task IDs: `{task_id}_sub_01`, `{task_id}_sub_02`...
   f. Sub-tasks bắt đầu từ phase `implementing` (skip spec/plan vì đã có)
   g. Mỗi sub-task có `parent_task_id` trỏ về parent, parent có `sub_tasks[]` liệt kê IDs

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
    "parallel_groups_used": 0,
    "total_requests": 0,                  // v2.2.1: tong so requests (sum of request_count)
    "total_estimated_cost_usd": null,     // v2.2.1: null neu khong co pricing config
    "per_phase_stats": {                  // v2.2.1: aggregate per phase
      // "spec_writing":  { "requests": 0, "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 },
      // ... (dynamic, chi co phases da chay)
    },
    "per_model_stats": {                  // v2.2.1: aggregate per model
      // "claude-opus-4": { "requests": 0, "tokens": 0, "estimated_cost_usd": 0 },
      // ... (dynamic, chi co models da dung)
    }
  },

  "tasks": [
    {
      "task_id": "task_01",
      "slug": "string",
      "title": "string",
      "branch": "workflow/slug",
      "pr_number": null,        // null | number
      "status": "pending|spec_writing|spec_review|plan_writing|plan_review|implementing|code_review|pr_created|pr_review|completed|failed|cancelled|blocked|split",
      "phase_loop_count": 0,
      "depends_on": [],
      "parent_task_id": null,        // OPTIONAL — cho sub-tasks, trỏ về parent task_id
      "sub_tasks": [],               // OPTIONAL — cho parent task khi split, liệt kê sub-task IDs
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
          // { "phase": "spec_writing", "role": "spec-writer", "model": "claude-opus-4",
          //   "prompt_chars": 8400, "completion_chars": 7200,
          //   "estimated_prompt_tokens": 2100, "estimated_completion_tokens": 1800,
          //   "estimated_total_tokens": 3900,
          //   "request_count": 1, "has_tool_calls": false, "at": "ISO" }
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
**LUÔN dùng Bash tool** (không dùng Write/Edit — tránh hiện diff dài trên CLI):

```bash
# Backup + ghi state trong 1 lệnh
cp .workflow/{wf_id}/state.json .workflow/{wf_id}/state.backup.json 2>/dev/null; node -e "
const s = {JSON_OBJECT};
require('fs').writeFileSync('.workflow/{wf_id}/state.json', JSON.stringify(s, null, 2));
console.log('State updated');
"
```

**Tương tự cho registry:**
```bash
node -e "
const r = {REGISTRY_OBJECT};
require('fs').writeFileSync('.workflow/registry.json', JSON.stringify(r, null, 2));
console.log('Registry updated');
"
```

**Quy tắc:** Tất cả ghi state/registry PHẢI dùng Bash + `node -e` — không dùng Write/Edit tool.
Cập nhật registry sau mỗi lần ghi state (Section 4).

### Đọc state file
1. Dùng Read tool đọc `.workflow/{wf_id}/state.json`
2. Parse JSON — nếu parse fail → đọc `.workflow/{wf_id}/state.backup.json` làm fallback

### Lưu ý
- `.workflow/` PHẢI nằm trong `.gitignore` — đây là orchestration state, không phải project artifact
- Artifacts (spec, plan) được commit riêng trong `{docs_dir}/`

### Budget Update sau moi Dispatch (v2.1)

Sau MOI agent dispatch:
1. Do `prompt_chars` (noi dung prompt gui cho teammate)
2. Nhan response → do `completion_chars`
3. Tinh tokens tach rieng:
   - `estimated_prompt_tokens = ceil(prompt_chars / chars_per_token)`
   - `estimated_completion_tokens = ceil(completion_chars / chars_per_token)`
   - `estimated_total_tokens = estimated_prompt_tokens + estimated_completion_tokens`
4. Tao dispatch record:
   ```jsonc
   {
     "phase": "...", "role": "...", "model": "...",
     "prompt_chars": ..., "completion_chars": ...,
     "estimated_prompt_tokens": ..., "estimated_completion_tokens": ...,
     "estimated_total_tokens": ...,
     "request_count": 1,  // tang neu agent retry noi bo
     "has_tool_calls": false, "at": "ISO"
   }
   ```
5. Cap nhat state:
   - `task.budget.tokens_used += estimated_total_tokens`
   - `workflow.budget.tokens_used += estimated_total_tokens`
   - Append dispatch record vao `task.budget.dispatches[]`
6. Kiem tra budget status (Section 21)
7. Ghi state file (backup truoc)

### Dispatches Truncation

Neu `dispatches[]` > 100 entries → truncate oldest, giu 100 gan nhat.
- Luon giu `retry_boundary` markers (khong xoa boundaries)
- Log warning khi truncation xay ra

### Budget Defaults (khi reactions.yaml khong co section budget)

`tokens_limit = null` (unlimited), `warn_at_pct = 80`, `chars_per_token = 4`
Van TRACK `tokens_used` va `dispatches[]` ngay ca khi limit = null.

---

## 8. Teammate Prompt Templates

### 8.1 unified-author

**Isolation:** `worktree` | **Mode:** `bypassPermissions`
**Tools:** Read, Write, Edit, Bash, Grep, Glob

**Vai trò:** Author XUYÊN SUỐT tất cả phases (spec → plan → code) cho cùng 1 task. Được spawn 1 lần ở phase `spec_writing`, sau đó nhận SendMessage để chuyển phase. PHẢI nhớ decisions và rationale từ phases trước.

```
Bạn là author xuyên suốt cho task "{task.title}".

IMPORTANT: Follow the output language setting from project config (reactions.yaml → project.language). Code, commit prefix, branch name, file path always in English.

## Vai trò
Bạn viết TẤT CẢ phases: spec → plan → code.
Bạn PHẢI nhớ decisions và rationale từ phases trước:
- Khi viết plan: nhớ tại sao spec chọn approach này, trade-offs gì
- Khi implement: nhớ plan rationale, reviewer đã challenge gì

## Phase hiện tại: {current_phase}
## Decisions từ phases trước: (đọc lại spec/plan nếu cần)

## Spec (nếu đã viết): {task.artifacts.spec}
## Plan (nếu đã viết): {task.artifacts.plan}
## Review history: {docs_dir}/reviews/{wf_id}/{task_id}/

## Yêu cầu gốc
{original_request}

## Feedback từ reviewer (nếu có)
{reviewer_feedback hoặc "Bản nháp đầu tiên — chưa có feedback"}

## Bối cảnh

- Explore the codebase to understand related code (use Grep/Glob)
- Assess the blast radius of changes

## Phase-specific instructions

### Khi SPEC (spec_writing):
- Pattern specs: {specs_dir}/YYYY-MM-DD-<topic>-design.md
- Đọc specs hiện có để tham khảo style
- Output: {specs_dir}/{date}-{slug}-design.md
- Commit: "docs: add {slug} design spec"
- Bạn PHẢI ghi section ## Decisions ở cuối spec (xem format bên dưới)

### Khi PLAN (plan_writing):
- Đọc spec đã approved tại {task.artifacts.spec}
- Pattern plans: {plans_dir}/YYYY-MM-DD-<topic>.md
- Plan phải bao gồm: files cần sửa, thứ tự implement, test strategy, risk assessment
- Output: {plans_dir}/{date}-{slug}.md
- Commit: "docs: add {slug} implementation plan"
- Bạn PHẢI ghi section ## Decisions ở cuối plan (xem format bên dưới)

### Khi IMPLEMENT (implementing):
- Đọc plan tại {task.artifacts.plan} và spec tại {task.artifacts.spec}
- Explore existing code before modifying
- Assess impact before modifying any symbol
- Quy trình TDD: viết tests → implement → chạy tests → fix
- Commit với message phù hợp (feat:, fix:, refactor:...)

## Decision Log — BẮT BUỘC

Bạn PHẢI ghi section ## Decisions ở cuối spec và plan. Đây là context quan trọng cho plan-writing, implementing, và recovery.

Format:
| # | Quyết định | Alternatives đã xét | Lý do chọn |
|---|-----------|---------------------|-------------|
| 1 | ... | ... | ... |
```

### 8.2 unified-reviewer

**Isolation:** không (foreground) | **Mode:** `bypassPermissions` | **Background:** `true`
**Tools:** Read, Grep, Glob, Bash (chỉ cho `gh` commands)

**Vai trò:** Reviewer XUYÊN SUỐT tất cả phases (spec → plan → code → PR) cho cùng 1 task. Được spawn 1 lần ở phase `spec_review`, sau đó nhận SendMessage để chuyển phase. PHẢI nhớ và cross-reference feedback từ phases trước.

```
Bạn là unified reviewer cho this project.

IMPORTANT: Follow the output language setting from project config (reactions.yaml → project.language). Code, commit prefix, branch name, file path always in English.

## Vai trò
Bạn review XUYÊN SUỐT toàn bộ lifecycle của task — từ spec → plan → code → PR.
Bạn PHẢI nhớ feedback đã cho ở phases trước và cross-reference khi review phase sau.

## Phase hiện tại: {current_phase}
## Artifact cần review: {artifact_path}

## Yêu cầu gốc từ user
{original_request}

## Bối cảnh artifacts
- Spec: {task.artifacts.spec}
- Plan: {task.artifacts.plan}
- PR: #{task.pr_number} trên branch {task.branch}
- Review history: {docs_dir}/reviews/{wf_id}/{task_id}/
  (Đọc lại review files nếu cần khôi phục context từ phases trước)

## Tiêu chí đánh giá theo phase

### Khi review SPEC (spec_review):
1. Spec có đầy đủ các section cần thiết không? (Overview, Architecture, API, Error handling, Testing)
2. Có thiếu edge case nào quan trọng không?
3. Có mâu thuẫn với architecture hiện tại không? (explore codebase to verify)
4. Có rõ ràng, cụ thể, có thể implement được không?

### Khi review PLAN (plan_review):
1. Plan có cover hết các requirement trong spec không? (cross-reference spec đã review)
2. Thứ tự implement có hợp lý không?
3. Có thiếu test cases quan trọng không?
4. Are all affected files identified?
5. Plan có khả thi và rõ ràng để implement không?
6. **Cross-check:** Feedback bạn đã cho ở spec phase có được address trong plan không?

### Khi review CODE (code_review):
1. Code có đúng theo plan không? (cross-reference plan đã review)
2. Plan có đúng theo spec không? (cross-reference spec đã review)
3. Tests có đầy đủ và pass không?
4. Có security issues không?
5. Có performance concerns không?
6. Code style có consistent với codebase không?
7. Blast radius có hợp lý không?
8. **Cross-check:** Các issues bạn raise ở spec/plan phase đã được resolve trong code chưa?

### Khi review PR (pr_review):
- Post review bằng gh command:
  - `gh pr review {pr_number} --approve --body "..."` — nếu code OK
  - `gh pr review {pr_number} --request-changes --body "..."` — nếu cần fix

## Output
Trả về ĐÚNG MỘT trong hai format:
- "approved" — nếu artifact đạt yêu cầu
- "issues: [danh sách vấn đề]" — nếu cần sửa, mỗi issue rõ ràng và actionable
```

### 8.3 _(đã gộp vào 8.1 unified-author)_

### 8.4 _(đã gộp vào 8.2 unified-reviewer)_

### 8.5 _(đã gộp vào 8.1 unified-author)_

### 8.6 _(đã gộp vào 8.2 unified-reviewer)_

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

### 9.2 Teammate Lifecycle — Spawn, Message, Reuse

**Khác biệt Subagent vs Teammate:**

| | Subagent (cũ) | Teammate (v2) |
|---|---|---|
| Spawn | `Agent(prompt)` — one-shot, huỷ sau khi done | `Agent(prompt, name, run_in_background: true)` — named, giữ sống |
| Follow-up | Không thể — phải spawn mới | `SendMessage(to=name)` — gửi thêm instructions |
| Review loop | Spawn agent mới mỗi vòng | SendMessage feedback → agent sửa trên context cũ |
| Song song | Nhiều Agent calls | Nhiều named agents, coordinate qua SendMessage |
| Context | Mất sau mỗi dispatch | Giữ nguyên — agent nhớ artifacts, feedback trước đó |
| Lifetime | Terminate sau response | Sống cho đến khi orchestrator kết thúc workflow |

**Quy tắc đặt tên teammate:**
```
Author (unified): author-{wf_id}-{task_id}
VD: author-wf_001-task_01
    (1 author duy nhất cho toàn bộ lifecycle: spec → plan → code)
    Spawn lần đầu ở spec_writing, SendMessage cho plan_writing và implementing

Reviewer (unified): reviewer-{wf_id}-{task_id}
VD: reviewer-wf_001-task_01
    (1 reviewer duy nhất cho toàn bộ lifecycle của task)

→ 2 long-lived teammates per task thay vì 6 short-lived
```

### 9.3 Spawn Teammate — Lần Đầu Dispatch

Khi task bắt đầu phase mới VÀ chưa có teammate cho role đó:

**Author (unified) — Worktree isolation, spawn 1 lần ở spec_writing:**
```
Agent(
  prompt: "{template 8.1 unified-author, current_phase=spec_writing}",
  name: "author-{wf_id}-{task_id}",
  isolation: "worktree",
  mode: "bypassPermissions",
  model: "{từ role_mapping hoặc smart selection}",
  run_in_background: true    // cho parallel dispatch
)
```

**Các phase sau (plan_writing, implementing) — SendMessage chuyển phase:**
```
SendMessage(
  to: "author-{wf_id}-{task_id}",
  message: "Phase mới: {phase}. Nhớ lại decisions từ phases trước.
    Review history: {docs_dir}/reviews/{wf_id}/{task_id}/
    Đọc lại review files nếu cần khôi phục context."
)
```

**Reviewer (unified) — Background, spawn 1 lần ở spec_review:**
```
Agent(
  prompt: "{template 8.2 unified-reviewer, current_phase=spec_review}",
  name: "reviewer-{wf_id}-{task_id}",
  mode: "bypassPermissions",
  run_in_background: true,
  model: "{từ role_mapping hoặc cross-model selection}"
)
```

**Các phase sau (plan_review, code_review, pr_review) — SendMessage chuyển phase:**
```
SendMessage(
  to: "reviewer-{wf_id}-{task_id}",
  message: "Phase mới: {phase}. Artifact: {path}. Nhớ lại feedback từ phases trước."
)
```

Sau khi spawn → lưu `name` vào task state để tái sử dụng.

### 9.4 SendMessage — Follow-up & Review Loop

Khi teammate đã tồn tại (đã spawn trước đó), **KHÔNG spawn mới** — dùng SendMessage:

**Review loop (reviewer tìm issues → author sửa):**
```
SendMessage(
  to: "author-wf_001-task_01",
  message: "Reviewer feedback (loop {N}/{max}):\n{issues}\n\nReview file: {docs_dir}/reviews/{wf_id}/{task_id}/{phase}-review-v{N}.md\nSửa và commit lại."
)
```

**Code reviewer nhận PR update:**
```
SendMessage(
  to: "code-reviewer-wf_001-task_01",
  message: "Writer đã push fixes. Re-review branch {branch}."
)
```

**Lợi ích:** Writer giữ context từ lần viết trước — biết artifact đã tạo, feedback đã nhận, không cần đọc lại từ đầu.

### 9.5 Khi Nào Spawn Mới vs SendMessage

```
Cần dispatch teammate cho {role}/{wf_id}/{task_id}
    |
    +-- Role là reviewer?
    |     |
    |     +-- CÓ → Teammate name "reviewer-{wf_id}-{task_id}" đã spawn?
    |     |         |
    |     |         +-- CÓ → SendMessage(to="reviewer-{wf_id}-{task_id}",
    |     |         |         message="Phase mới: {phase}. Artifact: {path}. Nhớ lại feedback từ phases trước.")
    |     |         |
    |     |         +-- KHÔNG → Agent(prompt=8.2 unified-reviewer, name="reviewer-{wf_id}-{task_id}", ...)
    |     |                     (spawn lần đầu ở spec_review, lưu name vào state)
    |     |
    |     +-- KHÔNG (author) → Teammate name "author-{wf_id}-{task_id}" đã spawn?
    |           |
    |           +-- CÓ → SendMessage(to="author-{wf_id}-{task_id}",
    |           |         message="Phase mới: {phase}. Review history: {docs_dir}/reviews/{wf_id}/{task_id}/")
    |           |         (teammate giữ context, tiếp tục làm việc)
    |           |
    |           +-- KHÔNG → Agent(prompt=8.1 unified-author, name="author-{wf_id}-{task_id}", ...)
    |                       (spawn teammate mới ở spec_writing, lưu name vào state)
    |
    +-- Teammate trả kết quả → orchestrator xử lý
```

**⚠ CRITICAL: `run_in_background: true` là BẮT BUỘC cho MỌI teammate Agent() call.**
Thiếu flag này → agent terminate sau response đầu tiên → SendMessage fail → review loop broken.
Áp dụng cho CẢ author LẪN reviewer, không ngoại lệ.

**Lưu ý:**
- Mỗi task có tối đa 3 teammates cùng lúc: 1 author (unified) + 1 reviewer (unified) + 1 escalation (v2.1)
- Author được spawn 1 lần ở spec_writing, dùng lại xuyên suốt plan_writing → implementing
- Reviewer được spawn 1 lần ở spec_review, dùng lại xuyên suốt plan_review → code_review → pr_review
- Khi task completed → teammates tự huỷ (không cần cleanup)
- Khi task retry → spawn teammates MỚI (context cũ có thể misleading)

### 9.5.0 Graceful Context Recovery

Khi teammate chết/không phản hồi hoặc cần retry:

```
Teammate chết/không phản hồi hoặc retry
    |
    +-- Kiểm tra artifact files trên disk
    |     |
    |     +-- CÓ files (spec/plan/review history tồn tại) →
    |     |     Spawn teammate mới với recovery prompt:
    |     |     "Bạn thay thế teammate trước. Đọc lại context:
    |     |      - Spec: {task.artifacts.spec}
    |     |      - Plan: {task.artifacts.plan}
    |     |      - Review history: {docs_dir}/reviews/{wf_id}/{task_id}/
    |     |      - Decision Log: đọc ## Decisions trong spec/plan
    |     |      - Phase hiện tại: {phase}
    |     |      - Tiếp tục từ đây."
    |     |
    |     +-- KHÔNG files → Spawn mới từ đầu phase (behavior cũ)
```

**Kiểm tra artifacts tồn tại:**
1. Đọc `task.artifacts.spec` — file tồn tại?
2. Đọc `task.artifacts.plan` — file tồn tại?
3. Kiểm tra `{docs_dir}/reviews/{wf_id}/{task_id}/` — có review files?
4. Nếu BẤT KỲ file nào tồn tại → dùng recovery prompt
5. Nếu KHÔNG file nào → spawn từ đầu phase

**Recovery prompt bổ sung vào unified-author (8.1) và unified-reviewer (8.2):**
Template đã bao gồm các paths cần thiết. Teammate mới chỉ cần Read files để khôi phục context.

### 9.5.1 Pause Check Trước Mỗi Dispatch

**TRƯỚC MỖI dispatch** (spawn hoặc SendMessage), orchestrator PHẢI:

```
1. Đọc state file → kiểm tra workflow.status
2. Nếu status == "paused" → DỪNG NGAY, không dispatch
   → Output: 🟡 ▸ [{HH:MM:SS}] Workflow paused — dừng tại {phase}
3. Nếu status == "running" → tiếp tục dispatch
```

**Giới hạn:** Không thể dừng teammate ĐANG chạy giữa chừng. `/stop-autodev` đánh dấu `paused` và workflow dừng **sau khi phase hiện tại hoàn thành**.

### 9.6 Placeholder Substitution

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

### 9.7 Cross-Model Reviewer Selection (v2.1)

Khi cross-model enabled, thay the reviewer selection logic:

**Reviewer model chon 1 lan khi spawn, giu xuyen suot:**
- Model reviewer duoc chon khi spawn `reviewer-{wf_id}-{task_id}` lan dau (tai spec_review)
- Model nay GIU NGUYEN cho tat ca phases sau (plan_review, code_review, pr_review)
- Neu muon doi model → phai spawn reviewer MOI (mat context tu phases truoc)
- **Recommend:** Chon model manh nhat cho reviewer vi no review xuyen suot

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

### 9.8 Pluggable Agent — Formal Role Mapping (v2)

Đọc `agents.role_mapping` từ `.workflow/reactions.yaml`:

```yaml
agents:
  role_mapping:
    author: claude-opus-4       # unified author — 1 model xuyên suốt spec/plan/code
    reviewer: gpt-4o            # unified reviewer — 1 model xuyên suốt spec/plan/code/PR review
    escalation: gemini-2.5-pro
```

**Smart model selection:**
- **Task size nhỏ** (1-2 files) → có thể dùng model nhẹ (haiku)
- **Task size lớn** (3+ files) → dùng model mạnh (opus, gpt-4o)
- **Retry sau failure** → upgrade model (haiku → sonnet → opus)
- **Reflect phase** → dùng model nhẹ (haiku) để tiết kiệm

Nếu không có `reactions.yaml` hoặc không có `role_mapping` → dùng model mặc định của Claude Code.

**Pricing config** (optional — enables cost estimates in Reflect summary):

```yaml
budget:
  pricing:  # USD per 1M tokens, keyed by model name
    claude-opus-4:    { prompt: 15.00, completion: 75.00 }
    claude-sonnet-4:  { prompt: 3.00,  completion: 15.00 }
    gpt-4o:           { prompt: 2.50,  completion: 10.00 }
    gemini-2.5-pro:   { prompt: 1.25,  completion: 10.00 }
```

Nếu không có `budget.pricing` → Reflect summary chỉ hiện tokens và requests, ẩn cost columns.

---

## 10. Review Loop Logic — Vòng Lặp Đánh Giá

### 10.0 Review Artifacts On Disk

Sau **MỖI review round**, orchestrator PHẢI ghi review output ra file trên disk:

```
{docs_dir}/reviews/{wf_id}/
├── {task_id}/
│   ├── spec-review-v1.md        ← issues lần 1
│   ├── spec-review-v2.md        ← approved
│   ├── plan-review-v1.md
│   ├── plan-review-v2.md
│   ├── code-review-v1.md
│   └── code-review-v2.md
```

**Quy tắc ghi file:**
- File name: `{phase}-review-v{loop_count}.md` (VD: `spec-review-v1.md`)
- Nội dung: toàn bộ output của reviewer (issues hoặc approved)
- Ghi bằng Bash tool: `mkdir -p {docs_dir}/reviews/{wf_id}/{task_id} && node -e "..."`
- Khi reviewer trả "approved" → ghi file cuối cùng với nội dung "APPROVED" + summary

**Khi SendMessage chuyển phase**, LUÔN kèm path đến review files trước đó:
```
SendMessage(
  to: "reviewer-{wf_id}-{task_id}",
  message: "Phase mới: {phase}. Artifact: {path}.
    Review history: {docs_dir}/reviews/{wf_id}/{task_id}/
    Nhớ lại feedback từ phases trước. Nếu context bị mất, đọc lại review files."
)
```

**Mục đích:** Dù compaction xóa conversation history, reviewer/author có thể Read file để khôi phục context.

---

Sau mỗi pha "write", dispatch unified reviewer (cùng 1 reviewer cho tất cả phases):

```
spec_writing hoàn thành → spawn reviewer-{wf_id}-{task_id} (lần đầu)
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

plan_writing hoàn thành → SendMessage đến reviewer-{wf_id}-{task_id}
  (reviewer nhớ context spec review, cross-reference spec khi review plan)
  ├── "approved" → implementing
  └── "issues" → loop tương tự

implementing hoàn thành → SendMessage đến reviewer-{wf_id}-{task_id}
  (reviewer nhớ context spec + plan review, cross-reference khi review code)
  ├── "approved" → pr_created
  └── "issues" → loop tương tự
```

**Reviewer giữ context xuyên suốt:** Không cần truyền lại spec/plan path — reviewer đã đọc từ phases trước.

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
    ├── CHỜ notifications (không poll):
    │   ├── Claude Code batch tất cả completed agent results vào 1 turn
    │   ├── Thứ tự results = dispatch order, không phải completion order
    │   ├── Xử lý từng result tuần tự:
    │   │   ├── Task completed → cập nhật state, cherry-pick nếu cần
    │   │   ├── Task failed → xử lý theo Section 16
    │   │   └── Task cần next phase → dispatch tiếp (background)
    │   └── Tất cả tasks trong group completed → group done → tiếp group sau
    │
    └── Group completed → tiếp parallel group tiếp theo
```

### 11.2 Merge Strategy

Mỗi task chạy trong **worktree isolation** trên branch `workflow/{slug}`.

**TRƯỚC khi spawn worktree agent:**

```
1. Kiểm tra local changes trên main branch:
   git_status = `git status --porcelain`

2. Nếu có local changes (modified/untracked):
   `git stash push -m "autodev-pre-{wf_id}" --include-untracked`
   Lưu stash_ref vào state: workflow.stash_ref = "autodev-pre-{wf_id}"

3. Spawn worktree agent (fork từ HEAD hiện tại)
```

**SAU khi worktree agent hoàn thành — Merge Flow:**

```
1. Lấy commit hash từ worktree branch:
   commit_hash = `git log workflow/{slug} -1 --format="%H"`

2. CHERRY-PICK (ưu tiên hơn merge — tránh merge commit noise):
   `git cherry-pick {commit_hash} --no-commit`

   Nếu OK → `git commit` → done

3. Nếu cherry-pick CONFLICT:
   a. Check loại conflict:

      - LOCAL CHANGES BLOCK (error: local changes would be overwritten):
        → `git stash` → retry cherry-pick → `git stash pop`

      - ADD/ADD CONFLICT (cùng file tạo trên cả 2 branch):
        → `git checkout workflow/{slug} -- {conflicted_files}`
        → `git add {conflicted_files}` → `git commit`

      - UNTRACKED FILE BLOCK (untracked file would be overwritten):
        → `git rm --cached {files}` hoặc `rm {files}`
        → Retry cherry-pick

      - CONTENT CONFLICT (cùng dòng sửa khác nhau):
        → Re-dispatch implementer với conflict context (Section 11.3)

4. Sau merge thành công:
   Nếu workflow.stash_ref tồn tại:
     `git stash pop` (hoặc `git stash apply` nếu lo mất data)
     Xóa stash_ref khỏi state
```

**Quy tắc merge order:**
- Tasks trong cùng parallel group: merge theo thứ tự hoàn thành (first done, first merged)
- Groups merge tuần tự: group 1 merge hết → group 2 bắt đầu
- Mỗi task tạo PR riêng, merge PR independently

### 11.3 Conflict Resolution

Khi cherry-pick/merge gặp content conflict (non-trivial):

```
1. Parse conflicted files: `git diff --name-only --diff-filter=U`

2. Nếu ≤ 3 files conflict:
   → Re-dispatch implementer với context:
     "Resolve merge conflicts in: {files}.
      Ours (main): {ours_content}.
      Theirs (worktree): {theirs_content}."
   → Implementer resolve → commit

3. Nếu > 3 files conflict:
   → Pause task, thông báo user:
     "Task {slug} has {N} merge conflicts.
      Run /resume-autodev {wf_id}:{task_id} after manual resolution."

4. Nếu re-implement cũng fail (2 attempts):
   → Pause task, log conflict details
```

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

### 11.5 Parallel Wait Mechanism

Background agents hoàn thành → Claude Code runtime batch notifications vào turn tiếp theo của orchestrator.

**Đặc điểm đã xác nhận:**
- **Batching:** TẤT CẢ pending notifications gộp vào 1 message turn
- **Thứ tự:** Theo dispatch order (tool_use_id), KHÔNG theo completion time
- **Không drop:** Cả N results đều present, không race condition
- **Model:** Event batching (giống React batched state updates)

**Orchestrator KHÔNG poll — chỉ đợi notifications:**

```
Dispatch Task A (background) → dispatch Task B (background) → dispatch Task C (background)
    ↓
Orchestrator nhận 1 batched turn chứa results [A, B, C]
    ↓
Xử lý tuần tự theo dispatch order:
    ├── Task A result → cập nhật state, chuyển phase tiếp
    ├── Task B result → cập nhật state, chuyển phase tiếp
    └── Task C result → cập nhật state, chuyển phase tiếp
    ↓
Tất cả tasks trong group đã xong phase hiện tại?
    ├── CÓ → group phase completed, dispatch phase tiếp cho cả group
    └── KHÔNG → dispatch phase tiếp cho tasks đã xong, chờ tasks còn lại
```

---

## 12. PR Lifecycle — Vòng Đời Pull Request

Orchestrator tự xử lý PR (không qua teammate):

### Bước 1: Push & Tạo PR
```bash
git push -u origin workflow/{slug}
gh pr create --title "{task.title}" --body "{progress_table}

## Review History
- Review files: {docs_dir}/reviews/{wf_id}/{task_id}/
- Spec: {task.artifacts.spec}
- Plan: {task.artifacts.plan}
"
```
Lưu `pr_number` vào state file. PR body PHẢI link đến review files để human có visibility vào toàn bộ review history.

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
SendMessage đến `reviewer-{wf_id}-{task_id}` (unified reviewer) để review PR.

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

## 13. Email Notification — Thông Báo Email

**BẮT BUỘC:** Orchestrator PHẢI gửi email tại mỗi sự kiện bên dưới bằng cách chạy Bash tool. Không skip.

**Cách gửi:** Copy-paste đoạn code dưới, thay `SUBJECT` và `BODY`:

```bash
node -e "
const n = require('nodemailer');
const t = n.createTransport({ host: process.env.SMTP_HOST, port: 587, secure: false, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
t.sendMail({ from: 'AutoDev <' + process.env.SMTP_USER + '>', to: '{notifications.email}', subject: 'SUBJECT', text: 'BODY' })
  .then(() => console.log('Email sent')).catch(e => console.error('Email failed:', e.message));
"
```

### Các sự kiện trigger email — PHẢI gửi

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

**Lưu ý:** Nếu email fail (SMTP lỗi), log `🟡 ▸ Email failed: {error}` rồi tiếp tục — không block workflow. Nhưng PHẢI thử gửi, không được skip.

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

### Color Dots

| Dot | Ý nghĩa | Dùng khi |
|-----|---------|---------|
| 🔵 | Đang chạy / Active | Bắt đầu phase, dispatch teammate |
| 🟢 | Thành công | Phase approved, task completed, workflow done |
| 🟡 | Cảnh báo | Timeout warning, budget warning, escalation |
| 🔴 | Thất bại | Phase failed, task failed, budget exceeded |
| 🟣 | Hệ thống | Checkpoint, migration, reflect, cache, dashboard |
| ⚪ | Chờ | Task pending, blocked |

### Format chuẩn

```
{dot} ▸ [{HH:MM:SS}] {wf_id}/{slug} {message}
```

### Ví dụ

```
── wf_001/rate-limiting ──────────────────
🔵 ▸ [15:30:02] wf_001/rate-limiting spec_writing bắt đầu
🟢 ▸ [15:30:45] wf_001/rate-limiting spec viết xong
🔵 ▸ [15:30:46] wf_001/rate-limiting spec_review loop 1
🔴 ▸ [15:31:20] wf_001/rate-limiting spec_review: 2 vấn đề
🔵 ▸ [15:31:21] wf_001/rate-limiting spec_writing sửa lại
🟢 ▸ [15:32:30] wf_001/rate-limiting spec APPROVED
🟣 ▸ [15:32:31] wf_001 checkpoint cp_003
```

### Cross-Model Logging (v2.1)

```
🔵 ▸ [HH:MM:SS] wf_id/slug cross-model review: writer=opus, reviewer=gpt-4o
🟡 ▸ [HH:MM:SS] wf_id/slug ESCALATION: reviewer nhẹ approve task phức tạp → dispatch gemini
🟢 ▸ [HH:MM:SS] wf_id/slug escalation APPROVED — advance phase
🟡 ▸ [HH:MM:SS] wf_id/slug CONSENSUS PAUSED — 3 models bất đồng
```

### Budget Logging (v2.1)

```
🟡 ▸ [HH:MM:SS] wf_id/slug BUDGET WARN: {used}/{limit} ({pct}%)
    → Model downgraded to haiku

🔴 ▸ [HH:MM:SS] wf_id/slug BUDGET EXCEEDED: {used}/{limit}
    → Task paused. /autodev-retry --budget +50% | /resume-autodev --budget unlimited

🔴 ▸ [HH:MM:SS] wf_id WORKFLOW BUDGET EXCEEDED: {used}/{limit}
    → Workflow paused. /resume-autodev --budget +50% | --budget unlimited
```

### Cache Logging (v2.1)

```
🟣 ▸ [HH:MM:SS] wf_id/slug CACHE HIT: spec (hash: {prefix}, saved ~{N}m)
🔵 ▸ [HH:MM:SS] wf_id/slug CACHE MISS: plan — dispatching plan-writer
🟣 ▸ [HH:MM:SS] wf_id/slug cached spec (hash: {prefix}, ttl: {N}d)
🟣 ▸ [HH:MM:SS] cache invalidation: {N} entries (reason: git_change)
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
| Test failure | Tests fail sau khi implement | Dispatch implementer với error output | Retry once with debug context. Then escalate |
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

`estimated_prompt_tokens = ceil(prompt_chars / cpt)`, `estimated_completion_tokens = ceil(completion_chars / cpt)`, `estimated_total_tokens = prompt + completion` (default cpt=4). Moi dispatch record luu tach rieng prompt/completion tokens va chars goc.

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
⚠ QUY TẮC UX: Output log TRƯỚC MỖI bước — user phải biết đang làm gì, không được im lặng.

1. V1 MIGRATION CHECK (Section 25)
   → LOG: 🟣 ▸ [{HH:MM:SS}] Kiểm tra v1 migration...
   └── Detect .workflow/state.json (v1) → migrate nếu cần

2. ĐỌC REGISTRY (Section 4)
   → LOG: 🟣 ▸ [{HH:MM:SS}] Đọc registry...
   └── Tạo mới nếu chưa có
   └── Kiểm tra giới hạn concurrent workflows + agents

3. ĐỌC CONFIG (Section 9.8)
   → LOG: 🟣 ▸ [{HH:MM:SS}] Đọc config (reactions, model-registry)...
   └── Load reactions.yaml → role_mapping, timeouts, budget, cache
   └── Load model-registry.json nếu cross-model enabled

4. PHÂN TÁCH TASKS (Section 5)
   → LOG: 🔵 ▸ [{HH:MM:SS}] Phân tích yêu cầu...
   └── Parse requirement → tasks
   └── Khai báo files_touched cho mỗi task
   └── Gán parallel groups
   → LOG: Hiển thị decomposition box → chờ user xác nhận

5. TẠO STATE FILE (Section 6, 7)
   → LOG: 🟣 ▸ [{HH:MM:SS}] Tạo workflow {wf_id}...
   └── mkdir -p .workflow/{wf_id}
   └── Ghi state.json với tasks ở status "pending"
   └── Cập nhật registry

6. KHỞI ĐỘNG DASHBOARD (tuỳ chọn, Section 24)
   └── Nếu user muốn → npx serve .workflow --cors

7. GỬI EMAIL "Workflow bắt đầu" (Section 13)
   → LOG: 🟣 ▸ [{HH:MM:SS}] Gửi email thông báo...

8. CACHE INVALIDATION (Section 26.4)
   → LOG: 🟣 ▸ [{HH:MM:SS}] Kiểm tra cache...
   └── Kiểm tra git changes → invalidate stale entries

9. CHO MỖI PARALLEL GROUP (tuần tự):
   │
   → LOG: 🔵 ▸ [{HH:MM:SS}] {wf_id} group {grp_id} bắt đầu ({N} tasks)
   │
   ├── 9a. Dispatch tasks trong group ĐỒNG THỜI (Section 11):
   │   │
   │   └── CHO MỖI TASK (parallel trong group):
   │       │
   │       ├── Tạo branch: git checkout -b workflow/{slug}
   │       ├── 🔵 ▸ [{HH:MM:SS}] {wf_id}/{slug} bắt đầu
   │       ├── Cập nhật timers
   │       │
   │       ├── ** KIỂM TRA paused** → nếu state=paused → DỪNG, không dispatch tiếp
   │       │
   │       ├── PHA SPEC (Section 8.1, 8.2, 10):
   │       │   ├── 🔵 ▸ [{HH:MM:SS}] {wf_id}/{slug} spec_writing — dispatching spec-writer...
   │       │   ├── Cache lookup → HIT? 🟣 CACHE HIT, skip : dispatch
   │       │   ├── Spawn/SendMessage spec-writer (Section 9.3/9.4)
   │       │   ├── 🔵 ▸ [{HH:MM:SS}] {wf_id}/{slug} spec_review — dispatching reviewer...
   │       │   ├── Spawn/SendMessage spec-reviewer
   │       │   ├── Loop nếu cần (max 3) — mỗi loop: 🔵 log trước dispatch
   │       │   ├── Budget check mỗi dispatch
   │       │   ├── Timeout check mỗi phase
   │       │   ├── Cache CREATE nếu approved
   │       │   ├── 🟢 ▸ [{HH:MM:SS}] {wf_id}/{slug} spec APPROVED
   │       │   └── 🟣 checkpoint
   │       │
   │       ├── PHA PLAN (Section 8.3, 8.4, 10):
   │       │   ├── 🔵 ▸ [{HH:MM:SS}] {wf_id}/{slug} plan_writing — dispatching plan-writer...
   │       │   ├── Cache lookup → HIT? skip : dispatch
   │       │   ├── Spawn/SendMessage plan-writer
   │       │   ├── 🔵 ▸ [{HH:MM:SS}] {wf_id}/{slug} plan_review — dispatching reviewer...
   │       │   ├── Loop nếu cần (max 3)
   │       │   ├── Budget check, timeout check
   │       │   ├── Cache CREATE nếu approved
   │       │   ├── 🟢 ▸ [{HH:MM:SS}] {wf_id}/{slug} plan APPROVED
   │       │   └── 🟣 checkpoint
   │       │
   │       ├── PHA IMPLEMENT (Section 8.5, 8.6, 10):
   │       │   ├── 🔵 ▸ [{HH:MM:SS}] {wf_id}/{slug} implementing — dispatching implementer...
   │       │   ├── Spawn/SendMessage implementer
   │       │   ├── 🔵 ▸ [{HH:MM:SS}] {wf_id}/{slug} code_review — dispatching reviewer...
   │       │   ├── Loop nếu cần (max 3)
   │       │   ├── Budget check, timeout check
   │       │   ├── 🟢 ▸ [{HH:MM:SS}] {wf_id}/{slug} code review APPROVED
   │       │   └── 🟣 checkpoint
   │       │
   │       ├── PHA PR (Section 12):
   │       │   ├── 🔵 ▸ [{HH:MM:SS}] {wf_id}/{slug} pushing + creating PR...
   │       │   ├── Push + tạo PR
   │       │   ├── 🔵 ▸ [{HH:MM:SS}] {wf_id}/{slug} PR #{N} — AI self-review...
   │       │   ├── AI self-review
   │       │   ├── 🔵 ▸ [{HH:MM:SS}] {wf_id}/{slug} polling external comments...
   │       │   ├── Poll external comments
   │       │   └── Final summary khi xong
   │       │
   │       └── 🟢 ▸ [{HH:MM:SS}] {wf_id}/{slug} HOÀN THÀNH
   │
   ├── 9b. CHỜ tất cả tasks trong group → group completed
   │   → LOG: 🟢 ▸ [{HH:MM:SS}] {wf_id} group {grp_id} hoàn thành
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

## 28. Reflect Phase — Tong Ket Cuoi Workflow (v2 + v2.1 + v2.2.1)

### 28.0 Aggregate Computation

Truoc khi hien summary, iterate qua tat ca `task.budget.dispatches[]` cua moi task:

```
for each task:
  for each dispatch in task.budget.dispatches:
    // Per-phase stats
    per_phase_stats[dispatch.phase].requests += dispatch.request_count
    per_phase_stats[dispatch.phase].prompt_tokens += dispatch.estimated_prompt_tokens
    per_phase_stats[dispatch.phase].completion_tokens += dispatch.estimated_completion_tokens
    per_phase_stats[dispatch.phase].total_tokens += dispatch.estimated_total_tokens

    // Per-model stats
    per_model_stats[dispatch.model].requests += dispatch.request_count
    per_model_stats[dispatch.model].tokens += dispatch.estimated_total_tokens

    // If pricing config exists for this model:
    if pricing[dispatch.model]:
      cost = (dispatch.estimated_prompt_tokens * pricing[model].prompt / 1_000_000)
           + (dispatch.estimated_completion_tokens * pricing[model].completion / 1_000_000)
      per_model_stats[dispatch.model].estimated_cost_usd += cost

    total_requests += dispatch.request_count
```

Luu ket qua vao `reflect` object trong state file.

### 28.1 Summary Format

Output khi workflow completed:

```
═══════════════════════════════════════════════════════════════
  WORKFLOW SUMMARY: {wf_id}
═══════════════════════════════════════════════════════════════
  Request:    "{original_request}"
  Duration:   {total_duration}
  Tasks:      {completed}/{total} completed
  Groups:     {parallel_groups_used} parallel groups
  Loops:      {total_review_loops} review loops
═══════════════════════════════════════════════════════════════

  TOKEN USAGE BY PHASE
  ───────────────────────────────────────────────────────────
  Phase              Requests   Prompt   Completion    Total
  ───────────────────────────────────────────────────────────
  spec_writing              2    3,200      4,100      7,300
  spec_review               3    2,800      1,200      4,000
  plan_writing              1    4,500      5,200      9,700
  plan_review               2    3,100      1,000      4,100
  implementing              3   12,400     18,600     31,000
  code_review               2    8,200      2,400     10,600
  pr_review                 1    1,500        800      2,300
  ───────────────────────────────────────────────────────────
  TOTAL                    14   35,700     33,300     69,000

  TOKEN USAGE BY MODEL
  ───────────────────────────────────────────────────────────
  Model                Requests    Tokens    Est. Cost
  ───────────────────────────────────────────────────────────
  claude-opus-4              8    45,000       ~$0.68
  gpt-4o                     5    21,000       ~$0.12
  gemini-2.5-pro             1     3,000       ~$0.02
  ───────────────────────────────────────────────────────────
  TOTAL                     14    69,000       ~$0.82

  PER-TASK BREAKDOWN
  ───────────────────────────────────────────────────────────
  Task                 Requests  Tokens   Loops  Duration
  ───────────────────────────────────────────────────────────
  rate-limiting              6   32,000     2    18m 20s
  auth-refactor              4   18,000     1    10m 05s
  search-caching             4   19,000     1    12m 30s

  CACHE PERFORMANCE
  ───────────────────────────────────────────────────────────
  Spec hits: 1/3    Plan hits: 0/3    Time saved: ~4m 20s

═══════════════════════════════════════════════════════════════
```

### 28.2 Format Rules

- So tokens format co dau phay ngan hang nghin (VD: `45,000`)
- Cost hien thi `~$X.XX` (uoc tinh, prefix `~`)
- Neu khong co `budget.pricing` config → an cot `Est. Cost`, section `TOKEN USAGE BY MODEL` chi hien Requests + Tokens
- Duration format: `Xh Ym Zs` (bo don vi = 0, VD: `18m 20s` thay vi `0h 18m 20s`)
- Section `CACHE PERFORMANCE` chi hien khi cache enabled
- Chi hien phases co data (bo phases request=0)
- Tat ca text bang tieng Anh (data table, khong phai prose)

### 28.3 Cross-Model Summary (v2.1)

Xem Section 20.2 — bo sung ben canh summary tren, KHONG thay the.