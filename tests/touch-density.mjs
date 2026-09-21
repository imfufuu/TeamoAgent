// ─── 触屏密度真机检查：菜单行高 / 左下角按钮不折行 / 芯片停转 / 刷新只转箭头 ───
// 背景（用户报的）：
//   ① 「网页行间距被拉的这么大」——其实是 @media (hover: none) 触屏层在带触摸屏的桌面浏览器上
//      命中了：模型菜单每行被抬到 44px，左下角四个按钮因为字号/内边距一起放大 + 中文标签换行，
//      被撑成两行高（58px）。
//   ② 「刷新模型按钮整个在转」——旋转加在按钮本体上，边框/背景跟着转。
//   ③ 「工具图标一直在转」——芯片图标用的是 ⚙ 字符且永久旋转。
// 这条测试用真 Chromium 量计算样式，headless 默认就是 hover:none（正好复现用户环境）。
//
// 用法：npm run test:touch
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

const SSE = [
  'event: x\ndata: {"type":"message_start","message":{"id":"m","role":"assistant","content":[]}}\n\n',
  'event: x\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_1","name":"write_file","input":{}}}\n\n',
  'event: x\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.md\\",\\"content\\":\\"hi\\"}"}}\n\n',
  'event: x\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: x\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}\n\n',
  'event: x\ndata: {"type":"message_stop"}\n\n',
].join('');
const SSE_TEXT = [
  'event: x\ndata: {"type":"message_start","message":{"id":"m2","role":"assistant","content":[]}}\n\n',
  'event: x\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: x\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"写好了。"}}\n\n',
  'event: x\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: x\ndata: {"type":"message_stop"}\n\n',
].join('');
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST,GET,OPTIONS' };

const server = http.createServer((q, r) => {
  const u = decodeURIComponent(String(q.url).split('?')[0]);
  const f = path.join(ROOT, u === '/' ? 'index.html' : u);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(r);
});
await new Promise((res) => server.listen(0, '127.0.0.1', res));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'],
  env: { ...process.env, LD_LIBRARY_PATH: '/home/user/.local/chromedeps/usr/lib/x86_64-linux-gnu' } });

const failures = [];
const ok = (name, pass, detail = '') => {
  console.log(`  ${pass ? '✓' : '✗'} ${name}${pass || !detail ? '' : `\n       ${detail}`}`);
  if (!pass) failures.push(name);
};

async function probe(vp, label) {
  const page = await browser.newPage();
  await page.setViewport(vp);
  let turn = 0;
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    const u = r.url();
    if (r.method() === 'OPTIONS') return r.respond({ status: 204, headers: CORS, body: '' });
    if (u.includes('/v1/models')) return r.respond({ status: 200, headers: CORS, contentType: 'application/json', body: '{"data":[{"id":"claude-haiku-4-5"}]}' });
    if (u.includes('/v1/messages')) { const body = ++turn === 1 ? SSE : SSE_TEXT; return r.respond({ status: 200, headers: CORS, contentType: 'text/event-stream', body }); }
    r.continue();
  });
  await page.evaluateOnNewDocument(() => localStorage.setItem('teamo-agent-state-v1-v2', JSON.stringify({
    apiKey: 'sk-stub', model: 'claude-haiku-4-5',
    settings: { webEnabled: false, thinking: false, sandboxEnabled: true, fastMode: false, theme: 'light' },
    sessions: [], messages: [], files: {} })));
  page.on('dialog', (d) => d.accept()); // 「清空会话」要 confirm：不处理会卡住（无头浏览器不会自动关）
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#composer-input');
  await new Promise((r) => setTimeout(r, 900));
  const mq = await page.evaluate(() => ({ 触屏层命中: matchMedia('(hover: none), (max-width: 720px)').matches, hover: matchMedia('(hover: none)').matches }));
  console.log(`\n── ${label}（触屏层命中=${mq.触屏层命中} / hover:none=${mq.hover}）──`);

  // ① 模型菜单行高与内部间距
  await page.evaluate(() => document.querySelector('#model-btn').click());
  await new Promise((r) => setTimeout(r, 350));
  const menu = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#model-menu .dd-item')].slice(0, 6);
    const c = rows[0] && getComputedStyle(rows[0]);
    return {
      行高: rows.map((n) => Math.round(n.getBoundingClientRect().height)),
      行字号: c && parseFloat(c.fontSize), 行内边距: c && c.padding,
      整菜单高: Math.round(document.querySelector('#model-menu').getBoundingClientRect().height),
      搜索框行高: Math.round(document.querySelector('#model-menu .dd-search').getBoundingClientRect().height),
    };
  });
  ok('模型菜单每行 ≤ 40px（不再被拉伸到 44px）', menu.行高.every((h) => h <= 40), JSON.stringify(menu.行高));
  ok('模型菜单行仍够点得中（≥36px）', menu.行高.every((h) => h >= 36), JSON.stringify(menu.行高));
  await page.evaluate(() => document.body.click());
  await new Promise((r) => setTimeout(r, 200));

  // ② 左下角四个按钮：单行、等高、不折行
  const foot = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.side-footer-btns .mini-btn')];
    return btns.map((n) => {
      const r = n.getBoundingClientRect(); const c = getComputedStyle(n);
      // 文字那一段的行盒高度：折行会变成两倍 —— 比拿按钮总高去除行高可靠
      const tn = [...n.childNodes].find((x) => x.nodeType === 3 && x.textContent.trim());
      let textH = 0;
      if (tn) { const rg = document.createRange(); rg.selectNodeContents(tn); textH = Math.round(rg.getBoundingClientRect().height); }
      return { t: n.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top),
        textH, line: parseFloat(c.lineHeight) || parseFloat(c.fontSize) * 1.2, ws: c.whiteSpace, fs: parseFloat(c.fontSize) };
    });
  });
  const heights = [...new Set(foot.map((b) => b.h))];
  ok('左下角按钮文字只有一行（没有被换成两行）', foot.every((b) => b.textH > 0 && b.textH <= Math.ceil(b.line) + 2),
    JSON.stringify(foot.map((b) => `${b.t}:文字${b.textH}px/行高${Math.round(b.line)}`)));
  ok('左下角按钮等高且都在同一行', heights.length === 1 && new Set(foot.map((b) => b.top)).size === 1, JSON.stringify(foot.map((b) => `${b.t}:${b.w}x${b.h}@${b.top}`)));
  ok('按钮文字不折行（white-space: nowrap）', foot.every((b) => b.ws === 'nowrap'), JSON.stringify(foot.map((b) => [b.t, b.ws])));
  ok('按钮高度收敛（≤44px，仍是触屏可点尺寸）', heights[0] <= 44 && heights[0] >= 36, String(heights[0]));

  // ③ 刷新模型按钮：只转箭头
  await page.evaluate(() => document.querySelector('#model-btn').click());
  await new Promise((r) => setTimeout(r, 300));
  const spin = await page.evaluate(() => {
    const btn = document.querySelector('#refresh-models');
    btn.classList.add('spin');
    const b = getComputedStyle(btn); const svg = getComputedStyle(btn.querySelector('svg'));
    const out = { 按钮动画: b.animationName, 箭头动画: svg.animationName };
    btn.classList.remove('spin');
    return out;
  });
  await page.evaluate(() => document.body.click());
  await new Promise((r) => setTimeout(r, 200));
  ok('刷新时按钮本体不旋转、只有箭头在转', spin.按钮动画 === 'none' && spin.箭头动画 === 'spin', JSON.stringify(spin));

  // ④ 工具芯片：SVG 图标 + 跑完停转
  await page.evaluate(() => { const el = document.querySelector('#composer-input'); el.value = '写个文件'; el.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#send-btn').click(); });
  await page.waitForFunction(() => !!document.querySelector('#messages .chip'), { timeout: 20000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));
  const chip = await page.evaluate(() => {
    const c = document.querySelector('#messages .chip');
    if (!c) return null;
    const ico = c.querySelector('.chip-ico');
    return { 有svg: !!ico.querySelector('svg'), 文本: ico.textContent.trim(), 动画: getComputedStyle(ico).animationName,
      done: c.classList.contains('done'), running: c.classList.contains('running'), 状态: c.querySelector('.chip-state').textContent.trim() };
  });
  ok('工具芯片图标是 SVG（不是 ⚙ 字符）', !!chip && chip.有svg && chip.文本 === '', JSON.stringify(chip));
  ok('工具跑完后图标停止转动', !!chip && chip.done && chip.动画 === 'none' && chip.状态 === '✓', JSON.stringify(chip));

  // ⑤ 没有会话记录时的短提示
  await page.evaluate(() => document.querySelector('#clear-sessions').click());
  await new Promise((r) => setTimeout(r, 300));
  const hint = await page.evaluate(() => (document.querySelector('#session-list .sess-empty-hint') || {}).textContent?.trim() || '');
  ok('空会话列表提示就是一句「还没有会话记录」', hint === '还没有会话记录', hint);

  await page.close();
}

await probe({ width: 1280, height: 900 }, '桌面 1280×900');
await probe({ width: 390, height: 844, isMobile: true, hasTouch: true }, '手机 390×844');

await browser.close();
server.close();
console.log('');
if (failures.length) { console.log(`${failures.length} 项失败 ❌`); process.exit(1); }
console.log('触屏密度检查全部通过 ✅');
