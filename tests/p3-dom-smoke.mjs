// ─── P3 DOM 冒烟（tests/p3-dom-smoke.mjs）─────────────────────────────────
// 用 jsdom 真挂载 app.html + mountUI，验证 P3 两条诉求在界面这一层真的接上了：
//   ① 编辑直播折叠行（Editing Files）+ 预览窗（最近 N 行 / 行号 / 写入中游标 / 节流字段）
//   ② 任务后自清理的可见面：固定 strip 策略（不提供开关）+ 回复下方的清理痕迹
// 依赖可选：未安装 jsdom 时自动跳过（CI 不依赖本文件）。
//   node tests/p3-dom-smoke.mjs          # 需 npm i -D jsdom
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  console.log('跳过 P3 DOM 冒烟：未安装 jsdom（npm i -D jsdom 后可运行）');
  process.exit(0);
}

const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', pretendToBeVisual: true });
const { window } = dom;
for (const k of ['document', 'window', 'location', 'navigator', 'HTMLElement', 'Element', 'Node', 'CustomEvent', 'Event', 'MouseEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'URL', 'Blob', 'FormData', 'File']) {
  if (window[k] !== undefined) globalThis[k] = window[k];
}
globalThis.self = window;
globalThis.localStorage = window.localStorage;
window.confirm = () => true;
globalThis.confirm = window.confirm;
if (!window.matchMedia) window.matchMedia = (q) => ({ media: q, matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.matchMedia = window.matchMedia;
if (!window.CSS?.escape) { window.CSS = window.CSS || {}; window.CSS.escape = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`); }
globalThis.CSS = window.CSS;
window.Element.prototype.scrollTo = function () {};
window.Element.prototype.scrollIntoView = function () {};

let failures = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name} ${extra}`); }
};

const { createStore } = await import(path.join(ROOT, 'js/state.js'));
const { createAgent } = await import(path.join(ROOT, 'js/agent.js'));
const { mountUI } = await import(path.join(ROOT, 'js/ui.js'));

const store = createStore();
store.state.apiKey = 'sk-teamo-test';
const agent = createAgent(store, {});
const ui = mountUI(store, agent);
const $ = (s) => window.document.querySelector(s);
const $$ = (s) => [...window.document.querySelectorAll(s)];

// ── ① 顶栏清理状态（当前设计：永久开启，不提供开关按钮） ──
console.log('\n① 文件自清理（永久 strip 策略，不提供切换 pill）');
const pill = $('#cleanup-toggle');
ok('自清理固定为 strip 且不渲染可关闭的顶栏开关', !pill && store.state.settings.cleanupPolicy === 'strip');
ok('能力行明确显示自清理状态', /自清理/.test($('#cap-line')?.textContent || ''), $('#cap-line')?.textContent || '缺失');

// ── ② 编辑直播折叠行 + 预览窗 ──
console.log('\n② 编辑直播（Editing Files + 预览窗）');
const rawCall = { id: 'call-live-1', name: 'write_file', args: { __raw: '{"path":"tmp/live.md","content":"第一行\\n第二行\\n第三行' } };
const liveMsg = store.pushMessage({ role: 'assistant', text: '', model: 'gpt-5.6-sol', toolCalls: [rawCall], done: false });
const realGetStatus = agent.getStatus;
agent.getStatus = () => 'executing';   // 复刻「本轮正在跑」的忙碌态（live 语义依赖它）
ui.onAssistantStart(liveMsg);

const fold = $('.edited-files');
ok('写文件折叠行已渲染', !!fold);
ok('直播期间显示 Editing Files（不是 Edited Files）', /Editing File/.test(fold.querySelector('.chip-name').textContent), fold.querySelector('.chip-name').textContent);
ok('折叠行在直播期间自动展开（能看到预览窗）', fold.classList.contains('expanded'));
ok('路径来自半截 JSON（流式期间也能拿到路径）', fold.textContent.includes('tmp/live.md'), fold.textContent.slice(0, 80));
const win = $('.edited-files .edit-preview');
ok('预览窗已渲染', !!win);
ok('预览窗带策略版本标记（口径可追溯）', win && /edit-preview-\d/.test(win.dataset.policy || ''), win && win.dataset.policy);
ok('预览窗标注「写入中…」状态位', /写入中/.test(fold.querySelector('.ep-state')?.textContent || ''), fold.querySelector('.ep-state')?.textContent);
ok('预览窗显示行号 + 已到达的内容', $$('.edited-files .ep-line').length >= 2 && /第一行/.test($('.edited-files .ep-body').textContent));
ok('写入中显示光标（直播语义）', !!$('.edited-files .ep-caret'));
ok('预览窗标题含模式 / 行数 / 字符数', /整文件写入/.test(win.querySelector('.ep-head').textContent) && /行/.test(win.querySelector('.ep-head').textContent), win.querySelector('.ep-head').textContent);
ok('刷新是节流的（2.5 秒档，不是每帧重排）', /EDIT_PREVIEW_REFRESH_MS/.test(fs.readFileSync(path.join(ROOT, 'js/ui.js'), 'utf8')));

// 完成：换成完整参数 + done → 折叠回 Edited Files N，预览窗仍在（可回看）
const doneMsg = store.updateMessage(liveMsg.id, { toolCalls: [{ id: 'call-live-1', name: 'write_file', args: { path: 'tmp/live.md', content: '第一行\n第二行\n第三行' } }], done: true, text: '已写入。' });
agent.getStatus = realGetStatus;
ui.onAssistantDone(doneMsg);
const fold2 = $('.edited-files');
ok('完成后折叠行变回 Edited File（不再直播）', /Edited File/.test(fold2.querySelector('.chip-name').textContent), fold2.querySelector('.chip-name').textContent);
ok('完成后自动折叠（不占版面）', !fold2.classList.contains('expanded'));
ok('展开后预览窗仍在（回看最后一次写入）', !!$('.edited-files .edit-preview'));

// ── ③ 清理痕迹挂在回复下方 ──
console.log('\n③ 任务后自清理的可见面');
const cleanupBrief = { brief: '🧹 已清理 2 个临时文件（tmp/a.json、tmp/b.json，共 34 字符）', count: 2, chars: 34, at: Date.now() };
store.updateMessage(doneMsg.id, { cleanup: cleanupBrief });
ui.onCleanup({ ...cleanupBrief, deletedPaths: ['tmp/a.json', 'tmp/b.json'], verified: true });
const cln = $('.cleanup-fold');
ok('回复下方渲染清理痕迹', !!cln);
ok('痕迹文案不含 emoji 前缀（图标走 SVG）', cln && !/🧹/.test(cln.querySelector('.chip-name').textContent), cln && cln.querySelector('.chip-name').textContent);
ok('痕迹默认折叠（不打扰，展开才看理由）', cln && !cln.classList.contains('expanded'));
cln.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
ok('点击可展开看理由清单', cln.classList.contains('expanded'));

console.log(`\nP3 DOM 冒烟：${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}`);
process.exit(failures ? 1 : 0);
