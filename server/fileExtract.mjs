import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { CONFIG } from './config.mjs';

// 二进制附件 → 文本（**只在可信 node 后端做**，不给任何 claude 档加 Bash/工具）。
//
// 为什么必须在后端抽：
//   · deepseek 等非 agentic 模型完全无工具，只吃装配器拼好的上下文快照；
//   · claude 的 write/research 档也没有 Bash；
//   原来 readFileSource 对 PDF 只返回 {binary:true}，装配器就写一句"请用 Read 工具读取"，
//   于是选 DeepSeek 时它如实说"读不了上下文里的 PDF（二进制、需 Read 工具，当前模型无工具）"。
//
// 抽取器（都在本机、只读打开 PDF，不出网），按中文可读性排序：
//   ① 339-kb collector venv 里的 pypdf —— 中文阅读顺序明显更好（实测同一份中文 PDF，
//      pdftotext -layout 会把竖排/定位的 CJK 字打散成"档 文 / 页 本 一 唯"，pypdf 出来是通顺的）
//   ② /opt/homebrew/bin/pdftotext（poppler）—— 更快，①缺席或抽空时兜底
//   两者都抽不出（扫描件/纯图 PDF）→ 如实报错，装配器写明"标 🟡 待核"，绝不静默当没这份文件
//
// 缓存：LOG_DIR/kb-writer-extract/<sha1(绝对路径)>-<mtime>-<size>.txt
//   · 不写进 kb 树（不污染知识库、也不要求源文件所在目录可写）
//   · key 带 mtime+size → 文件换了自动失效重抽
//   · 上传时预热一次（见 server.mjs 的 /api/context/upload），之后每次批改都是读缓存

const EXTRACT_DIR = path.join(CONFIG.LOG_DIR, 'kb-writer-extract');
const PDFTOTEXT = '/opt/homebrew/bin/pdftotext';
const PYPDF_PYTHON = path.join(CONFIG.HOME, '339-kb', 'collector', '.venv', 'bin', 'python');
const EXTRACT_TIMEOUT_MS = 90_000;
const MAX_RAW_CHARS = 2_000_000;   // 抽出的原始文本落盘上限（防超大 PDF 撑爆缓存）

// inline 进上下文的字符上限（与文本文件的 FILE_INLINE_LIMIT 同量级，可 env 单独调）
export const PDF_INLINE_LIMIT = Number(process.env.KB_WRITER_PDF_INLINE_LIMIT || 24000);

const nfc = (s) => String(s).normalize('NFC');

export function isPdfPath(p) { return /\.pdf$/i.test(nfc(p || '')); }

// 魔数判定（扩展名不可靠时兜底）：PDF 以 %PDF- 开头
function sniffPdf(p) {
  try {
    const fd = fs.openSync(p, 'r');
    const b = Buffer.alloc(5);
    fs.readSync(fd, b, 0, 5, 0);
    fs.closeSync(fd);
    return b.toString('latin1') === '%PDF-';
  } catch { return false; }
}

function cacheFile(p) {
  let st;
  try { st = fs.statSync(p); } catch { return null; }
  const key = crypto.createHash('sha1').update(nfc(path.resolve(p))).digest('hex').slice(0, 16);
  return path.join(EXTRACT_DIR, `${key}-${Math.round(st.mtimeMs)}-${st.size}.txt`);
}

function runPdftotext(p) {
  if (!fs.existsSync(PDFTOTEXT)) return null;
  const r = spawnSync(PDFTOTEXT, ['-layout', '-enc', 'UTF-8', '-q', p, '-'], {
    encoding: 'utf8', timeout: EXTRACT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) return null;
  const t = (r.stdout || '').trim();
  return t ? { text: t, via: 'pdftotext' } : null;
}

function runPypdf(p) {
  if (!fs.existsSync(PYPDF_PYTHON)) return null;
  const script = 'import sys\nfrom pypdf import PdfReader\nr = PdfReader(sys.argv[1])\n'
    + 'sys.stdout.write("\\n\\n".join((pg.extract_text() or "") for pg in r.pages))\n';
  const r = spawnSync(PYPDF_PYTHON, ['-c', script, p], {
    encoding: 'utf8', timeout: EXTRACT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) return null;
  const t = (r.stdout || '').trim();
  return t ? { text: t, via: 'pypdf' } : null;
}

// 抽一个 PDF 的全文（带磁盘缓存）。返回 { text, via, cached, chars } 或 { text: null, error }。
export function extractPdfText(p) {
  if (!p || (!isPdfPath(p) && !sniffPdf(p))) return { text: null, error: '不是 PDF' };
  const cf = cacheFile(p);
  if (cf && fs.existsSync(cf)) {
    try {
      const text = fs.readFileSync(cf, 'utf8');
      return { text, via: 'cache', cached: true, chars: text.length };
    } catch { /* 缓存坏了 → 重抽 */ }
  }
  const got = runPypdf(p) || runPdftotext(p);
  if (!got) {
    return { text: null, error: fs.existsSync(PDFTOTEXT) || fs.existsSync(PYPDF_PYTHON)
      ? '抽取器返回空文本（可能是扫描件/纯图片 PDF，需 OCR）'
      : '本机没有可用的 PDF 抽取器（pdftotext / pypdf 都没找到）' };
  }
  let text = got.text;
  if (text.length > MAX_RAW_CHARS) text = text.slice(0, MAX_RAW_CHARS);
  if (cf) {
    try { fs.mkdirSync(EXTRACT_DIR, { recursive: true }); fs.writeFileSync(cf, text, 'utf8'); } catch { /* 缓存失败不影响本次 */ }
  }
  return { text, via: got.via, cached: false, chars: text.length };
}

// 装配器用：抽出并按 inline 上限截断（超限带尾注，绝不静默截）。
// limit 可覆写默认 PDF_INLINE_LIMIT —— raw/书 源用更大的上限（KB_WRITER_RAW_INLINE_LIMIT）尽量全文注入。
export function inlineBinaryText(p, limit = PDF_INLINE_LIMIT) {
  const r = extractPdfText(p);
  if (r.text == null) return { text: null, error: r.error };
  const full = r.text.length;
  const cap = Number(limit) > 0 ? Number(limit) : PDF_INLINE_LIMIT;
  const truncated = full > cap;
  return {
    text: truncated ? r.text.slice(0, cap) : r.text,
    truncated, fullChars: full, limit: cap, via: r.via, cached: !!r.cached,
  };
}
