# DeepSeek API 更新日志监控

一个常驻在本地 Homelab 的 DeepSeek API 更新日志监控服务。服务每 5 分钟抓取一次
[DeepSeek API 更新日志](https://api-docs.deepseek.com/zh-cn/updates)，通过 SHA-256
比较日期和标题，并通过邮件、Server酱、PushPlus 等渠道发送变化通知和定时状态。

## 当前通知规则

所有时间固定使用东八区（UTC+8）：

- 页面始终每 5 分钟检测一次。
- **检测到更新**：不受时段限制，SMTP 邮件和微信渠道都立即发送，优先级最高。
- **SMTP 邮件无更新状态**：仅在 `08:00、10:00、12:00、14:00、16:00、18:00、20:00、22:00` 发送。
- **微信无更新状态**：平时完全静默，只在每天 `18:00` 发送一次当日汇总。
- 微信日报包括当天成功检测次数、页面变化次数、变化条目、最近条目和监控状态。
- 如果更新恰好在 18:00 被检测到，微信把即时更新和日报合并为一条消息。
- 服务短暂离线错过 18:00 后，会在当天恢复时补发日报；跨日遗漏的日报会在下一个 18:00 合并补发。

`00:00-08:00` 只静默常规状态消息，真正的更新仍会立即通知邮件和微信。

## 状态与可靠性

状态保存在 `/data/state.json`，采用 schema v3，包含：

- `entries` / `hash`：最近一次检测到的页面内容。
- `deliveries`：每个渠道独立保存已通知哈希、两小时窗口或微信日报日期。
- `dailyActivities`：最近 31 天的检测次数和变化明细，用于生成微信日报。

渠道状态彼此隔离，例如邮件成功但微信失败时，微信会在下一轮单独重试，不会被邮件的成功掩盖。状态通过临时文件加原子重命名写入，断电或进程被终止时不会留下只写了一半的 JSON。

容器使用 `restart: unless-stopped` 自动恢复；健康检查要求最近一次成功抓取不能早于 15 分钟前。通知全部失败时不会推进已通知快照，下一轮检测会继续重试。

## 本地 Docker 部署

```bash
cp .env.example .env
# 编辑 .env，至少配置一个通知渠道
docker compose build
docker compose up -d
docker compose logs -f --tail 100
```

服务器上的默认目录：

```text
C:\srv\stacks\deepseek-updates-watcher       项目和 compose.yaml
C:\srv\appdata\deepseek-updates-watcher     持久化状态
```

容器不开放任何入站端口，只需要出站访问监控页面、SMTP 和已启用的通知服务。

常用运维命令：

```bash
cd /mnt/c/srv/stacks/deepseek-updates-watcher
docker compose ps
docker compose logs --tail 100
docker compose restart
docker inspect --format '{{.State.Health.Status}}' deepseek-updates-watcher
```

## 配置

所有密钥只放在 `.env`，该文件已经被 `.gitignore` 排除。

| 渠道 | 环境变量 | 说明 |
| --- | --- | --- |
| SMTP 邮件 | `SMTP_HOST`、`SMTP_USER`、`SMTP_PASS`、`MAIL_TO` | 可选 `SMTP_PORT`、`SMTP_SECURE`、`SMTP_FROM` |
| Server酱 | `SERVERCHAN_SENDKEY` | 微信推送 |
| PushPlus | `PUSHPLUS_TOKEN` | 微信推送 |
| Telegram | `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID` | Bot 消息 |
| Discord | `DISCORD_WEBHOOK` | Webhook 消息 |
| Slack | `SLACK_WEBHOOK` | Incoming Webhook |
| ntfy | `NTFY_TOPIC` | 可选 `NTFY_SERVER`，默认 `https://ntfy.sh` |
| Bark | `BARK_KEY` | iOS 推送 |

其他配置：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PAGE_URL` | DeepSeek 中文更新日志 | 被监控页面 |
| `CHECK_INTERVAL_SECONDS` | `300` | 检测周期，最小 60 秒 |
| `NOTIFY_ON_FIRST_RUN` | `true` | 无历史状态时是否发送启动通知 |
| `STATE_FILE` | `/data/state.json` | 容器内状态路径 |

GitHub Actions Secrets 无法被读取或导出，因此从 Actions 迁移到本地时，需要把对应通知凭据重新填写到服务器 `.env`。

## 测试与演练

```bash
npm ci
npm test

# 抓取真实页面并显示本次决策，不发送、不写状态
DRY_RUN=true npm run check
```

`npm test` 覆盖解析器和以下调度边界：两小时邮件窗口、微信 18:00 日报、日报去重、旧状态迁移、微信日常静默，以及夜间更新同时触发邮件和微信。

## GitHub Actions

定时调度已经从工作流中移除，避免本地容器和 GitHub 重复通知。工作流仍保留 `workflow_dispatch`，用于手动故障排查。状态迁移完成后，本地容器不会再向仓库自动提交 `last-update.json`。
