import fs from 'node:fs';
import { CONFIG } from './config.mjs';

// 模型 provider 抽象。
//   · claude-cli(默认)：全 agentic——活读 KB、调 skill、live 拉网关；安全靠 write/api/research 三档沙箱。
//   · deepseek：纯文本补全（直连 HTTP，无 shell/agent loop → 没有能力硬化那套风险）。
//     没有 skill/KB 工具，靠上下文装配器把 文件/API 快照拼成 prompt 喂过去；库里查无必须标 🟡。
// 模型下拉不写额度状态（额度是暂态；真没额度时运行时 error 事件会带原因）。

export const PROVIDERS = {
  'claude-cli': { label: 'Claude（订阅，全 agentic）', agentic: true, auth: 'subscription' },
  deepseek: { label: 'DeepSeek（直连 API，纯补全，吃上下文快照）', agentic: false, auth: 'apiKey' },
};

export function providerFor(modelId = '') {
  if (String(modelId).startsWith('deepseek')) return 'deepseek';
  return 'claude-cli';
}

export function isAgentic(modelId) {
  return PROVIDERS[providerFor(modelId)]?.agentic !== false;
}

// key 引用机器上已有位置（V3 .env.local），不复制明文；env DEEPSEEK_API_KEY 可覆盖。
function deepseekKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  try {
    const txt = fs.readFileSync(CONFIG.DEEPSEEK_KEY_FILE, 'utf8');
    const m = txt.match(/^DEEPSEEK_API_KEY=(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch { /* fallthrough */ }
  return '';
}

// 非 Claude 补全：流式（OpenAI 兼容 SSE）。onDelta(text) 逐段回调；resolve { text, usage }。
// 费用：deepseek 极低，暂不计入预算（usage 返回 tokens 供参考）。
export async function runCompletion(modelId, { system, user }, onDelta, { timeoutMs } = {}) {
  const key = deepseekKey();
  if (!key) throw new Error(`DeepSeek key 未找到（查 ${CONFIG.DEEPSEEK_KEY_FILE} 或设 DEEPSEEK_API_KEY）`);
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(new Error('deepseek 请求超时')), timeoutMs || CONFIG.SEND_TIMEOUT_MS);
  try {
    const res = await fetch(`${CONFIG.DEEPSEEK_BASE}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        messages: [ ...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: user } ],
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`deepseek HTTP ${res.status}：${body.slice(0, 300)}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', text = '', usage = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let j; try { j = JSON.parse(payload); } catch { continue; }
        const d = j.choices?.[0]?.delta?.content;
        if (d) { text += d; try { onDelta?.(d); } catch { /* client 断开 */ } }
        if (j.usage) usage = j.usage;
      }
    }
    if (!text) throw new Error('deepseek 返回为空');
    return { text, usage, cost: 0 };
  } finally { clearTimeout(to); }
}
