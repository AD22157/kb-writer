import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.mjs';
import { deepseekKey } from './providers.mjs';
import { feishuRead } from './larkRead.mjs';

// DeepSeek 也能调研：后端 agentic 工具循环。
//   DeepSeek 支持 function-calling → 后端把工具定义发给它 → 它只发"工具调用意图" →
//   **后端替它执行**（可信 node 代码，边界写死）→ 结果喂回 → 循环到出结论。
//
// 固定安全工具集（后端亲手实现，边界写死）：
//   · kb_read      只读 kb/entities + kb/dimensions（NFC 逐段解析，拒 ..、拒库外路径）
//   · web_search   网页搜索（固定搜索源，只发查询词、收摘要片段）
//   · web_fetch    GET-only + 域名白名单 = CONFIG.RESEARCH_DOMAINS（与 claude research 档同一份，跳转也须在白名单内）
//   · reddit       arctic-shift 存档 API（QS-reddit 的 URL 规律；reddit.com 直连不通）
//   · feishu_read  只读飞书/Lark 链接（走 lark-cli 用户身份；host 白名单 + 只读子命令 + 清 OPENCLAW_* env，
//                  实现见 larkRead.mjs）。web_fetch 读不了飞书（要鉴权、非可 GET 的网页），这条补上。
// 不给 write、不给 shell、不给任意 URL。DeepSeek 全程碰不到 OS——提示注入至多让它调白名单内工具，无外泄口。
//
// TODO(model-agnostic)：让 opus/fable 与 deepseek-批改/补写（无工具的直连补全）也能读飞书链接，正解是在
//   contextAssembler 装配上下文时把草稿/选段里的飞书链接内联成快照。那要动 contextAssembler/server（本次并行 agent 在改），
//   本次先只把 DeepSeek 工具循环这条修透。

const nfc = (s) => String(s).normalize('NFC');

// ---------------- 工具实现（可信后端执行；返回字符串直接作为 tool 消息） ----------------

const KB_READ_ROOTS = ['entities', 'dimensions'];
const KB_READ_LIMIT = 28000;

export function toolKbRead({ path: rel } = {}) {
  const raw = nfc(String(rel || '')).replace(/^\/+/, '').replace(/\/+$/, '').trim();
  const segs = raw.split('/').filter(Boolean);
  if (!segs.length || segs.some((x) => x === '..' || x === '.')) return '错误：path 需为 entities/ 或 dimensions/ 下的相对路径（如 entities/_index.md、entities/公司/安克.md、dimensions/）';
  if (!KB_READ_ROOTS.includes(segs[0])) return `拒绝：kb_read 只读 ${KB_READ_ROOTS.join('/ 与 ')}/（收到 ${segs[0]}/）`;
  // 逐段 NFC 匹配磁盘真实名（NAS 中文名是 NFD，绝不直接拼路径）
  let cur = CONFIG.KB_ROOT;
  for (const seg of segs) {
    let entries;
    try { entries = fs.readdirSync(cur); } catch { return `错误：${raw} 上级目录不可读`; }
    const hit = entries.find((e) => nfc(e) === seg) || entries.find((e) => nfc(e).toLowerCase() === seg.toLowerCase());
    if (!hit) return `错误：找不到 ${raw}（「${seg}」不存在。可先 kb_read 上级目录列文件，或读 entities/_index.md 查别名表）`;
    cur = path.join(cur, hit);
  }
  try {
    // 防符号链逃逸：真实路径必须仍在库内
    const real = fs.realpathSync(cur);
    if (!nfc(real).startsWith(nfc(fs.realpathSync(CONFIG.KB_ROOT) + path.sep))) return '拒绝：目标在知识库之外';
    const st = fs.statSync(real);
    if (st.isDirectory()) return `目录 ${raw}/ 下：\n` + fs.readdirSync(real).map((f) => nfc(f)).join('\n');
    const text = fs.readFileSync(real, 'utf8');
    return text.length > KB_READ_LIMIT ? text.slice(0, KB_READ_LIMIT) + `\n…（已截断，全文共 ${text.length} 字符）` : text;
  } catch (e) { return `错误：读取失败 ${String(e.message || e)}`; }
}

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function hostAllowed(host) {
  const h = String(host || '').toLowerCase();
  return CONFIG.RESEARCH_DOMAINS.some((d) => h === d.toLowerCase() || h.endsWith('.' + d.toLowerCase()));
}

const FETCH_LIMIT = 20000;

export async function toolWebFetch({ url } = {}, signal) {
  let u;
  try { u = new URL(String(url || '')); } catch { return '错误：URL 不合法'; }
  if (!/^https?:$/.test(u.protocol)) return '错误：只允许 http(s)';
  if (!hostAllowed(u.hostname)) return `拒绝：${u.hostname} 不在研究档域名白名单（RESEARCH_DOMAINS）内，不要再试这个域。白名单：${CONFIG.RESEARCH_DOMAINS.join(', ')}`;
  // GET-only；重定向手动跟，目标域也必须在白名单（防白名单域 302 跳出去）
  let cur = u;
  for (let i = 0; i < 4; i++) {
    const res = await fetch(cur, { method: 'GET', redirect: 'manual', signal, headers: { 'user-agent': 'kb-writer-research/1.0', accept: 'text/html,application/json,text/plain,*/*' } });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return `错误：HTTP ${res.status} 无 Location`;
      const nu = new URL(loc, cur);
      if (!hostAllowed(nu.hostname)) return `拒绝：跳转目标 ${nu.hostname} 不在白名单，中止`;
      cur = nu; continue;
    }
    if (!res.ok) return `错误：HTTP ${res.status}（${cur.hostname}）`;
    const ct = res.headers.get('content-type') || '';
    const body = await res.text();
    const text = /html/i.test(ct) ? htmlToText(body) : body;
    return text.length > FETCH_LIMIT ? text.slice(0, FETCH_LIMIT) + '\n…（已截断）' : text;
  }
  return '错误：重定向过多';
}

export async function toolWebSearch({ query, count } = {}, signal) {
  const q = String(query || '').trim();
  if (!q) return '错误：缺少 query';
  const n = Math.min(Math.max(Number(count) || 8, 1), 10);
  // 固定搜索源（Bing HTML，免 key；DDG 本网络不通）：只发查询词出去、收标题/URL/摘要片段回来。
  const res = await fetch('https://www.bing.com/search?q=' + encodeURIComponent(q) + '&count=' + n, {
    signal, redirect: 'follow',
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      accept: 'text/html', 'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.5',
    },
  });
  if (!res.ok) return `错误：搜索源 HTTP ${res.status}（稍后再试，或改用 reddit / web_fetch 白名单源 / kb_read）`;
  const html = await res.text();
  const out = [];
  for (const block of html.match(/<li class="b_algo"[\s\S]{0,4000}?<\/li>/g) || []) {
    const a = block.match(/<h2[^>]*>\s*<a[^>]*href="(http[^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    out.push({ title: htmlToText(a[2]).slice(0, 140), url: a[1], snippet: htmlToText(p ? p[1] : '').slice(0, 300) });
    if (out.length >= n) break;
  }
  if (!out.length) return '搜索无结果（或搜索源结构变化/暂不可用）。换个关键词，或改用 reddit / web_fetch 白名单源。';
  return JSON.stringify(out, null, 1);
}

const ARCTIC = 'https://arctic-shift.photon-reddit.com/api';
const isoDay = (t) => (t ? new Date(t * 1000).toISOString().slice(0, 10) : '');

export async function toolReddit(args = {}, signal) {
  const op = String(args.op || 'search_posts');
  const limit = Math.min(Math.max(Number(args.limit) || 15, 1), 25);
  const q = new URLSearchParams();
  let url;
  if (op === 'search_posts') {
    // arctic-shift 规则：query/title 必须搭配 subreddit（或 author）；全站关键词搜走 search_comments。
    if (args.query && !args.subreddit) return '错误：search_posts 的 query 必须搭配 subreddit（如 NewParents、beyondthebump、Mommit）；要全站关键词搜请改用 search_comments（body 全站可搜）';
    url = `${ARCTIC}/posts/search`;
    if (args.subreddit) q.set('subreddit', String(args.subreddit).replace(/^r\//, ''));
    if (args.query) q.set('query', String(args.query));
    if (args.after) q.set('after', String(args.after));
  } else if (op === 'search_comments') {
    // arctic-shift 现行规则（2026-09 实测）：body 关键词也必须搭配 subreddit/author/link_id，没有全站搜。
    if (args.query && !args.subreddit && !args.link_id) return '错误：search_comments 的 query 也必须搭配 subreddit（arctic-shift 不支持全站关键词搜）。常用母婴 subreddit：NewParents、beyondthebump、Mommit、BabyBumps、breastfeeding、daddit；逐个搜。';
    url = `${ARCTIC}/comments/search`;
    if (args.subreddit) q.set('subreddit', String(args.subreddit).replace(/^r\//, ''));
    if (args.link_id) q.set('link_id', String(args.link_id).startsWith('t3_') ? String(args.link_id) : 't3_' + args.link_id);
    if (args.query) q.set('body', String(args.query));      // 评论搜的是 body=
    if (args.after) q.set('after', String(args.after));
  } else if (op === 'post_comments') {
    if (!args.link_id) return '错误：post_comments 需要 link_id（帖子 id，如 abc123 或 t3_abc123）';
    url = `${ARCTIC}/comments/search`;
    q.set('link_id', String(args.link_id).startsWith('t3_') ? String(args.link_id) : 't3_' + args.link_id);
  } else return '错误：op 须为 search_posts / search_comments / post_comments';
  q.set('limit', String(limit));
  const res = await fetch(`${url}?${q}`, { signal, headers: { 'user-agent': 'kb-writer-research/1.0' } });
  if (res.status === 422) return 'arctic-shift 限流（422 Timeout, maybe slow down）：这是限流不是失败——等几秒再试，或缩小时间范围/换关键词';
  if (!res.ok) return `错误：arctic-shift HTTP ${res.status}`;
  let j; try { j = await res.json(); } catch { return '错误：arctic-shift 返回非 JSON'; }
  const rows = (j.data || []).map((d) => (op === 'search_posts'
    ? { title: d.title, sub: d.subreddit, date: isoDay(d.created_utc), score: d.score, comments: d.num_comments, author: d.author, id: d.id, url: `https://www.reddit.com${d.permalink || `/r/${d.subreddit}/comments/${d.id}/`}`, text: String(d.selftext || '').slice(0, 500) }
    : { body: String(d.body || '').slice(0, 800), sub: d.subreddit, date: isoDay(d.created_utc), score: d.score, author: d.author, link_id: d.link_id }));
  return rows.length ? JSON.stringify(rows, null, 1) : '0 条命中（arctic-shift 是存档，覆盖度≠热度）。放宽关键词、去掉 subreddit 或拉长时间范围再试。';
}

// ---------------- 工具定义（发给 DeepSeek 的 function-calling schema） ----------------

export const DS_TOOLS = [
  { type: 'function', function: { name: 'kb_read', description: '只读 339 知识库：entities/（L2 事实页，每行带日期与 src，是核查 ground truth）与 dimensions/（L3 主人裁定的理解）。传相对路径；传目录路径则列出其中文件。先读 entities/_index.md 查别名表定位实体。', parameters: { type: 'object', properties: { path: { type: 'string', description: '相对路径，如 "entities/_index.md"、"entities/公司/安克.md"、"dimensions/"' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'web_search', description: '网页搜索，返回 [{title,url,snippet}]。适合先找线索，再用 web_fetch 读白名单内的原文。', parameters: { type: 'object', properties: { query: { type: 'string' }, count: { type: 'number', description: '结果数，默认 8，最多 10' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'web_fetch', description: '抓取一个网页正文（GET-only）。只允许研究档域名白名单，白名单外会被拒绝——被拒后不要对同一个域反复试，换源。', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'reddit', description: 'Reddit 检索（走 arctic-shift 存档 API；reddit.com 直连不通，一律用本工具）。op=search_posts 搜帖 / search_comments 搜评论 / post_comments 取某帖全部评论。关键词搜索必须搭配 subreddit（无全站搜），母婴常用：NewParents、beyondthebump、Mommit、BabyBumps、breastfeeding、daddit——逐个搜。', parameters: { type: 'object', properties: { op: { type: 'string', enum: ['search_posts', 'search_comments', 'post_comments'] }, subreddit: { type: 'string', description: '必填（除 post_comments）。如 NewParents、beyondthebump、Mommit' }, query: { type: 'string', description: '关键词' }, link_id: { type: 'string', description: 'post_comments 用：帖子 id' }, after: { type: 'string', description: 'YYYY-MM-DD 起始日期' }, limit: { type: 'number', description: '默认 15，最多 25' } }, required: ['op'] } } },
  { type: 'function', function: { name: 'feishu_read', description: '读取一个飞书/Lark 链接的内容当作上下文（只读，走已授权的用户身份）。**只要任务/草稿正文/选段/上下文里出现飞书链接（feishu.cn / larksuite.com），先用本工具把它读进来再作答，绝不回避说“链接内容未提供”。** 支持：drive 文件夹（会列出整个目录清单并展开读前若干篇 docx/表格）、docx/wiki 文档、电子表格。文件夹很大时只展开前 N 篇；要读其中某一篇的全文，就对那篇文档自己的飞书链接再调一次本工具。多个链接逐个读。', parameters: { type: 'object', properties: { url: { type: 'string', description: '完整飞书链接，如 https://xxx.feishu.cn/drive/folder/<token> 或 /docx/<token> 或 /sheets/<token>' }, max_docs: { type: 'number', description: '文件夹模式最多展开几篇文档，默认 8，最多 20' } }, required: ['url'] } } },
];

async function execTool(name, args, deadline) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('tool 超时')), Math.min(45000, Math.max(deadline - Date.now(), 1000)));
  try {
    if (name === 'kb_read') return toolKbRead(args);
    if (name === 'web_search') return await toolWebSearch(args, ctrl.signal);
    if (name === 'web_fetch') return await toolWebFetch(args, ctrl.signal);
    if (name === 'reddit') return await toolReddit(args, ctrl.signal);
    if (name === 'feishu_read') return await feishuRead(args, ctrl.signal);
    return `错误：未知工具 ${name}（只有 kb_read / web_search / web_fetch / reddit / feishu_read）`;
  } catch (e) {
    return `工具执行失败：${String(e.message || e)}`;
  } finally { clearTimeout(t); }
}

// ---------------- 工具循环 ----------------

// 单轮流式请求（OpenAI 兼容 SSE，tool_calls 按 index 拼装）。
async function streamRound(key, model, messages, leftMs, onDelta, useTools) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(new Error('deepseek 单轮超时')), leftMs);
  try {
    const res = await fetch(`${CONFIG.DEEPSEEK_BASE}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model, messages, stream: true, stream_options: { include_usage: true },
        ...(useTools ? { tools: DS_TOOLS } : {}),
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`deepseek HTTP ${res.status}：${body.slice(0, 300)}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', content = '', usage = null;
    const calls = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let j; try { j = JSON.parse(payload); } catch { continue; }
        const ch = j.choices?.[0];
        if (ch?.delta?.content) { content += ch.delta.content; try { onDelta?.(ch.delta.content); } catch { /* client 断开 */ } }
        for (const tc of ch?.delta?.tool_calls || []) {
          const k = tc.index ?? 0;
          if (!calls[k]) calls[k] = { id: tc.id || `call_${k}`, type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) calls[k].id = tc.id;
          if (tc.function?.name) calls[k].function.name += tc.function.name;
          if (tc.function?.arguments) calls[k].function.arguments += tc.function.arguments;
        }
        if (j.usage) usage = j.usage;
      }
    }
    return { content, toolCalls: calls.filter(Boolean), usage };
  } finally { clearTimeout(to); }
}

// research + deepseek 的入口：循环「模型发调用意图 → 后端执行 → 喂回」直到它输出结论。
// onDelta(text) 流式正文；onTool(name) 面板可追溯；resolve { text, usage, cost:0 }。
export async function runDeepseekResearch(modelId, { system, user }, onDelta, onTool, { timeoutMs } = {}) {
  const key = deepseekKey();
  if (!key) throw new Error(`DeepSeek key 未找到（查 ${CONFIG.DEEPSEEK_KEY_FILE} 或设 DEEPSEEK_API_KEY）`);
  const deadline = Date.now() + (timeoutMs || CONFIG.TASK_TIMEOUT_RESEARCH_MS);
  const messages = [
    ...(system ? [{ role: 'system', content: system }] : []),
    { role: 'user', content: user },
  ];
  let text = '', usage = null;
  for (let round = 0; round < CONFIG.DS_MAX_TOOL_ROUNDS; round++) {
    const left = deadline - Date.now();
    if (left < 8000) throw new Error('调研超时（deepseek 工具循环）');
    const r = await streamRound(key, modelId, messages, left, onDelta, true);
    if (r.usage) usage = r.usage;
    if (r.content) text += r.content;
    if (!r.toolCalls.length) {
      if (!text.trim()) throw new Error('deepseek 返回为空');
      return { text, usage, cost: 0 };
    }
    messages.push({ role: 'assistant', content: r.content || null, tool_calls: r.toolCalls });
    for (const tc of r.toolCalls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* 传空 → 工具自己报参数错 */ }
      try { onTool?.(tc.function.name); } catch { /* noop */ }
      const result = await execTool(tc.function.name, args, deadline);
      console.error(`[ds-research] ${tc.function.name}(${(tc.function.arguments || '').slice(0, 160)}) → ${String(result).length} chars`);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: String(result).slice(0, 24000) });
    }
  }
  // 轮数打满：不再给工具，逼它基于已获素材收尾。
  messages.push({ role: 'user', content: '工具轮数已达上限。请立即基于已获素材输出调研小结（每条事实带出处），不要再调工具。' });
  const fin = await streamRound(key, modelId, messages, Math.max(deadline - Date.now(), 8000), onDelta, false);
  const finText = text + fin.content;
  if (!finText.trim()) throw new Error('deepseek 返回为空（工具轮数打满后仍无结论）');
  return { text: finText, usage: fin.usage || usage, cost: 0 };
}
