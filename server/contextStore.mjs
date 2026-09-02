import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG, WRITING_DIR } from './config.mjs';

// 每个文档一个"上下文篮子" sidecar：kb/writing/<草稿>.context.json（随草稿存，下次打开还在）。
// 源类型：① 草稿本身(始终) ② 知识库(默认开) ③ 文件 ④ 接口/API ⑤ 飞书/网页(留插槽)
//        ⑥ entity(单个实体页,L2 事实) ⑦ entity-all(整类实体)。

const nfc = (s) => s.normalize('NFC');

function basketPathOnDisk(name) {
  const want = nfc(`${name}.context.json`);
  if (fs.existsSync(WRITING_DIR)) {
    for (const fn of fs.readdirSync(WRITING_DIR)) if (nfc(fn) === want) return path.join(WRITING_DIR, fn);
  }
  return path.join(WRITING_DIR, `${name}.context.json`);
}

function defaultBasket() {
  return {
    version: 1,
    sources: [
      { id: 'kb', type: 'kb', enabled: true, mode: 'retrieval', label: '知识库 (entities 事实 + dimensions 理解)' },
    ],
    skills: [],   // 挂载技能（名字数组，顺序=主人优先序）
  };
}

export function readBasket(name) {
  const p = basketPathOnDisk(name);
  if (fs.existsSync(p)) {
    try {
      const b = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!Array.isArray(b.sources)) b.sources = [];
      if (!Array.isArray(b.skills)) b.skills = [];
      return b;
    } catch { /* 坏文件 → 默认 */ }
  }
  return defaultBasket();
}

export function writeBasket(name, basket) {
  fs.mkdirSync(WRITING_DIR, { recursive: true });
  const p = basketPathOnDisk(name);
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(basket, null, 2), 'utf8');
  fs.renameSync(tmp, p);
  return basket;
}

export function addSource(name, src) {
  const b = readBasket(name);
  const id = src.id || (src.type + '-' + crypto.randomBytes(4).toString('hex'));
  const clean = {
    id,
    type: src.type,                       // file | api | feishu | web | kb
    enabled: src.enabled !== false,
    mode: src.mode || (src.type === 'api' ? 'live' : 'snapshot'), // live | snapshot | retrieval
    label: src.label || id,
  };
  if (src.type === 'file') clean.path = src.path;
  if (src.type === 'api') { clean.skill = src.skill || 'papablic-data'; clean.query = src.query || ''; }
  if (src.type === 'web' || src.type === 'feishu') clean.ref = src.ref || '';
  if (src.type === 'entity') {
    clean.entityType = src.entityType; clean.entity = src.entity;
    clean.mode = src.mode === 'pointer' ? 'pointer' : 'snapshot';
  }
  if (src.type === 'entity-all') {
    clean.entityType = src.entityType;
    clean.mode = src.mode === 'full' ? 'full' : 'index';
  }
  b.sources.push(clean);
  return writeBasket(name, b);
}

export function updateSource(name, id, patch) {
  const b = readBasket(name);
  const s = b.sources.find((x) => x.id === id);
  if (!s) return b;
  Object.assign(s, patch);
  return writeBasket(name, b);
}

// 挂载技能：整组覆盖（数组顺序=优先序）。只存名字，元信息现查 skillsRegistry。
export function setSkills(name, skills) {
  const b = readBasket(name);
  b.skills = (Array.isArray(skills) ? skills : []).filter((x) => typeof x === 'string' && x.trim()).slice(0, 30);
  return writeBasket(name, b);
}

export function removeSource(name, id) {
  const b = readBasket(name);
  b.sources = b.sources.filter((x) => x.id !== id);
  return writeBasket(name, b);
}

// 保存上传的附件到 kb/writing/_attachments/<草稿>/<文件名>（在 kb 内 → 会话 Read/沙箱都覆盖）。
// _attachments 是子目录，不会被 listDrafts/发布器当草稿。返回绝对路径。
export function saveAttachment(draftName, filename, buffer) {
  const safeDraft = nfc(draftName).replace(/[/\\]/g, '_');
  const safeName = nfc(filename).replace(/[/\\]/g, '_').replace(/^\.+/, '').slice(0, 200) || 'attachment';
  const dir = path.join(WRITING_DIR, '_attachments', safeDraft);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, safeName);
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, dest);
  return { path: dest, name: safeName, bytes: buffer.length };
}

// ---- 实体源（kb/entities/{公司,人,产品}，L2 事实页）----
// 路径解析一律目录扫描 + NFC 归一（NAS 中文名是 NFD，绝不直接拼路径），复用 kbStore.resolveOnDisk 的模式。

export const ENTITY_TYPES = ['公司', '人', '产品'];
const ENTITIES_DIR = path.join(CONFIG.KB_ROOT, 'entities');
const DIMENSIONS_DIR = path.join(CONFIG.KB_ROOT, 'dimensions');

const scanDir = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
const isTemplate = (fn) => nfc(fn) === '_模板.md';

function entityIndexPath() {
  for (const f of scanDir(ENTITIES_DIR)) if (nfc(f) === '_index.md') return path.join(ENTITIES_DIR, f);
  return path.join(ENTITIES_DIR, '_index.md');
}

// UI 选单用：{公司:[{name,bytes}],人:[…],产品:[…],dimensions:[{name,path}]}（NFC 归一、剔 _模板.md）。
export function listEntities() {
  const out = {};
  for (const t of ENTITY_TYPES) {
    const dir = path.join(ENTITIES_DIR, t);
    out[t] = scanDir(dir)
      .filter((f) => f.endsWith('.md') && !isTemplate(f))
      .map((f) => {
        let bytes = 0; try { bytes = fs.statSync(path.join(dir, f)).size; } catch { /* noop */ }
        return { name: nfc(f).slice(0, -3), bytes };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  }
  // dimensions = L3 主人裁定理解，允许只读挂（前端拿绝对路径按 file 源挂，装配器识别路径标 L3）
  out.dimensions = scanDir(DIMENSIONS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ name: nfc(f).slice(0, -3), path: path.join(DIMENSIONS_DIR, f) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return out;
}

// 解析实体名 → 磁盘真实页。先目录扫描（NFC、大小写不敏感），再查 entities/_index.md 别名表
// （行如 `| [[安克]] | 安克创新、Anker、300866.SZ… |`，输 "Anker" 命中 安克）。找不到返回 null。
export function resolveEntityPage(entityType, name) {
  if (!ENTITY_TYPES.includes(entityType)) return null;
  const dir = path.join(ENTITIES_DIR, entityType);
  const want = nfc(String(name || '')).trim();
  if (!want) return null;
  const findInDir = (target) => {
    const t = nfc(target).trim().toLowerCase();
    for (const f of scanDir(dir)) {
      if (!f.endsWith('.md') || isTemplate(f)) continue;
      if (nfc(f).slice(0, -3).toLowerCase() === t) return { canonical: nfc(f).slice(0, -3), path: path.join(dir, f) };
    }
    return null;
  };
  const direct = findInDir(want);
  if (direct) return direct;
  try {
    const idx = nfc(fs.readFileSync(entityIndexPath(), 'utf8'));
    const w = want.toLowerCase();
    for (const line of idx.split('\n')) {
      const m = line.match(/^\|\s*\[\[([^\]]+)\]\]\s*\|([^|]*)\|/);
      if (!m) continue;
      const page = m[1].trim();
      const aliases = m[2].split(/[、，,;；\/／]/).map((a) => a.replace(/\*\*/g, '').trim().toLowerCase()).filter(Boolean);
      if (page.toLowerCase() === w || aliases.includes(w)) {
        const hit = findInDir(page);           // 只认本类目录里真实存在的页（别名表跨类共用）
        if (hit) return hit;
      }
    }
  } catch { /* 无索引 → 只靠目录扫描 */ }
  return null;
}

// 读实体页（bounded：实体页专用上限 ENTITY_INLINE_LIMIT，超限 truncated=true，装配器负责尾注不静默）。
export function readEntityPage(entityType, name) {
  const hit = resolveEntityPage(entityType, name);
  if (!hit) return null;
  try {
    let text = fs.readFileSync(hit.path, 'utf8');
    const truncated = text.length > CONFIG.ENTITY_INLINE_LIMIT;
    if (truncated) text = text.slice(0, CONFIG.ENTITY_INLINE_LIMIT);
    return { ...hit, text, truncated };
  } catch (e) { return { ...hit, text: null, error: String(e.message || e) }; }
}

export function listEntityPages(entityType) {
  const dir = path.join(ENTITIES_DIR, entityType);
  return scanDir(dir)
    .filter((f) => f.endsWith('.md') && !isTemplate(f))
    .map((f) => ({ name: nfc(f).slice(0, -3), path: path.join(dir, f) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

// entity-all mode=full 的守门：现算该类总字符数。
export function classTotalChars(entityType) {
  let sum = 0;
  for (const p of listEntityPages(entityType)) {
    try { sum += fs.readFileSync(p.path, 'utf8').length; } catch { /* noop */ }
  }
  return sum;
}

// entity-all mode=index：从 entities/_index.md 抽该类的表（## <类> 到下一个 ## 之间，每类几 KB）。
export function extractIndexSection(entityType) {
  try {
    const idx = nfc(fs.readFileSync(entityIndexPath(), 'utf8'));
    const m = new RegExp(`^##\\s*${entityType}\\s*$`, 'm').exec(idx);
    if (!m) return null;
    const rest = idx.slice(m.index);
    const next = rest.slice(3).search(/^##\s/m);
    const section = next >= 0 ? rest.slice(0, next + 3) : rest;
    return section.trim().slice(0, 9000);
  } catch { return null; }
}

// 读文件源内容（bounded）。返回 {text, truncated} 或 null（读不了/非文本）。
const FILE_INLINE_LIMIT = 24000;
export function readFileSource(p) {
  try {
    const buf = fs.readFileSync(p);
    // 粗判文本：无 NUL 字节
    if (buf.includes(0)) return { text: null, binary: true };
    let text = buf.toString('utf8');
    let truncated = false;
    if (text.length > FILE_INLINE_LIMIT) { text = text.slice(0, FILE_INLINE_LIMIT); truncated = true; }
    return { text, truncated, binary: false };
  } catch (e) {
    return { text: null, error: String(e.message || e) };
  }
}
