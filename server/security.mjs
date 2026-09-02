import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.mjs';

// 生成两份「硬边界」settings 文件（不碰用户 ~/.claude/settings.json，那里有 lark-mcp 令牌等）。
// 机制（防御纵深两层，实测均生效）：
//   ① 权限层 dontAsk：不在 allow 里的工具自动拒绝、不挂起（headless）。写作会话直接禁掉 Bash。
//   ② OS 沙箱 Seatbelt：即便放行了 Bash，也把它的写/网络硬关在沙箱里
//      —— 写只 kb/writing、网络 strictAllowlist 只放行网关、读 deny 敏感目录。
//
// 实测得到的两条硬规则（Claude Code 沙箱的坑）：
//   · 用「绝对 // 路径」，不要用「~/」或含 dotdir 的 ** glob（后者读授权会时灵时不灵）。
//   · denyRead 不能和 allowRead 的子树重叠（例：allow ~/sync/skills/** 就不能 deny ~/sync/env，
//     否则整个 profile 会 fail-closed 把本该 allow 的 token 也一起拒掉）。
//   · 可靠的是 network allowlist 与 write allowlist（跨所有测试都稳）。

const H = CONFIG.HOME.replace(/^\//, '');              // Users/qqkk
const abs = (p) => `//${H}/${p}`;                      // //Users/qqkk/<p>
const KB_ABS = `//${CONFIG.KB_ROOT.replace(/^\//, '')}`; // //Volumes/2026Projects/kb
const KB_GLOB = `${KB_ABS}/**`;
const WRITING_GLOB = `${KB_ABS}/writing/**`;

// 敏感目录：Bash 子进程 deny 读。注意——不得与 allowRead 子树重叠。
const SECRET_DENY_READ = [
  abs('.ssh'), abs('.aws'), abs('.gnupg'), abs('.wind-aifinmarket'),
  abs('.config/gcloud'), abs('Library/Keychains'), abs('.docker'),
];

function baseSandbox(extraAllowRead, allowedDomains) {
  return {
    enabled: true,
    failIfUnavailable: true,        // 沙箱不可用即失败（fail-closed），绝不裸跑
    autoAllowBashIfSandboxed: true,
    network: { allowedDomains, strictAllowlist: true, deniedDomains: [] },
    filesystem: {
      allowRead: [KB_GLOB, ...extraAllowRead],
      denyRead: [...SECRET_DENY_READ],
      allowWrite: [WRITING_GLOB],  // 写只 kb/writing（allow-list，实测 /tmp 写 operation not permitted）
      denyWrite: [],
    },
  };
}

// 纯写作/批改会话：禁 Bash / 禁网络 / 禁写；只 Read/Grep/Glob 限定 kb/**。
// 无 Bash → 无 shell 可越权；密钥保护由权限层负责（Read 只 allow kb/**，其它 dontAsk 拒）。
export function writeSessionSettings() {
  return {
    sandbox: baseSandbox([], []),                     // Bash 子进程无网络（其实无 Bash）
    permissions: {
      deny: ['Bash', 'WebFetch', 'WebSearch', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Task'],
      allow: [`Read(${KB_GLOB})`, `Grep(${KB_GLOB})`, `Glob(${KB_GLOB})`],
    },
  };
}

// —— api 档专有的 denyWrite（只收紧，不放松）——
// 坑：Seatbelt 沙箱不约束 cwd 子树，而 cwd = KB_ROOT。于是 api 档（唯一有 Bash 的档）下
// 整个 kb 树都可写，`allowWrite: kb/writing/**` 名不副实——实测 `echo > kb/dimensions/x.md` 成功。
// 这违反宪法「agent 任何路径不得写 dimensions/entities」。这里对 kb 下「除 writing 外」的子树显式 denyWrite。
// denyWrite 与 denyRead 的 fail-closed 重叠坑无关（读仍全库 allow，只是写不进去）。
// 目录本身与 /** 都列上：前者挡 rm/替换目录，后者挡目录内文件。
const KB_READONLY_SUBTREES = ['dimensions', 'entities', 'raw', '_schema', 'weekly']
  .flatMap((d) => [`${KB_ABS}/${d}`, `${KB_ABS}/${d}/**`]);
// 提权路径：cwd/.claude/settings*.json 会被 --setting-sources project 读进下一次会话，
// 能给自己加 allow / 关沙箱。精确 deny 这两个文件（不动 .claude/.cc-writes，那是 CC 自己的记账目录）。
const KB_PROJECT_SETTINGS_DENY = [`${KB_ABS}/.claude/settings.json`, `${KB_ABS}/.claude/settings.local.json`];
// 控制类 sidecar：agent 不能经 Bash 篡改——`.memory.md` 有最高权威的「主人裁决」段（会被后续照办）、
// `.context.json` 决定挂了哪些上下文源。它们在 kb/writing(allowWrite)内，但 denyWrite 更具体、覆盖 allow。
// 合法写入走可信 node 后端(memoryStore/contextStore)，不经沙箱，不受此影响。
const KB_CONTROL_FILES_DENY = ['*.memory.md', '*.context.json']
  .flatMap((g) => [`${KB_ABS}/writing/${g}`, `${KB_ABS}/writing/**/${g}`]);

// live-API 会话：额外放行 Skill+Bash 跑网关只读 client。沙箱把 Bash 硬关——
// 网络只 gateway host、写只 kb/writing、读 deny 敏感目录（网关 token 精确放行给 client）。
// 残留（已知、可接受）：因 network 锁死到网关，Bash 即便读到 ~/sync/env 等也无法外泄；
// 且此档只在文档挂了 live API 源时启用（opt-in），默认会话是上面全锁的 write 档。
export function apiSessionSettings() {
  const gatewayHost = new URL(process.env.KB_GATEWAY_URL || 'https://gateway.papablic.com').host;
  const sbx = baseSandbox([
    abs('.claude/skills/**'),                 // 技能目录（papablic-data client 在此，含符号链到 ~/sync/skills）
    abs('sync/skills/**'),                    // 符号链真实路径；故不能 deny ~/sync 下任何子树
    abs('.openclaw/secrets/gateway-token'),   // 精确放行这一个密钥文件给 client（绝对路径才稳）
  ], [gatewayHost]);
  // 仅 api 档收紧：kb 树里除 writing 外全部只读（Bash 只有这一档有）。write/research 档不动。
  sbx.filesystem.denyWrite = [...sbx.filesystem.denyWrite, ...KB_READONLY_SUBTREES, ...KB_PROJECT_SETTINGS_DENY, ...KB_CONTROL_FILES_DENY];
  return {
    sandbox: sbx,
    permissions: {
      deny: ['WebFetch', 'WebSearch', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Task'],
      allow: [`Read(${KB_GLOB})`, `Grep(${KB_GLOB})`, `Glob(${KB_GLOB})`, 'Skill', 'Bash'],
    },
  };
}

// research 档：调研需要"更宽的读取向能力"，不是任意 shell/出网。
//   给：WebSearch（广搜片段）+ WebFetch(只到白名单域，实测 permission 层拦得住) + 读 kb + 只读非-Bash skill。
//   不给：Bash（→无 curl 任意 POST）、Write/Edit（→scratch 由服务端可信写，agent 只读）。
//   硬边界一条不减：denyRead 密钥、写全禁、沙箱兜底。防注入网页把库/草稿 POST/GET 外泄。
export function researchSessionSettings() {
  return {
    sandbox: baseSandbox([], []),   // 无 Bash → 无 Bash 子进程网络；WebFetch 走 permission 层白名单
    permissions: {
      deny: ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Task'],
      allow: [
        `Read(${KB_GLOB})`, `Grep(${KB_GLOB})`, `Glob(${KB_GLOB})`,
        'WebSearch', 'Skill',
        ...CONFIG.RESEARCH_DOMAINS.map((d) => `WebFetch(domain:${d})`),
      ],
    },
  };
}

export function ensureSettingsFiles() {
  const dir = path.join(CONFIG.LOG_DIR, 'kb-writer-settings');
  fs.mkdirSync(dir, { recursive: true });
  const wp = path.join(dir, 'harden-write.json');
  const ap = path.join(dir, 'harden-api.json');
  const rp = path.join(dir, 'harden-research.json');
  fs.writeFileSync(wp, JSON.stringify(writeSessionSettings(), null, 2), { mode: 0o600 });
  fs.writeFileSync(ap, JSON.stringify(apiSessionSettings(), null, 2), { mode: 0o600 });
  fs.writeFileSync(rp, JSON.stringify(researchSessionSettings(), null, 2), { mode: 0o600 });
  return { write: wp, api: ap, research: rp };
}
