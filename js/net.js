// ─── 网络能力：网页抓取 / git（git 内置轻量引擎；联网 git 仍走中继）────────
//
// 中继探测顺序（relay 自动）：
//   ① 同源中继（本地 python3 server.py，或 Pages/Functions 把 /api/* 绑到 Worker）
//   ② 用户在 localStorage 手动设置的公共中继（key: teamo-relay，值如 https://xxx.workers.dev）
//   ③ 内置公共 Cloudflare Worker 中继候选（留空可由用户或社区自行部署）
//   全部不可用时给出可操作的错误提示，而不是返回假结果。
//
// 模型原生网页搜索字段保持关闭；另提供显式 search_web / crawl_site 工具，只有 health 声明对应能力的
// Cloudflare Worker 才会被选作这两个路由，避免误调旧版本地 relay 的 404。
//
// 注意：本模块被 tools.js 与测试引用；具名导出形状需保持稳定避免 ESM 混版缓存白屏。

// 当前选中的 relay endpoints 包；初始指向同源，探测成功后替换为公共 relay 地址
let RELAY = { base: '', fetch: '/api/fetch', git: '/api/git', health: '/api/health' };
let activeRelay = null; // { base, label, endpoints, capabilities }
let featureRelays = { search: null, crawl: null };
let relayOk = null;
let relayProbe = null;

// 内置公共 Cloudflare Worker 中继候选。按顺序探测，第一个 200/ok 的生效。
// 官方公共中继由维护者部署（免费额度 10 万次/天）。用户可通过 localStorage 'teamo-relay' 覆盖。
const PUBLIC_RELAY_CANDIDATES = [
  'https://relay.teamo.workers.dev',
];

function userRelayOverride() {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('teamo-relay') : null;
    if (!v) return '';
    const u = new URL(v);
    return u.origin;
  } catch { return ''; }
}
function relayEndpoints(base) {
  const b = String(base || '').replace(/\/+$/, '');
  return { base: b, fetch: `${b}/api/fetch`, git: `${b}/api/git`, health: `${b}/api/health`, search: `${b}/api/search`, crawl: `${b}/api/crawl` };
}
async function probeRelayEndpoint(endpoints, signal, timeoutMs = 3500) {
  // AbortSignal.any/timeout 老浏览器可能没有，手动派生一个 ctrl
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const res = await fetch(endpoints.health, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return false;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) return false;
    const j = await res.json().catch(() => ({}));
    if (!(j && j.ok)) return false;
    // 老版本本地 relay 未声明能力时仅视为支持其既有 fetch/git 接口。
    const capabilities = Array.isArray(j.capabilities) ? j.capabilities.map((x) => String(x).toLowerCase()) : ['fetch', 'git'];
    return { ok: true, capabilities };
  } catch { return false; }
  finally {
    clearTimeout(t);
    if (signal) signal.removeEventListener && signal.removeEventListener('abort', onAbort);
  }
}

/** 探测可用中继（结果缓存；并发调用共享同一个探测） */
export async function relayAvailable(signal) {
  if (relayOk === true) return true;
  if (relayProbe) return relayProbe;
  relayProbe = (async () => {
    const candidates = [{ base: '', label: 'origin', endpoints: relayEndpoints('') }];
    const override = userRelayOverride();
    if (override) candidates.push({ base: override, label: 'user', endpoints: relayEndpoints(override) });
    for (const url of PUBLIC_RELAY_CANDIDATES) candidates.push({ base: url, label: 'public', endpoints: relayEndpoints(url) });
    const unique = candidates.filter((c, i, all) => all.findIndex((x) => x.endpoints.base === c.endpoints.base) === i);
    let selected = null;
    featureRelays = { search: null, crawl: null };
    // 先保留既有的中继优先级（同源 → 用户指定 → 公共），同时继续探测至找到声明搜索/爬虫能力的 Worker。
    // 这样本地 server.py 可继续服务 fetch/git，而新增工具不会误打到它的 404 路由。
    for (const c of unique) {
      const probe = await probeRelayEndpoint(c.endpoints, signal, c.label === 'origin' ? 3500 : 1800);
      if (!probe || !probe.ok) continue;
      const candidate = { ...c, capabilities: probe.capabilities };
      if (!selected) selected = candidate;
      if (!featureRelays.search && probe.capabilities.includes('search')) featureRelays.search = candidate;
      if (!featureRelays.crawl && probe.capabilities.includes('crawl')) featureRelays.crawl = candidate;
      if (selected && featureRelays.search && featureRelays.crawl) break;
    }
    if (selected) {
      activeRelay = selected;
      RELAY = { base: selected.base, ...selected.endpoints };
      relayOk = true;
      return true;
    }
    activeRelay = null;
    featureRelays = { search: null, crawl: null };
    // 回落到同源默认值
    RELAY = { base: '', ...relayEndpoints('') };
    relayOk = false;
    return false;
  })();
  try { return await relayProbe; } finally { relayProbe = null; }
}

/** 当前生效 relay 信息，无则 null */
export function currentRelay() { return relayOk && activeRelay ? { base: activeRelay.base, label: activeRelay.label, capabilities: [...(activeRelay.capabilities || [])] } : null; }

/** Worker 特性由 health.capabilities 声明；不要仅凭 /api/health=ok 假设存在新路由。 */
export function relaySupports(feature) { return !!(relayOk && featureRelays[String(feature || '').toLowerCase()]); }
export function relayCapabilities() { return { search: relaySupports('search'), crawl: relaySupports('crawl') }; }

/** 重置探测缓存（测试 / 切换环境时用） */
export function resetRelayProbe() {
  relayOk = null; relayProbe = null; activeRelay = null;
  featureRelays = { search: null, crawl: null };
  RELAY = { base: '', ...relayEndpoints('') };
}

export const RELAY_HINT = '需要中继：请执行 python3 server.py 启动本地中继，或在控制台设置 localStorage.setItem("teamo-relay","https://<你的-worker>.workers.dev") 指定已部署的 Cloudflare Worker 中继（见仓库 relay/worker.js）。';

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
// Worker-backed search_web 是另一个具名工具；本兼容桩只服务仍缓存旧 tools.js 的用户。
export async function webSearch() {
  return {
    provider: 'none',
    results: [],
    note: '兼容旧缓存的空桩；请使用工具表中的 search_web（仅新版 Worker 支持），或说明当前没有可用网页搜索路由。',
  };
}

async function relayFeatureJson(feature, params, signal) {
  const key = String(feature || '').toLowerCase();
  if (!await relayAvailable(signal)) return { ok: false, error: `没有可用中继。${RELAY_HINT}` };
  const candidate = featureRelays[key];
  if (!candidate) return { ok: false, error: `当前可用中继未声明 ${key === 'search' ? '搜索' : '爬虫'} 能力；请部署新版 relay/worker.js 并配置 Worker 路由。` };
  const endpoint = candidate.endpoints[key];
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') query.set(name, String(value));
  }
  try {
    const res = await fetch(`${endpoint}?${query.toString()}`, {
      signal,
      headers: { Accept: 'application/json' },
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: String(payload.error || `Worker 返回 HTTP ${res.status}`), status: res.status };
    return { ok: true, ...payload };
  } catch (err) {
    return { ok: false, error: `Worker ${key} 请求失败：${err && err.message ? err.message : String(err)}` };
  }
}

/** 调用声明支持 search 的 Worker 路由（SearXNG / DuckDuckGo 由 Worker 端选择）。 */
export async function relaySearch({ query = '', limit = 5, signal } = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: '搜索词不能为空' };
  if (q.length > 500) return { ok: false, error: '搜索词不能超过 500 个字符' };
  const n = Math.max(1, Math.min(10, Math.floor(Number(limit) || 5)));
  return relayFeatureJson('search', { q, limit: n }, signal);
}

/** 调用声明支持 crawl 的 Worker 路由（限制在站点同源、页数与深度硬上限内）。 */
export async function relayCrawl({ url = '', maxPages = 3, maxDepth = 1, maxChars = 12000, signal } = {}) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) return { ok: false, error: 'crawl_site 只接受 http(s) 绝对地址' };
  return relayFeatureJson('crawl', {
    url: target,
    max_pages: Math.max(1, Math.min(5, Math.floor(Number(maxPages) || 3))),
    max_depth: Math.max(0, Math.min(2, Math.floor(Number(maxDepth) || 0))),
    max_chars: Math.max(1000, Math.min(16000, Math.floor(Number(maxChars) || 12000))),
  }, signal);
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
    savedTo = savePath || `internal/web/${slugFromUrl(finalUrl)}.md`;
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


// ── 内置轻量 Git（沙箱内，无本地中继也能用）────────────────────────────
// 目标不是复刻系统 git 的所有网络能力，而是让下载后的静态项目在浏览器沙箱里
// 直接具备 init/status/diff/add/commit/log/branch/checkout/reset 等核心版本管理能力。
function splitGitArgs(cmd) {
  const out = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  for (let m; (m = re.exec(String(cmd || ''))); ) out.push((m[1] ?? m[2] ?? m[3] ?? '').replace(/\\(["'\\])/g, '$1'));
  return out;
}
function cleanRepo(repo) {
  return String(repo || '').trim().replace(/^\/+|\/+$/g, '').split('/').filter((x) => x && x !== '.' && x !== '..').join('/');
}
function joinRepo(base, rel) { return base ? `${base}/${rel}` : rel; }
function metaPath(base) { return joinRepo(base, '.git/teamo.json'); } // .git/ 目录天然不展示给用户（点前缀），作为内部元数据位置
function relPath(base, path) {
  const p = String(path || '');
  if (!base) return p;
  return p.startsWith(base + '/') ? p.slice(base.length + 1) : '';
}
function readMeta(fs, base) {
  try { return JSON.parse(fs.read(metaPath(base))); } catch { return null; }
}
function writeMeta(fs, base, meta) { fs.write(metaPath(base), JSON.stringify(meta, null, 2)); }
function emptyMeta() { return { version: 1, head: 'main', branches: { main: null }, commits: {}, index: {} }; }
function workTree(fs, base) {
  const out = {};
  const prefix = base ? base + '/' : '';
  for (const f of fs.list()) {
    const p = String(f.path || '');
    if (base && !p.startsWith(prefix)) continue;
    const rel = relPath(base, p);
    if (!rel || rel.startsWith('.git/')) continue;
    out[rel] = fs.read(p);
  }
  return out;
}
function headCommit(meta) { return meta && meta.branches ? meta.branches[meta.head] || null : null; }
function headTree(meta) {
  const id = headCommit(meta);
  return id && meta.commits[id] ? { ...(meta.commits[id].tree || {}) } : {};
}
function simpleHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
function sameTree(a, b) {
  const ks = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of ks) if ((a || {})[k] !== (b || {})[k]) return false;
  return true;
}
function pathArgs(args) { return args.filter((x) => x && !x.startsWith('-')); }
function selectedPath(rel, paths) {
  if (!paths.length || paths.includes('.') || paths.includes('./')) return true;
  return paths.some((p) => {
    const x = String(p || '').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
    return rel === x || rel.startsWith(x + '/');
  });
}
function stageTree(meta) {
  const tree = headTree(meta);
  for (const [p, v] of Object.entries(meta.index || {})) {
    if (v == null) delete tree[p]; else tree[p] = v;
  }
  return tree;
}
function statusText(meta, work) {
  const head = headTree(meta);
  const staged = stageTree(meta);
  const keys = [...new Set([...Object.keys(head), ...Object.keys(staged), ...Object.keys(work)])].sort();
  const lines = [];
  for (const k of keys) {
    const h = Object.prototype.hasOwnProperty.call(head, k) ? head[k] : undefined;
    const s = Object.prototype.hasOwnProperty.call(staged, k) ? staged[k] : undefined;
    const w = Object.prototype.hasOwnProperty.call(work, k) ? work[k] : undefined;
    let ix = ' ';
    if (s !== h) ix = h === undefined ? 'A' : (s === undefined ? 'D' : 'M');
    let wt = ' ';
    const base = ix !== ' ' ? s : h;
    if (w !== base) wt = w === undefined ? 'D' : (base === undefined ? '?' : 'M');
    if (ix !== ' ' || wt !== ' ') lines.push(`${ix}${wt} ${k}`);
  }
  return lines.join('\n');
}
function diffTrees(a, b, only = []) {
  const keys = [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].sort().filter((k) => selectedPath(k, only));
  const out = [];
  for (const k of keys) {
    const oldV = (a || {})[k];
    const newV = (b || {})[k];
    if (oldV === newV) continue;
    out.push(`diff --git a/${k} b/${k}`);
    if (oldV === undefined) out.push('new file mode 100644');
    if (newV === undefined) out.push('deleted file mode 100644');
    out.push(`--- ${oldV === undefined ? '/dev/null' : 'a/' + k}`);
    out.push(`+++ ${newV === undefined ? '/dev/null' : 'b/' + k}`);
    out.push('@@');
    if (oldV !== undefined) String(oldV).split('\n').forEach((l) => out.push(`-${l}`));
    if (newV !== undefined) String(newV).split('\n').forEach((l) => out.push(`+${l}`));
  }
  return out.join('\n');
}
function restoreWorkTree(fs, base, tree) {
  const cur = workTree(fs, base);
  for (const p of Object.keys(cur)) if (!Object.prototype.hasOwnProperty.call(tree, p)) fs.remove(joinRepo(base, p));
  for (const [p, v] of Object.entries(tree || {})) fs.write(joinRepo(base, p), v);
}
function parseMessage(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-m' || args[i] === '--message') return String(args[i + 1] || '').trim();
    if (args[i].startsWith('-m') && args[i].length > 2) return args[i].slice(2).trim();
    if (args[i].startsWith('--message=')) return args[i].slice(10).trim();
  }
  return '';
}
function localGitRun({ command, repo, fs } = {}) {
  if (!fs || typeof fs.list !== 'function') return { ok: false, error: `git 命令需要本地中继或沙箱文件系统。${RELAY_HINT}` };
  const parts = splitGitArgs(command);
  if (parts[0] === 'git') parts.shift();
  const sub = parts.shift() || '';
  const base = cleanRepo(repo);
  const cwd = base ? `sandbox://${base}` : 'sandbox://';
  if (!sub) return { ok: false, error: 'run_git 需要 command，例如 "git status --short"' };
  if (sub === '--version' || sub === 'version') return { ok: true, code: 0, cwd, text: 'git version TeamoGit 0.1 (browser embedded)', note: '内置沙箱 Git' };
  if (['clone', 'fetch', 'pull', 'push'].includes(sub)) {
    return { ok: false, code: 2, cwd, text: `内置浏览器 Git 当前支持沙箱内 init/status/diff/add/commit/log/branch/checkout/reset；${sub} 这类远端网络操作需要本地中继或后续配置 CORS 代理。`, note: '内置沙箱 Git' };
  }
  let meta = readMeta(fs, base);
  if (sub === 'init') {
    meta = meta || emptyMeta();
    writeMeta(fs, base, meta);
    return { ok: true, code: 0, cwd, text: `Initialized empty TeamoGit repository in ${joinRepo(base, '.git') || '.git'}/`, note: '内置沙箱 Git' };
  }
  if (!meta) return { ok: false, code: 128, cwd, text: 'fatal: not a git repository (or any of the parent directories): .git', note: '内置沙箱 Git' };
  const work = workTree(fs, base);
  if (sub === 'status') {
    const short = parts.includes('--short') || parts.includes('-s');
    const s = statusText(meta, work);
    return { ok: true, code: 0, cwd, text: short ? s : (s || `On branch ${meta.head}\nnothing to commit, working tree clean`), note: '内置沙箱 Git' };
  }
  if (sub === 'add') {
    const args = parts;
    const paths = pathArgs(args);
    const all = !paths.length || args.includes('-A') || args.includes('--all') || paths.includes('.');
    const head = headTree(meta);
    let n = 0;
    for (const [rel, val] of Object.entries(work)) if (selectedPath(rel, paths)) { meta.index[rel] = val; n++; }
    if (all) for (const rel of Object.keys(head)) if (!Object.prototype.hasOwnProperty.call(work, rel)) { meta.index[rel] = null; n++; }
    writeMeta(fs, base, meta);
    return { ok: true, code: 0, cwd, text: `staged ${n} path(s)`, note: '内置沙箱 Git' };
  }
  if (sub === 'diff') {
    const cached = parts.includes('--cached') || parts.includes('--staged');
    const paths = pathArgs(parts);
    const a = cached ? headTree(meta) : stageTree(meta);
    const b = cached ? stageTree(meta) : work;
    return { ok: true, code: 0, cwd, text: diffTrees(a, b, paths), note: '内置沙箱 Git' };
  }
  if (sub === 'commit') {
    const message = parseMessage(parts);
    if (!message) return { ok: false, code: 1, cwd, text: 'Aborting commit due to empty commit message.', note: '内置沙箱 Git' };
    const next = stageTree(meta);
    if (sameTree(next, headTree(meta))) return { ok: false, code: 1, cwd, text: 'nothing to commit, working tree clean', note: '内置沙箱 Git' };
    const parent = headCommit(meta);
    const stamp = new Date().toISOString();
    const id = simpleHash(`${parent || ''}\n${message}\n${stamp}\n${JSON.stringify(next)}`);
    meta.commits[id] = { id, parent, message, ts: stamp, tree: next };
    meta.branches[meta.head] = id;
    meta.index = {};
    writeMeta(fs, base, meta);
    return { ok: true, code: 0, cwd, text: `[${meta.head} ${id}] ${message}\n ${Object.keys(next).length} file(s) in snapshot`, note: '内置沙箱 Git' };
  }
  if (sub === 'log') {
    const oneline = parts.includes('--oneline');
    let limit = 20;
    const dashN = parts.find((x) => /^-\d+$/.test(x));
    if (dashN) limit = Math.abs(Number(dashN));
    const ni = parts.indexOf('-n');
    if (ni >= 0) limit = Number(parts[ni + 1]) || limit;
    const mx = parts.find((x) => x.startsWith('--max-count='));
    if (mx) limit = Number(mx.slice(12)) || limit;
    const lines = [];
    let id = headCommit(meta);
    while (id && lines.length < limit && meta.commits[id]) {
      const c = meta.commits[id];
      lines.push(oneline ? `${id} ${c.message}` : `commit ${id}\nDate: ${c.ts}\n\n    ${c.message}\n`);
      id = c.parent;
    }
    return { ok: true, code: 0, cwd, text: lines.join(oneline ? '\n' : '\n'), note: '内置沙箱 Git' };
  }
  if (sub === 'branch') {
    const names = parts.filter((x) => x && !x.startsWith('-'));
    if (!names.length) {
      const lines = Object.keys(meta.branches).sort().map((b) => `${b === meta.head ? '*' : ' '} ${b}`);
      return { ok: true, code: 0, cwd, text: lines.join('\n'), note: '内置沙箱 Git' };
    }
    const name = cleanRepo(names[0]).replace(/\//g, '-');
    if (!name) return { ok: false, code: 1, cwd, text: 'fatal: invalid branch name', note: '内置沙箱 Git' };
    if (Object.prototype.hasOwnProperty.call(meta.branches, name)) return { ok: false, code: 1, cwd, text: `fatal: a branch named '${name}' already exists`, note: '内置沙箱 Git' };
    meta.branches[name] = headCommit(meta);
    writeMeta(fs, base, meta);
    return { ok: true, code: 0, cwd, text: `branch ${name} created`, note: '内置沙箱 Git' };
  }
  if (sub === 'checkout' || sub === 'switch') {
    let create = false;
    let name = '';
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === '-b' || parts[i] === '-c') { create = true; name = parts[i + 1] || ''; break; }
      if (!parts[i].startsWith('-')) { name = parts[i]; break; }
    }
    name = cleanRepo(name).replace(/\//g, '-');
    if (!name) return { ok: false, code: 1, cwd, text: 'fatal: missing branch name', note: '内置沙箱 Git' };
    if (create) meta.branches[name] = headCommit(meta);
    if (!Object.prototype.hasOwnProperty.call(meta.branches, name)) return { ok: false, code: 1, cwd, text: `error: pathspec '${name}' did not match any branch`, note: '内置沙箱 Git' };
    meta.head = name; meta.index = {};
    restoreWorkTree(fs, base, headTree(meta));
    writeMeta(fs, base, meta);
    return { ok: true, code: 0, cwd, text: `Switched to branch '${name}'`, note: '内置沙箱 Git' };
  }
  if (sub === 'reset' && parts.includes('--hard')) {
    meta.index = {};
    restoreWorkTree(fs, base, headTree(meta));
    writeMeta(fs, base, meta);
    return { ok: true, code: 0, cwd, text: `HEAD is now at ${headCommit(meta) || '(empty)'}`, note: '内置沙箱 Git' };
  }
  if (sub === 'rev-parse' && parts.includes('--show-toplevel')) return { ok: true, code: 0, cwd, text: cwd, note: '内置沙箱 Git' };
  return { ok: false, code: 2, cwd, text: `内置 Git 暂不支持子命令：git ${sub}`, note: '内置沙箱 Git' };
}

// ── git：优先本地中继真 git；无中继时回退内置沙箱 Git ─────────────────
export async function gitRun({ command, repo, timeoutSec = 25, signal, fs } = {}) {
  const cmd = String(command || '').trim();
  if (!cmd) return { ok: false, error: 'run_git 需要 command，例如 "git status --short"' };
  const localFallback = (reason) => {
    const r = localGitRun({ command: cmd, repo, fs });
    if (r.note === '内置沙箱 Git' && reason) r.note = `内置沙箱 Git（${reason}）`;
    return r;
  };
  if (await relayAvailable(signal)) {
    let res;
    try {
      res = await fetch(RELAY.git, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ command: cmd, repo: repo ? String(repo) : '', timeout: Number(timeoutSec) || 25 }),
        signal,
      });
    } catch (err) {
      if (signal && signal.aborted) return { ok: false, error: `git 中继请求已取消：${err.message}` };
      return localFallback(`Git 中继请求失败：${err.message}；以下为本地模拟器结果`);
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const why = String(j.error || res.statusText || `HTTP ${res.status}`);
      const noGitRoute = [404, 405, 501].includes(res.status)
        || (res.status === 403 && /git.{0,12}(?:关闭|禁用|disabled|not enabled)/i.test(why));
      if (noGitRoute) return localFallback(`中继未提供可用的真实 Git（${why}）`);
      return { ok: false, error: `git 中继拒绝执行（HTTP ${res.status}）：${why}` };
    }
    // Cloudflare Worker / 旧版中继可能有 health 却没有 /api/git；不要把它误报成一次真实 Git 失败。
    if (!Number.isInteger(j.code)) return localFallback('当前中继未提供 /api/git；以下为本地模拟器结果');
    const out = [j.stdout, j.stderr].filter((x) => x && String(x).trim()).join('\n── stderr ──\n');
    return {
      ok: j.code === 0,
      code: j.code,
      cwd: j.cwd || '',
      text: out || `（无输出，退出码 ${j.code}）`,
      note: ['本机真实 Git（经本地中继）', j.note].filter(Boolean).join('；'),
    };
  }
  return localGitRun({ command: cmd, repo, fs });
}

export const NET_TOOLS_AVAILABLE_NOTE = RELAY_HINT;
