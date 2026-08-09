# DeepSeek API 更新日志监控（deepseek-updates-watcher）

一个基于 GitHub Actions 的定时监控项目：每小时抓取
[DeepSeek API 更新日志](https://api-docs.deepseek.com/zh-cn/updates) 页面，检测到**新的更新条目**（尤其是**新模型发布**）时，通过邮件 / Server酱 / PushPlus / Telegram / Discord / Slack / ntfy / Bark 等渠道推送通知，并把最新状态快照自动提交回仓库。

## 项目简介

DeepSeek 的更新日志是静态 Docusaurus 页面，没有公开的 RSS / API 接口。本项目用 Node.js 脚本定期抓取该页面、解析条目并与上次的快照比对，从而实现"有新内容立刻通知你"的效果：

- 🕐 **每小时自动检查**（可自定义 cron）
- 🚀 **识别新模型发布**（如 `DeepSeek-V4-Flash`），标题显示为"🚀 新模型发布："
- 📢 其他更新显示为"📢 更新日志："
- 📧 邮件 + 7 种主流即时通讯渠道，任意组合
- 💾 状态文件 `last-update.json` 即"记忆"，无外部数据库

## 工作原理

```
定时触发 GitHub Actions
        │
        ▼
抓取 https://api-docs.deepseek.com/zh-cn/updates  HTML
        │
        ▼
parseUpdates() 按 <h2> 块正则解析出 [{date, title, body}]
        │
        ▼
与状态文件 last-update.json 中上次的 [{date, title}] 快照对比
        │
   ┌────┴─────┐
   ▼          ▼
 有变化      无变化 → 静默退出
   │
   ▼
向已配置的通知渠道推送（新模型发布 → 🚀 前缀）
   │
   ▼
写入新快照 last-update.json，提交并推送回 GitHub
```

状态文件是项目的"记忆"：首次运行记录全量快照，之后每次只推送**新增**的条目，所以不会重复轰炸。检测到变化时仓库里会留下一次 commit（如 `chore: update DeepSeek changelog snapshot`），也是一份历史审计记录。

## 目录结构

```
deepseek-updates-watcher/
├── .github/workflows/
│   └── check-updates.yml    # GitHub Actions 工作流（定时 + 手动触发）
├── scripts/
│   ├── parse-updates.mjs    # HTML 解析模块（纯正则，无第三方库）
│   └── check-updates.mjs    # 主脚本：抓取→解析→比对→通知→写状态
├── test/
│   ├── fixtures/updates.html    # 真实抓取的页面快照（勿修改）
│   └── verify_fixture.mjs       # 用快照验证解析逻辑的测试
├── last-update.json         # 状态快照（监控的"记忆"，自动提交）
├── package.json             # 依赖与脚本（仅 nodemailer）
└── .gitignore
```

## 快速开始

1. **新建仓库**：在 GitHub 上创建一个仓库（可设为 Private）。

2. **本地初始化**（可选，也可直接在 GitHub 网页上"上传文件"）：
   ```powershell
   cd deepseek-updates-watcher
   git init
   git add .
   git commit -m "init: deepseek updates watcher"
   git branch -M main
   git remote add origin git@github.com:<你的用户名>/<仓库名>.git
   git push -u origin main
   ```

3. **添加 Secrets**：进入仓库
   `Settings → Secrets and variables → Actions → New repository secret`，
   按下面的"通知渠道配置表"添加你要用的渠道密钥。**不填任何 Secret 也能运行**（只是收不到通知），脚本会打印警告但照常提交状态快照。

4. **手动触发一次**：`Actions` 页 → 选中 **Watch DeepSeek API Updates** → **Run workflow**，验证一切正常。

## 通知渠道配置表

每个渠道为**可选项**，在仓库 Secrets 中配置对应密钥即启用；不配置自动跳过。

| 渠道 | 所需 Secrets | 说明 |
| ---- | ------------ | ---- |
| SMTP 邮件 | `SMTP_HOST`、`SMTP_USER`、`SMTP_PASS`、`MAIL_TO`；可选 `SMTP_PORT`（默认 587）、`SMTP_SECURE`（`true` 表示 465 SSL）、`SMTP_FROM`（默认用 `SMTP_USER`） | 发送 HTML 邮件。`MAIL_TO` 支持逗号分隔多个收件人。**注意：QQ 邮箱 / Gmail 需使用"授权码"而非登录密码**（QQ 邮箱在"设置→账户→开启 SMTP 服务"获取；Gmail 需开启两步验证后生成应用专用密码） |
| Server酱 | `SERVERCHAN_SENDKEY` | [Server酱 Turbo](https://sct.ftqq.com) 微信推送，表单 POST 到 `sctapi.ftqq.com/{key}.send` |
| PushPlus | `PUSHPLUS_TOKEN` | [PushPlus](https://www.pushplus.plus) 微信推送，JSON + markdown 模板 |
| Telegram | `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID` | 通过 BotFather 创建 Bot 获得 token；chat_id 为接收者的数字 ID（可与机器人 @userinfobot 获取） |
| Discord | `DISCORD_WEBHOOK` | 频道设置 → 集成 → Webhook 的完整 URL，正文自动截断至 2000 字符 |
| Slack | `SLACK_WEBHOOK` | Incoming Webhook 的完整 URL，消息体为 `{ text }` |
| ntfy | `NTFY_TOPIC`；可选 `NTFY_SERVER` | 默认 POST 到 `https://ntfy.sh/{topic}`；`NTFY_SERVER` 可指向自建 ntfy 服务器 |
| Bark | `BARK_KEY` | iOS 推送，GET 请求，正文自动截断至约 300 字符以控制 URL 长度 |

## 首次运行

部署后第一次运行时，若状态文件为空，脚本会记录全量快照并发送一条 **"监控已启动"** 确认消息（提示你渠道配置正确、能收到通知）。之后只推送新增条目。

> 不需要首次确认消息？在 Secrets 中添加 `NOTIFY_ON_FIRST_RUN` 并设为 `false`。

## 测试

- **手动触发**：仓库 `Actions` 页 → **Watch DeepSeek API Updates** → 右侧 **Run workflow** → 运行按钮。
- **本地解析测试**：
  ```powershell
  npm run verify:fixture
  ```
  用 `test/fixtures/updates.html`（真实抓取的 18 条快照）校验解析逻辑。

## 自定义

- **检查频率**：修改 `.github/workflows/check-updates.yml` 中 `schedule.cron`。`0 * * * *` = 每小时整点；`*/30 * * * *` = 每 30 分钟。（注意：GitHub Actions 的 cron 使用 **UTC 时间**；调度在高负载时段（每小时整点）可能延迟几分钟，属正常现象；公共仓库的定时工作流在 60 天无仓库活动后会被自动禁用，需手动重新启用）
- **监控其他页面**：`PAGE_URL` 默认指向中文更新日志页，可通过 Secret `PAGE_URL` 覆盖（页面结构需一致）。
- **本地调试**：见下节。

## 本地调试

```powershell
npm install
$env:DRY_RUN = 'true'   # 演练模式：抓取 + 解析 + 比对，但不发送通知、不写状态文件
node scripts/check-updates.mjs
```

DRY_RUN 模式会打印解析结果、变化检测结果、将发送给哪些渠道、将写入的状态内容，**不会产生任何副作用**。想验证真实推送，可临时在 PowerShell 中 `$env:SERVERCHAN_SENDKEY = '...'` 等设置后，去掉 `DRY_RUN` 运行——但请留意状态文件会被写入。

## 兜底

脚本设计上**不会静默失败**：

- 页面抓取连续 3 次失败 → 脚本以非零码退出；
- 所有已配置渠道发送均失败 → 脚本以非零码退出；
- 这些情况下 GitHub Actions 会直接标记任务失败。建议在 GitHub 的 `Settings → Notifications` 里开启 **Actions** 相关失败邮件通知，即可在"监控脚本自身出问题"时也收到提醒。

## 注意事项

- **自动推送**：`check-updates.yml` 使用默认的 `GITHUB_TOKEN`，权限 `contents: write`，提交与推送均为自动完成，无需额外配置 PAT。
- **不会无限循环**：GitHub 规定从 Actions 内部触发的 commit **不会**重新触发同仓库的 `workflow_dispatch` / `schedule` 工作流，因此本项目的状态提交不会引起自我触发，无循环风险。
- **状态文件会被提交**：`last-update.json` 作为监控记忆需要入库，请勿加入 `.gitignore`。
- **渠道密钥只存 Secrets**：本地测试密钥请放 `.env` 文件（已在 `.gitignore` 中忽略），切勿提交。
