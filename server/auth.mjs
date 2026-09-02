import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { CONFIG } from './config.mjs';

// 多端共享 token：后端 bind LAN，能调本机 claude，必须校验 token 才放行。
// token 存 ~/.kb-collector/kb-writer.token（600），首启生成；凭据不进 git/NAS，不回显到日志/bundle/报错。
const TOKEN_FILE = path.join(CONFIG.LOG_DIR, 'kb-writer.token');
const ACCESS_LOG = path.join(CONFIG.LOG_DIR, 'kb-writer-access.log');

export function loadOrCreateToken() {
  fs.mkdirSync(CONFIG.LOG_DIR, { recursive: true });
  if (process.env.KB_WRITER_TOKEN) return process.env.KB_WRITER_TOKEN.trim();
  try { const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); if (t) return t; } catch { /* 生成 */ }
  const t = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
  return t;
}
export const TOKEN = loadOrCreateToken();
const TOKEN_BUF = Buffer.from(TOKEN);

// 常数时间比较，避免 timing 侧信道；长度不等直接 false（timingSafeEqual 要求等长）。
function tokenEqual(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const b = Buffer.from(candidate);
  if (b.length !== TOKEN_BUF.length) { // 仍做一次等长比较以钝化 timing
    try { crypto.timingSafeEqual(TOKEN_BUF, TOKEN_BUF); } catch { /* noop */ }
    return false;
  }
  return crypto.timingSafeEqual(b, TOKEN_BUF);
}

// —— 限流：单 IP 鉴权失败累计到阈值就锁一段时间，防 token 爆破 ——
const FAIL_MAX = 8;             // 窗口内最多失败次数
const FAIL_WINDOW_MS = 60_000;  // 统计窗口
const LOCK_MS = 5 * 60_000;     // 触发后锁定时长
const fails = new Map();        // ip -> { count, first, lockUntil }

function ipOf(req) {
  // 直连 LAN，无反代；用 socket 远端地址（不信任 X-Forwarded-*）
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
function rateBlocked(ip) {
  const r = fails.get(ip);
  if (r && r.lockUntil && Date.now() < r.lockUntil) return true;
  return false;
}
function noteFail(ip) {
  const now = Date.now();
  let r = fails.get(ip);
  if (!r || now - r.first > FAIL_WINDOW_MS) r = { count: 0, first: now, lockUntil: 0 };
  r.count += 1;
  if (r.count >= FAIL_MAX) r.lockUntil = now + LOCK_MS;
  fails.set(ip, r);
}
function noteOk(ip) { fails.delete(ip); }

function accessLog(ip, method, pathname, ok, note) {
  // 只记路径（不含 query，避免把首个 ?token= 落盘）；不记 token。
  const line = `${new Date().toISOString()}\t${ip}\t${method}\t${pathname}\t${ok ? 'OK' : 'DENY'}${note ? '\t' + note : ''}\n`;
  fs.appendFile(ACCESS_LOG, line, () => {});
}

// 取 token：header x-kb-token 优先，其次 cookie kbw_token；**不接受 URL query**（避免落日志/历史）。
function tokenFromReq(req) {
  const h = req.get('x-kb-token');
  if (h) return h;
  const cookie = req.get('cookie') || '';
  const m = cookie.match(/(?:^|;\s*)kbw_token=([^;]+)/);
  if (m) return decodeURIComponent(m[1]);
  return '';
}

// 中间件：/api/* 需 token（health 除外，但 health 不泄信息）。静态前端与 OPTIONS 放行。
export function requireToken(req, res, next) {
  if (req.method === 'OPTIONS') return next();
  if (!req.path.startsWith('/api/')) return next();
  const ip = ipOf(req);
  // health 无需 token，但也不泄露任何内部信息
  if (req.path === '/api/health') { accessLog(ip, req.method, req.path, true, 'health'); return res.json({ ok: true }); }

  if (rateBlocked(ip)) { accessLog(ip, req.method, req.path, false, 'rate-locked'); return res.status(429).json({ error: 'too many attempts' }); }

  const ok = tokenEqual(tokenFromReq(req));
  accessLog(ip, req.method, req.path, ok);
  if (!ok) { noteFail(ip); return res.status(401).json({ error: 'unauthorized' }); }
  noteOk(ip);
  next();
}

// 首次带 ?token= 打开时，把它转存 httpOnly cookie 后 302 到干净 URL（token 不再留在地址栏/历史）。
export function tokenCookieBootstrap(req, res, next) {
  if (req.method === 'GET' && !req.path.startsWith('/api/') && typeof req.query.token === 'string' && req.query.token) {
    if (tokenEqual(req.query.token)) {
      res.setHeader('Set-Cookie', `kbw_token=${encodeURIComponent(req.query.token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`);
    }
    const clean = req.path; // 丢掉 query（含 token）
    return res.redirect(302, clean);
  }
  next();
}

export function lanAddresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) for (const ni of ifs[name] || []) if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
  return out;
}
