// ─── P3 DOM 冒烟（tests/p3-dom-smoke.mjs）─────────────────────────────────
// 用 jsdom 真挂载 app.html + mountUI，验证编辑直播预览在界面这一层接通：
//   ① 编辑直播折叠行（Editing Files）+ 预览窗（最近 N 行 / 行号 / 写入中游标 / 节流字段）
// 依赖 jsdom（npm ci 会装；CI 必跑本文件，未安装时本地自动跳过）。
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
  // Node ≥ 21 自带只读 getter 的 globalThis.navigator，直接赋值会抛 TypeError（CI 跑 Node 22 时暴露）：改用 defineProperty 覆盖
  if (window[k] !== undefined) Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true, enumerable: true });
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

// ── 编辑直播折叠行 + 预览窗 ──
console.log('\n② 编辑直播（Editing Files + 预览窗）');
const rawCall = { id: 'call-live-1', name: 'write_file', args: { __raw: '{"path":"tmp/live.md","content":"第一行\\n第二行\\n第三行' } };
const liveMsg = store.pushMessage({ role: 'assistant', text: '', model: 'gpt-5.6-sol', toolCalls: [rawCall], done: false });
const realGetStatus = agent.getStatus;
agent.getStatus = () => 'executing';   // 复刻「本轮正在跑」的忙碌态（live 语义依赖它）
ui.onAssistantStart(liveMsg);

const fold = $('.edited-files');
ok('写文件折叠行已渲染', !!fold);
ok('直播期间显示 Editing Files（不是 Edited Files）', /Editing file/.test(fold.querySelector('.chip-name').textContent), fold.querySelector('.chip-name').textContent);
ok('折叠行在直播期间自动展开（能看到预览窗）', fold.classList.contains('expanded'));
ok('路径来自半截 JSON（流式期间也能拿到路径）', fold.textContent.includes('tmp/live.md'), fold.textContent.slice(0, 80));
const win = $('.edited-files .edit-preview');
ok('预览窗已渲染', !!win);
ok('预览窗带策略版本标记（口径可追溯）', win && /edit-preview-\d/.test(win.dataset.policy || ''), win && win.dataset.policy);
ok('半截参数标注「内容生成中」，不伪装文件已写入', /内容生成中/.test(fold.querySelector('.ep-state')?.textContent || ''), fold.querySelector('.ep-state')?.textContent);
ok('预览窗显示行号 + 已到达的内容', $$('.edited-files .ep-line').length >= 2 && /第一行/.test($('.edited-files .ep-body').textContent));
ok('写入中显示光标（直播语义）', !!$('.edited-files .ep-caret'));
ok('预览窗标题含模式 / 行数 / 字符数', /整文件写入/.test(win.querySelector('.ep-head').textContent) && /行/.test(win.querySelector('.ep-head').textContent), win.querySelector('.ep-head').textContent);
ok('刷新是有界节流的（50ms，实时预览而非整文件重排）', /EDIT_PREVIEW_REFRESH_MS/.test(fs.readFileSync(path.join(ROOT, 'js/ui.js'), 'utf8')));

// 完成：换成完整参数 + done → 折叠回 Edited Files N，预览窗仍在（可回看）
const doneMsg = store.updateMessage(liveMsg.id, { toolCalls: [{ id: 'call-live-1', name: 'write_file', args: { path: 'tmp/live.md', content: '第一行\n第二行\n第三行' } }], done: true, text: '已写入。' });
agent.getStatus = realGetStatus;
ui.onAssistantDone(doneMsg);
const fold2 = $('.edited-files');
ok('完成后折叠行变回 Edited File（不再直播）', /Edited file/.test(fold2.querySelector('.chip-name').textContent), fold2.querySelector('.chip-name').textContent);
ok('完成后自动折叠（不占版面）', !fold2.classList.contains('expanded'));
ok('展开后预览窗仍在（回看最后一次写入）', !!$('.edited-files .edit-preview'));

// ── P2 修正：临时沙箱丢弃标注 ──
console.log('\n③ 临时沙箱丢弃标注（Edited File(s) 里划线 + 「已丢弃 · 回答未引用」）');
store.pushMessage({ role: 'user', text: '再写两个文件' });
const m2 = store.pushMessage({ role: 'assistant', text: '', model: 'gpt-5.6-sol', toolCalls: [
  { id: 'c-a', name: 'write_file', args: { path: 'outputs/keep.md', content: '# keep' }, status: 'ok' },
  { id: 'c-b', name: 'write_file', args: { path: 'outputs/tmp.md', content: 'x' }, status: 'ok' },
], done: false });
ui.onAssistantStart(m2);
ui.onAssistantDone(store.updateMessage(m2.id, { done: true, text: '结果在 outputs/keep.md。' }));
ok('回合未提交前：没有丢弃标注', $$('.edited-files .fold-discarded').length === 0);
// agent 收尾：tempCommit 挂到回合最终助手消息（这里是另一条、没有 write_file 的消息）→ onTempCommit 钩子重画整个回合
const m2b = store.pushMessage({ role: 'assistant', text: '都写好了。', model: 'gpt-5.6-sol', done: true });
ui.onAssistantStart(m2b); ui.onAssistantDone(m2b);
ui.onTempCommit(store.updateMessage(m2b.id, { tempCommit: { committed: ['outputs/keep.md'], discarded: ['outputs/tmp.md', 'outputs/plot.png'] } }));
const folds = $$('.edited-files');
ok('丢弃清单只画一块（上一回合的折叠不受影响）', folds.length === 2 && $$('.edited-files.has-discarded').length === 1, String(folds.length));
const fold3 = folds[1];
ok('标题仍是 Edited Files 2（按 write_file 计数）', /Edited files 2/.test(fold3.querySelector('.chip-name').textContent), fold3.querySelector('.chip-name').textContent);
const items = [...fold3.querySelectorAll('li')];
ok('列表 3 项：2 个 write_file + 1 个脚本生成的被丢弃产物', items.length === 3, String(items.length));
const dropped = [...fold3.querySelectorAll('li.fold-discarded')];
ok('2 项划线标丢弃，保留项不标', dropped.length === 2 && !items[0].classList.contains('fold-discarded'));
ok('丢弃项带「已丢弃 · 回答未引用」标签和 title 说明怎么保留', dropped.every((li) => /已丢弃 · 回答未引用/.test(li.textContent) && /写出路径或文件名即可保留/.test(li.title)));
ok('折叠底部有一行解释（internal/ 与 uploads/ 总是保留）', /本轮丢弃 2 个未在回答中引用的临时文件；internal\/ 与 uploads\/ 下的文件总是保留/.test(fold3.querySelector('.fold-note')?.textContent || ''));
ok('折叠头带 has-discarded 态', fold3.classList.contains('has-discarded'));
// 整轮没 write_file（脚本生成）→ Discarded File(s) 折叠
store.pushMessage({ role: 'user', text: '画个图' });
const m3 = store.pushMessage({ role: 'assistant', text: '', model: 'gpt-5.6-sol', toolCalls: [{ id: 'c-py', name: 'execute_python', args: { code: 'open("outputs/a.png","wb")' }, status: 'ok' }], done: false });
ui.onAssistantStart(m3);
ui.onAssistantDone(store.updateMessage(m3.id, { done: true, text: '画好了。' }));
ui.onTempCommit(store.updateMessage(m3.id, { tempCommit: { committed: [], discarded: ['outputs/a.png'] } }));
const dfold = $$('.edited-files').filter((n) => /Discarded File/.test(n.querySelector('.chip-name').textContent));
ok('没有 write_file 时用 Discarded File 标题，画在挂 tempCommit 的消息上', dfold.length === 1 && dfold[0].querySelector('.chip-name').textContent === 'Discarded File', dfold.map((n) => n.querySelector('.chip-name').textContent).join('|'));

console.log(`
P3 DOM 冒烟：${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}`);
process.exit(failures ? 1 : 0);
