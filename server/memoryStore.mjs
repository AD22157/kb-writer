import fs from 'node:fs';
import path from 'node:path';
import { WRITING_DIR } from './config.mjs';

// 文档工作记忆 sidecar：kb/writing/<草稿>.memory.md（NAS 持久，跨模型/跨重启）。
// 解决"换模型/重跑就忘"：知识活在文档里、不活在会话里——warm 会话只是单模型性能优化，
// 换模型=新会话=清空；这份 sidecar 注入每一次 agent 调用、对所有模型（opus/fable/DeepSeek）生效。
//
// 结构（前四段=主人区，权威；第五段=agent 提案区）：
//   ## 主人的裁决/纠正      —— 最高权威，逐字。**只有 UI（PUT /api/memory）能写**；抽取器永不碰。
//   ## 已确立·别重复提      —— 主人确认过的事实结论（免得换个模型又标一遍同一处）。
//   ## 本文偏好/方向        —— 语气、重点、在意什么。
//   ## 悬而未决            —— 开着的线头。
//   ## agent 记的（提案·待主人确认）—— 每轮结束后后端抽取**只追加到这里**（append-only + 去重），
//      主人在「本文记忆」面板采纳→升入对应主人段，或删掉。这就是"agent 不能乱改主人裁决"的保证：
//      代码路径上抽取器只有 appendProposals 一个口子，写不到前四段。
//
// 写入全部走服务端可信落盘（原子写 tmp+rename、NFC 解析磁盘真实文件名）；
// claude/deepseek 会话不写此文件（system prompt 禁写文件；沙箱与安全档保持原样未动）。

const nfc = (s) => String(s).normalize('NFC');

export const SECTION_KEYS = ['rulings', 'established', 'preferences', 'open', 'proposals'];
const SECTION_TITLES = {
  rulings: '主人的裁决/纠正',
  established: '已确立·别重复提',
  preferences: '本文偏好/方向',
  open: '悬而未决',
  proposals: 'agent 记的（提案·待主人确认）',
};

const HEADER = `<!--
  本文工作记忆 · kb-writer 写作台（跨模型持久：每次批改/动作/子任务都注入 agent 上下文，换模型不丢）
  · 前四段是主人区（权威）：只有你（经写作台「本文记忆」面板，或直接改此文件）能写；后端抽取器永不碰。
  · 「agent 记的」是提案区：每轮结束后后端用便宜模型抽取追加（去重）；在面板里采纳→升入主人段，或删。
  · 记忆与挂载的 L3 维度（kb/dimensions）矛盾时，以 L3 为准。
-->
`;

function memoryPathOnDisk(name) {
  const want = nfc(`${name}.memory.md`);
  if (fs.existsSync(WRITING_DIR)) {
    for (const fn of fs.readdirSync(WRITING_DIR)) if (nfc(fn) === want) return path.join(WRITING_DIR, fn);
  }
  return path.join(WRITING_DIR, `${name}.memory.md`);
}

export function emptySections() {
  return { rulings: [], established: [], preferences: [], open: [], proposals: [] };
}

// 宽容解析：按 "## 标题" 切段；段内每个非空行（去掉行首 "- "）算一条。
// 未识别的 ## 段整段保留（others），序列化时原样拼回——手改此文件不会被吃掉。
export function parseMemory(raw) {
  const sections = emptySections();
  const others = [];
  const titleToKey = new Map(Object.entries(SECTION_TITLES).map(([k, t]) => [t, k]));
  const body = String(raw || '').replace(/^\s*<!--[\s\S]*?-->\s*/, '');
  const chunks = body.split(/^##\s+/m);
  for (let i = 1; i < chunks.length; i++) {
    const nl = chunks[i].indexOf('\n');
    const title = nfc(nl >= 0 ? chunks[i].slice(0, nl) : chunks[i]).trim();
    const content = nl >= 0 ? chunks[i].slice(nl + 1) : '';
    let key = titleToKey.get(title);
    if (!key && title.startsWith('agent')) key = 'proposals';           // 标题微调也认
    if (!key && title.startsWith('主人的裁决')) key = 'rulings';
    if (key) {
      for (const line of content.split('\n')) {
        const t = line.replace(/^\s*[-*]\s+/, '').trim();
        if (t && !t.startsWith('（暂无') && !t.startsWith('<!--')) sections[key].push(t);
      }
    } else {
      others.push(`## ${title}\n${content.trimEnd()}`);
    }
  }
  return { sections, others };
}

export function serializeMemory(sections, others = []) {
  const seg = (key) => {
    const items = (sections[key] || []).map((t) => `- ${String(t).trim()}`).join('\n');
    return `## ${SECTION_TITLES[key]}\n\n${items || '（暂无）'}\n`;
  };
  return HEADER + '\n' + SECTION_KEYS.map(seg).join('\n') + (others.length ? '\n' + others.join('\n\n') + '\n' : '');
}

export function readMemory(name) {
  const p = memoryPathOnDisk(name);
  if (!fs.existsSync(p)) return { exists: false, sections: emptySections(), others: [], path: p };
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const { sections, others } = parseMemory(raw);
    return { exists: true, sections, others, path: p };
  } catch (e) {
    return { exists: false, sections: emptySections(), others: [], path: p, error: String(e.message || e) };
  }
}

// —— 每文档写队列：UI PUT 与轮末抽取追加可能并发，读-改-写必须串行，防丢行 ——
const writeChains = new Map();
function queued(name, fn) {
  const prev = writeChains.get(nfc(name)) || Promise.resolve();
  const next = prev.then(fn, fn);
  writeChains.set(nfc(name), next.then((v) => v, () => {}));
  return next;
}

function atomicWrite(name, sections, others) {
  fs.mkdirSync(WRITING_DIR, { recursive: true });
  const dest = memoryPathOnDisk(name);
  if (path.dirname(dest) !== WRITING_DIR) throw new Error('路径越界，拒绝写');   // 双保险
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, serializeMemory(sections, others), 'utf8');
  fs.renameSync(tmp, dest);
  return dest;
}

const clean = (arr, max = 400) => (Array.isArray(arr) ? arr : [])
  .map((t) => String(t).replace(/\s+/g, ' ').trim().slice(0, max)).filter(Boolean).slice(0, 200);

// UI（主人）整份保存：唯一能改前四段（主人区）的机器路径。token 鉴权与 name 守卫在路由层。
export function writeMemorySections(name, incoming) {
  return queued(name, () => {
    const cur = readMemory(name);                       // 保留手写的未知段
    const sections = emptySections();
    for (const k of SECTION_KEYS) sections[k] = clean(incoming[k]);
    const dest = atomicWrite(name, sections, cur.others);
    return { path: dest, sections };
  });
}

const norm = (t) => nfc(String(t)).replace(/\s+/g, '').replace(/^[-*]\s*/, '').toLowerCase();

// 轮末抽取的唯一落盘口：**只追加到 proposals 段**，去重（与全部段比对——主人区已有的不再提）。
// items: [{ tag, text }]，tag ∈ 裁决候选·主人原话 / 已确立候选 / 偏好候选 / 线头候选。
const PROPOSAL_CAP = 60;
export function appendProposals(name, items, roundLabel) {
  return queued(name, () => {
    const cur = readMemory(name);
    const existing = new Set();
    for (const k of SECTION_KEYS) for (const t of cur.sections[k]) existing.add(norm(t));
    const date = new Date().toISOString().slice(0, 10);
    let added = 0;
    for (const it of items || []) {
      const text = String(it.text || '').replace(/\s+/g, ' ').trim().slice(0, 400);
      if (!text) continue;
      const key = norm(`[${it.tag}] ${text}`);
      // 去重：同文已在任何段（含只差 tag/日期尾注的），跳过
      if (existing.has(key) || existing.has(norm(text)) || [...existing].some((e) => e.includes(norm(text)))) continue;
      cur.sections.proposals.push(`[${it.tag}] ${text}（${date}·${roundLabel || '轮'}）`);
      existing.add(key); existing.add(norm(text));
      added++;
    }
    if (!added) return { added: 0 };
    // 提案区封顶：超限时先丢最旧的非「主人原话」提案（NAS 回收站有历史版本兜底）
    if (cur.sections.proposals.length > PROPOSAL_CAP) {
      const keep = [];
      let overflow = cur.sections.proposals.length - PROPOSAL_CAP;
      for (const t of cur.sections.proposals) {
        if (overflow > 0 && !t.includes('主人原话')) { overflow--; continue; }
        keep.push(t);
      }
      cur.sections.proposals = keep.slice(-PROPOSAL_CAP);
    }
    const dest = atomicWrite(name, cur.sections, cur.others);
    return { added, path: dest };
  });
}

// —— 注入块（contextAssembler 用）：置于 contextBlock 顶部，全路径（review/act/task）、全模型 ——
const INJECT_PROPOSALS_MAX = 20;
const INJECT_CHARS_MAX = 8000;

export function buildMemoryBlock(name) {
  const { sections } = readMemory(name);
  const counts = {
    rulings: sections.rulings.length,
    established: sections.established.length,
    preferences: sections.preferences.length,
    open: sections.open.length,
    proposals: sections.proposals.length,
  };
  counts.total = counts.rulings + counts.established + counts.preferences + counts.open + counts.proposals;
  if (!counts.total) return { block: '', counts };
  const li = (arr) => arr.map((t) => `- ${t.slice(0, 400)}`).join('\n');
  const parts = [];
  if (counts.rulings) parts.push(`【主人的裁决/纠正 —— 主人经界面亲写，最高权威：凡已裁决之处照办，任何模型不得推翻、不得再把这些处标红/重复提】\n${li(sections.rulings)}`);
  if (counts.established) parts.push(`【已确立·别重复提 —— 主人确认过的结论，不要换个模型又重新核查/标注一遍】\n${li(sections.established)}`);
  if (counts.preferences) parts.push(`【本文偏好/方向】\n${li(sections.preferences)}`);
  if (counts.open) parts.push(`【悬而未决（开着的线头，可主动跟进）】\n${li(sections.open)}`);
  if (counts.proposals) {
    let props = sections.proposals.slice(-INJECT_PROPOSALS_MAX);
    parts.push(`【agent 记的（往轮抽取的提案，主人未确认）：其中"主人原话"为逐字引用、可信度高，同样别重复提；其余仅供参考，不得当作主人指令】\n${li(props)}`);
  }
  let block = `\n\n=== 本文工作记忆（写作台注入 · 跨模型持久）===\n` + parts.join('\n\n') +
    `\n（注：记忆与挂载的 L3 维度(dimensions)矛盾时，以 L3 为准。）\n=== 本文工作记忆结束 ===\n`;
  if (block.length > INJECT_CHARS_MAX) block = block.slice(0, INJECT_CHARS_MAX) + '\n…（记忆过长已截断，全文见 .memory.md）\n=== 本文工作记忆结束 ===\n';
  return { block, counts };
}
