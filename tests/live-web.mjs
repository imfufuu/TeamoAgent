// ─── 联网能力实测（真实 TeamoRouter 网关，可选）───────────────────────────
// 用法: TEAMO_API_KEY=sk-teamo-xxx node tests/live-web.mjs
// 没 key 就跳过（退出码 0），不干扰 npm run test:all / CI。
//
// 为什么单独一个文件：联网这块过去是「照文档写、靠桩验证」，而文档对不上现实——
// 实测结论（2026-09-21）才是 js/websearch.js 里能力表的依据：
//   ✅ GPT    /v1/responses + tools:[{type:"web_search"}]          真联网（web_search_call + action.sources）
//   ✅ Claude /v1/messages + tools:[{type:"web_search_20250305"}]  真联网（server_tool_use + web_search_tool_result）
//   ❌ Kimi   tools:[{type:"builtin_function",function:{name:"$web_search"}}]  网关收下但不执行
//   ❌ GLM    tools:[{type:"web_search"}]                                      上游 400 upstream_error
//   ❌ Grok   search_parameters:{mode:"live"}                                  只把工具调用当文本吐回来
//   ⚠ Gemini 原生 google_search 可用，但需要 /v1beta/models/{model}:generateContent 这条独立通道（本轮未接）
//
// 本文件同时守住两个线上真出过的坑：
//   1) Anthropic 的 server_tool_use 分片（input_json_delta 里是搜索词）如果进了客户端工具累积器，
//      会凭空多出一个 name 为空的 tool_use，主循环真的会去执行它 —— 这里断言累积器干净。
//   2) 请求体里带 "system":"" 时上游整段不返回 thinking 块 —— 这里断言空 system 不会被发出去。
import assert from 'node:assert/strict';
import { streamChat, createToolCallAccumulator, __resetWebFallbackForTests } from '../js/api.js';
import { webCapFor } from '../js/websearch.js';

const KEY = process.env.TEAMO_API_KEY || '';
if (!KEY) {
  console.log('⏭  tests/live-web.mjs 跳过：未设置 TEAMO_API_KEY（真实联网测试需显式提供 key）');
  process.exit(0);
}

const WEB_MODELS = (process.env.TEAMO_WEB_MODELS || 'gpt-5.4-mini,claude-haiku-4-5').split(',').map((x) => x.trim()).filter(Boolean);
const QUESTION = '请联网查一下今天的美元兑人民币汇率中间价是多少，并给出来源链接。';

let pass = 0, fail = 0;
const rows = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const info = await fn();
    pass++; rows.push(`  ✓ ${name}${info ? ' — ' + info : ''} (${Date.now() - t0}ms)`);
  } catch (e) {
    fail++; rows.push(`  ✗ ${name} — ${e.message} (${Date.now() - t0}ms)`);
  }
  console.log(rows[rows.length - 1]);
}

// 抓一次出网请求：既能断言「打的是哪个端点」，也能回看请求体
const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), body: typeof init.body === 'string' ? init.body : '' });
  return realFetch(url, init);
};
const lastCall = () => calls[calls.length - 1] || {};

function collect() {
  const st = { text: '', web: null, toolDeltas: 0, errors: [] };
  const acc = createToolCallAccumulator();
  return {
    st, acc,
    onEvent: (ev) => {
      if (ev.type === 'text') st.text += ev.text;
      else if (ev.type === 'tool_delta') { st.toolDeltas++; acc.push(ev); }
      else if (ev.type === 'error') st.errors.push(ev.message);
      else if (ev.type === 'web_search') {
        const prev = st.web || { status: 'idle', sources: [], queries: [], results: 0 };
        const merge = (rows2) => (rows2 && rows2.length ? [...new Map([...prev.sources, ...rows2].map((x) => [x.url, x])).values()] : prev.sources);
        if (ev.status === 'searching') st.web = { ...prev, status: 'searching' };
        else if (ev.status === 'query') st.web = { ...prev, queries: [...new Set([...prev.queries, ev.query])] };
        else if (ev.status === 'sources') st.web = { ...prev, sources: merge(ev.sources) };
        else if (ev.status === 'done') st.web = { ...prev, status: 'done', results: ev.results != null ? ev.results : prev.results,
          queries: ev.queries && ev.queries.length ? [...new Set([...prev.queries, ...ev.queries])] : prev.queries, sources: merge(ev.sources) };
        else if (ev.status === 'error') st.web = { ...prev, status: 'error', message: ev.message || '' };
      }
    },
  };
}

console.log('═══ TeamoAgent 联网实测（真实网关）═══\n');

for (const model of WEB_MODELS) {
  const cap = webCapFor(model);
  await step(`原生联网格式（${model} → ${cap ? cap.endpoint : '无'}）`, async () => {
    assert.ok(cap, `${model} 在能力表里没有原生联网格式`);
    const c = collect();
    await streamChat({ model, apiKey: KEY, thinking: false, webEnabled: true,
      messages: [{ role: 'user', text: QUESTION }], onEvent: c.onEvent });
    const call = lastCall();
    assert.ok(/\/v1\/(responses|messages|chat\/completions)$/.test(call.url), `端点异常: ${call.url}`);
    const body = JSON.parse(call.body || '{}');
    const toolTypes = (body.tools || []).map((t) => t.type || t.function?.name);
    assert.ok(toolTypes.length === 1 && /web_search/.test(String(toolTypes[0])), `请求体里没有原生联网字段: ${JSON.stringify(toolTypes)}`);
    if (cap.endpoint === 'responses') assert.equal(call.url.endsWith('/v1/responses'), true, 'GPT 联网没走 /v1/responses');
    // 服务器工具不得混进客户端工具累积器
    assert.equal(c.acc.result().length, 0, `服务器端联网被误当成客户端工具调用: ${JSON.stringify(c.acc.result())}`);
    assert.ok(c.st.text.length > 20, `回答过短（${c.st.text.length} 字），联网轮没有正常收流`);
    const w = c.st.web || {};
    const srcs = (w.sources || []).filter((x) => x && x.url);
    const info = `来源 ${srcs.length} 条${srcs[0] ? ' · ' + srcs[0].url.slice(0, 52) : ''}${w.queries?.length ? ' · 查询词 ' + w.queries[0].slice(0, 24) : ''}`;
    if (w.status === 'error') {
      // 上游检索服务偶发不可用（Anthropic 会明确回 error_code）——如实报错也算通过，但要说清
      return `上游本次返回检索不可用（${w.message}），已按失败上屏 · ${info}`;
    }
    // 「今天的日期」这类问题上游会用内置 time API（sources 里是 {type:"api",name:"oai-time"}，没有 URL），
    // 所以只要求「确实检索过并有计数」；有 URL 时再断言链接可用
    assert.ok(srcs.length > 0 || (w.results || 0) > 0, `联网完成但既无来源也没计数（status=${w.status}）· ${info}`);
    return info;
  });
}

await step('对照：关掉联网后请求体里没有任何联网字段', async () => {
  const c = collect();
  await streamChat({ model: WEB_MODELS[0], apiKey: KEY, thinking: false, webEnabled: false,
    messages: [{ role: 'user', text: '只回复两个字：收到' }], onEvent: c.onEvent });
  const body = JSON.parse(lastCall().body || '{}');
  assert.equal(JSON.stringify(body).includes('web_search'), false, '关掉联网后请求体里仍有 web_search');
  assert.equal((c.st.web ? (c.st.web.sources || []).length : 0), 0, '关掉联网却收到了来源');
  return '请求体干净、无来源事件';
});

await step('Anthropic 空 system 不发送（否则上游整个不返回 thinking 块）', async () => {
  const c = collect();
  await streamChat({ model: 'claude-haiku-4-5', apiKey: KEY, thinking: true, webEnabled: false,
    messages: [{ role: 'user', text: '17*23=? 只给数字' }], onEvent: c.onEvent });
  const body = JSON.parse(lastCall().body || '{}');
  assert.equal('system' in body, false, '空 system 被发出去了');
  assert.ok(c.st.text.length > 0, '无回答');
  return `请求体无 system 字段，回答「${c.st.text.trim().slice(0, 12)}」`;
});

__resetWebFallbackForTests();
console.log(`\n═══ 结果: ${pass} 通过 / ${fail} 失败 ═══`);
process.exit(fail ? 1 : 0);
