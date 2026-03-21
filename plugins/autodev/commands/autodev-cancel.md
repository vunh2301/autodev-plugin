---
name: autodev-cancel
description: "Huỷ workflow hoặc task. Hỗ trợ: /autodev-cancel (tất cả, cần xác nhận), /autodev-cancel wf_001, /autodev-cancel wf_001:task_01"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

**⚠ Output language is determined by project.language in reactions.yaml.**

# /autodev-cancel — Huỷ workflow hoặc task

## Parse arguments

- Không có arg → huỷ TẤT CẢ workflows (cần xác nhận)
- `wf_001` → huỷ 1 workflow
- `wf_001:task_01` → huỷ 1 task trong workflow

## Quy trình

1. **Đọc registry**
   - Read `.workflow/registry.json`
   - Nếu không tồn tại → `🔴 ▸ Không có workflow nào để huỷ.` → DỪNG

2. **Nếu KHÔNG có arg** — huỷ toàn bộ:
   a. Yêu cầu xác nhận: `⚠ Huỷ TẤT CẢ {N} workflows? Gõ 'có' để xác nhận.`
   b. Nếu user KHÔNG gõ `"có"` → `🟡 ▸ Đã hủy thao tác.` → DỪNG
   c. Nếu user xác nhận:
      - Với mỗi workflow trong registry:
        - Read `.workflow/{wf_id}/state.json`
        - Với mỗi task có branch → `git branch -D workflow/{slug}` (ignore error)
        - Xoá folder: `rm -rf .workflow/{wf_id}/`
      - Xoá `.workflow/registry.json`
      - Thử xoá `.workflow/` nếu rỗng: `rmdir .workflow 2>/dev/null`
   d. Output:
   ```
   🔴 ▸ [{time}] CANCEL-ALL
     Đã huỷ {N} workflows
     Branches đã xoá: {danh sách hoặc "không có"}
     Registry đã xoá.
   ```

3. **Nếu có `wf_id`** — huỷ 1 workflow:
   a. Tìm workflow trong registry, nếu không tìm thấy → `🔴 ▸ Không tìm thấy {wf_id}` → DỪNG
   b. Read `.workflow/{wf_id}/state.json`
   c. Với mỗi task có branch → `git branch -D workflow/{slug}` (ignore error)
   d. Xoá folder: `rm -rf .workflow/{wf_id}/`
   e. Xoá entry khỏi registry, ghi lại `registry.json`
   f. Nếu registry rỗng → xoá `registry.json` luôn
   g. Output:
   ```
   🔴 ▸ [{time}] {wf_id}
     Đã huỷ workflow — {N} tasks cancelled
     Branches đã xoá: {danh sách}
   ```

4. **Nếu có `wf_id:task_id`** — huỷ 1 task:
   a. Tìm workflow + task, nếu không tìm thấy → `🔴 ▸ Không tìm thấy {wf_id}:{task_id}` → DỪNG
   b. Nếu task đã `completed` → `🟡 ▸ Task đã hoàn thành, không cần huỷ.` → DỪNG
   c. Nếu task đã `cancelled` → `🟡 ▸ Task đã bị huỷ rồi.` → DỪNG
   d. Set `task.status = "cancelled"`
   e. Thêm history entry: `{ "phase": "cancel", "at": "<ISO now>", "result": "cancelled", "details": "Huỷ bởi /autodev-cancel" }`
   f. Dọn branch: `git branch -D workflow/{slug}` (ignore error)
   g. Kiểm tra: nếu TẤT CẢ tasks đều cancelled/completed → set workflow `status: "cancelled"`, cập nhật registry
   h. Ghi `.workflow/{wf_id}/state.json` + `registry.json`
   i. Output:
   ```
   🔴 ▸ [{time}] {wf_id}/{task_id}
     Đã huỷ task ({slug})
     Branch đã xoá: workflow/{slug}
   ```

## Lưu ý

- Luôn dọn branches trước khi xoá state
- Dùng `2>/dev/null` hoặc ignore error cho git branch -D
- KHÔNG xoá code đã merge — chỉ xoá branches và state files
