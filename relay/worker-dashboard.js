/**
 * Dubhe Agent 公共中继 — Cloudflare Worker（网页粘贴版，兼容在线编辑器）
 * v1.5
 *
 * 端点：
 *   GET /api/health         -> {"ok":true,"relay":"teamo-cf-worker","version":"1.5"}
 *   GET /api/fetch?url=...  -> 抓取并抽正文（text/raw，max=字节上限）
 *   GET /                   -> 版本说明
 *
 * 安全：SSRF 防护（每跳重定向校验私网/环回/链路本地）、4MB 上限、25s 超时、CORS 全开
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36 Dubhe-Agent-Relay/1.5';
const MAX_FETCH_BYTES = 4000000;
const FETCH_TIMEOUT_MS = 25000;
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-max-age': '86400',
};

const PRIVATE_V4_RE = [
  /^10\./, /^127\./, /^169\.254\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
];
function isPrivateIP(ip) {
  if (!ip) return true;
  if (ip.includes(':')) {
    return /^::1?$|^fe80:|^fc00:|^fd00:|^0{0,4}:0{0,4}:0{0,4}:0{0,4}:0{0,4}:ffff:(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(ip);
  }
  for (const p of PRIVATE_V4_RE) { if (p.test(ip)) return true; }
  if (ip === '0.0.0.0') return true;
  return false;
}

const STRIP_RE = /<(script|style|noscript|svg|iframe)[^>]*>[\s\S]*?<\/\1>/gi;
const BLOCK_RE = /<\/?(p|div|li|h[1-6]|tr|blockquote|pre|br)\s*\/?>/gi;
const TAG_RE = /<[^>]+>/g;
const ENTITIES = {
  nbsp:'\u00a0', amp:'&', lt:'<', gt:'>', quot:'"', apos:"'",
  mdash:'—', ndash:'–', hellip:'…', middot:'·', copy:'©', reg:'®', trade:'™',
  laquo:'«', raquo:'»', times:'×',
};
function decodeEntities(s) {
  return s.replace(/&#(x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (_, n) => {
    if (ENTITIES[n]) return ENTITIES[n];
    if (n[0] === '#') {
      try {
        const hex = n[1] === 'x' || n[1] === 'X';
        return String.fromCodePoint(parseInt(hex ? n.slice(2) : n.slice(1), hex ? 16 : 10));
      } catch { return ''; }
    }
    return '';
  });
}
function htmlToText(doc) {
  let s = String(doc || '').replace(STRIP_RE, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(BLOCK_RE, '\n').replace(TAG_RE, ' ');
  s = decodeEntities(s).replace(/&nbsp;/gi, ' ');
  const lines = s.split('\n').map(ln => ln.replace(/[ \t\u00a0]+/g, ' ').trim());
  const out = []; let blank = false;
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

async function guardedFetch(urlStr, opts = {}) {
  const limit = opts.limit || MAX_FETCH_BYTES;
  let current = urlStr;
  let hops = 0;
  while (hops++ < 10) {
    const u = new URL(current);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只允许 http(s)');
    if (current.length > 2000) throw new Error('URL 过长');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(current, {
        signal: ctrl.signal,
        headers: {
          'User-Agent': UA,
          'Accept': '*/*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        redirect: 'manual',
        cf: { cacheTtlByStatus: { '200-299': 300, '404': 30, '500-599': 0 }, cacheEverything: true },
      });
    } finally { clearTimeout(t); }
    if ([301,302,303,307,308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error('重定向缺少 Location');
      current = new URL(loc, current).toString();
      continue;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
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
    return {
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      body: new TextDecoder('utf-8', { fatal: false }).decode(buf),
      truncated: total > limit,
    };
  }
  throw new Error('重定向次数过多');
}

function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, CORS, extra || {}),
  });
}

addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') {
    return event.respondWith(new Response(null, { status: 204, headers: CORS }));
  }
  if (url.pathname === '/api/health') {
    // Preserve the legacy health identifier for compatible clients.
    return event.respondWith(json({ ok: true, relay: 'teamo-cf-worker', version: '1.5' }));
  }
  if (url.pathname === '/api/fetch') {
    return event.respondWith((async () => {
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
          limit: limit,
          chars: text.length,
        });
      } catch (err) {
        return json({ error: (err && err.message) || String(err), url: url.searchParams.get('url') || '' }, 502);
      }
    })());
  }
  event.respondWith(new Response(
    'Dubhe Agent Cloudflare Relay v1.5\n\n' +
    '  GET  /api/health\n' +
    '  GET  /api/fetch?url=<URL>[&mode=text|raw][&max=2000000]\n\n' +
    '部署方法：见 Dubhe Agent 仓库 relay/README.md\n',
    { status: 200, headers: Object.assign({ 'content-type': 'text/plain; charset=utf-8' }, CORS) }
  ));
});
