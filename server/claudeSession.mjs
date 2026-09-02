import { spawn } from 'node:child_process';
import { CONFIG } from './config.mjs';
import { buildSystemPrompt } from './systemPrompt.mjs';
import { ensureSettingsFiles } from './security.mjs';

// warm 会话：每个草稿维持一个常驻 claude 进程（stream-json I/O 模式），避免每次冷启。
// 首个 turn 付冷启代价，续问复用同一进程 + 已在上下文里的 KB/上下文源 → 秒级。
//
// 安全（换掉 bypassPermissions）：--permission-mode dontAsk + --settings <硬边界文件>。
//   - 'write' 会话：禁 Bash/网络/写，只 Read/Grep/Glob 限 kb/**（沙箱兜底）。
//   - 'api' 会话（文档挂了 live API 源）：额外放行 Skill+Bash 跑网关只读 client，
//     但 OS 沙箱把网络锁死只到网关、写只 kb/writing、读 deny 敏感目录。

const SYSTEM_PROMPT = buildSystemPrompt();
const SETTINGS = ensureSettingsFiles(); // { write, api } 路径，启动时生成（600）

function spawnClaude(model, kind) {
  const settingsFile = SETTINGS[kind] || SETTINGS.write;   // 'write' | 'api' | 'research'
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--model', model,
    '--permission-mode', 'dontAsk',        // 不在 allow 里的工具自动拒绝、不挂起
    '--settings', settingsFile,            // 硬边界（沙箱 + 权限），不加载用户 settings 的危险项
    '--setting-sources', 'project',        // 排除 ~/.claude/settings.json（含 lark-mcp 令牌）
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',   // 生产 MCP 硬关
    '--append-system-prompt', SYSTEM_PROMPT,
  ];
  return spawn(CONFIG.CLAUDE_BIN, args, {
    cwd: CONFIG.KB_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:${CONFIG.HOME}/.local/bin`,
    },
  });
}

class Session {
  constructor(name, model, kind) {
    this.name = name;
    this.model = model;
    this.kind = kind; // 'write' | 'api'
    this.proc = null;
    this.buf = '';
    this.current = null;
    this.queue = Promise.resolve();
    this.lastUsed = Date.now();
    this.sessionId = null;
  }

  ensureProc() {
    if (this.proc && !this.proc.killed && this.proc.exitCode === null) return;
    const proc = spawnClaude(this.model, this.kind);
    this.proc = proc;
    this.buf = '';
    proc.stdout.on('data', (d) => this._onStdout(d));
    proc.stderr.on('data', (d) => {
      const s = d.toString();
      if (s.trim()) console.error(`[claude:${this.name}] ${s.trimEnd()}`);
    });
    // 子进程意外退出 / stdout EOF：若还在 await result，reject（带退出码）→ 让上层 catch 释放名额，不永久挂。
    const failIfPending = (why) => {
      if (this.current) {
        const cur = this.current; this.current = null;
        if (cur.timer) clearTimeout(cur.timer);
        cur.reject(new Error(why));
      }
    };
    proc.on('exit', (code, signal) => {
      console.error(`[claude:${this.name}] exited code=${code} signal=${signal || ''}`);
      failIfPending(`claude 进程退出（code=${code}${signal ? ' signal=' + signal : ''}），任务未完成`);
      this.proc = null;
    });
    proc.on('error', (e) => { console.error(`[claude:${this.name}] proc error ${e.message}`); failIfPending(`claude 进程错误：${e.message}`); this.proc = null; });
    proc.stdout.on('end', () => failIfPending('claude 输出流意外结束（子进程可能已死）'));
    proc.stdout.on('close', () => { if (this.current && (!this.proc || this.proc.exitCode !== null)) failIfPending('claude 输出流已关闭'); });
  }

  _onStdout(d) {
    this.buf += d.toString();
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      this._onEvent(ev);
    }
  }

  _onEvent(ev) {
    if (ev.type === 'system' && ev.subtype === 'init') { this.sessionId = ev.session_id; return; }
    if (!this.current) return;
    if (ev.type === 'stream_event') {
      const st = ev.event?.type;
      if (st === 'content_block_delta' && ev.event.delta?.type === 'text_delta') {
        const t = ev.event.delta.text || '';
        this.current.text += t;
        try { this.current.onDelta(t); } catch { /* client 断开 */ }
      } else if (st === 'content_block_start' && ev.event.content_block?.type === 'tool_use') {
        // 让面板看到 agent 正在用哪个工具/skill（可追溯）
        const name = ev.event.content_block.name;
        try { this.current.onTool?.(name); } catch { /* noop */ }
      }
      return;
    }
    if (ev.type === 'result') {
      const cur = this.current;
      this.current = null;
      if (cur.timer) clearTimeout(cur.timer);   // 收到结果 → 撤看门狗
      // Bug#1 修复：额度耗尽等错误是 is_error:true + subtype:"success"，消息在 ev.result。
      // 只看 subtype 会漏掉 → 空白。这里把错误/额度消息透出去，让前端显示。
      if (ev.is_error) {
        cur.reject(new Error(ev.result || `claude 出错（subtype=${ev.subtype}）`));
      } else if (ev.subtype && ev.subtype !== 'success') {
        cur.reject(new Error(`claude result subtype=${ev.subtype}`));
      } else if (!cur.text && ev.result) {
        // 没有 delta 但 result 里有最终文本（非流式收尾）→ 用它，别丢内容
        cur.resolve({ text: ev.result, cost: ev.total_cost_usd || 0, sessionId: this.sessionId });
      } else {
        cur.resolve({ text: cur.text, cost: ev.total_cost_usd || 0, sessionId: this.sessionId });
      }
    }
  }

  // timeoutMs：超时看门狗——无论子进程死没死、流关没关，到点必 reject 并杀进程，绝不永久挂。
  send(userText, onDelta, onTool, timeoutMs) {
    const to = timeoutMs || CONFIG.SEND_TIMEOUT_MS;
    const run = () => new Promise((resolve, reject) => {
      this.lastUsed = Date.now();
      try { this.ensureProc(); } catch (e) { return reject(e); }
      const cur = { onDelta: onDelta || (() => {}), onTool, resolve, reject, text: '', timer: null };
      this.current = cur;
      cur.timer = setTimeout(() => {
        if (this.current === cur) {
          this.current = null;
          this.kill();   // 杀掉卡死进程，释放资源
          reject(new Error(`任务超时（${Math.round(to / 1000)}s），已终止`));
        }
      }, to);
      const msg = JSON.stringify({ type: 'user', message: { role: 'user', content: userText } }) + '\n';
      this.proc.stdin.write(msg, (err) => { if (err && this.current === cur) { this.current = null; clearTimeout(cur.timer); reject(err); } });
    }).finally(() => { this.lastUsed = Date.now(); });
    const p = this.queue.then(run, run);
    this.queue = p.then(() => {}, () => {});
    return p;
  }

  kill() {
    if (this.proc && this.proc.exitCode === null) {
      try { this.proc.stdin.end(); } catch { /* noop */ }
      try { this.proc.kill(); } catch { /* noop */ }
    }
    this.proc = null;
  }
}

const sessions = new Map();

// kind：'write'（纯写作，禁 Bash/网络）或 'api'（挂了 live API 源，放行网关只读 client）。
// model 或 kind 变了就重建会话（换更严格/更宽松的边界）。
export function getSession(name, model, kind = 'write') {
  const m = model || CONFIG.DEFAULT_MODEL;
  let s = sessions.get(name);
  if (s && (s.model !== m || s.kind !== kind)) { s.kill(); s = null; }
  if (!s) { s = new Session(name, m, kind); sessions.set(name, s); }
  return s;
}

// 一次性 claude 调用（用于钉 API 快照：复用 skill 拉一次真数，返回文本）。默认 api 边界。
export function oneShot(prompt, { model, kind = 'api' } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawnClaude(model || CONFIG.DEFAULT_MODEL, kind);
    let buf = '', text = '', done = false;
    const finish = (fn, arg) => { if (!done) { done = true; try { proc.stdin.end(); } catch {} try { proc.kill(); } catch {} fn(arg); } };
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event.delta?.type === 'text_delta') text += ev.event.delta.text || '';
        else if (ev.type === 'result') {
          if (ev.is_error) finish(reject, new Error(ev.result || `claude 出错（subtype=${ev.subtype}）`));
          else finish(resolve, { text: text || ev.result || '', cost: ev.total_cost_usd || 0 });
        }
      }
    });
    proc.stderr.on('data', (d) => { const s = d.toString(); if (s.trim()) console.error(`[oneshot] ${s.trimEnd()}`); });
    proc.on('exit', (code) => finish(code === 0 ? resolve : reject, code === 0 ? { text, cost: 0 } : new Error(`oneShot claude exited ${code}`)));
    proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n');
    setTimeout(() => finish(reject, new Error('oneShot 超时')), 240000);
  });
}

setInterval(() => {
  const now = Date.now();
  for (const [name, s] of sessions) {
    if (now - s.lastUsed > CONFIG.SESSION_IDLE_MS) { s.kill(); sessions.delete(name); console.error(`[claude:${name}] 空闲回收`); }
  }
}, 60 * 1000).unref();

// 回收指定会话（一次性任务跑完调用，不常驻）。
export function killSession(name) {
  const s = sessions.get(name);
  if (s) { s.kill(); sessions.delete(name); }
}

export function shutdownAll() { for (const s of sessions.values()) s.kill(); sessions.clear(); }
