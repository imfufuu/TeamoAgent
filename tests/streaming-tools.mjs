// 2026.10.10.1: chronology, folding, cancellation, incremental file/Worker output.
import test from 'node:test';
const checks = []; const check = (name, fn) => checks.push([name, fn]);
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { recordOutputText, recordOutputTool, displayParts, turnHasAssistantText, appendToolStream, TOOL_STREAM_MAX_CHARS } from '../js/toolflow.js?v=2026.10.10.1';
import { createToolPresentation, projectToolPrefix } from '../js/toolpresentation.js?v=2026.10.10.1';
import { createToolCallAccumulator } from '../js/api.js?v=2026.10.10.1';
import { createFS, createTempFS, websiteDependencies, runJavaScript } from '../js/sandbox.js';
import { sandboxProject, sandboxBrowserRequest, probeLocalBrowser, resetLocalBrowserProbe } from '../js/localbrowser.js?v=2026.10.10.1';
import { computeCapabilityVector } from '../js/nexus.js';
import { TOOL_DEFS, executeTool } from '../js/tools.js';
import { buildCapabilityConstraints, checkCapabilityConstraints } from '../js/execution.js';
import { createTurnExecutionContext, deriveToolWhitelist, selectToolsForTurn } from '../js/executionContext.js';

const dom = new JSDOM(fs.readFileSync(new URL('../app.html', import.meta.url), 'utf8'), { url: 'http://localhost:8787', pretendToBeVisual: true });
const { window } = dom;
// Legacy Chinese contracts are explicit; separate feature/browser tests exercise auto English.
Object.defineProperty(window.navigator, 'language', { value: 'zh-CN', configurable: true });
for (const k of ['document', 'window', 'location', 'navigator', 'HTMLElement', 'Element', 'Node', 'CustomEvent', 'Event', 'MouseEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'URL', 'Blob', 'FormData', 'File']) if (window[k] !== undefined) Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true });
globalThis.self = window; globalThis.localStorage = window.localStorage;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.matchMedia = window.matchMedia;
globalThis.confirm = window.confirm = () => true;
globalThis.CSS = window.CSS = { escape: (s) => String(s).replace(/[^\w-]/g, (c) => `\\${c}`) };
window.Element.prototype.scrollTo = function () {};
window.Element.prototype.scrollIntoView = function () {};
const { createStore } = await import('../js/state.js');
const { createAgent } = await import('../js/agent.js');
const { mountUI } = await import('../js/ui.js');
const store = createStore(), agent = createAgent(store, {});
let status = 'streaming'; agent.getStatus = () => status;
const nativeSetInterval = globalThis.setInterval, nativeClearInterval = globalThis.clearInterval;
globalThis.setInterval = window.setInterval.bind(window); globalThis.clearInterval = window.clearInterval.bind(window);
const ui = mountUI(store, agent);
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const click = (n) => n.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const frame = () => new Promise((r) => setTimeout(r, 35));
const until = async (fn, ms = 1600) => { const end = Date.now() + ms; while (!fn()) { assert.ok(Date.now() < end, 'timed out waiting for UI'); await new Promise((r) => setTimeout(r, 10)); } };
let seq = 0;
function reset() { store.state.messages = []; status = 'streaming'; ui.rebuildMessages(); store.pushMessage({ role: 'user', text: '验收' }); }
function call(name = 'execute_javascript', args = { code: 'return 1' }) { return { id: `stream-${++seq}`, name, args }; }
function assistant(toolCalls = [], text = '', extra = {}) { const m = store.pushMessage({ role: 'assistant', model: 'gpt-5.6-sol', text, toolCalls, done: false, ...extra }); ui.onAssistantStart(m); return m; }
function result(c, body = '── 控制台输出 ──\n[log] done') { c.status = 'ok'; store.pushMessage({ role: 'tool', toolCallId: c.id, name: c.name, content: body }); ui.onToolResult(c, body); }
function done(m) { store.updateMessage(m.id, { done: true }); ui.onAssistantDone(m); }
function wrap(m) { return $(`#messages .msg[data-id="${m.id}"]`); }
function before(a, b) { return !!(a.compareDocumentPosition(b) & window.Node.DOCUMENT_POSITION_FOLLOWING); }


check('tool→text→tool metadata preserves order even for out-of-order protocol indices', () => {
  const m = { text: '', toolCalls: [{ id: 'zero', name: 'execute_javascript' }, { id: 'three', name: 'execute_javascript' }], toolOrderIndices: [0, 3] };
  recordOutputTool(m, 3); m.text = '插话😀'; recordOutputText(m, 0, m.text.length); recordOutputTool(m, 0);
  const p = displayParts(m);
  assert.deepEqual(p.map((x) => x.kind), ['commands', 'text', 'commands']);
  assert.equal(p[0].toolCalls[0].id, 'three'); assert.equal(p[1].text, '插话😀'); assert.equal(p[2].toolCalls[0].id, 'zero');
  assert.deepEqual(displayParts(JSON.parse(JSON.stringify(m))), p, 'persisted/reloaded chronology is identical');
});

check('two command messages do not drag the first block across intervening assistant text', () => {
  reset(); status = 'done'; const a = call(), b = call();
  const first = assistant([a], '', { done: true }); result(a);
  const middle = assistant([], '这是不能跨越的正文', { done: true });
  const last = assistant([b], '', { done: true }); result(b);
  ui.rebuildMessages();
  assert.equal($$('.ran-commands').length, 2);
  assert.ok(before($('.ran-commands', wrap(first)), $('.md-body', wrap(middle))));
  assert.ok(before($('.md-body', wrap(middle)), $('.ran-commands', wrap(last))));
});

check('a streamed message reveals command→text→command in order, without crossing its text barrier', async () => {
  reset(); const a = call(), b = call();
  const m = assistant([a, b], '先解释，再执行'); m.outputOrder = []; m.toolOrderIndices = [0, 1];
  recordOutputTool(m, 0); recordOutputText(m, 0, m.text.length); recordOutputTool(m, 1);
  ui.onAssistantDone(m);
  assert.deepEqual($$('.assistant-fragment', wrap(m)).map((n) => n.dataset.family), ['commands', 'text']);
  const first = $('.tool-call-chip', wrap(m)); result(a); result(b);
  await until(() => $$('.tool-call-chip', wrap(m)).length === 2);
  assert.equal($('.tool-call-chip', wrap(m)), first);
  assert.deepEqual($$('.assistant-fragment', wrap(m)).map((n) => n.dataset.family), ['commands', 'text', 'commands']);
  assert.equal($$('.ran-commands', wrap(m)).length, 2);
  assert.equal($$('.tool-call-chip', wrap(m)).length, 2);
  assert.ok($$('.ran-commands', wrap(m)).every((n) => $('.chip-name', n).textContent === 'Ran command'));
});

check('adjacent tool-only messages can still merge, without collapsing repeated calls into ×N', () => {
  reset(); status = 'done'; const a = call(), b = call();
  const one = assistant([a], '', { done: true }); result(a);
  const two = assistant([b], '', { done: true }); result(b);
  ui.rebuildMessages();
  assert.equal($$('.ran-commands').length, 1); assert.equal($$('.tool-call-chip').length, 2);
  assert.equal($('.ran-commands .chip-name').textContent, 'Ran commands 2');
  assert.ok(!$('.ran-commands', wrap(one))); assert.ok($('.ran-commands', wrap(two)));
});

check('pure-tool turns stay expanded on completion; preceding text permits folding', () => {
  reset(); status = 'executing'; const a = call(); const m = assistant([a]); result(a); done(m); status = 'done'; ui.onAssistantDone(m);
  assert.ok($('.ran-commands', wrap(m)).classList.contains('expanded'));
  assert.ok($('.tool-call-chip', wrap(m)).classList.contains('expanded'));
  reset(); assistant([], '正文已在工具之前输出', { done: true }); const b = call(), n = assistant([b]); result(b); done(n);
  assert.ok(!$('.ran-commands', wrap(n)).classList.contains('expanded'));
  assert.ok(turnHasAssistantText(store.state.messages, n.id));
});

check('later assistant text updates older completed folds in the same turn, not other turns', async () => {
  reset(); const a = call(), m = assistant([a]); result(a); done(m);
  assert.ok($('.ran-commands', wrap(m)).classList.contains('expanded'));
  const text = assistant([], '正文开始'); ui.onDelta(text); await frame();
  assert.ok(!$('.ran-commands', wrap(m)).classList.contains('expanded'));
  store.pushMessage({ role: 'user', text: '新的纯工具轮' }); const b = call(), n = assistant([b]); result(b); done(n);
  assert.ok($('.ran-commands', wrap(n)).classList.contains('expanded'), 'previous turn text cannot fold the new turn');
});

check('manual expansion of the group and each call wins across completion and full rebuilds', () => {
  reset(); const c = call(), m = assistant([c], '前置正文'); result(c); done(m);
  click($('.ran-commands', wrap(m))); click($('.tool-call-chip', wrap(m)));
  ui.onAssistantDone(m); ui.rebuildMessages();
  assert.ok($('.ran-commands', wrap(m)).classList.contains('expanded'));
  assert.ok($('.tool-call-chip', wrap(m)).classList.contains('expanded'));
});

check('tool parameters are visible before valid JSON; changes do not replace live windows', async () => {
  reset(); const c = call('execute_javascript', { __raw: '{"code":"console.log(1)' }); const m = assistant([c]);
  const pre = $('[data-win="command"] pre', wrap(m)); assert.match(pre.textContent, /console.log\(1\)/);
  c.args = { __raw: '{"code":"console.log(1); return 9' }; ui.onDelta(m); await frame();
  assert.equal($('[data-win="command"] pre', wrap(m)), pre); assert.match(pre.textContent, /return 9/);
});

check('STDOUT/STDERR arrive before a final result and remain visible after rebuilding', async () => {
  reset(); const c = call(), m = assistant([c]);
  ui.onToolEvent(c, { status: 'running', stream: 'stdout', delta: 'first live line\n' });
  assert.match($('[data-win="stdout"] pre', wrap(m)).textContent, /first live line/);
  ui.onToolEvent(c, { status: 'running', stream: 'stderr', delta: 'live warning\n' }); await frame();
  assert.match($('[data-win="stderr"] pre', wrap(m)).textContent, /live warning/);
  ui.rebuildMessages(); assert.match($('[data-win="stdout"] pre', wrap(m)).textContent, /first live line/);
  assert.equal(store.state.messages.filter((x) => x.role === 'tool').length, 0, 'nothing pretends to be a final tool result');
});

check('half-valid file edits stream decoded content without mutating the filesystem', async () => {
  reset(); const c = call('write_file', { __raw: '{"path":"site/live.html","content":"第一行\\n第二行' }); const m = assistant([c]);
  assert.match($('.edited-files .ep-body', wrap(m)).textContent, /第一行/);
  assert.ok(!agent.fs.has('site/live.html')); assert.match($('.ep-state', wrap(m)).textContent, /内容生成中/);
  await new Promise((r) => setTimeout(r, 60)); c.args.__raw += '\\n第三行'; ui.onDelta(m); await frame();
  assert.match($('.edited-files .ep-body', wrap(m)).textContent, /第三行/); assert.ok(!agent.fs.has('site/live.html'));
});

check('manually opened file preview survives the text/tool-fragment transition and completion', () => {
  reset(); const c = call('write_file', { path: 'site/manual.html', content: 'one' }); const m = assistant([c]);
  const old = $('.edited-files', wrap(m)); click(old); click(old); // explicit open
  store.updateMessage(m.id, { text: '说明正文', done: true }); ui.onAssistantDone(m); ui.rebuildMessages();
  assert.ok($('.edited-files', wrap(m)).classList.contains('expanded'));
});

check('read_file delivers incremental real content before its completion frame', async () => {
  reset(); const c = call('read_file', { path: 'notes/live.txt' }); const m = assistant([c], '', { done: true }); status = 'executing';
  ui.onToolEvent(c, { status: 'running', stream: 'stdout', delta: '读取内容一\n' }); await frame();
  assert.match($('.file-read-stream', wrap(m)).textContent, /读取内容一/);
  ui.onToolEvent(c, { stream: 'stdout', delta: '读取内容二\n' }); await frame();
  assert.match($('.file-read-stream', wrap(m)).textContent, /读取内容一\n读取内容二/);
  assert.ok($('.explored-files', wrap(m)).classList.contains('expanded'));
});

check('stop marker follows every unfinished tool/text/file fragment; queued old paints and late events cannot move it', async () => {
  reset(); const c = call(), m = assistant([c], '未写完的消息');
  m.outputOrder = [{ kind: 'tools', indices: [0] }, { kind: 'text', start: 0, end: m.text.length }];
  ui.onDelta({ ...m, text: '旧帧' }); status = 'cancelled'; store.updateMessage(m.id, { cancelled: true, done: true }); ui.onCancelled();
  await frame(); const w = wrap(m), marker = $('.cancelled-tag', w);
  assert.ok(marker); assert.ok(before($('.tool-call-chip', w), marker));
  assert.ok(before($$('.md-body', w).at(-1), marker)); assert.match(w.textContent, /未写完的消息/);
  assert.equal($$('.cancelled-tag', w).length, 1);
  assert.ok(!w.textContent.includes('模型未返回可见答复'));
  ui.onToolEvent(c, { status: 'running', stream: 'stdout', delta: 'late result' }); await frame();
  assert.ok(!w.textContent.includes('late result'));
});

check('fallback tool call IDs are stable across all partial accumulator snapshots', () => {
  const a = createToolCallAccumulator(); a.push({ index: 4, name: 'write_file', argsText: '{"path":' });
  const id = a.result()[0].id; assert.equal(a.result()[0].id, id);
  a.push({ index: 4, argsText: '"site/a.html","content":"ok"}' });
  assert.equal(a.result()[0].id, id); assert.deepEqual(a.indices(), [4]);
});

check('live stdout/stderr buffers are bounded independently', () => {
  const c = {}; appendToolStream(c, { stream: 'stdout', delta: 'x'.repeat(100000) }); appendToolStream(c, { stream: 'stderr', delta: 'err' });
  assert.equal(c.liveOutput.stdout.length, TOOL_STREAM_MAX_CHARS); assert.equal(c.liveOutput.stderr, 'err');
});

check('local browser capability is independent of Web/Cloudflare, but gated by sandbox and actual readiness', () => {
  const v = computeCapabilityVector({ relayOk: false, webEnabled: false, localBrowserEnabled: true, sandboxEnabled: true });
  assert.equal(v.localBrowserActive, true); assert.ok(v.enabledTools.includes('browser_sandbox'));
  assert.equal(v.webFetchActive, false); assert.equal(computeCapabilityVector({ localBrowserEnabled: true, sandboxEnabled: false }).localBrowserActive, false);
  const cap = buildCapabilityConstraints({ sandboxEnabled: true, relayOk: false, webEnabled: false, overrides: { sandbox: { browser: true } } });
  const r = deriveToolWhitelist(createTurnExecutionContext({ capability: cap }), TOOL_DEFS);
  assert.ok(r.allowed.some((t) => t.name === 'browser_sandbox'));
  assert.ok(selectToolsForTurn({ allowed: r.allowed, text: '创建网页并截图调试' }).mounted.some((t) => t.name === 'browser_sandbox'));
  assert.equal(checkCapabilityConstraints({ name: 'browser_sandbox', args: { action: 'start' }, capabilities: buildCapabilityConstraints({ sandboxEnabled: true }) }).allowed, false);
});

check('project export is bounded, includes relative assets, and refuses public URLs and protected files', () => {
  const f = createFS({ 'site/index.html': '<h1>网页</h1>', 'site/app.js': 'console.log(1)', 'site/.env': 'secret', 'site/internal/private.txt': 'secret', 'outputs/unrelated.txt': 'x' });
  const p = sandboxProject(f, 'site/index.html'); assert.deepEqual(Object.keys(p.files).sort(), ['app.js', 'index.html']); assert.equal(p.entry, 'index.html');
  assert.throws(() => sandboxProject(f, 'https://example.com/index.html'));
  assert.throws(() => sandboxProject(f, 'site/index.html', 'elsewhere'));
  f.write('site/large.txt', 'x'.repeat(8 * 1024 * 1024)); assert.throws(() => sandboxProject(f, 'site/index.html'), /超过/);
});

check('local HTML delivery retains CSS/JS/import/image dependencies, not unrelated temporary artifacts', () => {
  const base = createFS(), tmp = createTempFS(base);
  tmp.write('site/index.html', '<link href="style.css"><script type="module" src="app.js"></script><img src="logo.svg">');
  tmp.write('site/style.css', 'body{background:url(bg.png)}'); tmp.write('site/app.js', 'import {x} from "./lib.js";'); tmp.write('site/lib.js', 'export const x=1');
  tmp.write('site/logo.svg', '<svg/>'); tmp.write('site/bg.png', 'data:image/png;base64,aGk='); tmp.write('tmp/debug.txt', 'do not keep');
  const r = tmp.commitAnswer('请打开 site/index.html。'); assert.equal(r.committed.length, 6); assert.deepEqual(r.discarded, ['tmp/debug.txt']);
  assert.ok(base.has('site/lib.js')); assert.ok(base.has('site/bg.png'));
  assert.ok(!websiteDependencies({ 'index.html': '<script src="https://example.com/x.js">', 'x.js': 'x' }, ['index.html']).has('x.js'));
});

check('a referenced started project also retains dynamically addressed resources in its uploaded snapshot', () => {
  const base = createFS(), tmp = createTempFS(base); tmp.write('site/index.html', '<script src="app.js"></script>'); tmp.write('site/app.js', 'fetch(variable)'); tmp.write('site/data.json', '{}'); tmp.write('tmp/other.txt', 'x');
  tmp.retainProject('site/index.html', ['site/index.html', 'site/app.js', 'site/data.json']); tmp.commitAnswer('site/index.html');
  assert.ok(base.has('site/data.json')); assert.ok(!base.has('tmp/other.txt'));
});

check('browser request rejects public URL input before making any request', async () => {
  const saved = globalThis.fetch; let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('unexpected'); };
  try { await assert.rejects(sandboxBrowserRequest({ action: 'screenshot', url: 'https://example.com' }), /公网 URL/); assert.equal(calls, 0); }
  finally { globalThis.fetch = saved; }
});

check('health and streamed browser RPC use only same-origin local endpoints and genuine PNG frames', async () => {
  const saved = globalThis.fetch, seen = [], events = [];
  globalThis.fetch = async (url, opts = {}) => {
    seen.push(String(url));
    if (String(url).endsWith('/health')) return new Response(JSON.stringify({ ok: true, local: true, kind: 'sandbox-project-browser', engine: 'chromium' }), { headers: { 'content-type': 'application/json' } });
    return new Response('{"type":"event","payload":{"stream":"stdout","delta":"ready\\n"}}\n{"type":"result","result":{"ok":true,"image":"data:image/png;base64,iVBORw0KGgo="}}\n', { headers: { 'content-type': 'application/x-ndjson' } });
  };
  try { resetLocalBrowserProbe(); assert.equal(await probeLocalBrowser(), true); await sandboxBrowserRequest({ action: 'screenshot', preview_id: 'abc' }, { onEvent: (e) => events.push(e) }); assert.equal(events.length, 1); assert.deepEqual(seen, ['/api/sandbox-web/health', '/api/sandbox-web/command']); }
  finally { resetLocalBrowserProbe(); globalThis.fetch = saved; }
});

check('actual read_file emits all chunks, cancels safely, and does not manufacture completion', async () => {
  const f = createFS({ 'a.txt': '行\n'.repeat(15000) }), chunks = [];
  const out = await executeTool('read_file', { path: 'a.txt' }, { fs: f, onUi: (p) => { if (p.stream) chunks.push(p.delta); } });
  assert.ok(chunks.length > 1); assert.equal(chunks.join(''), f.read('a.txt')); assert.match(out, /── a.txt ──/);
  const abort = new AbortController(), statuses = [];
  await executeTool('read_file', { path: 'a.txt' }, { fs: f, signal: abort.signal, onUi: (p) => { statuses.push(p.status); if (p.stream) abort.abort(); } });
  assert.ok(!statuses.includes('ok'));
});

check('JS Worker intermediate log messages do not resolve execution early', async () => {
  const saved = globalThis.Worker; let finished = false, sawBeforeFinish = false;
  class Worker {
    constructor() { queueMicrotask(() => this.onmessage({ data: { __dubheReady: 'js-runtime-2' } })); } terminate() {}
    postMessage(p) { queueMicrotask(() => this.onmessage({ data: { __log: { level: 'log', text: 'before await' } } })); setTimeout(() => { finished = true; this.onmessage({ data: { ok: true, result: 42, logs: [], files: p.files } }); }, 15); }
  }
  globalThis.Worker = Worker;
  try { const out = await runJavaScript('return 42', createFS(), { onOutput: () => { sawBeforeFinish = !finished; } }); assert.equal(out.result, 42); assert.ok(sawBeforeFinish); }
  finally { globalThis.Worker = saved; }
});

check('JS Worker abort terminates execution and rejects late filesystem changes', async () => {
  const saved = globalThis.Worker, abort = new AbortController(); let terminated = false;
  class Worker { constructor() { queueMicrotask(() => this.onmessage({ data: { __dubheReady: 'js-runtime-2' } })); setTimeout(() => this.onmessage({ data: { ok: true, logs: [], files: { 'late.txt': 'bad' } } }), 20); } terminate() { terminated = true; } postMessage() {} }
  globalThis.Worker = Worker;
  try { const f = createFS(), pending = runJavaScript('return 1', f, { signal: abort.signal }); abort.abort(); const out = await pending; assert.equal(out.aborted, true); assert.ok(terminated); await frame(); assert.ok(!f.has('late.txt')); }
  finally { globalThis.Worker = saved; }
});

check('real Agent stream emits partial tool hooks and persists file→text→file order without early writes', async () => {
  const saved = globalThis.fetch, state = createStore(), hooks = [], captured = []; let request = 0;
  state.state.apiKey = 'sk-test'; state.state.model = 'gpt-5.6-sol'; state.state.settings.webEnabled = false; state.state.settings.jevEnabled = false; state.state.settings.thinking = false; state.state.relayOk = false;
  const encoder = new TextEncoder(); let runner;
  const sse = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }] })}\n\n`;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/sandbox-web/health')) return new Response('{}', { status: 404 });
    request++;
    if (request !== 1) return new Response(sse({ content: '交付 site/index.html' }, 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    const events = [
      sse({ tool_calls: [{ index: 0, id: 'stream-write-html', function: { name: 'write_file', arguments: '{"path":"site/index.html","content":"<link href=\\"style.css\\">' } }] }),
      sse({ tool_calls: [{ index: 0, function: { arguments: '完成"}' } }] }),
      sse({ content: '再补样式。' }),
      sse({ tool_calls: [{ index: 1, id: 'stream-write-css', function: { name: 'write_file', arguments: '{"path":"site/style.css","content":"body{' } }] }),
      sse({ tool_calls: [{ index: 1, function: { arguments: 'color:blue}"}' } }] }),
      sse({}, 'tool_calls') + 'data: [DONE]\n\n',
    ];
    return new Response(new ReadableStream({ start(controller) { let at = 0; const emit = () => { controller.enqueue(encoder.encode(events[at++])); if (at < events.length) setTimeout(emit, 12); else controller.close(); }; emit(); } }), { headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    resetLocalBrowserProbe(); runner = createAgent(state, { onToolDelta(m) { hooks.push(m.toolCalls.length); if (m.toolCalls.some((c) => c.args?.__raw)) captured.push(!runner.fs.has('site/index.html')); } });
    await runner.send('生成一个本地网页'); assert.ok(hooks.length >= 4); assert.ok(captured.every(Boolean));
    const m = state.state.messages.find((x) => x.toolCalls?.length === 2); assert.ok(m);
    assert.deepEqual(displayParts(m).map((x) => x.kind), ['edited', 'text', 'edited']);
    assert.ok(runner.fs.has('site/index.html')); assert.ok(runner.fs.has('site/style.css'), 'entry-only delivery retains its CSS');
  } finally { resetLocalBrowserProbe(); globalThis.fetch = saved; }
});

check('malformed imported timeline metadata safely falls back instead of breaking the message UI', () => {
  assert.deepEqual(displayParts({ text: '保留正文', toolCalls: [], outputOrder: [{ kind: 'tools' }] }).map((p) => p.text), ['保留正文']);
});
check('manual call/group state does not leak to another turn that reuses a provider call ID', () => {
  reset(); const a = call(); const m = assistant([a], '前置正文'); result(a); done(m);
  click($('.ran-commands', wrap(m))); click($('.tool-call-chip', wrap(m)));
  store.pushMessage({ role: 'user', text: '下一轮' }); const b = { ...a }; const n = assistant([b], '新正文'); result(b); done(n);
  assert.ok(!$('.ran-commands', wrap(n)).classList.contains('expanded'));
  assert.ok(!$('.tool-call-chip', wrap(n)).classList.contains('expanded'));
});

check('real Agent cancellation keeps unfinished text on the last current-turn assistant', async () => {
  const saved = globalThis.fetch, st = createStore(); let runner, stops = 0;
  Object.assign(st.state, { apiKey: 'sk-cancel-test', model: 'gpt-5.6-sol', relayOk: false });
  Object.assign(st.state.settings, { webEnabled: false, jevEnabled: false, thinking: false });
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes('/api/sandbox-web/health')) return new Response('{}', { status: 404 });
    return new Response(new ReadableStream({ start(controller) {
      opts.signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"未写完"}}]}\n\n'));
    } }), { headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    resetLocalBrowserProbe(); runner = createAgent(st, { onDelta() { runner.abort(); }, onCancelled() { stops++; } });
    await runner.send('输出然后停止'); const last = st.state.messages.findLast((m) => m.role === 'assistant');
    assert.equal(last.text, '未写完'); assert.equal(last.cancelled, true); assert.equal(last.done, true); assert.equal(stops, 1);
  } finally { resetLocalBrowserProbe(); globalThis.fetch = saved; }
});
check('local readiness probing is busy/cancellable and never sends a model request after stop', async () => {
  const saved = globalThis.fetch, st = createStore(); let runner, modelCalls = 0, stops = 0;
  Object.assign(st.state, { apiKey: 'sk-probe-cancel-test', model: 'gpt-5.6-sol', relayOk: false });
  Object.assign(st.state.settings, { webEnabled: false, jevEnabled: false, thinking: false });
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes('/api/sandbox-web/health')) return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    modelCalls++; throw new Error('model must not run');
  };
  try {
    resetLocalBrowserProbe(); runner = createAgent(st, { onStatus(s) { if (s === 'connecting') queueMicrotask(() => runner.abort()); }, onCancelled() { stops++; } });
    await runner.send('停止健康检查'); assert.equal(runner.getStatus(), 'cancelled'); assert.equal(modelCalls, 0); assert.equal(stops, 1);
  } finally { resetLocalBrowserProbe(); globalThis.fetch = saved; }
});

check('full Edit preview retains its first line and every long line without HTML execution', () => {
  reset(); const long = '<img src=x onerror=alert(1)>' + 'long-'.repeat(1200);
  const content = ['FIRST-LINE', ...Array.from({ length: 45 }, (_, i) => `line-${i + 1}`), long, 'LAST-LINE'].join('\n');
  const m = assistant([call('write_file', { path: 'site/full.html', content })]);
  const rows = $$('.ep-line .ep-tx:not(.ep-empty)', wrap(m));
  assert.equal(rows.length, 48); assert.equal(rows[0].textContent, 'FIRST-LINE');
  assert.equal(rows.at(-2).textContent, long); assert.equal(rows.at(-1).textContent, 'LAST-LINE');
  assert.equal($('.ep-no', wrap(m)).textContent, '1'); assert.equal($('.ep-body img', wrap(m)), null);
  assert.ok(!wrap(m).textContent.includes('仅显示尾部'));
});

check('Edit filename/list/header/code nodes are stable across deltas, including a trailing throttled delta', async () => {
  reset(); const c = call('write_file', { __raw: '{"path":"site/stable.html","content":"first\\nsecond' }); const m = assistant([c]);
  const fold = $('.edited-files', wrap(m)), path = $('.edit-path', fold), head = $('.ep-head', fold), previewPath = $('.ep-path', fold);
  const firstLine = $('.ep-line .ep-tx:not(.ep-empty)', fold);
  c.args.__raw += '\\nthird'; ui.onToolDelta(m); await until(() => $('.ep-body', fold).textContent.includes('third'));
  assert.equal($('.edited-files', wrap(m)), fold); assert.equal($('.edit-path', fold), path);
  assert.equal($('.ep-head', fold), head); assert.equal($('.ep-path', fold), previewPath);
  assert.equal($('.ep-line .ep-tx:not(.ep-empty)', fold), firstLine);
  c.args.__raw += '\\nFOURTH'; ui.onToolDelta(m);
  await until(() => $('.ep-body', fold).textContent.includes('FOURTH'));
  assert.equal($('.edit-path', fold), path); assert.equal($('.ep-path', fold).textContent, 'site/stable.html');
  assert.ok(!agent.fs.has('site/stable.html'));
});

check('a filename split across parameter deltas changes text without restarting its DOM row', async () => {
  reset(); const c = call('write_file', { __raw: '{"path":"site/par' }); const m = assistant([c]);
  const path = $('.edit-path', wrap(m)); assert.equal(path.textContent, 'site/par');
  c.args.__raw += 'tial.html","content":"hello'; ui.onToolDelta(m); await frame();
  assert.equal($('.edit-path', wrap(m)), path); assert.equal(path.textContent, 'site/partial.html');
});

check('a successful write folds immediately with preceding body text, even while its message is still live', async () => {
  reset(); const c = call('write_file', { path: 'site/done.html', content: 'complete' }); const m = assistant([c], '先写文件。');
  const fold = $('.edited-files', wrap(m)); assert.ok(fold.classList.contains('expanded'));
  assert.equal($('.edit-preview', fold).dataset.status, 'ready', 'parameter completion is not disk success');
  agent.fs.write('site/done.html', c.args.content); ui.onToolEvent(c, { status: 'ok', settled: true, finalOutput: '已写入 site/done.html' });
  await until(() => !fold.classList.contains('expanded'));
  assert.equal(m.done, false); assert.equal(status, 'streaming');
  assert.equal($('.chip-name', fold).textContent, 'Edited file');
  assert.match($('.ep-meta', fold).textContent, /来自已落盘文件/);
});

check('later text folds an older completed Edit, but pure-tool turns and manual choices stay open', async () => {
  reset(); const c = call('write_file', { path: 'site/pure.html', content: 'pure' }), m = assistant([c]);
  result(c, '已写入 site/pure.html'); done(m); const fold = $('.edited-files', wrap(m)); assert.ok(fold.classList.contains('expanded'));
  const text = assistant([], '写入结果说明。'); ui.onDelta(text); await frame(); assert.ok(!fold.classList.contains('expanded'));
  click(fold); assert.ok(fold.classList.contains('expanded')); ui.onDelta(text); await frame(); ui.rebuildMessages();
  assert.ok($('.edited-files', wrap(m)).classList.contains('expanded'));
  store.pushMessage({ role: 'user', text: '新一轮纯工具' }); const next = call('write_file', { path: 'site/new.html', content: 'new' }), n = assistant([next]);
  result(next, '已写入 site/new.html'); done(n); assert.ok($('.edited-files', wrap(n)).classList.contains('expanded'));
});

check('manual collapse and code selection/scrolling are not overridden by ongoing writing', async () => {
  reset(); const c = call('write_file', { __raw: '{"path":"site/select.txt","content":"one' }), m = assistant([c]);
  const fold = $('.edited-files', wrap(m)); click($('.ep-body', fold)); assert.ok(fold.classList.contains('expanded'), 'code interaction is not a header toggle');
  click(fold); assert.ok(!fold.classList.contains('expanded'));
  c.args.__raw += '\\ntwo'; ui.onToolDelta(m); await frame(); assert.ok(!fold.classList.contains('expanded'));
  ui.rebuildMessages(); assert.ok(!$('.edited-files', wrap(m)).classList.contains('expanded'));
});

check('append/replace preview the whole candidate file without any early filesystem mutation', () => {
  const st = createStore(); st.state.files = { 'base.txt': 'HEADER\nold text\nFOOTER\n' }; const a = createAgent(st, {});
  const append = call('write_file', { __raw: '{"path":"base.txt","mode":"append","content":"added' });
  const p = a.getEditPreview([append], { preferDisk: false });
  assert.equal(p.content, 'HEADER\nold text\nFOOTER\nadded'); assert.equal(p.provisional, true);
  assert.equal(a.fs.read('base.txt'), 'HEADER\nold text\nFOOTER\n');
  const replace = call('write_file', { __raw: '{"path":"base.txt","mode":"replace","old_text":"old text","new_text":"new text' });
  assert.equal(a.getEditPreview([replace], { preferDisk: false }).content, 'HEADER\nnew text\nFOOTER\n');
  assert.equal(a.fs.read('base.txt'), 'HEADER\nold text\nFOOTER\n');
  a.fs.write('base.txt', ''); replace.status = 'ok';
  assert.equal(a.getEditPreview([replace]).content, '', 'an actually written empty file wins over the proposed snippet');
  assert.equal(a.getEditPreview([replace]).fromDisk, true);
});

check('presentation projections preserve text barriers and leave protocol data untouched', () => {
  const m = { text: '前置说明中间说明末尾说明', toolCalls: [call(), call(), call()], outputOrder: [
    { kind: 'text', start: 0, end: 4 }, { kind: 'tools', indices: [0] }, { kind: 'text', start: 4, end: 8 },
    { kind: 'tools', indices: [1, 2] }, { kind: 'text', start: 8, end: 12 },
  ] };
  const original = JSON.stringify(m), p = projectToolPrefix(m, 1);
  assert.deepEqual(displayParts(p).map((part) => part.kind), ['text', 'commands', 'text']);
  assert.equal(p.text, '前置说明中间说明'); assert.equal(p.toolCalls.length, 1);
  assert.equal(JSON.stringify(m), original); assert.equal(p._presentationPending, true);
});

check('queue ignores provisional success/retries and advances only one completed call per tick', () => {
  const calls = [call(), call(), call()]; calls.forEach((c) => { c.status = 'running'; c.settled = false; });
  const m = { id: 'queue-pure', toolCalls: calls, text: '' }, timers = new Map(); let timerSeq = 0, q;
  q = createToolPresentation({ readMessage: () => m,
    schedule(fn) { const id = ++timerSeq; timers.set(id, fn); return id; }, cancel(id) { timers.delete(id); },
    onAdvance() { q.project(m); },
  });
  q.watch(m); calls[1].status = calls[2].status = 'ok'; calls[1].settled = calls[2].settled = true;
  calls[0].status = 'ok'; assert.equal(q.project(m).toolCalls.length, 1); assert.equal(timers.size, 0);
  calls[0].settled = true; q.project(m); assert.equal(timers.size, 1);
  const next = () => { const [id, fn] = timers.entries().next().value; timers.delete(id); fn(); };
  next(); assert.equal(q.project(m).toolCalls.length, 2); assert.equal(timers.size, 1);
  next(); assert.equal(q.project(m).toolCalls.length, 3); assert.equal(timers.size, 0);
  q.clear();
});

check('parallel later stdout/stderr/media are buffered until their launch-order slot becomes visible', async () => {
  reset(); const calls = [call(), call(), call()]; const m = assistant(calls);
  const first = $('.tool-call-chip', wrap(m)), command = $('[data-win="command"] pre', first);
  assert.equal($$('.tool-call-chip', wrap(m)).length, 1);
  ui.onToolEvent(calls[2], { status: 'running', stream: 'stderr', delta: 'THIRD-WARNING', image: 'data:image/png;base64,aGk=' });
  ui.onToolEvent(calls[1], { status: 'running', stream: 'stdout', delta: 'SECOND-LIVE' }); await frame();
  assert.ok(!wrap(m).textContent.includes('SECOND-LIVE')); assert.ok(!wrap(m).textContent.includes('THIRD-WARNING'));
  assert.equal(calls[2].image, 'data:image/png;base64,aGk=');
  ui.onToolEvent(calls[2], { status: 'ok', settled: true, finalOutput: 'THIRD-FINAL' });
  ui.onToolEvent(calls[1], { status: 'ok', settled: true, finalOutput: 'SECOND-FINAL' }); await frame();
  assert.equal($$('.tool-call-chip', wrap(m)).length, 1);
  ui.onToolEvent(calls[0], { status: 'ok', settled: true, finalOutput: 'FIRST-FINAL' });
  await until(() => $$('.tool-call-chip', wrap(m)).length === 2);
  assert.match(wrap(m).textContent, /SECOND-FINAL/); assert.ok(!wrap(m).textContent.includes('THIRD-FINAL'));
  assert.equal($('.tool-call-chip', wrap(m)), first); assert.equal($('[data-win="command"] pre', first), command);
  await until(() => $$('.tool-call-chip', wrap(m)).length === 3); assert.match(wrap(m).textContent, /THIRD-FINAL/);
  assert.deepEqual($$('.tool-call-chip', wrap(m)).map((node) => node.dataset.callId), calls.map((c) => c.id));
});

check('completed backlogs remain sequential after engine completion and do not let the final answer jump ahead', async () => {
  reset(); const calls = [call(), call(), call()], m = assistant(calls);
  calls.forEach((c, i) => result(c, `BUFFERED-${i}`)); done(m); status = 'done';
  const reply = assistant([], 'FINAL-ANSWER-NOT-EARLY', { done: true });
  assert.equal($$('.tool-call-chip', wrap(m)).length, 1); assert.equal(wrap(reply), null);
  await until(() => $$('.tool-call-chip', wrap(m)).length === 2); assert.equal(wrap(reply), null);
  await until(() => $$('.tool-call-chip', wrap(m)).length === 3); assert.ok(wrap(reply));
  assert.ok(before(wrap(m), wrap(reply))); assert.equal(store.state.messages.filter((x) => x.role === 'tool').length, 3);
});

check('read/write tasks hide later filenames and previews, not just their command widgets', async () => {
  reset(); const calls = [call('write_file', { path: 'site/ONE.txt', content: 'ONE' }), call('write_file', { path: 'site/TWO.txt', content: 'TWO' }), call('read_file', { path: 'site/THREE.txt' })];
  const m = assistant(calls); assert.ok(wrap(m).textContent.includes('site/ONE.txt'));
  assert.ok(!wrap(m).textContent.includes('site/TWO.txt')); assert.ok(!wrap(m).textContent.includes('site/THREE.txt'));
  calls.slice(1).forEach((c) => { ui.onToolEvent(c, { status: 'ok', settled: true, finalOutput: 'DONE ' + c.args.path }); });
  ui.onToolEvent(calls[0], { status: 'ok', settled: true, finalOutput: 'DONE site/ONE.txt' });
  await until(() => wrap(m).textContent.includes('site/TWO.txt')); assert.ok(!wrap(m).textContent.includes('site/THREE.txt'));
  await until(() => wrap(m).textContent.includes('site/THREE.txt'));
  assert.deepEqual($$('.assistant-fragment', wrap(m)).map((n) => n.dataset.family), ['edited', 'explored']);
});

check('rebuilding a running queue does not bulk-load completed hidden calls or erase real buffered output', async () => {
  reset(); const calls = [call(), call(), call()], m = assistant(calls);
  ui.onToolEvent(calls[2], { status: 'ok', settled: true, finalOutput: 'KEEP-HIDDEN-THIRD' });
  ui.rebuildMessages(); assert.equal($$('.tool-call-chip', wrap(m)).length, 1); assert.ok(!wrap(m).textContent.includes('KEEP-HIDDEN-THIRD'));
  result(calls[0]); await until(() => $$('.tool-call-chip', wrap(m)).length === 2);
  ui.rebuildMessages(); assert.equal($$('.tool-call-chip', wrap(m)).length, 2);
  result(calls[1]); await until(() => $$('.tool-call-chip', wrap(m)).length === 3); assert.match(wrap(m).textContent, /KEEP-HIDDEN-THIRD/);
});

check('stop freezes queued reveals, puts its marker after visible unfinished output, and rejects late events', async () => {
  reset(); const calls = [call(), call(), call()], m = assistant(calls);
  result(calls[0], 'VISIBLE-FIRST'); result(calls[1], 'HIDDEN-SECOND'); result(calls[2], 'HIDDEN-THIRD');
  store.updateMessage(m.id, { cancelled: true, done: true }); status = 'cancelled'; ui.onCancelled();
  await new Promise((r) => setTimeout(r, 250));
  assert.equal($$('.tool-call-chip', wrap(m)).length, 1); const marker = $('.cancelled-tag', wrap(m)); assert.ok(marker);
  assert.ok(before($('.tool-call-chip', wrap(m)), marker)); assert.ok(!wrap(m).textContent.includes('HIDDEN-THIRD'));
  ui.onToolEvent(calls[1], { status: 'running', stream: 'stdout', delta: 'LATE-OUTPUT' }); await frame(); assert.ok(!wrap(m).textContent.includes('LATE-OUTPUT'));
});

check('new turns reusing call IDs cannot inherit old settlement/results or update an older widget', async () => {
  reset(); const a = call(), old = assistant([a]); result(a, 'OLD-RESULT-NO-LEAK'); done(old);
  const oldWidget = $('.tool-call-chip', wrap(old));
  store.pushMessage({ role: 'user', text: '新轮重用上游 ID' });
  const first = { id: a.id, name: a.name, args: { code: 'NEW-CODE' } }, second = call(), m = assistant([first, second]);
  ui.onToolEvent(second, { status: 'ok', settled: true, finalOutput: 'NEW-SECOND' });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal($$('.tool-call-chip', wrap(m)).length, 1); assert.ok(!wrap(m).textContent.includes('OLD-RESULT-NO-LEAK'));
  ui.onToolEvent(first, { status: 'running', stream: 'stdout', delta: 'NEW-LIVE' }); await frame();
  assert.match(wrap(m).textContent, /NEW-LIVE/); assert.ok(!oldWidget.textContent.includes('NEW-LIVE'));
  result(first, 'NEW-FIRST'); await until(() => $$('.tool-call-chip', wrap(m)).length === 2);
  assert.match(wrap(m).textContent, /NEW-FIRST/); assert.match(oldWidget.textContent, /OLD-RESULT-NO-LEAK/);
  ui.rebuildMessages(); assert.match(wrap(old).textContent, /OLD-RESULT-NO-LEAK/); assert.ok(!wrap(old).textContent.includes('NEW-FIRST'));
});

check('session/reset invalidates pending reveal timers instead of appending stale messages', async () => {
  reset(); const calls = [call(), call()], m = assistant(calls); calls.forEach((c) => result(c));
  const oldId = m.id; store.state.messages = []; ui.rebuildMessages(); status = 'streaming';
  store.pushMessage({ role: 'user', text: '新的会话内容' }); const next = assistant([call()], 'ONLY-NEW');
  await new Promise((r) => setTimeout(r, 200)); assert.equal($(`#messages .msg[data-id="${oldId}"]`), null);
  assert.ok(wrap(next)); assert.equal($$('.tool-call-chip').length, 1);
});

check('cloned append/replace calls retain their own baseline and never read a later hidden write', () => {
  const st = createStore(); st.state.files = { 'clone.txt': 'HEAD\nold\nTAIL\n' }; const a = createAgent(st, {});
  const append = call('write_file', { __raw: '{"path":"clone.txt","mode":"append","content":"APP' });
  assert.equal(a.getEditPreview([append]).content, 'HEAD\nold\nTAIL\nAPP');
  const copy = JSON.parse(JSON.stringify(append)); copy.args.__raw += 'END';
  a.fs.write('clone.txt', 'LATER-HIDDEN-CONTENT');
  assert.equal(a.getEditPreview([copy]).content, 'HEAD\nold\nTAIL\nAPPEND');
  assert.equal(a.fs.read('clone.txt'), 'LATER-HIDDEN-CONTENT');
  const fresh = { id: append.id, name: 'write_file', args: { path: 'clone.txt', mode: 'append', content: 'NEW-TURN' } };
  assert.equal(a.getEditPreview([fresh]).content, 'LATER-HIDDEN-CONTENTNEW-TURN', 'reused provider ID must not reuse another call baseline');
});

check('full replacement preview follows write_file $ substitution, new_text precedence and overwrite defaults', async () => {
  const st = createStore(); st.state.files = { 'dollar.txt': 'prefix old suffix' }; const a = createAgent(st, {});
  const replacement = "$`[$&]$$$'";
  const c = call('write_file', { path: 'dollar.txt', mode: 'replace', old_text: 'old', content: 'NOT-USED', new_text: replacement });
  const expected = 'prefix old suffix'.replace('old', replacement);
  assert.equal(a.getEditPreview([c], { preferDisk: false }).content, expected);
  const raw = call('write_file', { __raw: JSON.stringify(c.args).slice(0, -2) });
  assert.equal(a.getEditPreview([raw], { preferDisk: false }).content, expected);
  assert.equal(a.fs.read('dollar.txt'), 'prefix old suffix');
  await executeTool('write_file', c.args, { fs: a.fs });
  assert.equal(a.fs.read('dollar.txt'), expected);
  const overwrite = call('write_file', { path: 'default.txt', old_text: 'old', new_text: 'IGNORED', content: 'ACTUAL-DEFAULT' });
  const p = a.getEditPreview([overwrite], { preferDisk: false });
  assert.equal(p.mode, 'overwrite'); assert.equal(p.content, 'ACTUAL-DEFAULT');
  await executeTool('write_file', overwrite.args, { fs: a.fs }); assert.equal(a.fs.read('default.txt'), p.content);
});

check('terminal failure cancels reveal timers, preserves the error and never settles unfinished calls', () => {
  const calls = [call(), call(), call()]; calls.forEach((c) => { c.status = 'ok'; c.settled = true; });
  const m = { id: 'queue-terminal-error', toolCalls: calls, text: '' }, timers = new Map(); let q, nextId = 0, paints = 0;
  q = createToolPresentation({ readMessage: () => m, schedule(fn) { const id = ++nextId; timers.set(id, fn); return id; },
    cancel(id) { timers.delete(id); }, onAdvance() { paints++; } });
  q.watch(m); q.project(m); assert.equal(timers.size, 1);
  const late = timers.values().next().value;
  calls[0].status = 'running'; calls[0].settled = false; m.error = 'HTTP 503: streaming failed';
  const p = q.project(m); assert.equal(p.error, m.error); assert.equal(p.toolCalls.length, 1); assert.equal(timers.size, 0);
  late(); assert.equal(paints, 0); assert.equal(q.project(m).toolCalls.length, 1); assert.equal(calls[0].settled, false);
  const error = { id: 'error-notice', role: 'assistant', error: 'fatal transport error', done: true };
  const messages = [{ role: 'user' }, { ...m, role: 'assistant' }, error];
  assert.equal(q.deferred(error, messages), false, 'an error notice cannot wait behind unfinished work');
  assert.equal(q.deferred({ ...error, error: null }, messages), true, 'ordinary future replies are still buffered');
  q.clear();
});

check('a streamed Edit error stays visible at the frontier, removes the caret and ignores late output', async () => {
  reset(); const first = call('write_file', { __raw: '{"path":"site/unfinished.txt","content":"UNFINISHED' });
  const later = call('write_file', { path: 'site/HIDDEN-ERROR-TASK.txt', content: 'HIDDEN-CONTENT' }), m = assistant([first, later]);
  const fold = $('.edited-files', wrap(m)), path = $('.edit-path', fold); assert.ok($('.ep-caret', fold));
  status = 'error'; store.updateMessage(m.id, { error: 'HTTP 503: TERMINAL-EDIT-ERROR', done: true }); ui.onAssistantDone(m);
  assert.match($('.err-box', wrap(m)).textContent, /TERMINAL-EDIT-ERROR/);
  assert.equal($('.edited-files', wrap(m)), fold); assert.equal($('.edit-path', fold), path);
  assert.equal($('.ep-caret', fold), null); assert.equal($('.ep-state', fold).textContent, '未完成');
  assert.ok(fold.classList.contains('expanded'), 'error metadata is not assistant body text');
  ui.onToolEvent(later, { status: 'ok', settled: true, finalOutput: 'LATE-MUST-STAY-HIDDEN' });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!wrap(m).textContent.includes('HIDDEN-ERROR-TASK')); assert.ok(!wrap(m).textContent.includes('LATE-MUST-STAY-HIDDEN'));
  assert.notEqual(first.settled, true); assert.equal(agent.fs.has('site/unfinished.txt'), false);
});

check('a fresh terminal error message renders without onAssistantStart while the older task queue remains frozen', async () => {
  reset(); const first = call('write_file', { __raw: '{"path":"site/interrupted.txt","content":"FIRST' });
  const m = assistant([first, call('read_file', { path: 'HIDDEN-READ.txt' })]); const fold = $('.edited-files', wrap(m));
  const error = store.pushMessage({ role: 'assistant', error: 'FATAL-NEW-ERROR-NOTICE', text: '', done: true, model: 'gpt-5.6-sol' });
  status = 'error'; ui.onAssistantDone(error); // main.js uses this exact terminal route
  assert.ok(wrap(error)); assert.match($('.err-box', wrap(error)).textContent, /FATAL-NEW-ERROR-NOTICE/);
  assert.ok(before(wrap(m), wrap(error))); assert.equal($('.ep-caret', fold), null); assert.equal($('.ep-state', fold).textContent, '未完成');
  await new Promise((r) => setTimeout(r, 200)); assert.ok(!document.querySelector('#messages').textContent.includes('HIDDEN-READ.txt'));
  assert.notEqual(first.settled, true);
});

check('the actual Agent snapshots each same-path write before the later hidden writes, including JSON-cloned previews', async () => {
  const saved = globalThis.fetch, st = createStore(); st.clearAllSessions(); let requests = 0; const snapshots = [], seenAtSdk = [];
  Object.assign(st.state, { apiKey: 'sk-snapshot-test', model: 'gpt-5.6-sol', relayOk: false, files: { 'same.txt': 'BASE-BEFORE-STREAM' } });
  Object.assign(st.state.settings, { webEnabled: false, jevEnabled: false, thinking: false });
  const first = 'FIRST\nold\nTAIL\n', second = first + 'SECOND\n', replacement = "$`[$&]$$$'", third = second.replace('old', replacement);
  const args = [{ path: 'same.txt', content: first }, { path: 'same.txt', mode: 'append', content: 'SECOND\n' },
    { path: 'same.txt', mode: 'replace', old_text: 'old', new_text: replacement }];
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/sandbox-web/health')) return new Response('{}', { status: 404 });
    const delta = requests++ === 0 ? { tool_calls: args.map((a, index) => ({ index, id: `snapshot-agent-${index}`, function: { name: 'write_file', arguments: JSON.stringify(a) } })) }
      : { content: '已完成 same.txt 的三个修改。' };
    return new Response('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    resetLocalBrowserProbe(); const runner = createAgent(st, {
      onToolEvent(c, patch) {
        if (patch.status === 'ok' && patch.editedPath) seenAtSdk.push(c.editPreviewSnapshot?.content);
        if (patch.settled) snapshots.push(JSON.parse(JSON.stringify(c)));
      },
    });
    await runner.send('依次写入 same.txt、追加，再局部替换，最终保留 same.txt');
    assert.deepEqual(seenAtSdk, [first, second, third]); assert.equal(snapshots.length, 3);
    assert.deepEqual(snapshots.map((c) => c.editPreviewSnapshot.content), [first, second, third]);
    assert.deepEqual(snapshots.map((c) => runner.getEditPreview([c]).content), [first, second, third]);
    assert.equal(snapshots[1].editPreviewBase.content, first, 'append baseline is the actual predecessor, not the pre-stream file');
    assert.equal(snapshots[2].editPreviewBase.content, second); assert.equal(runner.fs.read('same.txt'), third);
    assert.ok(snapshots.every((c) => runner.getEditPreview([c]).fromDisk));
    runner.fs.write('same.txt', 'EVEN-LATER-MUTATION');
    assert.equal(runner.getEditPreview([snapshots[0]]).content, first, 'a repaint cannot read a later task\'s file');
    const owner = st.state.messages.find((m) => m.role === 'assistant' && m.toolCalls?.length);
    const clonedOwner = JSON.parse(JSON.stringify(owner));
    assert.deepEqual(clonedOwner.toolCalls.map((c) => runner.getEditPreview([c]).content), [first, second, third]);
  } finally { resetLocalBrowserProbe(); globalThis.fetch = saved; }
});

check('a single unfinished task also buffers the next assistant message until real settlement', async () => {
  reset(); const c = call(), m = assistant([c]); ui.onToolEvent(c, { status: 'running', settled: false });
  const reply = assistant([], 'SINGLE-TASK-REPLY-NOT-EARLY', { done: true }); assert.equal(wrap(reply), null);
  ui.onToolEvent(c, { status: 'ok', settled: false, note: 'SDK success, kernel still checking' }); await frame();
  assert.equal(wrap(reply), null, 'a provisional result is not enough to release the next message');
  ui.onToolEvent(c, { status: 'ok', settled: true, finalOutput: 'SINGLE-TASK-FINISHED' });
  await until(() => !!wrap(reply)); assert.ok(before(wrap(m), wrap(reply))); assert.match(wrap(m).textContent, /SINGLE-TASK-FINISHED/);
});

check('regeneration after stop/error resets the same-user frontier and rejects late events with reused IDs', async () => {
  for (const reason of ['cancelled', 'error']) {
    reset(); const oldCall = call(), old = assistant([oldCall, call()]);
    ui.onToolEvent(oldCall, { status: 'running', settled: false, stream: 'stdout', delta: 'OLD-RUN-OUTPUT' });
    status = reason; ui.setStatus(reason);
    if (reason === 'cancelled') { store.updateMessage(old.id, { cancelled: true, done: true }); ui.onCancelled(); }
    else { store.updateMessage(old.id, { error: 'OLD-RUN-ERROR', done: true }); ui.onAssistantDone(old); }
    const userId = store.state.messages.findLast((x) => x.role === 'user').id;
    store.dropLastAssistantTurn(); ui.rebuildMessages(); status = 'connecting'; ui.setStatus(status);
    const nextCall = { id: oldCall.id, name: oldCall.name, args: { code: 'return "NEW-RUN"' } }, second = call(), next = assistant([nextCall, second]);
    assert.equal(store.state.messages.findLast((x) => x.role === 'user').id, userId, 'regeneration keeps the user message');
    assert.equal(wrap(old), null); assert.equal($$('.tool-call-chip', wrap(next)).length, 1);
    ui.onToolEvent(nextCall, { status: 'running', settled: false, stream: 'stdout', delta: 'NEW-RUN-OUTPUT' });
    ui.onToolEvent(oldCall, { status: 'ok', settled: true, finalOutput: 'LATE-OLD-RUN-MUST-NOT-LEAK' });
    ui.onToolResult(oldCall, 'LATE-OLD-RESULT-MUST-NOT-LEAK'); await frame();
    assert.match(wrap(next).textContent, /NEW-RUN-OUTPUT/); assert.ok(!wrap(next).textContent.includes('LATE-OLD-RUN-MUST-NOT-LEAK'));
    assert.ok(!wrap(next).textContent.includes('LATE-OLD-RESULT-MUST-NOT-LEAK'));
    assert.equal(nextCall.settled, false); assert.equal($$('.tool-call-chip', wrap(next)).length, 1);
    ui.onToolEvent(second, { status: 'ok', settled: true, finalOutput: 'NEW-SECOND' });
    ui.onToolEvent(nextCall, { status: 'ok', settled: true, finalOutput: 'NEW-FIRST' });
    await until(() => $$('.tool-call-chip', wrap(next)).length === 2);
    assert.match(wrap(next).textContent, /NEW-FIRST/); assert.match(wrap(next).textContent, /NEW-SECOND/);
  }
  ui.setStatus('done');
});

check('the actual Agent starts independent reads concurrently and settles each without waiting for Promise.all', async () => {
  const saved = globalThis.fetch, st = createStore(); st.clearAllSessions(); let requests = 0; const starts = [], settles = [], counts = [];
  Object.assign(st.state, { apiKey: 'sk-queue-test', model: 'gpt-5.6-sol', relayOk: false, files: { 'large.txt': 'LARGE\n'.repeat(30000), 'small.txt': 'SMALL' } });
  Object.assign(st.state.settings, { webEnabled: false, jevEnabled: false, thinking: false });
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/sandbox-web/health')) return new Response('{}', { status: 404 });
    const delta = requests++ === 0 ? { tool_calls: [
      { index: 0, id: 'queue-agent-large', function: { name: 'read_file', arguments: '{"path":"large.txt"}' } },
      { index: 1, id: 'queue-agent-small', function: { name: 'read_file', arguments: '{"path":"small.txt"}' } },
    ] } : { content: '已读取两个文件。' };
    return new Response('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    resetLocalBrowserProbe(); const runner = createAgent(st, {
      onToolStart(c) { starts.push(c.id); },
      onToolEvent(c, patch) { if (patch.settled) { settles.push(c.id); counts.push(st.state.messages.filter((m) => m.role === 'tool').length); assert.equal(c.settled, true); assert.ok(Object.hasOwn(patch, 'finalOutput')); } },
    });
    await runner.send('读取 large.txt 和 small.txt');
    assert.deepEqual(starts, ['queue-agent-large', 'queue-agent-small']); assert.deepEqual(settles, ['queue-agent-small', 'queue-agent-large']);
    assert.deepEqual(counts, [0, 0], 'individual settlement does not wait for ordered protocol insertion');
    assert.deepEqual(st.state.messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId), starts, 'protocol pairing remains in original order');
  } finally { resetLocalBrowserProbe(); globalThis.fetch = saved; }
});

await test('2026.10.10.1 streamed tools acceptance', async (t) => {
  try { for (const [name, fn] of checks) await t.test(name, fn); }
  finally { dom.window.close(); globalThis.setInterval = nativeSetInterval; globalThis.clearInterval = nativeClearInterval; }
});
