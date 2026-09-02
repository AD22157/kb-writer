import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG, WRITING_DIR } from './config.mjs';
import { getSession, killSession } from './claudeSession.mjs';
import { assemble } from './contextAssembler.mjs';
import { isAgentic, runCompletion } from './providers.mjs';
import { runDeepseekResearch } from './deepseekAgent.mjs';
import { buildNonAgenticSystemPrompt, buildDeepseekResearchSystemPrompt } from './systemPrompt.mjs';
import { scheduleExtraction } from './memoryExtractor.mjs';

// 文档内多 agent 编排：从一篇文档并行派 N 个"按档 scoped"的子任务。
//   · 补写(write 档) / 调研(research 档)——各用自己那档 settings+沙箱，进程隔离，不逃档。
//   · 护栏：每文档并发上限 + 累计花费上限，防一键把额度打光。
//   · 产出落 scratch（kb/writing/_research/<草稿>/），人审后才进正文/转上下文源——不直接改正文。
//   · 主次：审"对不对"是主视图；这里是侧边 opt-in 助手；补写产出要过审查才落笔（前端流程保证）。

const runningByDoc = new Map();   // name -> Set<taskId>
const spentByDoc = new Map();     // name -> cumulative USD
const tasks = new Map();          // taskId -> {id,name,type,instruction,status,cost,createdAt,scratchPath}

const nfc = (s) => s.normalize('NFC');
const runningCount = (name) => (runningByDoc.get(name)?.size || 0);
const spent = (name) => spentByDoc.get(name) || 0;

export function budgetState(name) {
  return {
    running: runningCount(name),
    maxParallel: CONFIG.MAX_PARALLEL_TASKS,
    spent: Number(spent(name).toFixed(4)),
    budget: CONFIG.DOC_BUDGET_USD,
    tasks: [...tasks.values()].filter((t) => t.name === name)
      .map((t) => ({ id: t.id, type: t.type, status: t.status, cost: Number((t.cost || 0).toFixed(4)), instruction: t.instruction, scratchPath: t.scratchPath })),
  };
}

export function canStart(name) {
  if (runningCount(name) >= CONFIG.MAX_PARALLEL_TASKS) return { ok: false, reason: `并发已达上限（${CONFIG.MAX_PARALLEL_TASKS}），等一个任务完成再派` };
  if (spent(name) >= CONFIG.DOC_BUDGET_USD) return { ok: false, reason: `本文档累计花费已达上限 $${CONFIG.DOC_BUDGET_USD}，护栏拦下（可调 KB_WRITER_DOC_BUDGET_USD）` };
  return { ok: true };
}

const TASK_PROMPT = {
  write: (name, instruction, selection, ctx) =>
    `【补写子任务】文档《${name}》。${selection ? `选段：\n「${selection}」\n` : ''}任务：${instruction}\n\n` +
    `基于知识库与已挂上下文帮我起草这一段（事实处带 src、判断处标"建议"）。用 \`【草稿】\` 单独起一段给出可插入的纯文本；这段稍后要过"对不对"审查、我确认才落笔，所以只求准与有据，不堆字。${ctx || ''}`,
  research: (name, instruction, selection, ctx) =>
    `【调研子任务】文档《${name}》。${selection ? `围绕选段：\n「${selection}」\n` : ''}调研任务：${instruction}\n\n` +
    `用可用工具（知识库只读检索 + 网页搜索 + 白名单域抓取 + Reddit/arctic-shift）收集**带来源**的事实素材，输出一段可引用的调研小结：每条事实后跟出处（KB src 或 URL）。只收事实、标不确定项，不下结论、不替我写正文。${ctx || ''}`,
};

// 启动一个任务，流式回调 onEvent({type,...})。成功后把产出写进 scratch（服务端可信写，agent 只读）。
export async function startTask(name, type, instruction, selection, model, onEvent) {
  const gate = canStart(name);
  if (!gate.ok) { onEvent({ type: 'error', message: gate.reason }); return; }
  const id = 't-' + crypto.randomBytes(4).toString('hex');
  const kind = type === 'research' ? 'research' : 'write';
  const task = { id, name, type, instruction, status: 'running', cost: 0, createdAt: Date.now(), scratchPath: null };
  tasks.set(id, task);
  if (!runningByDoc.has(name)) runningByDoc.set(name, new Set());
  runningByDoc.get(name).add(id);

  const mid = model || CONFIG.DEFAULT_MODEL;
  const agentic = isAgentic(mid);
  // research + deepseek 不再拒绝：走后端工具循环（kb_read/web_search/web_fetch/reddit，后端替它执行）。
  const dsResearch = kind === 'research' && !agentic;
  const { contextBlock } = assemble(name, { agentic, kbTool: dsResearch });
  const sessionKey = `task:${id}`;
  const session = agentic ? getSession(sessionKey, mid, kind) : null;
  onEvent({ type: 'started', id, kind: agentic ? kind : (dsResearch ? 'deepseek-tools' : 'completion') });
  let out = '';
  try {
    const timeoutMs = kind === 'research' ? CONFIG.TASK_TIMEOUT_RESEARCH_MS : CONFIG.TASK_TIMEOUT_WRITE_MS;
    const prompt = TASK_PROMPT[kind](name, instruction, selection, contextBlock);
    const { text, cost } = agentic
      ? await session.send(
          prompt,
          (t) => { out += t; onEvent({ type: 'delta', id, text: t }); },
          (tool) => onEvent({ type: 'tool', id, name: tool }),
          timeoutMs,   // 超时看门狗：research 8min / write 4min（env 可调）
        )
      : dsResearch
        ? await runDeepseekResearch(mid, { system: buildDeepseekResearchSystemPrompt(), user: prompt },
            (t) => { out += t; onEvent({ type: 'delta', id, text: t }); },
            (tool) => onEvent({ type: 'tool', id, name: tool }),
            { timeoutMs })
        : await runCompletion(mid, { system: buildNonAgenticSystemPrompt(), user: prompt },
            (t) => { out += t; onEvent({ type: 'delta', id, text: t }); }, { timeoutMs });
    task.cost = cost || 0;
    task.status = 'done';
    task.scratchPath = persistScratch(name, id, type, instruction, text || out);
    spentByDoc.set(name, spent(name) + task.cost);
    runningByDoc.get(name)?.delete(id);   // 先出并发计数，再报 budget（否则 running 把自己算进去）
    onEvent({ type: 'done', id, cost: task.cost, scratchPath: task.scratchPath, budget: budgetState(name) });
    // 轮末记忆抽取：任务指令是主人原话（裁决只能逐字摘自它），产出进提案区
    scheduleExtraction(name, { label: kind === 'research' ? '调研子任务' : '补写子任务', masterText: instruction, reply: text || out });
  } catch (e) {
    task.status = 'error';
    runningByDoc.get(name)?.delete(id);
    onEvent({ type: 'error', id, message: String(e.message || e) });
  } finally {
    runningByDoc.get(name)?.delete(id);   // 兜底
    if (agentic) killSession(sessionKey);   // 一次性任务：跑完回收进程，不常驻（deepseek 无进程可回收）
  }
}

// 过往调研/补写产出（磁盘持久化，跨刷新/重启存活）：扫 _research/<草稿>/ 目录。
export function listResearchOutputs(name) {
  const dir = path.join(WRITING_DIR, '_research', nfc(name).replace(/[/\\]/g, '_'));
  if (!fs.existsSync(dir)) return { outputs: [] };
  const out = [];
  for (const fn of fs.readdirSync(dir)) {
    if (!nfc(fn).endsWith('.md')) continue;
    const p = path.join(dir, fn);
    try {
      const st = fs.statSync(p);
      const head = fs.readFileSync(p, 'utf8');
      // persistScratch 头：`# <type> · <instruction>\n\n> 子任务 <id>，<iso>，未审...\n\n<text>`
      const m = head.match(/^#\s*(\S+)\s*·\s*(.+)$/m);
      const type = m ? m[1] : (fn.startsWith('research') ? 'research' : 'write');
      const instruction = m ? m[2].trim() : fn;
      const body = head.replace(/^#[^\n]*\n+>[^\n]*\n+/, '').trim();
      out.push({ file: fn, path: p, type, instruction, mtime: st.mtimeMs, size: st.size, preview: body.slice(0, 240) });
    } catch { /* skip */ }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return { outputs: out };
}

// 手动取消一个在跑的任务：杀它的进程 → startTask 的 await reject → catch 释放名额。
export function cancelTask(name, id) {
  const t = tasks.get(id);
  if (!t || t.name !== name) return { ok: false, error: '找不到该任务' };
  if (t.status !== 'running') return { ok: false, error: `任务已是 ${t.status}` };
  t.status = 'cancelled';
  killSession(`task:${id}`);   // 杀进程 → 进程 exit → send reject → startTask catch/finally 释放名额
  runningByDoc.get(name)?.delete(id);   // 立即释放名额（catch 里还会兜底删一次）
  return { ok: true };
}

// 服务端把任务产出写进 scratch 区（agent 无写权限，由可信 node 落盘）。
function persistScratch(name, id, type, instruction, text) {
  try {
    const dir = path.join(WRITING_DIR, '_research', nfc(name).replace(/[/\\]/g, '_'));
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `${type}-${id}.md`);
    fs.writeFileSync(p, `# ${type} · ${instruction}\n\n> 子任务 ${id}，${new Date().toISOString()}，未审。人审后才可进正文/转上下文源。\n\n${text}\n`);
    return p;
  } catch { return null; }
}
