import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

// 只读飞书阅读器：给 DeepSeek 工具循环用的 feishu_read(url) 底座。
//
// 为什么要它：web_fetch 走裸 GET + RESEARCH_DOMAINS 白名单，读不了飞书——飞书要鉴权，
// 且 /drive/folder/ 不是一个可 GET 的网页。于是模型只能说"链接内容未提供"。
// 这里用 lark-cli 的**用户身份**（阿峰已 OAuth 授权）只读地把飞书链接读进来当上下文。
//
// 安全不变式（务必保持——DeepSeek 全程碰不到 OS）：
//   · 只读：只 spawn lark-cli 的读子命令（docs +fetch / drive files list / sheets +workbook-info|+csv-get），
//     白名单写死在 ALLOWED_PREFIXES，绝不 +update/+create/+delete/写任何飞书。
//   · host 白名单：url 必须是 *.feishu.cn / *.larksuite.com，否则拒绝（防被诱导读任意地址）。
//   · 无 shell 注入：spawn 用 args 数组（不经 shell）；模型只能给 url，token 从 url 解析并做字符集校验后
//     作为独立 argv 传，不拼接、不可能变成 flag 注入。
//   · 清 env：kb-writer 若带 OPENCLAW_* 会打死 lark-cli 的用户身份（回退/拒用个人身份，静默读不到）。
//     spawn 前清掉整族 OPENCLAW_* + 还原被 openclaw 改过的 TMPDIR。见记忆 ref_openclaw_cron_env_lark。
//
// model-agnostic 上下文层内联（已落地）：contextAssembler 装配上下文时就扫草稿正文/选段里的飞书链接、
//   调本模块 feishuRead 内联成快照（连"无工具的直连补全"deepseek 路径也能读到）。见 contextAssembler.mjs 的
//   scanAutoFeishu/assembleContext；本模块另导出 classifyFeishuUrl 给它判类型（note-only 与否）。

const LARK_BIN = process.env.KB_WRITER_LARK_BIN || 'lark-cli';

// ---- host 白名单 ----
const FEISHU_HOSTS = ['feishu.cn', 'larksuite.com'];
function hostOk(host) {
  const h = String(host || '').toLowerCase();
  return FEISHU_HOSTS.some((d) => h === d || h.endsWith('.' + d));
}

// ---- 清 env（去 OPENCLAW_* 一族 + 还原 TMPDIR），保住 lark-cli 的用户身份 ----
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('OPENCLAW_')) delete env[k];
  const openclawTmp = path.join(os.homedir(), '.openclaw', 'tmp');
  if (env.TMPDIR && env.TMPDIR.replace(/\/+$/, '') === openclawTmp) env.TMPDIR = '/tmp';
  return env;
}

// ---- 只读子命令白名单（belt-and-suspenders：args 全由本模块内部构造，这里再兜一层） ----
const ALLOWED_PREFIXES = [
  ['docs', '+fetch'],
  ['drive', 'files', 'list'],
  ['sheets', '+workbook-info'],
  ['sheets', '+csv-get'],
];
function assertReadVerb(args) {
  const ok = ALLOWED_PREFIXES.some((p) => p.every((tok, i) => args[i] === tok));
  if (!ok) throw new Error(`内部错误：拒绝非只读 lark 子命令「${args.slice(0, 3).join(' ')}」`);
}

// token/id 字符集校验：飞书 token 是字母数字（可含 _ -）。杜绝以 -- 开头被当 flag，或塞入奇怪字符。
const isToken = (s) => /^[A-Za-z0-9_-]{4,80}$/.test(String(s || ''));
const isSheetId = (s) => /^[A-Za-z0-9_-]{2,40}$/.test(String(s || ''));

// ---- 安全 spawn（数组参数，不经 shell；超时/体积/中断都能杀） ----
function runLark(args, { timeoutMs = 18000, signal } = {}) {
  assertReadVerb(args);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(LARK_BIN, args, { env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return reject(new Error(`lark-cli 无法启动：${e.message}`)); }
    let out = '', err = '', killed = false;
    const kill = (why) => { killed = true; try { child.kill('SIGKILL'); } catch { /* noop */ } reject(new Error(why)); };
    const timer = setTimeout(() => kill('lark-cli 超时'), timeoutMs);
    const onAbort = () => kill('lark-cli 被中止');
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    child.stdout.on('data', (d) => { out += d; if (out.length > 8_000_000) kill('lark-cli 输出过大'); });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); if (!killed) reject(new Error(`lark-cli 启动失败：${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener?.('abort', onAbort);
      if (killed) return;
      resolve({ code, out, err });
    });
  });
}

// 跑一条读命令并解析 JSON；ok:false / 非 0 退出都转成可读错误串（不抛，交由上层拼进结果）。
async function larkJson(args, opts) {
  const { code, out, err } = await runLark(args, opts);
  let j;
  try { j = JSON.parse(out); } catch {
    if (code !== 0) throw new Error(`lark-cli 退出码 ${code}：${(err || out).slice(0, 200)}`);
    throw new Error(`lark-cli 返回非 JSON：${(out || err).slice(0, 200)}`);
  }
  if (j && j.ok === false) {
    const msg = j.error?.msg || j.error?.message || j.msg || JSON.stringify(j.error || {}).slice(0, 200);
    throw new Error(`飞书返回失败：${msg}`);
  }
  return j;
}

// ---- URL 解析 → {type, token} ----
// 路径规律：/drive/folder/<t>、/docx/<t>、/docs|/doc/<t>、/wiki/<t>、/sheets/<t>、
//           /base|/bitable/<t>、/slides/<t>、/file 或 /drive/file/<t>、/minutes/<t>、/wiki 里的 base…
function parseFeishuUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return { error: 'URL 不合法；feishu_read 需要一个完整的飞书链接（http(s)://…feishu.cn/…）' }; }
  if (!/^https?:$/.test(u.protocol)) return { error: '只允许 http(s) 的飞书链接' };
  if (!hostOk(u.hostname)) return { error: `拒绝：${u.hostname} 不是飞书域名（只允许 *.feishu.cn / *.larksuite.com）` };
  const segs = u.pathname.split('/').filter(Boolean);
  // 找 "<kind>/<token>" 形态
  // 注：query（?from=copylink…）与 #anchor 天然不进 u.pathname，故各类"复制链接"形态都能认。
  const KIND = {
    folder: 'folder', docx: 'docx', docs: 'doc', doc: 'doc', wiki: 'wiki',
    sheets: 'sheet', sheet: 'sheet', base: 'base', bitable: 'base', slides: 'slides',
    file: 'file', minutes: 'minutes', mindnote: 'docx',
  };
  for (let i = segs.length - 2; i >= 0; i--) {
    const kind = KIND[segs[i]];
    if (kind && isToken(segs[i + 1])) return { type: kind, token: segs[i + 1], url: raw };
  }
  // /drive/folder/<t> 已被上面覆盖；/drive/<t> 兜底当 folder? 不猜——报无法识别。
  return { error: `无法从链接识别飞书资源类型（支持 docx/wiki/sheets/drive folder 等）：${u.pathname}` };
}

// ---- 逐类型只读 ----
const colLetter = (n) => { let s = ''; let x = Math.max(1, n); while (x > 0) { const r = (x - 1) % 26; s = String.fromCharCode(65 + r) + s; x = Math.floor((x - 1) / 26); } return s; };

async function readDocContent(token, maxChars, opts) {
  const j = await larkJson(['docs', '+fetch', '--doc', token, '--doc-format', 'markdown', '--detail', 'simple', '--format', 'json'], opts);
  const content = String(j?.data?.document?.content || '').trim();
  if (!content) return '（文档为空或无正文）';
  return content.length > maxChars ? content.slice(0, maxChars) + `\n…（已截断，全文约 ${content.length} 字，需要全文可单独对该文档链接调 feishu_read）` : content;
}

async function readSheetContent(token, maxChars, opts) {
  const wb = await larkJson(['sheets', '+workbook-info', '--spreadsheet-token', token, '--format', 'json'], opts);
  const sheets = (wb?.data?.sheets || []).filter((s) => !s.is_hidden);
  if (!sheets.length) return '（空表格或全部子表隐藏）';
  const parts = [];
  let budget = maxChars;
  for (const s of sheets.slice(0, 3)) {
    if (budget < 400 || opts?.signal?.aborted) break;
    if (!isSheetId(s.sheet_id)) continue;
    const cols = Math.min(Number(s.column_count) || 12, 12);
    const rows = Math.min(Number(s.row_count) || 40, 40);
    const range = `A1:${colLetter(cols)}${rows}`;
    try {
      const cg = await larkJson(['sheets', '+csv-get', '--spreadsheet-token', token, '--sheet-id', s.sheet_id, '--range', range,
        '--include-row-prefix=false', '--max-chars', String(Math.min(budget, 6000)), '--format', 'json'], opts);
      const csv = String(cg?.data?.annotated_csv || cg?.data?.csv || '').trim();
      const chunk = `【子表 ${s.sheet_name || s.sheet_id}｜读取范围 ${range}（表实际 ${s.row_count}行×${s.column_count}列）】\n${csv || '（该范围为空）'}`;
      parts.push(chunk.slice(0, budget));
      budget -= chunk.length;
    } catch (e) { parts.push(`【子表 ${s.sheet_name || s.sheet_id}】读取失败：${String(e.message || e)}`); }
  }
  const extra = sheets.length > 3 ? `\n（还有 ${sheets.length - 3} 个子表未展开）` : '';
  return parts.join('\n\n') + extra;
}

// note-only 类型（不展开全文，只在清单里标出，让模型知道存在）
const NOTE_ONLY = new Set(['slides', 'base', 'file', 'minutes', 'shortcut']);
const TYPE_CN = { docx: 'docx文档', doc: 'doc文档', wiki: 'wiki文档', sheet: '电子表格', slides: '幻灯片', base: '多维表格', file: '文件', folder: '文件夹', minutes: '妙记', shortcut: '快捷方式' };

// 读单个资源（非 folder）：docx/wiki/doc → 全文；sheet → 表格；其余 → note-only
async function readOne(type, token, maxChars, opts) {
  if (type === 'docx' || type === 'doc' || type === 'wiki') return readDocContent(token, maxChars, opts);
  if (type === 'sheet') return readSheetContent(token, maxChars, opts);
  return `（类型 ${TYPE_CN[type] || type} 暂不展开全文——feishu_read 目前只全文读 docx/wiki 文档与电子表格。token=${token}）`;
}

// ---- 文件夹递归（有界：深度 + 篇数 + 总字数 + 墙钟） ----
async function listFolder(token, opts) {
  const files = [];
  let pageToken = '';
  for (let guard = 0; guard < 20; guard++) {
    const params = { folder_token: token, page_size: 200 };
    if (pageToken) params.page_token = pageToken;
    const j = await larkJson(['drive', 'files', 'list', '--params', JSON.stringify(params), '--format', 'json'], opts);
    for (const f of j?.data?.files || []) files.push(f);
    if (j?.data?.has_more && j?.data?.next_page_token) pageToken = j.data.next_page_token; else break;
  }
  return files;
}

// 把 drive files.list 的 type 归一到我们的 type
function normType(t) {
  const m = { folder: 'folder', docx: 'docx', doc: 'doc', sheet: 'sheet', bitable: 'base', slides: 'slides', mindnote: 'docx', file: 'file', shortcut: 'shortcut' };
  return m[t] || t;
}

async function readFolder(rootToken, { maxDocs, maxCharsPerDoc, totalBudget, maxDepth, deadline }, signal) {
  const opts = { signal, timeoutMs: 15000 };
  const manifest = [];          // {type, name, tokPath, token, readable}
  const readQueue = [];         // readable leaves in traversal order
  // BFS，带相对路径
  let frontier = [{ token: rootToken, prefix: '' }];
  for (let depth = 0; depth <= maxDepth && frontier.length; depth++) {
    const next = [];
    for (const node of frontier) {
      if (signal?.aborted || Date.now() > deadline) break;
      let files;
      try { files = await listFolder(node.token, opts); }
      catch (e) { manifest.push({ type: 'folder', name: `${node.prefix || '(根)'}（列目录失败：${String(e.message || e)}）`, readable: false }); continue; }
      for (const f of files) {
        const type = normType(f.type);
        const name = `${node.prefix}${f.name || '(无名)'}`;
        const readable = (type === 'docx' || type === 'doc' || type === 'wiki' || type === 'sheet') && isToken(f.token);
        manifest.push({ type, name, token: f.token, url: f.url || '', readable });
        if (type === 'folder' && isToken(f.token) && depth < maxDepth) next.push({ token: f.token, prefix: `${name}/` });
        if (readable) readQueue.push({ type, token: f.token, name });
      }
    }
    frontier = next;
  }

  // 展开读前 maxDocs 篇，受 totalBudget 与 deadline 约束
  const read = [];
  let used = 0;
  for (const item of readQueue) {
    if (read.length >= maxDocs || used >= totalBudget || signal?.aborted || Date.now() > deadline) break;
    const room = Math.min(maxCharsPerDoc, totalBudget - used);
    let body;
    try { body = await readOne(item.type, item.token, room, opts); }
    catch (e) { body = `（读取失败：${String(e.message || e)}）`; }
    const block = `### [${TYPE_CN[item.type] || item.type}] ${item.name}\n${body}`;
    read.push(block);
    used += block.length;
  }

  // 组织输出：先目录清单（全部项，便于挑选），再已读内容
  const folders = manifest.filter((m) => m.type === 'folder').length;
  const readableCnt = manifest.filter((m) => m.readable).length;
  // 清单里给 可读文档/子文件夹 附上各自链接：模型可据此对某一篇 feishu_read 读全文、或对某子文件夹再展开。
  const listLines = manifest.slice(0, 80).map((m) => {
    const tag = `[${TYPE_CN[m.type] || m.type}] ${m.name}`;
    return (m.url && (m.readable || m.type === 'folder')) ? `${tag} — ${m.url}` : tag;
  });
  let listBlock = listLines.join('\n');
  if (listBlock.length > 7500) listBlock = listBlock.slice(0, 7500) + '\n…（清单过长已截断）';
  const listMore = manifest.length > 80 ? `\n…（另有 ${manifest.length - 80} 项未列出）` : '';
  const unread = readQueue.length - read.length;
  const header = `飞书文件夹：共扫出 ${manifest.length} 项（其中 ${folders} 个子文件夹、${readableCnt} 篇可全文读的文档/表格）。` +
    `已展开读取前 ${read.length} 篇（累计约 ${used} 字）。` +
    (unread > 0 ? `还有 ${unread} 篇可读文档未展开——要读某一篇的全文，用清单里它后面的链接单独再调 feishu_read（每项后的 URL 就是可直接读的链接）。` : '') +
    (signal?.aborted || Date.now() > deadline ? '（注意：因时间预算，读取提前结束，可能未覆盖全部。）' : '');
  return `${header}\n\n── 目录清单（可读项后附其飞书链接，可对某项单独 feishu_read）──\n${listBlock}${listMore}\n\n── 已读内容 ──\n${read.join('\n\n') || '（本文件夹下没有可全文读的 docx/wiki/表格）'}`;
}

// 轻量分类（不出网、不 spawn）：给上下文装配器判正文里飞书链接的类型/是否 note-only/是否可识别。
// 返回 { type, token, typeCn, noteOnly } 或 { error }。
export function classifyFeishuUrl(url) {
  const parsed = parseFeishuUrl(url);
  if (parsed.error) return { error: parsed.error };
  return {
    type: parsed.type,
    token: parsed.token,
    typeCn: TYPE_CN[parsed.type] || parsed.type,
    noteOnly: NOTE_ONLY.has(parsed.type),
  };
}

// ---- 对外入口：feishu_read({url, max_docs, max_chars}, signal) → string ----
export async function feishuRead({ url, max_docs, max_chars } = {}, signal) {
  const parsed = parseFeishuUrl(url);
  if (parsed.error) return `拒绝/无法读取：${parsed.error}`;
  const maxDocs = Math.min(Math.max(Number(max_docs) || 8, 1), 20);
  const singleMaxChars = Math.min(Math.max(Number(max_chars) || 16000, 1000), 20000);
  // 墙钟预算：execTool 给的 signal 最多 45s，这里再留一手内部 deadline 40s，超了返回已读部分
  const deadline = Date.now() + 40000;
  try {
    if (parsed.type === 'folder') {
      return await readFolder(parsed.token, {
        maxDocs,
        maxCharsPerDoc: 2600,
        totalBudget: 14000,   // 内容预算；+目录清单(≤7500)+表头，总量压在 deepseek 工具消息 24000 字上限内
        maxDepth: 3,
        deadline,
      }, signal);
    }
    if (NOTE_ONLY.has(parsed.type)) {
      return `该飞书链接是「${TYPE_CN[parsed.type] || parsed.type}」，feishu_read 目前只全文读 docx/wiki 文档与电子表格，未展开。`;
    }
    const body = await readOne(parsed.type, parsed.token, singleMaxChars, { signal, timeoutMs: 20000 });
    return `飞书${TYPE_CN[parsed.type] || parsed.type}（${parsed.token}）内容：\n\n${body}`;
  } catch (e) {
    const msg = String(e.message || e);
    // 身份/权限类的常见形态，给模型一句可行动的提示
    if (/permission|denied|forbidden|无权|没有权限|not.*bound|context detected/i.test(msg)) {
      return `读取飞书失败（疑似权限/身份问题）：${msg}。可能是当前身份无该资源访问权，或 lark-cli 用户身份未生效。`;
    }
    return `读取飞书失败：${msg}`;
  }
}
