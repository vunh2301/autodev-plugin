---
name: autodev-retry
description: "Retry task bị failed. Hỗ trợ: /autodev-retry wf_001:task_01 (1 task), /autodev-retry wf_001 (tất cả failed tasks)"
---

**⚠ Output language is determined by project.language in reactions.yaml.**

# /autodev-retry — Retry task bị failed

## Parse arguments

- Không có arg → `🔴 ▸ Cần chỉ định target. VD: /autodev-retry wf_001:task_01` → DỪNG
- `wf_001` → retry TẤT CẢ failed tasks trong workflow
- `wf_001:task_01` → retry 1 task cụ thể

## Quy trình

1. **Đọc registry**
   - Read `.workflow/registry.json`
   - Nếu không tồn tại → `🔴 ▸ Không có workflow nào.` → DỪNG

2. **Tìm workflow**
   - Parse `wf_id` (và `task_id` nếu có) từ argument
   - Tìm workflow trong registry, nếu không thấy → `🔴 ▸ Không tìm thấy {wf_id}` → DỪNG

3. **Đọc state**
   - Read `.workflow/{wf_id}/state.json`

4. **Xác định tasks cần retry**
   - `wf_id:task_id` → tìm task khớp, kiểm tra `status == "failed"`
     - Nếu không failed → `🟡 ▸ Task {task_id} không ở trạng thái failed (hiện tại: {status})` → DỪNG
   - `wf_id` → lọc tất cả tasks có `status == "failed"`
     - Nếu không có task failed → `🟡 ▸ Không có task nào bị failed trong {wf_id}` → DỪNG

5. **Với mỗi task cần retry**:
   a. Tìm phase thành công cuối trong `task.history[]` (duyệt từ cuối):
      - Entry có `result` là `"done"` hoặc `"approved"`
      - Xác định phase tiếp theo:
        - `spec_writing` (done) → `spec_review`
        - `spec_review` (approved) → `plan_writing`
        - `plan_writing` (done) → `plan_review`
        - `plan_review` (approved) → `implementing`
        - `implementing` (done) → `code_review`
        - `code_review` (approved) → `pr_created`
        - `pr_created` (done) → `pr_review`
      - Nếu KHÔNG tìm thấy phase thành công → resume từ `spec_writing`
   b. Set `task.status` = phase tiếp theo
   c. Set `task.phase_loop_count` = 0
   d. Thêm history entry:
      ```json
      { "phase": "retry", "at": "<ISO now>", "result": "retrying", "details": "Retry từ {last_phase}, tiếp tục tại {next_phase}" }
      ```

6. **Smart model upgrade**
   - Nếu task đã failed với model mặc định → gợi ý: `🟣 ▸ Task đã failed với model mặc định. Thử upgrade lên opus?`
   - Chờ user phản hồi trước khi tiếp tục

7. **Cập nhật workflow**
   - Set workflow `status: "running"`, `paused_by: null`, `updated_at: <ISO now>`
   - Backup → `.workflow/{wf_id}/state.backup.json`
   - Ghi `.workflow/{wf_id}/state.json`
   - Cập nhật registry entry status → `"running"`
   - Ghi `registry.json`

8. **Output kết quả**

```
🟣 ▸ [{time}] RETRY {wf_id}

🔵 ▸ [{time}] {wf_id}/{task_id}
  🔄 Retry — phase cuối: {last_phase} → tiếp tục: {next_phase}

🔵 ▸ [{time}] {wf_id}/{task_id2}
  🔄 Retry — phase cuối: {last_phase} → tiếp tục: {next_phase}

🟢 ▸ Đang chuyển sang /autodev để tiếp tục orchestration...
```

9. **Hand off** — gọi skill `/autodev` để tiếp tục orchestration

## Lưu ý

- Retry chỉ áp dụng cho task có `status: "failed"`
- Phase loop count reset về 0 khi retry
- Max loop mặc định = 2
