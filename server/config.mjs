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
  // research 档 WebFetch 只允许这些域（防注入网页把数据 GET 外泄；实测 permission 层 domain scoping 生效）。
  // WebSearch 不受限（只返回搜索片段，非直连外泄）。用户可按需扩这个白名单。
  RESEARCH_DOMAINS: (process.env.KB_RESEARCH_DOMAINS ||
    // arctic-shift = Reddit 只读存档 API（免鉴权、GET-only JSON）。研究档 agent 无 Bash，
    // 直接 WebFetch 这个域取 Reddit 数据（发不出数据）——比给 Bash+网络安全得多。
    'en.wikipedia.org,zh.wikipedia.org,github.com,raw.githubusercontent.com,www.sec.gov,www.annualreports.com,finance.yahoo.com,www.crunchbase.com,arctic-shift.photon-reddit.com')
    .split(',').map((s) => s.trim()).filter(Boolean),
  // 多 agent 编排护栏
  MAX_PARALLEL_TASKS: Number(process.env.KB_WRITER_MAX_PARALLEL || 3),
  DOC_BUDGET_USD: Number(process.env.KB_WRITER_DOC_BUDGET_USD || 3),
  // 超时看门狗（毫秒）：任务不能无限挂
  TASK_TIMEOUT_RESEARCH_MS: Number(process.env.KB_WRITER_TASK_TIMEOUT_RESEARCH_MS || 8 * 60 * 1000),
  TASK_TIMEOUT_WRITE_MS: Number(process.env.KB_WRITER_TASK_TIMEOUT_WRITE_MS || 4 * 60 * 1000),
  // 交互式批改/动作的通用安全网（冷启大库批改可能数分钟，给宽一点，只防真卡死）
  SEND_TIMEOUT_MS: Number(process.env.KB_WRITER_SEND_TIMEOUT_MS || 12 * 60 * 1000),
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
