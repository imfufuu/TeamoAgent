// 2026.10.9.4: chronology, folding, cancellation, incremental file/Worker output.
import test from 'node:test';
const checks = []; const check = (name, fn) => checks.push([name, fn]);
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { recordOutputText, recordOutputTool, displayParts, turnHasAssistantText, appendToolStream, TOOL_STREAM_MAX_CHARS } from '../js/toolflow.js?v=2026.10.9.4';
import { createToolCallAccumulator } from '../js/api.js?v=2026.10.9.4';
import { createFS, createTempFS, websiteDependencies, runJavaScript } from '../js/sandbox.js';
import { sandboxProject, sandboxBrowserRequest, probeLocalBrowser, resetLocalBrowserProbe } from '../js/localbrowser.js?v=2026.10.9.4';
import { computeCapabilityVector } from '../js/nexus.js';
import { TOOL_DEFS, executeTool } from '../js/tools.js';
import { buildCapabilityConstraints, checkCapabilityConstraints } from '../js/execution.js';
import { createTurnExecutionContext, deriveToolWhitelist, selectToolsForTurn } from '../js/executionContext.js';

const dom = new JSDOM(fs.readFileSync(new URL('../app.html', import.meta.url), 'utf8'), { url: 'http://localhost:8787', pretendToBeVisual: true });
const { window } = dom;
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

check('a single streamed message renders command→text→command as three stable fragments', () => {
  reset(); const a = call(), b = call();
  const m = assistant([a, b], '先解释，再执行'); m.outputOrder = []; m.toolOrderIndices = [0, 1];
  recordOutputTool(m, 0); recordOutputText(m, 0, m.text.length); recordOutputTool(m, 1);
  ui.onAssistantDone(m);
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
    constructor() {} terminate() {}
    postMessage(p) { queueMicrotask(() => this.onmessage({ data: { __log: { level: 'log', text: 'before await' } } })); setTimeout(() => { finished = true; this.onmessage({ data: { ok: true, result: 42, logs: [], files: p.files } }); }, 15); }
  }
  globalThis.Worker = Worker;
  try { const out = await runJavaScript('return 42', createFS(), { onOutput: () => { sawBeforeFinish = !finished; } }); assert.equal(out.result, 42); assert.ok(sawBeforeFinish); }
  finally { globalThis.Worker = saved; }
});

check('JS Worker abort terminates execution and rejects late filesystem changes', async () => {
  const saved = globalThis.Worker, abort = new AbortController(); let terminated = false;
  class Worker { constructor() {} terminate() { terminated = true; } postMessage() { setTimeout(() => this.onmessage({ data: { ok: true, logs: [], files: { 'late.txt': 'bad' } } }), 20); } }
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

await test('2026.10.9.4 streamed tools acceptance', async (t) => {
  try { for (const [name, fn] of checks) await t.test(name, fn); }
  finally { dom.window.close(); globalThis.setInterval = nativeSetInterval; globalThis.clearInterval = nativeClearInterval; }
});
