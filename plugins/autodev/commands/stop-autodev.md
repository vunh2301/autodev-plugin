---
name: stop-autodev
description: "Dừng workflow đang chạy. Hỗ trợ: /stop-autodev (tất cả), /stop-autodev wf_001 (1 workflow), /stop-autodev wf_001:task_01 (1 task)"
---

**⚠ Output language is determined by project.language in reactions.yaml.**

# /stop-autodev — Dừng workflow đang chạy

## Parse arguments

- Không có arg → target = TẤT CẢ workflows đang running
- `wf_001` → target = 1 workflow
- `wf_001:task_01` → target = 1 task trong workflow

## Quy trình

1. **Đọc registry**
   - Read `.workflow/registry.json`
   - Nếu không tồn tại → `🔴 ▸ Không có workflow nào đang chạy.` → DỪNG

2. **Xác định targets**
   - Không arg → lọc tất cả workflows có `status: "running"` từ registry
   - `wf_id` → tìm workflow khớp, nếu không tìm thấy → `🔴 ▸ Không tìm thấy {wf_id}` → DỪNG
   - `wf_id:task_id` → tìm workflow + task khớp

3. **Với mỗi workflow target** — lặp qua danh sách:
   a. Read `.workflow/{wf_id}/state.json`
   b. Nếu target là task cụ thể → chỉ set task đó `status: "paused"`
   c. Nếu target là workflow → set tất cả task đang running về `status: "paused"`
   d. Set workflow `status: "paused"`, `paused_by: "command"`, `updated_at: <ISO now>`
   e. Tạo checkpoint:
      ```json
      { "id": "cp_NNN", "at": "<ISO now>", "task_id": "<task>", "phase": "<phase>", "message": "Dừng bởi /stop-autodev" }
      ```
   f. Backup → `.workflow/{wf_id}/state.backup.json`
   g. Ghi `.workflow/{wf_id}/state.json`
   h. Cập nhật entry tương ứng trong `registry.json`

4. **Ghi registry.json** đã cập nhật

5. **Output kết quả** — mỗi workflow 1 block, dùng separator:

```
🟣 ▸ [{time}] STOP-AUTODEV

🔵 ▸ [{time}] {wf_id}/{slug}
  ⏸ Đã dừng — {N} tasks paused
  Task 1 ({slug}): {phase} (loop {count}/{max})
  Task 2 ({slug}): {status}
  Checkpoint: {cp_id} đã lưu

─────────────────────────────────

🔵 ▸ [{time}] {wf_id2}/{slug2}
  ⏸ Đã dừng — {N} tasks paused
  ...

🟢 ▸ Dùng /resume-autodev để tiếp tục.
```

## Lưu ý

- Max loop mặc định = 2
- Nếu workflow đã paused → bỏ qua, output: `🟡 ▸ {wf_id} đã dừng rồi.`
- Skill này KHÔNG gọi orchestrator sau khi dừng
