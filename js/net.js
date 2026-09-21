// ─── 网络能力：搜索 / 拉取网页 / git（浏览器没有跨域抓取能力，需要分层兜底）──
//
// 传输层次（按可用性依次尝试，全部失败时给出「怎么修」的可执行说明）：
//   ① 本地中继 server.py 的 /api/search、/api/fetch、/api/git —— 同源、无 CORS 限制、可抓任意页面
//   ② 直连对 CORS 友好的公开端点（DuckDuckGo Instant Answer API 返回 access-control-allow-origin: *）
//   ③ 直连目标 URL 本身（少数站点/API 允许跨域）
//
// 为什么不做「前端硬编一个第三方搜索」：实测 html.duckduckgo.com / lite.duckduckgo.com 对数据中心
// IP 直接回 202 反爬页，public SearXNG 实例普遍 429，corsproxy.io 要 key，allorigins 已 522 ——
// 这些都不适合写进产品里当唯一路径。所以能力可用来就去中继，去不了就明确说明，而不是给一堆假结果。
//
// 注意：本模块被 tools.js 与测试引用；tools.js 里只 import 已有形状的函数，
// 避免「新增具名导出 + 混版缓存」的 link 期白屏（见 js/agent.js 同类注释）。

const RELAY = { search: '/api/search', fetch: '/api/fetch', git: '/api/git', health: '/api/health' };

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

export const RELAY_HINT = '需要本地中继：在该目录执行 python3 server.py 后打开 http://localhost:8787（Pages 静态托管没有服务端，抓取与 git 只能走本地中继）';

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

// ── 搜索 ────────────────────────────────────────────────────────────────
const ddgToResults = (json, count) => {
  const out = [];
  const push = (title, url, snippet) => {
    if (url && title && out.length < count) out.push({ title: String(title).trim(), url, snippet: String(snippet || '').trim() });
  };
  const j = json || {};
  if (j.AbstractText) push(j.Heading || j.AbstractSource || 'Instant Answer', j.AbstractURL || '', j.AbstractText);
  if (j.Answer) push(typeof j.Answer === 'string' ? j.Answer.slice(0, 80) : 'Answer', '', typeof j.Answer === 'string' ? j.Answer : JSON.stringify(j.Answer));
  if (j.Definition) push(j.DefinitionSource || 'Definition', j.DefinitionURL || '', j.Definition);
  for (const r of j.RelatedTopics || []) {
    if (!r) continue;
    if (r.FirstURL) push(r.Text || r.FirstURL, r.FirstURL, r.Text);
    else for (const t of r.Topics || []) if (t && t.FirstURL) push(t.Text || t.FirstURL, t.FirstURL, t.Text);
  }
  return out;
};

async function ddgInstantSearch(query, count, signal) {
  const u = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1&t=teamoagent`;
  const res = await fetch(u, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`DuckDuckGo Instant Answer HTTP ${res.status}`);
  return ddgToResults(await res.json(), count);
}

/**
 * 搜索：中继优先，其次直连 DDG Instant Answer。
 * @returns {Promise<{provider:string, results:{title:string,url:string,snippet:string}[], note:string}>}
 */
export async function webSearch({ query, count = 6, signal } = {}) {
  const q = String(query || '').trim();
  if (!q) return { provider: 'none', results: [], note: 'web_search 缺少 query 参数' };
  const n = Math.max(1, Math.min(10, Number(count) || 6));
  if (await relayAvailable(signal)) {
    try {
      const res = await fetch(`${RELAY.search}?q=${encodeURIComponent(q)}&count=${n}`, { signal, headers: { Accept: 'application/json' } });
      if (res.ok) {
        const j = await res.json();
        const results = Array.isArray(j.results) ? j.results.slice(0, n) : [];
        if (results.length) return { provider: j.provider || 'relay', results, note: j.note || '' };
      }
    } catch { /* 中继失败 → 降级到直连 */ }
  }
  try {
    const results = await ddgInstantSearch(q, n, signal);
    if (results.length) {
      return {
        provider: 'duckduckgo-instant',
        results,
        note: '未连到本地中继，用的是 DuckDuckGo Instant Answer（百科/定义类查询效果好，新闻与长尾覆盖有限）；想要通用搜索请跑 ' + RELAY_HINT,
      };
    }
    return {
      provider: 'duckduckgo-instant',
      results: [],
      note: `DuckDuckGo Instant Answer 对「${q}」没有结果。${RELAY_HINT}；或者直接用 fetch_url 抓你已知的网址。`,
    };
  } catch (err) {
    return { provider: 'none', results: [], note: `搜索失败：${err.message}。${RELAY_HINT}` };
  }
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
  const want = mode === 'raw' ? 'raw' : mode === 'markdown' ? 'markdown' : 'text';
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
    try {
      const res = await fetch(u, { signal, redirect: 'follow', headers: { Accept: 'text/html,application/xhtml+xml,application/json,text/plain,*/*' } });
      status = res.status;
      contentType = res.headers.get('content-type') || '';
      finalUrl = res.url || u;
      if (!res.ok) return { ok: false, error: `直连抓取失败：HTTP ${res.status}${contentType.includes('html') ? '' : `（${contentType}）`}` };
      if (!looksTextual(contentType)) {
        const size = res.headers.get('content-length');
        return { ok: false, error: `目标是 ${contentType || '未知类型'}${size ? `（${size} 字节）` : ''}，不是文本；fetch_url 只做文本/markdown 提取。要下载二进制请让用户在浏览器里打开该链接。` };
      }
      const raw = await res.text();
      body = /html/i.test(contentType) ? (want === 'text' ? htmlToText(raw) : raw) : raw;
      if (want === 'text' && /html/i.test(contentType)) note = note || '已直连抓取并在浏览器内去标签（无本地中继）';
      else note = note || '已直连抓取（未走本地中继）';
    } catch (err) {
      return {
        ok: false,
        error: `抓取失败：${err.message}（该站点不允许浏览器跨域读取）。${RELAY_HINT}`,
      };
    }
  }

  const text = String(body || '');
  if (!text.trim()) return { ok: false, error: `抓到了内容但是空的（可能是纯 JS 渲染页面）。可试 mode="markdown"（走中继的正文抽取器）或换一个 URL。` };
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
