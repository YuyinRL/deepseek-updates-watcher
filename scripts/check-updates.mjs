/**
 * check-updates.mjs
 *
 * DeepSeek API 更新日志监控 —— 主脚本
 *
 * 工作流程：
 *   1. 抓取更新日志页面 HTML（带重试与超时）
 *   2. 用 parseUpdates() 解析出全部更新条目
 *   3. 读取状态文件，分别对比「最近检测」与「最近已通知」快照
 *   4. 按渠道执行：更新即时通知、邮件两小时状态、微信 18:00 日报
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
import {
  commitChannelDelivery,
  decideChannelNotification,
  getUtc8Schedule,
} from './notification-policy.mjs';

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

function buildDailySummaryText(activities, pageUrl) {
  const lines = ['DeepSeek API 更新日志监控日报', ''];
  for (const activity of activities) {
    lines.push(`日期：${activity.date}（UTC+8）`);
    lines.push(`成功检测：${activity.checks} 次`);
    lines.push(`页面变化：${activity.changes.length} 次`);
    lines.push(`最近条目：${activity.latestEntry?.date ?? '未知'} | ${activity.latestEntry?.title ?? '无'}`);
    if (activity.changes.length === 0) {
      lines.push('结论：当天截至汇总时未检测到更新。');
    } else {
      lines.push('变化明细：');
      for (const change of activity.changes) {
        const titles = change.items.length > 0
          ? change.items.map((item) => `${item.date} | ${item.title}`).join('；')
          : '页面内容发生变化（未识别出新增条目）';
        lines.push(`- ${change.localTime}：${titles}`);
      }
    }
    lines.push('');
  }
  lines.push('监控状态：正常运行，每 5 分钟检测一次。');
  lines.push(`页面链接：${pageUrl}`);
  return lines.join('\n');
}

function buildDailySummaryHtml(activities, pageUrl) {
  const sections = activities.map((activity) => {
    const changes = activity.changes.length === 0
      ? '<p>当天截至汇总时未检测到更新。</p>'
      : `<ul>${activity.changes.map((change) => {
          const titles = change.items.length > 0
            ? change.items.map((item) => `${escapeHtml(item.date)} — ${escapeHtml(item.title)}`).join('；')
            : '页面内容发生变化（未识别出新增条目）';
          return `<li>${escapeHtml(change.localTime)}：${titles}</li>`;
        }).join('')}</ul>`;
    return `
      <section style="margin:16px 0;padding:12px;border:1px solid #e0e0e0;border-radius:8px;">
        <h3 style="margin-top:0;">${escapeHtml(activity.date)}（UTC+8）</h3>
        <p>成功检测：${activity.checks} 次<br>页面变化：${activity.changes.length} 次<br>最近条目：${escapeHtml(activity.latestEntry?.date ?? '未知')} — ${escapeHtml(activity.latestEntry?.title ?? '无')}</p>
        ${changes}
      </section>`;
  }).join('');
  return `
  <div style="font-family:-apple-system,'Segoe UI',Roboto,'Microsoft YaHei',sans-serif;max-width:640px;margin:0 auto;color:#222;">
    <h2>DeepSeek API 更新日志监控日报</h2>
    ${sections}
    <p>监控状态：正常运行，每 5 分钟检测一次。</p>
    <p><a href="${escapeHtml(pageUrl)}">打开更新日志页面 →</a></p>
  </div>`;
}

function appendSummaryToPayload(payload, activities) {
  const summaryText = buildDailySummaryText(activities, PAGE_URL);
  const summaryHtml = buildDailySummaryHtml(activities, PAGE_URL);
  return {
    subject: `${payload.subject}（含 18:00 日报）`,
    text: `${payload.text}\n\n----------------\n\n${summaryText}`,
    html: `${payload.html}<hr>${summaryHtml}`,
  };
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
  { id: 'smtp', kind: 'email', name: 'SMTP邮件', envVars: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'MAIL_TO'], send: sendSmtp },
  { id: 'serverchan', kind: 'wechat', name: 'Server酱', envVars: ['SERVERCHAN_SENDKEY'], send: sendServerChan },
  { id: 'pushplus', kind: 'wechat', name: 'PushPlus', envVars: ['PUSHPLUS_TOKEN'], send: sendPushPlus },
  { id: 'telegram', kind: 'standard', name: 'Telegram', envVars: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'], send: sendTelegram },
  { id: 'discord', kind: 'standard', name: 'Discord', envVars: ['DISCORD_WEBHOOK'], send: sendDiscord },
  { id: 'slack', kind: 'standard', name: 'Slack', envVars: ['SLACK_WEBHOOK'], send: sendSlack },
  { id: 'ntfy', kind: 'standard', name: 'ntfy', envVars: ['NTFY_TOPIC'], send: sendNtfy },
  { id: 'bark', kind: 'standard', name: 'Bark', envVars: ['BARK_KEY'], send: sendBark },
];

function updateDailyActivities({ state, schedule, checkedAt, observedChanged, newItems, entries }) {
  const activities = structuredClone(state?.dailyActivities ?? {});
  const activity = activities[schedule.localDate] ?? {
    date: schedule.localDate,
    checks: 0,
    changes: [],
  };

  activity.checks += 1;
  activity.lastCheckedAt = checkedAt.toISOString();
  activity.latestEntry = entries[0] ?? null;
  activity.entriesCount = entries.length;
  if (observedChanged) {
    activity.changes.push({
      detectedAt: checkedAt.toISOString(),
      localTime: schedule.localTime,
      items: newItems.map((item) => ({ date: item.date, title: item.title })),
    });
  }
  activities[schedule.localDate] = activity;

  // Keep one month of compact summaries for delayed 18:00 delivery and audits.
  const retainedDates = Object.keys(activities).sort().slice(-31);
  return Object.fromEntries(retainedDates.map((date) => [date, activities[date]]));
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

  // 4. 计算观察状态，并记录当天检测和变化，供微信 18:00 日报汇总。
  const newMeta = entries.map((e) => ({ date: e.date, title: e.title }));
  const newHash = computeHash(newMeta);
  const oldHash = state?.hash ?? (state?.entries?.length ? computeHash(state.entries) : null);
  const observedChanged = oldHash !== null && newHash !== oldHash;
  const observedOldKeys = new Set((state?.entries ?? []).map((e) => `${e.date}|${e.title}`));
  const observedNewItems = entries.filter((e) => !observedOldKeys.has(`${e.date}|${e.title}`));
  const schedule = getUtc8Schedule(checkedAt);
  const dailyActivities = updateDailyActivities({
    state,
    schedule,
    checkedAt,
    observedChanged,
    newItems: observedNewItems,
    entries: newMeta,
  });
  log(`内容哈希：${newHash.slice(0, 12)}… ${observedChanged ? '（与上次检测不同）' : '（与上次检测一致）'}`);
  log(`UTC+8 时间：${schedule.localDate} ${schedule.localTime}${schedule.quiet ? '（常规消息静默时段，更新仍会立即发送）' : ''}`);

  // 5. 每个渠道独立判定和提交状态，某个渠道失败不会被其他渠道的成功掩盖。
  const configuredChannels = CHANNELS.filter((c) => c.envVars.every((v) => env[v]));
  const deliveries = structuredClone(state?.deliveries ?? {});
  const activityDates = Object.keys(dailyActivities);
  let exitCode = 0;

  if (configuredChannels.length === 0) {
    warn('未配置任何通知渠道；检测状态会保存，但无法发送通知。');
    if (!DRY_RUN) exitCode = 1;
  }

  for (const channel of configuredChannels) {
    const decision = decideChannelNotification({
      now: checkedAt,
      currentHash: newHash,
      state,
      channel,
      activityDates,
    });
    // Persist migrated per-channel state even when no message is due.
    deliveries[channel.id] = decision.delivery;

    if (!decision.shouldNotify) {
      log(channel.kind === 'wechat'
        ? `${channel.name}：无更新，且今日 18:00 日报无需发送`
        : `${channel.name}：无更新，且当前两小时状态已发送或仍在静默时段`);
      continue;
    }

    const channelOldKeys = new Set(decision.delivery.notifiedEntries.map((e) => `${e.date}|${e.title}`));
    const channelNewItems = entries.filter((e) => !channelOldKeys.has(`${e.date}|${e.title}`));
    const isRelease = decision.changedSinceNotification && channelNewItems.some(isModelReleaseItem);
    const isFirstNotification = decision.delivery.notifiedHash === null;
    let payload;

    if (isFirstNotification) {
      payload = {
        subject: '🚀 DeepSeek API 更新日志监控已启动',
        text: buildStartupText(entries, PAGE_URL),
        html: buildStartupHtml(entries, PAGE_URL),
      };
    } else if (decision.changedSinceNotification) {
      const prefix = channelNewItems.length > 0
        ? (isRelease ? '🚀 新模型发布：' : '📢 更新日志：')
        : '📢 更新日志：';
      payload = {
        subject: buildSubject(prefix, channelNewItems),
        text: buildNotificationText(channelNewItems, PAGE_URL),
        html: buildNotificationHtml(channelNewItems, PAGE_URL),
      };
    } else if (channel.kind === 'wechat') {
      const activities = decision.summaryDates.map((date) => dailyActivities[date]);
      payload = {
        subject: `DeepSeek 监控日报：${decision.summaryDates.at(-1)}`,
        text: buildDailySummaryText(activities, PAGE_URL),
        html: buildDailySummaryHtml(activities, PAGE_URL),
      };
    } else {
      payload = {
        subject: 'DeepSeek API 更新日志：定时状态正常',
        text: buildPeriodicText(entries, PAGE_URL, `${schedule.localDate} ${schedule.localTime}`),
        html: buildPeriodicHtml(entries, PAGE_URL, `${schedule.localDate} ${schedule.localTime}`),
      };
    }

    if (channel.kind === 'wechat' && decision.changedSinceNotification && decision.summaryDue) {
      payload = appendSummaryToPayload(
        payload,
        decision.summaryDates.map((date) => dailyActivities[date]),
      );
    }

    if (DRY_RUN) {
      const reason = decision.changedSinceNotification
        ? '更新即时通知'
        : (channel.kind === 'wechat' ? '18:00 日报' : '两小时状态');
      log(`DRY_RUN：${channel.name} 将发送${reason}（${payload.subject}）`);
      continue;
    }

    if (isFirstNotification && !NOTIFY_ON_FIRST_RUN) {
      log(`${channel.name}：首次运行且 NOTIFY_ON_FIRST_RUN=false，记录基线但不发送`);
      deliveries[channel.id] = commitChannelDelivery({ now: checkedAt, entries: newMeta, hash: newHash, decision });
      continue;
    }

    try {
      const sent = await channel.send(payload);
      if (!sent) throw new Error('渠道配置在发送前变为不可用');
      deliveries[channel.id] = commitChannelDelivery({ now: checkedAt, entries: newMeta, hash: newHash, decision });
      log(`[OK] ${channel.name} 通知发送成功`);
    } catch (err) {
      error(`[FAIL] ${channel.name} 通知发送失败：${err.message}`);
      exitCode = 1;
    }
  }

  if (DRY_RUN) {
    log(`DRY_RUN：将写入 schemaVersion=3 状态文件；实际未发送、未写入`);
    return 0;
  }

  // 6. 保存观察、日报和各渠道独立投递状态。
  writeState(STATE_FILE, {
    schemaVersion: 3,
    checkedAt: checkedAt.toISOString(),
    entries: newMeta,
    hash: newHash,
    dailyActivities,
    deliveries,
  });
  appendGithubOutput([
    'state_changed=true',
    `has_changes=${observedChanged}`,
    `new_release=${observedNewItems.some(isModelReleaseItem)}`,
  ]);
  log(exitCode === 0 ? '观察状态和分渠道通知状态已更新' : '观察状态已更新；失败渠道保留待发送状态供下轮重试');

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
