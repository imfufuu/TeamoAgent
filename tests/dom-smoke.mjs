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
const agent = createAgent(store, {});
const ui = mountUI(store, agent);
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

console.log('\n① 切换会话后模型名恢复该会话自己的模型');
store.state.model = 'gpt-5.5';
store.state.imageModel = 'gpt-image-2.5-flare';
store.notify();
ui.renderSessions();
click($('#new-session'));
ok('新会话继承当前模型', store.state.model === 'gpt-5.5', store.state.model);
store.pushMessage({ role: 'user', text: 'B会话' }); // 让 B 有可定位的标题
store.state.model = 'claude-opus-5';
store.notify();
ui.renderSessions();
const byTitle = (t) => $$('.sess-item').find((n) => n.querySelector('.sess-title').textContent === t);
ok('侧栏出现两个会话', !!byTitle('B会话') && !!byTitle('新对话'), $$('.sess-title').map((n) => n.textContent).join(','));
click(byTitle('新对话'));
ok('切回会话 A 恢复 gpt-5.5', store.state.model === 'gpt-5.5', store.state.model);
ok('模型按钮文案同步 gpt-5.5', $('#model-btn-name').textContent === 'gpt-5.5', $('#model-btn-name').textContent);
ok('生图模型下拉同步 gpt-image-2.5-flare', $('#image-model').value === 'gpt-image-2.5-flare', $('#image-model').value);
click(byTitle('B会话'));
ok('切到会话 B 恢复 claude-opus-5（互不污染）', store.state.model === 'claude-opus-5', store.state.model);
ok('按钮文案随之更新', $('#model-btn-name').textContent === 'claude-opus-5', $('#model-btn-name').textContent);

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
const paths = $$('#file-list .file-path').map((n) => n.textContent);
ok('文件面板列出 uploads 条目', paths.includes('uploads/cat.png') && paths.includes('uploads/spec.md'), paths.join(','));
ok('每行有下载按钮', $$('#file-list .file-dl').length === 2, `${$$('#file-list .file-dl').length} 个`);
click($$('#file-list .file-item').find((n) => n.textContent.includes('cat.png')));
ok('图片文件在查看器内预览', !!$('#file-viewer .fv-img img'));
ok('查看器带下载按钮', !!$('#file-viewer #fv-dl'));
click($('#fv-close'));
ok('查看器可关闭', !$('#file-viewer').classList.contains('open'));

let download = null, downloadName = null;
const origCreate = window.URL.createObjectURL;
const origRevoke = window.URL.revokeObjectURL;
const origClick = window.HTMLAnchorElement.prototype.click;
window.URL.createObjectURL = (b) => { download = b; return 'blob:fake'; };
window.URL.revokeObjectURL = () => {};
window.HTMLAnchorElement.prototype.click = function () { downloadName = this.getAttribute('download'); };
click($$('#file-list .file-dl')[1]);
ok('单文件下载触发且文件名正确', !!download && /cat\.png$/.test(downloadName || ''), String(downloadName));
download = null; downloadName = null;
click($('#download-zip'));
ok('ZIP 下载触发', !!download && download.size > 100, `size=${download?.size}`);
ok('ZIP 文件名规范', /^teamo-sandbox-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.zip$/.test(downloadName || ''), String(downloadName));
window.HTMLAnchorElement.prototype.click = origClick;
window.URL.createObjectURL = origCreate;
window.URL.revokeObjectURL = origRevoke;
const zipBlob = createZip([{ name: 'a.txt', bytes: new TextEncoder().encode('hi') }]);
ok('createZip 返回非空 Blob', zipBlob && zipBlob.size > 22, `size=${zipBlob?.size}`);

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

console.log('\n⑥ Kimi 品牌图标');
const { providerIcon } = await import(path.join(ROOT, 'js/icons.js'));
ok('providerIcon(Kimi) 指向 kimi.svg', providerIcon('Kimi').includes('assets/icons/kimi.svg'), providerIcon('Kimi'));
ok('kimi.svg 存在且已精简', (() => {
  const p = path.join(ROOT, 'assets/icons/kimi.svg');
  return fs.existsSync(p) && fs.statSync(p).size < 4096;
})());

console.log(failures ? `\n${failures} 项失败 ❌` : '\nDOM 冒烟测试全部通过 ✅');
process.exit(failures ? 1 : 0);
