import express from 'express';
import cors from 'cors';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.mjs';
import { ensureNas, listDrafts, readDraft, writeDraft, publishFeedback, listVersions, readVersion, restoreVersion } from './kbStore.mjs';
import { getSession, shutdownAll } from './claudeSession.mjs';
import { assemble, snapshotApiSource } from './contextAssembler.mjs';
import {
  readBasket, addSource, updateSource, removeSource, writeBasket, saveAttachment,
  ENTITY_TYPES, listEntities, resolveEntityPage, classTotalChars,
} from './contextStore.mjs';
import { TOKEN, requireToken, lanAddresses } from './auth.mjs';
import { startTask, budgetState, cancelTask, listResearchOutputs } from './orchestrator.mjs';
import { isAgentic, runCompletion } from './providers.mjs';
import { buildNonAgenticSystemPrompt } from './systemPrompt.mjs';
import { ensureActionFiles, loadActionBody, readActionSkill, writeActionSkill, ACTION_FILES } from './actionSkills.mjs';
import { installedSkills } from './skillsRegistry.mjs';
import { setSkills } from './contextStore.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
ensureActionFiles();   // 把 补充/修正/提问/起草 的内置方法论迁成可编辑文件（已存在则不动）
const app = express();
app.use(cors());
app.use(express.json({ limit: '8mb' }));
app.use(requireToken);

// ---- 请求文案 ----
const reviewPrompt = (name, md, quick, ctx) => (quick
  ? `【快速核查】草稿《${name}》：只标事实性硬伤（🔴 与库矛盾 / 🟡 关键数字待核），三五条以内，不展开四块。\n\n---\n${md}\n---`
  : `【批改】以下是我当前的草稿《${name}》，请按四块结构（一、事实核查 二、可补的论据 三、结构与逻辑建议 四、与理解层的一致性）给写作反馈，逐条核查事实并引用来源（kb/entities 的 src、或接口拉到的数字口径）。\n\n---\n${md}\n---`
) + (ctx || '');

// 选段级动作：ask/supplement/revise/question/draft
// 补充/修正/提问/起草 的方法论正文从「动作技能文件」现读（~/sync/skills/QS-写作/actions/，改文件立即生效）。
function actPrompt(action, { name, selection, question, outline, md }, ctx) {
  const sel = selection ? `\n选中的这段：\n「${selection}」` : '';
  const body = (a) => loadActionBody(a).body;
  const base = {
    ask: `【选段提问】草稿《${name}》。${sel}\n\n我的问题：${question}\n\n结合上下文回答，事实级结论带来源。若建议改这段，末尾用【建议修订】给可替换选区的文本。`,
    supplement: `【补充】草稿《${name}》。${sel}\n\n${body('supplement')}`,
    revise: `【修正】草稿《${name}》。${sel}\n\n${body('revise')}`,
    question: `【提问】草稿《${name}》。${sel}\n\n${body('question')}`,
    draft: `【起草】草稿《${name}》。${selection ? sel + '\n\n请就这段' : ''}${outline ? `\n大纲/要点：${outline}` : ''}\n\n${body('draft')}`,
    // 审 agent 补写的产出：落笔前先过"对不对"。这一步是本 app 的灵魂——代笔产出也受审。
    audit: `【审这段对不对】下面这段是 agent 帮我起草/补写的，请在我落笔前审它（这是审查、不是替我写）：\n「${selection}」\n\n分三块简短判：① 事实——逐条核对库/来源，✅有据(带 src)/🔴与库矛盾/🟡查无待核；② 逻辑——推理链有无跳步/循环/以偏概全；③ 是否有据——哪些是硬事实、哪些只是 agent 的措辞或判断（标"建议级"）。最后一句给结论：可落笔 / 建议改后再落 / 不建议用。不改写正文。`,
  }[action];
  return (base || base === '' ? base : base) + (ctx || '');
}

// ---- SSE ----
function sseInit(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(': connected\n\n');
}
const sseSend = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

// 统一跑一个流式 turn（带上下文装配 + 工具追溯）。
// 非 agentic 模型（deepseek）：无工具，直连补全，吃装配器快照；调研类能力不可用（诚实边界在 system prompt）。
async function runTurn(res, { name, model, buildPrompt }) {
  const agentic = isAgentic(model);
  const { contextBlock, kind, used, skillNames } = assemble(name, { agentic });
  sseInit(res);
  sseSend(res, { type: 'context', used, kind: agentic ? kind : 'completion', skills: skillNames || [] });
  const started = Date.now();
  try {
    if (!agentic) {
      const { usage } = await runCompletion(
        model,
        { system: buildNonAgenticSystemPrompt(), user: buildPrompt(contextBlock) },
        (t) => sseSend(res, { type: 'delta', text: t }),
        { timeoutMs: CONFIG.SEND_TIMEOUT_MS },
      );
      sseSend(res, { type: 'done', ms: Date.now() - started, cost: 0, toolsSeen: [], used, usage, note: 'deepseek 直连（费用极低，未计入预算）' });
    } else {
      const session = getSession(name, model, kind);
      const toolsSeen = [];
      const { cost } = await session.send(
        buildPrompt(contextBlock),
        (t) => sseSend(res, { type: 'delta', text: t }),
        (toolName) => { toolsSeen.push(toolName); sseSend(res, { type: 'tool', name: toolName }); },
      );
      sseSend(res, { type: 'done', ms: Date.now() - started, cost, toolsSeen, used });
    }
  } catch (e) {
    sseSend(res, { type: 'error', message: String(e.message || e) });
  }
  res.end();
}

// ---- 草稿 ----
app.get('/api/health', (req, res) => res.json({ ok: true, nas: ensureNas(), model: CONFIG.DEFAULT_MODEL, port: CONFIG.PORT }));

app.get('/api/drafts', (req, res) => {
  if (!ensureNas()) return res.status(503).json({ error: 'NAS 不可用' });
  res.json({ drafts: listDrafts() });
});

app.get('/api/draft', (req, res) => {
  const name = (req.query.name || '').toString();
  if (!name) return res.status(400).json({ error: '缺少 name' });
  if (!ensureNas()) return res.status(503).json({ error: 'NAS 不可用' });
  res.json({ ...readDraft(name), basket: readBasket(name) });
});

app.put('/api/draft', (req, res) => {
  const { name, markdown } = req.body || {};
  if (!name || typeof markdown !== 'string') return res.status(400).json({ error: '缺少 name/markdown' });
  if (/[/\\]/.test(name)) return res.status(400).json({ error: 'name 不能含路径分隔符' });
  if (!ensureNas()) return res.status(503).json({ error: 'NAS 不可用' });
  res.json({ ok: true, ...writeDraft(name, markdown) });
});

// ---- 批改（整篇） ----
app.post('/api/review', async (req, res) => {
  const { name, markdown, model, quick } = req.body || {};
  if (!name || typeof markdown !== 'string') return res.status(400).json({ error: '缺少 name/markdown' });
  if (!ensureNas()) return res.status(503).json({ error: 'NAS 不可用' });
  try { writeDraft(name, markdown); } catch { /* 存盘失败不阻断 */ }
  await runTurn(res, { name, model, buildPrompt: (ctx) => reviewPrompt(name, markdown, quick, ctx) });
});

// ---- 一起写（选段级动作） ----
app.post('/api/act', async (req, res) => {
  const { name, action, selection, question, outline, markdown, model } = req.body || {};
  const ACTIONS = ['ask', 'supplement', 'revise', 'question', 'draft', 'audit'];
  if (!name || !ACTIONS.includes(action)) return res.status(400).json({ error: 'action 须为 ' + ACTIONS.join('/') });
  if (action === 'ask' && !question) return res.status(400).json({ error: 'ask 需要 question' });
  if (['audit', 'revise', 'supplement'].includes(action) && !selection) return res.status(400).json({ error: action + ' 需要 selection' });
  if (!ensureNas()) return res.status(503).json({ error: 'NAS 不可用' });
  if (typeof markdown === 'string') { try { writeDraft(name, markdown); } catch { /* noop */ } }
  await runTurn(res, { name, model, buildPrompt: (ctx) => actPrompt(action, { name, selection, question, outline, md: markdown }, ctx) });
});

// ---- 上下文篮子 ----
app.get('/api/context', (req, res) => {
  const name = (req.query.name || '').toString();
  if (!name) return res.status(400).json({ error: '缺少 name' });
  res.json(readBasket(name));
});
app.post('/api/context/source', (req, res) => {
  const { name, source } = req.body || {};
  if (!name || !source?.type) return res.status(400).json({ error: '缺少 name/source.type' });
  // 实体源：挂载时就解析/守门，别等装配时静默失败。
  if (source.type === 'entity' || source.type === 'entity-all') {
    if (!ENTITY_TYPES.includes(source.entityType)) return res.status(400).json({ error: 'entityType 须为 ' + ENTITY_TYPES.join('/') });
    if (!ensureNas()) return res.status(503).json({ error: 'NAS 不可用' });
    if (source.type === 'entity') {
      const hit = resolveEntityPage(source.entityType, source.entity);
      if (!hit) return res.status(400).json({ error: `entities/${source.entityType}/ 与 _index.md 别名表都找不到「${source.entity}」` });
      source.entity = hit.canonical;                       // 别名归一：输 "Anker" 存 "安克"
      if (!source.label) source.label = hit.canonical;
    } else {
      if (!source.label) source.label = `所有${source.entityType}`;
      if (source.mode === 'full') {
        const total = classTotalChars(source.entityType);
        if (total > CONFIG.ENTITY_ALL_FULL_LIMIT) {
          return res.status(400).json({ error: `整类「${source.entityType}」共约 ${Math.round(total / 1000)}K 字符，超过 full 上限 ${Math.round(CONFIG.ENTITY_ALL_FULL_LIMIT / 1000)}K 会打爆上下文——请用 index 模式（注入该类索引表＋覆盖指令，涉及哪家读哪页）` });
        }
      }
    }
  }
  res.json(addSource(name, source));
});
app.patch('/api/context/source', (req, res) => {
  const { name, id, patch } = req.body || {};
  if (!name || !id || !patch) return res.status(400).json({ error: '缺少 name/id/patch' });
  // entity-all 切 full 也过同一道守门（装配器还有超限自动回退 index 兜底）
  if (patch.mode === 'full') {
    const s0 = readBasket(name).sources.find((x) => x.id === id);
    if (s0?.type === 'entity-all' && ensureNas()) {
      const total = classTotalChars(s0.entityType);
      if (total > CONFIG.ENTITY_ALL_FULL_LIMIT) {
        return res.status(400).json({ error: `整类「${s0.entityType}」共约 ${Math.round(total / 1000)}K 字符 > full 上限 ${Math.round(CONFIG.ENTITY_ALL_FULL_LIMIT / 1000)}K——请用 index 模式` });
      }
    }
  }
  res.json(updateSource(name, id, patch));
});
// 实体清单（「+ 挂实体」UI 选单）：扫 entities/{公司,人,产品}，NFC 归一、剔 _模板.md；附 dimensions（L3 只读挂）。
app.get('/api/kb/entities', (req, res) => {
  if (!ensureNas()) return res.status(503).json({ error: 'NAS 不可用' });
  res.json(listEntities());
});
app.delete('/api/context/source', (req, res) => {
  const { name, id } = req.body || {};
  if (!name || !id) return res.status(400).json({ error: '缺少 name/id' });
  res.json(removeSource(name, id));
});
// 挂载技能（文档级，顺序=主人优先序；只存名字）
app.put('/api/context/skills', (req, res) => {
  const { name, skills } = req.body || {};
  if (!name || !Array.isArray(skills)) return res.status(400).json({ error: '缺少 name/skills[]' });
  res.json(setSkills(name, skills));
});
// 全局已装技能清单（挂载候选；needsBash=带工具脚本，write 档只用其方法论）
app.get('/api/skills', (req, res) => res.json({ skills: installedSkills() }));
// 动作技能（补充/修正/提问/起草 的方法论，可查看/重写；服务端可信落盘，agent 无权写）
app.get('/api/action-skill', (req, res) => {
  const action = (req.query.action || '').toString();
  const r = readActionSkill(action);
  if (!r) return res.status(400).json({ error: 'action 须为 ' + Object.keys(ACTION_FILES).join('/') });
  res.json(r);
});
app.put('/api/action-skill', (req, res) => {
  const { action, content } = req.body || {};
  try { res.json({ ok: true, ...writeActionSkill(action, content) }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// 上传附件作为上下文源（原始字节，无需 multipart 依赖）。任意设备（macbook）都能传。
app.post('/api/context/upload', express.raw({ type: '*/*', limit: '40mb' }), (req, res) => {
  const name = (req.query.name || '').toString();
  const filename = (req.query.filename || 'attachment').toString();
  if (!name) return res.status(400).json({ error: '缺少 name' });
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: '空文件' });
  if (!ensureNas()) return res.status(503).json({ error: 'NAS 不可用' });
  const saved = saveAttachment(name, filename, req.body);
  const basket = addSource(name, { type: 'file', path: saved.path, label: `${saved.name}（上传 ${(saved.bytes / 1024).toFixed(0)}KB）`, mode: 'snapshot' });
  res.json({ ok: true, ...saved, basket });
});

// 钉一份 API 快照（复用 claude+skill 现拉，写回篮子）
app.post('/api/context/snapshot', async (req, res) => {
  const { name, id, model } = req.body || {};
  if (!name || !id) return res.status(400).json({ error: '缺少 name/id' });
  const b = readBasket(name);
  const s = b.sources.find((x) => x.id === id);
  if (!s || s.type !== 'api') return res.status(400).json({ error: '不是 api 源' });
  try {
    const text = await snapshotApiSource(s.skill, s.query, model);
    s.mode = 'snapshot'; s.snapshot = text; s.snapshotAt = new Date().toISOString();
    writeBasket(name, b);
    res.json({ ok: true, snapshot: text, snapshotAt: s.snapshotAt, basket: b });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---- 版本历史（NAS 回收站每次自动存的历史版本；只读+恢复成新文件，不覆盖当前）----
app.get('/api/versions', (req, res) => {
  const name = (req.query.name || '').toString();
  if (!name) return res.status(400).json({ error: '缺少 name' });
  if (!ensureNas()) return res.status(503).json({ error: 'NAS 不可用' });
  res.json(listVersions(name));
});
app.get('/api/version', (req, res) => {
  const file = (req.query.file || '').toString();
  if (!file) return res.status(400).json({ error: '缺少 file' });
  if (!ensureNas()) return res.status(503).json({ error: 'NAS 不可用' });
  const content = readVersion(file);
  if (content == null) return res.status(404).json({ error: '找不到该版本' });
  res.json({ file, content });
});
app.post('/api/version/restore', (req, res) => {
  const { name, file } = req.body || {};
  if (!name || !file) return res.status(400).json({ error: '缺少 name/file' });
  if (!ensureNas()) return res.status(503).json({ error: 'NAS 不可用' });
  try { res.json({ ok: true, ...restoreVersion(name, file) }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- 多 agent 编排（侧边 opt-in；补写/调研并行子任务，带并发+预算护栏）----
app.get('/api/tasks', (req, res) => {
  const name = (req.query.name || '').toString();
  if (!name) return res.status(400).json({ error: '缺少 name' });
  res.json(budgetState(name));
});
app.post('/api/task', async (req, res) => {
  const { name, type, instruction, selection, model } = req.body || {};
  if (!name || !['write', 'research'].includes(type) || !instruction) return res.status(400).json({ error: '缺少 name/type(write|research)/instruction' });
  if (!ensureNas()) return res.status(503).json({ error: 'NAS 不可用' });
  sseInit(res);
  await startTask(name, type, instruction, selection, model, (ev) => sseSend(res, ev));
  res.end();
});
app.post('/api/task/cancel', (req, res) => {
  const { name, id } = req.body || {};
  if (!name || !id) return res.status(400).json({ error: '缺少 name/id' });
  res.json(cancelTask(name, id));
});
// 过往调研/补写产出（磁盘持久化，跨刷新/重启）
app.get('/api/research', (req, res) => {
  const name = (req.query.name || '').toString();
  if (!name) return res.status(400).json({ error: '缺少 name' });
  if (!ensureNas()) return res.status(503).json({ error: 'NAS 不可用' });
  res.json(listResearchOutputs(name));
});

// ---- 发布反馈到 /kbpub ----
app.post('/api/publish-feedback', async (req, res) => {
  const { name, feedbackMarkdown } = req.body || {};
  if (!name || typeof feedbackMarkdown !== 'string') return res.status(400).json({ error: '缺少 name/feedbackMarkdown' });
  if (!ensureNas()) return res.status(503).json({ error: 'NAS 不可用' });
  res.json(await publishFeedback(name, feedbackMarkdown));
});

// ---- 静态前端 ----
const DIST = path.join(__dirname, '..', 'web', 'dist');
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get('*', (req, res, next) => { if (req.path.startsWith('/api/')) return next(); res.sendFile(path.join(DIST, 'index.html')); });
}

// BIND_ADDR 可为逗号分隔多个地址：默认只 127.0.0.1；走 Tailscale 设 "127.0.0.1,100.x.x.x"
// —— 同时绑 localhost(本机方便) 与 tailnet(多端)，**绝不绑 0.0.0.0**，公司 LAN 扫不到。
const hosts = CONFIG.BIND_ADDR.split(',').map((s) => s.trim()).filter(Boolean);
const servers = hosts.map((host) => {
  const s = http.createServer(app);
  s.headersTimeout = 0;            // 允许长 SSE（冷启批改可能数分钟）
  s.requestTimeout = 0;
  s.listen(CONFIG.PORT, host);
  s.on('error', (e) => console.error(`[kb-writer] bind ${host}:${CONFIG.PORT} 失败: ${e.message}`));
  return s;
});
console.error(`[kb-writer] 监听 ${hosts.map((h) => `http://${h}:${CONFIG.PORT}`).join('  ')}  model=${CONFIG.DEFAULT_MODEL}  NAS=${ensureNas() ? 'ok' : 'unavailable'}`);
console.error(`[kb-writer] 本机 http://localhost:${CONFIG.PORT}${hosts.some((h) => h.startsWith('100.')) ? '  多端(Tailscale) http://' + hosts.find((h) => h.startsWith('100.')) + ':' + CONFIG.PORT : '  （多端设 KB_WRITER_BIND=127.0.0.1,<tailnet IP>）'}`);
// 不回显 token；只提示位置。前端首次用 ?token=<它> 打开一次，之后走 header。
console.error(`[kb-writer] token 在 ${CONFIG.LOG_DIR}/kb-writer.token（cat 它，首次 ?token= 打开）  访问日志 ${CONFIG.LOG_DIR}/kb-writer-access.log`);

const stop = () => { shutdownAll(); servers.forEach((s) => s.close()); setTimeout(() => process.exit(0), 500); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
