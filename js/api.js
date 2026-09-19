// ─── TeamoRouter API 客户端 ────────────────────────────────────────────
// 协议路由 + SSE 流式解析 + 传输层（浏览器直连 / 服务端代理兜底）
// 纯函数导出，便于 node 单测（tests/agent.test.mjs）

import { BASE_URL, ANTHROPIC_VERSION, MAX_TOKENS, THINKING_BUDGET, REQUEST_TIMEOUT_MS, protocolOf, thinkingParamsFor } from './config.js';

// 实测不支持思考参数的模型（400 降级后记录，会话内不再尝试）
const thinkingUnsupported = new Set();
export function thinkingDisabledFor(model) { return thinkingUnsupported.has(model); }

let transport = 'direct'; // 'direct' | 'proxy'
export function getTransport() { return transport; }
export function resetTransport() { transport = 'direct'; }

function proxyAvailable() {
  return typeof location !== 'undefined' && /^https?:$/.test(location.protocol);
}

// 统一请求入口：优先直连（TeamoRouter 返回 Access-Control-Allow-Origin: *），
// 网络/CORS 失败时自动切换到本地服务端代理 /api/proxy 并重放一次。
async function request(path, { method = 'POST', headers = {}, body, signal } = {}) {
  const tryFetch = (url) => fetch(url, { method, headers, body, signal });
  try {
    transport = 'direct';
    return await tryFetch(BASE_URL + path);
  } catch (err) {
    if (signal?.aborted) throw err;
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
  return function handle(json) {
    switch (json.type) {
      case 'message_start': {
        const u = json.message && json.message.usage;
        if (u) onEv({ type: 'usage', usage: { input: u.input_tokens, output: u.output_tokens } });
        break;
      }
      case 'content_block_start': {
        const b = json.content_block || {};
        if (b.type === 'tool_use') onEv({ type: 'tool_delta', index: json.index, id: b.id, name: b.name, argsText: '' });
        else if (b.type === 'text' && b.text) onEv({ type: 'text', text: b.text });
        break;
      }
      case 'content_block_delta': {
        const d = json.delta || {};
        if (d.type === 'text_delta' && d.text) onEv({ type: 'text', text: d.text });
        else if (d.type === 'input_json_delta') onEv({ type: 'tool_delta', index: json.index, argsText: d.partial_json || '' });
        else if (d.type === 'thinking_delta' && d.thinking) onEv({ type: 'reasoning', text: d.thinking });
        break;
      }
      case 'message_delta': {
        if (json.usage && json.usage.output_tokens != null) onEv({ type: 'usage', usage: { output: json.usage.output_tokens } });
        if (json.delta && json.delta.stop_reason) onEv({ type: 'finish', reason: json.delta.stop_reason });
        break;
      }
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
      if (ev.argsText) t.argsText += ev.argsText;
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

export function buildAnthropicPayload(messages, { maxTokens = MAX_TOKENS } = {}) {
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
      if (m.text) content.push({ type: 'text', text: m.text });
      for (const t of m.toolCalls || []) content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.args });
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
export async function streamChat({ model, apiKey, messages, tools, fastMode = false, thinking = false, signal, onEvent }) {
  const protocol = protocolOf(model);
  const wantThinking = thinking && !thinkingUnsupported.has(model);

  const buildBody = (withThinking) => {
    let body;
    if (protocol === 'anthropic') {
      const p = buildAnthropicPayload(messages);
      // 思考模式要求 max_tokens > budget_tokens
      const maxTokens = withThinking ? Math.max(p.max_tokens, THINKING_BUDGET * 4) : p.max_tokens;
      body = { model, stream: true, system: p.system, messages: p.messages, max_tokens: maxTokens };
    } else {
      body = { model, stream: true, stream_options: { include_usage: true }, messages: buildOpenAIMessages(messages) };
      if (fastMode) body.service_tier = 'fast'; // TeamoRouter Fast mode（GPT 系列）
    }
    if (withThinking) Object.assign(body, thinkingParamsFor(model));
    if (tools && tools.length) {
      body.tools = protocol === 'anthropic' ? toAnthropicTools(tools) : toOpenAITools(tools);
    }
    return body;
  };

  let body = buildBody(wantThinking);
  let bodyThinking = wantThinking;
  const headers = { 'Content-Type': 'application/json', ...authHeaders(protocol, apiKey) };

  // 发起请求（429/5xx 自动退避重试一次）
  const res = await withRetry(async () => {
    const path = protocol === 'anthropic' ? '/v1/messages' : '/v1/chat/completions';
    const r = await request(path, { method: 'POST', headers, body: JSON.stringify(body), signal });
    if ((r.status === 429 || r.status >= 500) && r.status !== 501) {
      const text = await r.text().catch(() => '');
      const err = new Error(httpErrorMessage(r.status, text));
      err.status = r.status; err.retryable = true;
      throw err;
    }
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      // 思考参数不被该模型支持 → 记录并去掉思考参数重试（对模型家族级降级）
      if (r.status === 400 && bodyThinking && /thinking|reasoning|extended/i.test(text)) {
        thinkingUnsupported.add(model);
        body = buildBody(false);
        bodyThinking = false;
        const err = new Error(httpErrorMessage(r.status, text));
        err.status = 400; err.retryable = true;
        throw err;
      }
      const err = new Error(httpErrorMessage(r.status, text));
      err.status = r.status;
      throw err;
    }
    return r;
  });

  const normalize = protocol === 'anthropic' ? createAnthropicStream(onEvent) : createOpenAIStream(onEvent);
  const feed = createSSEParser((json) => { if (json !== null) normalize(json); });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const timeout = setTimeout(() => { try { reader.cancel(); } catch { /* noop */ } }, REQUEST_TIMEOUT_MS);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      feed(decoder.decode(value, { stream: true }));
    }
    feed(decoder.decode());
  } catch (err) {
    try { reader.cancel(); } catch { /* noop */ }
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
