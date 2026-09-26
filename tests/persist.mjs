// ─── 刷新页面后「对话 + 附件 + 沙箱」还在吗（真 Chromium + 真 IndexedDB）──────
// 这条路径用 jsdom 测不出来：jsdom 没有 IndexedDB，也不会真的重建页面。
// 线上真踩过的坑：附件图片 / 沙箱里的图都是 base64，塞进 localStorage（~5MB）一超限
// 就抛 QuotaExceededError，旧代码静默退化成「瘦身版」→ 用户刷新后图片全没了。
// 现在重数据外置到 IndexedDB，localStorage 只存轻量状态。
//
// 用法：npm run test:persist            （默认跑本地文件）
//       TEAMO_PERSIST_URL=https://imfufuu.github.io/TeamoAgent/ npm run test:persist
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import puppeteer from 'puppeteer';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const REMOTE = process.env.TEAMO_PERSIST_URL || '';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

// ── 造一张约 60KB 的 PNG（随机像素，避免压成几百字节）──
function makePng(w = 256, h = 256, seed = 12345) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) % 251);
  const row = () => Buffer.from([0, ...Array.from({ length: w * 3 }, rnd)]);
  const raw = Buffer.concat(Array.from({ length: h }, row));
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}
// zlib.crc32 在 Node 20.12+ 才有，老版本自己算
function crc32(buf) {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return (~c) >>> 0;
}

const SSE = [
  'event: x\ndata: {"type":"message_start","message":{"id":"m","role":"assistant","content":[]}}\n\n',
  'event: x\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: x\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"收到，图片我看过了。"}}\n\n',
  'event: x\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: x\ndata: {"type":"message_stop"}\n\n',
].join('');
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST,GET,OPTIONS' };

const failures = [];
const ok = (name, pass, detail = '') => {
  console.log(`  ${pass ? '✓' : '✗'} ${name}${pass || !detail ? '' : `\n       ${detail}`}`);
  if (!pass) failures.push(name);
};

let server = null;
let base = REMOTE;
if (!base) {
  server = http.createServer((q, r) => {
    const u = decodeURIComponent(String(q.url).split('?')[0]);
    const file = path.join(ROOT, u === '/' ? 'app.html' : u);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { r.writeHead(404); r.end(); return; }
    r.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(r);
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${server.address().port}/`;
}

const png = makePng();
const tmpDir = fs.mkdtempSync('/tmp/teamo-persist-');
const pngPath = path.join(tmpDir, 'shot.png');
const txtPath = path.join(tmpDir, 'notes.txt');
fs.writeFileSync(pngPath, png);
fs.writeFileSync(txtPath, 'x'.repeat(120000));                     // 12 万字符：超长附件文本
const pngDataUrl = 'data:image/png;base64,' + png.toString('base64');

const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'],
  env: { ...process.env, LD_LIBRARY_PATH: '/home/user/.local/chromedeps/usr/lib/x86_64-linux-gnu' } });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
// 捕获页面的持久化警告（IndexedDB 写失败会 warn），失败时能看到原因
const warns = [];
page.on('console', (m) => { const t = m.text(); if (/persist|IndexedDB|blob/i.test(t)) warns.push(`${m.type()}: ${t.slice(0, 160)}`); });
await page.setRequestInterception(true);
page.on('request', (r) => {
  const u = r.url();
  if (r.method() === 'OPTIONS') return r.respond({ status: 204, headers: CORS, body: '' });
  if (u.includes('/v1/models')) return r.respond({ status: 200, headers: CORS, contentType: 'application/json', body: '{"data":[{"id":"claude-haiku-4-5"}]}' });
  if (u.includes('/v1/')) return r.respond({ status: 200, headers: CORS, contentType: 'text/event-stream', body: SSE });
  r.continue();
});
// 只在第一次加载时播种（刷新必须保留真实写入的状态）。
// 注意：沙箱文件必须挂在**活动会话**上 —— 根级 files 只是镜像，启动时会被会话的同名字段覆盖。
await page.evaluateOnNewDocument((du) => {
  if (localStorage.getItem('__seeded')) return;
  localStorage.setItem('__seeded', '1');
  const s1 = { id: 's1', title: '', model: '', imageModel: '', createdAt: Date.now(), updatedAt: Date.now(),
    messages: [], checkpoints: [], undoBranch: null,
    files: { 'outputs/pic.png': du, 'notes.md': '普通文本文件' }, stats: { lastMs: 0, totalMs: 0 } };
  localStorage.setItem('teamo-agent-state-v1-v2', JSON.stringify({
    apiKey: 'sk-stub', model: 'claude-haiku-4-5', activeSessionId: 's1',
    settings: { webEnabled: false, thinking: false, sandboxEnabled: true, fastMode: false, theme: 'light' },
    sessions: [s1], messages: s1.messages, files: s1.files,
  }));
}, pngDataUrl);

console.log('═══ 刷新后仍在：对话 / 附件 / 沙箱（真 Chromium + IndexedDB）═══');
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#composer-input', { timeout: 30000 });
await new Promise((r) => setTimeout(r, 900));

// 附件：一张 60KB 图 + 一个 12 万字符的文本
await (await page.$('#attach-input')).uploadFile(pngPath, txtPath);
await new Promise((r) => setTimeout(r, 500));
await page.evaluate(() => { const el = document.querySelector('#composer-input'); el.value = '看看这两份附件'; el.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#send-btn').click(); });
await page.waitForFunction(() => document.querySelectorAll('#messages .msg-assistant').length > 0, { timeout: 20000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 1500));

const snap = (tag) => page.evaluate(async (t) => {
  const idbCount = await new Promise((res) => {
    try {
      const req = indexedDB.open('teamo-agent-blobs');
      req.onerror = () => res(-1);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('blobs')) return res(0);
        const c = db.transaction('blobs', 'readonly').objectStore('blobs').count();
        c.onsuccess = () => res(c.result); c.onerror = () => res(-1);
      };
    } catch { res(-1); }
  });
  const ls = localStorage.getItem('teamo-agent-state-v1-v2') || '';
  return {
    tag: t,
    消息数: document.querySelectorAll('#messages .msg').length,
    附件图张数: document.querySelectorAll('#messages .msg-user img').length,
    附件图有数据: [...document.querySelectorAll('#messages .msg-user img')].every((i) => /^data:image\//.test(i.getAttribute('src') || '')),
    附件名: [...document.querySelectorAll('#messages .att-file, #messages .att-img')].map((n) => n.getAttribute('title') || n.textContent.trim().slice(0, 20)),
    文本附件省略标记: /已省略/.test(document.querySelector('#messages .msg-user .bubble')?.textContent || ''),
    面板文件: [...document.querySelectorAll('#sandbox-panel .ft-name')].map((n) => n.textContent.trim()),
    侧栏会话数: document.querySelectorAll('#session-list .sess-item').length,
    localStorage大小: ls.length,
    localStorage里还有base64图: /data:image\/png;base64/.test(ls),
    IndexedDB条数: idbCount,
    长度诊断: (() => { try {
      const st = JSON.parse(ls); const s1 = (st.sessions || [])[0] || {};
      const msg = (s1.messages || []).find((m) => m.role === 'user') || {};
      return { 文件: Object.fromEntries(Object.entries(s1.files || {}).map(([k, v]) => [k, `${typeof v}:${String(v).length}`])),
               附件: (msg.attachments || []).map((a) => `${a.kind}:${typeof a.dataUrl}:${a.dataUrl ? String(a.dataUrl).length : 0}:stripped=${!!a.stripped}`) };
    } catch (e) { return 'ERR ' + e.message; } })(),
    存储里的key: (() => { try {
      const st = JSON.parse(ls); const s = (st.sessions || [])[0] || {};
      const msg = (s.messages || []).find((m) => m.role === 'user') || {};
      return { 外置文件: Object.keys(s.blobFiles || {}), 外置附件: Object.values(msg.blobAtts || {}), 会话内文件: Object.keys(s.files || {}) };
    } catch (e) { return 'parse-fail: ' + e.message; } })(),
  };
}, tag);

const before = await snap('刷新前');
console.log('  刷新前:', JSON.stringify(before, null, 0));

const needReload = async () => { await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForSelector('#composer-input', { timeout: 30000 }); await new Promise((r) => setTimeout(r, 2500)); };
await needReload();
const after = await snap('刷新后');
console.log('  刷新后:', JSON.stringify(after, null, 0));

ok('刷新后消息还在', after.消息数 === before.消息数 && after.消息数 >= 2, `${before.消息数} → ${after.消息数}`);
ok('刷新后会话记录还在', after.侧栏会话数 >= 1, String(after.侧栏会话数));
ok('刷新后附件图仍能显示（data URL 已取回）', after.附件图张数 >= 1 && after.附件图有数据, `${after.附件图张数} 张，有数据=${after.附件图有数据}`);
ok('刷新后沙箱里的图与文本文件都还在', after.面板文件.includes('pic.png') && after.面板文件.includes('notes.md'), JSON.stringify(after.面板文件));
ok('重数据确实外置到了 IndexedDB', after.IndexedDB条数 >= 2, `IDB ${after.IndexedDB条数} 条`);
ok('localStorage 里不再塞 base64 图（不会顶爆配额）', !after.localStorage里还有base64图
  && after.localStorage大小 < 100000, `${after.localStorage大小} 字符`);
ok('轻量状态里留有索引，能按 key 取回', !!after.存储里的key && after.存储里的key.外置附件?.length >= 2
  && after.存储里的key.外置文件?.length >= 2, JSON.stringify(after.存储里的key));
ok('小文件仍留在快照里（不必都进 IDB）', !!after.存储里的key && after.存储里的key.会话内文件?.includes('notes.md'), JSON.stringify(after.存储里的key?.会话内文件));
ok('刷新过程零页面错误', errs.length === 0, errs.slice(0, 2).join(' | '));
ok('持久化过程无告警（IndexedDB 正常）', warns.length === 0, warns.slice(0, 3).join(' | '));

await browser.close();
if (server) server.close();

console.log('');
if (failures.length) { console.log(`${failures.length} 项失败 ❌`); process.exit(1); }
console.log('刷新持久化测试全部通过 ✅');
