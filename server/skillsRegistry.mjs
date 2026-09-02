import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.mjs';

// 全局已装技能清单（~/.claude/skills，多为符号链到 ~/sync/skills）。
// needsBash 启发式：技能带 Tools/tools/scripts 目录（有可执行脚本）→ 在无 Bash 的档位只能用其方法论。

let cache = null, cacheAt = 0;

function readDescription(dir) {
  try {
    const md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').slice(0, 4000);
    const m = md.match(/^description:\s*(.+)$/m);
    if (m) return m[1].trim().slice(0, 140);
    const line = md.split('\n').find((l) => l.trim() && !l.startsWith('---') && !l.startsWith('#') && !l.startsWith('name:'));
    return (line || '').trim().slice(0, 140);
  } catch { return ''; }
}

function hasToolScripts(dir) {
  for (const sub of ['Tools', 'tools', 'scripts', 'Scripts']) {
    const p = path.join(dir, sub);
    try {
      if (fs.statSync(p).isDirectory() &&
          fs.readdirSync(p).some((f) => /\.(py|sh|mjs|js|ts)$/.test(f))) return true;
    } catch { /* noop */ }
  }
  return false;
}

export function installedSkills() {
  const now = Date.now();
  if (cache && now - cacheAt < 60_000) return cache;
  const out = [];
  try {
    for (const name of fs.readdirSync(CONFIG.SKILLS_DIR)) {
      if (name.startsWith('.') || name.endsWith('.md') || name.endsWith('.py')) continue;
      const dir = path.join(CONFIG.SKILLS_DIR, name);
      try {
        if (!fs.statSync(dir).isDirectory()) continue;       // 跟随符号链
        if (!fs.existsSync(path.join(dir, 'SKILL.md'))) continue;
        out.push({ name, description: readDescription(dir), needsBash: hasToolScripts(dir) });
      } catch { /* 断链跳过 */ }
    }
  } catch (e) { console.error(`[skills] 读取技能目录失败：${e.message}`); }
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  cache = out; cacheAt = now;
  return out;
}

export function skillMeta(name) {
  return installedSkills().find((s) => s.name === name) || null;
}
