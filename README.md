# DeepSeek API 更新日志监控

一个常驻在本地 Homelab 的 DeepSeek API 更新日志监控服务。服务每 5 分钟抓取一次
[DeepSeek API 更新日志](https://api-docs.deepseek.com/zh-cn/updates)，通过 SHA-256
比较日期和标题，并通过邮件、Server酱、PushPlus 等渠道发送变化通知和定时状态。

## 当前通知规则

所有时间固定使用东八区（UTC+8）：

- `00:00 <= 时间 < 08:00`：继续每 5 分钟检测，但不发送任何通知。
- 夜间检测到的变化会保存在状态文件中，08:00 后补发，不会因为静默而丢失。
- `08:00、10:00、12:00、14:00、16:00、18:00、20:00、22:00`：发送一次状态通知，即使没有变化也会发送。
- `08:00-24:00` 检测到变化：不等待下一个两小时整点，立即发送。
- 如果变化通知恰好发生在一个尚未发送的两小时窗口，它同时算作该窗口的状态通知，不会连续发送两封。
- 服务停机后恢复时，只补当前窗口的一次状态，不会把错过的所有心跳集中补发。

检测周期和通知周期相互独立：页面仍然每 5 分钟检测，两小时只是无变化时的主动报平安周期。

## 状态与可靠性

状态保存在 `/data/state.json`，包含两套快照：

- `entries` / `hash`：最近一次检测到的页面内容。
- `notifiedEntries` / `notifiedHash`：最近一次已经成功通知的内容。

这套拆分可以保证夜间继续检测时不会吞掉变化。状态通过临时文件加原子重命名写入，断电或进程被终止时不会留下只写了一半的 JSON。

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

`npm test` 覆盖解析器和以下调度边界：静默起止时间、两小时固定窗口、夜间变化积压、08:00 补发、窗口内去重以及白天变化即时通知。

## GitHub Actions

定时调度已经从工作流中移除，避免本地容器和 GitHub 重复通知。工作流仍保留 `workflow_dispatch`，用于手动故障排查。状态迁移完成后，本地容器不会再向仓库自动提交 `last-update.json`。
