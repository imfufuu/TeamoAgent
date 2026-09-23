// ─── TeamoRouter API 客户端 ────────────────────────────────────────────
// 协议路由 + SSE 流式解析 + 传输层（浏览器直连 / 服务端代理兜底）
// 纯函数导出，便于 node 单测（tests/agent.test.mjs）

import { ANTHROPIC_VERSION, MAX_TOKENS, THINKING_BUDGET, REQUEST_TIMEOUT_MS, protocolOf, thinkingParamsFor } from './config.js';
import { gatewayBase, setGatewayBase, otherGatewayBase, isNetworkError } from './endpoint.js';
import { webCapFor, injectWeb, buildResponsesInput, createResponsesStream } from './websearch.js';

// 实测不支持思考参数的模型（400 降级后记录，会话内不再尝试）
const thinkingUnsupported = new Set();
export function thinkingDisabledFor(model) { return thinkingUnsupported.has(model); }
// 原生联网被拒过的模型（400 降级后记录，会话内不再尝试）
const webUnsupported = new Set();
const responsesUnsupported = new Set();
export function webFallbackFor(model) { return webUnsupported.has(model); }
export function responsesFallbackFor(model) { return responsesUnsupported.has(model); }
// 仅测试用：清空降级记录，保证用例互相独立
export function __resetThinkingFallbackForTests() { thinkingUnsupported.clear(); }
export function __resetWebFallbackForTests() { webUnsupported.clear(); responsesUnsupported.clear(); }

let transport = 'direct'; // 'direct' | 'proxy'
export function getTransport() { return transport; }

function proxyAvailable() {
  return typeof location !== 'undefined' && /^https?:$/.test(location.protocol);
}

// 切换域名后通知界面（只有真的换了才提示一次，避免刷屏）
let lastSwitchNote = 0;
export function __resetEndpointForTests() { endpointSwitched = false; }
let endpointSwitched = false;
export function endpointSwitchNote() { return lastSwitchNote; }
function noteSwitch(from, to) {
  endpointSwitched = true;
  lastSwitchNote = Date.now();
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('teamo:endpoint-switched', { detail: { from, to } }));
    }
  } catch { /* 忽略 */ }
}
export function tookEndpointSwitch() { const v = endpointSwitched; endpointSwitched = false; return v; }

// 统一请求入口。三条路，按顺序退化：
//   ① 直连当前接入点（TeamoRouter 返回 Access-Control-Allow-Origin: *）
//   ② 网络层失败（域名不可达 / DNS / 连接被拒 / CORS）→ 换另一个域名重放一次
//      —— 中国大陆网络下 api.teamorouter.com 常常打不开，而 api.teamorouter.cn 正常，
//         这一步让用户不用手动改配置
//   ③ 仍失败 → 本地服务端代理 /api/proxy（本地跑 server.py 时可用，能绕开浏览器网络限制）
async function request(path, { method = 'POST', headers = {}, body, signal } = {}) {
  const tryFetch = (url) => fetch(url, { method, headers, body, signal });
  const base = gatewayBase();
  try {
    transport = 'direct';
    return await tryFetch(base + path);
  } catch (err) {
    if (signal?.aborted) throw err;
    if (isNetworkError(err)) {
      const alt = otherGatewayBase();
      try {
        const res = await tryFetch(alt + path);
        setGatewayBase(alt, 'failover');   // 记住能用的那个
        noteSwitch(base, alt);
        return res;
      } catch (err2) {
        if (signal?.aborted) throw err2;
        if (!isNetworkError(err2) || !proxyAvailable()) throw err2;
      }
    }
    if (proxyAvailable()) {
      transport = 'proxy';
      return await tryFetch(`/api/proxy?path=${encodeURIComponent(path)}`);
    }
    throw err;
  }
}

// ── 认证头（调研结论：Anthropic 用 x-api-key；OpenAI/Gemini 用 Bearer）──
export function authHeaders(protocol, apiKey) {
  return protocol === 'anthropic'
    ? { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION }
    : { Authorization: `Bearer ${apiKey}` };
}

// ── SSE 行解析器 ────────────────────────────────────────────────────────
// 喂入任意切分的文本块，按 SSE 规范切出 data: 负载（兼容 \r\n、多行 data、[DONE]）
export function createSSEParser(onData) {
  let buf = '';
  return function feed(chunk) {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      const line = raw.replace(/\r$/, '');
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trimStart();
      if (payload === '[DONE]') { onData(null); continue; }
      if (!payload) continue;
      try { onData(JSON.parse(payload)); } catch { /* 忽略不完整 JSON 行 */ }
    }
  };
}

// ── OpenAI chat.completion.chunk 归一化 ─────────────────────────────────
export function createOpenAIStream(onEv) {
  return function handle(json) {
    if (json.error) { onEv({ type: 'error', message: json.error.message || JSON.stringify(json.error) }); return; }
    if (json.usage) onEv({ type: 'usage', usage: { input: json.usage.prompt_tokens, output: json.usage.completion_tokens } });
    const ch = (json.choices && json.choices[0]) || null;
    if (!ch) return;
    const d = ch.delta || {};
    if (d.content) onEv({ type: 'text', text: d.content });
    if (d.reasoning_content) onEv({ type: 'reasoning', text: d.reasoning_content });
    if (d.tool_calls) {
      for (const tc of d.tool_calls) {
        onEv({
          type: 'tool_delta',
          index: tc.index ?? 0,
          id: tc.id || '',
          name: (tc.function && tc.function.name) || '',
          argsText: (tc.function && tc.function.arguments) || '',
        });
      }
    }
    if (ch.finish_reason) onEv({ type: 'finish', reason: ch.finish_reason });
  };
}

// ── Anthropic /v1/messages 事件流归一化 ─────────────────────────────────
export function createAnthropicStream(onEv) {
  // 服务器工具（模型侧 web_search）的块不能进客户端工具累积器：它的 input_json_delta 里装的是
  // 「搜索查询词」，如果混进 tool_calls 会凭空多出一个 name 为空的工具调用，主循环会去执行它。
  const serverIdx = new Set();
  const serverArgs = new Map();
  const emittedQuery = new Set(); // 同一查询词只上报一次（分片凑齐与 content_block_stop 都会尝试解析）
  // 网关实测：Anthropic 路由把网页工具**混着两种块**发出来 —— 有时是 server_tool_use（服务端自己执行），
  // 有时干脆是一个名叫 web_search / web_fetch 的普通 tool_use 块。后者如果按客户端工具处理，主循环会去
  // executeTool('web_fetch') 然后报「未知工具」；实际内容仍由服务端以 web_search_tool_result 回灌。
  // 这里统一按服务端工具对待：不进客户端累积器，只上报进度。
  const SERVER_TOOL_NAMES = new Set(['web_search', 'web_fetch', 'web_search_preview', 'google_search']);
  const flushQuery = (idx) => {
    const raw = serverArgs.get(idx);
    if (!raw) return;
    let j = null;
    try { j = JSON.parse(raw); } catch { return; } // 分片还没拼完，等下一片或 content_block_stop
    if (!j) return;
    const value = j.query || j.url;
    if (!value) return;
    const kind = j.query ? 'search' : 'fetch';
    const key = `${idx}|${kind}|${value}`;
    if (emittedQuery.has(key)) return;
    emittedQuery.add(key);
    onEv({ type: 'web_search', status: 'query', query: String(value), ...(kind === 'fetch' ? { kind: 'fetch' } : {}) });
  };
  return function handle(json) {
    switch (json.type) {
      case 'message_start': {
        const u = json.message && json.message.usage;
        if (u) onEv({ type: 'usage', usage: { input: u.input_tokens, output: u.output_tokens } });
        break;
      }
      case 'content_block_start': {
        const b = json.content_block || {};
        // 模型服务端自带的联网工具：不由我们执行，只把「查了什么 / 拿到几条来源」暴露给 UI
        if (b.type === 'server_tool_use') {
          serverIdx.add(json.index); serverArgs.set(json.index, ''); // 同一 index 复用时重置分片，避免两次查询拼在一起
          onEv({ type: 'web_search', status: 'searching', name: b.name || 'web_search' });
          if (b.input && b.input.query) onEv({ type: 'web_search', status: 'query', query: String(b.input.query) });
          break;
        }
        if (b.type === 'web_search_tool_result' || b.type === 'web_search_result') {
          serverIdx.add(json.index);
          const rows = Array.isArray(b.content) ? b.content : [];
          const sources = rows.filter((r) => r && r.url).map((r) => (r.page_age ? { url: r.url, title: r.title || '', page_age: r.page_age } : { url: r.url, title: r.title || '' }));
          onEv({ type: 'web_search', status: 'done', results: sources.length || rows.length, sources });
          // 上游检索服务不可用时 content 是 {type:'web_search_tool_result_error', error_code}
          if (b.content && b.content.error_code) onEv({ type: 'web_search', status: 'error', message: b.content.error_code });
          break;
        }
        if (b.type === 'tool_use' && SERVER_TOOL_NAMES.has(b.name)) {
          serverIdx.add(json.index); serverArgs.set(json.index, '');
          onEv({ type: 'web_search', status: 'searching', name: b.name });
          if (b.input && b.input.query) onEv({ type: 'web_search', status: 'query', query: String(b.input.query) });
          else if (b.input && b.input.url) onEv({ type: 'web_search', status: 'query', query: String(b.input.url), kind: 'fetch' });
          break;
        }
        if (b.type === 'tool_use') onEv({ type: 'tool_delta', index: json.index, id: b.id, name: b.name, argsText: '' });
        else if (b.type === 'text' && b.text) onEv({ type: 'text', text: b.text });
        // thinking / redacted_thinking 块必须在后续回合原样回传（含 signature），
        // 这里把块的起止与签名暴露给上层累积（见 createThinkingTracker）
        else if (b.type === 'thinking') onEv({ type: 'block_start', index: json.index, block: { type: 'thinking' } });
        else if (b.type === 'redacted_thinking') onEv({ type: 'block_start', index: json.index, block: { type: 'redacted_thinking', data: b.data || '' } });
        break;
      }
      case 'content_block_delta': {
        const d = json.delta || {};
        if (d.type === 'text_delta' && d.text) onEv({ type: 'text', text: d.text });
        else if (d.type === 'input_json_delta') {
          if (serverIdx.has(json.index)) { serverArgs.set(json.index, (serverArgs.get(json.index) || '') + (d.partial_json || '')); flushQuery(json.index); }
          else onEv({ type: 'tool_delta', index: json.index, argsText: d.partial_json || '' });
        }
        // 引用（web_search_result_location）：顺带补齐来源的标题，去重交给上层按 url 合并
        else if (d.type === 'citations_delta' && d.citation && d.citation.url) {
          onEv({ type: 'web_search', status: 'sources', sources: [{ url: d.citation.url, title: d.citation.title || '' }] });
        }
        else if (d.type === 'thinking_delta' && d.thinking) onEv({ type: 'reasoning', text: d.thinking, index: json.index });
        else if (d.type === 'signature_delta' && d.signature) onEv({ type: 'signature_delta', index: json.index, signature: d.signature });
        break;
      }
      case 'message_delta': {
        if (json.usage && json.usage.output_tokens != null) onEv({ type: 'usage', usage: { output: json.usage.output_tokens } });
        if (json.delta && json.delta.stop_reason) onEv({ type: 'finish', reason: json.delta.stop_reason });
        break;
      }
      case 'content_block_stop':
        if (serverIdx.has(json.index)) flushQuery(json.index);
        break;
      case 'message_stop': onEv({ type: 'stop' }); break;
      case 'error': onEv({ type: 'error', message: (json.error && json.error.message) || 'Anthropic stream error' }); break;
      default: break;
    }
  };
}

// ── 工具调用增量累积（两种协议共用）────────────────────────────────────
export function createToolCallAccumulator() {
  const map = new Map();
  return {
    push(ev) {
      if (!map.has(ev.index)) map.set(ev.index, { id: '', name: '', argsText: '' });
      const t = map.get(ev.index);
      if (ev.id) t.id = ev.id;
      if (ev.name) t.name = ev.name;
      // replace：某些协议（OpenAI Responses 的 output_item.done）在收尾时给出**完整** arguments，
      // 直接追加会和已收到的增量重复 → 这里整体覆盖（空值不清掉已有的流式结果）。
      if (ev.replace) { if (ev.argsText) t.argsText = ev.argsText; }
      else if (ev.argsText) t.argsText += ev.argsText;
    },
    result() {
      return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => {
        let args = {};
        try { args = t.argsText ? JSON.parse(t.argsText) : {}; } catch { args = { __raw: t.argsText }; }
        return { id: t.id || `call_${Math.random().toString(36).slice(2, 10)}`, name: t.name, args };
      });
    },
  };
}

// ── Anthropic 思考块累积器（P0-2）────────────────────────────────────
// 开启 extended thinking 时，协议要求：含 tool_use 的 assistant 回合在后续请求中
// 必须把收到的 thinking / redacted_thinking 块（连同 signature）按原顺序回传，
// 否则第二次请求直接 400（"Expected `thinking` or `redacted_thinking`..."），
// 表现为「第一次工具调用后思考模式被静默废掉」。本累积器按流内顺序收集块，
// 由 buildAnthropicPayload 在 assistant content 最前面重放。
export function createThinkingTracker() {
  const byIndex = new Map();
  const order = [];
  return {
    start(index, block) {
      const b = block && block.type === 'redacted_thinking'
        ? { type: 'redacted_thinking', data: block.data || '' }
        : { type: 'thinking', thinking: '' };
      byIndex.set(index, b);
      order.push(b);
    },
    delta(index, text) {
      const b = byIndex.get(index);
      if (b && b.type === 'thinking') b.thinking += text || '';
    },
    signature(index, signature) {
      const b = byIndex.get(index);
      if (b && b.type === 'thinking' && signature) b.signature = signature;
    },
    // 只保留可回传的块：thinking 需非空内容 + signature（缺签名的块会被 API 拒收），
    // redacted_thinking 需 data
    blocks() {
      return order
        .filter((b) => (b.type === 'thinking' ? b.thinking && b.signature : b.data))
        .map((b) => ({ ...b }));
    },
  };
}

// ── 请求体构建：内部消息 → 协议格式 ────────────────────────────────────
// 内部消息: {role:'system'|'user'|'assistant'|'tool', text?, toolCalls?, toolCallId?, content?, attachments?}
// 附件: {kind:'image'|'text', name, mime, size, dataUrl?, text?, stripped?}

function attachmentNote(a) {
  return a.stripped ? `（附件「${a.name}」内容因本地存储限制已省略）` : `（附件「${a.name}」不可读）`;
}

function userTextParts(m) {
  // OpenAI 兼容协议：文本 + image_url（data URL）多模态 parts
  const parts = [];
  if (m.text) parts.push({ type: 'text', text: m.text });
  for (const a of m.attachments || []) {
    if (a.kind === 'image' && a.dataUrl) parts.push({ type: 'image_url', image_url: { url: a.dataUrl } });
    else if (a.kind === 'text' && a.text != null) parts.push({ type: 'text', text: `【附件：${a.name}】\n${a.text}` });
    else parts.push({ type: 'text', text: attachmentNote(a) });
  }
  return parts;
}

export function buildOpenAIMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
      return {
        role: 'assistant',
        content: m.text || null,
        tool_calls: m.toolCalls.map((t) => ({
          id: t.id, type: 'function',
          function: { name: t.name, arguments: JSON.stringify(t.args) },
        })),
      };
    }
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
    if (m.role === 'user' && m.attachments && m.attachments.length) {
      return { role: 'user', content: userTextParts(m) };
    }
    return { role: m.role, content: m.text };
  });
}

// includeThinking：是否把历史 assistant 消息里的 thinking 块重放进 payload。
// 仅当本次请求开启思考时为 true —— 关闭思考时必须整体省略（API 不接受无思考参数
// 请求里夹带 thinking 块），降级重试路径即依赖这一点。
export function buildAnthropicPayload(messages, { maxTokens = MAX_TOKENS, includeThinking = true } = {}) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.text).join('\n\n');
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      if (m.attachments && m.attachments.length) {
        // Anthropic 原生多模态：text 块 + image 块（source.base64）
        const content = [];
        if (m.text) content.push({ type: 'text', text: m.text });
        for (const a of m.attachments) {
          if (a.kind === 'image' && a.dataUrl) {
            const match = /^data:(.+?);base64,(.*)$/s.exec(a.dataUrl);
            if (match) content.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
            else content.push({ type: 'text', text: attachmentNote(a) });
          } else if (a.kind === 'text' && a.text != null) {
            content.push({ type: 'text', text: `【附件：${a.name}】\n${a.text}` });
          } else {
            content.push({ type: 'text', text: attachmentNote(a) });
          }
        }
        out.push({ role: 'user', content });
      } else {
        out.push({ role: 'user', content: m.text });
      }
    } else if (m.role === 'assistant') {
      const content = [];
      // 思考块回传（P0-2）：API 要求它们位于消息最前面、先于 text / tool_use，
      // 且按流内接收顺序排列（非 interleaved 模式下思考块总在回合开头）
      if (includeThinking) {
        for (const b of m.thinkingBlocks || []) {
          if (b.type === 'thinking' && b.thinking && b.signature) content.push({ type: 'thinking', thinking: b.thinking, signature: b.signature });
          else if (b.type === 'redacted_thinking' && b.data) content.push({ type: 'redacted_thinking', data: b.data });
        }
      }
      if (m.text) content.push({ type: 'text', text: m.text });
      for (const t of m.toolCalls || []) content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.args });
      if (!content.length) content.push({ type: 'text', text: '' }); // 空 content 数组会被 API 拒收
      out.push({ role: 'assistant', content });
    } else if (m.role === 'tool') {
      // 连续的 tool 结果合并进同一条 user 消息（Anthropic 协议要求）
      const last = out[out.length - 1];
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
      if (last && last.role === 'user' && Array.isArray(last.content) && last.content.every((b) => b.type === 'tool_result')) {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
    }
  }
  return { system, messages: out, max_tokens: maxTokens };
}

// ── 流式对话（含 429/5xx 单次退避重试 + 思考参数 400 自动降级）─────────
// onThinkingFallback：思考参数被 400 降级时回调（用于向用户提示，避免静默关闭）
export async function streamChat({ model, apiKey, messages, tools, fastMode = false, thinking = false, signal, onEvent, onThinkingFallback, webEnabled = false, onWebFallback }) {
  const protocol = protocolOf(model);
  const wantThinking = thinking && !thinkingUnsupported.has(model);
  // 联网 = 只往请求体里塞模型 API 自带的网页搜索字段（能力表见 js/websearch.js）。
  // 没有原生格式的模型（DeepSeek 等）就是「本轮不联网」，绝不改道去调第三方搜索 API。
  const webCap = webEnabled && !webUnsupported.has(model) ? webCapFor(model) : null;
  let endpoint = webCap && webCap.endpoint === 'responses' && !responsesUnsupported.has(model) ? 'responses'
    : (protocol === 'anthropic' ? 'messages' : 'chat');

  const buildBody = (withThinking, withWeb) => {
    let body;
    if (endpoint === 'responses') {
      // OpenAI Responses API：网关文档 4.4 —— /v1/responses 仅 GPT 系列，Claude/Gemini 会 400
      const { instructions, input } = buildResponsesInput(messages);
      body = { model, stream: true, input };
      if (instructions) body.instructions = instructions;
      const fnTools = tools && tools.length ? toOpenAITools(tools) : [];
      if (fnTools.length) body.tools = fnTools.map((t) => ({ type: 'function', ...t.function }));
      if (withThinking) body.reasoning = { effort: thinkingParamsFor(model).reasoning_effort || 'medium' };
      if (fastMode) body.service_tier = 'fast';
      if (withWeb) injectWeb(body, webCap);
      return body;
    }
    if (protocol === 'anthropic') {
      // 思考关闭的请求不能夹带历史 thinking 块（API 会拒收）
      const p = buildAnthropicPayload(messages, { includeThinking: withThinking });
      // 思考模式要求 max_tokens > budget_tokens
      const maxTokens = withThinking ? Math.max(p.max_tokens, THINKING_BUDGET * 4) : p.max_tokens;
      // 空 system 不要发：实测网关 Anthropic 路由收到 system:"" 时上游整段不返回 thinking 块
      body = { model, stream: true, messages: p.messages, max_tokens: maxTokens };
      if (p.system) body.system = p.system;
    } else {
      body = { model, stream: true, stream_options: { include_usage: true }, messages: buildOpenAIMessages(messages) };
      if (fastMode) body.service_tier = 'fast'; // TeamoRouter Fast mode（GPT 系列）
    }
    if (withThinking) Object.assign(body, thinkingParamsFor(model));
    if (tools && tools.length) {
      body.tools = protocol === 'anthropic' ? toAnthropicTools(tools) : toOpenAITools(tools);
    }
    if (withWeb) injectWeb(body, webCap);
    return body;
  };

  let bodyThinking = wantThinking;
  let bodyWeb = !!webCap;
  let body = buildBody(bodyThinking, bodyWeb);
  const headers = { 'Content-Type': 'application/json', ...authHeaders(protocol, apiKey) };
  const noteWebFallback = (why) => {
    try { onWebFallback && onWebFallback(model, why); } catch { /* 视图层异常不能影响请求本身 */ }
  };

  // 发起请求（429/5xx 自动退避重试一次）
  const res = await withRetry(async () => {
    const path = endpoint === 'messages' ? '/v1/messages' : (endpoint === 'responses' ? '/v1/responses' : '/v1/chat/completions');
    const r = await request(path, { method: 'POST', headers, body: JSON.stringify(body), signal });
    if ((r.status === 429 || r.status >= 500) && r.status !== 501) {
      const text = await r.text().catch(() => '');
      const err = new Error(httpErrorMessage(r.status, text));
      err.status = r.status; err.retryable = true;
      throw err;
    }
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      // ① Responses 端点被拒 → 退回 /v1/chat/completions 并同时去掉联网字段
      if ((r.status === 400 || r.status === 404 || r.status === 422) && endpoint === 'responses') {
        responsesUnsupported.add(model);
        endpoint = 'chat';
        bodyWeb = false;
        body = buildBody(bodyThinking, false);
        noteWebFallback(`Responses API 端点被拒（${String(text).slice(0, 120)}），已退回 /v1/chat/completions，本轮不联网`);
        const err = new Error(httpErrorMessage(r.status, text));
        err.status = r.status; err.retryable = true;
        throw err;
      }
      // ② 思考参数不被该模型支持 → 记录并去掉思考参数重试（对模型家族级降级）。
      // 必须排在联网降级前面：上游文案常是 "thinking is not supported"，会同时命中
      // 联网分支那条过于宽泛的 /not support/ —— 旧顺序会把思考 400 误判成联网被拒。
      // 通过 onThinkingFallback 告知上层，避免「思考被静默关闭」用户无感知。
      if (r.status === 400 && bodyThinking && /thinking|reasoning|extended/i.test(text)) {
        thinkingUnsupported.add(model);
        try { onThinkingFallback && onThinkingFallback(model); } catch { /* noop */ }
        // 只去掉思考参数，联网字段必须原样保留（旧写法 buildBody(false) 把 withWeb 默认为假，
        // 思考 400 会把本轮联网一并关掉，表现为「开了思考的模型突然不会检索」）。
        body = buildBody(false, bodyWeb);
        bodyThinking = false;
        const err = new Error(httpErrorMessage(r.status, text));
        err.status = 400; err.retryable = true;
        throw err;
      }
      // ③ 联网字段被拒（模型或上游不认这套原生格式）→ 剥离后重试一次，并记住这个模型
      if (r.status === 400 && bodyWeb && /web_search|search_parameters|search_context|builtin_function|\$web_search|unsupported|not support|unknown|invalid|tool|include|instructions/i.test(text)) {
        webUnsupported.add(model);
        bodyWeb = false;
        body = buildBody(bodyThinking, false);
        noteWebFallback(`该模型拒绝原生联网字段，已按无联网重试：${String(text).slice(0, 160)}`);
        const err = new Error(httpErrorMessage(r.status, text));
        err.status = r.status; err.retryable = true;
        throw err;
      }
      const err = new Error(httpErrorMessage(r.status, text));
      err.status = r.status;
      throw err;
    }
    return r;
  });

  const normalize = endpoint === 'responses' ? createResponsesStream(onEvent)
    : (protocol === 'anthropic' ? createAnthropicStream(onEvent) : createOpenAIStream(onEvent));
  const feed = createSSEParser((json) => { if (json !== null) normalize(json); });

  // 某些代理/服务端会以 200 + 空 body 回（如中间层截断）：直接 getReader() 会抛
  // 一个「reading undefined」的 TypeError，用户看不懂；换成可定位的提示。
  if (!res.body) throw new Error('网关返回了空响应体（Content-Length 0 或连接被中断），请重试或切换模型');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  // cancel() 在流已出错时返回 rejected promise，必须显式吞掉，否则产生未处理拒绝
  const cancelQuiet = () => { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* noop */ } };
  const timeout = setTimeout(cancelQuiet, REQUEST_TIMEOUT_MS);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      feed(decoder.decode(value, { stream: true }));
    }
    feed(decoder.decode());
  } catch (err) {
    cancelQuiet();
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function withRetry(fn, retries = 1) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      if (!err.retryable || i === retries) throw err;
      await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
    }
  }
  throw lastErr;
}

function httpErrorMessage(status, text) {
  let msg = text;
  try {
    const j = JSON.parse(text);
    msg = (j.error && (j.error.message || JSON.stringify(j.error))) || text;
  } catch { /* 保留原文 */ }
  const hints = {
    401: '（请检查 API Key：应以 sk-teamo- 开头，且未被删除）',
    402: '（余额不足，请前往 TeamoRouter 控制台充值）',
    404: '（模型不存在，请用 GET /v1/models 核对模型 ID）',
    429: '（触发限流，稍后自动重试）',
  };
  return `HTTP ${status}: ${String(msg).slice(0, 400)} ${hints[status] || ''}`.trim();
}

// ── 工具 Schema 转换 ────────────────────────────────────────────────────
export function toOpenAITools(tools) {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}
export function toAnthropicTools(tools) {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
}

// ── 模型列表 ────────────────────────────────────────────────────────────
export async function fetchModels(apiKey, signal) {
  const res = await request('/v1/models', { method: 'GET', headers: authHeaders('openai', apiKey), signal });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(httpErrorMessage(res.status, text));
  }
  const json = await res.json();
  const list = (json.data || json.models || []).map((m) => m.id || m).filter(Boolean);
  return [...new Set(list)];
}

const IMAGE_MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
const IMAGE_EXT = { png: 'png', jpeg: 'jpg', webp: 'webp' };

// ── 图像模型（GPT Image 2 / 2.5 Sunburst / 2.5 Flare）───────────────────
// 文档：生成 POST /v1/images/generations（JSON）、编辑 POST /v1/images/edits
//       （multipart/form-data：model + prompt + image[/image[]] [+ mask]）
// 鉴权 Authorization: Bearer；响应 data[i].b64_json（Base64）
// 官方建议超时 300s（实测单张 30–65s，2048x2048/high 也只需约 45s）
export const IMAGE_TIMEOUT_MS = 300000;

function withTimeout(signal, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const onAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ac.signal,
    release() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    },
  };
}

// data URL ↔ 字节（图片编辑要把沙箱内的 data URL 还原成上传文件）
export function dataUrlToBytes(dataUrl) {
  const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(String(dataUrl || ''));
  if (!m) throw new Error('不是合法的 data URL，无法作为图片上传');
  const mime = m[1] || 'application/octet-stream';
  const payload = m[3];
  if (m[2]) {
    const bin = atob(payload);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, mime };
  }
  return { bytes: new TextEncoder().encode(decodeURIComponent(payload)), mime };
}

export function bytesToDataUrl(bytes, mime = 'image/png') {
  let bin = '';
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(bin)}`;
}

// 从图片字节头解析真实尺寸与格式（网关有时不返回 width/height，或返回与请求不符的格式）
// 支持 PNG / JPEG / GIF / WebP（VP8 | VP8L | VP8X）
export function sniffImage(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (!u || u.length < 20) return {};
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const fourcc = (o) => String.fromCharCode(u[o], u[o + 1], u[o + 2], u[o + 3]);
  if (u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47) { // \x89PNG\r\n\x1a\n
    if (u.length < 24 || fourcc(12) !== 'IHDR') return { mime: 'image/png', ext: 'png' };
    const pw = dv.getUint32(16); const ph = dv.getUint32(20);
    if (!(pw > 0 && ph > 0 && pw < 100000 && ph < 100000)) return { mime: 'image/png', ext: 'png' };
    return { mime: 'image/png', ext: 'png', width: pw, height: ph };
  }
  if (u[0] === 0xff && u[1] === 0xd8) {
    const out = { mime: 'image/jpeg', ext: 'jpg' };
    for (let i = 2; i + 9 < u.length && u[i] === 0xff; ) {
      const marker = u[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        out.height = dv.getUint16(i + 5);
        out.width = dv.getUint16(i + 7);
        break;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xd8 || marker === 0xd9) { i += 2; continue; }
      i += 2 + dv.getUint16(i + 2);
    }
    return out;
  }
  if (fourcc(0) === 'GIF8') return { mime: 'image/gif', ext: 'gif', width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
  if (fourcc(0) === 'RIFF' && fourcc(8) === 'WEBP') {
    const tag = fourcc(12);
    if (tag === 'VP8 ') {
      return { mime: 'image/webp', ext: 'webp', width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
    }
    if (tag === 'VP8L') {
      const bits = dv.getUint32(21, true);
      return { mime: 'image/webp', ext: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (tag === 'VP8X') {
      return {
        mime: 'image/webp', ext: 'webp',
        width: (u[24] | (u[25] << 8) | (u[26] << 16)) + 1,
        height: (u[27] | (u[28] << 8) | (u[29] << 16)) + 1,
      };
    }
    return { mime: 'image/webp', ext: 'webp' };
  }
  return {};
}

// 统一解析图像响应：b64_json 优先，退回 url；网关也可能返回 image/jpeg|webp
// 返回 { images:[{dataUrl,mime,ext,width,height,revisedPrompt}], dataUrl/mime/ext（首张，向后兼容）, usage }
export function parseImageResponse(json, format = 'png', meta = {}) {
  const tag = meta.status ? `（HTTP ${meta.status}）` : '';
  if (!json || typeof json !== 'object') {
    const raw = String(meta.raw || '').slice(0, 200).replace(/\s+/g, ' ').trim();
    throw new Error(`图像接口未返回 JSON${tag}：${raw || '空响应体'}`);
  }
  const items = Array.isArray(json.data) ? json.data : null;
  // 网关也会用 200 + error/message 表达上游失败，必须显式暴露而不是「缺少 data[0]」
  const soft = json.error || (json.message && !items ? { message: json.message } : null);
  if (soft && !items) {
    const m = typeof soft === 'object' ? (soft.message || JSON.stringify(soft)) : String(soft);
    const err = new Error(`图像接口报错：${String(m).slice(0, 300)}`);
    err.retryable = true; // 上游类错误多为瞬时（网关常提示「请稍后重试」）
    err.code = typeof soft === 'object' ? soft.type || soft.code : undefined;
    throw err;
  }
  if (!items) throw new Error(`图像接口响应异常：缺少 data 数组${tag}（响应字段：${Object.keys(json).join(', ') || '无'}）`);
  if (!items.length) {
    const err = new Error(`网关接受请求但未返回任何图片（data 为空数组${tag}）`);
    err.retryable = true;
    throw err;
  }
  const want = IMAGE_MIME[format] || IMAGE_MIME.png;
  const images = [];
  for (const item of items) {
    const entry = item && typeof item === 'object' ? item : {};
    let mime = want;
    let ext = IMAGE_EXT[format] || 'png';
    let dataUrl = '';
    if (entry.b64_json) {
      dataUrl = `data:${mime};base64,${entry.b64_json}`;
      // 以字节头为准：网关偶尔无视 output_format 返回 png（扩展名/展示都会跟着修正）
      try {
        const sniffed = sniffImage(dataUrlToBytes(dataUrl).bytes);
        if (sniffed.mime && sniffed.mime !== mime) { mime = sniffed.mime; ext = sniffed.ext; dataUrl = `data:${mime};base64,${entry.b64_json}`; }
        if (sniffed.width && sniffed.height) {
          entry.width = sniffed.width; entry.height = sniffed.height;
        }
      } catch { /* 非法 base64 时退回按请求格式处理 */ }
    } else if (entry.url) {
      dataUrl = entry.url;
    } else {
      continue;
    }
    images.push({ dataUrl, mime, ext, width: entry.width || 0, height: entry.height || 0, revisedPrompt: entry.revised_prompt || '' });
  }
  if (!images.length) throw new Error('图像接口未返回图片数据（data[*].b64_json / url 均为空）');
  return { images, ...images[0], created: json.created || 0, usage: json.usage || null };
}

async function postImage(path, { apiKey, body, isForm, signal, timeoutMs }) {
  const t = withTimeout(signal, timeoutMs);
  try {
    const headers = isForm ? authHeaders('openai', apiKey) : { 'Content-Type': 'application/json', ...authHeaders('openai', apiKey) };
    const r = await request(path, { method: 'POST', headers, body, signal: t.signal });
    const text = await r.text().catch(() => '');
    if (!r.ok) {
      const err = new Error(httpErrorMessage(r.status, text));
      err.status = r.status;
      err.retryable = r.status === 429 || r.status >= 500;
      throw err;
    }
    let json = null;
    try { json = JSON.parse(text); } catch { /* 下面按非 JSON 处理 */ }
    if (!json) {
      const err = new Error(`图像接口返回了非 JSON 响应（HTTP ${r.status}，${r.headers.get('content-type') || '未知类型'}，${text.length} 字节）：${text.slice(0, 160).replace(/\s+/g, ' ').trim() || '空响应体'}`);
      err.retryable = true; // 典型为网关/代理抖动，重放一次通常即可
      throw err;
    }
    return json;
  } finally {
    t.release();
  }
}

// 生图单次 30–65s，抖动重放代价高但远小于整轮失败，故只补一次、间隔 3s
export const IMAGE_RETRY_DELAY_MS = 3000;
export async function postImageWithRetry(path, opts, { parse, retries = 1, retryDelayMs = IMAGE_RETRY_DELAY_MS, onRetry, signal } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const json = await postImage(path, opts);
      try {
        return parse ? parse(json) : parseImageResponse(json, opts.format);
      } catch (err) {
        err.payloadAttempt = attempt;
        throw err;
      }
    } catch (err) {
      lastErr = err;
      const abortLike = err && (err.name === 'AbortError' || (signal && signal.aborted));
      if (abortLike || attempt >= retries || !err.retryable) throw err;
      if (onRetry) onRetry(err, attempt + 1);
      await sleepRetry(retryDelayMs, signal);
    }
  }
  throw lastErr;
}

function sleepRetry(ms, signal) {
  return new Promise((resolve) => {
    const done = () => { if (signal) signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    if (signal) {
      if (signal.aborted) { clearTimeout(timer); done(); return; }
      signal.addEventListener('abort', () => { clearTimeout(timer); done(); }, { once: true });
    }
  });
}

// 文生图：size 为像素尺寸（16 的倍数、最大边 ≤3840、长宽比 ≤3:1），auto/缺省交给模型
// n>1 时网关在 data[] 内返回多张，全部落地（不要只取第一张而丢掉其余）
export async function generateImage({ model, apiKey, prompt, size, quality, background, format = 'png', n, signal, timeoutMs = IMAGE_TIMEOUT_MS, onRetry } = {}) {
  const body = { model, prompt, output_format: format };
  if (size && size !== 'auto') body.size = size;
  if (quality && quality !== 'auto') body.quality = quality;
  if (background && background !== 'auto') body.background = background;
  const count = Number(n);
  if (Number.isFinite(count) && count > 1) body.n = Math.min(4, Math.max(2, Math.floor(count)));
  const json = await postImageWithRetry('/v1/images/generations', { apiKey, body: JSON.stringify(body), signal, timeoutMs, format },
    { signal, onRetry, parse: (j) => parseImageResponse(j, format, { status: 200 }) });
  return json;
}

// 图片编辑：images = [{ name?, dataUrl }]（沙箱内图片读出即为 data URL）；mask 可选
export async function editImage({ model, apiKey, prompt, images = [], mask, size, quality, inputFidelity, format = 'png', n, signal, timeoutMs = IMAGE_TIMEOUT_MS, onRetry } = {}) {
  if (!images.length) throw new Error('图片编辑需要至少一张原图（reference_paths）');
  const fd = new FormData();
  fd.append('model', model);
  fd.append('prompt', String(prompt || ''));
  fd.append('output_format', format);
  if (size && size !== 'auto') fd.append('size', size);
  if (quality && quality !== 'auto') fd.append('quality', quality);
  if (inputFidelity && inputFidelity !== 'auto') fd.append('input_fidelity', inputFidelity);
  const count = Number(n);
  if (Number.isFinite(count) && count > 1) fd.append('n', String(Math.min(4, Math.max(2, Math.floor(count)))));
  const field = images.length > 1 ? 'image[]' : 'image'; // OpenAI Images 兼容：多张参考图用 image[]
  for (const img of images) {
    const { bytes, mime } = dataUrlToBytes(img && img.dataUrl);
    fd.append(field, new File([bytes], img.name || `input.${format === 'jpeg' ? 'jpg' : format}`, { type: mime }));
  }
  if (mask && mask.dataUrl) {
    const { bytes, mime } = dataUrlToBytes(mask.dataUrl);
    fd.append('mask', new File([bytes], mask.name || 'mask.png', { type: mime }));
  }
  // 不手动设置 Content-Type：boundary 需由 FormData 生成
  const json = await postImageWithRetry('/v1/images/edits', { apiKey, body: fd, isForm: true, signal, timeoutMs, format },
    { signal, onRetry, parse: (j) => parseImageResponse(j, format, { status: 200 }) });
  return json;
}
