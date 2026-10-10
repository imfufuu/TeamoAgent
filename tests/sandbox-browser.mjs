// Native Chromium acceptance, opt-in locally via npm run setup:browser.
// ONLY this trusted test container disables the OS sandbox; production keeps it on.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';
import http from 'node:http';
let chromium;
try { ({ chromium } = await import('playwright')); }
catch { console.log('⏭ tests/sandbox-browser.mjs 跳过：未安装 Playwright（npm run setup:browser）'); process.exit(0); }
if (!fs.existsSync(chromium.executablePath())) { console.log('⏭ tests/sandbox-browser.mjs 跳过：未安装 Chromium（npm run setup:browser）'); process.exit(0); }
const { createFS, createTempFS } = await import('../js/sandbox.js');
const { executeTool } = await import('../js/tools.js');
const ROOT = new URL('../', import.meta.url).pathname;
const files = {
  'index.html': '<!doctype html><html><head><title>沙箱真实交互</title><link rel="stylesheet" href="style.css"></head><body><h1 id="heading">沙箱网页验收</h1><button id="add">增加</button><p id="count">0</p><input id="name" placeholder="名字"><p id="greet"></p><script type="module" src="app.js"></script></body></html>',
  'style.css': 'body{font-family:sans-serif;background:#eef3ff;color:rgb(12,55,200);padding:32px}button{padding:12px 24px;background:#14234b;color:white;border:0;border-radius:12px}h1{font-size:30px}',
  'app.js': 'import { inc } from "./lib.js"; document.querySelector("#add").onclick=()=>document.querySelector("#count").textContent=inc(+document.querySelector("#count").textContent);document.querySelector("#name").oninput=e=>document.querySelector("#greet").textContent="你好，"+e.target.value; console.log("PROJECT_BOOTED");',
  'lib.js': 'export const inc = n => n + 1;',
};

await test('local Chromium project-only acceptance', async (t) => {
  const child = spawn('python3', ['-u', '-c', `import json, signal, sys\nimport server\nserver.BROWSER_ENABLED=True\nserver.BROWSER_REMOTE_TRUSTED=False\ns=server.Server(('127.0.0.1',0),server.Handler)\ndef stop(*_):\n server.SANDBOX_BROWSER.close()\n sys.exit(0)\nsignal.signal(signal.SIGTERM,stop)\nprint(json.dumps({'port':s.server_address[1]}),flush=True)\ns.serve_forever()`], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DUBHE_BROWSER_NO_SANDBOX: '1' },
  });
  let serverLog = '', uiBrowser;
  child.stderr.on('data', (b) => { serverLog += b.toString(); });
  const lines = readline.createInterface({ input: child.stdout });
  const startup = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('local companion startup timeout: ' + serverLog)), 10000);
    lines.once('line', (line) => { clearTimeout(timer); try { resolve(JSON.parse(line)); } catch (err) { reject(err); } });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error('companion exit ' + code + ': ' + serverLog)); });
  });
  try {
    const { port } = await startup, base = `http://127.0.0.1:${port}`;
    const rpc = async (payload, opts = {}) => {
      const r = await fetch(base + (payload.action === 'start' ? '/api/sandbox-web/start' : '/api/sandbox-web/command'), { method: 'POST', headers: { 'Content-Type': 'application/json', ...opts.headers }, body: JSON.stringify(payload) });
      const text = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${text}`);
      const frames = text.trim().split('\n').map(JSON.parse), result = frames.find((x) => x.type === 'result')?.result;
      if (!result?.ok) throw new Error(result?.error || 'missing result');
      return { ...result, events: frames.filter((x) => x.type === 'event').map((x) => x.payload) };
    };
    let preview;
    await t.test('health checks actual Chromium launch, not only package/executable existence', async () => {
      const r = await fetch(base + '/api/sandbox-web/health'), info = await r.json();
      assert.equal(info.ok, true, info.error); assert.equal(info.engine, 'chromium'); assert.equal(info.kind, 'sandbox-project-browser');
    });
    await t.test('start serves the VFS snapshot and runs CSS, JS, ESM imports and Chinese UTF-8', async () => {
      preview = await rpc({ action: 'start', entry: 'index.html', files, width: 800, height: 600 });
      assert.equal(preview.title, '沙箱真实交互'); assert.match(preview.text, /沙箱网页验收/); assert.ok(preview.events.some((e) => /PROJECT_BOOTED/.test(e.delta || '')));
      assert.deepEqual(preview.errors, []);
      const r = await rpc({ action: 'evaluate', preview_id: preview.preview_id, expression: 'getComputedStyle(document.body).color' }); assert.equal(r.evaluation, 'rgb(12, 55, 200)');
    });
    await t.test('click and fill change the same persistent Chromium page', async () => {
      const click = await rpc({ action: 'click', preview_id: preview.preview_id, selector: '#add' }); assert.match(click.text, /\n1(?:\n|$)/);
      const filled = await rpc({ action: 'fill', preview_id: preview.preview_id, selector: '#name', text: '天枢' }); assert.match(filled.text, /你好，天枢/);
      const r = await rpc({ action: 'evaluate', preview_id: preview.preview_id, expression: 'document.querySelector("#count").textContent' }); assert.equal(r.evaluation, '1');
    });
    await t.test('screenshot is a real PNG from that interacted page, at the requested viewport', async () => {
      const r = await rpc({ action: 'screenshot', preview_id: preview.preview_id, width: 640, height: 480 });
      const bytes = Buffer.from(r.image.split(',')[1], 'base64'); assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.equal(bytes.readUInt32BE(16), 640); assert.equal(bytes.readUInt32BE(20), 480); assert.ok(bytes.length > 2000); assert.match(r.text, /你好，天枢/);
      if (process.env.DUBHE_BROWSER_ARTIFACTS) { fs.mkdirSync(process.env.DUBHE_BROWSER_ARTIFACTS, { recursive: true }); fs.writeFileSync(process.env.DUBHE_BROWSER_ARTIFACTS + '/native-sandbox.png', bytes); }
    });
    await t.test('element screenshots obey pixel/dimension limits; oversized evaluate results fail', async () => {
      const r = await rpc({ action: 'screenshot', preview_id: preview.preview_id, selector: '#add' }); const bytes = Buffer.from(r.image.split(',')[1], 'base64'); assert.ok(bytes.readUInt32BE(16) < 640);
      await assert.rejects(rpc({ action: 'evaluate', preview_id: preview.preview_id, expression: '"x".repeat(70000)' }), /64KB/);
      await rpc({ action: 'evaluate', preview_id: preview.preview_id, expression: 'document.body.style.minHeight="20000px"' });
      await assert.rejects(rpc({ action: 'screenshot', preview_id: preview.preview_id, full_page: true }), /过大/);
    });
    await t.test('reload syncs fresh project files into the same session', async () => {
      const changed = { ...files, 'index.html': files['index.html'].replace('沙箱网页验收', '重新加载成功') };
      const r = await rpc({ action: 'reload', preview_id: preview.preview_id, entry: 'index.html', files: changed }); assert.match(r.text, /重新加载成功/);
      assert.match(r.text, /\n0(?:\n|$)/, 'reload resets page state but preserves the session ID'); assert.equal(r.preview_id, preview.preview_id);
    });
    await t.test('public screenshot URL input is rejected without any cloud/provider fallback', async () => {
      await assert.rejects(rpc({ action: 'start', entry: 'index.html', files, url: 'https://example.com/' }), /HTTP 400/);
      await assert.rejects(rpc({ action: 'screenshot', preview_id: preview.preview_id, url: 'https://example.com/' }), /HTTP 400/);
    });
    await t.test('project scripts cannot fetch public sites, parent app APIs, file URLs or arbitrary local ports', async () => {
      for (const url of ['https://example.com/', '/api/health', 'file:///etc/passwd', 'http://127.0.0.1:1/']) {
        const r = await rpc({ action: 'evaluate', preview_id: preview.preview_id, expression: `(async()=>{try{await fetch(${JSON.stringify(url)});return "escaped"}catch{return "blocked"}})()` }); assert.equal(r.evaluation, 'blocked', url);
      }
      assert.ok(!serverLog.includes('"GET /api/health '), 'project never reached the parent API');
    });
    await t.test('opaque-origin storage and WebRTC/STUN remain inaccessible', async () => {
      const r = await rpc({ action: 'evaluate', preview_id: preview.preview_id, expression: '(()=>{let storage;try{localStorage.getItem("secret");storage="escaped"}catch{storage="blocked"}return {storage,rtc:typeof RTCPeerConnection}})()' });
      assert.deepEqual(r.evaluation, { storage: 'blocked', rtc: 'undefined' });
    });
    await t.test('second projects cannot fetch the first project or leak its console stream', async () => {
      const two = await rpc({ action: 'start', entry: 'index.html', files: { 'index.html': '<h1>SECOND_PROJECT</h1><script>setInterval(()=>console.log("OTHER_SESSION_LOG"),10)</script>' } });
      try {
        const r = await rpc({ action: 'evaluate', preview_id: two.preview_id, expression: `(async()=>{try{await fetch(${JSON.stringify(preview.preview_path)});return "escaped"}catch{return "blocked"}})()` }); assert.equal(r.evaluation, 'blocked');
        const first = await rpc({ action: 'inspect', preview_id: preview.preview_id, wait_ms: 60 }); assert.ok(first.events.every((e) => !String(e.delta).includes('OTHER_SESSION_LOG')));
      } finally { await rpc({ action: 'stop', preview_id: two.preview_id }); }
    });
    await t.test('Origin null, cross-site fetch and rebinding Host are rejected at the API boundary', async () => {
      await assert.rejects(rpc({ action: 'inspect', preview_id: preview.preview_id }, { headers: { Origin: 'null' } }), /HTTP 403/);
      await assert.rejects(rpc({ action: 'inspect', preview_id: preview.preview_id }, { headers: { Origin: 'https://evil.example' } }), /HTTP 403/);
      const r = await fetch(base + '/api/sandbox-web/health', { headers: { 'Sec-Fetch-Site': 'cross-site' } }); assert.equal(r.status, 403);
      const h = await new Promise((resolve, reject) => { const req = http.get(base + '/api/sandbox-web/health', { headers: { Host: 'evil.example' } }, (r) => { r.resume(); resolve(r.statusCode); }); req.on('error', reject); }); assert.equal(h, 403);
    });
    await t.test('Agent browser tool persists the genuine PNG and referenced project dependency bundle', async () => {
      const realFetch = globalThis.fetch, baseFS = createFS(), temp = createTempFS(baseFS);
      for (const [p, c] of Object.entries(files)) temp.write('site/' + p, c);
      globalThis.fetch = (url, opts) => realFetch(new URL(String(url), base).href, opts);
      let id;
      try {
        const ctx = { fs: temp, onUi() {} }; const start = await executeTool('browser_sandbox', { action: 'start', entry: 'site/index.html' }, ctx); id = /preview_id=([a-f0-9]{32})/.exec(start)?.[1]; assert.ok(id, start);
        const result = await executeTool('browser_sandbox', { action: 'screenshot', preview_id: id, path: 'outputs/local.png' }, ctx);
        assert.match(result, /真实 Chromium 截图已保存 outputs\/local.png/); assert.match(temp.read('outputs/local.png'), /^data:image\/png;base64,iVBORw0KGgo/);
        temp.commitAnswer('打开 site/index.html。![网页](sandbox://outputs/local.png)'); assert.ok(baseFS.has('site/lib.js')); assert.ok(baseFS.has('site/style.css')); assert.ok(baseFS.has('outputs/local.png'));
      } finally { if (id) await rpc({ action: 'stop', preview_id: id }); globalThis.fetch = realFetch; }
    });
    await t.test('HTML file viewer runs an interactive isolated preview, cannot access parent state, and stops its native session on close', async () => {
      uiBrowser = await chromium.launch({ headless: true, chromiumSandbox: false, args: ['--disable-dev-shm-usage'] });
      const context = await uiBrowser.newContext({ locale: 'zh-CN' }); await context.route('**/*', (route) => { if (new URL(route.request().url()).origin === base && !/\/js\/main\.js/.test(route.request().url())) route.continue(); else route.abort(); });
      const page = await context.newPage(); const uiErrors = []; page.on('pageerror', (e) => uiErrors.push(e.message)); page.setDefaultTimeout(10000); await page.goto(base + '/app.html');
      await page.evaluate(async ({ files }) => {
        const { createStore } = await import('./js/state.js'), { createAgent } = await import('./js/agent.js'), { mountUI } = await import('./js/ui.js');
        const st = createStore(); st.state.apiKey = 'sk-native-ui-test'; const agent = createAgent(st, {}); for (const [p, c] of Object.entries(files)) agent.fs.write('site/' + p, c);
        const ui = mountUI(st, agent); ui.renderFiles(); document.querySelector('#panel-toggle').click(); localStorage.setItem('parent-secret', 'DO_NOT_LEAK'); document.querySelector('.file-item[data-path="site/index.html"]').click();
      }, { files });
      await page.locator('#fv-run').click(); await page.locator('.fv-web iframe').waitFor({ timeout: 20000 });
      const frame = await page.locator('.fv-web iframe').elementHandle().then((h) => h.contentFrame());
      await frame.waitForFunction(() => typeof document.querySelector('#add')?.onclick === 'function');
      await frame.locator('#add').click();
      const count = await frame.locator('#count').textContent();
      if (count !== '1') {
        console.log('UI_CLICK_DIAGNOSTIC', JSON.stringify({ count, errors: uiErrors, info: await frame.evaluate(() => ({ handler: document.querySelector('#add').onclick.toString(), url: location.href, x: document.querySelector('#add').getBoundingClientRect().x, y: document.querySelector('#add').getBoundingClientRect().y })) }));
        if (process.env.DUBHE_BROWSER_ARTIFACTS) await page.screenshot({ path: process.env.DUBHE_BROWSER_ARTIFACTS + '/ui-click-debug.png' });
      }
      assert.equal(count, '1');
      const blocked = await frame.evaluate(() => { try { parent.localStorage.getItem('parent-secret'); return false; } catch { return true; } }); assert.equal(blocked, true);
      const id = /\/sandbox-web\/([a-f0-9]{32})\//.exec(await page.locator('.fv-web iframe').getAttribute('src'))[1];
      await page.locator('#fv-close').click(); await page.waitForTimeout(100); assert.equal(await page.locator('.fv-web iframe').count(), 0);
      await assert.rejects(rpc({ action: 'inspect', preview_id: id }), /不存在|已停止/);
      await context.close();
    });
    await t.test('Edit UI keeps stable filenames, streams full untruncated source, and folds at write completion in real Chromium', async () => {
      uiBrowser ||= await chromium.launch({ headless: true, chromiumSandbox: false, args: ['--disable-dev-shm-usage'] });
      const context = await uiBrowser.newContext({ locale: 'zh-CN' });
      try {
        await context.route('**/*', (route) => { if (new URL(route.request().url()).origin === base && !/\/js\/main\.js/.test(route.request().url())) route.continue(); else route.abort(); });
        const page = await context.newPage(), errors = []; page.on('pageerror', (e) => errors.push(e.message)); await page.goto(base + '/app.html');
        await page.evaluate(async () => {
          const { createStore } = await import('./js/state.js'), { createAgent } = await import('./js/agent.js'), { mountUI } = await import('./js/ui.js');
          const st = createStore(); st.clearAllSessions(); st.state.apiKey = 'sk-ui-edit-fixture';
          const a = createAgent(st, {}), x = { st, a, status: 'streaming' }; a.getStatus = () => x.status;
          x.ui = mountUI(st, a); x.ui.onUserMessage(st.pushMessage({ role: 'user', text: '完整编辑预览' }));
          st.pushMessage({ role: 'assistant', text: '先写入文件。', model: 'gpt-5.6-sol', done: true }); x.ui.rebuildMessages();
          x.initial = Array.from({ length: 24 }, (_, i) => `FIRST ${i + 1}`).join('\n');
          x.c = { id: 'native-edit-full', name: 'write_file', args: { __raw: '{"path":"site/full.txt","content":' + JSON.stringify(x.initial).slice(0, -1) } };
          x.m = st.pushMessage({ role: 'assistant', text: '', model: 'gpt-5.6-sol', toolCalls: [x.c], done: false }); x.ui.onAssistantStart(x.m);
          x.fold = document.querySelector('.edited-files'); x.path = x.fold.querySelector('.edit-path'); x.previewPath = x.fold.querySelector('.ep-path');
          x.head = x.fold.querySelector('.ep-head'); x.firstLine = x.fold.querySelector('.ep-tx:not(.ep-empty)'); x.removedPaths = 0;
          x.observer = new MutationObserver((records) => { for (const record of records) for (const node of record.removedNodes) if (node === x.path || node.contains?.(x.path) || node === x.previewPath || node.contains?.(x.previewPath)) x.removedPaths++; });
          x.observer.observe(x.fold, { subtree: true, childList: true });
          x.long = 'LONG-CODE-'.repeat(650); x.source = x.initial + '\n' + x.long + '\nLAST';
          x.c.args.__raw = '{"path":"site/full.txt","content":' + JSON.stringify(x.source).slice(0, -1); x.ui.onToolDelta(x.m);
          window.__editFixture = x;
        });
        await page.waitForFunction(() => document.querySelector('.edited-files .ep-body')?.textContent.includes('LAST'));
        const live = await page.evaluate(() => {
          const x = window.__editFixture, fold = document.querySelector('.edited-files');
          const rows = [...fold.querySelectorAll('.ep-tx:not(.ep-empty)')].map((row) => row.textContent);
          return { stable: fold === x.fold && fold.querySelector('.edit-path') === x.path && fold.querySelector('.ep-path') === x.previewPath && fold.querySelector('.ep-head') === x.head && fold.querySelector('.ep-tx:not(.ep-empty)') === x.firstLine,
            removedPaths: x.removedPaths, first: rows[0], last: rows.at(-1), long: rows.at(-2), count: rows.length,
            unmutated: !x.a.fs.has('site/full.txt'), expanded: fold.classList.contains('expanded'), overflow: getComputedStyle(fold.querySelector('.ep-body')).overflowY };
        });
        assert.equal(live.stable, true); assert.equal(live.removedPaths, 0); assert.equal(live.first, 'FIRST 1'); assert.equal(live.last, 'LAST');
        assert.equal(live.long, 'LONG-CODE-'.repeat(650)); assert.equal(live.count, 26); assert.equal(live.unmutated, true); assert.equal(live.expanded, true); assert.equal(live.overflow, 'auto');
        await page.evaluate(() => { const x = window.__editFixture; x.c.args = { path: 'site/full.txt', content: x.source }; x.a.fs.write(x.c.args.path, x.source); x.ui.onToolEvent(x.c, { status: 'ok', settled: true, finalOutput: '已写入 site/full.txt' }); });
        await page.waitForFunction(() => !document.querySelector('.edited-files')?.classList.contains('expanded'));
        const done = await page.evaluate(() => { const x = window.__editFixture; x.observer.disconnect(); return { same: document.querySelector('.edited-files') === x.fold, title: x.fold.querySelector('.chip-name').textContent, messageDone: x.m.done, status: x.status, rows: x.fold.querySelectorAll('.ep-tx:not(.ep-empty)').length, fromDisk: x.fold.querySelector('.ep-meta').textContent }; });
        assert.equal(done.same, true); assert.equal(done.title, 'Edited file'); assert.equal(done.messageDone, false); assert.equal(done.status, 'streaming'); assert.equal(done.rows, 26); assert.match(done.fromDisk, /来自已落盘文件/); assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
    await t.test('real Chromium reveals concurrent results one-by-one in launch order and defers the final assistant message', async () => {
      uiBrowser ||= await chromium.launch({ headless: true, chromiumSandbox: false, args: ['--disable-dev-shm-usage'] });
      const context = await uiBrowser.newContext({ locale: 'zh-CN' });
      try {
        await context.route('**/*', (route) => { if (new URL(route.request().url()).origin === base && !/\/js\/main\.js/.test(route.request().url())) route.continue(); else route.abort(); });
        const page = await context.newPage(), errors = []; page.on('pageerror', (e) => errors.push(e.message)); await page.goto(base + '/app.html');
        const early = await page.evaluate(async () => {
          const { createStore } = await import('./js/state.js'), { createAgent } = await import('./js/agent.js'), { mountUI } = await import('./js/ui.js');
          const st = createStore(); st.clearAllSessions(); st.state.apiKey = 'sk-ui-order-fixture';
          const a = createAgent(st, {}), x = { st, a, status: 'executing', seen: [] }; a.getStatus = () => x.status; x.ui = mountUI(st, a);
          x.ui.onUserMessage(st.pushMessage({ role: 'user', text: '并发任务有序显示' }));
          x.calls = [1, 2, 3].map((n) => ({ id: `native-order-${n}`, name: 'execute_javascript', args: { code: `return ${n}` }, settled: false }));
          x.m = st.pushMessage({ role: 'assistant', text: '', model: 'gpt-5.6-sol', toolCalls: x.calls, done: true }); x.ui.onAssistantStart(x.m);
          x.first = document.querySelector('.tool-call-chip'); x.seen.push({ id: x.first.dataset.callId, at: performance.now() });
          x.observer = new MutationObserver((records) => { for (const record of records) for (const node of record.addedNodes) {
            const added = node.matches?.('.tool-call-chip') ? [node] : [...(node.querySelectorAll?.('.tool-call-chip') || [])];
            for (const chip of added) x.seen.push({ id: chip.dataset.callId, at: performance.now() });
          } }); x.observer.observe(document.querySelector('#messages'), { childList: true, subtree: true });
          x.ui.onToolEvent(x.calls[2], { status: 'ok', settled: true, finalOutput: 'THIRD-NATIVE-OUTPUT' });
          x.ui.onToolEvent(x.calls[1], { status: 'ok', settled: true, finalOutput: 'SECOND-NATIVE-OUTPUT' });
          window.__orderFixture = x;
          return { widgets: document.querySelectorAll('.tool-call-chip').length, hidden: !document.querySelector('#messages').textContent.includes('THIRD-NATIVE-OUTPUT') };
        });
        assert.equal(early.widgets, 1); assert.equal(early.hidden, true);
        const held = await page.evaluate(() => {
          const x = window.__orderFixture; x.ui.onToolEvent(x.calls[0], { status: 'ok', settled: true, finalOutput: 'FIRST-NATIVE-OUTPUT' }); x.status = 'done';
          x.reply = x.st.pushMessage({ role: 'assistant', text: 'FINAL-NATIVE-ANSWER', model: 'gpt-5.6-sol', done: true }); x.ui.onAssistantStart(x.reply);
          return { widgets: document.querySelectorAll('.tool-call-chip').length, replyHidden: !document.querySelector(`#messages .msg[data-id="${x.reply.id}"]`) };
        });
        assert.equal(held.widgets, 1); assert.equal(held.replyHidden, true);
        await page.waitForFunction(() => document.querySelectorAll('.tool-call-chip').length === 3 && document.querySelector('#messages').textContent.includes('FINAL-NATIVE-ANSWER'));
        const final = await page.evaluate(() => { const x = window.__orderFixture; x.observer.disconnect(); return { same: document.querySelector('.tool-call-chip') === x.first, order: x.seen, text: document.querySelector('#messages').textContent }; });
        assert.equal(final.same, true); assert.deepEqual(final.order.map((entry) => entry.id), ['native-order-1', 'native-order-2', 'native-order-3']);
        assert.ok(final.order[2].at - final.order[1].at >= 60, 'completed backlog must span separate reveal ticks, not bulk insertion');
        assert.match(final.text, /FIRST-NATIVE-OUTPUT/); assert.match(final.text, /SECOND-NATIVE-OUTPUT/); assert.match(final.text, /THIRD-NATIVE-OUTPUT/); assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
    await t.test('real Agent/UI keeps each same-path write snapshot behind the launch-order frontier in Chromium', async () => {
      uiBrowser ||= await chromium.launch({ headless: true, chromiumSandbox: false, args: ['--disable-dev-shm-usage'] });
      const context = await uiBrowser.newContext({ locale: 'zh-CN' });
      try {
        await context.route('**/*', (route) => { if (new URL(route.request().url()).origin === base && !/\/js\/main\.js/.test(route.request().url())) route.continue(); else route.abort(); });
        const page = await context.newPage(), errors = []; page.on('pageerror', (e) => errors.push(e.message)); await page.goto(base + '/app.html');
        const held = await page.evaluate(async () => {
          const { createStore } = await import('./js/state.js'), { createAgent } = await import('./js/agent.js'), { mountUI } = await import('./js/ui.js');
          const st = createStore(); st.clearAllSessions();
          Object.assign(st.state, { apiKey: 'sk-native-snapshot-fixture', model: 'gpt-5.6-sol', relayOk: false, files: {} });
          Object.assign(st.state.settings, { webEnabled: false, jevEnabled: false, thinking: false });
          let ui, requests = 0; const first = 'FIRST-CALL-ONLY\nold\nTAIL', second = first + '\nSECOND-CALL-ONLY';
          const third = second.replace('old', 'THIRD-CALL-ONLY');
          const args = [{ path: 'same.txt', content: first }, { path: 'same.txt', mode: 'append', content: '\nSECOND-CALL-ONLY' },
            { path: 'same.txt', mode: 'replace', old_text: 'old', new_text: 'THIRD-CALL-ONLY' }];
          const savedFetch = window.fetch;
          window.fetch = async (url) => {
            if (String(url).includes('/api/sandbox-web/health')) return new Response('{}', { status: 404 });
            const delta = requests++ === 0 ? { tool_calls: args.map((a, index) => ({ index, id: `native-snapshot-${index}`, function: { name: 'write_file', arguments: JSON.stringify(a) } })) }
              : { content: '已完成 same.txt 的三次写入。' };
            return new Response('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
          };
          const a = createAgent(st, {
            onStatus: (s) => ui?.setStatus(s), onUserMessage: (_text, m) => ui?.onUserMessage(m),
            onAssistantStart: (m) => ui?.onAssistantStart(m), onAssistantDone: (m) => ui?.onAssistantDone(m),
            onDelta: (m) => ui?.onDelta(m), onToolDelta: (m) => ui?.onToolDelta(m),
            onToolEvent: (c, p) => ui?.onToolEvent(c, p), onToolResult: (c, r) => ui?.onToolResult(c, r),
            onTempCommit: (m) => ui?.onTempCommit(m),
          });
          ui = mountUI(st, a);
          try { await a.send('同一路径依次写入、追加和替换，最后保留 same.txt'); }
          finally { window.fetch = savedFetch; }
          window.__snapshotFixture = { st, a, ui, first, second, third };
          const fold = document.querySelector('.edited-files');
          return { source: [...fold.querySelectorAll('.ep-tx:not(.ep-empty)')].map((n) => n.textContent).join('\n'),
            foot: fold.querySelector('.ep-foot').textContent, disk: a.fs.read('same.txt'),
            replyHidden: !document.querySelector('#messages').textContent.includes('已完成 same.txt 的三次写入。'),
            snapshots: st.state.messages.find((m) => m.toolCalls?.length)?.toolCalls.map((c) => c.editPreviewSnapshot.content) };
        });
        assert.equal(held.source, 'FIRST-CALL-ONLY\nold\nTAIL'); assert.equal(held.foot, ''); assert.equal(held.replyHidden, true);
        assert.match(held.disk, /SECOND-CALL-ONLY/); assert.match(held.disk, /THIRD-CALL-ONLY/);
        assert.deepEqual(held.snapshots, ['FIRST-CALL-ONLY\nold\nTAIL', 'FIRST-CALL-ONLY\nold\nTAIL\nSECOND-CALL-ONLY', 'FIRST-CALL-ONLY\nTHIRD-CALL-ONLY\nTAIL\nSECOND-CALL-ONLY']);
        await page.waitForFunction(() => document.querySelector('.ep-foot')?.textContent.includes('3 次') && document.querySelector('#messages').textContent.includes('已完成 same.txt 的三次写入。'));
        const final = await page.evaluate(() => { const x = window.__snapshotFixture; x.ui.rebuildMessages(); return {
          source: [...document.querySelectorAll('.edited-files .ep-tx:not(.ep-empty)')].map((n) => n.textContent).join('\n'),
          firstAgain: x.a.getEditPreview([JSON.parse(JSON.stringify(x.st.state.messages.find((m) => m.toolCalls?.length).toolCalls[0]))]).content,
          expanded: document.querySelector('.edited-files').classList.contains('expanded'),
        }; });
        assert.equal(final.source, held.disk); assert.equal(final.firstAgain, held.source); assert.equal(final.expanded, false); assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
    await t.test('Chromium renders terminal errors after unfinished output without releasing buffered tasks or leaving a live Edit caret', async () => {
      uiBrowser ||= await chromium.launch({ headless: true, chromiumSandbox: false, args: ['--disable-dev-shm-usage'] });
      const context = await uiBrowser.newContext({ locale: 'zh-CN' });
      try {
        await context.route('**/*', (route) => { if (new URL(route.request().url()).origin === base && !/\/js\/main\.js/.test(route.request().url())) route.continue(); else route.abort(); });
        const page = await context.newPage(), errors = []; page.on('pageerror', (e) => errors.push(e.message)); await page.goto(base + '/app.html');
        const immediate = await page.evaluate(async () => {
          const { createStore } = await import('./js/state.js'), { createAgent } = await import('./js/agent.js'), { mountUI } = await import('./js/ui.js');
          const st = createStore(); st.clearAllSessions(); st.state.apiKey = 'sk-native-error-fixture';
          const a = createAgent(st, {}), x = { st, a, status: 'streaming' }; a.getStatus = () => x.status; x.ui = mountUI(st, a);
          x.ui.onUserMessage(st.pushMessage({ role: 'user', text: '中断错误边界' }));
          x.calls = [{ id: 'native-error-first', name: 'write_file', args: { __raw: '{"path":"unfinished.txt","content":"UNFINISHED-NATIVE' } },
            { id: 'native-error-hidden', name: 'read_file', args: { path: 'HIDDEN-NATIVE-READ.txt' } }];
          x.m = st.pushMessage({ role: 'assistant', text: '', toolCalls: x.calls, done: true }); x.ui.onAssistantStart(x.m);
          const fold = document.querySelector('.edited-files'); x.path = fold.querySelector('.edit-path');
          x.status = 'error'; x.ui.setStatus('error');
          x.err = st.pushMessage({ role: 'assistant', text: '', error: 'FATAL-NATIVE-ERROR', done: true }); x.ui.onAssistantDone(x.err);
          x.ui.onToolEvent(x.calls[1], { status: 'ok', settled: true, finalOutput: 'LATE-HIDDEN-NATIVE-OUTPUT' });
          window.__errorFixture = x;
          return { error: document.querySelector('.err-box')?.textContent, stable: fold.querySelector('.edit-path') === x.path,
            caret: !!fold.querySelector('.ep-caret'), state: fold.querySelector('.ep-state').textContent,
            ordered: !!(document.querySelector(`.msg[data-id="${x.m.id}"]`).compareDocumentPosition(document.querySelector(`.msg[data-id="${x.err.id}"]`)) & Node.DOCUMENT_POSITION_FOLLOWING) };
        });
        assert.match(immediate.error, /FATAL-NATIVE-ERROR/); assert.equal(immediate.stable, true); assert.equal(immediate.caret, false); assert.equal(immediate.state, '未完成'); assert.equal(immediate.ordered, true);
        await page.waitForTimeout(200);
        const held = await page.evaluate(() => { const x = window.__errorFixture; return { text: document.querySelector('#messages').textContent, settled: x.calls[0].settled === true, file: x.a.fs.has('unfinished.txt') }; });
        assert.ok(!held.text.includes('HIDDEN-NATIVE-READ')); assert.ok(!held.text.includes('LATE-HIDDEN-NATIVE-OUTPUT')); assert.match(held.text, /UNFINISHED-NATIVE/);
        assert.equal(held.settled, false); assert.equal(held.file, false); assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
    await t.test('the real Agent kernel mounts the local tool, starts a project and commits a genuine screenshot', async () => {
      const { createAgent } = await import('../js/agent.js'), { createStore } = await import('../js/state.js');
      const lb = await import('../js/localbrowser.js?v=2026.10.10.1');
      const oldFetch = globalThis.fetch, oldLocation = globalThis.location; let step = 0, id;
      globalThis.location = { protocol: 'http:', origin: base };
      globalThis.fetch = async (url, opts = {}) => {
        if (String(url).startsWith('/api/sandbox-web/')) return oldFetch(base + url, opts);
        const body = JSON.parse(opts.body || '{}'); let delta, finish;
        if (step++ === 0) { delta = { tool_calls: [{ index: 0, id: 'native-agent-start', function: { name: 'browser_sandbox', arguments: JSON.stringify({ action: 'start', entry: 'site/index.html' }) } }] }; finish = 'tool_calls'; }
        else if (step === 2) {
          id = /preview_id=([a-f0-9]{32})/.exec((body.messages || []).filter((m) => m.role === 'tool').map((m) => m.content).join(''))?.[1];
          delta = { tool_calls: [{ index: 0, id: 'native-agent-shot', function: { name: 'browser_sandbox', arguments: JSON.stringify({ action: 'screenshot', preview_id: id, path: 'outputs/agent-native.png' }) } }] }; finish = 'tool_calls';
        } else { delta = { content: '已真实运行 site/index.html。![网页](sandbox://outputs/agent-native.png)' }; finish = 'stop'; }
        return new Response('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: finish }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
      };
      try {
        lb.resetLocalBrowserProbe(); const st = createStore(); st.state.apiKey = 'sk-native-agent-test'; st.state.model = 'gpt-5.6-sol'; st.state.relayOk = false;
        Object.assign(st.state.settings, { webEnabled: false, sandboxEnabled: true, jevEnabled: false, thinking: false });
        const a = createAgent(st, {}); for (const [p, c] of Object.entries(files)) a.fs.write('site/' + p, c);
        await a.send('运行并调试网页，再用 Chromium 截图');
        assert.equal(a.getStatus(), 'done'); assert.ok(id); assert.match(a.fs.read('outputs/agent-native.png'), /^data:image\/png;base64,iVBORw0KGgo/);
        assert.equal(st.state.messages.filter((m) => m.role === 'tool' && m.name === 'browser_sandbox').length, 2);
      } finally { globalThis.fetch = oldFetch; globalThis.location = oldLocation; lb.resetLocalBrowserProbe(); if (id) await rpc({ action: 'stop', preview_id: id }); }
    });
    await t.test('WebSocket and popup escape routes stay blocked, including local websocket paths', async () => {
      const ws = `ws://127.0.0.1:${port}/sandbox-web/${preview.preview_id}/ws`;
      const r = await rpc({ action: 'evaluate', preview_id: preview.preview_id, expression: `new Promise(resolve=>{try{const s=new WebSocket(${JSON.stringify(ws)});s.onopen=()=>resolve('escaped');s.onclose=()=>resolve('blocked');s.onerror=()=>resolve('blocked');setTimeout(()=>resolve('timeout'),1000)}catch{resolve('blocked')}})` });
      assert.equal(r.evaluation, 'blocked');
      const popup = await rpc({ action: 'evaluate', preview_id: preview.preview_id, expression: 'window.open("https://example.com/") === null' }); assert.equal(popup.evaluation, true);
    });
    await t.test('aborting streamed start releases its Chromium context even without later console events', async () => {
      const before = (await (await fetch(base + '/api/sandbox-web/health')).json()).active_sessions;
      const controller = new AbortController();
      const r = await fetch(base + '/api/sandbox-web/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ entry: 'index.html', files: { 'index.html': '<h1>Quiet cancellable page</h1>' } }) });
      await r.body.getReader().read(); controller.abort(); await new Promise((resolve) => setTimeout(resolve, 1000));
      const after = (await (await fetch(base + '/api/sandbox-web/health')).json()).active_sessions;
      assert.equal(after, before, 'cancelled start must not consume a session slot');
    });
    await t.test('stop removes both Chromium context and project assets; stale IDs cannot capture anything', async () => {
      await rpc({ action: 'stop', preview_id: preview.preview_id });
      assert.equal((await fetch(base + preview.preview_path)).status, 404);
      await assert.rejects(rpc({ action: 'screenshot', preview_id: preview.preview_id }), /不存在|已停止/);
    });
  } finally {
    if (uiBrowser) await uiBrowser.close();
    lines.close(); child.kill('SIGTERM');
    if (child.exitCode === null) await Promise.race([once(child, 'exit'), new Promise((r) => { const timer = setTimeout(() => { child.kill('SIGKILL'); r(); }, 5000); timer.unref(); })]);
  }
});
