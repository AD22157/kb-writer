// 集中配置。launchd 环境裸，一切显式（参考 339-kb/ops/lib.sh）。
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();

export const CONFIG = {
  PORT: Number(process.env.KB_WRITER_PORT || 4177),
  // 默认只绑 localhost。走 Tailscale 私有网时把 BIND_ADDR 指到 mini 的 tailnet IP(100.x.x.x)，
  // 公司 LAN/公网扫不到端口；绝不默认绑 0.0.0.0。
  BIND_ADDR: process.env.KB_WRITER_BIND || '127.0.0.1',
  HOME,
  // 本机已登录的 claude（订阅额度，免 API key）。禁止给本 app 接独立 Anthropic API key。
  CLAUDE_BIN: process.env.KB_WRITER_CLAUDE || path.join(HOME, '.local', 'bin', 'claude'),
  // 显式 --model（settings.json 的 fable 会让 SDK 静默失效，必须显式）。默认 opus 深度批改。
  DEFAULT_MODEL: process.env.KB_WRITER_MODEL || 'claude-opus-5',
  FAST_MODEL: process.env.KB_WRITER_FAST_MODEL || 'claude-fable-5',
  KB_ROOT: process.env.KB_ROOT || '/Volumes/2026Projects/kb',
  NAS_MOUNT_URL: 'smb://qingkuai@192.168.2.250/2026Projects',
  LOG_DIR: path.join(HOME, '.kb-collector'),
  // QS-写作 的 HTML 渲染 + 发布器（唯一发布器 publish-kb-html.py 由它内部调用）
  RENDER_FEEDBACK: path.join(HOME, 'sync', 'skills', 'QS-写作', 'Tools', 'render_feedback.py'),
  PY312: '/opt/homebrew/opt/python@3.12/bin/python3.12',
  // 会话空闲多久回收（毫秒）。回收后下次请求重新冷启。
  SESSION_IDLE_MS: Number(process.env.KB_WRITER_SESSION_IDLE_MS || 20 * 60 * 1000),
  // 「curated 一手源根」= 调研最想直达的可信公网源（*.gov / 年报 / 百科 / 财经 / arctic-shift / 网关）。
  // 2026-09 改：deepseek 的 web_fetch 不再拿这份当「唯一可 fetch 的白名单」——那太窄，公司官网/IR/
  //   巴菲特年报全被拦，一手源够不着。现在 web_fetch 放开到「任意公网 http(s) + SSRF 护栏」
  //   （拒私网/环回/链路本地/云元数据，逐跳复校，见 deepseekAgent.mjs 的 assertPublicHost）。
  //   这份清单降级为「可信根」：命中它的域跳过 DNS 解析直接放行（防瞬时 DNS 抖动误伤必需源，
  //   且保证 arctic-shift / gateway 永远可达），其余域走完整 SSRF 解析校验。
  // claude 研究档的 WebFetch 同步从「按域 scoping」放宽为整体放行（见 security.mjs），使 opus 也能取一手源。
  RESEARCH_DOMAINS: (process.env.KB_RESEARCH_DOMAINS ||
    // arctic-shift = Reddit 只读存档 API（免鉴权、GET-only JSON）；gateway = 网关（必需放行，别搞丢）。
    'en.wikipedia.org,zh.wikipedia.org,github.com,raw.githubusercontent.com,sec.gov,www.annualreports.com,finance.yahoo.com,www.crunchbase.com,berkshirehathaway.com,tesla.com,arctic-shift.photon-reddit.com,gateway.papablic.com')
    .split(',').map((s) => s.trim()).filter(Boolean),
  // 多 agent 编排护栏
  MAX_PARALLEL_TASKS: Number(process.env.KB_WRITER_MAX_PARALLEL || 3),
  DOC_BUDGET_USD: Number(process.env.KB_WRITER_DOC_BUDGET_USD || 3),
  // 超时看门狗（毫秒）：任务不能无限挂
  TASK_TIMEOUT_RESEARCH_MS: Number(process.env.KB_WRITER_TASK_TIMEOUT_RESEARCH_MS || 8 * 60 * 1000),
  TASK_TIMEOUT_WRITE_MS: Number(process.env.KB_WRITER_TASK_TIMEOUT_WRITE_MS || 4 * 60 * 1000),
  // 交互式批改/动作的通用安全网（冷启大库批改可能数分钟，给宽一点，只防真卡死）
  SEND_TIMEOUT_MS: Number(process.env.KB_WRITER_SEND_TIMEOUT_MS || 12 * 60 * 1000),
  // 实体源（entity/entity-all）上下文预算：
  //   实体页专用 inline 上限（比通用文件的 24K 高——实体页是核查 ground truth，值得多给；超限带尾注不静默截）
  ENTITY_INLINE_LIMIT: Number(process.env.KB_WRITER_ENTITY_LIMIT || 32000),
  //   entity-all mode=full 的整类总字符上限（实测：产品/人 ≤40K 可整挂；公司 15 页 ~200K 会打爆→拒绝提示用 index）
  ENTITY_ALL_FULL_LIMIT: Number(process.env.KB_WRITER_ENTITY_ALL_LIMIT || 40000),
  //   raw/书 源（挂 kb/raw/ 具体原文，全文注入）单文件 inline 上限：书/长文比实体页大得多，给足；
  //   超限截断带清晰尾注（绝不静默截）。整本 IPO 招股书/年报（几十万~上百万字符）必然超限，会明示"仅前 N 字"。
  //   多本大部头同时挂会打爆上下文——每份都超限时提示主人调高本值(KB_WRITER_RAW_INLINE_LIMIT)或少挂几份。
  RAW_INLINE_LIMIT: Number(process.env.KB_WRITER_RAW_INLINE_LIMIT || 120000),
  // DeepSeek 调研工具循环：最多工具轮数（防空转烧钱/超时）
  DS_MAX_TOOL_ROUNDS: Number(process.env.KB_WRITER_DS_MAX_ROUNDS || 12),
  // 文档工作记忆：轮末抽取开关 + 抽取模型（便宜档；默认 deepseek 直连，失败回退 FAST_MODEL=fable，绝不用 opus）
  MEMORY_EXTRACT: process.env.KB_WRITER_MEMORY_EXTRACT !== '0',
  MEMORY_EXTRACT_MODEL: process.env.KB_WRITER_MEMORY_MODEL || 'deepseek-chat',
};

// DeepSeek（非 Claude provider）：key 引用机器上已有的位置（V3 的 .env.local），不复制明文到新地方。
// 可用 KB_WRITER_DEEPSEEK_KEY_FILE 或直接 DEEPSEEK_API_KEY 覆盖。
CONFIG.DEEPSEEK_KEY_FILE = process.env.KB_WRITER_DEEPSEEK_KEY_FILE ||
  path.join(HOME, '.openclaw', 'workspace-marketing', 'projects', 'influencer-v3', '.env.local');
CONFIG.DEEPSEEK_BASE = process.env.KB_WRITER_DEEPSEEK_BASE || 'https://api.deepseek.com';
// 动作技能（补充/修正/提问/起草 的方法论，可编辑文件；放 ~/sync 自带 git 版本史）
CONFIG.ACTIONS_DIR = process.env.KB_WRITER_ACTIONS_DIR || path.join(HOME, 'sync', 'skills', 'QS-写作', 'actions');
// 全局技能目录（挂载技能的候选来源）
CONFIG.SKILLS_DIR = path.join(HOME, '.claude', 'skills');

export const WRITING_DIR = path.join(CONFIG.KB_ROOT, 'writing');
