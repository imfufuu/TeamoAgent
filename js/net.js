// ─── 网络能力：网页抓取 / git（浏览器既没有跨域抓取能力，也没有执行外部程序的能力）
//
// 分层：
//   ① 本地中继 server.py 的 /api/fetch、/api/git —— 同源、无 CORS 与 CSP 限制、可抓任意页面
//   ② 直连目标 URL（仅在页面 CSP 与站点 CORS 都放行时可用，例如用户自己改过 connect-src）
//   全部不可用时返回「怎么修」的可执行说明，而不是给一堆假结果。
//
// 「联网搜索」不在这里：按用户要求，联网只使用模型 API 自带的网页搜索请求格式
//（见 js/websearch.js 与 api.js 的注入逻辑），本项目不再调用任何第三方搜索 API。
//
// 注意：本模块被 tools.js 与测试引用；tools.js 里只 import 已有形状的函数，
// 避免「新增具名导出 + 混版缓存」的 link 期白屏（见 js/agent.js 同类注释）。

const RELAY = { fetch: '/api/fetch', git: '/api/git', health: '/api/health' };

let relayOk = null; // null=未探测 true/false
let relayProbe = null;

/** 探测本地中继是否在跑（结果缓存；并发调用共享同一个探测） */
export async function relayAvailable(signal) {
  if (relayOk === true) return true;
  if (relayProbe) return relayProbe;
  relayProbe = (async () => {
    try {
      const res = await fetch(RELAY.health, { signal, headers: { Accept: 'application/json' } });
      if (!res.ok) return false;
      const ct = res.headers.get('content-type') || '';
      relayOk = ct.includes('json'); // Pages 会把未知路径回成 404 HTML —— 不能当健康
      return relayOk;
    } catch {
      relayOk = false;
      return false;
    } finally {
      relayProbe = null;
    }
  })();
  return relayProbe;
}

/** 测试/页面切换部署环境时重置探测缓存 */
export function resetRelayProbe() { relayOk = null; relayProbe = null; }

export const RELAY_HINT = '需要本地中继：在项目目录执行 python3 server.py 后打开 http://localhost:8787（Pages 静态托管没有服务端，抓取与 git 只能走本地中继）';

// ── HTML → 纯文本（纯函数，可在 node 里单测）─────────────────────────
export function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(?:noscript|svg|iframe)[\s\S]*?<\/(?:noscript|svg|iframe)>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(?:p|div|li|h[1-6]|tr|blockquote|pre)>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  const map = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#x27': "'", middot: '·', mdash: '—', ndash: '–', hellip: '…', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»', times: '×' };
  s = s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => (map[e] !== undefined ? map[e] : (e[0] === '#' ? String.fromCodePoint(parseInt(e.slice(1).replace(/^x/i, ''), e[0] === '#' && e[1] !== 'x' ? 10 : 16)) : m)));
  return s.split('\n').map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim()).filter((l, i, a) => l || (a[i - 1] || '').length).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function pageTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ''));
  return m ? htmlToText(m[1]).slice(0, 160) : '';
}

// ── 兼容桩（一个发布周期内保留）──────────────────────────────────────
// 静态站点没有构建器、Pages 对子资源有 ~10 分钟缓存，于是可能出现「旧 tools.js + 新 net.js」：
// 旧 tools.js 还写着 import { webSearch } —— 少这个导出会在 ESM link 期直接报错（整页白屏，
// 比按钮失灵严重得多）。所以保留同名导出但不再实现任何搜索：搜索已按用户要求改成模型 API 自带格式。
// 下一个发布周期（所有访问者的缓存都换过一轮后）可以删掉本函数与 tools.js 里的旧引用痕迹。
export async function webSearch() {
  return {
    provider: 'none',
    results: [],
    note: '项目已不再内置第三方搜索；联网请打开顶栏「联网」开关，由模型 API 自带的网页搜索格式完成。',
  };
}

// ── 拉取网页 ────────────────────────────────────────────────────────────
const looksTextual = (mime) => /text\/|html|xml|json|javascript|csv|markdown|plain/i.test(String(mime || ''));

export function slugFromUrl(url) {
  const m = /^https?:\/\/([^/]+)(\/[^?#]*)?/i.exec(String(url || ''));
  const host = (m && m[1]) || 'page';
  const tail = ((m && m[2]) || '').split('/').filter(Boolean).pop() || 'index';
  return `${host.replace(/[^a-z0-9.-]+/gi, '_')}/${tail.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 60) || 'index'}`;
}

/**
 * 抓取一个 URL 并转成文本。优先走本地中继（无 CORS 限制），失败则直连。
 * 文本超过 2000 字符时把全文写进沙箱 savePath（默认 web/<host>/<path>.md），
 * 返回结果里给出截断预览 —— 这样子智能体和 read_file 都能继续用这份原文。
 */
export async function fetchPage({ url, mode = 'text', maxBytes = 2000000, signal, fs, savePath } = {}) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return { ok: false, error: `fetch_url 只接受 http(s) 绝对地址，收到：${u || '(空)'}` };
  const want = mode === 'raw' ? 'raw' : 'text';
  let status = 0, body = '', contentType = '', finalUrl = u, note = '';

  if (await relayAvailable(signal)) {
    try {
      const res = await fetch(`${RELAY.fetch}?url=${encodeURIComponent(u)}&mode=${want}&max=${Math.min(Number(maxBytes) || 0 || 2000000, 4000000)}`, { signal, headers: { Accept: 'application/json' } });
      status = res.status;
      if (res.ok) {
        const j = await res.json();
        body = String(j.text != null ? j.text : (j.html || j.content || ''));
        contentType = j.content_type || '';
        finalUrl = j.url || u;
        note = [j.truncated ? `上游内容被截断（上限 ${j.limit || ''}B）` : '', j.title ? `标题：${j.title}` : ''].filter(Boolean).join(' · ');
      } else {
        const j = await res.json().catch(() => ({}));
        return { ok: false, error: `本地中继抓取失败（HTTP ${res.status}）：${j.error || res.statusText || '未知原因'}` };
      }
    } catch (err) {
      note = `中继抓取异常（${err.message}），已改为浏览器直连`;
    }
  }

  if (!body) {
    // 直连只在「页面 CSP 允许 + 目标站点允许跨域」时才可能成功；本项目 index.html 的 CSP
    // 只放行了网关，所以绝大多数情况下这一步会失败 —— 保留它是为了让自建部署（改过 CSP）仍可用
    try {
      const res = await fetch(u, { signal, redirect: 'follow', headers: { Accept: 'text/html,application/xhtml+xml,application/json,text/plain,*/*' } });
      status = res.status;
      contentType = res.headers.get('content-type') || '';
      finalUrl = res.url || u;
      if (!res.ok) return { ok: false, error: `直连抓取失败：HTTP ${res.status}${contentType.includes('html') ? '' : `（${contentType}）`}` };
      if (!looksTextual(contentType)) {
        const size = res.headers.get('content-length');
        return { ok: false, error: `目标是 ${contentType || '未知类型'}${size ? `（${size} 字节）` : ''}，不是文本；fetch_url 只做文本提取。要下载二进制请让用户在浏览器里打开该链接。` };
      }
      const raw = await res.text();
      body = /html/i.test(contentType) ? (want === 'text' ? htmlToText(raw) : raw) : raw;
      if (want === 'text' && /html/i.test(contentType)) note = note || '已直连抓取并在浏览器内去标签（未走本地中继）';
      else note = note || '已直连抓取（未走本地中继）';
    } catch (err) {
      return {
        ok: false,
        error: `抓取失败：${err.message}。浏览器直连会被页面 CSP(connect-src) 或目标站点的 CORS 挡住，`
          + `这不是可绕过的偶发错误。${RELAY_HINT}`,
      };
    }
  }

  const text = String(body || '');
  if (!text.trim()) return { ok: false, error: `抓到了内容但是空的（可能是纯 JS 渲染页面）。换个直链的静态页面试试，或用 mode="raw" 拿原始 HTML 自己解析。` };
  let savedTo = '';
  if (fs && text.length > 2000) {
    savedTo = savePath || `web/${slugFromUrl(finalUrl)}.md`;
    try { fs.write(savedTo, text); } catch { savedTo = ''; }
  }
  const PREVIEW = 6000;
  return {
    ok: true,
    url: finalUrl,
    status,
    contentType,
    chars: text.length,
    savedTo,
    preview: text.length > PREVIEW ? `${text.slice(0, PREVIEW)}\n…（共 ${text.length} 字符${savedTo ? `，全文已写入沙箱 ${savedTo}，可 read_file 继续读` : ''}）` : text,
    note,
  };
}

// ── git（只有本地中继能跑真 git）───────────────────────────────────────
export async function gitRun({ command, repo, timeoutSec = 25, signal } = {}) {
  const cmd = String(command || '').trim();
  if (!cmd) return { ok: false, error: 'run_git 需要 command，例如 "git status --short"' };
  if (!(await relayAvailable(signal))) return { ok: false, error: `git 命令需要本地中继（浏览器里无法执行外部程序）。${RELAY_HINT}` };
  let res;
  try {
    res = await fetch(RELAY.git, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ command: cmd, repo: repo ? String(repo) : '', timeout: Number(timeoutSec) || 25 }),
      signal,
    });
  } catch (err) {
    return { ok: false, error: `git 中继请求失败：${err.message}` };
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: `git 中继拒绝执行（HTTP ${res.status}）：${j.error || res.statusText}` };
  const out = [j.stdout, j.stderr].filter((x) => x && String(x).trim()).join('\n── stderr ──\n');
  return {
    ok: j.code === 0,
    code: j.code,
    cwd: j.cwd || '',
    text: out || `（无输出，退出码 ${j.code}）`,
    note: j.note || '',
  };
}

export const NET_TOOLS_AVAILABLE_NOTE = RELAY_HINT;
