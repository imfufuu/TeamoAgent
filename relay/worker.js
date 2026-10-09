/**
 * Dubhe Agent 公共中继 — Cloudflare Worker 版本
 *
 * 部署方式：
 *   1. https://dash.cloudflare.com/ → Workers & Pages → Create Worker
 *   2. 粘贴本文件全部内容 → Deploy
 *   3. 获得地址 https://<name>.<sub>.workers.dev
 *   4. 在 Dubhe Agent「API Key」弹窗或 localStorage 里设置（或修改下面 DEFAULT_PUBLIC_RELAY 自带内置默认）
 *
 * 端点：
 *   GET /api/health                    → 版本与 capabilities
 *   GET /api/fetch?url=...             → 有 SSRF 护栏的单页抓取（text/raw）
 *   GET /api/search?q=...              → SearXNG（配置时）优先 → DuckDuckGo HTML → DuckDuckGo Lite（POST）→ Brave HTML → Bing RSS 依次回退
 *   GET /api/crawl?url=...             → 同源、有限页数/深度的 HTML 正文抓取
 *   GET /api/file?url=...              → 跨域二进制文件拉取（图片 / PDF / 视频 / ZIP，≤ 16MB，原样回传 + CORS）
 *   GET /api/screenshot?url=...        → 网页截图（Cloudflare Browser Run，PNG ≤ 8MB；仅配置 CF_ACCOUNT_ID + CF_API_TOKEN 时出现）
 *                                      可选 max_pages、max_depth、max_bytes、max_chars
 *   GET /                              → 版本提示
 *
 * 配置：可选 Cloudflare Worker 变量 SEARXNG_URL，指向允许 JSON 格式的 HTTPS SearXNG 实例。
 *
 * 安全与范围：
 *   · 拒绝字面私网/环回/链路本地/保留地址；每次重定向重新校验；无 DNS 重绑定保证
 *   · crawl 仅允许初始站点同源链接；不执行 JavaScript，不下载二进制资源；默认 3 页/1 层
 *   · 每页与总页数均有硬上限；外连仅 HTTP(S)，每个 fetch 最长 25s
 *   · CORS 全开供静态站点直连；公开部署建议再用 Cloudflare Rate Limiting 限流
 */

const WORKER_VERSION = '1.8.0';
const UA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36 Dubhe-Agent-Relay/${WORKER_VERSION}`;
const MAX_FETCH_BYTES = 4_000_000;
const MAX_FILE_BYTES = 16 * 1024 * 1024; // /api/file：与前端视频附件上限一致；Worker 128MB 内存，16MB 一次性缓冲安全
const FILE_TIMEOUT_MS = 60_000;
const MAX_SEARCH_BYTES = 600_000;
const MAX_SEARCH_RESULTS = 10;
const MAX_CRAWL_PAGES = 5;
const MAX_CRAWL_DEPTH = 2;
const MAX_CRAWL_BYTES_PER_PAGE = 800_000;
const MAX_CRAWL_PAGE_CHARS = 16_000;
const FETCH_TIMEOUT_MS = 25_000;
const SEARCH_TIMEOUT_MS = 12_000;
// DuckDuckGo 两个入口在被挡时经常是「挂着不回」而不是 202：各给 6s 快速失败，别让回退到 Brave 要等 24s
const DDG_TIMEOUT_MS = 6_000;
const CRAWL_TIMEOUT_MS = 7_000;
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-max-age': '86400',
};

// ── SSRF 防护：拒绝字面私网 IP、localhost 与保留主机名 ─────────────
// Workers 不提供通用 DNS 解析 API；Cloudflare 出口还会阻止部分私网目标。
// 这里对 URL 字面值和每次重定向做显式校验，不把它夸大成 DNS 重绑定防护。
function isPrivateIP(ip) {
  const value = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!value) return true;
  if (value.includes(':')) {
    if (value === '::' || value === '::1' || value.startsWith('::ffff:') || value.startsWith('::')) return true;
    if (/^f[cd][0-9a-f]{2}:/i.test(value)) return true; // fc00::/7 ULA
    if (/^fe[89ab][0-9a-f]:/i.test(value)) return true; // fe80::/10 link-local
    if (/^ff[0-9a-f]{2}:/i.test(value)) return true; // multicast
    if (/^2001:db8:/i.test(value) || /^2002:/i.test(value)) return true; // documentation / 6to4
    return false;
  }
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return false;
  const octets = value.split('.').map(Number);
  if (octets.some((n) => n < 0 || n > 255)) return true;
  const [a, b, c] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) // 100.64.0.0/10
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100))
    || (a === 203 && b === 0 && c === 113);
}
const PRIVATE_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.test', '.invalid', '.example'];
function unsafeHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return !host || host === 'localhost' || PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)) || isPrivateIP(host);
}
async function guardUrl(urlStr) {
  const raw = String(urlStr || '');
  if (!raw || raw.length > 2000) throw new Error(raw ? 'URL 过长' : '缺少 URL');
  let u;
  try { u = new URL(raw); } catch { throw new Error('URL 格式无效'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只允许 http(s) 绝对地址');
  if (u.username || u.password) throw new Error('URL 不得包含用户名或密码');
  if (unsafeHostname(u.hostname)) throw new Error('目标主机属于内网、环回或保留地址，已拒绝抓取');
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
function decodeEntities(value) {
  return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, token) => {
    if (token[0] === '#') {
      const hex = token[1].toLowerCase() === 'x';
      const codePoint = parseInt(token.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return '\uFFFD';
      try { return String.fromCodePoint(codePoint); } catch { return '\uFFFD'; }
    }
    const named = ENTITIES[token.toLowerCase()];
    return named === undefined ? match : named;
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


// ── HTMLRewriter 正文提取 / 爬虫链接解析 ─────────────────────────
const SKIP_HTML_SELECTOR = 'script,style,noscript,svg,iframe,object,nav,header,footer,aside,form,button';
const BLOCK_HTML_SELECTOR = 'address,article,blockquote,br,dd,div,dl,dt,fieldset,figcaption,figure,h1,h2,h3,h4,h5,h6,hr,li,main,ol,p,pre,section,table,tr,td,th,ul';
const BINARY_PATH_RE = /\.(?:7z|avi|bmp|css|docx?|eot|gif|heic|heif|ico|jpe?g|js|m4a|mkv|mov|mp3|mp4|pdf|png|pptx?|rar|svg|tar|tif?f|webp|woff2?|xlsx?|zip)(?:$|\/)/i;
function cleanExtractedText(value) {
  return String(value || '').replace(/\r/g, '').replace(/[ \t\u00a0]+/g, ' ')
    .split('\n').map((line) => line.trim()).filter((line, i, all) => line || (i > 0 && all[i - 1]))
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
function publicHttpUrl(raw) {
  try {
    let value = decodeEntities(String(raw || '').trim());
    if (value.startsWith('//')) value = `https:${value}`;
    const u = new URL(value);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || unsafeHostname(u.hostname)) return '';
    return u.toString();
  } catch { return ''; }
}
function normalizeCrawlLink(href, baseUrl) {
  const raw = decodeEntities(String(href || '').trim());
  if (!raw || /^(?:#|mailto:|javascript:|tel:|data:)/i.test(raw)) return '';
  try {
    const base = new URL(baseUrl);
    const u = new URL(raw, base);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.origin !== base.origin || unsafeHostname(u.hostname)) return '';
    if (BINARY_PATH_RE.test(u.pathname)) return '';
    u.hash = '';
    return u.toString();
  } catch { return ''; }
}
function metaDescriptionFromHtml(html) {
  for (const tag of String(html || '').match(/<meta\b[^>]*>/gi) || []) {
    const name = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    if (!name || String(name[1] || name[2] || name[3] || '').toLowerCase() !== 'description') continue;
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    if (content) return cleanExtractedText(decodeEntities(content[1] || content[2] || content[3] || '')).slice(0, 500);
  }
  return '';
}
function fallbackExtractHtml(html, baseUrl, maxLinks) {
  const source = String(html || '');
  const links = [];
  for (const match of source.matchAll(/<a\b[^>]*>/gi)) {
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[0]);
    if (!href) continue;
    const link = normalizeCrawlLink(href[1] || href[2] || href[3], baseUrl);
    if (link && !links.includes(link)) links.push(link);
    if (links.length >= maxLinks) break;
  }
  const readable = source.replace(/<(nav|header|footer|aside|form|button)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  return { title: htmlTitle(source), description: metaDescriptionFromHtml(source), text: htmlToText(readable), links };
}
async function extractHtmlDocument(html, baseUrl, maxLinks = 40) {
  const source = String(html || '');
  if (typeof HTMLRewriter !== 'function') return fallbackExtractHtml(source, baseUrl, maxLinks);
  const data = { title: '', description: '', text: [], links: [] };
  try {
    const rewriter = new HTMLRewriter()
      .on(SKIP_HTML_SELECTOR, { element(el) { el.remove(); } })
      .on('title', { text(chunk) { data.title += chunk.text; } })
      .on('meta[name]', { element(el) {
        if (String(el.getAttribute('name') || '').toLowerCase() === 'description') {
          data.description = String(el.getAttribute('content') || '').slice(0, 1000);
        }
      } })
      .on(BLOCK_HTML_SELECTOR, { element() { data.text.push('\n'); } })
      .on('a[href]', { element(el) {
        if (data.links.length >= maxLinks) return;
        const link = normalizeCrawlLink(el.getAttribute('href'), baseUrl);
        if (link && !data.links.includes(link)) data.links.push(link);
      } })
      .on('*', { text(chunk) { data.text.push(chunk.text); } });
    // 消费变换流会触发 selector 回调；正文只保留 text chunks，不把脚本/导航送给调用方。
    await rewriter.transform(new Response(source, { headers: { 'content-type': 'text/html; charset=utf-8' } })).text();
    return {
      title: cleanExtractedText(data.title).slice(0, 160) || htmlTitle(source),
      description: cleanExtractedText(data.description).slice(0, 500) || metaDescriptionFromHtml(source),
      text: cleanExtractedText(data.text.join('')),
      links: data.links,
    };
  } catch {
    // 若测试桩/极旧运行时不兼容 HTMLRewriter selector，则走无依赖的有限 HTML 解析回退。
    return fallbackExtractHtml(source, baseUrl, maxLinks);
  }
}

function clampInt(value, min, max, fallback) {
  const empty = value === null || value === undefined || String(value).trim() === '';
  const n = empty ? Number.NaN : Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
}
function normalizeSearchResult(item, source = '') {
  if (!item || typeof item !== 'object') return null;
  const url = publicHttpUrl(item.url || item.link || '');
  if (!url) return null;
  return {
    title: cleanExtractedText(item.title || item.name || url).slice(0, 240),
    url,
    snippet: cleanExtractedText(item.content || item.snippet || item.description || '').slice(0, 800),
    source: cleanExtractedText(item.engine || source || '').slice(0, 80),
  };
}
function unwrapDuckUrl(raw) {
  const target = publicHttpUrl(raw);
  if (!target) return '';
  try {
    const u = new URL(target);
    if (/(^|\.)duckduckgo\.com$/i.test(u.hostname) && u.pathname.includes('/l/')) {
      const redirect = u.searchParams.get('uddg');
      return redirect ? publicHttpUrl(redirect) : '';
    }
  } catch { return ''; }
  return target;
}
function parseDuckDuckGoHtml(html, limit) {
  const source = String(html || '');
  const anchors = [...source.matchAll(/<a\b[^>]*\bclass\s*=\s*(["'])[^"']*\bresult__a\b[^"']*\1[^>]*>[\s\S]*?<\/a\s*>/gi)];
  const results = [];
  for (let i = 0; i < anchors.length && results.length < limit; i++) {
    const match = anchors[i];
    const tagEnd = match[0].indexOf('>');
    const tag = match[0].slice(0, tagEnd + 1);
    const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const href = hrefMatch && (hrefMatch[1] || hrefMatch[2] || hrefMatch[3]);
    const url = unwrapDuckUrl(href);
    if (!url) continue;
    const title = htmlToText(match[0].slice(tagEnd + 1).replace(/<\/a\s*>$/i, ''));
    const start = (match.index || 0) + match[0].length;
    const next = anchors[i + 1] ? anchors[i + 1].index : Math.min(source.length, start + 1600);
    const segment = source.slice(start, next < 0 ? start + 1600 : next);
    const snippet = htmlToText(segment).slice(0, 500);
    const item = normalizeSearchResult({ title, url, snippet }, 'DuckDuckGo');
    if (item && !results.some((r) => r.url === item.url)) results.push(item);
  }
  return results;
}
async function searchSearXNG(query, limit, env = {}, signal) {
  const configured = String(env.SEARXNG_URL || '').trim();
  if (!configured) return null;
  let endpoint;
  try { endpoint = new URL(configured); } catch { throw new Error('SEARXNG_URL 不是有效 URL'); }
  if (endpoint.protocol !== 'https:' || unsafeHostname(endpoint.hostname)) throw new Error('SEARXNG_URL 必须是可公开访问的 HTTPS 地址');
  const path = endpoint.pathname.replace(/\/+$/, '');
  if (!/\/search$/i.test(path)) endpoint.pathname = `${path}/search` || '/search';
  endpoint.searchParams.set('q', query);
  endpoint.searchParams.set('format', 'json');
  endpoint.searchParams.set('language', 'all');
  const response = await guardedFetch(endpoint.toString(), {
    limit: MAX_SEARCH_BYTES, cache: false, maxRedirects: 3, timeoutMs: SEARCH_TIMEOUT_MS, signal,
    accept: 'application/json',
  });
  if (response.truncated) throw new Error('SearXNG JSON 响应超过大小限制');
  let body;
  try { body = JSON.parse(response.body); } catch { throw new Error('SearXNG 没有返回有效 JSON（实例可能未启用 JSON 输出）'); }
  if (!Array.isArray(body.results)) throw new Error('SearXNG 响应缺少 results 数组');
  const results = [];
  for (const raw of body.results) {
    const item = normalizeSearchResult(raw, 'SearXNG');
    if (item && !results.some((r) => r.url === item.url)) results.push(item);
    if (results.length >= limit) break;
  }
  if (!results.length) throw new Error('SearXNG 没有返回可用结果');
  return { provider: 'SearXNG', results };
}
// DuckDuckGo Lite（POST 表单）：同一个出口 IP 上 html.duckduckgo.com GET 被 202 人机页挡住时，lite 的 POST 入口往往还能正常返回
// （2026-10-07 实测）。结果是表格：<a class='result-link' href=...>标题</a> + <td class='result-snippet'>摘要</td>。
function parseDuckDuckGoLite(html, limit) {
  const source = String(html || '');
  const anchors = [...source.matchAll(/<a\b[^>]*\bclass\s*=\s*(["'])result-link\1[^>]*>[\s\S]*?<\/a\s*>/gi)];
  const results = [];
  for (let i = 0; i < anchors.length && results.length < limit; i++) {
    const match = anchors[i];
    const tagEnd = match[0].indexOf('>');
    const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[0].slice(0, tagEnd + 1));
    const url = unwrapDuckUrl(hrefMatch && (hrefMatch[1] || hrefMatch[2] || hrefMatch[3]));
    if (!url) continue;
    const title = htmlToText(match[0].slice(tagEnd + 1).replace(/<\/a\s*>$/i, ''));
    const start = (match.index || 0) + match[0].length;
    const next = anchors[i + 1] ? anchors[i + 1].index : Math.min(source.length, start + 2000);
    const seg = source.slice(start, next);
    const sn = /<td\b[^>]*\bclass\s*=\s*(["'])result-snippet\1[^>]*>([\s\S]*?)<\/td>/i.exec(seg);
    const snippet = htmlToText(sn ? sn[2] : '').slice(0, 500);
    const item = normalizeSearchResult({ title, url, snippet }, 'DuckDuckGo Lite');
    if (item && !results.some((r) => r.url === item.url)) results.push(item);
  }
  return results;
}
async function searchDuckDuckGoLite(query, limit, signal) {
  const response = await guardedFetch('https://lite.duckduckgo.com/lite/', {
    limit: MAX_SEARCH_BYTES, cache: false, maxRedirects: 3, timeoutMs: DDG_TIMEOUT_MS, signal,
    method: 'POST', body: new URLSearchParams({ q: query, kl: 'wt-wt' }).toString(), contentType: 'application/x-www-form-urlencoded',
    accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  });
  const results = parseDuckDuckGoLite(response.body, limit);
  if (!results.length) throw new Error('DuckDuckGo Lite 没有解析到结果（可能被上游限流）');
  return { provider: 'DuckDuckGo Lite', results, truncated: response.truncated };
}
async function searchDuckDuckGo(query, limit, signal) {
  const endpoint = new URL('https://html.duckduckgo.com/html/');
  endpoint.searchParams.set('q', query);
  const response = await guardedFetch(endpoint.toString(), {
    limit: MAX_SEARCH_BYTES, cache: false, maxRedirects: 3, timeoutMs: DDG_TIMEOUT_MS, signal,
    accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  });
  const results = parseDuckDuckGoHtml(response.body, limit);
  if (!results.length) throw new Error('DuckDuckGo HTML 没有解析到结果（可能被上游限流）');
  return { provider: 'DuckDuckGo', results, truncated: response.truncated };
}
// DuckDuckGo 从 2026-10 起对 Cloudflare 出口 IP 普遍返回 202 + 「anomaly / challenge」人机页（html 与 lite 两个入口都一样），
// 解析不到结果就等于搜索整条链路挂掉。Bing 的 RSS 输出（/search?format=rss）不需要 Key、对数据中心 IP 也稳定，作为第二回退。
function parseBingRss(xml, limit) {
  const source = String(xml || '');
  const items = [...source.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
  const pick = (block, tag) => {
    const m = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block);
    if (!m) return '';
    return decodeEntities(String(m[1]).replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1'));
  };
  const results = [];
  for (const it of items) {
    const block = it[1];
    const item = normalizeSearchResult({ title: htmlToText(pick(block, 'title')), url: pick(block, 'link'), snippet: htmlToText(pick(block, 'description')) }, 'Bing');
    if (item && !results.some((r) => r.url === item.url)) results.push(item);
    if (results.length >= limit) break;
  }
  return results;
}
async function searchBing(query, limit, signal) {
  const endpoint = new URL('https://www.bing.com/search');
  endpoint.searchParams.set('q', query);
  endpoint.searchParams.set('format', 'rss');
  endpoint.searchParams.set('count', String(Math.max(limit, 10)));
  // 注意：不要加 mkt / setlang——2026-10-07 实测带上后 Bing 对无 cookie 的数据中心请求返回整页无关结果（YouTube / 百度经验），不带反而正常。
  const response = await guardedFetch(endpoint.toString(), {
    limit: MAX_SEARCH_BYTES, cache: false, maxRedirects: 3, timeoutMs: SEARCH_TIMEOUT_MS, signal,
    accept: 'application/rss+xml,application/xml;q=0.9,text/xml;q=0.8,*/*;q=0.5',
  });
  const results = parseBingRss(response.body, limit);
  if (!results.length) throw new Error('Bing RSS 没有解析到结果');
  return { provider: 'Bing', results, truncated: response.truncated };
}
// Brave Search（HTML）：对数据中心出口最宽容、结果质量也最好的一家（2026-10-07 实测 DuckDuckGo 两个入口都挡、Bing RSS 偶发整页无关结果时，
// Brave 仍能把目标仓库排第一）。结构：<div class="snippet …" data-type="web"> → 第一个 <a href> 是落地页，
// <div class="… search-snippet-title …" title="…"> 是标题，<div class="generic-snippet"><div class="content …">…</div> 是摘要。
function parseBraveHtml(html, limit) {
  const source = String(html || '');
  const blocks = source.split(/<div\b[^>]*\bclass\s*=\s*"snippet(?:\s[^"]*)?"[^>]*\bdata-type\s*=\s*"web"[^>]*>/i).slice(1);
  const results = [];
  for (const block of blocks) {
    const href = /<a\b[^>]*\bhref\s*=\s*"(https?:\/\/[^"]+)"/i.exec(block);
    if (!href) continue;
    const t = /search-snippet-title[^>]*\btitle\s*=\s*"([^"]*)"/i.exec(block);
    const sn = /generic-snippet[\s\S]*?<div\b[^>]*\bclass\s*=\s*"content[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block);
    const item = normalizeSearchResult({ title: htmlToText(t ? decodeEntities(t[1]) : ''), url: decodeEntities(href[1]), snippet: htmlToText(sn ? sn[1] : '').slice(0, 500) }, 'Brave');
    if (item && !results.some((r) => r.url === item.url)) results.push(item);
    if (results.length >= limit) break;
  }
  return results;
}
async function searchBrave(query, limit, signal) {
  const endpoint = new URL('https://search.brave.com/search');
  endpoint.searchParams.set('q', query);
  endpoint.searchParams.set('source', 'web');
  const response = await guardedFetch(endpoint.toString(), {
    limit: MAX_SEARCH_BYTES, cache: false, maxRedirects: 3, timeoutMs: SEARCH_TIMEOUT_MS, signal,
    accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  });
  const results = parseBraveHtml(response.body, limit);
  if (!results.length) throw new Error('Brave 没有解析到结果（可能被上游限流）');
  return { provider: 'Brave', results, truncated: response.truncated };
}
async function searchWeb(query, limit, env = {}, signal) {
  const errors = [];
  const providers = [];
  if (String(env.SEARXNG_URL || '').trim()) providers.push(['SearXNG', () => searchSearXNG(query, limit, env, signal)]);
  providers.push(['DuckDuckGo', () => searchDuckDuckGo(query, limit, signal)]);
  providers.push(['DuckDuckGo Lite', () => searchDuckDuckGoLite(query, limit, signal)]);
  providers.push(['Brave', () => searchBrave(query, limit, signal)]);
  providers.push(['Bing', () => searchBing(query, limit, signal)]);
  for (const [name, run] of providers) {
    try {
      const result = await run();
      if (!result) continue;
      const fallback = errors.length > 0;
      return {
        query,
        ...result,
        fallback,
        tried: errors.map((e) => e.provider),
        warning: fallback
          ? `${errors.map((e) => `${e.provider} 不可用（${e.error}）`).join('；')}，已回退 ${name}`
          : (env.SEARXNG_URL || name !== 'DuckDuckGo' ? '' : '未配置 SearXNG，使用 DuckDuckGo HTML 适配器'),
      };
    } catch (err) {
      if (signal && signal.aborted) throw err;
      errors.push({ provider: name, error: String(err && err.message || err).slice(0, 160) });
    }
  }
  throw new Error(`所有搜索源都失败：${errors.map((e) => `${e.provider}：${e.error}`).join('；')}`);
}

async function crawlSite({ url, maxPages = 3, maxDepth = 1, maxBytesPerPage = 250_000, maxCharsPerPage = 12_000, signal } = {}) {
  const startUrl = await guardUrl(url);
  const start = new URL(startUrl);
  const maxPageCount = clampInt(maxPages, 1, MAX_CRAWL_PAGES, 3);
  const depthLimit = clampInt(maxDepth, 0, MAX_CRAWL_DEPTH, 1);
  const byteLimit = clampInt(maxBytesPerPage, 2048, MAX_CRAWL_BYTES_PER_PAGE, 250_000);
  const charLimit = clampInt(maxCharsPerPage, 1000, MAX_CRAWL_PAGE_CHARS, 12_000);
  const queue = [{ url: startUrl, depth: 0 }];
  const queued = new Set([startUrl]);
  const visited = new Set();
  const pages = [];
  const errors = [];
  let truncated = false;
  while (queue.length && visited.size < maxPageCount) {
    const current = queue.shift();
    if (!current || visited.has(current.url)) continue;
    visited.add(current.url);
    try {
      const response = await guardedFetch(current.url, {
        limit: byteLimit, cache: true, maxRedirects: 4, timeoutMs: CRAWL_TIMEOUT_MS, signal,
        allowedOrigin: start.origin,
        accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5',
      });
      const contentType = response.contentType || '';
      const finalUrl = response.url || current.url;
      if (new URL(finalUrl).origin !== start.origin) throw new Error('重定向离开初始站点，已停止此页');
      const isHtml = /html|xhtml/i.test(contentType);
      const isText = /text\/|json|xml|javascript/i.test(contentType);
      if (!isHtml && !isText) throw new Error(`跳过非文本页面（${contentType || '未知类型'}）`);
      const extracted = isHtml
        ? await extractHtmlDocument(response.body, finalUrl, 40)
        : { title: finalUrl, description: '', text: response.body, links: [] };
      const fullText = cleanExtractedText(extracted.text);
      const page = {
        url: finalUrl,
        title: extracted.title || finalUrl,
        description: extracted.description || '',
        depth: current.depth,
        chars: fullText.length,
        text: fullText.slice(0, charLimit),
        truncated: response.truncated || fullText.length > charLimit,
      };
      pages.push(page);
      if (response.truncated) truncated = true;
      if (current.depth >= depthLimit) continue;
      for (const link of extracted.links || []) {
        if (queue.length + visited.size >= maxPageCount) {
          truncated = true;
          break;
        }
        if (visited.has(link) || queued.has(link)) continue;
        queued.add(link);
        queue.push({ url: link, depth: current.depth + 1 });
      }
    } catch (err) {
      errors.push({ url: current.url, error: String(err && err.message || err).slice(0, 240) });
    }
  }
  if (queue.length) truncated = true;
  if (!pages.length) throw new Error(errors[0] ? `没有可用页面：${errors[0].error}` : '没有抓取到页面');
  return {
    url: startUrl,
    origin: start.origin,
    pages,
    errors,
    visited: visited.size,
    max_pages: maxPageCount,
    max_depth: depthLimit,
    truncated,
    chars_total: pages.reduce((n, page) => n + page.chars, 0),
  };
}

// ── 带重定向护栏的 fetch ───────────────────────────────────────
// Cloudflare fetch 自动跟随重定向，但 follow=manual 后我们自己跟，每跳校验。
async function guardedFetch(urlStr, { limit = MAX_FETCH_BYTES, cache = true, maxRedirects = 5, timeoutMs = FETCH_TIMEOUT_MS, accept = '*/*', signal, allowedOrigin, binary = false, method = 'GET', body = null, contentType = '' } = {}) {
  let current = await guardUrl(urlStr);
  let hops = 0;
  while (hops++ <= maxRedirects) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([timeoutSignal, signal])
      : (signal || timeoutSignal);
    const init = {
      method,
      signal: requestSignal,
      headers: { 'User-Agent': UA, 'Accept': accept, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', ...(contentType ? { 'Content-Type': contentType } : {}) },
      redirect: 'manual', // 自己处理以便每跳校验
    };
    if (body != null && method !== 'GET') init.body = body;
    if (cache && method === 'GET') init.cf = { cacheTtlByStatus: { '200-299': 300, '404': 30, '500-599': 0 }, cacheEverything: true };
    const res = await fetch(current, init);
    // 3xx 自己跟
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`重定向缺少 Location（HTTP ${res.status}）`);
      current = await guardUrl(new URL(loc, current).toString());
      if (allowedOrigin && new URL(current).origin !== allowedOrigin) throw new Error('重定向离开初始站点，已拒绝');
      continue;
    }
    if (!res.ok) throw new Error(`上游返回 HTTP ${res.status}`);
    // 限制读 limit+1 字节（与 server.py 对齐）
    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    if (!reader) return { status: res.status, contentType: res.headers.get('content-type') || '', body: '', truncated: false, url: current };
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.length > limit + 1) {
        chunks.push(value.slice(0, limit + 1 - total));
        total = limit + 1;
        try { await reader.cancel(); } catch {}
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
    if (binary) {
      return {
        status: res.status,
        contentType: res.headers.get('content-type') || '',
        bytes: buf,
        truncated: total > limit,
        url: current,
        lastModified: res.headers.get('last-modified') || '',
      };
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    return {
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      body: text,
      truncated: total > limit,
      url: current,
    };
  }
  throw new Error(`重定向次数过多（上限 ${maxRedirects}）`);
}

// 从 URL 路径猜文件名；没有扩展名时按 Content-Type 补一个，保证前端能按后缀分流（图片 / 视频 / PDF / ZIP）
const MIME_EXT = [
  [/^image\/jpeg/i, 'jpg'], [/^image\/png/i, 'png'], [/^image\/gif/i, 'gif'], [/^image\/webp/i, 'webp'], [/^image\/svg/i, 'svg'],
  [/^video\/mp4/i, 'mp4'], [/^video\/webm/i, 'webm'], [/^video\/quicktime/i, 'mov'],
  [/^application\/pdf/i, 'pdf'], [/zip/i, 'zip'], [/^application\/json/i, 'json'], [/^text\/html/i, 'html'], [/^text\/plain/i, 'txt'], [/^text\/csv/i, 'csv'],
];
function fileNameFromUrl(u, contentType) {
  let name = '';
  try { name = decodeURIComponent(new URL(u).pathname.split('/').filter(Boolean).pop() || ''); } catch { name = ''; }
  name = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 120);
  if (!name) name = 'download';
  if (!/\.[a-z0-9]{1,5}$/i.test(name)) {
    const hit = MIME_EXT.find(([re]) => re.test(String(contentType || '')));
    if (hit) name += `.${hit[1]}`;
  }
  return name;
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });
}

// ── 网页截图（Cloudflare Browser Run REST · /browser-rendering/screenshot）─────────────
// 只有 env.CF_ACCOUNT_ID 与 env.CF_API_TOKEN 都已配置时才声明 screenshot 能力：健康检查据此决定前端是否提供
// screenshot_web 工具，所以未配置的 Worker 行为与旧版完全一致。Token 需要「Browser Rendering Write」权限。
// 视口预设：desktop 1280×800 / tablet 820×1180 / mobile 390×844；full_page 长图；selector 只截单个元素；wait_ms 额外等待。
// 返回 PNG 原字节（≤ 8MB）。Browser Run 按量计费，前端只在用户明确要求截图时才会调用。
const SCREENSHOT_VIEWPORTS = Object.freeze({
  desktop: { width: 1280, height: 800, isMobile: false },
  tablet: { width: 820, height: 1180, isMobile: true },
  mobile: { width: 390, height: 844, isMobile: true },
});
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const SCREENSHOT_TIMEOUT_MS = 40_000;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const screenshotConfigured = (env = {}) => !!(env && env.CF_ACCOUNT_ID && env.CF_API_TOKEN);

async function takeScreenshot(env, { url, viewport = 'desktop', width, height, fullPage = false, waitMs = 0, selector = '' } = {}) {
  const preset = SCREENSHOT_VIEWPORTS[viewport] || SCREENSHOT_VIEWPORTS.desktop;
  const w = clampInt(width, 320, 1920, preset.width);
  const h = clampInt(height, 320, 2400, preset.height);
  const body = {
    url,
    viewport: { width: w, height: h, deviceScaleFactor: 1, isMobile: preset.isMobile, hasTouch: preset.isMobile },
    gotoOptions: { waitUntil: 'networkidle2', timeout: SCREENSHOT_TIMEOUT_MS - 10_000 },
    screenshotOptions: { fullPage: !!fullPage, type: 'png', omitBackground: false },
  };
  if (waitMs > 0) body.waitForTimeout = waitMs;
  if (selector) body.selector = selector;
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID)}/browser-rendering/screenshot?cacheTTL=0`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, 'content-type': 'application/json', accept: 'image/png, application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SCREENSHOT_TIMEOUT_MS),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = (Array.isArray(j.errors) && j.errors.map((x) => (x && x.message) || String(x)).join('; ')) || j.error || '';
    } catch { detail = res.statusText || ''; }
    throw Object.assign(new Error(`Browser Run 截图失败（HTTP ${res.status}）${detail ? `：${String(detail).slice(0, 300)}` : ''}`), { status: res.status >= 500 ? 502 : 400 });
  }
  let bytes;
  if (/application\/json/i.test(res.headers.get('content-type') || '')) {
    // 若接口以 JSON 返回 base64 结果，同样解码
    const j = await res.json().catch(() => ({}));
    const b64 = typeof j.result === 'string' ? j.result : (typeof j.data === 'string' ? j.data : '');
    if (!b64) throw Object.assign(new Error('Browser Run 返回了无法识别的 JSON 响应'), { status: 502 });
    const bin = atob(b64);
    bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } else {
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  if (bytes.byteLength > MAX_SCREENSHOT_BYTES) throw Object.assign(new Error(`截图超过 ${Math.round(MAX_SCREENSHOT_BYTES / 1024 / 1024)}MB 上限（试试关闭整页或换小视口）`), { status: 413 });
  if (bytes.byteLength < PNG_MAGIC.length || PNG_MAGIC.some((b, i) => bytes[i] !== b)) throw Object.assign(new Error('Browser Run 返回的不是 PNG 图片'), { status: 502 });
  return { bytes, width: w, height: h };
}

export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'GET') return json({ error: '只允许 GET 请求' }, 405);
    if (url.pathname === '/api/health') {
      // Keep this legacy health identifier stable for clients that inspect metadata.
      const capabilities = ['fetch', 'search', 'crawl', 'file'];
      if (screenshotConfigured(env)) capabilities.push('screenshot');
      return json({ ok: true, relay: 'dubhe-cf-worker', version: WORKER_VERSION, capabilities, limits: { file_bytes: MAX_FILE_BYTES, screenshot_bytes: MAX_SCREENSHOT_BYTES } });
    }
    if (url.pathname === '/api/search') {
      try {
        const query = String(url.searchParams.get('q') || '').trim();
        if (!query) return json({ error: '缺少 q 参数' }, 400);
        if (query.length > 500) return json({ error: '搜索词不能超过 500 个字符' }, 400);
        const limit = clampInt(url.searchParams.get('limit'), 1, MAX_SEARCH_RESULTS, 5);
        return json(await searchWeb(query, limit, env, request.signal));
      } catch (err) {
        return json({ error: err && err.message ? err.message : String(err) }, 502);
      }
    }
    if (url.pathname === '/api/crawl') {
      try {
        const target = url.searchParams.get('url');
        if (!target) return json({ error: '缺少 url 参数' }, 400);
        const result = await crawlSite({
          url: target,
          maxPages: url.searchParams.get('max_pages'),
          maxDepth: url.searchParams.get('max_depth'),
          maxBytesPerPage: url.searchParams.get('max_bytes'),
          maxCharsPerPage: url.searchParams.get('max_chars'),
          signal: request.signal,
        });
        return json(result);
      } catch (err) {
        return json({ error: err && err.message ? err.message : String(err), url: url.searchParams.get('url') || '' }, 502);
      }
    }
    if (url.pathname === '/api/file') {
      // 跨域二进制拉取：浏览器直连会被目标站 CORS 拦下，这里原样转发字节并加 CORS 头。
      // 同一套 SSRF 护栏（guardUrl）与重定向逐跳校验；超过上限直接 413 而不是截断（半个视频 / ZIP 没有意义）。
      const target = url.searchParams.get('url') || '';
      try {
        if (!target) return json({ error: '缺少 url 参数' }, 400);
        let limit = Number(url.searchParams.get('max') || MAX_FILE_BYTES);
        if (!Number.isFinite(limit)) limit = MAX_FILE_BYTES;
        limit = Math.max(1024, Math.min(Math.floor(limit), MAX_FILE_BYTES));
        const r = await guardedFetch(target, { limit, binary: true, cache: false, timeoutMs: FILE_TIMEOUT_MS, signal: request.signal });
        if (r.truncated) return json({ error: `文件超过上限 ${Math.round(limit / 1024 / 1024)}MB`, url: target, limit }, 413);
        const name = fileNameFromUrl(r.url || target, r.contentType);
        return new Response(r.bytes, {
          status: 200,
          headers: {
            ...CORS,
            'content-type': r.contentType || 'application/octet-stream',
            'content-length': String(r.bytes.length),
            'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
            'cache-control': 'no-store',
            'x-dubhe-final-url': encodeURI(r.url || target),
            'x-dubhe-file-name': encodeURIComponent(name),
            'access-control-expose-headers': 'content-type, content-length, content-disposition, x-dubhe-final-url, x-dubhe-file-name',
          },
        });
      } catch (err) {
        return json({ error: err && err.message ? err.message : String(err), url: target }, 502);
      }
    }
    if (url.pathname === '/api/screenshot') {
      // 网页截图：未配置 Browser Run 凭据时 404 并说明原因；URL 先过同一套 SSRF 护栏（guardUrl）再交给 Browser Run。
      if (!screenshotConfigured(env)) return json({ error: '本 Worker 未配置网页截图（需要 CF_ACCOUNT_ID 与 CF_API_TOKEN，见 relay/README.md）' }, 404);
      const target = url.searchParams.get('url') || '';
      let safe;
      try { safe = await guardUrl(target); } catch (err) { return json({ error: err && err.message ? err.message : String(err), url: target }, 400); }
      try {
        const shot = await takeScreenshot(env, {
          url: safe,
          viewport: String(url.searchParams.get('viewport') || 'desktop').toLowerCase(),
          width: url.searchParams.get('width'),
          height: url.searchParams.get('height'),
          fullPage: /^(1|true|yes)$/i.test(url.searchParams.get('full_page') || ''),
          waitMs: clampInt(url.searchParams.get('wait_ms'), 0, 10000, 0),
          selector: String(url.searchParams.get('selector') || '').slice(0, 200),
        });
        return new Response(shot.bytes, {
          status: 200,
          headers: {
            ...CORS,
            'content-type': 'image/png',
            'content-length': String(shot.bytes.length),
            'cache-control': 'no-store',
            'x-dubhe-final-url': encodeURI(safe),
            'x-dubhe-viewport': `${shot.width}x${shot.height}`,
            'access-control-expose-headers': 'content-type, content-length, x-dubhe-final-url, x-dubhe-viewport',
          },
        });
      } catch (err) {
        return json({ error: err && err.message ? err.message : String(err), url: target }, err && err.status ? err.status : 502);
      }
    }
    if (url.pathname === '/api/fetch') {
      try {
        const target = url.searchParams.get('url');
        if (!target) return json({ error: '缺少 url 参数' }, 400);
        const mode = url.searchParams.get('mode') === 'raw' ? 'raw' : 'text';
        let limit = Number(url.searchParams.get('max') || MAX_FETCH_BYTES);
        if (!Number.isFinite(limit)) limit = MAX_FETCH_BYTES;
        limit = Math.max(2048, Math.min(Math.floor(limit), MAX_FETCH_BYTES));
        const r = await guardedFetch(target, { limit, signal: request.signal });
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
      `Dubhe Agent Cloudflare Relay v${WORKER_VERSION}\n\n` +
      `  GET  /api/health\n` +
      `  GET  /api/fetch?url=<URL>[&mode=text|raw][&max=4000000]\n` +
      `  GET  /api/search?q=<query>[&limit=1..10]\n` +
      `  GET  /api/crawl?url=<URL>[&max_pages=1..5][&max_depth=0..2]\n` +
      `  GET  /api/file?url=<URL>[&max=1024..${MAX_FILE_BYTES}]   （二进制原样回传，≤16MB）\n` +
      `  GET  /api/screenshot?url=<URL>[&viewport=desktop|tablet|mobile][&full_page=1][&wait_ms=0..10000][&selector=CSS]   （需 CF_ACCOUNT_ID / CF_API_TOKEN，返回 PNG）\n\n` +
      `部署说明见仓库 relay/worker.js；搜索可选配置 SEARXNG_URL。\n` +
      `公开部署建议为 /api/search 与 /api/crawl 配置 Cloudflare 限流规则。\n`,
      { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS } },
    );
  },
};
