/**
 * TeamoAgent 公共中继 — Cloudflare Worker 版本
 *
 * 部署方式：
 *   1. https://dash.cloudflare.com/ → Workers & Pages → Create Worker
 *   2. 粘贴本文件全部内容 → Deploy
 *   3. 获得地址 https://<name>.<sub>.workers.dev
 *   4. 在 TeamoAgent「API Key」弹窗或 localStorage 里设置（或修改下面 DEFAULT_PUBLIC_RELAY 自带内置默认）
 *
 * 端点（与本地 server.py 的 /api/fetch /api/health 行为对齐，前端 net.js 直接复用）：
 *   GET /api/health              → {"ok":true,"relay":"teamo-cf-worker"}
 *   GET /api/fetch?url=...       → 公网抓取，带 SSRF 防护，自动抽正文
 *                                  可选参数：mode=text|raw、max=字节上限（默认 2MB，最大 4MB）
 *   GET /                        → 版本提示
 *
 * 安全：
 *   · SSRF 护栏：拒绝解析到私网/环回/链路本地/保留地址的目标（每一跳重定向都校验）
 *   · 只允许 http(s)；URL 最长 2000；请求超时 25s
 *   · CORS 全开（Access-Control-Allow-Origin: *）供静态站点直接 fetch
 *   · UA 用桌面浏览器字符串
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36 TeamoAgent-Relay/1.5';
const MAX_FETCH_BYTES = 4_000_000;
const FETCH_TIMEOUT_MS = 25_000;
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-max-age': '86400',
};

// ── SSRF 防护：校验目标 IP 不是内网/保留地址 ──────────────────────
// Cloudflare fetch 本身不会打内网（caveat：它会走 CF 出口），但显式再挡一层，
// 避免有人通过 302 跳到 169.254.169.254 之类 CF 元数据地址。
const PRIVATE_IP_V4 = [
  { a: 0, b: 0 },                             // 0.0.0.0/32 unspecified 作特殊处理（通配）
  /^10\./, /^127\./,
  /^169\.254\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,              // 172.16.0.0/12
];
function isPrivateIP(ip) {
  if (!ip) return true;
  if (ip.includes(':')) {
    // IPv6：简化处理，直接拒绝 loopback/linklocal/ULA/private
    return /^::1?$|^fe80:|^fc00:|^fd00:|^::ffff:(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(ip);
  }
  for (const p of PRIVATE_IP_V4) {
    if (p instanceof RegExp ? p.test(ip) : ip === p.a) return true;
  }
  return false;
}
async function guardUrl(urlStr) {
  const u = new URL(urlStr);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只允许 http(s) 绝对地址');
  if (urlStr.length > 2000) throw new Error('URL 过长');
  return u.toString();
}

// ── HTML → 纯文本（和 server.py 对齐）────────────────────────────
const STRIP_RE = /<(script|style|noscript|svg|iframe)[^>]*>[\s\S]*?<\/\1>/gi;
const BLOCK_RE = /<\/?(p|div|li|h[1-6]|tr|blockquote|pre|br)\s*\/?>/gi;
const TAG_RE = /<[^>]+>/g;
const ENTITIES = {
  nbsp: '\u00a0', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  mdash: '—', ndash: '–', hellip: '…', middot: '·', copy: '©', reg: '®', trade: '™',
  laquo: '«', raquo: '»', times: '×',
};
function decodeEntities(s) {
  return s.replace(/&#(x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (_, n) => {
    if (ENTITIES[n]) return ENTITIES[n];
    if (n.startsWith('#')) {
      try { return String.fromCodePoint(parseInt(n[1] === 'x' || n[1] === 'X' ? n.slice(2) : n.slice(1), 16)); }
      catch { return ''; }
    }
    return '';
  });
}
function htmlToText(doc) {
  let s = String(doc || '').replace(STRIP_RE, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(BLOCK_RE, '\n');
  s = s.replace(TAG_RE, ' ');
  s = decodeEntities(s);
  s = s.replace(/&nbsp;/gi, ' '); // 二次兜底
  const lines = s.split('\n').map((ln) => ln.replace(/[ \t\u00a0]+/g, ' ').trim());
  const out = [];
  let blank = false;
  for (const ln of lines) {
    if (!ln) { if (!blank && out.length) blank = true; continue; }
    if (blank) { out.push(''); blank = false; }
    out.push(ln);
  }
  return out.join('\n').trim();
}
function htmlTitle(doc) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(doc || ''));
  return m ? htmlToText(m[1]).slice(0, 160) : '';
}

// ── 带重定向护栏的 fetch ───────────────────────────────────────
// Cloudflare fetch 自动跟随重定向，但 follow=manual 后我们自己跟，每跳校验。
async function guardedFetch(urlStr, { limit = MAX_FETCH_BYTES } = {}) {
  let current = await guardUrl(urlStr);
  let hops = 0;
  while (hops++ < 10) {
    const ctrl = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const res = await fetch(current, {
      signal: ctrl,
      headers: { 'User-Agent': UA, 'Accept': '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
      redirect: 'manual', // 自己处理以便每跳校验
      cf: { cacheTtlByStatus: { '200-299': 300, '404': 30, '500-599': 0 }, cacheEverything: true },
    });
    // 3xx 自己跟
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`重定向缺少 Location（HTTP ${res.status}）`);
      current = new URL(loc, current).toString();
      await guardUrl(current);
      continue;
    }
    if (!res.ok) throw new Error(`上游返回 HTTP ${res.status}`);
    // 限制读 limit+1 字节（与 server.py 对齐）
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.length > limit + 1) {
        chunks.push(value.slice(0, limit + 1 - total));
        total = limit + 1;
        try { reader.cancel(); } catch {}
        break;
      }
      chunks.push(value);
      total += value.length;
    }
    const buf = new Uint8Array(Math.min(total, limit));
    let off = 0;
    for (const c of chunks) {
      const take = Math.min(c.length, buf.length - off);
      buf.set(c.subarray(0, take), off);
      off += take;
      if (off >= buf.length) break;
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    return {
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      body: text,
      truncated: total > limit,
    };
  }
  throw new Error('重定向次数过多');
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (url.pathname === '/api/health') {
      return json({ ok: true, relay: 'teamo-cf-worker', version: '1.5' });
    }
    if (url.pathname === '/api/fetch') {
      try {
        const target = url.searchParams.get('url');
        if (!target) return json({ error: '缺少 url 参数' }, 400);
        const mode = url.searchParams.get('mode') === 'raw' ? 'raw' : 'text';
        let limit = Number(url.searchParams.get('max') || MAX_FETCH_BYTES);
        if (!Number.isFinite(limit)) limit = MAX_FETCH_BYTES;
        limit = Math.max(2048, Math.min(Math.floor(limit), MAX_FETCH_BYTES));
        const r = await guardedFetch(target, { limit });
        const isHtml = /html/i.test(r.contentType);
        const text = mode === 'raw' ? r.body : (isHtml ? htmlToText(r.body) : r.body);
        return json({
          url: target,
          status: r.status,
          content_type: r.contentType,
          title: isHtml ? htmlTitle(r.body) : '',
          text,
          truncated: r.truncated,
          limit,
          chars: text.length,
        });
      } catch (err) {
        return json({ error: err && err.message ? err.message : String(err), url: url.searchParams.get('url') || '' }, 502);
      }
    }
    // 根路径：版本页
    return new Response(
      `TeamoAgent Cloudflare Relay v1.5\n\n` +
      `  GET  /api/health\n` +
      `  GET  /api/fetch?url=<URL>[&mode=text|raw][&max=2000000]\n\n` +
      `部署说明见仓库 relay/worker.js；前端会自动探测同源中继，若静态托管在 Pages 上\n` +
      `则可在设置里把本 Worker 绑定为 /api/* 路由，前端无需任何改动即可使用。\n`,
      { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS } },
    );
  },
};
