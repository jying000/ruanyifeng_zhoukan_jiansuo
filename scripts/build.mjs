#!/usr/bin/env node
/**
 * 阮一峰《科技爱好者周刊》检索索引构建脚本
 *
 * 流程：
 *  1. 抓取 ruanyifeng.com 周刊归档页，得到 期号 -> URL 的权威映射（含发布日期）。
 *  2. 过滤出 2023-01 起、且（增量模式下）尚未索引的期号；增量模式下再于抓取后
 *     按「精确发表日期 <= 上一个周五」跳过当周刚发布、未稳定的最新一期。
 *  3. 对每期抓取 GitHub raw Markdown，按「每条资源条目」解析为可搜索条目。
 *  4. 对每期抓取 ruanyifeng.com 页面 HTML，提取栏目锚点（<h2 id>），用于深链定位。
 *  5. 增量合并写入 site/index.json（同时作为浏览器检索数据与增量状态）。
 *
 * 约束（用户需求）：
 *  - 不索引「封面图」栏目。
 *  - 遇到「言论」栏目即停止，不索引「言论」及其后内容（文档信息 / 相关文章 / 留言 / 往年回顾等，历史上命名有过变化）。
 *  - 过滤「@原作者」类条目，不做索引。
 *  - 仅收录日期 >= 2023-01 的期数。
 *  - 日期优先取 ruanyifeng.com 单期页面的精确发表日期，失败回退到归档页年月（日默认 01）。
 *
 * 用法：
 *  node scripts/build.mjs            # 增量构建（仅新增、且发布日期 <= 上一个周五的期号，跳过当周未稳定最新一期）
 *  node scripts/build.mjs --full     # 全量重建（清空后从 2023 起重新索引，不受上一个周五约束）
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SITE_DIR = path.join(ROOT, 'site');
const INDEX_PATH = path.join(SITE_DIR, 'index.json');

const ARCHIVE_URL = 'https://www.ruanyifeng.com/blog/weekly/';
const RAW_MD = (n) => `https://raw.githubusercontent.com/ruanyf/weekly/master/docs/issue-${n}.md`;
const SOURCE = 'ruanyf/weekly';

// 索引起始日期（含）
const MIN_DATE = '2023-01-01';

/**
 * 计算「上一个周五」的日期（ISO，YYYY-MM-DD）。
 * 周刊每周五发布，但作者发布后常会修正出处/链接错误。
 * 为避免拉到当周刚发布、尚未稳定的最新一期，定时任务在周四晚执行，
 * 只拉取上一个周五（及之前）已发布满一周、大概率已修正的周刊。
 * 定义：相对于今天最近过去的那个周五（不含今天，若今天就是周五则取上周五）。
 */
function lastFriday(now = new Date()) {
  // 以本地日期计算（cron 在固定时区运行），转成 YYYY-MM-DD。
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = d.getDay(); // 0=周日 ... 5=周五 ... 6=周六
  // 距离上一个周五的天数：周五(5) -> 7天前；周六(6) -> 1天前；周日(0) -> 2天前；周一(1) -> 3天前 ...
  const offset = day >= 5 ? day - 5 + 7 : day + 2;
  d.setDate(d.getDate() - offset);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// 不索引的栏目 / 终止栏目
const SKIP_SECTIONS = new Set(['封面图', '封面']);
// 遇到「言论」栏目即停止：言论模块之后（文档信息 / 相关文章 / 留言 / 往年回顾等，
// 历史上命名有过变化）一律不索引。
const STOP_SECTIONS = new Set(['言论']);

// 从 ruanyifeng.com 单期页面 HTML 提取精确发表日期（ISO：2026-07-31T08:08:55+08:00）。
function extractPublishedDate(html) {
  const m = html.match(/class="published"[^>]*title="([\d]{4}-[\d]{2}-[\d]{2})/);
  return m ? m[1] : null;
}

const CONCURRENCY = 2;
const RETRY = 4;
const REQUEST_DELAY_MS = 600; // 礼貌抓取间隔，避免触发 ruanyifeng.com 限流（429）

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchText(url, { retries = RETRY } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'ruanyf-weekly-search-bot/1.0 (+github)' },
      });
      if (res.status === 429) throw new Error(`HTTP 429 for ${url}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (i < retries) {
        // 429 限流时退避更久，避免连续冲击。
        const backoff = err.message.includes('429') ? 3000 * (i + 1) : 800 * (i + 1);
        await sleep(backoff);
      }
    }
  }
  throw lastErr;
}

async function runPool(tasks, concurrency = CONCURRENCY) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const cur = idx++;
      try {
        results[cur] = await tasks[cur]();
      } catch (err) {
        results[cur] = { __error: err };
      }
      await sleep(REQUEST_DELAY_MS);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// 1. 归档页映射
// ---------------------------------------------------------------------------
async function fetchIssueMap() {
  const html = await fetchText(ARCHIVE_URL);
  // 匹配形如 /blog/2026/07/weekly-issue-406.html 的链接
  const re = /href=["']([^"']*\/blog\/(\d{4})\/(\d{2})\/weekly-issue-(\d+)\.html)["']/g;
  const map = new Map(); // issueNumber -> { url, date }
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = new URL(m[1], 'https://www.ruanyifeng.com').href;
    const issue = Number(m[4]);
    const date = `${m[2]}-${m[3]}-01`;
    map.set(issue, { url, date });
  }
  return map;
}

// ---------------------------------------------------------------------------
// 2. Markdown 解析为条目
// ---------------------------------------------------------------------------
function stripMdLink(text) {
  // 将 [名称](url) 或 [名称](url "title") 变为 名称
  return text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '$1');
}

function normalizeHeading(text) {
  return stripMdLink(text)
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

const ITEM_LINE = /^\s*\d+[、.．)）]\s*/;

function parseMarkdown(md, issueNumber, issueUrl, date) {
  const lines = md.split(/\r?\n/);
  const items = [];
  let currentSection = null;
  let stopped = false;
  let sectionItemCounter = 0;

  // 提取刊首标题
  let issueTitle = `第 ${issueNumber} 期`;
  const h1 = lines.find((l) => l.startsWith('# '));
  if (h1) issueTitle = stripMdLink(h1.slice(2)).trim();

  let buffer = []; // 当前条目累积行

  function flushItem() {
    if (!buffer.length) return;
    const firstLine = buffer[0].trim();
    const body = buffer.join('\n').trim();
    // 首行提取链接 [名称](url)
    const linkMatch = firstLine.match(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/);
    let itemTitle = stripMdLink(firstLine);
    let itemUrl = null;
    if (linkMatch) {
      itemTitle = linkMatch[1].trim();
      itemUrl = linkMatch[2].trim();
    }
    // 过滤「@原作者」类条目（无实际索引价值）
    if (itemTitle.startsWith('@')) return;
    const snippet = stripMdLink(body)
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // 去掉图片
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);

    items.push({
      id: `${issueNumber}-${normalizeHeading(currentSection)}-${sectionItemCounter}`,
      issueNumber,
      issueTitle,
      issueUrl,
      date,
      section: currentSection,
      anchor: null, // ruanyifeng.com 标题无 id 锚点，深链指向期页面顶部
      itemTitle: itemTitle.slice(0, 120),
      itemUrl,
      snippet,
    });
    sectionItemCounter++;
    buffer = [];
  }

  for (const raw of lines) {
    const line = raw.trimEnd();
    const headingMatch = line.match(/^##\s+(.*)$/);
    if (headingMatch) {
      const headingText = stripMdLink(headingMatch[1]).trim();
      // 切换栏目：先 flush 上一个散文栏目的条目
      if (currentSection !== null) flushItem();

      // 终止判定：遇到「言论」即停止，其后内容（文档信息/相关文章/留言等）不索引
      if (STOP_SECTIONS.has(headingText) || STOP_SECTIONS.has(normalizeHeading(headingText))) {
        stopped = true;
        currentSection = null;
        break;
      }
      if (SKIP_SECTIONS.has(headingText) || SKIP_SECTIONS.has(normalizeHeading(headingText))) {
        currentSection = null;
        continue;
      }
      currentSection = headingText;
      sectionItemCounter = 0;
      buffer = [];
      continue;
    }

    if (stopped) continue;
    if (currentSection === null) continue;

    if (ITEM_LINE.test(line)) {
      flushItem();
      buffer = [line.trim()];
    } else if (line.trim() === '') {
      // 跳过空行（不写入 buffer，避免把空行当作首行）
      continue;
    } else if (buffer.length) {
      // 续行（描述、图片、引用等）
      buffer.push(line.trim());
    } else {
      // 散文栏目（无编号）的首行
      buffer = [line.trim()];
    }
  }
  // 末尾 flush
  if (currentSection !== null && !stopped) flushItem();

  return { issueTitle, items };
}

// ---------------------------------------------------------------------------
// 3. 栏目锚点说明
//    ruanyifeng.com 的标题（<h2>）不带 id 锚点，无法深链到具体栏目。
//    因此深链统一指向该期页面顶部，结果卡片会明确展示「栏目」与条目文本，
//    方便用户快速定位。保留 anchor 字段（恒为 null）以备将来支持。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  const fullRebuild = process.argv.includes('--full');
  await mkdir(SITE_DIR, { recursive: true });

  console.log('[1/4] 抓取归档页映射期号 -> URL ...');
  const issueMap = await fetchIssueMap();
  if (issueMap.size === 0) {
    throw new Error('归档页未解析到任何周刊链接，可能 ruanyifeng.com 已改版。');
  }
  console.log(`      共发现 ${issueMap.size} 期。`);

  // 读取已有索引（增量状态）
  let existing = { meta: null, items: [] };
  if (!fullRebuild && existsSync(INDEX_PATH)) {
    try {
      existing = JSON.parse(await readFile(INDEX_PATH, 'utf8'));
    } catch {
      existing = { meta: null, items: [] };
    }
  }
  const existingSet = new Set(existing.items.map((i) => i.issueNumber));

  // 过滤：日期 >= MIN_DATE 且（增量时）未索引
  const candidates = [...issueMap.entries()]
    .filter(([n, info]) => info.date >= MIN_DATE)
    .filter(([n]) => fullRebuild || !existingSet.has(n))
    .sort((a, b) => a[0] - b[0]);

  console.log(`[2/4] 待处理期数：${candidates.length} 期（${fullRebuild ? '全量重建' : '增量'}）。`);

  // 增量模式：定时任务在周四晚执行。周刊每周五发布，作者随后可能修正出处/链接错误。
  // 因此只拉取「上一个周五」发布的那一期（已发布满一周、大概率已稳定），
  // 既跳过当周周五刚发布、尚未稳定的最新一期，也不重拉更早的历史期。
  // 注意：必须用就绪后的「精确发表日期」判断，归档页年月（日默认 01）不可靠。
  const cutoff = fullRebuild ? null : lastFriday();
  if (cutoff) {
    console.log(`      增量模式：只拉取上一个周五 ${cutoff} 发布的期（其余跳过）。`);
  }

  const newItems = [];
  const tasks = candidates.map(([n, info]) => async () => {
    const [md, html] = await Promise.all([fetchText(RAW_MD(n)), fetchText(info.url)]);
    // 优先用 ruanyifeng.com 的精确发表日期，失败回退到归档页的年月（日默认 01）。
    const exactDate = extractPublishedDate(html);
    const date = exactDate || info.date;
    // 增量模式：只处理「精确发表日期 === 上一个周五」的那一期；其余一律跳过。
    if (cutoff && date !== cutoff) {
      console.log(`      ⊘ 第 ${n} 期（${date}）不是上一个周五 ${cutoff}，跳过。`);
      return [];
    }
    const { issueTitle, items } = parseMarkdown(md, n, info.url, date);
    console.log(`      ✓ 第 ${n} 期：${items.length} 条（${date}）`);
    return items;
  });

  const results = await runPool(tasks, CONCURRENCY);
  for (const r of results) {
    if (r && !r.__error) newItems.push(...r);
    else if (r && r.__error) console.warn(`      ✗ 处理失败：${r.__error.message}`);
  }

  // 合并
  const allItems = fullRebuild ? newItems : [...existing.items, ...newItems];
  // 去除重复（按 id）
  const byId = new Map();
  for (const it of allItems) byId.set(it.id, it);
  const merged = [...byId.values()].sort((a, b) => b.issueNumber - a.issueNumber || a.id.localeCompare(b.id));

  const issueNumbers = [...new Set(merged.map((i) => i.issueNumber))];
  const meta = {
    generatedAt: new Date().toISOString(),
    minIssue: issueNumbers.length ? Math.min(...issueNumbers) : 0,
    maxIssue: issueNumbers.length ? Math.max(...issueNumbers) : 0,
    issueCount: issueNumbers.length,
    itemCount: merged.length,
    source: SOURCE,
  };

  // 增量模式若没有任何新增条目，则不重写 index.json（避免 generatedAt 时间戳刷新、
  // 被 auto-update.sh 的 git diff 误判为变化而空提交）。
  if (!fullRebuild && newItems.length === 0) {
    console.log(`[3/4] 增量模式无新增条目，跳过写出 index.json（共 ${merged.length} 条，覆盖 ${issueNumbers.length} 期）。`);
    console.log('[4/4] 完成。');
    return;
  }

  console.log(`[3/4] 写出 index.json：共 ${merged.length} 条，覆盖 ${issueNumbers.length} 期。`);
  await writeFile(INDEX_PATH, JSON.stringify({ meta, items: merged }, null, 0));

  console.log('[4/4] 完成。');
}

main().catch((err) => {
  console.error('构建失败：', err);
  process.exit(1);
});
