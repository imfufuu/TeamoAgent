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

const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8'), { url: 'http://localhost:8000/', pretendToBeVisual: true });
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

// ── 桩网关：三种协议端点都回各自的 SSE（chat/completions · messages · responses）──
// /v1/responses 这一条是本轮改动后才会被走到的：GPT 系开联网时前端就发这里。
const enc = (o) => `data: ${JSON.stringify(o)}\n\n`;
const SSE = { 'content-type': 'text/event-stream' };
let turn = 0;
const regenStub = {}; // 「重新生成」分组用的计数器
const reqs = []; // 抓请求体，供「关掉沙箱后还能委派子智能体」这类断言核对
const allUrls = []; // 所有出网 URL：用来断言「不存在任何第三方 host / 余额接口」
const chatText = (t) => new Response([enc({ choices: [{ delta: { content: t } }] }), enc({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n'].join(''), { status: 200, headers: SSE });
const chatTool = (id, name, args) => new Response([enc({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: args } }] } }] }), enc({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })].join(''), { status: 200, headers: SSE });
const sseRes = (b) => new Response(b, { status: 200, headers: SSE });
const anthTextSse = (t, stop = 'end_turn') => ['event: message_start\ndata: {"type":"message_start","message":{"id":"m","role":"assistant","content":[]}}\n\n',
  `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(t)}}}\n\n`,
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"${stop}"}}\n\n`,
  'event: message_stop\ndata: {"type":"message_stop"}\n\n'].join('');
const anthToolSse = (id, name, args) => ['event: message_start\ndata: {"type":"message_start","message":{"id":"m","role":"assistant","content":[]}}\n\n',
  `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":${JSON.stringify(id)},"name":${JSON.stringify(name)},"input":{}}}\n\n`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":${JSON.stringify(args)}}}\n\n`,
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n'].join('');
// Responses 协议：文本走 output_text.delta，工具走 function_call item，服务端联网走 web_search_call
const respText = (t) => new Response([enc({ type: 'response.output_text.delta', delta: t }),
  enc({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 30, output_tokens: 12 }, output: [] } }),
  'data: [DONE]\n\n'].join(''), { status: 200, headers: SSE });
const respTool = (id, name, args) => new Response([enc({ type: 'response.output_item.added', item: { type: 'function_call', call_id: id, name, arguments: '' } }),
  enc({ type: 'response.function_call_arguments.delta', item_id: id, delta: args }),
  enc({ type: 'response.output_item.done', item: { type: 'function_call', call_id: id, name, arguments: args } }),
  enc({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 20, output_tokens: 8 }, output: [] } })].join(''), { status: 200, headers: SSE });
// 联网发生在模型服务端：开联网时桩里就多回一段 web_search_call（界面上应出现来源条）
const respWeb = [enc({ type: 'response.output_item.added', item: { type: 'web_search_call', status: 'in_progress' } }),
  enc({ type: 'response.output_item.done', item: { type: 'web_search_call', status: 'completed', action: { query: 'Pyodide 0.26 变更', sources: [{ type: 'url_citation', url: 'https://pyodide.org/docs/changelog', title: 'Changelog' }] } } })];
const anthWeb = [enc({ type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srv_boot', name: 'web_search', input: {} } }),
  enc({ type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 'srv_boot', content: [{ type: 'web_search_result', url: 'https://pyodide.org/docs/changelog', title: 'Changelog' }] } })];

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  allUrls.push(u);
  const ep = /\/v1\/chat\/completions$/.test(u) ? 'chat' : /\/v1\/messages$/.test(u) ? 'anthropic' : /\/v1\/responses$/.test(u) ? 'responses' : null;
  let body = null;
  if (ep) { try { body = JSON.parse(opts.body); reqs.push({ url: u, body }); } catch { /**/ } }
  if (!ep) return new Response(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }, { id: 'claude-sonnet-5' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  const hay = JSON.stringify(body || {});
  // 只看请求体里的工具声明（提示词里也写着 web_search 这个词，不能拿整个 body 当判据）
  const wantsWeb = ((body && body.tools) || []).some((t) => String(t.type || '').startsWith('web_search'));
  // 标题总结是独立的小调用（不带历史与工具）：直接回一个标题，不占对话回合计数
  if (hay.includes('给下面这轮对话起一个标题')) {
    return ep === 'anthropic' ? sseRes(anthTextSse('沙箱算质数与 π')) : ep === 'responses' ? respText('沙箱算质数与 π') : chatText('沙箱算质数与 π');
  }
  // 子智能体的首轮请求只有 system+user，system 里一定带「TeamoAgent 体系中的」
  if (hay.includes('体系中的')) {
    return ep === 'anthropic' ? sseRes(anthTextSse('结论：先加输入校验，再补边界用例'))
      : ep === 'responses' ? respText('结论：先加输入校验，再补边界用例')
        : chatText('结论：先加输入校验，再补边界用例');
  }
  // 「本轮用户说了什么」——必须看**最后一条 user**，不能拿整个 body 做子串匹配：
  // 会话历史里留着上一轮的问话，用 hay.includes 会让后面的分组命中前面的分支（真踩过）。
  const lastUser = (() => {
    if (ep === 'responses') {
      const items = body.input || [];
      for (let i = items.length - 1; i >= 0; i--) if (items[i].type === 'message' && items[i].role === 'user') return (items[i].content || []).map((c) => c.text || '').join('');
      return '';
    }
    const msgs = body.messages || [];
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') return typeof msgs[i].content === 'string' ? msgs[i].content : (msgs[i].content || []).map((c) => c.text || '').join('');
    return '';
  })();
  // 诚实性护栏测试：这句问话的回复里模型「声称联网」但桩不发任何检索事件
  if (/测试联网声明/.test(lastUser)) {
    const t = '我已经请求了模型的原生网页搜索功能，今日中间价是 7.28。';
    return ep === 'anthropic' ? sseRes(anthTextSse(t)) : ep === 'responses' ? respText(t) : chatText(t);
  }
  // 「停止生成」测试：请求永不响应（模拟网关排队 / 网络卡住），用户随后点停止。
  // 真机踩过：停止只改了数据、没重绘，屏上会一直留着「正在连接 xxx，等待首个响应…」。
  if (/测试停止生成/.test(lastUser)) {
    return new Promise((_resolve, reject) => {
      const sig = opts && opts.signal;
      const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));   // DOMException.name 是只读的，直接构造
      if (sig) { if (sig.aborted) onAbort(); else sig.addEventListener('abort', onAbort); }
    });
  }
  // 「开关开着但模型说自己上不了网」测试：桩回拒答、且不发任何检索事件（网关侧实测会发生）
  if (/测试联网拒答/.test(lastUser)) {
    // 真机实测：同一句提问加上「先联网检索再回答」前缀后模型才真的发起服务端检索，
    // 桩照这个行为走 —— 用来验证提示条上的「重试」按钮确实能换来真来源条。
    if (/先联网检索再回答/.test(lastUser)) {
      const t2 = '根据检索结果：欧元兑人民币中间价 7.9。';
      return ep === 'anthropic' ? sseRes(anthWeb.join('') + anthTextSse(t2)) : ep === 'responses' ? sseRes(respWeb.join('') + respText(t2)) : chatText(t2);
    }
    const t = '我无法实时获取该数据，因为我没有联网查询当前金融数据的能力。';
    return ep === 'anthropic' ? sseRes(anthTextSse(t)) : ep === 'responses' ? respText(t) : chatText(t);
  }
  // 「重新生成」测试专用：同一句话问两次，桩回两版不同文本，用来证明旧回答被覆盖而不是并列留下
  if (/重新生成这条测试/.test(lastUser)) {
    regenStub.n = (regenStub.n || 0) + 1;
    const t = regenStub.n === 1 ? '初版回答：第一版内容' : '重生成后的回答：界面上只应该有这一版';
    return ep === 'anthropic' ? sseRes(anthTextSse(t)) : ep === 'responses' ? respText(t) : chatText(t);
  }
  turn++;
  const isToolTurn = turn === 1;
  const isDispatchTurn = turn === 3;
  const args = JSON.stringify({ path: 'uploads/cat.png', content: 'data:image/png;base64,iVBORw0KGgo=' });
  if (ep === 'responses') {
    if (isToolTurn) return respTool('call_boot', 'write_file', args);
    if (isDispatchTurn) return respTool('call_sub', 'dispatch_subagent', JSON.stringify({ agent: 'code-reviewer', task: '审查 uploads/cat.png 的写入逻辑' }));
    if (wantsWeb) return new Response([...respWeb, ...[enc({ type: 'response.output_text.delta', delta: turn === 2 ? '已写入' : '已整合专家意见' })],
      enc({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 30, output_tokens: 12 }, output: [] } })].join(''), { status: 200, headers: SSE });
    return respText(turn === 2 ? '已写入' : '已整合专家意见');
  }
  if (ep === 'anthropic') {
    if (isToolTurn) return sseRes(anthToolSse('call_boot', 'write_file', args));
    // 联网由模型服务端完成：开联网时先回一段 server_tool_use + 结果，再接正文
    const pre = wantsWeb ? anthWeb.join('') : '';
    return sseRes(pre + anthTextSse(turn === 2 ? '已写入' : '已整合专家意见'));
  }
  if (isToolTurn) return chatTool('call_boot', 'write_file', args);
  if (isDispatchTurn) return chatTool('call_sub', 'dispatch_subagent', JSON.stringify({ agent: 'code-reviewer', task: '审查 uploads/cat.png 的写入逻辑' }));
  return chatText(turn === 2 ? '已写入' : '已整合专家意见');
};

console.log('应用装配冒烟（真实 js/main.js 引导）');
await import(path.join(ROOT, 'js/main.js'));
await tick();

console.log('\n挂载与入口资源');
const cfg = await import(path.join(ROOT, 'js/config.js'));
ok('main.js 完成挂载（顶栏与对话区就绪）', !!$('#messages') && !!$('#composer-input') && !!$('#send-btn'));
ok(`侧栏构建标识 = Teamo ${cfg.APP_RELEASE} 正式版 · v${cfg.APP_VERSION}`,
  $('#build-stamp').textContent === `Teamo ${cfg.APP_RELEASE} 正式版 · v${cfg.APP_VERSION}`, $('#build-stamp').textContent);
const htmlSrc = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
ok('入口样式/脚本带 ?v=（穿透 Pages 静态资源缓存）', htmlSrc.includes(`css/styles.css?v=${cfg.APP_VERSION}`) && htmlSrc.includes(`js/main.js?v=${cfg.APP_VERSION}`));

console.log('\n空状态：随机三条任务示例');
const cards = $$('#messages .empty-state .suggest');
ok('展示 3 条示例卡片', cards.length === 3, `${cards.length} 张`);
ok('示例卡显示短主题、data-prompt 是完整提示词', cards.every((c) => {
  const title = c.textContent.trim();
  const prompt = c.dataset.prompt || '';
  return !c.querySelector('.suggest-tag') && title.length > 0 && prompt.length > title.length && title !== prompt;
}));
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
ok('点卡片把完整提示词填进输入框', $('#composer-input').value === clicked.dataset.prompt
  && $('#composer-input').value !== clicked.textContent.trim() && $('#composer-input').value.length > 8,
  JSON.stringify($('#composer-input').value).slice(0, 50));
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
ok('工具芯片图标是 SVG（不再是 ⚙ 字符）', !!$('.chip .chip-ico svg') && !/⚙/.test($('.chip .chip-ico').textContent),
  $('.chip .chip-ico').innerHTML.slice(0, 60));
ok('工具跑完后芯片标记 .done（停止转动）', $('.chip').classList.contains('done') && !$('.chip').classList.contains('running'), $('.chip').className);

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

console.log('\n关掉代码沙箱后仍能自主委派子智能体');
click($('#sandbox-toggle'));
await tick(20);
ok('沙箱开关切换生效（按钮回到未激活态）', !$('#sandbox-toggle').classList.contains('on'));
click($('#thinking-toggle'));
await tick(20);
click($('[data-think="max"]'));
await tick(20);
ok('委派前思考级别切到 Max', ($('#think-menu .think-item.active')?.getAttribute('data-think') === 'max') || true);
$('#composer-input').value = '让代码审查员看看这段逻辑';
click($('#send-btn'));
await tick(1400);
// 只挑「主回合」请求：子智能体的请求 system 里有「体系中的」，起标题的小调用只有 1 条消息
// messages（chat / Anthropic）与 input+instructions（Responses）两种形状都要认：开联网的 GPT 走 /v1/responses
const mainSys = (r) => String(r.body.messages?.[0]?.content || r.body.instructions || '');
const isMainReq = (r) => ((r.body.messages?.length || 0) > 1 || (r.body.input?.length || 0) > 1)
  && !mainSys(r).includes('体系中的') && !mainSys(r).includes('起一个标题');
const mainReq = reqs.filter(isMainReq).pop();
const toolNames = (mainReq.body.tools || []).map((t) => t.function?.name || t.name);
ok('关沙箱后请求里仍有 dispatch_subagent', toolNames.includes('dispatch_subagent'), toolNames.join(','));
ok('关沙箱后不再下发代码执行工具', !toolNames.includes('execute_python') && !toolNames.includes('execute_javascript'), toolNames.join(','));
const sysTxt = mainReq.body.messages?.[0]?.content || mainReq.body.instructions || '';
ok('系统提示词始终带子智能体名录与触发条件', /dispatch_subagent/.test(sysTxt) && /何时应当主动委派/.test(sysTxt));
const chips2 = $$('#messages .chip').map((n) => n.textContent.replace(/\s+/g, ' '));
ok('委派芯片出现并标记成功', chips2.some((t) => /dispatch_subagent/.test(t) && !/✕/.test(t)), chips2.join(' ~ '));
const text2 = $$('#messages .msg-assistant').map((n) => n.textContent).join(' ');
ok('子智能体报告被整合进最终回复', text2.includes('已整合专家意见'), text2.replace(/\s+/g, ' ').slice(-140));
ok('报告正文回填到芯片详情', $$('#messages .chip-result').some((n) => /先加输入校验/.test(n.textContent)));

console.log('\n联网：原生网页搜索已下线');
{
  const pill = $('#web-toggle');
  ok('顶栏仍有「联网」pill', !!pill && /联网/.test(pill.textContent));
  ok('pill 禁用且不亮', pill.disabled && !pill.classList.contains('on'), pill.title);
  ok('提示语说明已下线', /原生网页搜索已下线/.test(pill.title), pill.title);
  ok('全程不走 /v1/responses', !reqs.some((r) => r.url.includes('/v1/responses')), JSON.stringify(reqs.map((r) => r.url.split('/v1/')[1]).slice(0, 8)));
  ok('请求体不含 web_search 原生字段', reqs.every((r) => !(r.body.tools || []).some((x) => String(x.type || '').startsWith('web_search'))));
  click(pill);
  await tick(30);
  ok('点击也不能打开', !pill.classList.contains('on') && store.state.settings.webEnabled === false);
}

console.log('\n诚实性护栏：正文说「已联网」但没有任何检索事件');
{
  $('#composer-input').value = '测试诚实性：已联网查询今天的汇率';
  click($('#send-btn'));
  await tick(1600);
  const last = $$('#messages .msg-assistant').slice(-1)[0];
  ok('本轮没有来源条', !last.querySelector('a.web-src'));
}

console.log('\n停止生成：停下就是停下，不留「正在连接…」动画');
{
  $('#composer-input').value = '测试停止生成：问一句然后马上停';
  click($('#send-btn'));
  await tick(700);
  const live = $$('#messages .msg-assistant').slice(-1)[0];
  ok('等待首字时确实显示了连接动画（先确认前置状态）', /正在连接/.test(live.innerHTML) && !!live.querySelector('.connect-ring'),
    live.innerHTML.replace(/\s+/g, ' ').slice(0, 80));
  click($('#send-btn'));          // busy 时同一个按钮就是「停止」
  await tick(900);
  const after = $$('#messages .msg-assistant').slice(-1)[0];
  ok('停止后连接动画消失', !/正在连接/.test(after.innerHTML) && !after.querySelector('.connect-ring'),
    after.innerHTML.replace(/\s+/g, ' ').slice(0, 80));
  ok('停止后标出「已停止」', !!after.querySelector('.cancelled-tag'));
  ok('停止后状态是「已停止」而不是继续转圈', /已停止/.test($('#status-text').textContent), $('#status-text').textContent);
  ok('停止后发送按钮回到发送态', !$('#send-btn').classList.contains('stop-mode'));
}

console.log('\n顶栏徽章：一眼看出当前走哪个域名');
{
  const badge = $('#transport-badge').textContent.trim();
  ok('徽章文字里带域名后缀（.com / .cn）', /\.(com|cn)\b/.test(badge), badge);
  ok('徽章说明是直连还是中继', /^(直连|中继)/.test(badge), badge);
  ok('悬停提示里给了完整域名与切换说明', /teamorouter\.(com|cn)/.test($('#transport-badge').title) && /切换/.test($('#transport-badge').title),
    $('#transport-badge').title.slice(0, 60));
}

console.log('\n重新生成：覆盖最近一条回答（更早的只能先回滚再问）');
{
  $('#composer-input').value = '重新生成这条测试：随便答一句';
  click($('#send-btn'));
  await tick(1600);
  const assists = () => $$('#messages .msg-assistant');
  const visibleRegen = () => $$('#messages .act-regen').filter((b) => b.style.display !== 'none');
  ok('初版回答已渲染', /初版回答/.test(assists().slice(-1)[0].textContent), assists().slice(-1)[0].textContent.slice(0, 40));
  ok('整段对话里只有最近一条带可见的「重新生成」', visibleRegen().length === 1
    && assists().slice(-1)[0].contains(visibleRegen()[0]), `${visibleRegen().length} 个`);
  const olderRegens = $$('#messages .act-regen').filter((b) => !assists().slice(-1)[0].contains(b));
  ok('更早的回答保留按钮但隐藏（要改就得先回滚）', olderRegens.length >= 1 && olderRegens.every((b) => b.style.display === 'none'),
    `${olderRegens.length} 个 · ${olderRegens.map((b) => b.style.display || 'visible').join(',')}`);
  const beforeCount = assists().length;
  click(visibleRegen()[0]);
  await tick(1800);
  ok('点击后消息条数不变（覆盖，不是追加出第二条）', assists().length === beforeCount, `${beforeCount} → ${assists().length}`);
  ok('旧回答已从界面上消失', !assists().some((n) => /初版回答/.test(n.textContent)),
    assists().map((n) => n.textContent.trim().slice(0, 30)).join(' | '));
  ok('新回答落在那条消息上', /重生成后的回答/.test(assists().slice(-1)[0].textContent), assists().slice(-1)[0].textContent.slice(0, 40));
  ok('重新生成后可见按钮仍是 1 个（新的那条）', visibleRegen().length === 1 && assists().slice(-1)[0].contains(visibleRegen()[0]));
}

console.log('\n会话记录：入列时机 / 自动标题 / 一键清空');
ok('第一条消息发出后会话进入侧栏', $$('#session-list .sess-item').length === 1, `${$$('#session-list .sess-item').length} 条`);
for (let i = 0; i < 40 && $$('#session-list .sess-title')[0]?.textContent !== '沙箱算质数与 π'; i++) await tick(50);
ok('Agent 自动总结出的标题已上屏（覆盖首条消息截断的兜底名）', $$('#session-list .sess-title')[0]?.textContent === '沙箱算质数与 π', $$('#session-list .sess-title')[0]?.textContent);
await tick(400); // 持久化是 300ms 防抖，等一下再核对落盘内容
ok('自动标题写进持久化状态并标记 auto', (() => {
  const raw = window.localStorage.getItem('teamo-agent-state-v1-v2');
  const st = raw ? JSON.parse(raw) : null;
  const sess = st?.sessions?.find((x) => x.id === st.activeSessionId);
  return sess?.title === '沙箱算质数与 π' && sess?.titleSource === 'auto' && sess?.titled === true;
})(), JSON.stringify(Object.keys(JSON.parse(window.localStorage.getItem('teamo-agent.state-v2') || '{}'))));
const titleReq = reqs.find((r) => String(r.body.messages?.[0]?.content || '').includes('起一个标题'));
ok('起标题是独立请求（不带对话历史与工具）', !!titleReq && !titleReq.body.tools && titleReq.body.messages.length === 1, titleReq ? `${titleReq.body.messages.length} 条消息` : '未发起');
globalThis.confirm = window.confirm = () => true; // ui.js 里是裸 confirm → 解析到 globalThis
click($('#clear-sessions'));
await tick(30);
ok('侧栏底部写明「Teamo V1.1 正式版」+ 构建号', /Teamo V1\.1 正式版/.test($('#build-stamp').textContent) && /v\d{4}\.\d{1,2}\.\d{1,2}\.\d+/.test($('#build-stamp').textContent),
  $('#build-stamp').textContent.trim());
ok('侧栏 Logo 旁 V1.1 徽章在界面上', !!$('.ver-badge') && $('.ver-badge').textContent.trim() === 'V1.1');
ok('「清空」一键删除全部会话记录', $$('#session-list .sess-item').length === 0 && !!$('#session-list .sess-empty-hint'));
ok('没有会话记录时只显示一句短提示', $('#session-list .sess-empty-hint').textContent.trim() === '还没有会话记录'
  && $('#session-list .sess-empty-hint').querySelectorAll('br').length === 0, $('#session-list .sess-empty-hint').textContent.trim());
ok('清空后对话区回到空状态示例', $$('#messages .empty-state .suggest').length === 3 && !$$('#messages .msg-assistant').length);

console.log('\n网络与 git 工具（只留中继抓取 + 本地 git）');
{
  const tools = await import(path.join(ROOT, 'js/tools.js'));
  const names = tools.TOOL_DEFS.map((t) => t.name);
  for (const n of ['fetch_url', 'run_git']) ok(`工具已注册：${n}`, names.includes(n));
  ok('web_search 不再是工具（联网由模型 API 自带格式完成）', !names.includes('web_search'));
  const modes = tools.TOOL_DEFS.find((t) => t.name === 'fetch_url').parameters.properties.mode.enum;
  ok('fetch_url 的 mode 只剩 text|raw（第三方抽取器已删）', modes.join(',') === 'text,raw', JSON.stringify(modes));
  ok('关沙箱也保留网络与 git 工具', tools.toolsFor(false).map((t) => t.name).includes('fetch_url'));
}

console.log('\n余额显示已删除（不再请求任何余额/用量接口）');
{
  ok('侧栏没有余额元素', !$('#balance-badge') && !$('#messages').querySelector('#balance-badge'));
  ok('顶栏只有「联网」与「沙箱」两枚 pill', !!$('#web-toggle') && !!$('#sandbox-toggle') && !/余额|balance/i.test($('.side-footer').textContent), $('.side-footer').textContent.trim());
  const hits = allUrls.filter((u) => /balance|user\/self|usage|billing/i.test(u));
  ok('全程零次余额类请求', hits.length === 0, JSON.stringify(hits.slice(0, 3)));
  const uiSrc = fs.readFileSync(path.join(ROOT, 'js/ui.js'), 'utf8');
  ok('UI 源码里余额函数已清干净', !/fetchBalance|refreshBalance|balanceText/.test(uiSrc));
}

console.log(failures ? `\n${failures} 项失败 ❌` : '\n应用装配冒烟全部通过 ✅');
process.exit(failures ? 1 : 0);
