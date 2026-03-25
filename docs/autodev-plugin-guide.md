# Autodev Plugin — Hướng Dẫn Cài Đặt & Sử Dụng

Plugin đóng gói hệ thống autodev workflow thành package có thể cài lên bất kỳ dự án nào dùng Claude Code.

## Tổng Quan

Autodev plugin tự động hoá toàn bộ quy trình phát triển:

```
Yêu cầu → Spec → Plan → Implement → PR → Review → Done
```

**Không cần copy SKILL.md thủ công** — plugin tự đăng ký commands, hooks, và config.

## Cài Đặt

### Cách 1: Từ marketplace (khuyến nghị)

```bash
# Bước 1: Thêm marketplace (chỉ cần 1 lần)
claude plugin marketplace add vunh2301/autodev-plugin

# Bước 2: Cài plugin
claude plugin install autodev
```

### Cách 2: Load trực tiếp (không cần cài)

```bash
# Clone repo
git clone https://github.com/vunh2301/autodev-plugin.git ~/.claude/plugins/local/autodev-plugin

# Chạy Claude Code với plugin
claude --plugin-dir ~/.claude/plugins/local/autodev-plugin
```

### Cách 3: Dùng cho 1 session (test nhanh)

```bash
# Không cần clone — chỉ cần đường dẫn local
claude --plugin-dir /path/to/autodev-plugin
```

## Khởi Tạo Dự Án

Sau khi cài plugin, chạy init script trong thư mục dự án:

```bash
cd /path/to/your-project

# Cơ bản
node ~/.claude/plugins/local/autodev-plugin/scripts/init.mjs

# Tùy chỉnh đầy đủ
node ~/.claude/plugins/local/autodev-plugin/scripts/init.mjs \
  --name "my-app" \
  --language "vi" \
  --specs-dir "docs/design" \
  --plans-dir "docs/plans" \
  --test-cmd "pnpm test" \
  --email "team@example.com"
```

### Init script tạo gì?

| File | Mục đích |
|------|----------|
| `.workflow/reactions.yaml` | Config chính — ngôn ngữ, paths, agents, budget, cache |
| `.workflow/model-registry.json` | Danh sách LLM models khả dụng |
| `docs/specs/` | Thư mục cho design specs |
| `docs/plans/` | Thư mục cho implementation plans |
| `.gitignore` entry | Thêm `.workflow/` vào gitignore |

### Options

| Flag | Default | Mô tả |
|------|---------|-------|
| `--name <name>` | Tên folder | Tên dự án (hiển thị trong logs, emails) |
| `--language <lang>` | `en` | Ngôn ngữ output: `en`, `vi`, `ja`, `zh` |
| `--specs-dir <path>` | `docs/specs` | Thư mục lưu design specs |
| `--plans-dir <path>` | `docs/plans` | Thư mục lưu implementation plans |
| `--test-cmd <cmd>` | `npm test` | Lệnh chạy tests |
| `--email <email>` | `null` | Email thông báo (null = tắt) |
| `--force` | — | Ghi đè config đã tồn tại |

## Cấu Hình

### `.workflow/reactions.yaml`

File config chính. Các section quan trọng:

```yaml
# === Thông tin dự án ===
project:
  name: "my-app"
  language: "en"              # Ngôn ngữ output
  specs_dir: "docs/specs"     # Nơi lưu specs
  plans_dir: "docs/plans"     # Nơi lưu plans
  test_command: "npm test"    # Lệnh test

# === Thông báo ===
notifications:
  email: null                 # null = tắt email
  smtp_host: "smtp.gmail.com"
  smtp_port: 587
  smtp_secure: false          # true cho port 465

# === Agent roles ===
agents:
  role_mapping:
    spec-writer: default      # "default" = model đang dùng
    spec-reviewer: default
    implementer: default
    code-reviewer: default

# === Cross-model review (tuỳ chọn) ===
cross_model:
  enabled: false              # Bật để dùng model khác cho reviewer
  role_mapping:
    writer: "claude-opus-4"
    reviewer: "gpt-5.4"

# === Budget (tuỳ chọn) ===
budget:
  task_budget_tokens: null    # null = không giới hạn
  workflow_budget_tokens: null
  warn_at_pct: 80

# === Cache (tuỳ chọn) ===
cache:
  enabled: true
  ttl_days: 7
  max_entries: 100
```

### `.workflow/model-registry.json`

Danh sách models khả dụng cho cross-model review. Chỉ cần sửa nếu bật `cross_model.enabled: true`.

## Lệnh

| Lệnh | Mô tả | Ví dụ |
|-------|--------|-------|
| `/autodev "yêu cầu"` | Bắt đầu workflow mới | `/autodev "add JWT auth"` |
| `/autodev-status` | Xem trạng thái | `/autodev-status wf_001` |
| `/stop-autodev` | Dừng workflow | `/stop-autodev wf_001` |
| `/resume-autodev` | Tiếp tục workflow | `/resume-autodev wf_001` |
| `/autodev-retry` | Retry task failed | `/autodev-retry wf_001:task_01` |
| `/autodev-cancel` | Huỷ workflow | `/autodev-cancel wf_001` |

## Cấu Trúc Files

```
your-project/
├── .workflow/                      # Runtime state (gitignored)
│   ├── reactions.yaml              # Config
│   ├── model-registry.json         # Models
│   ├── registry.json               # Multi-workflow registry (auto-created)
│   ├── cache/                      # Spec/plan cache (auto-created)
│   └── wf_YYYYMMDD_HHMMSS/        # Per-workflow state (auto-created)
│       ├── state.json
│       └── state.backup.json
│
├── docs/specs/                     # Design specs (committed to git)
│   └── 2026-03-20-feature-design.md
│
└── docs/plans/                     # Implementation plans (committed to git)
    └── 2026-03-20-feature.md
```

**Quy tắc:**
- `.workflow/` → gitignored (runtime state, không commit)
- `docs/specs/` và `docs/plans/` → committed (artifacts có giá trị)

## Pipeline Chi Tiết

```
┌──────┐    ┌──────┐    ┌──────┐    ┌─────────┐    ┌──────┐
│ SPEC │───▶│ PLAN │───▶│ IMPL │───▶│ PR+PUSH │───▶│ DONE │
└──┬───┘    └──┬───┘    └──┬───┘    └────┬────┘    └──────┘
   │ ▲         │ ▲         │ ▲           │ ▲
   ▼ │         ▼ │         ▼ │           ▼ │
┌────────┐  ┌────────┐  ┌────────┐  ┌─────────┐
│REVIEW  │  │REVIEW  │  │REVIEW  │  │REVIEW   │
└────────┘  └────────┘  └────────┘  └─────────┘
```

Mỗi phase có review loop (max 3 vòng). Nếu reviewer tìm thấy issues → writer sửa → re-review. Nếu vượt max loops → escalate.

### Parallel Execution

Nếu yêu cầu có nhiều tasks không overlap files, chúng chạy song song:

```
/autodev "thêm rate limiting + refactor auth middleware"

→ Task 1: rate-limiting (src/routes/search.ts)     ─┐
→ Task 2: auth-refactor (src/auth/*.ts)             ─┤ Parallel Group 1
                                                     ─┘
```

## Yêu Cầu Hệ Thống

- **Claude Code** CLI
- **`gh` CLI** đã login (`gh auth status`)
- **Git** với remote đã setup
- **Node.js** ≥18 (cho init script và hooks)
- Env: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (plugin tự set)

## So Sánh: Plugin vs Project-Local Skills

| | Plugin | Project-local (.claude/skills/) |
|---|---|---|
| **Cài đặt** | 1 lần, dùng mọi project | Copy thủ công mỗi project |
| **Update** | `claude plugin update` | Copy lại từ source |
| **Config** | `.workflow/reactions.yaml` per project | Hardcode trong SKILL.md |
| **Ngôn ngữ** | Configurable (en/vi/ja/zh) | Hardcode Vietnamese |
| **Dependencies** | Không cần gitnexus | Có thể cần gitnexus |
| **Hooks** | Auto-register qua plugin.json | Cần sửa settings.json |

## Troubleshooting

### Plugin không nhận commands

```bash
# Kiểm tra plugin đã cài chưa
claude plugin list

# Nếu local plugin, kiểm tra đường dẫn
ls ~/.claude/plugins/local/autodev-plugin/.claude-plugin/plugin.json
```

### Workflow không tìm thấy config

```bash
# Chạy init script
node <plugin-path>/scripts/init.mjs --force

# Kiểm tra .workflow/ tồn tại
ls .workflow/reactions.yaml
```

### Hook không chạy khi khởi động session

Plugin tự đăng ký hook qua `plugin.json`. Nếu không hoạt động:
1. Kiểm tra `plugin.json` có section `hooks.SessionStart`
2. Restart Claude Code session
3. Kiểm tra `CLAUDE_PLUGIN_ROOT` env var

### Email không gửi được

Email là optional. Cần cấu hình 2 nơi:

**1. reactions.yaml** — địa chỉ nhận và SMTP server:

```yaml
notifications:
  email: "team@example.com"       # Địa chỉ nhận thông báo
  smtp_host: "smtp.gmail.com"     # SMTP server
  smtp_port: 587                  # 587 (STARTTLS) hoặc 465 (SSL)
  smtp_secure: false              # true cho port 465
```

**2. Environment variables** — credentials (KHÔNG lưu trong config file):

```bash
# Set trong shell hoặc .env
export SMTP_USER="your-email@gmail.com"    # Tài khoản SMTP
export SMTP_PASS="your-app-password"       # App password (không phải password chính)
```

**Với Gmail:** Cần tạo App Password tại https://myaccount.google.com/apppasswords (yêu cầu 2FA đã bật). Không dùng password đăng nhập Gmail trực tiếp.

**Với dịch vụ khác:**

| Dịch vụ | smtp_host | smtp_port | Ghi chú |
|---------|-----------|-----------|---------|
| Gmail | smtp.gmail.com | 587 | Cần App Password |
| Outlook/Hotmail | smtp-mail.outlook.com | 587 | |
| SendGrid | smtp.sendgrid.net | 587 | SMTP_USER = "apikey" |
| Resend | smtp.resend.com | 465 | smtp_secure: true |
| Amazon SES | email-smtp.{region}.amazonaws.com | 587 | IAM credentials |

**Kiểm tra nhanh:**

```bash
# Test gửi email (cần nodemailer đã cài)
SMTP_USER="..." SMTP_PASS="..." node -e "
  const n = require('nodemailer');
  const t = n.createTransport({host:'smtp.gmail.com',port:587,auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}});
  t.sendMail({from:process.env.SMTP_USER,to:'test@example.com',subject:'Autodev test',text:'OK'}).then(()=>console.log('Sent!')).catch(e=>console.error(e.message));
"
```

## Chia Sẻ Cho Người Khác

### GitHub repo (public)

Plugin đã được publish tại: **https://github.com/vunh2301/autodev-plugin**

Người khác cài bằng 2 lệnh:

```bash
# Bước 1: Đăng ký marketplace (chỉ 1 lần)
claude plugin marketplace add vunh2301/autodev-plugin

# Bước 2: Cài plugin
claude plugin install autodev
```

Sau đó trong dự án của họ:

```bash
cd /path/to/their/project
node ~/.claude/plugins/*/autodev-plugin/scripts/init.mjs --name "their-app"
```

### Share nhanh (không cần marketplace)

```bash
# Người nhận clone + dùng --plugin-dir
git clone https://github.com/vunh2301/autodev-plugin.git ~/autodev-plugin
claude --plugin-dir ~/autodev-plugin
```

### Fork & customize cho team

```bash
# Fork repo
gh repo fork vunh2301/autodev-plugin --clone

# Sửa templates, commands, hooks theo nhu cầu
# Push lên org repo
git push origin main

# Team members đăng ký marketplace từ org repo
claude plugin marketplace add <org>/autodev-plugin
claude plugin install autodev
```

### Cài offline (không cần GitHub)

```bash
# Share qua zip
zip -r autodev-plugin.zip autodev-plugin/

# Người nhận giải nén + load
unzip autodev-plugin.zip
claude --plugin-dir ./autodev-plugin
```

### Update plugin

```bash
# Bước 1: Pull latest từ GitHub
claude plugin marketplace update autodev-marketplace

# Bước 2: Reinstall plugin (lấy version mới)
claude plugin uninstall autodev
claude plugin install autodev

# Bước 3: Restart Claude Code để áp dụng
```

> **Lưu ý:** `claude plugin update autodev` hiện có bug không tìm thấy plugin qua marketplace source. Dùng uninstall + install thay thế.

**Config `.workflow/reactions.yaml` không bị ghi đè** khi update — chỉ commands/hooks trong plugin thay đổi.

```bash
# Nếu cài qua clone (thủ công)
cd ~/autodev-plugin && git pull
# Restart Claude Code
```

---

## Migration từ Project-Local Skills

Nếu đang dùng autodev trong `.claude/skills/autodev/`:

1. Cài plugin (xem phần Cài Đặt)
2. Chạy init: `node <plugin-path>/scripts/init.mjs --language "vi"`
3. Sửa `.workflow/reactions.yaml`:
   - `specs_dir` → path cũ (VD: `docs/superpowers/specs`)
   - `plans_dir` → path cũ (VD: `docs/superpowers/plans`)
4. Workflows đang chạy (`.workflow/`) vẫn tương thích — plugin đọc cùng format state
5. Xoá `.claude/skills/autodev*` khi chắc chắn plugin hoạt động
