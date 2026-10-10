// Local companion's Chromium controller. The caller supplies an internally-created
// loopback preview base, NEVER an arbitrary URL. stdout is an NDJSON RPC channel.
import readline from 'node:readline';

const launchOptions = {
  headless: true, timeout: 6000,
  // Playwright normally disables the OS sandbox. We explicitly keep it enabled.
  chromiumSandbox: process.env.DUBHE_BROWSER_NO_SANDBOX !== '1',
  args: ['--disable-dev-shm-usage', '--disable-background-networking', '--disable-extensions', '--dns-prefetch-disable',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
};
let chromium;
try { ({ chromium } = await import('playwright')); }
catch { console.log(JSON.stringify({ ok: false, error: '未安装 Playwright：运行 npm run setup:browser，然后重新启动 server.py。' })); process.exit(process.argv.includes('--probe') ? 0 : 1); }
if (process.argv.includes('--probe')) {
  let ok = false, error = '';
  try { const b = await chromium.launch(launchOptions); await b.close(); ok = true; }
  catch (e) { error = 'Chromium 无法启动，请检查浏览器安装、系统库与 OS 沙箱支持：' + String(e.message).slice(0, 700); }
  console.log(JSON.stringify({ ok, engine: 'chromium', error }));
  process.exit(0);
}
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const sessions = new Map();
let browser;
let currentRequest, currentSession, eventBytes = 0;
process.on('SIGTERM', async () => { if (browser) await browser.close().catch(() => {}); process.exit(0); });
const clamp = (n, low, high, fallback) => Number.isFinite(Number(n)) ? Math.min(high, Math.max(low, Math.round(Number(n)))) : fallback;
function previewBase(value) {
  const u = new URL(String(value || ''));
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !u.port || u.username || u.password
      || !/^\/sandbox-web\/[a-f0-9]{32}\/$/.test(u.pathname) || u.search || u.hash) throw new Error('仅接受本地服务内部创建的沙箱预览地址');
  return u.href;
}
function insideProject(url, base) {
  try {
    const u = new URL(url), b = new URL(base);
    return u.origin === b.origin && u.pathname.startsWith(b.pathname) && !u.username && !u.password;
  } catch { return false; }
}
async function ensureBrowser() {
  if (!browser || !browser.isConnected()) browser = await chromium.launch(launchOptions);
  return browser;
}
function event(payload, sessionId = currentSession) {
  if (!currentRequest || sessionId !== currentSession || eventBytes > 65536) return;
  eventBytes += Buffer.byteLength(JSON.stringify(payload));
  send({ requestId: currentRequest, type: 'event', payload });
}
async function command(job) {
  const id = String(job.preview_id || '');
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('无效的沙箱服务 ID');
  if (job.action === 'start') {
    const base = previewBase(job.base);
    const target = new URL(String(job.entry || '').split('/').map(encodeURIComponent).join('/'), base).href;
    if (!insideProject(target, base)) throw new Error('入口不属于沙箱项目');
    const context = await (await ensureBrowser()).newContext({ serviceWorkers: 'block', acceptDownloads: false, viewport: { width: clamp(job.width, 320, 1920, 1280), height: clamp(job.height, 320, 2400, 800) }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const session = { base, page, context, logs: [], errors: [], blocked: [], touched: Date.now() };
    sessions.set(id, session);
    await context.route('**/*', (route) => {
      const request = route.request(), url = request.url();
      const local = insideProject(url, base);
      const resource = /^(data|blob):/.test(url) && !request.isNavigationRequest();
      if (local || resource) route.continue().catch(() => {});
      else {
        session.blocked.push(url.slice(0, 240));
        if (session.blocked.length > 100) session.blocked.shift();
        route.abort('blockedbyclient').catch(() => {});
      }
    });
    await context.routeWebSocket('**/*', (socket) => socket.close());
    await context.addInitScript(() => {
      // WebRTC's STUN/TURN traffic does not pass through HTTP routing/CSP.
      for (const key of ['RTCPeerConnection', 'webkitRTCPeerConnection'])
        Object.defineProperty(globalThis, key, { value: undefined, writable: false, configurable: false });
    });
    const log = (level, text) => {
      const line = { level, text: String(text).slice(0, 2000) };
      session.logs.push(line); if (session.logs.length > 100) session.logs.shift();
      if (level === 'error') { session.errors.push(line.text); if (session.errors.length > 50) session.errors.shift(); }
      event({ stream: level === 'error' ? 'stderr' : 'stdout', delta: `[${level}] ${line.text}\n` }, id);
    };
    page.on('console', (msg) => log(msg.type(), msg.text()));
    page.on('pageerror', (err) => log('error', err.message));
    page.on('popup', (popup) => popup.close().catch(() => {}));
    await page.setViewportSize({ width: clamp(job.width, 320, 1920, 1280), height: clamp(job.height, 320, 2400, 800) });
    event({ note: '本地沙箱服务已启动，Chromium 正在加载入口…' });
    try { const response = await page.goto(target, { waitUntil: 'networkidle', timeout: 20000 }); if (!response?.ok()) throw new Error('入口加载失败，HTTP ' + (response?.status() || 0)); }
    catch (err) { await context.close(); sessions.delete(id); throw err; }
  }
  const s = sessions.get(id);
  if (!s) throw new Error('该沙箱浏览器会话已停止或服务已重启，请重新 start');
  s.touched = Date.now();
  if (job.action === 'stop') { await s.context.close(); sessions.delete(id); return { ok: true, preview_id: id, stopped: true }; }
  if (job.width || job.height) await s.page.setViewportSize({ width: clamp(job.width, 320, 1920, 1280), height: clamp(job.height, 320, 2400, 800) });
  if (job.action === 'reload') await s.page.reload({ waitUntil: 'networkidle', timeout: 20000 });
  if (job.action === 'click') { await s.page.locator(String(job.selector)).first().click({ timeout: 5000 }); }
  if (job.action === 'fill') {
    await s.page.waitForSelector(String(job.selector), { timeout: 5000 });
    await s.page.$eval(String(job.selector), (node, value) => {
      if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName)) throw new Error('fill 仅支持输入框/选择框');
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'value');
      if (descriptor?.set) descriptor.set.call(node, value); else node.value = value;
      node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true }));
    }, String(job.text || '').slice(0, 20000));
  }
  let evaluation;
  if (job.action === 'evaluate') {
    const expression = String(job.expression || '').slice(0, 8000);
    evaluation = await s.page.evaluate(`(async () => { const value = await (${expression}); const json = JSON.stringify(value); if (json && json.length > 65536) throw new Error('evaluate 返回值超过 64KB'); return json === undefined ? undefined : JSON.parse(json); })()`);
  }
  const wait = clamp(job.wait_ms, 0, 5000, 0);
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  if (!insideProject(s.page.url(), s.base)) throw new Error('页面尝试离开沙箱项目，操作已拒绝');
  const info = await s.page.evaluate(() => ({
    title: document.title, text: (document.body?.innerText || '').slice(0, 12000),
    viewport: { width: innerWidth, height: innerHeight },
    page: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
    elements: [...document.querySelectorAll('button,a,input,textarea,select,[role="button"]')].slice(0, 60).map((n) => ({
      tag: n.tagName.toLowerCase(), id: n.id, text: (n.innerText || n.getAttribute('aria-label') || n.getAttribute('placeholder') || '').slice(0, 100),
    })),
  }));
  const result = { ok: true, preview_id: id, ...info, logs: s.logs, errors: s.errors, blocked_requests: s.blocked, ...(evaluation !== undefined ? { evaluation } : {}) };
  if (job.action === 'screenshot') {
    event({ note: 'Chromium 正在截取当前沙箱页面…' });
    await s.page.evaluate(() => document.fonts.ready);
    if (job.full_page && (info.page.width > 8192 || info.page.height > 16384 || info.page.width * info.page.height > 24000000)) throw new Error('整页过大，请关闭 full_page 或截取元素');
    const target = job.selector ? await s.page.$(String(job.selector)) : s.page;
    if (!target) throw new Error('截图元素不存在');
    if (job.selector) { const box = await target.boundingBox(); if (!box || box.width > 8192 || box.height > 16384 || box.width * box.height > 24000000) throw new Error('截图元素过大或不可见'); }
    const bytes = await target.screenshot({ type: 'png', ...(job.selector ? {} : { fullPage: job.full_page === true }) });
    if (bytes.length > 8 * 1024 * 1024) throw new Error('截图超过 8MB 上限');
    result.image = 'data:image/png;base64,' + Buffer.from(bytes).toString('base64');
    result.bytes = bytes.length;
  }
  return result;
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  let job;
  try {
    job = JSON.parse(line); currentRequest = job.requestId; currentSession = String(job.preview_id || ''); eventBytes = 0;
    if (!['start', 'inspect', 'screenshot', 'click', 'fill', 'evaluate', 'reload', 'stop'].includes(job.action)) throw new Error('不支持该沙箱浏览器操作');
    send({ requestId: job.requestId, type: 'result', result: await command(job) });
  } catch (err) { send({ requestId: job?.requestId, type: 'result', result: { ok: false, error: String(err.message || err).slice(0, 1000) } }); }
  finally { currentRequest = null; currentSession = null; }
}
if (browser) await browser.close();
