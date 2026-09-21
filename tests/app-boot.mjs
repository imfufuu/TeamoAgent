// ─── 应用装配冒烟（tests/app-boot.mjs）────────────────────────────────
// 与 dom-smoke 的区别：这里跑的是**真实入口 js/main.js**（含 store→agent→ui 的 hook 接线），
// 通过 UI 事件路径（Key 弹窗 → 模型菜单 → 输入框 → 发送按钮）驱动一整轮对话 + 一次工具调用。
// 专门用来抓「挂载/接线」级故障——例如混版缓存下 hook 缺失导致 send() 抛错、界面毫无反应。
// 依赖可选：未安装 jsdom 时自动跳过（CI 不依赖本文件）。
//   node tests/app-boot.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  console.log('跳过应用装配冒烟：未安装 jsdom（npm i -D jsdom 后可运行）');
  process.exit(0);
}

const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), { url: 'http://localhost:8000/', pretendToBeVisual: true });
const { window } = dom;
for (const k of ['document', 'window', 'location', 'navigator', 'HTMLElement', 'Element', 'Node', 'CustomEvent', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'URL', 'Blob', 'FormData', 'File', 'TextEncoder']) {
  if (window[k] !== undefined) globalThis[k] = window[k];
}
globalThis.self = window;
globalThis.localStorage = window.localStorage;
window.matchMedia = (q) => ({ media: q, matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.matchMedia = window.matchMedia;
window.CSS = window.CSS || {};
window.CSS.escape = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
globalThis.CSS = window.CSS;
window.Element.prototype.scrollTo = () => {};
window.Element.prototype.scrollIntoView = () => {};
window.URL.createObjectURL = () => 'blob:fake';
window.URL.revokeObjectURL = () => {};

const $ = (s) => window.document.querySelector(s);
const $$ = (s) => [...window.document.querySelectorAll(s)];
const click = (n) => n && n.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const diag = [];
const ok = (name, cond, extra = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name} ${extra}`); if (diag.length) console.log('      ' + diag.join('\n      ')); }
};

// ── 桩网关：只对话端点回 SSE，其它端点回 JSON（避免占用回合）──
const enc = (o) => `data: ${JSON.stringify(o)}\n\n`;
let turn = 0;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (!/\/v1\/(chat\/completions|messages)$/.test(u)) {
    return new Response(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }, { id: 'claude-sonnet-5' }], balance: 12.5, quota: 100, used: 2 }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const anthropic = u.includes('/v1/messages');
  turn++;
  const isToolTurn = turn === 1;
  if (anthropic) {
    const body = isToolTurn
      ? ['event: message_start\ndata: {"type":"message_start","message":{"id":"m1","role":"assistant","content":[]}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_boot","name":"write_file","input":{}}}\n\n',
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":${JSON.stringify(JSON.stringify({ path: 'uploads/cat.png', content: 'data:image/png;base64,iVBORw0KGgo=' }))}}}\n\n`,
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n'].join('')
      : ['event: message_start\ndata: {"type":"message_start","message":{"id":"m2","role":"assistant","content":[]}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"已写入"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n'].join('');
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  const body = isToolTurn
    ? [enc({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_boot', function: { name: 'write_file', arguments: JSON.stringify({ path: 'uploads/cat.png', content: 'data:image/png;base64,iVBORw0KGgo=' }) } }] } }] }),
      enc({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })].join('')
    : [enc({ choices: [{ delta: { content: '已写入' } }] }), 'data: [DONE]\n\n'].join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};

console.log('应用装配冒烟（真实 js/main.js 引导）');
await import(path.join(ROOT, 'js/main.js'));
await tick();

console.log('\n挂载与入口资源');
const cfg = await import(path.join(ROOT, 'js/config.js'));
ok('main.js 完成挂载（顶栏与对话区就绪）', !!$('#messages') && !!$('#composer-input') && !!$('#send-btn'));
ok(`侧栏构建标识 = v${cfg.APP_VERSION}`, $('#build-stamp').textContent === `v${cfg.APP_VERSION}`, $('#build-stamp').textContent);
const htmlSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
ok('入口样式/脚本带 ?v=（穿透 Pages 静态资源缓存）', htmlSrc.includes(`css/styles.css?v=${cfg.APP_VERSION}`) && htmlSrc.includes(`js/main.js?v=${cfg.APP_VERSION}`));

console.log('\n空状态：随机三条任务示例');
const cards = $$('#messages .empty-state .suggest');
ok('展示 3 条示例卡片', cards.length === 3, `${cards.length} 张`);
ok('每条带能力标签与 data-prompt', cards.every((c) => c.querySelector('.suggest-tag')?.textContent && c.dataset.prompt?.length > 8));
ok('「换一批」可点', !!$('#messages .suggest-shuffle'));
const firstBatch = cards.map((c) => c.dataset.prompt).join('|');
let changed = false;
for (let i = 0; i < 10 && !changed; i++) {
  click($('#messages .suggest-shuffle'));
  changed = $$('#messages .empty-state .suggest').map((c) => c.dataset.prompt).join('|') !== firstBatch;
}
ok('换一批换出不同组合', changed);
click($$('#messages .empty-state .suggest')[0]);
const clicked = $$('#messages .empty-state .suggest')[0];
ok('点卡片只回填 prompt（不带标签文字）', $('#composer-input').value === clicked.dataset.prompt && $('#composer-input').value !== clicked.textContent.trim());
$('#composer-input').value = '';

console.log('\n发送一整轮（含工具调用）');
// 通过真实的 Key 弹窗写入 key（而不是直接改 state），顺带验证弹窗这条链路
click($('#key-btn'));
await tick(30);
ok('API Key 弹窗可打开', $('#key-modal').classList.contains('open'));
$('#key-input').value = 'sk-teamo-boot-test';
click($('#key-save'));
await tick(30);
ok('保存后弹窗关闭且 key 生效', !$('#key-modal').classList.contains('open'));
click($('#model-btn'));
await tick(120);
const gptItem = $$('#model-menu .dd-item').find((n) => n.textContent.includes('gpt-5.6-sol'));
ok('模型菜单可选', !!gptItem);
click(gptItem);
await tick();
$('#composer-input').value = '把一张猫的图片写到 uploads/ 下';
click($('#send-btn'));
await tick(30);
ok('用户消息点发送即上屏（不等 AI）', $$('#messages .msg-user .bubble').some((n) => n.textContent.includes('把一张猫的图片写到')));
diag.push(`消息序列：${$$('#messages .msg').map((n) => n.textContent.replace(/\s+/g, ' ').slice(0, 28)).join(' ~ ')}`);
await tick(1200);
const allText = $$('#messages .msg-assistant').map((n) => n.textContent).join(' ');
ok('工具回合执行且回复落地', allText.includes('已写入') && !!$('.chip'), allText.replace(/\s+/g, ' ').slice(0, 120));
ok('工具芯片显示 write_file 成功', !!$('.chip') && /write_file/.test($('.chip').textContent) && !/✕/.test($('.chip-state')?.textContent || ''));

console.log('\n沙箱文件面板');
const dirRow = $$('#file-list .ft-dir')[0];
ok('uploads/ 目录行出现', dirRow?.dataset.path === 'uploads', $$('#file-list .ft-row').map((n) => n.dataset.path).join(','));
ok('目录行为 button + aria-expanded + SVG 文件夹图标', dirRow?.getAttribute('role') === 'button' && dirRow?.getAttribute('aria-expanded') === 'true' && !!dirRow?.querySelector('.ft-ico svg'));
const fileRow = $$('#file-list .ft-file')[0];
ok('文件行显示文件名与体积', /cat\.png/.test(fileRow?.textContent || '') && /\d/.test(fileRow?.querySelector('.file-size')?.textContent || ''));
ok('文件行下载按钮为 SVG（非 emoji）', !!fileRow?.querySelector('.file-dl svg') && !/⬇|↓/.test(fileRow.querySelector('.file-dl').textContent));
click(dirRow);
await tick(30);
ok('点目录行折叠子文件', !$$('#file-list .ft-file').length && $$('#file-list .ft-dir')[0]?.classList.contains('closed'));

console.log(failures ? `\n${failures} 项失败 ❌` : '\n应用装配冒烟全部通过 ✅');
process.exit(failures ? 1 : 0);
