import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import Editor, { EditorHandle } from './Editor';
import * as API from './api';
import { Basket, Source, UsedSource } from './api';

const MODELS = [
  { id: 'claude-opus-5', label: 'opus（深度·全工具）' },
  { id: 'claude-fable-5', label: 'fable（快·全工具）' },
  { id: 'deepseek-chat', label: 'DeepSeek（省额度·调研走后端工具循环）' },
];

// 从流式反馈里抽出可落笔的候选（提议→确认落笔）
function extractCandidate(md: string): { mode: 'replace' | 'insert'; text: string } | null {
  const markers: [RegExp, 'replace' | 'insert'][] = [
    [/【建议修订】/g, 'replace'],
    [/【建议插入】/g, 'insert'],
    [/【草稿】/g, 'insert'],
  ];
  let best: { idx: number; mode: 'replace' | 'insert' } | null = null;
  for (const [re, mode] of markers) {
    let m; while ((m = re.exec(md))) { if (!best || m.index > best.idx) best = { idx: m.index + m[0].length, mode }; }
  }
  if (!best) return null;
  let rest = md.slice(best.idx);
  const stop = rest.search(/\n#{1,3}\s/);
  if (stop > 0) rest = rest.slice(0, stop);
  const text = rest.replace(/^[:：\s]*\n?/, '').replace(/^```[a-z]*\n?/, '').replace(/```\s*$/, '').trim();
  return text ? { mode: best.mode, text } : null;
}

export default function App() {
  const edRef = useRef<EditorHandle>(null);
  const [tokenOk, setTokenOk] = useState<boolean | null>(null);
  const [tokenInput, setTokenInput] = useState('');
  const [drafts, setDrafts] = useState<API.Draft[]>([]);
  const [name, setName] = useState('');
  const [basket, setBasket] = useState<Basket>({ version: 1, sources: [] });
  const [model, setModel] = useState(MODELS[0].id);
  const [autoReview, setAutoReview] = useState(false);
  const [drawer, setDrawer] = useState(false);

  const [panelMd, setPanelMd] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [used, setUsed] = useState<UsedSource[]>([]);
  const [toolsSeen, setToolsSeen] = useState<string[]>([]);
  const [statusLine, setStatusLine] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [selection, setSelection] = useState('');
  const [question, setQuestion] = useState('');
  const [publishUrl, setPublishUrl] = useState('');
  const [pendingInsert, setPendingInsert] = useState('');
  const [saveState, setSaveState] = useState<'saved' | 'dirty' | 'saving'>('saved'); // 保存状态
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // 多 agent 助手（次要 opt-in）
  const [showAgents, setShowAgents] = useState(false);
  const [agentType, setAgentType] = useState<'write' | 'research'>('research');
  const [agentInstr, setAgentInstr] = useState('');
  const [runs, setRuns] = useState<Record<string, { id: string; type: string; instruction: string; text: string; status: string; scratchPath?: string; tools: number; lastTool: string; startTs: number }>>({});
  const [taskBudget, setTaskBudget] = useState<API.TaskBudget | null>(null);
  const [toast, setToast] = useState('');
  const [researchHist, setResearchHist] = useState<API.ResearchOutput[] | null>(null);
  const [, setTick] = useState(0); // 驱动"已用 Ns"刷新
  // 版本历史（NAS 回收站）
  const [showVersions, setShowVersions] = useState(false);
  const [versions, setVersions] = useState<API.Version[] | null>(null);
  const [versionsErr, setVersionsErr] = useState('');
  const [versionPreview, setVersionPreview] = useState<{ file: string; content: string } | null>(null);
  // 实体挂载（公司/人/产品 = L2 事实页；维度 = L3 只读）
  const [showEntities, setShowEntities] = useState(false);
  const [entType, setEntType] = useState<'公司' | '人' | '产品' | '维度L3'>('公司');
  const [kbEnts, setKbEnts] = useState<Record<string, API.KbEntity[]> | null>(null);
  // 技能挂载 + 动作技能
  const [allSkills, setAllSkills] = useState<API.InstalledSkill[] | null>(null);
  const [showAllSkills, setShowAllSkills] = useState(false);
  const [editAction, setEditAction] = useState<API.ActionSkill | null>(null);
  const [actionDraft, setActionDraft] = useState('');
  const mountedSkills = basket.skills || [];

  const loadingRef = useRef(false);
  const saveTimer = useRef<number | undefined>(undefined);
  const autoTimer = useRef<number | undefined>(undefined);
  const mdRef = useRef('');
  const nameRef = useRef('');            // beforeunload 闭包用
  const dirtyRef = useRef(false);        // beforeunload 闭包用

  // ---- 本地恢复缓冲（localStorage）：即使没点保存、后退/崩溃/刷新也不丢 ----
  const localKey = (n: string) => `kbw-draft:${n}`;
  const writeLocal = (n: string, md: string) => { try { localStorage.setItem(localKey(n), JSON.stringify({ markdown: md, ts: Date.now() })); } catch { /* 满了忽略 */ } };
  const readLocal = (n: string): { markdown: string; ts: number } | null => { try { const s = localStorage.getItem(localKey(n)); return s ? JSON.parse(s) : null; } catch { return null; } };
  const setSave = (s: 'saved' | 'dirty' | 'saving') => { setSaveState(s); dirtyRef.current = (s !== 'saved'); };

  // ---- boot ----
  const refreshDrafts = useCallback(async () => setDrafts(await API.listDrafts()), []);
  useEffect(() => {
    API.getToken();
    API.health().then(() => { setTokenOk(true); refreshDrafts(); })
      .catch((e) => setTokenOk(e.message === 'unauthorized' ? false : false));
  }, [refreshDrafts]);

  const saveToken = async () => {
    API.setToken(tokenInput);
    try { await API.health(); setTokenOk(true); refreshDrafts(); } catch { setTokenOk(false); }
  };

  // ---- 防误退/误关：有未保存改动时拦截后退/关标签/刷新；离开前最后 flush 本地缓冲 ----
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (nameRef.current && mdRef.current) writeLocal(nameRef.current, mdRef.current); // 同步落本地，可靠
      if (dirtyRef.current) { e.preventDefault(); e.returnValue = ''; return ''; }      // 触发浏览器"确定离开?"
      return undefined;
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // 有任务在跑时每秒刷新一次，驱动"已用 Ns"进度
  const anyRunning = Object.values(runs).some((r) => r.status === 'running');
  useEffect(() => {
    if (!anyRunning) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [anyRunning]);

  // ---- draft ops ----
  const openDraft = async (n: string) => {
    if (!n) return;
    const d = await API.loadDraft(n);
    loadingRef.current = true;
    setName(n); nameRef.current = n;
    let md = d.markdown || '';
    // 本地恢复：若 localStorage 有一份与服务器不同的未保存编辑 → 提示恢复
    const local = readLocal(n);
    if (local && typeof local.markdown === 'string' && local.markdown !== md && local.markdown.trim()) {
      const when = new Date(local.ts).toLocaleString();
      if (window.confirm(`「${n}」检测到一份本地未保存的编辑（${when}），与服务器已保存版本不同。\n\n确定 = 恢复这份未保存的编辑；\n取消 = 用服务器已保存的版本。`)) {
        md = local.markdown;
        edRef.current?.setMarkdown(md); mdRef.current = md;
        setBasket(d.basket || { version: 1, sources: [] });
        setPanelMd(''); setUsed([]); setToolsSeen([]); setStatusLine('已恢复本地未保存的编辑（记得点保存）'); setPublishUrl(''); setErrorMsg('');
        setSave('dirty'); setSavedAt(null);
        setTimeout(() => { loadingRef.current = false; }, 200);
        return;
      }
      writeLocal(n, md); // 用户选服务器版 → 清掉陈旧的本地恢复
    }
    edRef.current?.setMarkdown(md);
    mdRef.current = md;
    writeLocal(n, md);
    setBasket(d.basket || { version: 1, sources: [] });
    setPanelMd(d.feedback ? `> 已有旁批 \`${n}.反馈.md\`（下方为历史反馈）\n\n${d.feedback}` : '');
    setUsed([]); setToolsSeen([]); setStatusLine(''); setPublishUrl(''); setErrorMsg('');
    setSave('saved'); setSavedAt(Date.now());
    setTimeout(() => { loadingRef.current = false; }, 200);
  };

  const newDraft = async () => {
    const n = prompt('新草稿标题（会存为 kb/writing/<标题>.md）');
    if (!n) return;
    await API.saveDraft(n, `# ${n}\n\n`);
    await refreshDrafts();
    openDraft(n);
  };

  // 立即 flush 到 NAS（保存按钮 / 失焦 / beforeunload 前调用）
  const saveNow = async () => {
    if (!name) return;
    window.clearTimeout(saveTimer.current);
    const md = mdRef.current;
    setSave('saving');
    try { await API.saveDraft(name, md); setSave('saved'); setSavedAt(Date.now()); writeLocal(name, md); }
    catch (e: any) { setSave('dirty'); setErrorMsg('保存失败：' + (e.message || e) + '（内容仍在本地缓冲，别关页面，稍后重试保存）'); }
  };

  const onEditorUpdate = (md: string) => {
    mdRef.current = md;
    if (loadingRef.current || !name) return;
    writeLocal(name, md);          // 触发之一：实时写本地缓冲（不丢）
    setSave('dirty');
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { saveNow(); }, 1500);  // debounce 自动存
    if (autoReview) {
      window.clearTimeout(autoTimer.current);
      autoTimer.current = window.setTimeout(() => runReview(true), 4000);
    }
  };

  // ---- streaming turn ----
  const stream = async (path: string, body: any) => {
    setStreaming(true); setPanelMd(''); setUsed([]); setToolsSeen([]); setStatusLine('分析中…'); setPublishUrl(''); setErrorMsg('');
    let acc = '';
    await API.sse(path, { ...body, name, model }, (e) => {
      if (e.type === 'context') { setUsed(e.used); }
      else if (e.type === 'tool') { setToolsSeen((t) => [...t, e.name]); setStatusLine(`agent 正在用 ${e.name}…`); }
      else if (e.type === 'delta') { acc += e.text; setPanelMd(acc); setStatusLine(''); }
      else if (e.type === 'done') { setStatusLine(`完成 · ${(e.ms / 1000).toFixed(1)}s · $${(e.cost || 0).toFixed(4)}`); setUsed(e.used || []); }
      else if (e.type === 'error') { setStatusLine(''); setErrorMsg(e.message); }
    }).catch((err) => { setStatusLine(''); setErrorMsg(err.message === 'unauthorized' ? 'token 失效，请重新进入' : ('连接中断：' + err.message + '（可重试）')); });
    setStreaming(false);
  };

  const runReview = (quick = false) => stream('/api/review', { markdown: mdRef.current, quick });
  const runAct = (action: string, extra: any = {}) => {
    const sel = edRef.current?.getSelection().text || '';
    stream('/api/act', { action, selection: sel, markdown: mdRef.current, ...extra });
  };

  // ---- 落笔候选 ----
  const candidate = useMemo(() => (streaming ? null : extractCandidate(panelMd)), [panelMd, streaming]);
  const applyCandidate = () => {
    if (!candidate) return;
    if (candidate.mode === 'replace' && selection) edRef.current?.replaceSelection(candidate.text);
    else edRef.current?.insertAtCursor(candidate.text);
    setStatusLine('已落笔（可继续编辑/撤销）');
  };

  // ---- publish feedback ----
  const doPublish = async () => {
    if (!panelMd.trim()) return;
    const header = `# ${name} · 写作反馈\n\n> 由 kb-writer 写作台生成。\n\n`;
    const r = await API.publishFeedback(name, header + panelMd);
    setPublishUrl(r.url || (r.ok ? '(已发布，未捕获链接)' : '发布失败：' + (r.log || r.error || '')));
  };

  // ---- context ops ----
  const refreshBasket = async () => setBasket(await API.getContext(name));
  const toggleSource = async (s: Source) => setBasket(await API.patchSource(name, s.id, { enabled: !s.enabled }));
  const delSource = async (s: Source) => setBasket(await API.delSource(name, s.id));
  const [uploading, setUploading] = useState(false);
  const doUpload = async (files: FileList | null) => {
    if (!files || !files.length || !name) return;
    setUploading(true);
    try {
      let b = basket;
      for (const f of Array.from(files)) { const r = await API.uploadAttachment(name, f); b = r.basket; }
      setBasket(b);
      setStatusLine(`已上传 ${files.length} 个附件为上下文源`);
    } catch (e: any) { setStatusLine('上传失败：' + e.message); }
    setUploading(false);
  };
  const addFile = async () => {
    const p = prompt('mini 本机文件的绝对路径（用于挂 mini 上已有的文件；从别的设备请用上面的「上传附件」）');
    if (!p) return;
    setBasket(await API.addSource(name, { type: 'file', path: p, label: p.split('/').pop() || p, mode: 'snapshot' }));
  };
  const addApi = async () => {
    const query = prompt('API 源查询（例：最近30天 Papablic US 亚马逊销量）', '最近30天 Papablic US 亚马逊销量');
    if (!query) return;
    const label = prompt('标签', 'papablic-data 销量') || 'papablic-data';
    setBasket(await API.addSource(name, { type: 'api', skill: 'papablic-data', query, label, mode: 'live' }));
  };
  const setMode = async (s: Source, mode: string) => {
    try { setBasket(await API.patchSource(name, s.id, { mode })); }
    catch (e: any) { setErrorMsg(String(e.message || e)); }   // entity-all 切 full 超限会被 400 拒绝
  };
  // ---- 实体挂载 ----
  const openEntityPicker = async () => {
    setShowEntities(true);
    if (!kbEnts) { try { setKbEnts(await API.getKbEntities()); } catch (e: any) { setErrorMsg('读实体清单失败：' + (e.message || e)); setKbEnts({}); } }
  };
  const entitySrcOf = (t: string, n: string) => basket.sources.find((s) => s.type === 'entity' && s.entityType === t && (s.entity === n || s.label === n));
  const toggleEntity = async (t: string, n: string) => {
    const ex = entitySrcOf(t, n);
    try {
      if (ex) setBasket(await API.delSource(name, ex.id));
      else setBasket(await API.addSource(name, { type: 'entity', entityType: t, entity: n, mode: 'snapshot', label: n }));
    } catch (e: any) { setErrorMsg('挂实体失败：' + (e.message || e)); }
  };
  const entityAllSrcOf = (t: string) => basket.sources.find((s) => s.type === 'entity-all' && s.entityType === t);
  const toggleEntityAll = async (t: string) => {
    const ex = entityAllSrcOf(t);
    try {
      if (ex) setBasket(await API.delSource(name, ex.id));
      else setBasket(await API.addSource(name, { type: 'entity-all', entityType: t, mode: 'index', label: `所有${t}` }));
    } catch (e: any) { setErrorMsg(String(e.message || e)); }
  };
  const dimSrcOf = (p?: string) => basket.sources.find((s) => s.type === 'file' && s.path === p);
  const toggleDim = async (d: API.KbEntity) => {
    if (!d.path) return;
    const ex = dimSrcOf(d.path);
    try {
      if (ex) setBasket(await API.delSource(name, ex.id));
      else setBasket(await API.addSource(name, { type: 'file', path: d.path, label: `L3·${d.name}`, mode: 'snapshot' }));
    } catch (e: any) { setErrorMsg(String(e.message || e)); }
  };
  const snapshot = async (s: Source) => {
    setStatusLine(`钉 ${s.label} 快照中（claude 现拉，约 1-2 分钟）…`);
    try { const r = await API.snapshotSource(name, s.id, model); setBasket(r.basket); setStatusLine('快照已钉：' + (r.snapshotAt || '')); }
    catch (e: any) { setStatusLine('快照失败：' + e.message); }
  };

  // ---- 多 agent 编排（次要助手；补写产出要过审再落笔）----
  const openAgents = async () => { setShowAgents(true); setResearchHist(null); if (name) { try { setTaskBudget(await API.getTasks(name)); } catch { /* noop */ } loadHistory(); } };
  const dispatchTask = async () => {
    if (!name || !agentInstr.trim() || streaming) return;
    const sel = edRef.current?.getSelection().text || '';
    const instr = agentInstr; setAgentInstr('');
    await API.runTask({ name, type: agentType, instruction: instr, selection: sel, model }, (e) => {
      if (e.type === 'started') setRuns((r) => ({ ...r, [e.id]: { id: e.id, type: agentType, instruction: instr, text: '', status: 'running', tools: 0, lastTool: '', startTs: Date.now() } }));
      else if (e.type === 'tool') setRuns((r) => (r[e.id] ? { ...r, [e.id]: { ...r[e.id], tools: r[e.id].tools + 1, lastTool: e.name } } : r));
      else if (e.type === 'delta') setRuns((r) => (r[e.id] ? { ...r, [e.id]: { ...r[e.id], text: r[e.id].text + e.text } } : r));
      else if (e.type === 'done') { setRuns((r) => (r[e.id] ? { ...r, [e.id]: { ...r[e.id], status: 'done', scratchPath: e.scratchPath } } : r)); if (e.budget) setTaskBudget(e.budget); loadHistory(); }
      else if (e.type === 'error') { if (e.id) setRuns((r) => (r[e.id] ? { ...r, [e.id]: { ...r[e.id], status: 'error', text: r[e.id].text + '\n[出错] ' + e.message } } : r)); else setErrorMsg(e.message); }
    });
  };
  const showToast = (msg: string) => { setToast(msg); window.setTimeout(() => setToast(''), 3500); };
  // 审 agent 补写的产出（落笔前过"对不对"，结果进主审查面板）
  const auditRun = (runText: string) => {
    const cand = extractCandidate(runText);
    const t = cand ? cand.text : runText;
    setPendingInsert(t);
    setShowAgents(false);
    stream('/api/act', { action: 'audit', selection: t });
  };
  // 把一份产出加为上下文源（供 live run 与 历史 共用）——修 Bug2：缺文件不再静默 no-op
  const addOutputAsSource = async (opts: { path?: string; instruction: string }) => {
    if (!opts.path) { setErrorMsg('这个任务没有产出可加入（可能未跑完 / 超时 / 被取消）。重新派一次调研再加。'); return; }
    try {
      const b = await API.addSource(name, { type: 'file', path: opts.path, label: `调研:${opts.instruction.slice(0, 20)}`, mode: 'snapshot' });
      setBasket(b);
      showToast('✓ 已加入上下文（下次批改会带上这份调研）');
    } catch (e: any) { setErrorMsg('加入上下文失败：' + (e.message || e)); }
  };
  const loadHistory = async () => { if (!name) return; try { setResearchHist((await API.getResearch(name)).outputs); } catch { setResearchHist([]); } };

  // ---- 技能挂载 ----
  const openSkillPicker = async () => {
    setShowAllSkills(true);
    if (!allSkills) { try { setAllSkills(await API.getInstalledSkills()); } catch { setAllSkills([]); } }
  };
  const saveMounted = async (list: string[]) => setBasket(await API.setDocSkills(name, list));
  const toggleMount = (skill: string) => {
    const has = mountedSkills.includes(skill);
    saveMounted(has ? mountedSkills.filter((x) => x !== skill) : [...mountedSkills, skill]);
  };
  const moveSkill = (i: number, dir: -1 | 1) => {
    const j = i + dir; if (j < 0 || j >= mountedSkills.length) return;
    const list = [...mountedSkills];[list[i], list[j]] = [list[j], list[i]];
    saveMounted(list);
  };
  // ---- 动作技能 查看/重写 ----
  const openActionEdit = async (action: string) => {
    try { const r = await API.getActionSkill(action); setEditAction(r); setActionDraft(r.content); } catch (e: any) { setErrorMsg('读取动作技能失败：' + e.message); }
  };
  const saveActionSkill = async () => {
    if (!editAction) return;
    try { const r = await API.putActionSkill(editAction.action, actionDraft); setEditAction(r); showToast(`✓ 「${r.zh}」已更新（下次点击立即生效）`); }
    catch (e: any) { setErrorMsg('保存动作技能失败：' + e.message); }
  };

  // ---- 版本历史 ----
  const openVersions = async () => {
    setShowVersions(true); setVersions(null); setVersionsErr(''); setVersionPreview(null);
    try { const r = await API.getVersions(name); setVersions(r.versions); if (!r.available) setVersionsErr('NAS 回收站不可读'); }
    catch (e: any) { setVersionsErr(e.message?.includes('404') || e.message?.includes('Cannot') ? '版本历史需重启一次后端才生效（新功能）。' : ('读取失败：' + e.message)); }
  };
  const doRestore = async (file: string) => {
    if (!window.confirm('恢复这个历史版本为一个「新文件」（不覆盖当前草稿）？之后可对照/合并。')) return;
    const r = await API.restoreVersion(name, file);
    await refreshDrafts(); setShowVersions(false); setVersionPreview(null);
    openDraft(r.name);
  };

  const panelHtml = useMemo(() => marked.parse(panelMd || '') as string, [panelMd]);

  if (tokenOk === false) {
    return (
      <div className="token-gate">
        <h2>kb-writer 写作台</h2>
        <p>请输入访问 token（后端启动日志里打印，或用 <code>?token=…</code> 打开）。</p>
        <input value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} placeholder="粘贴 token" />
        <button onClick={saveToken}>进入</button>
      </div>
    );
  }
  if (tokenOk === null) return <div className="token-gate"><p>连接后端中…</p></div>;

  return (
    <div className="app">
      <header className="topbar">
        <b>kb-writer 写作台</b>
        <select value={name} onChange={(e) => openDraft(e.target.value)}>
          <option value="">— 选草稿 —</option>
          {drafts.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
        </select>
        <button onClick={newDraft}>+ 新建</button>
        {name && (
          <>
            <button className={saveState === 'dirty' ? 'primary' : ''} disabled={!name || saveState === 'saving'} onClick={saveNow} title="立即保存到 NAS（也有自动存兜底）">
              {saveState === 'saving' ? '保存中…' : '保存'}
            </button>
            <span className={`savestate ${saveState}`}>
              {saveState === 'saved' ? `已保存 ${savedAt ? new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}`
                : saveState === 'saving' ? '保存中…' : '● 未保存·有改动'}
            </span>
          </>
        )}
        <span className="spacer" />
        <label className="model">
          模型 <select value={model} onChange={(e) => setModel(e.target.value)}>
            {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>
        <label className="switch"><input type="checkbox" checked={autoReview} onChange={(e) => setAutoReview(e.target.checked)} /> 停顿即评</label>
        <button onClick={() => { setDrawer(true); refreshBasket(); if (!allSkills) API.getInstalledSkills().then(setAllSkills).catch(() => setAllSkills([])); }}>上下文 ({basket.sources.filter((s) => s.enabled).length}){mountedSkills.length > 0 ? ` ·技${mountedSkills.length}` : ''}</button>
        <button className={showAgents ? 'on' : ''} onClick={() => (showAgents ? setShowAgents(false) : openAgents())} title="次要助手：并行派 补写/调研 子任务，产出要过审才落笔">多 agent 助手</button>
        {name && <button onClick={openVersions} title="NAS 回收站里每次自动存的历史版本，可恢复成新文件">版本历史</button>}
      </header>

      <div className="body">
        <section className="left">
          {!name && <div className="hint">选一篇草稿或新建，开始写。草稿存到 kb/writing/。</div>}
          <Editor ref={edRef} onUpdate={onEditorUpdate} onSelectionChange={setSelection} onBlur={() => { if (dirtyRef.current) saveNow(); }} />
        </section>

        <section className="right">
          <div className="actions">
            <button className="primary" disabled={!name || streaming} onClick={() => runReview(false)}>批改整篇</button>
            <span className="sel-actions" data-active={!!selection}>
              <button disabled={!selection || streaming} onClick={() => runAct('supplement')}>补充</button>
              <button disabled={!selection || streaming} onClick={() => runAct('revise')}>修正</button>
              <button disabled={!selection || streaming} onClick={() => runAct('question')}>提问</button>
              <button disabled={!selection || streaming} onClick={() => runAct('draft')}>一起写</button>
            </span>
          </div>
          <div className="ask-row">
            <input value={question} placeholder={selection ? '就选中这段问一句…' : '先在左边选一段文字'} disabled={!selection || streaming}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && question && selection) { runAct('ask', { question }); setQuestion(''); } }} />
            <button disabled={!selection || !question || streaming} onClick={() => { runAct('ask', { question }); setQuestion(''); }}>问</button>
          </div>

          {(used.length > 0 || toolsSeen.length > 0) && (
            <div className="trace">
              上下文：{used.map((u) => <span key={u.id} className={`chip ${u.mode}`}>{u.label}·{u.mode}</span>)}
              {toolsSeen.length > 0 && <> ｜ 工具：{[...new Set(toolsSeen)].map((t) => <span key={t} className="chip tool">{t}</span>)}</>}
            </div>
          )}
          {errorMsg && (
            <div className="errbanner">
              ⚠️ {errorMsg}
              {/credit|额度|usage/i.test(errorMsg) && <span> — fable 额度已耗尽，请用 opus（顶部模型切 opus）。</span>}
            </div>
          )}
          {statusLine && <div className="status">{statusLine}</div>}

          {pendingInsert && !streaming && (
            <div className="candidate">
              <div className="cand-head">已审 · 这段是 agent 补写的,确认才落笔(上面是它的"对不对")</div>
              <pre>{pendingInsert}</pre>
              <button className="primary" onClick={() => { edRef.current?.insertAtCursor(pendingInsert); setPendingInsert(''); setStatusLine('已落笔'); }}>确认落笔</button>
              <button onClick={() => { setPendingInsert(''); setStatusLine('已弃用这段'); }}>弃用</button>
            </div>
          )}
          {candidate && (
            <div className="candidate">
              <div className="cand-head">agent 提议（{candidate.mode === 'replace' ? '替换选中段' : '插入正文'}）— 确认才落笔</div>
              <pre>{candidate.text}</pre>
              <button className="primary" onClick={applyCandidate}>确认落笔</button>
              <button onClick={() => setStatusLine('已忽略提议')}>忽略</button>
            </div>
          )}

          <div className="feedback" dangerouslySetInnerHTML={{ __html: panelHtml }} />

          {panelMd && !streaming && (
            <div className="publish">
              <button onClick={doPublish}>发布反馈到 /kbpub（手机可看）</button>
              {publishUrl && <a href={publishUrl} target="_blank" rel="noreferrer">{publishUrl}</a>}
            </div>
          )}

          {showAgents && (
            <div className="agents">
              <div className="agents-head">
                <b>多 agent 助手</b><span className="muted">（次要 · 审「对不对」才是主）</span>
                {taskBudget && <span className="budget">并发 {taskBudget.running}/{taskBudget.maxParallel} · 花费 ${taskBudget.spent}/${taskBudget.budget}</span>}
              </div>
              <p className="muted">派并行子任务:补写(帮起草一段)/调研(收集带源素材)。**产出不直接进正文**——补写要先「审这段」过一遍对不对,调研可加成上下文源。</p>
              <div className="agents-input">
                <select value={agentType} onChange={(e) => setAgentType(e.target.value as any)}>
                  <option value="research">调研（读网页/KB，收素材）</option>
                  <option value="write">补写（帮起草一段）</option>
                </select>
                <input value={agentInstr} placeholder={agentType === 'research' ? '调研什么（如：安克海外渠道结构）' : '补写什么（如：扩写"浅海战略"这段）'}
                  onChange={(e) => setAgentInstr(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') dispatchTask(); }} />
                <button className="primary" disabled={!name || !agentInstr.trim()} onClick={dispatchTask}>派</button>
              </div>
              {Object.values(runs).slice().reverse().map((r) => (
                <div key={r.id} className={`run ${r.status}`}>
                  <div className="run-head"><span className="chip">{r.type === 'research' ? '调研' : '补写'}</span> {r.instruction} <span className="muted">· {r.status}</span></div>
                  {r.status === 'running' && (
                    <div className="progress">⏳ {r.type === 'research' ? '调研中' : '补写中'} · 已用 {r.tools} 个工具 · 已 {Math.round((Date.now() - r.startTs) / 1000)}s{r.lastTool ? ` · 当前:${r.lastTool}` : ''}{!r.text ? '（生成正文前先在查资料，稍等）' : ''}</div>
                  )}
                  {r.text && <div className="run-body" dangerouslySetInnerHTML={{ __html: marked.parse(r.text) as string }} />}
                  {r.status === 'running' && <button onClick={async () => { try { await API.cancelTask(name, r.id); setRuns((rr) => (rr[r.id] ? { ...rr, [r.id]: { ...rr[r.id], status: 'cancelled' } } : rr)); setTaskBudget(await API.getTasks(name)); } catch { /* noop */ } }}>取消</button>}
                  {r.status === 'done' && r.type === 'write' && <button className="primary" onClick={() => auditRun(r.text)}>审这段对不对 →</button>}
                  {r.status === 'done' && r.type === 'research' && <button onClick={() => addOutputAsSource({ path: r.scratchPath, instruction: r.instruction })}>加为上下文源</button>}
                </div>
              ))}

              <div className="history">
                <div className="agents-head"><b>过往调研/补写</b><span className="muted">（磁盘持久化 · 刷新/重启都在）</span></div>
                {researchHist === null && <p className="muted">读取中…</p>}
                {researchHist && researchHist.length === 0 && <p className="muted">这篇还没有过往 agent 产出。</p>}
                {researchHist && researchHist.map((h) => (
                  <div key={h.file} className="run">
                    <div className="run-head"><span className="chip">{h.type === 'research' ? '调研' : '补写'}</span> {h.instruction} <span className="muted">· {new Date(h.mtime).toLocaleString()}</span></div>
                    <div className="run-body muted" style={{ fontSize: '12px' }}>{h.preview}…</div>
                    <button onClick={() => addOutputAsSource({ path: h.path, instruction: h.instruction })}>加为上下文源</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>

      {toast && <div className="toast">{toast}</div>}

      {drawer && (
        <div className="drawer-mask" onClick={() => setDrawer(false)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head"><b>上下文篮子 · {name || '（未选草稿）'}</b><button onClick={() => setDrawer(false)}>×</button></div>
            <p className="muted">这篇挂了哪些源。批改/提问时装配器汇总启用的源喂给会话。snapshot=钉一份，live=批改时现拉。</p>
            {basket.sources.map((s) => (
              <div key={s.id} className={`src ${s.enabled ? '' : 'off'}`}>
                <label><input type="checkbox" checked={s.enabled} onChange={() => toggleSource(s)} /> <b>{s.label}</b></label>
                <div className="src-meta">
                  <span className="chip">{s.type === 'entity' || s.type === 'entity-all' ? `${s.type}·${s.entityType}` : s.type}</span>
                  {s.type === 'api' && (
                    <select value={s.mode} onChange={(e) => setMode(s, e.target.value)}>
                      <option value="live">live（现拉）</option>
                      <option value="snapshot">snapshot（钉）</option>
                    </select>
                  )}
                  {s.type === 'entity' && (
                    <select value={s.mode} onChange={(e) => setMode(s, e.target.value)}>
                      <option value="snapshot">snapshot（整页塞进上下文）</option>
                      <option value="pointer">pointer（只指路，agent 自己读）</option>
                    </select>
                  )}
                  {s.type === 'entity-all' && (
                    <select value={s.mode} onChange={(e) => setMode(s, e.target.value)}>
                      <option value="index">index（索引表＋覆盖指令）</option>
                      <option value="full">full（整类全塞，≤40K 才允许）</option>
                    </select>
                  )}
                  {!['api', 'entity', 'entity-all'].includes(s.type) && <span className="chip">{s.mode}</span>}
                  {s.skill && <span className="chip">{s.skill}</span>}
                  {s.query && <span className="q">“{s.query}”</span>}
                  {s.path && <span className="q">{s.path}</span>}
                  {s.snapshotAt && <span className="q">钉于 {new Date(s.snapshotAt).toLocaleString()}</span>}
                  {s.type === 'api' && <button onClick={() => snapshot(s)}>钉快照</button>}
                  {s.type !== 'kb' && <button onClick={() => delSource(s)}>删</button>}
                </div>
                {s.snapshot && <pre className="snap">{s.snapshot.slice(0, 500)}{s.snapshot.length > 500 ? '…' : ''}</pre>}
              </div>
            ))}
            <label
              className="dropzone"
              onDragOver={(e) => { e.preventDefault(); }}
              onDrop={(e) => { e.preventDefault(); doUpload(e.dataTransfer.files); }}
            >
              <input type="file" multiple style={{ display: 'none' }} disabled={!name || uploading}
                onChange={(e) => { doUpload(e.target.files); e.currentTarget.value = ''; }} />
              {uploading ? '上传中…' : '⬆ 上传附件作为上下文（点选或拖拽；PDF / md / 文本 / 数据表）'}
            </label>
            <div className="add-src">
              <button onClick={openEntityPicker} disabled={!name} title="把 公司/人/产品 实体页（L2 事实）或维度（L3）挂进上下文">+ 挂实体</button>
              <button onClick={addApi} disabled={!name}>+ 挂 API（papablic-data）</button>
              <button onClick={addFile} disabled={!name} title="挂 mini 本机已有文件的路径">+ 挂 mini 本机文件</button>
            </div>

            <div className="skills-mount">
              <div className="drawer-head" style={{ marginTop: '14px' }}>
                <b>挂载技能</b><span className="muted">（agent 处理本文时优先用；拖动=优先序）</span>
              </div>
              {mountedSkills.length === 0 && <p className="muted">还没挂技能。点下面「挂载技能」从已装的里选。</p>}
              {mountedSkills.map((sk, i) => {
                const meta = allSkills?.find((x) => x.name === sk);
                const hidden = i >= 5;
                return (
                  <div key={sk} className="src" style={hidden ? { opacity: 0.6 } : undefined}>
                    <div><b>{i + 1}. {sk}</b>{meta?.needsBash && <span className="chip" title="带工具脚本；纯写作档只借方法论，research/api 档可调">🔧</span>}{hidden && <span className="muted"> · 常驻外（折叠）</span>}</div>
                    <div className="src-meta">
                      <button disabled={i === 0} onClick={() => moveSkill(i, -1)} title="上移（更优先）">↑</button>
                      <button disabled={i === mountedSkills.length - 1} onClick={() => moveSkill(i, 1)} title="下移">↓</button>
                      <button onClick={() => toggleMount(sk)}>卸载</button>
                      {meta?.description && <span className="q">{meta.description}</span>}
                    </div>
                  </div>
                );
              })}
              {mountedSkills.length > 5 && <p className="muted">常驻只显示前 5 个（其余折叠但仍生效）。</p>}
              <div className="add-src">
                <button onClick={openSkillPicker} disabled={!name}>＋ 挂载技能</button>
              </div>
            </div>

            <div className="skills-mount">
              <div className="drawer-head" style={{ marginTop: '14px' }}>
                <b>动作技能（补充/修正/提问/起草 的方法论，可重写）</b>
              </div>
              <p className="muted">这四个动作的行为就是这些技能文件。不满意→重写，保存后下次点击立即生效；改坏了 ~/sync 有 git 历史可回退。</p>
              <div className="add-src">
                {(['supplement', 'revise', 'question', 'draft'] as const).map((a) => (
                  <button key={a} onClick={() => openActionEdit(a)}>
                    重写「{{ supplement: '补充', revise: '修正', question: '提问', draft: '起草' }[a]}」
                  </button>
                ))}
              </div>
            </div>
          </aside>
        </div>
      )}

      {showEntities && (
        <div className="drawer-mask" onClick={() => setShowEntities(false)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head"><b>挂实体 · {name}</b><button onClick={() => setShowEntities(false)}>×</button></div>
            <p className="muted">实体页=L2 事实（每行带日期与 src，可当核查 ground truth），随便挂。snapshot=整页塞进上下文；pointer=只指路让 agent 自己读。维度=L3 主人裁定，只读挂，矛盾时以 L3 为准。</p>
            <div className="add-src">
              {(['公司', '人', '产品', '维度L3'] as const).map((t) => (
                <button key={t} className={entType === t ? 'primary' : ''} onClick={() => setEntType(t)}>{t}</button>
              ))}
            </div>
            {entType !== '维度L3' && (() => {
              const allSrc = entityAllSrcOf(entType);
              return (
                <div className="src">
                  <label><input type="checkbox" checked={!!allSrc} onChange={() => toggleEntityAll(entType)} /> <b>整类全挂（所有{entType}）</b></label>
                  <div className="src-meta">
                    {allSrc ? (
                      <select value={allSrc.mode} onChange={(e) => setMode(allSrc, e.target.value)}>
                        <option value="index">index（该类索引表＋"涉及哪家读哪页"指令）</option>
                        <option value="full">full（整类页面全塞，总量 ≤40K 才允许）</option>
                      </select>
                    ) : <span className="q">勾选后默认 index：装配时现从 _index.md 抽该类表注入</span>}
                  </div>
                </div>
              );
            })()}
            {kbEnts === null && <p className="muted">读取中…</p>}
            {kbEnts && entType !== '维度L3' && (kbEnts[entType] || []).map((ent) => {
              const on = !!entitySrcOf(entType, ent.name);
              return (
                <div key={ent.name} className={`src ${on ? '' : 'off'}`}>
                  <label><input type="checkbox" checked={on} onChange={() => toggleEntity(entType, ent.name)} /> <b>{ent.name}</b>
                    {ent.bytes != null && <span className="muted"> · {(ent.bytes / 1024).toFixed(0)}KB</span>}</label>
                </div>
              );
            })}
            {kbEnts && entType === '维度L3' && (kbEnts.dimensions || []).map((d) => {
              const on = !!dimSrcOf(d.path);
              return (
                <div key={d.name} className={`src ${on ? '' : 'off'}`}>
                  <label><input type="checkbox" checked={on} onChange={() => toggleDim(d)} /> <b>{d.name}</b> <span className="chip">L3</span></label>
                </div>
              );
            })}
            {kbEnts && entType === '维度L3' && !(kbEnts.dimensions || []).length && <p className="muted">kb/dimensions/ 下还没有维度文件。</p>}
          </aside>
        </div>
      )}

      {showAllSkills && (
        <div className="drawer-mask" onClick={() => setShowAllSkills(false)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head"><b>挂载技能 · {name}</b><button onClick={() => setShowAllSkills(false)}>×</button></div>
            <p className="muted">从本机已装技能里选，挂到这篇文档。🔧=带工具脚本（纯写作档只借其方法论，调研/API 档可真调）。</p>
            {allSkills === null && <p className="muted">读取中…</p>}
            {allSkills && allSkills.map((s) => {
              const on = mountedSkills.includes(s.name);
              return (
                <div key={s.name} className={`src ${on ? '' : 'off'}`}>
                  <label><input type="checkbox" checked={on} onChange={() => toggleMount(s.name)} /> <b>{s.name}</b>{s.needsBash && <span className="chip">🔧</span>}</label>
                  {s.description && <div className="src-meta"><span className="q">{s.description}</span></div>}
                </div>
              );
            })}
          </aside>
        </div>
      )}

      {editAction && (
        <div className="drawer-mask" onClick={() => setEditAction(null)}>
          <aside className="drawer wide" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head"><b>重写动作「{editAction.zh}」</b><button onClick={() => setEditAction(null)}>×</button></div>
            <p className="muted">
              这段是你点「{editAction.zh}」时发给 agent 的方法论。{editAction.isDefault && '（当前是内置默认，改后会写成文件）'}
              <br />文件：<code>{editAction.file}</code>
              <br />提示：想让产出能一键落笔，让 agent 用【建议插入】/【建议修订】/【草稿】起一段纯文本。
            </p>
            <textarea className="action-edit" value={actionDraft} onChange={(e) => setActionDraft(e.target.value)} rows={12} />
            <div className="add-src">
              <button className="primary" onClick={saveActionSkill}>保存</button>
              <button onClick={() => setActionDraft(editAction.content)}>还原</button>
            </div>
          </aside>
        </div>
      )}

      {showVersions && (
        <div className="drawer-mask" onClick={() => setShowVersions(false)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head"><b>版本历史 · {name}</b><button onClick={() => setShowVersions(false)}>×</button></div>
            <p className="muted">NAS 回收站里每次自动存留下的历史版本。恢复会存成**新文件**（不覆盖当前草稿），可对照/合并。</p>
            {versionsErr && <div className="errbanner">⚠️ {versionsErr}</div>}
            {versions === null && !versionsErr && <p className="muted">读取中…</p>}
            {versions && versions.length === 0 && !versionsErr && <p className="muted">这个草稿在回收站还没有历史版本（保存几次后会出现）。</p>}
            {versions && versions.map((v) => (
              <div key={v.file} className="src">
                <div><b>{new Date(v.mtime).toLocaleString()}</b> <span className="muted">· {(v.size / 1024).toFixed(1)}KB</span></div>
                <div className="src-meta">
                  <button onClick={async () => { try { setVersionPreview(await API.getVersion(v.file)); } catch (e: any) { setVersionsErr(e.message); } }}>预览</button>
                  <button className="primary" onClick={() => doRestore(v.file)}>恢复为新文件</button>
                </div>
              </div>
            ))}
            {versionPreview && (
              <div className="vpreview">
                <div className="drawer-head"><b>预览</b><button onClick={() => setVersionPreview(null)}>收起</button></div>
                <pre>{versionPreview.content.slice(0, 4000)}{versionPreview.content.length > 4000 ? '\n…（截断）' : ''}</pre>
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
