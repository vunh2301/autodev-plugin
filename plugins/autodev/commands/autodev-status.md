---
name: autodev-status
description: "Hiển thị trạng thái workflow hiện tại. Danh sách tasks, phase, loop count, checkpoints. VD: /autodev-status"
---

**⚠ Output language is determined by project.language in reactions.yaml.**

# /autodev-status — Hiển thị trạng thái workflow

## Quy trình

1. **Đọc state file**
   - Dùng Read tool đọc `.workflow/state.json`
   - Nếu không tồn tại → output: `"Không có workflow nào."` → DỪNG

2. **Parse JSON** và trích xuất thông tin workflow

3. **Tính tiến độ cho mỗi task**
   - Ánh xạ `task.status` → phần trăm:
     - `pending` → 0%
     - `spec_writing`, `spec_review` → 20%
     - `plan_writing`, `plan_review` → 40%
     - `implementing`, `code_review` → 60%
     - `pr_created`, `pr_review` → 80%
     - `completed` → 100%
     - `failed`, `cancelled`, `blocked` → hiển thị ký hiệu đặc biệt (xem bước 4)

4. **Tạo progress bar cho mỗi task**
   - Thanh progress gồm 10 ký tự, mỗi ký tự = 10%
   - Filled: `█`, Empty: `░`
   - VD: 60% → `[██████░░░░]`
   - Nếu `failed` → `[██FAILED██]`
   - Nếu `cancelled` → `[CANCELLED─]`
   - Nếu `blocked` → `[░░BLOCKED░]`

5. **Đếm và lấy checkpoint cuối**
   - Tổng số checkpoint trong `checkpoints[]`
   - Checkpoint cuối cùng: lấy phần tử cuối mảng

6. **Output dashboard**
   - Hiển thị theo format box-drawing sau:

```
┌────────────────────────────────────────────────────────┐
│ Workflow: {workflow_id}                                │
│ Trạng thái: {status}                                  │
│ Bắt đầu: {created_at}                                │
│ Cập nhật: {updated_at}                                │
│ Yêu cầu: {original_request (cắt ngắn nếu > 60 ký tự)}│
│                                                        │
│ Task 1: {slug}              [{progress_bar}] {pct}%   │
│   Phase: {status} (loop {phase_loop_count}/{max})     │
│   Branch: {branch}                                     │
│   PR: #{pr_number} hoặc "—"                           │
│   Depends: {depends_on[] hoặc "không"}                │
│                                                        │
│ Task 2: {slug}              [{progress_bar}] {pct}%   │
│   Phase: {status} (loop {phase_loop_count}/{max})     │
│   Branch: {branch}                                     │
│   PR: #{pr_number} hoặc "—"                           │
│                                                        │
│ ... (lặp cho tất cả tasks)                            │
│                                                        │
│ Tổng tiến độ: [{overall_bar}] {overall_pct}%          │
│                                                        │
│ Checkpoints: {count} đã lưu                           │
│ Checkpoint cuối: {last checkpoint message}             │
│                                                        │
│ Budget: {tokens_used} / {tokens_limit} ({pct}%)        │
│   [{budget_bar}] {budget_status}                       │
│   ├── task_01: {t_used} / {t_limit} ({t_pct}%) {s}    │
│   └── task_02: {t_used} / {t_limit} ({t_pct}%) {s}    │
│                                                        │
│ (Neu limit = null: "Budget: {tokens_used} tokens       │
│  (unlimited)")                                         │
└────────────────────────────────────────────────────────┘
```

Trong đó:
- `max` loop mặc định = 2 nếu không có thông tin khác
- `overall_pct` = trung bình phần trăm của tất cả tasks (bỏ qua cancelled)
- Nếu `status` là `"paused"` → thêm dòng: `"⏸ Workflow đang tạm dừng. Dùng /resume-autodev để tiếp tục."`
- Nếu `status` là `"failed"` → thêm dòng: `"✗ Workflow thất bại. Dùng /autodev-retry {task_id} để thử lại task lỗi."`

### Budget & Pause Reasons (v2.1)

- Doc `workflow.budget` va `task.budget` tu state file
- Neu field `budget` khong ton tai (state cu) → hien thi "Budget: khong co du lieu"
- Neu `paused_by` chua `"budget"` → them dong: `"Workflow tam dung (budget exceeded). /resume-autodev --budget +50% hoac --budget unlimited"`
- Neu `paused_by` chua `"consensus_disagreement"` → them dong: `"Workflow tam dung (consensus bat dong). /resume-autodev --accept | --reject | --resolve"`

## Lưu ý

- Skill này CHỈ ĐỌC, KHÔNG ghi file
- Không thay đổi state
- Luôn hiển thị TẤT CẢ tasks, kể cả pending
