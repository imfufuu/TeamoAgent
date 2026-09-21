// ─── DOM 冒烟测试（tests/dom-smoke.mjs）─────────────────────────────────
// 用 jsdom 真实挂载 index.html + mountUI，驱动关键交互路径，验证「接线」是否正确
// （元素 id、事件绑定、渲染分支、状态机动画、下载与文件面板）。
// 依赖可选：未安装 jsdom 时自动跳过（CI 只跑 agent.test.mjs，不依赖本文件）。
//   node tests/dom-smoke.mjs          # 需 npm i -D jsdom
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  console.log('跳过 DOM 冒烟测试：未安装 jsdom（npm i -D jsdom 后可运行）');
  process.exit(0);
}

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', pretendToBeVisual: true });
const { window } = dom;

for (const k of ['document', 'window', 'location', 'navigator', 'HTMLElement', 'Element', 'Node', 'CustomEvent', 'Event', 'MouseEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'URL', 'Blob', 'FormData', 'File']) {
  if (window[k] !== undefined) globalThis[k] = window[k];
}
globalThis.self = window;
globalThis.localStorage = window.localStorage;
// 破坏性操作都带 confirm()；测试里按需切换返回值
let confirmAnswer = true;
window.confirm = () => confirmAnswer;
globalThis.confirm = window.confirm;
// jsdom 未实现的浏览器 API 补齐（不影响被测代码路径的正确性）
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
const { createAgent, copyAttachmentsToFS } = await import(path.join(ROOT, 'js/agent.js'));
const { mountUI } = await import(path.join(ROOT, 'js/ui.js'));
const { createZip } = await import(path.join(ROOT, 'js/zip.js'));

const store = createStore();
store.state.apiKey = 'sk-teamo-test';
// 复刻 main.js 的接线（agent hooks → ui 方法），用于验证「用户消息立刻上屏」
const lateUI = {};
const agent = createAgent(store, {
  onUserMessage: (text, msg) => lateUI.onUserMessage && lateUI.onUserMessage(text, msg),
});
const ui = mountUI(store, agent);
lateUI.onUserMessage = (text, msg) => ui.onUserMessage(msg);
const $ = (s) => window.document.querySelector(s);
const $$ = (s) => [...window.document.querySelectorAll(s)];
const click = (n) => n.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

console.log('\n挂载与初始状态');
ok('mountUI 返回 hooks 对象', ui && typeof ui.setStatus === 'function');
ok('生图模型下拉已填充 3 项', $('#image-model').options.length === 3, `实际 ${$('#image-model').options.length}`);
ok('生图模型下拉默认 gpt-image-2', $('#image-model').value === 'gpt-image-2', $('#image-model').value);
ok('文件面板 ZIP 按钮存在', !!$('#download-zip'));

console.log('\n② 生图模型不作为对话模型出现');
click($('#model-btn'));
const ddItems = () => $$('#model-menu .dd-item-id').map((n) => n.textContent);
ok('模型菜单已渲染分组', $$('#model-menu .dd-group').length >= 5, `分组 ${$$('#model-menu .dd-group').length}`);
ok('菜单中没有 gpt-image 系列', !ddItems().some((i) => i.includes('gpt-image')), ddItems().filter((i) => i.includes('image')).join(','));
ok('菜单含 deepseek-v4-flash-vision-exp（图生文）', ddItems().includes('deepseek-v4-flash-vision-exp'));
ok('菜单不含已下线的 gemini-3.1-flash-lite-preview', !ddItems().includes('gemini-3.1-flash-lite-preview'));
ok('生图模型行在搜索框之后（DOM 顺序）', (() => {
  const kids = [...$('#model-menu').children].map((c) => c.className.split(' ')[0]);
  return kids[0] === 'dd-search-wrap' && kids[kids.length - 1] === 'dd-foot';
})(), JSON.stringify([...$('#model-menu').children].map((c) => c.className)));
// ⑦ 层级：jsdom 不抓外链样式表 → 直接校验 CSS 源码声明
const cssText = fs.readFileSync(path.join(ROOT, 'css/styles.css'), 'utf8');
const wrapZ = Number(/\.dd-search-wrap\s*\{[^}]*z-index:\s*(\d+)/.exec(cssText)?.[1] || 0);
const titleZ = Number(/\.dd-group-title\s*\{[^}]*z-index:\s*(\d+)/.exec(cssText)?.[1] ?? -1);
ok('⑦ 搜索框 z-index 高于分组图标层', wrapZ > titleZ && wrapZ > 0, `wrap=${wrapZ} title=${titleZ}`);
ok('⑦ 分组标题为定位元素（受 z-index 约束）', /\.dd-group-title\s*\{[^}]*position:\s*relative/.test(cssText));
$('#model-search').value = 'deepseek';
$('#model-search').dispatchEvent(new window.Event('input', { bubbles: true }));
ok('搜索后仅剩 DeepSeek 分组', $$('#model-menu .dd-group').length === 1 && $('#model-menu .dd-group-title').textContent.includes('DeepSeek'));
ok('搜索后生图行仍在末尾', $('#model-menu').lastElementChild.className.startsWith('dd-foot'));
$('#model-search').value = '';
$('#model-search').dispatchEvent(new window.Event('input', { bubbles: true }));

console.log('\n① 会话记录：第一条消息后才入列 + 切换会话恢复各自模型');
store.state.model = 'claude-opus-5';
store.state.imageModel = 'gpt-image-2.5-flare';
store.notify();
ui.renderSessions();
ok('空白的当前会话不进侧栏（显示引导语）', $$('.sess-item').length === 0 && !!$('#session-list .sess-empty-hint'),
  `${$$('.sess-item').length} 条`);
store.pushMessage({ role: 'user', text: 'A会话' }); // 第一条消息发出 → 立刻入列
ui.renderSessions();
ok('发出第一条消息后会话入列', $$('.sess-title').map((n) => n.textContent).join(',') === 'A会话',
  $$('.sess-title').map((n) => n.textContent).join(','));
const sessionsBefore = store.state.sessions.length;
click($('#new-session'));
ok('「＋ 新建」继承当前模型选择', store.state.model === 'claude-opus-5', store.state.model);
ok('新草稿仍不进列表（列表只剩 A）', $$('.sess-item').length === 1, `${$$('.sess-item').length} 条`);
click($('#new-session'));
ok('反复点「新建」复用同一个空草稿', store.state.sessions.length === sessionsBefore + 1, `${store.state.sessions.length} 个会话`);
store.pushMessage({ role: 'user', text: 'B会话' });
store.state.model = 'gpt-5.5';
store.notify();
ui.renderSessions();
const byTitle = (t) => $$('.sess-item').find((n) => n.querySelector('.sess-title').textContent === t);
ok('侧栏出现两个会话', !!byTitle('A会话') && !!byTitle('B会话'), $$('.sess-title').map((n) => n.textContent).join(','));
click(byTitle('A会话'));
ok('切到会话 A 恢复 claude-opus-5（互不污染）', store.state.model === 'claude-opus-5', store.state.model);
ok('按钮文案随之更新', $('#model-btn-name').textContent === 'claude-opus-5', $('#model-btn-name').textContent);
ok('生图模型下拉同步 gpt-image-2.5-flare', $('#image-model').value === 'gpt-image-2.5-flare', $('#image-model').value);
click(byTitle('B会话'));
ok('切回会话 B 恢复 gpt-5.5', store.state.model === 'gpt-5.5', store.state.model);

console.log('\n⑧ 会话改名（Agent 自动总结不覆盖用户手改）');
const rowB = byTitle('B会话');
ok('每条会话有改名按钮', !!rowB.querySelector('.sess-rename svg'), rowB.innerHTML.slice(0, 60));
click(rowB.querySelector('.sess-rename'));
const input = $('#session-list .sess-rename-input');
ok('点改名 → 出现就地输入框并带当前标题', !!input && input.value === 'B会话');
input.value = '手写标题';
input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
ok('Enter 提交后标题更新', byTitle('手写标题') !== undefined, $$('.sess-title').map((n) => n.textContent).join(','));
const activeId = store.state.activeSessionId;
ok('改名写进 store 并标记 titleSource=user', store.state.sessions.find((x) => x.id === activeId).titleSource === 'user');
ok('手改过的会话不再需要自动标题', store.needsTitle() === null);
store.state.sessions.find((x) => x.id !== activeId).titled = false; // A 会话仍可自动总结
ok('未改名的会话仍可被总结', store.needsTitle()?.sessionId !== activeId);
// A 的自动总结写回（不覆盖 B）
const aId = store.state.sessions.find((x) => x.id !== activeId).id;
ok('setAutoTitle 写入并置 titled', store.setAutoTitle(aId, '沙箱计算 π') && store.state.sessions.find((x) => x.id === aId).titleSource === 'auto');
ok('Agent 不会覆盖用户手改的标题', store.setAutoTitle(activeId, '又被总结了') === false);
ui.renderSessions();
ok('A 的标题显示为总结结果', byTitle('沙箱计算 π') !== undefined, $$('.sess-title').map((n) => n.textContent).join(','));

console.log('\n⑨ 一键清除所有会话记录');
confirmAnswer = false;
click($('#clear-sessions'));
ok('确认框取消时不动数据', store.state.sessions.length === 2 && $$('.sess-item').length === 2, `${$$('.sess-item').length} 条`);
confirmAnswer = true;
click($('#clear-sessions'));
ok('确认后所有会话被清空', store.state.sessions.length === 1 && $$('.sess-item').length === 0, `${store.state.sessions.length} / ${$$('.sess-item').length}`);
ok('清空后回到空状态引导语', !!$('#session-list .sess-empty-hint') && $$('#messages .empty-state').length === 1);
ok('清空后消息数组也是空的', store.state.messages.length === 0);

console.log('\n③ 连接动画（状态栏 + 顶栏进度条）');
ui.setStatus('connecting');
ok('状态文案含「连接模型中」', $('#status-text').textContent.includes('连接模型中'), $('#status-text').textContent);
ok('状态点为 busy.connecting', $('#status-dot').className.includes('connecting'), $('#status-dot').className);
ok('三个跳动点已渲染', $('#status-text').querySelectorAll('.sdots i').length === 3);
ok('顶栏进度条亮起并处于 connecting 节奏', $('#turn-bar').classList.contains('on') && $('#turn-bar').classList.contains('connecting'));
ui.setStatus('streaming');
ok('生成中：进度条保留但节奏切换', $('#turn-bar').classList.contains('on') && !$('#turn-bar').classList.contains('connecting'));
ok('状态文案切到「生成中」', $('#status-text').textContent.includes('生成中'));
ui.setStatus('executing');
ok('沙箱执行中提示', $('#status-text').textContent.includes('沙箱执行中'));
ui.setStatus('done');
ok('完成后进度条熄灭', !$('#turn-bar').classList.contains('on'));

console.log('\n④ 附件自动进 uploads/ + ⑤ 单文件 / ZIP 下载');
const written = copyAttachmentsToFS(agent.fs, [
  { kind: 'text', name: 'spec.md', text: '# 规格' },
  { kind: 'image', name: 'cat.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
]);
store.state.files = agent.fs.export();
store.notify();
ui.renderFiles();
ok('uploads/ 下生成两条记录', written.length === 2 && written[0] === 'uploads/spec.md', JSON.stringify(written));
agent.fs.write('outputs/nested/deep.md', '# 深一层');
store.state.files = agent.fs.export();
ui.renderFiles();
const rowPath = (n) => n.dataset.path;
const paths = $$('#file-list .ft-file').map(rowPath);
const dirs = $$('#file-list .ft-dir').map(rowPath);
ok('文件行按 data-path 记录完整路径', paths.includes('uploads/cat.png') && paths.includes('uploads/spec.md'), paths.join(','));
ok('目录节点被识别（uploads / outputs / outputs/nested）', dirs.join(',') === 'outputs,outputs/nested,uploads', dirs.join(','));
ok('目录行带 aria-expanded', $$('#file-list .ft-dir').every((n) => n.getAttribute('aria-expanded') === 'true'));
ok('目录行汇总文件数与体积', /2 个文件 ·/.test($$('#file-list .ft-dir')[2].textContent), $$('#file-list .ft-dir')[2].textContent);
ok('文件行显示文件名，整条路径挂到行 title', (() => {
  const row = $$('#file-list .ft-file').find((n) => rowPath(n) === 'uploads/cat.png');
  return !!row && row.querySelector('.ft-name').textContent === 'cat.png' && row.title === 'uploads/cat.png';
})());
ok('目录行 title 提示折叠与数量', (() => {
  const row = $$('#file-list .ft-dir').find((n) => rowPath(n) === 'uploads');
  return /共 2 个文件/.test(row.title) && /点击折叠/.test(row.title);
})(), $$('#file-list .ft-dir').map((n) => n.title).join(' | '));
ok('缩进由 --d 驱动', $$('#file-list .ft-row').some((n) => n.style.getPropertyValue('--d') === '2'), $$('#file-list .ft-row').map((n) => n.style.getPropertyValue('--d')).join(','));
ok('每行有下载按钮（目录行只有 ZIP）', $$('#file-list .file-dl').length === 3, `${$$('#file-list .file-dl').length} 个`);
ok('目录行有打包按钮', $$('#file-list .ft-zip').length === 3, `${$$('#file-list .ft-zip').length} 个`);
ok('目录/文件图标为内联 SVG', $$('#file-list .ft-ico').every((n) => !!n.querySelector('svg')));
ok('工具栏摘要含文件与目录计数', /3 个文件 · 3 个目录/.test($('#files-count').textContent), $('#files-count').textContent);

// 折叠：点目录行收起整棵子树
const uploadsRow = () => $$('#file-list .ft-dir').find((n) => rowPath(n) === 'uploads');
click(uploadsRow());
ui.renderFiles();
ok('折叠后子文件不再渲染', !$$('#file-list .ft-file').map(rowPath).includes('uploads/cat.png'), $$('#file-list .ft-file').map(rowPath).join(','));
ok('折叠后 aria-expanded=false 且带 closed 类', uploadsRow().getAttribute('aria-expanded') === 'false' && uploadsRow().classList.contains('closed'));
ok('折叠行上出现常驻 ZIP 按钮（不依赖 hover）', /ft-dir\.closed \.ft-zip \{ opacity: 1/.test(cssText));
click(uploadsRow());
ok('再点一次展开', $$('#file-list .ft-file').map(rowPath).includes('uploads/cat.png'));
click($$('#file-list .ft-file').find((n) => rowPath(n) === 'uploads/cat.png'));
ok('图片文件在查看器内预览', !!$('#file-viewer .fv-img img'));
ok('查看器带 SVG 下载按钮', !!$('#file-viewer #fv-dl svg') && /下载/.test($('#file-viewer #fv-dl').textContent));
ok('查看器关闭按钮为 SVG', !!$('#file-viewer #fv-close svg'));
click($('#fv-close'));
ok('查看器可关闭', !$('#file-viewer').classList.contains('open'));

let download = null, downloadName = null;
const origCreate = window.URL.createObjectURL;
const origRevoke = window.URL.revokeObjectURL;
const origClick = window.HTMLAnchorElement.prototype.click;
window.URL.createObjectURL = (b) => { download = b; return 'blob:fake'; };
window.URL.revokeObjectURL = () => {};
window.HTMLAnchorElement.prototype.click = function () { downloadName = this.getAttribute('download'); };
click($$('#file-list .file-dl').find((n) => n.closest('.ft-file').dataset.path === 'uploads/spec.md'));
ok('单文件下载触发且文件名正确', !!download && /spec\.md$/.test(downloadName || ''), String(downloadName));
ok('单文件下载按钮是 SVG 图标（不是 emoji）', !/⬇|↓/.test($$('#file-list .file-dl')[0].innerHTML) && !!$$('#file-list .file-dl')[0].querySelector('svg'));
download = null; downloadName = null;
click($$('#file-list .ft-zip').find((n) => n.closest('.ft-dir').dataset.path === 'uploads'));
ok('目录 ZIP 下载触发', !!download && download.size > 100, `size=${download?.size}`);
ok('目录 ZIP 以目录名命名', /^teamo-uploads-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.zip$/.test(downloadName || ''), String(downloadName));
download = null; downloadName = null;
click($('#download-zip'));
ok('整包 ZIP 下载触发', !!download && download.size > 100, `size=${download?.size}`);
ok('ZIP 文件名规范', /^teamo-sandbox-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.zip$/.test(downloadName || ''), String(downloadName));
window.HTMLAnchorElement.prototype.click = origClick;
window.URL.createObjectURL = origCreate;
window.URL.revokeObjectURL = origRevoke;
const zipBlob = createZip([{ name: 'a.txt', bytes: new TextEncoder().encode('hi') }]);
ok('createZip 返回非空 Blob', zipBlob && zipBlob.size > 22, `size=${zipBlob?.size}`);

console.log('\n①⚡ 顶栏按钮风格一致性（SVG 图标 + 中文文案）');
const fast = $('#fast-toggle');
ok('快速按钮用 class="pill"（与思考/沙箱同结构）', fast.className.includes('pill'));
ok('快速按钮内联 SVG 图标', !!fast.querySelector('svg.pill-ico') && !!fast.querySelector('svg path'));
ok('文案为「快速」而非 ⚡ Fast', fast.textContent.trim() === '快速', JSON.stringify(fast.textContent));
for (const id of ['#thinking-toggle', '#sandbox-toggle', '#fast-toggle']) {
  ok(`${id} 三个按钮同风格（pill + pill-ico svg）`, !!$(id) && $(id).classList.contains('pill') && !!$(id).querySelector('svg.pill-ico'));
}
ok('整站按钮不再使用 ⚡/⬇ emoji', !/⚡|⬇/.test(html) && !/⚡|⬇/.test(fs.readFileSync(path.join(ROOT, 'js/ui.js'), 'utf8')));
click(fast.querySelector('svg') || fast);
ok('点击快速按钮切换 on 状态', fast.classList.contains('on') !== (store.state.settings.fastMode === false));
store.state.settings.fastMode = false; fast.classList.remove('on');

console.log('\n② Agent 出图在工具芯片中展示');
const call = { id: 'call-img-1', name: 'generate_image', args: { prompt: '一只橘猫' } };
const imgMsg = store.pushMessage({ role: 'assistant', text: '好的，我来生成。', model: 'gpt-5.5', toolCalls: [call], done: false });
ui.onAssistantStart(imgMsg);
const chipSel = '.chip[data-call-id="call-img-1"]';
const chip = window.document.querySelector(chipSel);
ok('工具芯片已渲染', !!chip);
ui.onToolEvent(call, { status: 'running', note: '图像生成中（gpt-image-2 · 1024x1024）…' });
ok('芯片显示生图进度', chip.querySelector('.chip-state').textContent.includes('图像生成中'), chip.querySelector('.chip-state').textContent);
ui.onToolEvent(call, { status: 'ok', image: 'data:image/png;base64,iVBORw0KGgo=', imagePath: 'outputs/image-001.png' });
ok('芯片内显示生成的图片', !!chip.querySelector('.chip-img img'));
ok('图片说明含沙箱路径', /outputs\/image-001\.png/.test(chip.querySelector('.chip-img-cap').textContent));
ui.onToolResult(call, '[图像生成完成]\n- 模型：gpt-image-2\n- 输出：outputs/image-001.png');
ok('回填结果后图片仍在', !!chip.querySelector('.chip-img img'));
ok('回填后展示工具文本', chip.querySelector('.chip-result')?.textContent.includes('图像生成完成'));
ui.onAssistantDone(imgMsg);
ok('重绘后从缓存恢复图片', !!window.document.querySelector(`${chipSel} .chip-img img`));
ok('消息头部显示该轮实际模型 gpt-5.5', window.document.querySelector(`${chipSel}`).closest('.msg-assistant').querySelector('.msg-model').textContent === 'gpt-5.5');

console.log('\n③ 未收到首字时气泡内的连接动画');
const waitMsg = store.pushMessage({ role: 'assistant', text: '', model: 'claude-opus-5', done: false });
ui.onAssistantStart(waitMsg);
const waitWrap = window.document.querySelector(`.msg[data-id="${waitMsg.id}"]`);
ok('显示「正在连接 claude-opus-5」', waitWrap.querySelector('.connect-line')?.textContent.includes('正在连接 claude-opus-5'), waitWrap.querySelector('.md-body')?.textContent);
ok('连接中有旋转环元素', !!waitWrap.querySelector('.connect-ring'));
store.updateMessage(waitMsg.id, { text: '你好！', done: true });
ui.onAssistantDone(waitMsg);
ok('收到内容后连接动画消失', !waitWrap.querySelector('.connect-line'));

console.log('\n① 用户消息即时上屏（不必等 AI 输出完）');
const mainSrc = fs.readFileSync(path.join(ROOT, 'js/main.js'), 'utf8');
ok('main.js 已把 onUserMessage 接到 ui.onUserMessage(msg)', /onUserMessage:\s*\(text,\s*msg\)\s*=>\s*\{\s*ui && ui\.onUserMessage\(msg\)/.test(mainSrc), mainSrc.split('\n').find((l) => l.includes('onUserMessage')));
const origFetch = globalThis.fetch;
let releaseStream = null;
globalThis.fetch = () => new Promise((resolve) => { releaseStream = () => resolve(new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })); });
const beforeCount = store.state.messages.length;
const sending = agent.send('这条输入应当立刻可见');
await Promise.resolve(); // 让 send() 跑到 pushMessage + hook
const userNodes = $$('#messages .msg-user .bubble').map((n) => n.textContent.trim());
ok('发送后立即可见用户气泡', userNodes.some((t) => t.includes('这条输入应当立刻可见')), userNodes.join(' | '));
ok('用户消息已进入 state（其后才是 assistant 占位）', (() => {
  const list = store.state.messages;
  const lastUser = [...list].reverse().find((m) => m.role === 'user');
  return list.length > beforeCount && !!lastUser && lastUser.text.includes('这条输入应当立刻可见');
})());
ok('回滚按钮随用户消息一起渲染', !!$('#messages .msg-user .act'));
if (releaseStream) releaseStream();
await sending;
globalThis.fetch = origFetch;

console.log('\n② 空状态随机三条示例 + 换一批');
const sg = await import(path.join(ROOT, 'js/suggestions.js'));
ok('示例池 ≥12 条', sg.SUGGESTIONS.length >= 12, `${sg.SUGGESTIONS.length} 条`);
// 重挂空状态：清空消息后 rebuildMessages 会重新渲染
const savedMsgs = [...store.state.messages];
store.state.messages.length = 0;
ui.rebuildMessages();
const emptyState = $('#messages .empty-state');
const cards = emptyState ? [...emptyState.querySelectorAll('.suggest')] : [];
ok('空状态展示 3 条示例卡片', cards.length === 3, `${cards.length} 张`);
const cmp = (a, b) => { const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) if (a[i] !== b[i]) return `${i}:${a.charCodeAt(i)}≠${b.charCodeAt(i)}`; return a.length === b.length ? 'eq' : `len ${a.length}/${b.length}`; };
ok('示例卡不再带「任务类型」标签', cards.every((c) => !c.querySelector('.suggest-tag') && cmp(c.textContent.trim(), c.dataset.prompt || '') === 'eq'),
  cards.map((c) => `${cmp(c.textContent.trim(), c.dataset.prompt || '')}/${c.querySelector('.suggest-tag') ? '有标签:' + c.querySelector('.suggest-tag').outerHTML.slice(0, 60) : '无标签'}/${JSON.stringify([...c.children].map((k) => k.className))}`).join(' | '));
ok('CSS 里也没有 .suggest-tag 残留', !cssText.includes('.suggest-tag'));
ok('示例文本来自池子且本轮不重复', cards.every((c) => sg.SUGGESTIONS.some((x) => x.text === c.dataset.prompt)) && new Set(cards.map((c) => c.dataset.prompt)).size === 3);
ok('有「换一批」按钮', !!$('#messages .suggest-shuffle svg'));
const firstBatch = cards.map((c) => c.dataset.prompt).join('|');
// 连续重挂若干次，期望至少出现一次不同的组合（随机生效）
let sawDifferent = false;
for (let i = 0; i < 12 && !sawDifferent; i++) {
  click($('#messages .suggest-shuffle'));
  const now = [...window.document.querySelectorAll('#messages .empty-state .suggest')].map((c) => c.dataset.prompt).join('|');
  if (now !== firstBatch) sawDifferent = true;
}
ok('换一批会换出不同组合', sawDifferent);
const cardEl = window.document.querySelector('#messages .empty-state .suggest');
click(cardEl);
ok('点示例卡把整句任务填进输入框', (() => {
  const v = $('#composer-input').value;
  return v === cardEl.dataset.prompt && v === cardEl.textContent.trim() && v.length > 8;
})(), JSON.stringify($('#composer-input').value).slice(0, 60));
store.state.messages.push(...savedMsgs);
ui.rebuildMessages();

console.log('\n④ 侧栏 Logo 不再自转');
const logoRule = /\.logo-mark\s*\{[^}]*\}/.exec(cssText)?.[0] || '';
ok('.logo-mark 无 animation', !/animation/.test(logoRule), logoRule.trim());
ok('仅空状态大 Logo 保留慢转', /\.empty-logo svg\s*\{[^}]*animation: halfspin/.test(cssText));
ok('index.html 侧栏 Logo 无内联动画', !/logo-mark[^>]*style="[^"]*animation/.test(html));

console.log('\n③ 视图层故障不能 brick 发送');
const cfgMod = await import(path.join(ROOT, 'js/config.js'));
const cfgMod2 = cfgMod;
ok('侧栏展示构建版本', $('#build-stamp').textContent.includes(cfgMod.APP_VERSION), $('#build-stamp').textContent);
ok('index.html 入口资源已版本化', /css\/styles\.css\?v=/.test(html) && /js\/main\.js\?v=/.test(html));
// 旧调用方只传文本（缓存了旧 main.js 的情形）：UI 需自己找回那条用户消息
const oldStyle = store.pushMessage({ role: 'user', text: '旧式调用只给文本' });
ui.onUserMessage('旧式调用只给文本');
ok('旧式 onUserMessage(text) 仍能上屏', $$('#messages .msg-user .bubble').some((n) => n.textContent.includes('旧式调用只给文本')));
ok('不会重复插入同一节点', $$('#messages .msg[data-id="' + oldStyle.id + '"]').length === 1,
  `${$$('#messages .msg[data-id="' + oldStyle.id + '"]').length} 个节点`);
ui.onUserMessage('旧式调用只给文本');
ok('重复调用被去重', $$('#messages .msg[data-id="' + oldStyle.id + '"]').length === 1);

console.log('\n⑥ Kimi 品牌图标');
const { providerIcon } = await import(path.join(ROOT, 'js/icons.js'));
ok('providerIcon(Kimi) 指向 kimi.svg', providerIcon('Kimi').includes('assets/icons/kimi.svg'), providerIcon('Kimi'));
ok('kimi.svg 存在且已精简', (() => {
  const p = path.join(ROOT, 'assets/icons/kimi.svg');
  return fs.existsSync(p) && fs.statSync(p).size < 4096;
})());

console.log('\n⑩ 操作条：输出结束才出现，复制按钮带 SVG 图标');
{
  const { renderMarkdown: _rm } = await import(path.join(ROOT, 'js/ui.js'));
  store.pushMessage({ role: 'user', text: '请写点东西' });
  const partial = store.pushMessage({ role: 'assistant', text: '写到一半', model: 'gpt-5.5', done: false });
  ui.rebuildMessages();
  const wrapOf = (id) => $(`#messages .msg[data-id="${id}"]`);
  const userMsg = store.state.messages[store.state.messages.length - 2];
  ok('流式期间：本轮 user 与 assistant 的操作条都隐藏',
    wrapOf(userMsg.id).classList.contains('actions-pending') && wrapOf(partial.id).classList.contains('actions-pending'));
  const cssText2 = fs.readFileSync(path.join(ROOT, 'css/styles.css'), 'utf8');
  ok('隐藏由 .actions-pending + display:none 实现', /\.msg\.actions-pending \.msg-actions[^{]*\{[^}]*display: none/.test(cssText2));
  store.updateMessage(partial.id, { done: true });
  ui.setStatus('done'); // 真实链路：agent 的 onStatus → ui.setStatus → 刷新显隐
  ui.onAssistantDone(partial);
  ok('输出完成后操作条出现', !wrapOf(partial.id).classList.contains('actions-pending'));
  const acts = [...wrapOf(partial.id).querySelectorAll('.act')];
  ok('复制按钮是 SVG 图标 + 中文文字', acts.some((b) => b.dataset.act === 'copy' && b.querySelector('svg') && /复制/.test(b.textContent)),
    acts.map((b) => b.innerHTML.slice(0, 24)).join(' | '));
  ok('回滚/重新生成同样带 SVG（同一视觉语言）',
    acts.filter((b) => b.dataset.act !== 'copy').every((b) => b.querySelector('svg')));
  ok('工具图标没有 emoji 残留', !/[⚡⬇◧◨◑⤺↻📄🖼]/.test(acts.map((b) => b.textContent).join('')), acts.map((b) => b.textContent.trim()).join(','));
  ok('「重新生成」只给最后一条 assistant', acts.find((b) => b.dataset.act === 'regen').style.display === '');
}

console.log('\n⑪ 沙箱面板头部改成两行（标题一行，统计与按钮一行）');
{
  const bar = $('#tab-files .files-bar');
  ok('第一行是「虚拟文件系统」标题', $('#tab-files .files-toolbar > .files-title')?.textContent.trim() === '虚拟文件系统');
  ok('第二行含文件统计与 ZIP/清空', !!bar && !!$('#files-count', bar ? undefined : undefined) === true && !!bar.querySelector('#download-zip') && !!bar.querySelector('#clear-files'),
    bar ? bar.className : 'no .files-bar');
  const css = fs.readFileSync(path.join(ROOT, 'css/styles.css'), 'utf8');
  ok('工具栏为 column 布局（两行）', /\.files-toolbar\s*\{[^}]*flex-direction: column/.test(css));
  ok('第二行自身是左右分布', /\.files-bar\s*\{[^}]*justify-content: space-between/.test(css));
}

console.log('\n⑫ 联网开关（模型 API 自带格式，无第三方搜索）');
{
  const web = await import(path.join(ROOT, 'js/websearch.js'));
  const pill = $('#web-toggle');
  ok('顶栏有「联网」pill（SVG + 中文）', !!pill && !!pill.querySelector('svg') && /联网/.test(pill.textContent), pill ? pill.textContent : '缺失');
  ok('默认开启', pill.classList.contains('on') && store.state.settings.webEnabled !== false);
  // 提示语必须跟着「当前模型」走：先点模型列表选 GPT，pill 要立刻改成 Responses 原生格式的说法
  const before = pill.title;
  // 提示语必须跟着「当前模型」走：从模型菜单选 GPT，pill 要立刻改成 Responses 原生格式的说法
  const titleBefore = pill.title;
  click($('#model-btn'));
  const item = $$('#model-menu .dd-item').find((n) => /gpt-5\.5/.test(n.textContent));
  ok('模型菜单里有 GPT 这一项', !!item, $$('#model-menu .dd-item').length + ' 项');
  click(item);
  ok('菜单点完即关闭', !$('#model-menu').classList.contains('open'));
  ok('切模型后 store 里确实是这个模型', store.state.model === 'gpt-5.5', store.state.model);
  const capGpt = web.webCapFor('gpt-5.5');
  const capClaude = web.webCapFor('claude-opus-5');
  ok('pill 的提示语跟着换成该模型的原生格式',
    pill.title.includes(capGpt.label) && !pill.title.includes(capClaude.label) && pill.title !== titleBefore,
    pill.title);
  click(pill);
  ok('点一下即关闭并写回 settings', store.state.settings.webEnabled === false && !$('#web-toggle').classList.contains('on'));
  click($('#web-toggle'));
  ok('再点恢复开启', store.state.settings.webEnabled === true);
  // 联网来源条：由消息上的 webSearch 渲染（切会话/重开页面后同样能重建）
  const m = store.pushMessage({
    role: 'assistant', text: '根据来源回答', model: store.state.model, done: true,
    webSearch: { status: 'done', results: 2, queries: ['pyodide 0.26 版本'], sources: [{ url: 'https://pyodide.org/docs', title: 'Pyodide 文档' }, { url: 'https://a.test/b', title: 'B' }] },
  });
  ui.rebuildMessages();
  const note = $('#messages .msg[data-id="' + m.id + '"] .web-note');
  ok('回答下方出现联网来源条（含条数与查询词）', !!note && /服务端检索到 2 条来源/.test(note.textContent) && /pyodide 0.26 版本/.test(note.textContent), note ? note.textContent : '缺失');
  ok('来源渲染成可点外链且带 noopener', [...note.querySelectorAll('a.web-src')].length === 2 && String(note.querySelector('a').getAttribute('rel')).includes('noopener') && note.querySelector('a').target === '_blank');
  const m2 = store.pushMessage({ role: 'assistant', text: 'x', done: true, webSearch: { status: 'searching', sources: [], results: 0, queries: [] } });
  ui.rebuildMessages();
  ok('检索中显示进度而不是一片空白', !!$('#messages .msg[data-id="' + m2.id + '"] .web-note .web-dot'));
  ok('没有 webSearch 的消息不画来源条', $$('#messages .msg-user .web-note').length === 0);
}

console.log('\n⑬ 余额显示已删除');
{
  const html2 = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ok('markup 里没有 balance-badge', !/balance-badge/.test(html2));
  ok('UI 源码不再请求余额接口', !/fetchBalance|\/api\/user\/self/.test(fs.readFileSync(path.join(ROOT, 'js/ui.js'), 'utf8')));
  const uiSrc = fs.readFileSync(path.join(ROOT, 'js/ui.js'), 'utf8');
  ok('api.js 也不再导出余额函数', !/export async function fetchBalance/.test(fs.readFileSync(path.join(ROOT, 'js/api.js'), 'utf8')) && !/refreshBalance/.test(uiSrc));
}

console.log('\n⑭ 欢迎页在 y 轴居中');
{
  const css = fs.readFileSync(path.join(ROOT, 'css/styles.css'), 'utf8');
  const rule = /\.empty-state\s*\{[^}]*\}/.exec(css)?.[0] || '';
  ok('empty-state 自己是 flex 纵向居中容器', /display: flex/.test(rule) && /align-items: center/.test(rule) && /justify-content: center/.test(rule), rule);
  ok('靠 min-height:100% 占满视口而不是拍脑袋的 margin', /min-height: 100%/.test(rule) && !/margin: 9vh/.test(rule), rule);
  ok('内容超高时不裁顶（safe center）', /justify-content: safe center/.test(rule), rule);
  ok('有对话时布局不变（.messages 仍是普通滚动容器）', !/\.messages\s*\{[^}]*display: flex/.test(css));
}

console.log('\n⑮ 版本漂移自检（硬刷新前就能发现缓存不一致）');
{
  const uiSrc = fs.readFileSync(path.join(ROOT, 'js/ui.js'), 'utf8');
  ok('入口自带 app-version meta', /<meta name="app-version" content="([\d.]+)"/.test(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')));
  ok('UI 比对入口版本与模块版本并提示', /meta\[name="app-version"\]/.test(uiSrc) && /资源缓存不一致|缓存不一致/.test(uiSrc));
  ok('侧栏版本号仍然显示', $('#build-stamp').textContent.includes(cfgMod2.APP_VERSION), $('#build-stamp').textContent);
}

console.log('\n⑯ 移动端布局：根因修复 + 密度重排（源码级护栏）');
{
  const css = fs.readFileSync(path.join(ROOT, 'css/styles.css'), 'utf8');
  const uiSrc = fs.readFileSync(path.join(ROOT, 'js/ui.js'), 'utf8');
  // 根因：窄屏时 sidebar / panel 变 position:fixed 脱离网格，若没有命名网格区，
  // 唯一的在流子项 .main 会被自动排进第一列（--sbw 收敛为 0px）→ 主区宽度 0、内容挤成一团
  ok('网格用命名区域钉住三块', /grid-template-areas:\s*"side main panel"/.test(css));
  ok('.main / .sidebar / #sandbox-panel 各自认领区域', /\.main\s*\{[^}]*grid-area:\s*main/.test(css)
    && /\.sidebar\s*\{[^}]*grid-area:\s*side/.test(css) && /#sandbox-panel\s*\{[^}]*grid-area:\s*panel/.test(css));
  const m720 = /@media \(max-width: 720px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] || '';
  ok('存在 ≤720px 的移动端排布层', m720.length > 400, `${m720.length} 字节`);
  ok('顶栏胶囊横滑而不是挤成多行', /\.topbar-right\s*\{[^}]*flex-wrap: nowrap/.test(m720) && /\.topbar-right\s*\{[^}]*overflow-x: auto/.test(m720));
  ok('输入框字号 16px（低于它 iOS 会放大整页）', /#composer-input\s*\{[^}]*font-size: 16px/.test(m720));
  ok('消息区左右留白收窄、操作条允许换行', /\.msg\s*\{[^}]*padding: 0 14px/.test(m720) && /\.msg-actions\s*\{[^}]*flex-wrap: wrap/.test(m720));
  ok('长链接/代码块各自滚动不撑宽页面', /\.md-body pre\s*\{[^}]*font-size/.test(m720) && /\.md-body a\s*\{[^}]*overflow-wrap: anywhere/.test(m720));
  ok('输入区贴安全区（刘海屏不被遮挡）', /\.composer-wrap\s*\{[^}]*env\(safe-area-inset-bottom\)/.test(m720));
  const touch = /@media \(hover: none\), \(max-width: 720px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] || '';
  ok('触屏设备（含平板）可点区域 ≥40px', /\.act\s*\{[^}]*min-height: 40px/.test(touch) && /\.pill\s*\{[^}]*min-height: 40px/.test(touch)
    && /\.mini-btn\s*\{[^}]*min-height: 40px/.test(touch), `${touch.length} 字节`);
  // 侧栏面板按钮曾被 textContent='◧' 整体替换，丢掉 pill 的「图标 + 文字」统一外观并被压到 30 多像素宽
  ok('沙箱面板按钮保留图标+文字（没有 ◧ / ◨ 字符）', !/[◧◨]/.test(uiSrc));
  ok('它的状态改用 class + aria-pressed 表达', /setPanelCollapsed/.test(uiSrc) && /aria-pressed/.test(uiSrc) && /classList\.toggle\('on'/.test(uiSrc));
}

console.log(failures ? `\n${failures} 项失败 ❌` : '\nDOM 冒烟测试全部通过 ✅');
process.exit(failures ? 1 : 0);
