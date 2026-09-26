// ─── 移动端布局审计（真 Chrome + 真页面，开发者本地用）────────────────────
// 用法: npm run audit:mobile            # 默认 360 / 390 / 414 三个宽度
//       node tests/mobile-layout.mjs 320 390 430
//       TEAMO_AUDIT_URL=https://imfufuu.github.io/TeamoAgent/ node tests/mobile-layout.mjs   # 量线上
//
// 为什么要有它：这个项目没有视觉审查通道（助手看不到截图），「移动端挤在一起」
// 必须变成可计算的指标才有意义。这里用真实的 Chromium 打开真实 index.html，
// 先用桩网关灌一段「真实形状」的对话（含工具芯片、联网来源条、代码块、长 URL），
// 再逐项量：
//   · 有没有横向溢出（documentElement / .messages / 顶栏 / 各面板）
//   · 可点元素的触控尺寸（< 36px 记违规）
//   · 关键区域是否互相压住（顶栏 ↔ 消息区、输入区 ↔ 消息区、按钮 ↔ 文本）
//   · 交互面板（模型下拉、侧栏抽屉、沙箱面板）是否超出视口
// 依赖 puppeteer（npm i -D puppeteer 会自动带 Chromium）；没装就跳过，不阻断 CI。
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIDTHS = process.argv.slice(2).map(Number).filter(Boolean);
const VIEWPORTS = (WIDTHS.length ? WIDTHS : [360, 390, 414]).map((w) => ({ w, h: 780 }));

let puppeteer;
try { ({ default: puppeteer } = await import('puppeteer')); }
catch { console.log('⏭  tests/mobile-layout.mjs 跳过：未安装 puppeteer（npm i -D puppeteer）'); process.exit(0); }

// ── 静态服务器（只服务仓库目录，避免 file:// 下的 CSP/模块限制）────────────
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let p = path.join(ROOT, url === '/' ? 'app.html' : url);
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

// ── 桩网关：让页面能「真的」跑完一轮带工具与联网的对话 ────────────────────
const STUB = `(() => {
  const NL = String.fromCharCode(10); // 换行字符，避免在模板字符串里反复转义
  localStorage.setItem('teamo-agent-state-v1-v2', JSON.stringify({ apiKey: 'sk-teamo-stub', model: 'claude-sonnet-5' }));
  const sse = (chunks) => new Response(new ReadableStream({ start(c) { const e = new TextEncoder();
    for (const s of chunks) c.enqueue(e.encode(s)); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const ev = (o) => 'data: ' + JSON.stringify(o) + '\\n\\n';
  let turn = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!u.includes('teamorouter')) return new Response('{}', { status: 200 });
    if (u.includes('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5' }, { id: 'gpt-5.4-mini' }, { id: 'glm-5.3' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    const body = JSON.parse(init.body || '{}');
    if ((body.messages || []).some((m) => /标题/.test(JSON.stringify(m)))) return new Response('{}', { status: 400 });
    turn++;
    const long = '这是一段用于测量换行的长文本。'.repeat(6);
    if (u.includes('/v1/messages')) {
      return sse([
        ev({ type: 'message_start', message: { usage: { input_tokens: 1200, output_tokens: 0 } } }),
        ev({ type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 's1', name: 'web_search', input: {} } }),
        ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"移动端布局 视口宽度"}' } }),
        ev({ type: 'content_block_stop', index: 0 }),
        ev({ type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 's1', content: [
          { type: 'web_search_result', title: 'Web 视口宽度与安全区 inset 的巨大坑', url: 'https://example.com/a-very-long-url-that-should-not-break-the-mobile-layout-abcdefghijklmnop', page_age: '2 days ago' },
          { type: 'web_search_result', title: '移动端触控目标最小尺寸', url: 'https://example.org/touch-target-44', page_age: null } ] } }),
        ev({ type: 'content_block_stop', index: 1 }),
        ev({ type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } }),
        ev({ type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: '## 结论' + NL + NL + long + NL + NL + '- 一条列表项' + NL + '- 另一条列表项' + NL + NL + 'const veryLongIdentifierName = anotherVeryLongIdentifierName + yetAnotherOne;' + NL + long } }),
        ev({ type: 'content_block_stop', index: 2 }),
        // 第一轮再挂一个客户端工具调用：手机上工具芯片的排布也要量（第二轮只回文本收尾）
        ...(turn === 1 ? [
          ev({ type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'tu1', name: 'write_file', input: {} } }),
          ev({ type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"path":"files/mobile-report.md","content":"' + long + '"}' } }),
          ev({ type: 'content_block_stop', index: 3 }),
        ] : []),
        ev({ type: 'message_delta', delta: { stop_reason: turn === 1 ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 480 } }),
        ev({ type: 'message_stop' }),
      ]);
    }
    return sse([
      ev({ type: 'response.created', response: {} }),
      ev({ type: 'response.output_item.added', output_index: 0, item: { id: 'fc1', type: 'function_call', call_id: 'c1', name: 'write_file', arguments: '' } }),
      ev({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc1', delta: '{"path":"files/report.md","content":"' + long + '"}' }),
      ev({ type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc1', arguments: '{"path":"files/report.md","content":"' + long + '"}' }),
      ev({ type: 'response.output_item.done', output_index: 0, item: { id: 'fc1', type: 'function_call', call_id: 'c1', name: 'write_file', arguments: '{"path":"files/report.md","content":"' + long + '"}' } }),
      ev({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 900, output_tokens: 120 }, output: [] } }),
    ]);
  };
})();`;

// 桩脚本本身先过一遍语法检查：语法错的桩会让页面拿不到 fetch → 审计跑成「空页面全绿」的假阳性
try { new Function(STUB); } catch (e) { fs.writeFileSync('/tmp/stub-injected.js', STUB); console.error('✗ 审计脚本里的桩有语法错误:', e.message, '（已写入 /tmp/stub-injected.js）'); process.exit(1); }

const CHROME_LIBS = process.env.CHROME_LIBS || [
  '/home/user/.local/chromedeps/usr/lib/x86_64-linux-gnu',
  '/home/user/.local/chromedeps/lib/x86_64-linux-gnu',
].filter((p) => fs.existsSync(p)).join(':');

const browser = await puppeteer.launch({
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  env: { ...process.env, LD_LIBRARY_PATH: [CHROME_LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') },
});

const problems = [];
const notes = [];
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

async function seed(page) {
  // TEAMO_AUDIT_URL=https://imfufuu.github.io/TeamoAgent/ 可对线上站点跑同一套测量
  const target = (process.env.TEAMO_AUDIT_URL || `http://127.0.0.1:${PORT}/app.html`).replace(/\/$/, '/app.html');
  await page.goto(target, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#composer-input', { timeout: 15000 });
  // 首次运行会弹 API Key 弹窗（localStorage 里没 key 时）：关掉它再测，否则量到的是遮罩层
  const modal = await page.$('#key-modal.open, #key-modal.show, #key-modal[style*="flex"]');
  if (modal) await page.evaluate(() => document.querySelector('#key-close')?.click());
  await tick(600);
  const ask = async (text) => {
    await page.evaluate((t) => { const el = document.querySelector('#composer-input'); el.value = t; el.dispatchEvent(new Event('input', { bubbles: true })); }, text);
    // 用坐标点击（page.click(selector) 在移动仿真下会算错可点位置，点击静默落空）
    const box = await page.evaluate(() => { const b = document.querySelector('#send-btn').getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
    await page.mouse.click(box.x, box.y);
    await tick(1500);
    const dbg = process.env.MOBILE_AUDIT_DEBUG ? await page.evaluate(() => {
      const b = document.querySelector('#send-btn').getBoundingClientRect();
      const at = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return { box: { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) },
        at: at ? (at.id || at.className || at.tagName) : null, toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim()),
        key: document.querySelector('#key-modal').className, modalBox: (() => { const m = document.querySelector('.modal-card'); if (!m) return null; const r = m.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })() };
    }) : null;
    if (dbg) console.log('   · debug:', JSON.stringify(dbg));
    const n = await page.evaluate(() => document.querySelectorAll('#messages .msg').length);
    if (!n) {
      // 桩环境里发不出去时必须喊出来，否则「空空如也」的布局会被误判成通过
      const why = await page.evaluate(() => ({ key: !!document.querySelector('#key-modal.open'), value: (document.querySelector('#composer-input') || {}).value,
        btn: (document.querySelector('#send-btn') || {}).className, err: (document.querySelector('#status-text') || {}).textContent }));
      throw new Error(`桩环境未能发出消息: ${JSON.stringify(why)}`);
    }
  };
  page.on('pageerror', (e) => problems.push('页面异常: ' + String(e).slice(0, 160)));
  if (await page.$('.empty-state')) note(page, 'welcome', await measureWelcome(page));
  await ask('帮我把移动端布局的问题整理成一份报告，写进沙箱文件。');
  await ask('再补充一段更长的说明，看看窄屏会不会挤在一起。');
  await tick(400);
}

async function note(page, tag, data) { notes.push({ tag, ...data }); }

async function measureWelcome(page) {
  return page.evaluate(() => {
    const e = document.querySelector('.empty-state');
    if (!e) return { present: false };
    const r = e.getBoundingClientRect();
    const cards = [...document.querySelectorAll('.empty-cards .suggest')].map((c) => { const b = c.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; });
    return { present: true, top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight,
      centered: Math.abs((r.top + r.height / 2) - innerHeight / 2) < innerHeight * 0.12, cards, minCardH: Math.min(...cards.map((c) => c.h), 999) };
  });
}

function checkViewport(name, vp) {
  return page => page.evaluate(({ name, vp }) => {
    const bad = [];
    const r = (sel) => { const e = document.querySelector(sel); return e ? e.getBoundingClientRect() : null; };
    const vw = innerWidth;
    const de = document.documentElement;
    if (de.scrollWidth > vw + 1) bad.push(`页面横向溢出 ${de.scrollWidth - vw}px`);
    const scrollers = ['.messages', '.topbar-right', '.web-srcs', '.tool-chips'];
    for (const sel of scrollers) {
      const e = document.querySelector(sel);
      if (!e) continue;
      const style = getComputedStyle(e);
      const scrollable = /auto|scroll/.test(style.overflowX);
      if (e.scrollWidth > e.clientWidth + 1 && !scrollable) bad.push(`${sel} 内容 ${e.scrollWidth}px 超出容器 ${e.clientWidth}px 且不可横向滚动`);
    }
    // 触控目标
    const targets = [...document.querySelectorAll('.topbar-right .pill, .composer button, .msg-actions .act, .suggest-shuffle, .empty-cards .suggest, .mini-btn, .icon-btn')];
    const small = targets.filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && (b.height < 36 || b.width < 36); })
      .map((e) => { const b = e.getBoundingClientRect(); const id = e.id ? '#' + e.id : '';
        const cls = (e.className || '').toString().split(' ').slice(0, 2).join('.');
        return `${e.tagName.toLowerCase()}${id}.${cls}«${(e.textContent || '').trim().slice(0, 6)}»:${Math.round(b.width)}x${Math.round(b.height)}`; });
    if (small.length) bad.push(`触控目标过小: ${[...new Set(small)].join(', ')}`);
    // 关键区域互不重叠
    const top = r('.topbar'), msgs = r('#messages'), comp = r('.composer-wrap');
    const overlap = (a, b) => a && b && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
    if (overlap(top, msgs)) bad.push('顶栏与消息区重叠');
    if (overlap(comp, msgs)) bad.push('输入区与消息区重叠');
    if (msgs && (msgs.left < -1 || msgs.right > vw + 1)) bad.push(`消息区超出视口 (${Math.round(msgs.left)}~${Math.round(msgs.right)})`);
    if (comp && (comp.left < -1 || comp.right > vw + 1)) bad.push(`输入区超出视口 (${Math.round(comp.left)}~${Math.round(comp.right)})`);
    // 首屏可视元素都应落在视口内（排除明确可横向滚动的容器内部）
    const clipped = [];
    for (const e of document.querySelectorAll('.msg-assistant .md-body > *, .msg-actions .act, .web-note, .chip, .side-footer > *')) {
      if (e.closest('#sandbox-panel.collapsed, .sidebar:not(.sidebar-open)')) continue; // 平移出屏的浮层不算越界
      const b = e.getBoundingClientRect();
      if (b.width === 0) continue;
      if (b.right > vw + 1 || b.left < -1) clipped.push(`${e.className.toString().split(' ')[0] || e.tagName}(${Math.round(b.left)}~${Math.round(b.right)})`);
    }
    if (clipped.length) bad.push(`元素越出视口: ${[...new Set(clipped)].slice(0, 5).join(', ')}`);
    return bad;
  }, { name, vp });
}

async function auditAt(vp) {
  const page = await browser.newPage();
  await page.setViewport({ width: vp.w, height: vp.h, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await page.evaluateOnNewDocument(STUB);
  if (process.env.MOBILE_AUDIT_DEBUG) {
    page.on('console', (m) => console.log('   [页面]', m.type(), m.text().slice(0, 200)));
    page.on('pageerror', (e) => console.log('   [异常]', String(e).slice(0, 300)));
  }
  await seed(page);

  const push = async (label, bad) => { for (const b of bad) problems.push(`[${vp.w}px] ${label} → ${b}`); };
  await push('基础布局', await checkViewport('base', vp)(page));

  // 顶栏胶囊行：应能横滑而不是挤成两行压住状态栏
  const topbar = await page.evaluate(() => {
    const row = document.querySelector('.topbar-right');
    const st = getComputedStyle(row);
    const pills = [...row.querySelectorAll('.pill')].map((p) => Math.round(p.getBoundingClientRect().height));
    return { scrollable: /auto|scroll/.test(st.overflowX), lines: row.getBoundingClientRect().height > 60, pills };
  });
  if (topbar.lines) problems.push(`[${vp.w}px] 顶栏胶囊换行成多行（高度 ${Math.round(topbar.pills.length)} 个胶囊挤在一起）`);
  if (!topbar.scrollable && vp.w <= 430) problems.push(`[${vp.w}px] 顶栏胶囊行不可横向滚动（窄屏必然挤压）`);

  // 侧栏抽屉（窄屏下模型选择器在抽屉里，必须先拉开；顺带量抽屉本身）
  await page.evaluate(() => document.querySelector('#sidebar-fab')?.click()); await tick(500);
  const sb = await page.evaluate(() => { const s = document.querySelector('.sidebar'); const b = s.getBoundingClientRect();
    return { right: Math.round(b.right), w: Math.round(b.width), vw: innerWidth }; });
  if (sb.right > sb.vw + 1) problems.push(`[${vp.w}px] 侧栏抽屉超出视口 (右边缘 ${sb.right} > ${sb.vw})`);
  const drawerFooter = await page.evaluate(() => { const f = document.querySelector('.side-footer'); const r = f.getBoundingClientRect();
    const kids = [...f.children].map((c) => { const b = c.getBoundingClientRect(); return { tag: (c.id || c.className || c.tagName).toString().slice(0, 14), w: Math.round(b.width), h: Math.round(b.height) }; });
    return { h: Math.round(r.height), kids, overflowX: f.scrollWidth > f.clientWidth + 1 }; });
  if (drawerFooter.overflowX) problems.push(`[${vp.w}px] 侧栏底部信息横向溢出 (${drawerFooter.kids.map((k) => k.w).join('+')})`);
  await push('侧栏抽屉内', await checkViewport('drawer', vp)(page));

  // 模型下拉：面板必须完整落在视口内
  await page.click('#model-btn').catch(() => {}); await tick(300);
  const menu = await page.evaluate(() => { const m = document.querySelector('#model-menu'); if (!m) return null;
    const b = m.getBoundingClientRect(); const s = getComputedStyle(m);
    const open = s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0;
    return { open, left: Math.round(b.left), right: Math.round(b.right), vw: innerWidth, w: Math.round(b.width), h: Math.round(b.height) }; });
  if (menu && menu.open && (menu.left < -1 || menu.right > menu.vw + 1)) problems.push(`[${vp.w}px] 模型下拉超出视口 (${menu.left}~${menu.right} / ${menu.vw})`);
  if (menu && menu.open && menu.h > vp.h * 0.9) problems.push(`[${vp.w}px] 模型下拉高度 ${menu.h}px 超出屏幕可视高度`);
  await page.keyboard.press('Escape').catch(() => {}); await tick(200);
  await page.evaluate(() => document.querySelector('#sidebar-fab')?.click()); await tick(400); // 收回抽屉

  // 沙箱面板
  await page.evaluate(() => document.querySelector('#panel-toggle')?.click()); await tick(450);
  const pn = await page.evaluate(() => { const e = document.querySelector('#sandbox-panel'); const b = e.getBoundingClientRect();
    return { left: Math.round(b.left), right: Math.round(b.right), w: Math.round(b.width), vw: innerWidth, collapsed: e.classList.contains('collapsed') }; });
  if (!pn.collapsed && (pn.left < -1 || pn.right > pn.vw + 1)) problems.push(`[${vp.w}px] 沙箱面板超出视口 (${pn.left}~${pn.right})`);
  await page.evaluate(() => document.querySelector('#panel-toggle')?.click()); await tick(300);

  // 交互后再量一次（消息多了以后的滚动高度与输入区贴合）
  const tail = await push; await tail('交互后', await checkViewport('after', vp)(page));
  // 「开关开着却没检索」的提示条 + 重试按钮：真机上这条路径取决于上游是否随机检索，
  // 所以这里按 ui.js 的同一段结构与文案注入，专门量它在窄屏放不放得下。
  const hintBox = await page.evaluate(() => {
    const globe = document.querySelector('#web-toggle')?.innerHTML.match(/<svg[^>]*>[\s\S]*?<\/svg>/)?.[0] || '';
    const host = document.querySelector('#messages');
    host.insertAdjacentHTML('beforeend', '<div class="msg msg-assistant"><div class="md-body">'
      + '<div class="web-note hint"><span class="web-hint">联网开关是开着的，但本轮没有发生检索</span>'
      + '<span>上游模型自己没调用服务端搜索（网关侧偶发）。需要实时数据的话，点右边的按钮用同一句提问重试（会自动写明「先联网检索再回答」），或换个模型重问一次</span>'
      + `<button class="act web-act" data-act="web-retry">${globe}<span>重试并联网检索</span></button></div></div></div>`);
    const n = [...host.querySelectorAll('.web-note.hint')].pop(); const btn = n.querySelector('.web-act');
    const nr = n.getBoundingClientRect(), br = btn.getBoundingClientRect();
    return { noteRight: Math.round(nr.right), btnW: Math.round(br.width), btnH: Math.round(br.height),
      btnRight: Math.round(br.right), fits: br.right <= innerWidth - 4 && br.left >= nr.left - 1,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth, tap: br.height >= 32 };
  });
  if (!hintBox.fits) problems.push(`[${vp.w}px] 联网提示条里的重试按钮溢出/越界 (${JSON.stringify(hintBox)})`);
  if (hintBox.overflowX > 1) problems.push(`[${vp.w}px] 注入提示条后页面横向溢出 ${hintBox.overflowX}px`);
  if (!hintBox.tap) problems.push(`[${vp.w}px] 重试按钮触控高度只有 ${hintBox.btnH}px`);
  notes.push({ tag: `hint-note ${vp.w}`, ...hintBox });

  const metrics = await page.evaluate(() => ({ msgs: document.querySelectorAll('#messages .msg').length,
    webNotes: document.querySelectorAll('.web-note').length, chips: document.querySelectorAll('.chip').length,
    actions: [...document.querySelectorAll('.msg-actions')].filter((a) => getComputedStyle(a).display !== 'none' && a.getBoundingClientRect().height > 0).length,
    regenVisible: [...document.querySelectorAll('.act-regen')].filter((b) => b.style.display !== 'none').length }));
  notes.push({ tag: `viewport ${vp.w}`, ...metrics });
  await page.close();
}

for (const vp of VIEWPORTS) await auditAt(vp);
await browser.close();
server.close();

console.log('═══ 移动端布局审计 ═══\n');
for (const n of notes) console.log('  ·', JSON.stringify(n));
console.log('');
if (problems.length) { console.log(`发现 ${problems.length} 项问题：`); for (const p of problems) console.log('  ✗', p); }
else console.log('  ✓ 全部视口通过：无横向溢出、无重叠、触控目标 ≥36px、面板均在视口内');
process.exit(problems.length ? 1 : 0);
