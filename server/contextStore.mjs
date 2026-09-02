import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WRITING_DIR } from './config.mjs';

// 每个文档一个"上下文篮子" sidecar：kb/writing/<草稿>.context.json（随草稿存，下次打开还在）。
// 五类源：① 草稿本身(始终) ② 知识库(默认开) ③ 文件 ④ 接口/API ⑤ 飞书/网页(留插槽)。

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
