import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.mjs';

// 动作技能：补充/修正/提问/起草 的方法论抽成可编辑文件（~/sync/skills/QS-写作/actions/<名>.md）。
// · 服务端每次请求现读文件拼 prompt——改文件立即生效，无需重启。
// · 缺文件回退内置默认（isDefault:true 提示前端）。
// · 只有用户经 UI（token 鉴权）能改；agent 会话无权写 skill（沙箱/权限双禁）。
// · ~/sync 由 library 同步循环自动 git commit —— 改坏了去 ~/sync 的 git 历史回退。

export const ACTION_FILES = { supplement: '补充', revise: '修正', question: '提问', draft: '起草' };

const HEADER = (zh) => `<!--
  动作技能「${zh}」—— kb-writer 写作台在你点「${zh}」时发给 agent 的方法论正文。
  · 改这个文件 = 改这个动作的行为（保存后下一次点击立即生效，无需重启）。
  · 契约：若希望产出可被一键落笔，须让 agent 用【建议插入】/【建议修订】/【草稿】起一段纯文本（写作台靠这些标记抽取）。
  · 改坏了：~/sync 有 git 自动提交历史，可回退。
-->
`;

const BUILTIN = {
  supplement: '请从知识库/已挂接口里找能补进来的论据素材（带来源），加强或纠正这里的论点。若有可直接插入的一段，用【建议插入】给出。',
  revise: '请给这段的改写建议（更准/更紧/更有据），并用【建议修订】给出可直接替换这段选区的文本；简述改了什么、依据是什么。',
  question: '作为一起写的伙伴，向我抛 3-5 个能推进这篇的问题（事实缺口、口径、论证薄弱处、需要我拍板的判断）。不要插正文。',
  draft: '帮我起草一段（基于上下文，事实处带来源，判断处标"建议"），用【草稿】给出可插入的文本；我来定稿。',
};

const filePath = (action) => path.join(CONFIG.ACTIONS_DIR, `${ACTION_FILES[action]}.md`);
const stripHeader = (t) => t.replace(/^\s*<!--[\s\S]*?-->\s*/, '').trim();

// 启动时把内置默认迁成初版文件（已存在则不动——用户的改写优先）。
export function ensureActionFiles() {
  try {
    fs.mkdirSync(CONFIG.ACTIONS_DIR, { recursive: true });
    for (const [action, zh] of Object.entries(ACTION_FILES)) {
      const p = filePath(action);
      if (!fs.existsSync(p)) fs.writeFileSync(p, HEADER(zh) + BUILTIN[action] + '\n', 'utf8');
    }
  } catch (e) { console.error(`[actionSkills] 初始化失败（回退内置默认）：${e.message}`); }
}

// 现读（每次调用都读文件 → 编辑立即生效）。
export function loadActionBody(action) {
  if (!ACTION_FILES[action]) return null;
  try {
    const raw = fs.readFileSync(filePath(action), 'utf8');
    const body = stripHeader(raw);
    if (body) return { body, isDefault: false, file: filePath(action) };
  } catch { /* fallthrough */ }
  return { body: BUILTIN[action], isDefault: true, file: filePath(action) };
}

export function readActionSkill(action) {
  if (!ACTION_FILES[action]) return null;
  const { body, isDefault, file } = loadActionBody(action);
  return { action, zh: ACTION_FILES[action], content: body, isDefault, file };
}

export function writeActionSkill(action, content) {
  if (!ACTION_FILES[action]) throw new Error('action 须为 ' + Object.keys(ACTION_FILES).join('/'));
  if (!content || !content.trim()) throw new Error('内容不能为空');
  fs.mkdirSync(CONFIG.ACTIONS_DIR, { recursive: true });
  const p = filePath(action);
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, HEADER(ACTION_FILES[action]) + content.trim() + '\n', 'utf8');
  fs.renameSync(tmp, p);
  return readActionSkill(action);
}
