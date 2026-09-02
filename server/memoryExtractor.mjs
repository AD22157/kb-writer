import { CONFIG } from './config.mjs';
import { runCompletion } from './providers.mjs';
import { oneShot } from './claudeSession.mjs';
import { appendProposals, readMemory } from './memoryStore.mjs';

// 轮末记忆抽取：每次 review/act/子任务结束后，由可信 node 后端触发一次**廉价**抽取
// （默认 deepseek 直连；没 key/失败则回退 claude fable oneShot——绝不用 opus），
// 把"这轮新确立了什么、主人纠正了什么"追加进 <草稿>.memory.md 的 **agent 提案区**。
//
// 防乱改主人裁决（三道）：
//   ① 代码路径：抽取只有 appendProposals 一个落盘口——append-only、只进「agent 记的」段，
//      前四段（主人区）它根本写不到；主人区唯一写路径 = UI 的 PUT /api/memory（token 鉴权）。
//   ② 逐字校验：抽出的"主人裁决"必须是主人这轮原话的逐字子串（空白归一后包含），
//      对不上就降级成普通提案标（自述·未逐字对上），模型编不出"主人说过"。
//   ③ 注入语义：提案区注入时明确标"主人未确认，不得当主人指令"，权威只属主人区。
//
// fire-and-forget：不阻塞 SSE 响应；每文档串行（防并发读-改-写）；失败只记日志。

const chains = new Map();

export function scheduleExtraction(name, turn) {
  if (!CONFIG.MEMORY_EXTRACT) return;
  const reply = String(turn.reply || '').trim();
  if (reply.length < 60) return;                                   // 太短的轮（报错/空）不值一次抽取
  const prev = chains.get(name) || Promise.resolve();
  const next = prev
    .then(() => extractOnce(name, turn))
    .catch((e) => console.error(`[memory:${name}] 抽取失败：${String(e.message || e).slice(0, 300)}`));
  chains.set(name, next.then(() => {}, () => {}));
}

const collapse = (s) => String(s).normalize('NFC').replace(/\s+/g, '');

async function extractOnce(name, { label, masterText, reply }) {
  const master = String(masterText || '').trim();
  const mem = readMemory(name);
  const existingLines = [
    ...mem.sections.rulings, ...mem.sections.established,
    ...mem.sections.preferences, ...mem.sections.open, ...mem.sections.proposals,
  ].slice(0, 80).map((t) => `- ${t.slice(0, 160)}`).join('\n');

  const system = '你是写作台的记忆抽取器。从一轮"主人↔写作助手"交互中抽出值得跨轮、跨模型记住的条目。只输出严格 JSON，不输出任何其它文字。';
  const user = `文档《${name}》刚结束一轮「${label || '交互'}」。

【主人这轮亲口说的话（只有这一段是主人原话，可能为空）】
${master || '（这轮主人没有输入文字，只点了动作按钮）'}

【写作助手这轮的回复（可能截断）】
${String(reply).slice(0, 6000)}

【记忆里已有的条目——已有的**绝不再输出**（含意思相同只是措辞不同的）】
${existingLines || '（还没有任何记忆）'}

抽取规则：
1. rulings：主人这轮下的裁决/纠正（如"X是有意的别再标红""数字用Y不用Z""方向对，往下写"）。**必须逐字摘自上面主人原话，不许改写、不许概括**；主人没说话就输出 []。
2. established：这轮**明确核实成立**、以后不用再核/再标的结论（例：助手核过"某数字与库一致(src)"且主人未反对）。只收核过的，不收助手的猜测或建议。
3. preferences：主人对本文表现出的语气/重点/在意方向（有明确证据才收）。
4. open：这轮暴露且没解决的线头（🟡待核项、悬而未决的问题）。
5. 每类最多 3 条；没有就 []。条目要具体（带对象与结论），一条一句话。
只输出 JSON：{"rulings":[],"established":[],"preferences":[],"open":[]}`;

  const text = await runExtractModel(system, user);
  const parsed = parseJson(text);
  if (!parsed) throw new Error('抽取输出不是 JSON：' + String(text).slice(0, 120));

  const items = [];
  const arr = (v) => (Array.isArray(v) ? v : []).map((x) => String(typeof x === 'object' && x ? (x.quote || x.text || '') : x).trim()).filter(Boolean).slice(0, 3);
  const masterNorm = collapse(master);
  for (const q of arr(parsed.rulings)) {
    // ② 逐字校验：不是主人原话的子串 → 降级，绝不冒充裁决
    if (masterNorm && masterNorm.includes(collapse(q))) items.push({ tag: '裁决候选·主人原话', text: `主人说："${q}"` });
    else items.push({ tag: '已确立候选', text: `${q}（自述为主人裁决·未逐字对上，待定）` });
  }
  for (const t of arr(parsed.established)) items.push({ tag: '已确立候选', text: t });
  for (const t of arr(parsed.preferences)) items.push({ tag: '偏好候选', text: t });
  for (const t of arr(parsed.open)) items.push({ tag: '线头候选', text: t });
  if (!items.length) return;

  const r = await appendProposals(name, items, label || '轮');
  if (r.added) console.error(`[memory:${name}] 轮末抽取 +${r.added} 条提案（${label || '轮'}）`);
}

async function runExtractModel(system, user) {
  const pref = CONFIG.MEMORY_EXTRACT_MODEL;
  if (pref.startsWith('deepseek')) {
    try {
      const { text } = await runCompletion(pref, { system, user }, null, { timeoutMs: 90_000 });
      return text;
    } catch (e) {
      console.error(`[memory] deepseek 抽取失败（${String(e.message || e).slice(0, 120)}），回退 ${CONFIG.FAST_MODEL}`);
    }
  } else if (pref) {
    const { text } = await oneShot(`${system}\n\n${user}`, { model: pref, kind: 'write' });
    return text;
  }
  // 回退：claude 便宜档（fable），write 档边界（无工具需求，纯文本）
  const { text } = await oneShot(`${system}\n\n${user}`, { model: CONFIG.FAST_MODEL, kind: 'write' });
  return text;
}

function parseJson(text) {
  const t = String(text || '').replace(/```json|```/g, '').trim();
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}
