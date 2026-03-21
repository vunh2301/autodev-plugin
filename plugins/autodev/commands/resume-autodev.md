---
name: resume-autodev
description: "Tiếp tục workflow đã dừng. Hỗ trợ v1 migration, multi-workflow (wf_id/wf_id:task_id). VD: /resume-autodev hoặc /resume-autodev wf_001 hoặc /resume-autodev wf_001:task_01"
---

**⚠ Output language is determined by project.language in reactions.yaml.**

# /resume-autodev — Tiếp tục workflow đã dừng

## Quy trình

1. **Detect v1 vs v2**
   - Kiểm tra `.workflow/registry.json` tồn tại không?
     - **CÓ** → v2 mode → bước 2a
     - **KHÔNG** → kiểm tra `.workflow/state.json` tồn tại?
       - **CÓ** → v1 detected → chạy **v1 Migration** (xem autodev SKILL.md Section 25) → sau migration → v2 mode → bước 2a
       - **KHÔNG** → thử `.workflow/state.backup.json`
       - Nếu cả hai đều không tồn tại → output: `"Không tìm thấy workflow nào."` → DỪNG

2. **Parse argument (v2 multi-workflow)**
   - Nếu argument match pattern `wf_*:task_*` (VD: `wf_20260320_153000:task_01`):
     → Parse `wf_id` + `task_id`
   - Nếu argument match pattern `wf_*` (VD: `wf_20260320_153000`):
     → Parse `wf_id`, `task_id` = null (resume toàn bộ workflow)
   - Nếu argument match pattern `task_*` (VD: `task_01`):
     → `wf_id` = null (tìm tự động), `task_id` = argument
   - Nếu argument là flag (`--accept`, `--reject`, `--resolve`, `--budget`):
     → `wf_id` = null, `task_id` = null, lưu flags
   - Nếu không có argument:
     → `wf_id` = null, `task_id` = null (tự tìm)

3. **Tìm workflow (v2)**
   - Đọc `.workflow/registry.json`
   - Nếu `wf_id` chỉ định:
     - Tìm trong `active_workflows[]` theo `wf_id`
     - Nếu không tìm thấy → output: `"Không tìm thấy workflow {wf_id}"` → DỪNG
   - Nếu `wf_id` = null:
     - Tìm workflow đầu tiên có `status` là `"paused"` hoặc `"failed"`
     - Nếu nhiều workflows paused → liệt kê tất cả, hỏi user chọn:
       ```
       Có {N} workflows đang dừng:
       1. {wf_id_1} — "{request_summary}" (paused)
       2. {wf_id_2} — "{request_summary}" (failed)
       Chọn workflow để resume (1-{N}):
       ```
     - Nếu không tìm thấy → output: `"Không có workflow nào cần resume."` → DỪNG

4. **Đọc state file**
   - Dùng Read tool đọc `.workflow/{wf_id}/state.json`
   - Nếu không tồn tại → thử `.workflow/{wf_id}/state.backup.json`
   - Nếu cả hai fail → output: `"State file cho workflow {wf_id} bị hỏng."` → DỪNG

5. **Kiểm tra trạng thái**
   - Parse JSON
   - Nếu `status` là `"running"` → output: `"Workflow {wf_id} đang chạy rồi. Dùng /autodev-status để xem trạng thái."` → DỪNG
   - Nếu `status` là `"completed"` → output: `"Workflow {wf_id} đã hoàn thành. Không có gì để resume."` → DỪNG
   - Nếu `status` không phải `"paused"` và không phải `"failed"` → output: `"Workflow ở trạng thái {status}, không thể resume."` → DỪNG

6. **Tìm task để resume**
   - Nếu có `task_id` chỉ định:
     - Tìm task có `task_id` khớp trong mảng `tasks`
     - Nếu không tìm thấy → output: `"Không tìm thấy task {task_id} trong workflow {wf_id}"` → DỪNG
     - Nếu task đã `completed` hoặc `cancelled` → output: `"Task {task_id} đã {status}, không thể resume."` → DỪNG
   - Nếu không có `task_id`:
     - Tìm task đầu tiên có `status` KHÔNG thuộc `["pending", "completed", "cancelled", "blocked"]`
     - Nếu không tìm thấy → output: `"Tất cả tasks đã hoàn thành hoặc chưa bắt đầu."` → DỪNG

7. **Xác định chiến lược resume**
   - Kiểm tra phase hiện tại của task (`task.status`):
     - **Phase kết thúc bằng `_review`** (spec_review, plan_review, code_review, pr_review):
       → Chiến lược: "Tiếp tục review loop — sẽ dispatch reviewer lại"
     - **Phase là `implementing`**:
       → Kiểm tra xem có artifact (code changes) chưa commit không
       → Chiến lược: "Tiếp tục implementation — kiểm tra tiến độ code"
     - **Phase là `spec_writing` hoặc `plan_writing`**:
       → Kiểm tra artifact tương ứng (`artifacts.spec` hoặc `artifacts.plan`)
       → Nếu artifact tồn tại → chiến lược: "Artifact đã có — chuyển sang review"
       → Nếu chưa → chiến lược: "Tiếp tục viết từ đầu"
     - **Phase khác** (pr_created, pending, blocked):
       → Chiến lược: "Tiếp tục từ phase {phase}"
    - **Task bị pause bởi consensus (`paused_by` chứa `"consensus_disagreement"`):** (v2.1)
       → Kiểm tra argument:
         - `--accept` → Áp dụng majority vote, tiếp tục pipeline
         - `--reject` → Writer phải sửa tất cả issues, loop lại
         - `--resolve "ghi chú"` → Tiếp tục với ghi chú của user làm hướng dẫn cho writer
       → Nếu không có argument → Hiển thị consensus results và hỏi user chọn
    - **Task bị pause bởi budget (`paused_by` chứa `"budget"`):** (v2.1)
       → Kiểm tra argument:
         - `--budget +50%` → Tăng limit lên 150% giá trị cũ, reset status → OK
         - `--budget unlimited` → Set limit = null, reset status → OK
       → Nếu không có argument → Hiển thị budget usage và hỏi user chọn
       → Lưu ý: `paused_by` là array — chỉ resolve budget reason, nếu còn reasons khác thì vẫn paused
    - **Task bị pause bởi timeout (`paused_by` chứa `"timeout"`):** (v2)
       → Auto-resolve timeout reason khi resume (remove "timeout" từ paused_by)
       → Nếu còn reasons khác → vẫn paused

8. **Tìm checkpoint gần nhất** (nếu có)
   - Lọc `checkpoints[]` theo `task_id` của task đang resume
   - Lấy checkpoint cuối cùng (theo thứ tự mảng hoặc `at` timestamp)
   - Ghi nhận để hiển thị

9. **Cập nhật state**
   - Set `status: "running"`
   - Resolve paused_by reasons (xoá reasons đã xử lý, giữ reasons chưa xử lý)
   - Nếu `paused_by` vẫn còn items → giữ `status: "paused"`
   - Nếu `paused_by` rỗng → set `status: "running"`, `paused_by: []`
   - Set `updated_at` = ISO timestamp hiện tại
   - Cập nhật `timers.current_task_start` nếu resume task

10. **Backup và ghi file**
    - Đọc `.workflow/{wf_id}/state.json` hiện tại, ghi ra `.workflow/{wf_id}/state.backup.json`
    - Ghi state đã cập nhật vào `.workflow/{wf_id}/state.json`
    - **Cập nhật registry**: set workflow status trong `active_workflows[]`

11. **Output thông tin resume**

```
▶ Tiếp tục workflow {wf_id}
Task: {task_id} ({slug})
Phase: {phase}
Loop: {phase_loop_count}/{max}
Checkpoint gần nhất: {checkpoint_id} — {checkpoint_message}
Chiến lược: {strategy description}
```

12. **Chuyển sang orchestrator**
    - Output: `"Đang chuyển sang /autodev để tiếp tục orchestration..."`
    - Gọi skill `/autodev` để tiếp tục vòng lặp orchestration từ task và phase đã xác định