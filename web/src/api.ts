// API 客户端：token 从 localStorage 或 URL ?token= 取；SSE 走 fetch ReadableStream（可带 header）。

const TKEY = 'kb-writer-token';

export function getToken(): string {
  const url = new URL(window.location.href);
  const q = url.searchParams.get('token');
  if (q) {
    localStorage.setItem(TKEY, q);
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url.toString());
    return q;
  }
  return localStorage.getItem(TKEY) || '';
}
export function setToken(t: string) { localStorage.setItem(TKEY, t.trim()); }

function headers(json = true): Record<string, string> {
  const h: Record<string, string> = { 'x-kb-token': getToken() };
  if (json) h['content-type'] = 'application/json';
  return h;
}

export async function api(path: string, opts: RequestInit = {}) {
  const res = await fetch(path, { ...opts, headers: { ...headers(opts.body != null), ...(opts.headers || {}) } });
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

export type SseEvent =
  | { type: 'context'; used: UsedSource[]; kind: string }
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'done'; ms: number; cost: number; toolsSeen: string[]; used: UsedSource[] }
  | { type: 'error'; message: string };

export interface UsedSource { id: string; label: string; mode: string; type: string; skill?: string }

// 打开一个 SSE 流，逐事件回调。返回一个取消函数。
export async function sse(path: string, body: any, onEvent: (e: SseEvent) => void): Promise<void> {
  const res = await fetch(path, { method: 'POST', headers: headers(true), body: JSON.stringify(body) });
  if (res.status === 401) { onEvent({ type: 'error', message: 'unauthorized' }); return; }
  if (!res.ok || !res.body) { onEvent({ type: 'error', message: `HTTP ${res.status}` }); return; }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      try { onEvent(JSON.parse(line.slice(6))); } catch { /* ignore */ }
    }
  }
}

// ---- 类型 ----
export interface Draft { name: string; mtime: number }
export interface Source {
  id: string; type: string; enabled: boolean; mode: string; label: string;
  path?: string; skill?: string; query?: string; ref?: string;
  entityType?: string; entity?: string;
  snapshot?: string; snapshotAt?: string;
}
export interface Basket { version: number; sources: Source[]; skills?: string[] }

export const listDrafts = () => api('/api/drafts').then((r) => r.drafts as Draft[]);
export const loadDraft = (name: string) => api(`/api/draft?name=${encodeURIComponent(name)}`);
export const saveDraft = (name: string, markdown: string) =>
  api('/api/draft', { method: 'PUT', body: JSON.stringify({ name, markdown }) });
export const health = () => api('/api/health');

export const getContext = (name: string) => api(`/api/context?name=${encodeURIComponent(name)}`) as Promise<Basket>;
export const addSource = (name: string, source: Partial<Source>) =>
  api('/api/context/source', { method: 'POST', body: JSON.stringify({ name, source }) }) as Promise<Basket>;
export const patchSource = (name: string, id: string, patch: Partial<Source>) =>
  api('/api/context/source', { method: 'PATCH', body: JSON.stringify({ name, id, patch }) }) as Promise<Basket>;
export const delSource = (name: string, id: string) =>
  api('/api/context/source', { method: 'DELETE', body: JSON.stringify({ name, id }) }) as Promise<Basket>;
export const snapshotSource = (name: string, id: string, model?: string) =>
  api('/api/context/snapshot', { method: 'POST', body: JSON.stringify({ name, id, model }) });
export async function uploadAttachment(name: string, file: File): Promise<{ basket: Basket }> {
  const res = await fetch(`/api/context/upload?name=${encodeURIComponent(name)}&filename=${encodeURIComponent(file.name)}`, {
    method: 'POST', headers: { 'x-kb-token': getToken(), 'content-type': file.type || 'application/octet-stream' }, body: file,
  });
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}
// 实体清单（挂实体 UI 选单）：{公司:[{name,bytes}],人:[…],产品:[…],dimensions:[{name,path}]}
export interface KbEntity { name: string; bytes?: number; path?: string }
export const getKbEntities = () => api('/api/kb/entities') as Promise<Record<string, KbEntity[]>>;
export const publishFeedback = (name: string, feedbackMarkdown: string) =>
  api('/api/publish-feedback', { method: 'POST', body: JSON.stringify({ name, feedbackMarkdown }) });

// ---- 多 agent 编排 ----
export interface TaskInfo { id: string; type: string; status: string; cost: number; instruction: string; scratchPath?: string }
export interface TaskBudget { running: number; maxParallel: number; spent: number; budget: number; tasks: TaskInfo[] }
export const getTasks = (name: string) => api(`/api/tasks?name=${encodeURIComponent(name)}`) as Promise<TaskBudget>;
export const cancelTask = (name: string, id: string) => api('/api/task/cancel', { method: 'POST', body: JSON.stringify({ name, id }) }) as Promise<{ ok: boolean; error?: string }>;
export interface ResearchOutput { file: string; path: string; type: string; instruction: string; mtime: number; size: number; preview: string }
export const getResearch = (name: string) => api(`/api/research?name=${encodeURIComponent(name)}`) as Promise<{ outputs: ResearchOutput[] }>;

// ---- 技能挂载 + 动作技能 ----
export interface InstalledSkill { name: string; description: string; needsBash: boolean }
export const getInstalledSkills = () => api('/api/skills').then((r) => r.skills as InstalledSkill[]);
export const setDocSkills = (name: string, skills: string[]) =>
  api('/api/context/skills', { method: 'PUT', body: JSON.stringify({ name, skills }) }) as Promise<Basket>;
export interface ActionSkill { action: string; zh: string; content: string; isDefault: boolean; file: string }
export const getActionSkill = (action: string) => api(`/api/action-skill?action=${encodeURIComponent(action)}`) as Promise<ActionSkill>;
export const putActionSkill = (action: string, content: string) =>
  api('/api/action-skill', { method: 'PUT', body: JSON.stringify({ action, content }) }) as Promise<ActionSkill>;

// ---- 理解层（kb/dimensions，L3 主人手写区；唯一可写机器路径=这条用户 UI 路由）----
export interface Dimension { name: string; mtime: number; size: number }
export const listDimensions = () => api('/api/dimensions').then((r) => r.dimensions as Dimension[]);
export const loadDimension = (name: string) => api(`/api/dimension?name=${encodeURIComponent(name)}`) as Promise<{ name: string; markdown: string; exists: boolean }>;
export const saveDimension = (name: string, markdown: string) =>
  api('/api/dimension', { method: 'PUT', body: JSON.stringify({ name, markdown }) });

// ---- 版本历史（NAS 回收站；scope=writing 草稿 | dimensions 理解层）----
export type VersionScope = 'writing' | 'dimensions';
export interface Version { file: string; mtime: number; size: number }
export const getVersions = (name: string, scope: VersionScope = 'writing') =>
  api(`/api/versions?name=${encodeURIComponent(name)}&scope=${scope}`) as Promise<{ available: boolean; versions: Version[] }>;
export const getVersion = (file: string, scope: VersionScope = 'writing') =>
  api(`/api/version?file=${encodeURIComponent(file)}&scope=${scope}`) as Promise<{ file: string; content: string }>;
export const restoreVersion = (name: string, file: string, scope: VersionScope = 'writing') =>
  api('/api/version/restore', { method: 'POST', body: JSON.stringify({ name, file, scope }) }) as Promise<{ ok: boolean; name: string; scope: VersionScope }>;

// 派一个子任务（write=补写 / research=调研），流式回调（事件带 id）。
export async function runTask(
  body: { name: string; type: string; instruction: string; selection?: string; model?: string },
  onEvent: (e: any) => void,
): Promise<void> {
  const res = await fetch('/api/task', { method: 'POST', headers: { 'x-kb-token': getToken(), 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok || !res.body) { onEvent({ type: 'error', message: res.status === 401 ? 'unauthorized' : `HTTP ${res.status}` }); return; }
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data: ')); if (!line) continue;
      try { onEvent(JSON.parse(line.slice(6))); } catch { /* ignore */ } } }
}
