import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import dns from 'node:dns/promises';
import net from 'node:net';
import { CONFIG } from './config.mjs';
import { deepseekKey } from './providers.mjs';
import { feishuRead } from './larkRead.mjs';
import { extractPdfText } from './fileExtract.mjs';

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

// ---------------- web_fetch 的 SSRF 护栏（安全硬约束，阿峰极重视） ----------------
// 判定一个 IP 是否属于「禁止直达」的私网/环回/链路本地/元数据/组播/保留地址。
function ipIsBlocked(ip) {
  let v = ip;
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ip);  // IPv4-mapped IPv6
  if (mapped) v = mapped[1];
  if (net.isIPv4(v)) {
    const p = v.split('.').map(Number);
    if (p.length !== 4 || p.some((x) => Number.isNaN(x) || x < 0 || x > 255)) return true;
    const [a, b] = p;
    // 本机（及 mini）用 fake-ip DNS 代理（Clash/Surge 类）把所有公网域名映射到 198.18.0.0/15 再由代理转发
    // 到真实站点——这是本部署正常的出网路径，必须放行，否则一切研究抓取都会被误判为「保留地址」全拦。
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 0) return true;                          // 0.0.0.0/8
    if (a === 10) return true;                         // 10/8 私网
    if (a === 127) return true;                        // 127/8 环回
    if (a === 169 && b === 254) return true;           // 169.254/16 链路本地（含 169.254.169.254 云元数据）
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16/12 私网
    if (a === 192 && b === 168) return true;           // 192.168/16 私网
    if (a === 192 && b === 0 && p[2] === 0) return true; // 192.0.0.0/24
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
    if (a >= 224) return true;                         // 224+ 组播/保留（含 255.255.255.255 广播）
    return false;
  }
  if (net.isIPv6(v)) {
    const l = v.toLowerCase();
    if (l === '::1' || l === '::') return true;         // 环回 / 未指定
    if (/^fe[89ab]/.test(l)) return true;              // fe80::/10 链路本地
    if (l.startsWith('fc') || l.startsWith('fd')) return true; // fc00::/7 ULA 私网
    if (l.startsWith('ff')) return true;               // ff00::/8 组播
    return false;
  }
  return true;  // 解析不出合法 IP → 视为不安全
}

// 校验目标 host：拒 localhost / .local / .internal / 裸主机名 / 十进制或十六进制整数形式的 IP；
// 数字 IP 字面量直接查禁止范围（绕过 DNS，堵 http://169.254.169.254 这类）；域名则 DNS 解析后逐个 IP 校验
// （堵「解析到内网的域名」）。curated 可信根（CONFIG.RESEARCH_DOMAINS）跳过解析直接放行（防 DNS 抖动误伤必需源）。
function isTrustedRoot(host) {
  return CONFIG.RESEARCH_DOMAINS.some((d) => host === d.toLowerCase() || host.endsWith('.' + d.toLowerCase()));
}
async function assertPublicHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (!host) throw new Error('空主机名');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal'))
    throw new Error(`拒绝内网主机名 ${host}`);
  if (net.isIP(host)) {
    if (ipIsBlocked(host)) throw new Error(`拒绝私网/环回/链路本地/元数据地址 ${host}`);
    return;
  }
  // 非 IP 又不含点（裸主机名 like "metadata"）、或整数形式伪装 IP（十进制/十六进制，net.isIP 判否）→ 拒
  if (!/\./.test(host)) throw new Error(`拒绝无点主机名 ${host}（疑似内网短名或整数形式 IP）`);
  if (isTrustedRoot(host)) return;  // curated 一手源根：信任放行
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); }
  catch { throw new Error(`DNS 解析失败 ${host}`); }
  if (!addrs.length) throw new Error(`DNS 无记录 ${host}`);
  for (const a of addrs) if (ipIsBlocked(a.address)) throw new Error(`${host} 解析到非公网地址 ${a.address}，拒绝`);
}

const FETCH_LIMIT = 20000;
const FETCH_MAX_BYTES = 6_000_000;   // 响应体下载上限 6MB（防超大文件撑爆）
const FETCH_MAX_REDIRECTS = 5;
// 真浏览器 UA：很多站点对无名 UA 直接 403（Tesla 之类 Akamai 墙即便带浏览器 UA 也拦，那是站点侧硬墙，非本工具可绕）。
const FETCH_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function readCapped(res, max) {
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length; chunks.push(Buffer.from(value));
    if (total > max) { try { await reader.cancel(); } catch { /* noop */ } break; }
  }
  return Buffer.concat(chunks);
}

// web_fetch：GET-only + 只 http(s) + SSRF 护栏（逐跳复校，防重定向绕过）+ 放开到任意公网源。
// 调研档无密钥、无 OS 写权，风险面主要是 SSRF——护栏挡住即可（写/api 档网络策略不动，见 security.mjs）。
// 残留（已知、可接受）：本机 fake-ip 代理下 DNS 解析返回占位 IP，域名→内网的重绑定 TOCTOU 无法在此层根绝；
//   但字面量私网 IP、内网主机名、云元数据地址均被前置拦死，且本档无密钥可外泄、响应只回给模型。
export async function toolWebFetch({ url } = {}, signal) {
  let u;
  try { u = new URL(String(url || '')); } catch { return '错误：URL 不合法'; }
  if (!/^https?:$/.test(u.protocol)) return `错误：只允许 http(s)（拒 ${u.protocol}//，如 file/ftp/gopher/data）`;
  let cur = u;
  for (let i = 0; i <= FETCH_MAX_REDIRECTS; i++) {
    if (!/^https?:$/.test(cur.protocol)) return '错误：重定向到非 http(s)，中止';
    try { await assertPublicHost(cur.hostname); }
    catch (e) { return `拒绝（SSRF 护栏）：${String(e.message || e)}`; }
    let res;
    try {
      res = await fetch(cur, { method: 'GET', redirect: 'manual', signal, headers: { 'user-agent': FETCH_UA, accept: 'text/html,application/xhtml+xml,application/json,text/plain,application/pdf,*/*', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' } });
    } catch (e) { return `错误：请求失败 ${String(e.message || e).slice(0, 120)}（${cur.hostname}）`; }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return `错误：HTTP ${res.status} 无 Location`;
      let nu; try { nu = new URL(loc, cur); } catch { return '错误：重定向 Location 非法'; }
      cur = nu; continue;   // 下一圈重新跑 SSRF 校验（逐跳复校）
    }
    if (!res.ok) return `错误：HTTP ${res.status}（${cur.hostname}）${res.status === 403 ? '——站点侧反爬墙，本工具无法绕，换其它源' : ''}`;
    const ct = res.headers.get('content-type') || '';
    const buf = await readCapped(res, FETCH_MAX_BYTES);
    // PDF（巴菲特年报/致股东信、招股书等一手源常是 PDF）：落临时文件用本机抽取器取正文，读完即删。
    if (/pdf/i.test(ct) || /\.pdf($|\?)/i.test(cur.pathname)) {
      const tmp = path.join(os.tmpdir(), `kbwf-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
      try {
        fs.writeFileSync(tmp, buf);
        const r = extractPdfText(tmp);
        if (r.text) {
          const t = r.text;
          return `【PDF 正文（via ${r.via}，${buf.length} 字节）｜${cur.href}】\n` + (t.length > FETCH_LIMIT ? t.slice(0, FETCH_LIMIT) + '\n…（已截断）' : t);
        }
        return `（取到 PDF ${buf.length} 字节，但正文抽取失败：${r.error}。可能是扫描件/纯图 PDF。）`;
      } finally { try { fs.unlinkSync(tmp); } catch { /* noop */ } }
    }
    const body = new TextDecoder('utf-8').decode(buf);
    const text = /html/i.test(ct) ? htmlToText(body) : body;
    return text.length > FETCH_LIMIT ? text.slice(0, FETCH_LIMIT) + '\n…（已截断）' : text;
  }
  return '错误：重定向过多';
}

// —— web_search 后端与相关性闸门 ——
// 根因（2026-09 实测）：Bing HTML 对「农夫山泉 商业模式」这类中文/宽泛 query 会触发反爬，返回 200 + 正确
//   的搜索框/标题，但正文 organic 结果是「诱饵」——随机站点首页（米哈游/企查查/小红书…），每次还不一样。
//   query 本身没被改坏（搜索框回显正确），是 Bing 侧给爬虫喂噪音。旧代码照单全收，把噪音当「查到」喂给模型。
// 修法：① 中文 query 走 Baidu（对中文可靠、返回真 URL via mu 属性；英文 query 走 Bing 优先、Baidu 兜底）；
//       ② 无论哪个后端，出结果前过「相关性闸门」——查询词命中率过低就诚实降级标注「检索质量存疑」，绝不当事实。
const SEARCH_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const hasCJK = (s) => /[㐀-鿿豈-﫿]/.test(String(s));

// 查询词切成有意义的 token：CJK 连续 ≥2 字的串 + ASCII 长度 ≥2 的词（含年份数字）。
function queryTokens(q) {
  const cjk = q.match(/[㐀-鿿豈-﫿]{2,}/g) || [];
  const ascii = (q.toLowerCase().match(/[a-z0-9][a-z0-9'-]{1,}/g) || []);
  return [...new Set([...cjk, ...ascii])];
}
function resultMatches(r, tokens) {
  const hay = ((r.title || '') + ' ' + (r.snippet || '') + ' ' + (r.url || '')).toLowerCase();
  return tokens.some((tk) => {
    if (/^[a-z0-9'-]+$/.test(tk)) return hay.includes(tk);          // ASCII 词整词命中
    if (hay.includes(tk)) return true;                              // CJK 整串命中
    for (let i = 0; i + 2 <= tk.length; i++) if (hay.includes(tk.slice(i, i + 2))) return true; // CJK 2-gram 宽松命中
    return false;
  });
}
function relevance(results, tokens) {
  if (!results.length) return { ratio: 0, matched: 0 };
  if (!tokens.length) return { ratio: 1, matched: results.length };
  const matched = results.filter((r) => resultMatches(r, tokens)).length;
  return { ratio: matched / results.length, matched };
}

async function fetchBaidu(q, n, signal) {
  const res = await fetch('https://www.baidu.com/s?wd=' + encodeURIComponent(q) + '&rn=' + Math.max(n, 10), {
    signal, redirect: 'follow',
    headers: { 'user-agent': SEARCH_UA, accept: 'text/html', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
  });
  if (!res.ok) return { ok: false, err: `Baidu HTTP ${res.status}` };
  const html = await res.text();
  if (/百度安全验证|请输入验证码|wappass\.baidu|网络不给力/.test(html)) return { ok: false, err: 'Baidu 验证页（限流）' };
  const out = [];
  const re = /<div\b[^>]*\bclass="[^"]*\bc-container\b[^"]*"[^>]*>/g;
  const starts = []; let m;
  while ((m = re.exec(html))) starts.push({ idx: m.index, tag: m[0] });
  for (let i = 0; i < starts.length; i++) {
    const seg = html.slice(starts[i].idx, i + 1 < starts.length ? starts[i + 1].idx : starts[i].idx + 6000);
    const h3 = seg.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
    if (!h3) continue;
    const title = htmlToText(h3[1]);
    if (!title) continue;
    const mu = (starts[i].tag.match(/\bmu="([^"]+)"/) || [])[1];
    const href = (h3[0].match(/<a[^>]*href="([^"]+)"/) || [])[1];
    const url = (mu || href || '').replace(/&amp;/g, '&');
    let snip = htmlToText(seg.replace(h3[0], ' ')).replace(title, ' ').trim();
    out.push({ title: title.slice(0, 140), url, snippet: snip.slice(0, 300) });
    if (out.length >= n) break;
  }
  return { ok: true, results: out };
}

async function fetchSogou(q, n, signal) {
  const res = await fetch('https://www.sogou.com/web?query=' + encodeURIComponent(q), {
    signal, redirect: 'follow',
    headers: { 'user-agent': SEARCH_UA, accept: 'text/html', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
  });
  if (!res.ok) return { ok: false, err: `Sogou HTTP ${res.status}` };
  const html = await res.text();
  if (/安全验证|请输入验证码|antispider|seccodeInput/.test(html)) return { ok: false, err: 'Sogou 验证页（限流）' };
  const out = [];
  for (const mm of html.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/g)) {
    const raw = mm[0];
    const href = (raw.match(/<a[^>]*href="([^"]+)"/) || [])[1];
    if (!href) continue;   // 无链接的 h3 = Sogou 顶部 AI 答案卡片段，非 organic 结果
    const title = htmlToText(mm[1]);
    if (!title) continue;
    let url = href.replace(/&amp;/g, '&');
    if (url.startsWith('/')) url = 'https://www.sogou.com' + url;  // /link?url=... 补成绝对（跳转到真源）
    const after = html.slice(mm.index + raw.length, mm.index + raw.length + 1400);
    const sm = after.match(/<(?:div|p)[^>]*class="[^"]*(?:fz-mid|text-layout|str_info|space-txt|card-txt|fb)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|p)>/);
    out.push({ title: title.slice(0, 140), url, snippet: (sm ? htmlToText(sm[1]) : '').slice(0, 300) });
    if (out.length >= n) break;
  }
  return { ok: true, results: out };
}

async function fetchBing(q, n, signal) {
  const res = await fetch('https://www.bing.com/search?q=' + encodeURIComponent(q) + '&count=' + n, {
    signal, redirect: 'follow',
    headers: { 'user-agent': SEARCH_UA, accept: 'text/html', 'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.5' },
  });
  if (!res.ok) return { ok: false, err: `Bing HTTP ${res.status}` };
  const html = await res.text();
  const out = [];
  for (const block of html.match(/<li class="b_algo"[\s\S]{0,4000}?<\/li>/g) || []) {
    const a = block.match(/<h2[^>]*>\s*<a[^>]*href="(http[^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    out.push({ title: htmlToText(a[2]).slice(0, 140), url: a[1], snippet: htmlToText(p ? p[1] : '').slice(0, 300) });
    if (out.length >= n) break;
  }
  return { ok: true, results: out };
}

const REL_MIN = 0.34;   // 命中率低于此 → 判定检索质量存疑，诚实降级标注

export async function toolWebSearch({ query, count } = {}, signal) {
  const q = String(query || '').trim();
  if (!q) return '错误：缺少 query';
  const n = Math.min(Math.max(Number(count) || 8, 1), 10);
  const tokens = queryTokens(q);
  // 级联多后端，取第一个「过相关性闸门」的结果即停：
  //   中文主题 → 百度 → 搜狗 → 必应（Bing 对中文常喂反爬诱饵；百度被本代理出口 IP captcha 墙时搜狗兜底）；
  //   英文主题 → 必应 → 搜狗 → 百度。全部过闸门，都不达标则返回最优的一份并诚实标注质量存疑。
  const backends = hasCJK(q)
    ? [['baidu', fetchBaidu], ['sogou', fetchSogou], ['bing', fetchBing]]
    : [['bing', fetchBing], ['sogou', fetchSogou], ['baidu', fetchBaidu]];
  let best = null; const notes = [];
  for (const [name, fn] of backends) {
    let r;
    try { r = await fn(q, n, signal); } catch (e) { notes.push(`${name} 异常(${String(e.message || e).slice(0, 50)})`); continue; }
    if (!r.ok) { notes.push(`${name}: ${r.err}`); continue; }
    const { ratio, matched } = relevance(r.results, tokens);
    const cand = { name, results: r.results, ratio, matched };
    if (!best || ratio > best.ratio || (ratio === best.ratio && r.results.length > best.results.length)) best = cand;
    if (r.results.length && ratio >= REL_MIN) { best = cand; break; }  // 命中率达标 → 采用，不再试下一后端
  }
  if (!best || !best.results.length) {
    return `搜索无结果（尝试 ${backends.map((b) => b[0]).join('/')}${notes.length ? '；' + notes.join('；') : ''}）。换关键词，或改用 reddit / web_fetch 一手源 / kb_read。`;
  }
  const payload = { source: best.name, count: best.results.length, results: best.results };
  if (tokens.length && best.ratio < REL_MIN) {
    // 诚实降级：不把噪音当「查到」。明确标注，让模型别把这些当已核实事实。
    payload.quality = '⚠️ 检索质量存疑';
    payload.warning = `仅 ${best.matched}/${best.results.length} 条结果与查询词匹配——检索后端可能返回了无关内容（反爬诱饵/结构变化）。请勿把以下结果当已核实事实：用 web_fetch 打开原文逐条核对，或换关键词、改用 reddit / kb_read。`;
  }
  return JSON.stringify(payload, null, 1);
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
  { type: 'function', function: { name: 'web_search', description: '网页搜索，返回 {source,count,results:[{title,url,snippet}]}（中文走百度/搜狗、英文走必应，级联择优）。先搜线索、再用 web_fetch 读原文。若返回带 quality="⚠️ 检索质量存疑"，说明结果与查询词匹配度低、可能是无关噪音——不要当已核实事实，逐条 web_fetch 核对或换词。', parameters: { type: 'object', properties: { query: { type: 'string' }, count: { type: 'number', description: '结果数，默认 8，最多 10' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'web_fetch', description: '抓取一个网页/PDF 正文（GET-only，只 http(s)）。可取任意公网一手源——公司官网/IR 页、SEC/*.gov、巴菲特年报(berkshirehathaway.com)PDF、维基百科等；PDF 会自动抽正文。内置 SSRF 护栏拒私网/环回/云元数据地址。少数站点（如 tesla.com）有反爬硬墙返回 403，本工具绕不过——换其它源。', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
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
