import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { CONFIG, WRITING_DIR } from './config.mjs';

// 草稿只落 kb/writing/*.md（现有约定：QS-入库/周会/发布器天然看得见）。
// 中文文件名在这台 NAS 上是 NFD——比较/展示一律 normalize 到 NFC，别靠 shell glob。

const nfc = (s) => s.normalize('NFC');

// NAS 未挂载：NetFS 挂载（osascript mount volume），绝不 mount_smbfs。
// 真读+真写探针（launchd 下 [ -d ] 是假绿灯；node 是 homebrew 二进制，TCC 全通）。
export function ensureNas() {
  const probe = () => {
    try {
      if (!fs.existsSync(path.join(CONFIG.KB_ROOT, '_schema'))) return false;
      fs.readdirSync(CONFIG.KB_ROOT);
      const p = path.join(CONFIG.KB_ROOT, '.kbwriter.nasprobe');
      fs.writeFileSync(p, 'x');
      fs.unlinkSync(p);
      return true;
    } catch { return false; }
  };
  if (probe()) return true;
  try {
    execFileSync('/usr/bin/osascript', ['-e', `mount volume "${CONFIG.NAS_MOUNT_URL}"`], { stdio: 'ignore' });
  } catch { /* 挂载失败下面再探一次 */ }
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) { if (probe()) return true; sleepBusy(300); }
  return probe();
}

function sleepBusy(ms) { const t = Date.now(); while (Date.now() - t < ms) { /* spin */ } }

const isDraft = (fn) => {
  const n = nfc(fn);
  return n.endsWith('.md') && !n.endsWith('.反馈.md') && n !== 'README.md';
};

export function listDrafts() {
  if (!fs.existsSync(WRITING_DIR)) return [];
  return fs.readdirSync(WRITING_DIR)
    .filter(isDraft)
    .map((fn) => {
      const st = fs.statSync(path.join(WRITING_DIR, fn));
      return { name: nfc(fn).slice(0, -3), mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

// 按 NFC 名找到磁盘上实际存在的文件名（可能是 NFD），避免中文重名双写。
function resolveOnDisk(baseName) {
  const wantNfc = nfc(baseName);
  if (!fs.existsSync(WRITING_DIR)) return null;
  for (const fn of fs.readdirSync(WRITING_DIR)) {
    if (nfc(fn) === wantNfc) return fn;
  }
  return null;
}

export function readDraft(name) {
  const on = resolveOnDisk(`${name}.md`);
  const markdown = on ? fs.readFileSync(path.join(WRITING_DIR, on), 'utf8') : '';
  const fbOn = resolveOnDisk(`${name}.反馈.md`);
  const feedback = fbOn ? fs.readFileSync(path.join(WRITING_DIR, fbOn), 'utf8') : null;
  return { name, markdown, feedback, exists: !!on };
}

// 原子写：写 .tmp 再 rename。复用磁盘既有文件名（NFD）避免重复。
export function writeDraft(name, markdown) {
  fs.mkdirSync(WRITING_DIR, { recursive: true });
  const on = resolveOnDisk(`${name}.md`) || `${name}.md`;
  const dest = path.join(WRITING_DIR, on);
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, markdown, 'utf8');
  fs.renameSync(tmp, dest);
  return { name, path: dest };
}

// ---- 理解层（kb/dimensions/*.md，L3 主人手写区）----
// 宪法：L3 是主人手写区，人随时可改，但 agent 不能代笔。**唯一可写机器路径 = 服务端这几个
// 「用户经 UI 主动保存」的函数**（token 鉴权在路由层）；claude/deepseek 会话的沙箱
// allowWrite 仍只 kb/writing，一字未动——机器会话依然写不了 dimensions。

const DIMS_DIR = path.join(CONFIG.KB_ROOT, 'dimensions');

function resolveDimOnDisk(baseName) {
  const want = nfc(baseName);
  if (!fs.existsSync(DIMS_DIR)) return null;
  for (const fn of fs.readdirSync(DIMS_DIR)) if (nfc(fn) === want) return fn;
  return null;
}

export function listDimensions() {
  if (!fs.existsSync(DIMS_DIR)) return [];
  return fs.readdirSync(DIMS_DIR)
    .filter((fn) => nfc(fn).endsWith('.md'))
    .map((fn) => {
      const st = fs.statSync(path.join(DIMS_DIR, fn));
      return { name: nfc(fn).slice(0, -3), mtime: st.mtimeMs, size: st.size };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

export function readDimension(name) {
  const on = resolveDimOnDisk(`${name}.md`);
  return { name, markdown: on ? fs.readFileSync(path.join(DIMS_DIR, on), 'utf8') : '', exists: !!on };
}

// 路径守卫（路由层校验过，这里再兜一层）+ 原子写（tmp+rename）。复用磁盘既有 NFD 文件名避免双写。
export function writeDimension(name, markdown) {
  if (/[/\\]/.test(name) || name.includes('..') || !name.trim()) throw new Error('非法维度名');
  if (!fs.existsSync(DIMS_DIR)) throw new Error('kb/dimensions 目录不存在（NAS 状态异常，拒绝写）');
  const on = resolveDimOnDisk(`${name}.md`) || `${name}.md`;
  const dest = path.join(DIMS_DIR, on);
  if (path.dirname(dest) !== DIMS_DIR) throw new Error('路径越界，拒绝写');   // 双保险：写只允许落在 dimensions/ 平级
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, markdown, 'utf8');
  fs.renameSync(tmp, dest);
  return { name, path: dest };
}

// ---- 版本历史（NAS 群晖回收站，每次自动存都留了一版）----
// 回收站在 share 根 `#recycle`，镜像原路径：/Volumes/2026Projects/#recycle/kb/{writing,dimensions}/
// 文件名形如 <名>_<HHMMSS>.md（群晖追加时间戳）；mtime 保留了真实保存时刻。
// scope：'writing'（草稿）| 'dimensions'（理解层——L3 是最贵的资产，必须能回退）。

function recycleDir(scope = 'writing') {
  const share = path.dirname(CONFIG.KB_ROOT);           // /Volumes/2026Projects
  return path.join(share, '#recycle', 'kb', scope === 'dimensions' ? 'dimensions' : 'writing');
}

export function listVersions(name, scope = 'writing') {
  const dir = recycleDir(scope);
  if (!fs.existsSync(dir)) return { available: false, versions: [] };
  const want = nfc(name);
  const out = [];
  for (const fn of fs.readdirSync(dir)) {
    const n = nfc(fn);
    if (!n.endsWith('.md') || n.includes('.反馈')) continue;
    // 匹配 <name>.md 或 <name>_<后缀>.md（回收站时间戳版本）
    const base = n.slice(0, -3);
    if (base === want || base.startsWith(want + '_')) {
      try { const st = fs.statSync(path.join(dir, fn)); out.push({ file: fn, mtime: st.mtimeMs, size: st.size }); } catch { /* skip */ }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return { available: true, versions: out };
}

export function readVersion(file, scope = 'writing') {
  // 只允许读回收站目录里的裸文件名（防路径穿越）
  if (/[/\\]/.test(file)) return null;
  const dir = recycleDir(scope);
  const on = fs.readdirSync(dir).find((f) => nfc(f) === nfc(file));
  if (!on) return null;
  try { return fs.readFileSync(path.join(dir, on), 'utf8'); } catch { return null; }
}

// 恢复：把某个历史版本写成一个**新文件**（不覆盖当前），返回新名字。
// dimensions scope 恢复也落回 kb/dimensions/（同为用户经 UI 主动操作，走同一守卫的写函数）。
export function restoreVersion(name, file, scope = 'writing') {
  const content = readVersion(file, scope);
  if (content == null) throw new Error('找不到该版本');
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const newName = `${name}-恢复${stamp}`;
  if (scope === 'dimensions') writeDimension(newName, content);
  else writeDraft(newName, content);
  return { name: newName, scope };
}

// 写 <草稿>.反馈.md 并调用 QS-写作 的 render_feedback.py（内部走唯一发布器 publish-kb-html.py）。
// 返回手机可访问的 /kbpub 链接。
export function publishFeedback(name, feedbackMarkdown) {
  fs.mkdirSync(WRITING_DIR, { recursive: true });
  const on = resolveOnDisk(`${name}.反馈.md`) || `${name}.反馈.md`;
  const dest = path.join(WRITING_DIR, on);
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, feedbackMarkdown, 'utf8');
  fs.renameSync(tmp, dest);
  return new Promise((resolve) => {
    // render_feedback.py 用系统/homebrew python3 都行；用 python3.12 保证 NAS TCC。
    const py = fs.existsSync(CONFIG.PY312) ? CONFIG.PY312 : '/opt/homebrew/bin/python3';
    execFile(py, [CONFIG.RENDER_FEEDBACK, dest], { timeout: 60000 }, (err, stdout, stderr) => {
      const out = `${stdout || ''}\n${stderr || ''}`;
      const m = out.match(/https?:\/\/\S+/);
      resolve({
        ok: !err,
        url: m ? m[0] : null,
        feedbackPath: dest,
        log: out.trim().slice(-800),
      });
    });
  });
}
