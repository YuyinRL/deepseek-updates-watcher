/**
 * check-updates.mjs
 *
 * DeepSeek API 更新日志监控 —— 主脚本
 *
 * 工作流程：
 *   1. 抓取更新日志页面 HTML（带重试与超时）
 *   2. 用 parseUpdates() 解析出全部更新条目
 *   3. 读取状态文件，分别对比「最近检测」与「最近已通知」快照
 *   4. 按 UTC+8 静默期、变化即时通知和两小时状态通知规则作出决策
 *   5. 原子写入状态，并在通知失败时保留待通知变化供下一轮重试
 *
 * 支持的通知渠道（均为可选项，未配置相关环境变量即自动跳过）：
 *   SMTP 邮件 / Server酱 / PushPlus / Telegram / Discord / Slack / ntfy / Bark
 *
 * 除 nodemailer（仅 SMTP 用）外不依赖任何第三方包，全部使用 Node 内置能力。
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import { parseUpdates } from './parse-updates.mjs';
import { buildNextState, decideNotification } from './notification-policy.mjs';

// ---------------------------------------------------------------------------
// 环境配置与常量
// ---------------------------------------------------------------------------

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// 项目根目录：以脚本所在位置向上找一级（脚本位于 <root>/scripts 下）。
// 注意使用 import.meta.url 而非 process.cwd()，保证从任意目录运行都指向项目根。
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');

const env = process.env;
const PAGE_URL = env.PAGE_URL || 'https://api-docs.deepseek.com/zh-cn/updates';
const STATE_FILE = path.resolve(PROJECT_ROOT, env.STATE_FILE || 'last-update.json');
const DRY_RUN = env.DRY_RUN === 'true';                 // 演练模式：只打印不执行副作用
const NOTIFY_ON_FIRST_RUN = env.NOTIFY_ON_FIRST_RUN !== 'false'; // 默认开启首次运行确认

const USER_AGENT = 'Mozilla/5.0 (compatible; deepseek-updates-watcher)';
const FETCH_TIMEOUT_MS = 30000;   // 单次抓取超时
const MAX_FETCH_ATTEMPTS = 3;     // 抓取重试次数
const RETRY_BACKOFF_MS = 2000;    // 重试间隔基数（随次数递增）

// 模型发布检测正则：标题或正文命中任一即视为"新模型发布"
const MODEL_RELEASE_RE = [
  /deepseek-[\w.-]+/i,     // 例如 deepseek-v4-flash / deepseek-chat
  /DeepSeek[-\s]?V\d/i,    // 例如 DeepSeek-V4 / DeepSeek V4 / DeepSeekV4
];

// 通知正文中单条正文的截断长度
const BODY_TRUNCATE = 700;
// Bark 为 GET 请求，受 URL 长度限制，正文截断更短
const BARK_BODY_TRUNCATE = 300;
// Discord 单条消息上限 2000 字符
const DISCORD_MAX_LENGTH = 2000;

// ---------------------------------------------------------------------------
// 小工具函数
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 带时间戳的日志，便于 GitHub Actions 中排查
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
const warn = (msg) => console.warn(`[${new Date().toISOString()}] [警告] ${msg}`);
const error = (msg) => console.error(`[${new Date().toISOString()}] [错误] ${msg}`);

// 截断字符串到指定长度，超出部分加省略号
function truncateBody(text, max) {
  const s = (text || '').trim();
  if (s.length <= max) return s;
  return s.slice(0, max) + '...';
}

// HTML 转义（用于 SMTP 邮件正文、Telegram HTML 模式）
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// 检查 fetch 响应状态，非 2xx 抛出异常
async function checkResponse(res, channel) {
  if (res.ok) return;
  let detail = '';
  try {
    detail = (await res.text()).slice(0, 200);
  } catch {
    /* 忽略响应体读取失败 */
  }
  throw new Error(`${channel} HTTP ${res.status}: ${detail}`);
}

// ---------------------------------------------------------------------------
// 抓取页面（带重试与退避）
// ---------------------------------------------------------------------------

async function fetchPage(url) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      log(`第 ${attempt}/${MAX_FETCH_ATTEMPTS} 次抓取失败：${err.message}`);
      if (attempt < MAX_FETCH_ATTEMPTS) await sleep(RETRY_BACKOFF_MS * attempt);
    }
  }
  throw new Error(`多次抓取页面失败：${lastErr.message}`);
}

// ---------------------------------------------------------------------------
// 状态文件读写
// ---------------------------------------------------------------------------

// 读取状态文件，缺失或损坏时视为首次运行（返回 null）
function loadState(file) {
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    if (state && Array.isArray(state.entries)) return state;
    return null;
  } catch {
    return null;
  }
}

// 内容哈希：对全部条目的「日期+标题」计算 SHA-256。
// 只包含日期与标题 —— 正文变动不触发通知（节省通知渠道配额）；
// 出现新条目（如新模型发布）或已有条目标题被修改时，哈希必然变化。
function computeHash(metaEntries) {
  return createHash('sha256').update(JSON.stringify(metaEntries)).digest('hex');
}

// 原子写入状态：断电或进程被终止时，旧状态文件不会被写到一半。
function writeState(file, state) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporaryFile = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
    renameSync(temporaryFile, file);
  } finally {
    rmSync(temporaryFile, { force: true });
  }
}

// 向 GitHub Actions 输出文件追加键值对（steps.<id>.outputs.X 由此而来）
function appendGithubOutput(lines) {
  if (!env.GITHUB_OUTPUT) return;
  appendFileSync(env.GITHUB_OUTPUT, lines.map((l) => `${l}\n`).join(''), 'utf8');
}

// ---------------------------------------------------------------------------
// 通知内容构建
// ---------------------------------------------------------------------------

// 判断条目是否为"新模型发布"（标题或正文命中正则）
function isModelReleaseItem(item) {
  return MODEL_RELEASE_RE.some((re) => re.test(item.title) || re.test(item.body));
}

// 通知标题：🚀 新模型发布：xxx | 📢 更新日志：xxx
function buildSubject(prefix, newItems) {
  if (newItems.length === 0) return `${prefix}更新日志内容有变化`;
  const first = newItems[0].title;
  const suffix = newItems.length > 1 ? ` 等 ${newItems.length} 条` : '';
  return `${prefix}${first}${suffix}`;
}

// 纯文本通知正文（新条目列表 + 页面链接）
function buildNotificationText(newItems, pageUrl) {
  const lines = [];
  if (newItems.length > 0) {
    lines.push(`DeepSeek API 更新日志检测到 ${newItems.length} 条新内容：`);
    newItems.forEach((item, i) => {
      lines.push('');
      lines.push(`${i + 1}. ${item.date} | ${item.title}`);
      lines.push(truncateBody(item.body, BODY_TRUNCATE));
    });
  } else {
    // 状态有变化但没有全新条目（如已有条目的标题被编辑）的情况
    lines.push('DeepSeek API 更新日志内容有变化，但未识别出全新条目（可能为已有条目被编辑）。');
    lines.push('可打开页面链接查看最新内容。');
  }
  lines.push('');
  lines.push(`页面链接：${pageUrl}`);
  return lines.join('\n');
}

// 首次运行的"监控已启动"确认消息
function buildStartupText(entries, pageUrl) {
  const latest = entries[0] ?? { date: '未知', title: '无' };
  return [
    'DeepSeek API 更新日志监控已启动 🎉',
    '',
    `已记录 ${entries.length} 条历史更新日志。`,
    `最近一条：${latest.date} | ${latest.title}`,
    '',
    '之后将定时检查更新日志页面，发现新条目会立即推送通知。',
    `页面链接：${pageUrl}`,
  ].join('\n');
}

// SMTP 邮件专用 HTML 正文（含日期 / 标题 / 链接 / 正文）
function buildNotificationHtml(newItems, pageUrl) {
  const items = newItems
    .map(
      (item) => `
      <div style="margin:14px 0;padding:14px;border:1px solid #e0e0e0;border-radius:8px;">
        <h3 style="margin:0 0 8px;">${escapeHtml(item.date)} — ${escapeHtml(item.title)}</h3>
        <p style="margin:0;color:#444;white-space:pre-wrap;">${escapeHtml(truncateBody(item.body, BODY_TRUNCATE))}</p>
      </div>`
    )
    .join('');
  const header = newItems.length > 0
    ? `<h2>DeepSeek API 更新日志有新内容（${newItems.length} 条）</h2>`
    : '<h2>DeepSeek API 更新日志内容有变化</h2>';
  return `
  <div style="font-family:-apple-system,'Segoe UI',Roboto,'Microsoft YaHei',sans-serif;max-width:640px;margin:0 auto;color:#222;">
    ${header}
    ${items}
    <p><a href="${escapeHtml(pageUrl)}">打开更新日志页面 →</a></p>
  </div>`;
}

function buildStartupHtml(entries, pageUrl) {
  const latest = entries[0] ?? { date: '未知', title: '无' };
  return `
  <div style="font-family:-apple-system,'Segoe UI',Roboto,'Microsoft YaHei',sans-serif;max-width:640px;margin:0 auto;color:#222;">
    <h2>DeepSeek API 更新日志监控已启动</h2>
    <p>已记录 ${entries.length} 条历史更新日志。</p>
    <p>最近一条：${escapeHtml(latest.date)} — ${escapeHtml(latest.title)}</p>
    <p>之后将定时检查该页面，发现新条目会立即推送通知。</p>
    <p><a href="${escapeHtml(pageUrl)}">打开更新日志页面 →</a></p>
  </div>`;
}

function buildPeriodicText(entries, pageUrl, checkedAt) {
  const latest = entries[0] ?? { date: '未知', title: '无' };
  return [
    'DeepSeek API 更新日志定时状态：暂无新变化。',
    '',
    `本次检测时间：${checkedAt}（UTC+8）`,
    `当前记录：${entries.length} 条`,
    `最近一条：${latest.date} | ${latest.title}`,
    '',
    '监控仍在运行，每 5 分钟检测一次。',
    `页面链接：${pageUrl}`,
  ].join('\n');
}

function buildPeriodicHtml(entries, pageUrl, checkedAt) {
  const latest = entries[0] ?? { date: '未知', title: '无' };
  return `
  <div style="font-family:-apple-system,'Segoe UI',Roboto,'Microsoft YaHei',sans-serif;max-width:640px;margin:0 auto;color:#222;">
    <h2>DeepSeek API 更新日志定时状态</h2>
    <p>暂无新变化，监控仍在运行。</p>
    <p>本次检测时间：${escapeHtml(checkedAt)}（UTC+8）</p>
    <p>当前记录：${entries.length} 条</p>
    <p>最近一条：${escapeHtml(latest.date)} — ${escapeHtml(latest.title)}</p>
    <p><a href="${escapeHtml(pageUrl)}">打开更新日志页面 →</a></p>
  </div>`;
}

// ---------------------------------------------------------------------------
// 通知渠道实现
// 每个渠道返回 true 表示已配置并已发送；返回 false 表示未配置（跳过）；
// 已配置但发送失败则抛出异常，由外层循环 try/catch 隔离。
// ---------------------------------------------------------------------------

// 1) SMTP 邮件（nodemailer）
async function sendSmtp({ subject, text, html }) {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS || !env.MAIL_TO) return false;
  const port = Number(env.SMTP_PORT || '587');
  const secure = env.SMTP_SECURE === 'true'; // SMTP_SECURE=true → 465 SSL
  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
  await transporter.sendMail({
    from: env.SMTP_FROM || env.SMTP_USER,
    to: env.MAIL_TO, // 逗号分隔的多个收件人，nodemailer 原生支持
    subject,
    text,
    html,
  });
  return true;
}

// 2) Server酱（form 表单推送）
async function sendServerChan({ subject, text }) {
  if (!env.SERVERCHAN_SENDKEY) return false;
  const body = new URLSearchParams({ title: subject, desp: text });
  const res = await fetch(`https://sctapi.ftqq.com/${env.SERVERCHAN_SENDKEY}.send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  await checkResponse(res, 'Server酱');
  return true;
}

// 3) PushPlus（JSON + markdown 模板）
async function sendPushPlus({ subject, text }) {
  if (!env.PUSHPLUS_TOKEN) return false;
  const res = await fetch('https://www.pushplus.plus/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: env.PUSHPLUS_TOKEN, title: subject, content: text, template: 'markdown' }),
  });
  await checkResponse(res, 'PushPlus');
  return true;
}

// 4) Telegram（JSON + HTML parse_mode，需 HTML 转义）
async function sendTelegram({ subject, text }) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;
  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: `${escapeHtml(subject)}\n\n${escapeHtml(text)}`,
        parse_mode: 'HTML',
      }),
    }
  );
  await checkResponse(res, 'Telegram');
  return true;
}

// 5) Discord（Webhook JSON，正文截断至 2000 字符）
async function sendDiscord({ text }) {
  if (!env.DISCORD_WEBHOOK) return false;
  const res = await fetch(env.DISCORD_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: truncateBody(text, DISCORD_MAX_LENGTH) }),
  });
  await checkResponse(res, 'Discord');
  return true;
}

// 6) Slack（Webhook JSON { text }）
async function sendSlack({ text }) {
  if (!env.SLACK_WEBHOOK) return false;
  const res = await fetch(env.SLACK_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  await checkResponse(res, 'Slack');
  return true;
}

// 7) ntfy（POST 纯文本 + Title 请求头；NTFY_SERVER 可覆盖默认服务器）
async function sendNtfy({ subject, text }) {
  if (!env.NTFY_TOPIC) return false;
  const base = (env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '');
  const res = await fetch(`${base}/${encodeURIComponent(env.NTFY_TOPIC)}`, {
    method: 'POST',
    headers: { Title: subject, 'Content-Type': 'text/plain; charset=utf-8' },
    body: text,
  });
  await checkResponse(res, 'ntfy');
  return true;
}

// 8) Bark（GET 请求，正文截断至 ~300 字符以避免超长 URL）
async function sendBark({ subject, text }) {
  if (!env.BARK_KEY) return false;
  const url = `https://api.day.app/${encodeURIComponent(env.BARK_KEY)}/${encodeURIComponent(subject)}/${encodeURIComponent(truncateBody(text, BARK_BODY_TRUNCATE))}`;
  const res = await fetch(url);
  await checkResponse(res, 'Bark');
  return true;
}

// 渠道清单（顺序即发送顺序）：envVars 用于"未配置渠道"时的提示信息
const CHANNELS = [
  { name: 'SMTP邮件', envVars: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'MAIL_TO'], send: sendSmtp },
  { name: 'Server酱', envVars: ['SERVERCHAN_SENDKEY'], send: sendServerChan },
  { name: 'PushPlus', envVars: ['PUSHPLUS_TOKEN'], send: sendPushPlus },
  { name: 'Telegram', envVars: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'], send: sendTelegram },
  { name: 'Discord', envVars: ['DISCORD_WEBHOOK'], send: sendDiscord },
  { name: 'Slack', envVars: ['SLACK_WEBHOOK'], send: sendSlack },
  { name: 'ntfy', envVars: ['NTFY_TOPIC'], send: sendNtfy },
  { name: 'Bark', envVars: ['BARK_KEY'], send: sendBark },
];

// 发送到所有已配置渠道；每个渠道独立 try/catch，单点失败不影响其他渠道。
// 返回 { configured, ok }，供调用方判断"全部失败"或"未配置任何渠道"。
async function sendAllChannels(configuredChannels, payload) {
  let configured = 0;
  let ok = 0;
  for (const ch of configuredChannels) {
    try {
      const sent = await ch.send(payload);
      if (!sent) continue; // 未配置，跳过
      configured++;
      ok++;
      log(`[OK] ${ch.name} 通知发送成功`);
    } catch (err) {
      configured++;
      log(`[FAIL] ${ch.name} 通知发送失败：${err.message}`);
    }
  }
  return { configured, ok };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export async function runCheck({ now } = {}) {
  log('DeepSeek API 更新日志监控启动');
  log(`页面：${PAGE_URL}`);
  log(`状态文件：${STATE_FILE}${DRY_RUN ? '（DRY_RUN 演练模式：不发送通知、不写状态、不输出 GITHUB_OUTPUT）' : ''}`);

  // 1. 抓取页面 HTML（失败重试 3 次后直接退出）
  const html = await fetchPage(PAGE_URL);
  log('页面抓取成功');

  // 2. 解析更新条目
  const entries = parseUpdates(html);
  if (entries.length === 0) {
    throw new Error('页面解析结果为空，拒绝更新状态；目标页面结构可能已经变化');
  }
  const latest = entries[0];
  log(`解析到 ${entries.length} 条更新日志${latest ? `，最新：${latest.date} | ${latest.title}` : ''}`);

  // 默认以抓取和解析完成后的时刻作出通知决策；测试可显式注入固定时间。
  const checkedAt = now ?? new Date();

  // 3. 加载状态文件（缺失/损坏 → 首次运行）
  const state = loadState(STATE_FILE);
  const isFirstRun = !state || state.entries.length === 0;
  if (isFirstRun) log('当前为首次运行（状态文件为空或不存在）');

  // 4. 计算内容哈希并对比（哈希 = 全部条目「日期+标题」的 SHA-256）
  const newMeta = entries.map((e) => ({ date: e.date, title: e.title }));
  const newHash = computeHash(newMeta);
  // 兼容旧版状态文件（有 entries 但无 hash 字段）：用旧 entries 现算一个 hash 做迁移比对
  const oldHash = state?.hash ?? (state?.entries?.length ? computeHash(state.entries) : null);
  const changed = newHash !== oldHash;
  const decision = decideNotification({ now: checkedAt, currentHash: newHash, state });
  const oldKeys = new Set(decision.notified.entries.map((e) => `${e.date}|${e.title}`));
  const newItems = entries.filter((e) => !oldKeys.has(`${e.date}|${e.title}`));
  log(`内容哈希：${newHash.slice(0, 12)}… ${changed ? '（与上次检测不同）' : '（与上次检测一致）'}`);
  log(`UTC+8 时间：${decision.localDate} ${decision.localTime}${decision.quiet ? '（静默时段）' : ''}`);

  // 5. 00:00-08:00 仍持续检测并更新 observed snapshot，但绝不发送通知。
  // notified snapshot 保持不变，因此夜间积累的变化会在 08:00 后补发。
  if (decision.quiet) {
    log(decision.changedSinceNotification
      ? '静默时段检测到尚未通知的变化：已暂存，08:00 后补发'
      : '静默时段：本次无待通知变化');
    if (!DRY_RUN) {
      writeState(STATE_FILE, buildNextState({ now: checkedAt, entries: newMeta, hash: newHash, previousState: state, decision }));
      appendGithubOutput(['state_changed=true']);
    }
    return 0;
  }

  // 白天没有变化且当前两小时周期已通知过，只更新健康检查时间。
  if (!decision.shouldNotify) {
    log('无更新，且当前两小时通知已发送：跳过通知');
    if (!DRY_RUN) writeState(STATE_FILE, buildNextState({ now: checkedAt, entries: newMeta, hash: newHash, previousState: state, decision }));
    return 0;
  }

  // 6. 模型发布检测，决定标题前缀
  const isRelease = decision.changedSinceNotification && newItems.some(isModelReleaseItem);
  const prefix = newItems.length > 0 ? (isRelease ? '🚀 新模型发布：' : '📢 更新日志：') : '📢 更新日志：';
  const subject = buildSubject(prefix, newItems);
  const isFirstNotification = decision.notified.hash === null;
  log(decision.changedSinceNotification
    ? `准备发送变化通知：${newItems.length} 条新条目${isFirstNotification ? '（首次通知）' : ''}${isRelease ? '，判定为新模型发布' : ''}`
    : `当前 ${decision.periodicSlot.id} 两小时状态通知尚未发送`);

  // 7. 构建通知内容（首次运行只发"监控已启动"确认消息）
  const payload = isFirstNotification
    ? { subject: '🚀 DeepSeek API 更新日志监控已启动', text: buildStartupText(entries, PAGE_URL), html: buildStartupHtml(entries, PAGE_URL) }
    : decision.changedSinceNotification
      ? { subject, text: buildNotificationText(newItems, PAGE_URL), html: buildNotificationHtml(newItems, PAGE_URL) }
      : {
          subject: 'DeepSeek API 更新日志：定时状态正常',
          text: buildPeriodicText(entries, PAGE_URL, `${decision.localDate} ${decision.localTime}`),
          html: buildPeriodicHtml(entries, PAGE_URL, `${decision.localDate} ${decision.localTime}`),
        };
  // 已配置的渠道：所需环境变量全部非空（GitHub Actions 中未填写的 Secret 为空字符串，同样视为未配置）
  const configuredChannels = CHANNELS.filter((c) => c.envVars.every((v) => env[v]));

  // 8. DRY_RUN：仅打印"将要发生什么"，不产生任何副作用
  if (DRY_RUN) {
    log(`DRY_RUN：将发送${decision.changedSinceNotification ? '变化' : '两小时状态'}通知（标题：${payload.subject}）`);
    log(`DRY_RUN：共 ${configuredChannels.length} 个渠道已配置，实际不发送`);
    for (const ch of configuredChannels) {
      log(`DRY_RUN：  渠道 ${ch.name}（env: ${ch.envVars.join(', ')}）`);
    }
    log(`DRY_RUN：将写入 schemaVersion=2 状态文件（${newMeta.length} 条快照）`);
    log('DRY_RUN 结束：未发送任何通知、未写入状态文件');
    return 0;
  }

  // 9. 发送通知：首次运行且关闭确认消息时跳过
  let notificationCommitted = false;
  let exitCode = 0;
  if (isFirstNotification && !NOTIFY_ON_FIRST_RUN) {
    log('首次运行，且 NOTIFY_ON_FIRST_RUN=false，跳过通知发送');
    notificationCommitted = true;
  } else {
    const { configured, ok } = await sendAllChannels(configuredChannels, payload);

    if (configured === 0) {
      // 没有渠道时保留待通知状态并返回失败，常驻运行器会在下一周期重试。
      warn('未配置任何通知渠道。可配置的渠道及所需环境变量：');
      for (const ch of CHANNELS) warn(`  ${ch.name}：${ch.envVars.join('、')}`);
      warn('请在 .env 中配置至少一个通知渠道；本次不会把待通知变化标记为已发送。');
      exitCode = 1;
    } else if (ok === 0) {
      error(`已配置 ${configured} 个渠道但全部发送失败`);
      exitCode = 1;
    } else {
      notificationCommitted = true;
      if (ok < configured) warn(`${configured} 个已配置渠道中有 ${configured - ok} 个发送失败`);
    }
  }

  // 10. 无论发送成功与否都保存观察快照；只有成功时才推进 notified snapshot。
  writeState(STATE_FILE, buildNextState({
    now: checkedAt,
    entries: newMeta,
    hash: newHash,
    previousState: state,
    decision,
    notificationCommitted,
  }));
  appendGithubOutput([
    'state_changed=true',
    `has_changes=${decision.changedSinceNotification}`,
    `new_release=${isRelease}`,
  ]);
  log(notificationCommitted ? '状态已更新，通知已确认' : '观察状态已更新，待通知状态保留以便下次重试');

  return exitCode;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  runCheck()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      error(`执行失败：${err.message}`);
      process.exitCode = 1;
    });
}
