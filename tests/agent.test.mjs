// ─── 核心解析逻辑单测（node tests/agent.test.mjs）─────────────────────
import assert from 'node:assert/strict';
import {
  createSSEParser, createOpenAIStream, createAnthropicStream,
  createToolCallAccumulator, createThinkingTracker, buildOpenAIMessages, buildAnthropicPayload,
  authHeaders, toOpenAITools, toAnthropicTools,
  thinkingDisabledFor, __resetThinkingFallbackForTests,
} from '../js/api.js';
import { protocolOf, providerOf, supportsFastMode } from '../js/config.js';
import { renderMarkdown } from '../js/ui.js';
import { createFS } from '../js/sandbox.js';
import { createStore } from '../js/state.js';
import { estimateTokens, compactMessages, truncateToolContent, contextBudgetFor } from '../js/context.js';
import { thinkingParamsFor } from '../js/config.js';
import { SUBAGENTS, findSubagent, subagentGuide } from '../js/subagents.js';
import { TOOL_DEFS, executeTool } from '../js/tools.js';
import { createAgent, copyAttachmentsToFS } from '../js/agent.js';

// 联网开关在本轮改动里默认是开的（走模型 API 自带格式），而下面这些既有用例只校验
// /v1/chat/completions 与 /v1/messages 两条端点的解析与循环 —— 统一关掉，避免它们改道 /v1/responses。
// 联网本身有独立的用例组（见「联网：模型 API 自带请求格式」）。
const storeNoWeb = (st) => { st.state.settings.webEnabled = false; return st; };

// 排空上一用例遗留的持久化防抖定时器（state.save 用 300ms setTimeout），
// 避免它的写入串进下一个用例的 localStorage 桩
const drainSaves = () => new Promise((r) => setTimeout(r, 350));
// 命名空间引用：新增用例集中使用，避免与顶部具名 import 冲突
const cfg = await import('../js/config.js');
const api = await import('../js/api.js');

let passed = 0;
const queue = [];
const group = (name) => queue.push({ group: name });
const test = (name, fn) => queue.push({ name, fn }); // 支持 async：末尾统一顺序 await

group('协议路由');
test('Claude → anthropic 原生协议', () => {
  assert.equal(protocolOf('claude-sonnet-5'), 'anthropic');
  assert.equal(protocolOf('claude-fable-5-1'), 'anthropic');
  assert.equal(providerOf('claude-opus-5'), 'Anthropic');
});
test('其余模型 → openai 兼容协议', () => {
  assert.equal(protocolOf('gpt-5.6-sol'), 'openai');
  assert.equal(protocolOf('gemini-3.5-flash'), 'openai');
  assert.equal(protocolOf('deepseek-v4-pro'), 'openai');
  assert.equal(protocolOf('glm-5.3'), 'openai');
  assert.equal(protocolOf('grok-4.6'), 'openai');
});
test('Fast mode 仅 OpenAI 系', () => {
  assert.equal(supportsFastMode('gpt-6-astra'), true);
  assert.equal(supportsFastMode('claude-sonnet-5'), false);
});
test('认证头映射（调研结论）', () => {
  const a = authHeaders('anthropic', 'sk-teamo-x');
  assert.equal(a['x-api-key'], 'sk-teamo-x');
  assert.equal(a['anthropic-version'], '2023-06-01');
  const o = authHeaders('openai', 'sk-teamo-x');
  assert.equal(o['Authorization'], 'Bearer sk-teamo-x');
});

group('SSE 解析器');
test('跨 chunk 切分的行能被正确拼接', () => {
  const out = [];
  const feed = createSSEParser((j) => out.push(j));
  feed('data: {"a":');
  feed('1}\n\ndata: {"a":2}\r\n');
  feed('data: [DONE]\n');
  assert.deepEqual(out, [{ a: 1 }, { a: 2 }, null]);
});
test('忽略非 data 行与坏 JSON', () => {
  const out = [];
  const feed = createSSEParser((j) => out.push(j));
  feed('event: ping\n: comment\ndata: {bad json}\ndata: {"ok":true}\n\n');
  assert.deepEqual(out, [{ ok: true }]);
});

group('OpenAI 流归一化');
test('文本增量 + usage + finish', () => {
  const evs = [];
  const h = createOpenAIStream((e) => evs.push(e));
  h({ choices: [{ delta: { content: '你' } }] });
  h({ choices: [{ delta: { content: '好' } }] });
  h({ usage: { prompt_tokens: 21, completion_tokens: 7 }, choices: [] });
  h({ choices: [{ delta: {}, finish_reason: 'stop' }] });
  assert.deepEqual(evs.filter((e) => e.type === 'text').map((e) => e.text), ['你', '好']);
  assert.deepEqual(evs.find((e) => e.type === 'usage').usage, { input: 21, output: 7 });
  assert.equal(evs.find((e) => e.type === 'finish').reason, 'stop');
});
test('tool_calls 分片累积（index 对齐 + 参数拼接）', () => {
  const evs = [];
  const h = createOpenAIStream((e) => evs.push(e));
  h({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'execute_javascript', arguments: '' } }] } }] });
  h({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"code":' } }] } }] });
  h({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"1+1"}' } }] } }] });
  h({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'get_current_time', arguments: '{}' } }] } }] });
  const acc = createToolCallAccumulator();
  evs.filter((e) => e.type === 'tool_delta').forEach((e) => acc.push(e));
  const calls = acc.result();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].id, 'call_a');
  assert.equal(calls[0].name, 'execute_javascript');
  assert.deepEqual(calls[0].args, { code: '1+1' });
  assert.equal(calls[1].name, 'get_current_time');
});

group('Anthropic 流归一化');
test('事件序列 message_start → delta → message_delta', () => {
  const evs = [];
  const h = createAnthropicStream((e) => evs.push(e));
  h({ type: 'message_start', message: { usage: { input_tokens: 159, output_tokens: 1 } } });
  h({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  h({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } });
  h({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '!' } });
  h({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 34 } });
  h({ type: 'message_stop' });
  assert.deepEqual(evs.find((e) => e.type === 'usage').usage, { input: 159, output: 1 });
  assert.equal(evs.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'Hello!');
  assert.equal(evs.filter((e) => e.type === 'usage').pop().usage.output, 34);
  assert.equal(evs.find((e) => e.type === 'finish').reason, 'tool_use');
});
test('tool_use 块 + input_json_delta 拼接', () => {
  const evs = [];
  const h = createAnthropicStream((e) => evs.push(e));
  h({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_01', name: 'execute_python' } });
  h({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"code": "pri' } });
  h({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'nt(1)"}' } });
  const acc = createToolCallAccumulator();
  evs.filter((e) => e.type === 'tool_delta').forEach((e) => acc.push(e));
  const calls = acc.result();
  assert.equal(calls[0].id, 'toolu_01');
  assert.equal(calls[0].name, 'execute_python');
  assert.deepEqual(calls[0].args, { code: 'print(1)' });
});
test('坏 JSON 参数降级为 __raw', () => {test('replace 语义：done 的完整 arguments 覆盖而非叠加', () => {
  // Responses 协议既流式给 delta、又在 output_item.done 里给全量 arguments；
  // 聚合器必须用 replace 覆盖，否则参数变成两份拼接的坏 JSON（真实踩过）。
  const acc = createToolCallAccumulator();
  acc.push({ index: 0, id: 'c1', name: 'f', argsText: '' });
  acc.push({ index: 0, argsText: '{"a":1}' });
  acc.push({ index: 0, argsText: '{"a":1}', replace: true });
  assert.deepEqual(acc.result()[0].args, { a: 1 });
  acc.push({ index: 0, argsText: '', replace: true }); // 空全量不得抹掉已有增量
  assert.deepEqual(acc.result()[0].args, { a: 1 });
});

  const acc = createToolCallAccumulator();
  acc.push({ index: 0, id: 'x', name: 'f', argsText: '{broken' });
  assert.deepEqual(acc.result()[0].args, { __raw: '{broken' });
});

group('Anthropic 思考块捕获与回传（P0-2）');
test('thinking / redacted_thinking / signature_delta 事件被归一化', () => {
  const evs = [];
  const h = createAnthropicStream((e) => evs.push(e));
  h({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
  h({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先算' } });
  h({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '再答' } });
  h({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-123' } });
  h({ type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'ENC==' } });
  h({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_9', name: 'write_file' } });
  const starts = evs.filter((e) => e.type === 'block_start');
  assert.deepEqual(starts.map((e) => e.block.type), ['thinking', 'redacted_thinking']);
  const sig = evs.find((e) => e.type === 'signature_delta');
  assert.equal(sig.index, 0);
  assert.equal(sig.signature, 'sig-123');
  const reasonings = evs.filter((e) => e.type === 'reasoning');
  assert.equal(reasonings.length, 2);
  assert.equal(reasonings[0].index, 0, 'reasoning 事件需携带块 index 以便归属');
});
test('createThinkingTracker：按流内顺序拼装，仅保留可回传的块', () => {
  const tb = createThinkingTracker();
  tb.start(0, { type: 'thinking' });
  tb.delta(0, '让我');
  tb.delta(0, '想想');
  tb.signature(0, 'sig-A');
  tb.start(1, { type: 'redacted_thinking', data: 'ENC==' });
  tb.start(2, { type: 'thinking' });
  tb.delta(2, '第二段思考');
  // index 2 没有 signature → 不可回传，必须丢弃（API 拒收无签名块）
  const blocks = tb.blocks();
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { type: 'thinking', thinking: '让我想想', signature: 'sig-A' });
  assert.deepEqual(blocks[1], { type: 'redacted_thinking', data: 'ENC==' });
});
test('buildAnthropicPayload：思考块置于 assistant content 最前（先于 tool_use）', () => {
  const p = buildAnthropicPayload([
    { role: 'user', text: 'Q' },
    {
      role: 'assistant', text: '中间文本',
      thinkingBlocks: [
        { type: 'thinking', thinking: '推理过程', signature: 'sig-A' },
        { type: 'redacted_thinking', data: 'ENC==' },
        { type: 'thinking', thinking: '无签名，应被丢弃' },
      ],
      toolCalls: [{ id: 't1', name: 'write_file', args: { path: 'a', content: 'x' } }],
    },
    { role: 'tool', toolCallId: 't1', content: 'ok' },
  ]);
  const asst = p.messages[1];
  assert.deepEqual(asst.content.map((b) => b.type), ['thinking', 'redacted_thinking', 'text', 'tool_use']);
  assert.equal(asst.content[0].signature, 'sig-A');
  assert.equal(asst.content[0].thinking, '推理过程');
});
test('buildAnthropicPayload：includeThinking=false 时省略思考块（降级路径）', () => {
  const p = buildAnthropicPayload([
    { role: 'user', text: 'Q' },
    { role: 'assistant', text: '', thinkingBlocks: [{ type: 'thinking', thinking: 'x', signature: 's' }], toolCalls: [{ id: 't1', name: 'f', args: {} }] },
  ], { includeThinking: false });
  assert.deepEqual(p.messages[1].content.map((b) => b.type), ['tool_use']);
});

group('请求体构建');
test('OpenAI 消息转换（tool_calls / tool 结果）', () => {
  const msgs = buildOpenAIMessages([
    { role: 'system', text: 'S' },
    { role: 'user', text: 'U' },
    { role: 'assistant', text: 'T', toolCalls: [{ id: 'c1', name: 'execute_javascript', args: { code: '1' } }] },
    { role: 'tool', toolCallId: 'c1', content: 'ok' },
  ]);
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[2].tool_calls[0].function.arguments, '{"code":"1"}');
  assert.deepEqual(msgs[3], { role: 'tool', tool_call_id: 'c1', content: 'ok' });
});
test('Anthropic payload（system 提取 / tool_result 合并 / max_tokens 必填）', () => {
  const p = buildAnthropicPayload([
    { role: 'system', text: 'S1' },
    { role: 'user', text: 'U' },
    { role: 'assistant', text: '', toolCalls: [{ id: 't1', name: 'f', args: { a: 1 } }, { id: 't2', name: 'g', args: {} }] },
    { role: 'tool', toolCallId: 't1', content: 'r1' },
    { role: 'tool', toolCallId: 't2', content: 'r2' },
  ]);
  assert.equal(p.system, 'S1');
  assert.equal(p.max_tokens, 8192);
  const asst = p.messages[1];
  assert.equal(asst.content.length, 2);
  assert.equal(asst.content[0].type, 'tool_use');
  // 两条 tool 结果必须合并进同一条 user 消息
  const user = p.messages[2];
  assert.equal(user.role, 'user');
  assert.equal(user.content.length, 2);
  assert.deepEqual(user.content.map((b) => b.tool_use_id), ['t1', 't2']);
});
test('工具 schema 双格式转换', () => {
  const defs = [{ name: 'f', description: 'd', parameters: { type: 'object', properties: {} } }];
  assert.equal(toOpenAITools(defs)[0].function.name, 'f');
  assert.equal(toAnthropicTools(defs)[0].input_schema.type, 'object');
});

group('Markdown 渲染（UI）');
test('HTML 转义防 XSS', () => {
  const html = renderMarkdown('<script>alert(1)</script> 与 <img onerror=x>');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});
test('代码块 / 行内代码 / 加粗', () => {
  const html = renderMarkdown('用 `pip install` 安装：\n```python\nprint("hi")\n```');
  assert.ok(html.includes('<pre data-lang="python">'));
  assert.ok(html.includes('print(&quot;hi&quot;)'));
  assert.ok(html.includes('<code>pip install</code>'));
  assert.ok(renderMarkdown('**粗体**').includes('<strong>粗体</strong>'));
});

group('虚拟文件系统 / 回滚（state）');
test('FS 读写列举', () => {
  const fs = createFS();
  fs.write('a.txt', 'hello');
  fs.write('dir/b.md', '# t');
  assert.equal(fs.read('a.txt'), 'hello');
  assert.equal(fs.list().length, 2);
  assert.throws(() => fs.read('nope.txt'));
});
test('检查点回滚 + 一步撤销', () => {
  const store = storeNoWeb(createStore());
  // 真实时序：createCheckpoint（记录当前消息数）→ pushMessage
  store.createCheckpoint('第一问');
  store.pushMessage({ role: 'user', text: '第一问' });
  store.pushMessage({ role: 'assistant', text: '第一答', done: true });
  store.createCheckpoint('第二问');
  store.pushMessage({ role: 'user', text: '第二问' });
  store.pushMessage({ role: 'assistant', text: '第二答', done: true });
  assert.equal(store.state.messages.length, 4);
  const cp2 = store.state.checkpoints.find((c) => c.label === '第二问');
  assert.equal(cp2.messageCount, 2);
  assert.ok(store.rollbackTo(cp2.id));
  assert.equal(store.state.messages.length, 2);
  assert.equal(store.state.messages[1].text, '第一答');
  assert.ok(store.undoRollback());
  assert.equal(store.state.messages.length, 4);
  assert.equal(store.state.messages[3].text, '第二答');
});
test('dropLastAssistantTurn 保留 user 消息（重新生成）', () => {
  const store = storeNoWeb(createStore());
  store.createCheckpoint('Q');
  store.pushMessage({ role: 'user', text: 'Q' });
  store.pushMessage({ role: 'assistant', text: 'A1', toolCalls: [{ id: 'c', name: 'f', args: {} }] });
  store.pushMessage({ role: 'tool', toolCallId: 'c', content: 'r' });
  store.pushMessage({ role: 'assistant', text: 'A2', done: true });
  assert.equal(store.dropLastAssistantTurn(), 3);
  assert.equal(store.state.messages.length, 1);
  assert.equal(store.state.messages[0].role, 'user');
});

group('附件（多模态双协议）');
const IMG_ATT = { kind: 'image', name: 'p.png', mime: 'image/png', size: 10, dataUrl: 'data:image/png;base64,AAA' };
const TXT_ATT = { kind: 'text', name: 'n.csv', mime: 'text/csv', size: 5, text: 'a,b' };
test('OpenAI：图片 → image_url(data URL)，文本 → text part', () => {
  const [m] = buildOpenAIMessages([{ role: 'user', text: '看图', attachments: [IMG_ATT, TXT_ATT] }]);
  assert.equal(m.content[0].text, '看图');
  assert.equal(m.content[1].type, 'image_url');
  assert.equal(m.content[1].image_url.url, 'data:image/png;base64,AAA');
  assert.ok(m.content[2].text.includes('【附件：n.csv】'));
});
test('Anthropic：图片 → source.base64 块，stripped 附件 → 省略说明', () => {
  const p = buildAnthropicPayload([{ role: 'user', text: '看图', attachments: [IMG_ATT, { kind: 'text', name: 'x.txt', stripped: true }] }]);
  const content = p.messages[0].content;
  assert.equal(content[1].type, 'image');
  assert.equal(content[1].source.media_type, 'image/png');
  assert.equal(content[1].source.data, 'AAA');
  assert.ok(content[2].text.includes('已省略'));
});
test('无附件消息保持原格式（缓存友好）', () => {
  const [m] = buildOpenAIMessages([{ role: 'user', text: 'hi' }]);
  assert.equal(m.content, 'hi');
  const p = buildAnthropicPayload([{ role: 'user', text: 'hi' }]);
  assert.equal(p.messages[0].content, 'hi');
});

group('上下文管理');
test('token 估算：CJK ≈ 1/字，ASCII ≈ 1/4 字符', () => {
  const cjk = estimateTokens([{ role: 'user', text: '中'.repeat(100) }]);
  const ascii = estimateTokens([{ role: 'user', text: 'a'.repeat(400) }]);
  assert.ok(cjk >= 100 && cjk < 130, `cjk=${cjk}`);
  assert.ok(ascii >= 100 && ascii < 130, `ascii=${ascii}`);
});
// 关键不变量：每个 tool 消息前面必须存在携带对应 toolCall 的 assistant
const assertNoOrphan = (messages) => {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== 'tool') continue;
    const owner = messages.slice(0, i).reverse().find((m) => m.role === 'assistant' && (m.toolCalls || []).some((t) => t.id === messages[i].toolCallId));
    assert.ok(owner, `孤儿 tool 消息: ${messages[i].toolCallId}`);
  }
};
const buildRounds = (n) => {
  const msgs = [];
  for (let i = 0; i < n; i++) {
    msgs.push({ role: 'user', text: `问题${i} ${'x'.repeat(2000)}` });
    msgs.push({ role: 'assistant', text: '', toolCalls: [{ id: `c${i}`, name: 'f', args: {} }] });
    msgs.push({ role: 'tool', toolCallId: `c${i}`, content: `结果${i} ${'y'.repeat(3000)}` });
    msgs.push({ role: 'assistant', text: `回答${i}`, done: true });
  }
  return msgs;
};

// P0-1 回归：预算充足时，工具结果必须原样送达模型（此前被无条件砍到 1500 字符）
test('compactMessages：预算充足时零截断、零丢弃', () => {
  const tool = '结果行\n'.repeat(1500); // 6000 字符
  const msgs = [
    { role: 'user', text: '跑一下这段代码' },
    { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'execute_python', args: { code: 'x' } }] },
    { role: 'tool', toolCallId: 'c1', content: tool },
  ];
  for (const budget of [150000, 90000, 55000]) {
    const { messages, droppedCount } = compactMessages(msgs, budget);
    assert.equal(droppedCount, 0, `budget=${budget} 不应丢弃`);
    assert.equal(messages.length, 3);
    assert.equal(messages[2].content.length, tool.length, `budget=${budget} 工具结果被无谓截断`);
  }
});
test('compactMessages：子智能体报告（4000 字符）在预算充足时完整送达', () => {
  const report = '报告内容\n'.repeat(1200).slice(0, 4000);
  const msgs = [
    { role: 'user', text: '委派任务' },
    { role: 'assistant', text: '', toolCalls: [{ id: 'c2', name: 'dispatch_subagent', args: {} }] },
    { role: 'tool', toolCallId: 'c2', content: report },
  ];
  const { messages } = compactMessages(msgs, 150000);
  assert.equal(messages[2].content.length, report.length);
});

test('compactMessages：预算收紧时优先截断历史工具结果，保住全部轮次与本轮结果', () => {
  const msgs = buildRounds(30);
  const { messages, droppedCount } = compactMessages(msgs, 20000);
  assert.ok(estimateTokens(messages) <= 20000, `压缩后 ${estimateTokens(messages)}`);
  assert.equal(droppedCount, 0, '截断即可满足预算时不应丢轮次');
  assert.equal(messages.length, 120, '全部 30 轮都应保留');
  assertNoOrphan(messages);
  assert.equal(messages[messages.length - 1].text, '回答29', '最新消息必须保留');
  // 本轮（最后一条 user 之后）的工具结果必须完整
  assert.equal(messages[messages.length - 2].content, msgs[msgs.length - 2].content, '本轮工具结果必须完整');
});

test('compactMessages：极端预算下整轮丢弃，不产生孤儿 tool 消息', () => {
  const msgs = buildRounds(30);
  const { messages, droppedCount } = compactMessages(msgs, 3000);
  assert.ok(droppedCount > 0, '极端预算应触发整轮丢弃');
  assert.ok(estimateTokens(messages) <= 3000, `压缩后 ${estimateTokens(messages)}`);
  assertNoOrphan(messages);
  assert.equal(messages[messages.length - 1].text, '回答29', '最新消息必须保留');
});

// P1-1 回归：单条巨型 user 消息（如粘贴 400KB 文件）不得绕过压缩
test('compactMessages：单条巨型 user 消息不再绕过压缩', () => {
  for (const [size, budget] of [[400000, 20000], [200000, 20000], [512000, 90000]]) {
    const { messages } = compactMessages([{ role: 'user', text: 'z'.repeat(size) }], budget);
    assert.ok(estimateTokens(messages) <= budget, `size=${size} 压缩后 ${estimateTokens(messages)} > ${budget}`);
    assert.ok(messages[0].text.length < size, '应已截断');
  }
});
test('compactMessages：单轮超长工具结果（无轮次边界）也能落入预算', () => {
  const msgs = [
    { role: 'user', text: 'Q' },
    { role: 'assistant', text: '', toolCalls: [{ id: 'c0', name: 'f', args: {} }] },
    { role: 'tool', toolCallId: 'c0', content: 'y'.repeat(500000) },
  ];
  const { messages } = compactMessages(msgs, 20000);
  assert.ok(estimateTokens(messages) <= 20000, `压缩后 ${estimateTokens(messages)}`);
  assertNoOrphan(messages);
});
test('truncateToolContent 保头尾、报省略量', () => {
  const s = 'A'.repeat(5000) + 'MID' + 'B'.repeat(5000);
  const t = truncateToolContent(s, 1000);
  assert.ok(t.length < 1200);
  assert.ok(t.startsWith('AAAA'));
  assert.ok(t.endsWith('BBBB'));
  assert.ok(t.includes('省略'));
  assert.equal(truncateToolContent('short'), 'short');
});
test('上下文预算按模型家族', () => {
  assert.equal(contextBudgetFor('claude-sonnet-5'), 150000);
  assert.equal(contextBudgetFor('gemini-3.5-flash'), 400000);
  assert.equal(contextBudgetFor('unknown-model'), 90000);
});

group('思考模式参数路由');
test('Claude → thinking.budget_tokens', () => {
  const p = thinkingParamsFor('claude-sonnet-5');
  assert.equal(p.thinking.type, 'enabled');
  assert.ok(p.thinking.budget_tokens >= 1024);
});
test('GPT/Gemini/Grok → reasoning_effort', () => {
  assert.equal(thinkingParamsFor('gpt-5.6-sol').reasoning_effort, 'medium');
  assert.equal(thinkingParamsFor('gemini-3.5-flash').reasoning_effort, 'medium');
  assert.equal(thinkingParamsFor('grok-4.6').reasoning_effort, 'medium');
});
test('DeepSeek → reasoning；GLM → thinking.type', () => {
  assert.equal(thinkingParamsFor('deepseek-v4-pro').reasoning, true);
  assert.equal(thinkingParamsFor('glm-5.3').thinking.type, 'enabled');
});

group('子智能体注册表');
test('≥16 个子智能体且 ID 唯一', () => {
  assert.ok(SUBAGENTS.length >= 16, `实际 ${SUBAGENTS.length}`);
  assert.equal(new Set(SUBAGENTS.map((a) => a.id)).size, SUBAGENTS.length);
});
test('工具子集必须存在于 TOOL_DEFS，且不含 dispatch（防递归）', () => {
  const valid = new Set(TOOL_DEFS.map((t) => t.name));
  for (const a of SUBAGENTS) {
    for (const t of a.tools) {
      assert.ok(valid.has(t), `${a.id} 引用未知工具 ${t}`);
      assert.notEqual(t, 'dispatch_subagent', `${a.id} 不得再委派`);
    }
    assert.ok(a.prompt.length > 30 && a.description && a.name && a.tag, `${a.id} 字段不完整`);
  }
});
test('dispatch_subagent 工具已注册且 enum 覆盖全部子智能体', () => {
  const d = TOOL_DEFS.find((t) => t.name === 'dispatch_subagent');
  assert.ok(d, '未注册');
  const en = d.parameters.properties.agent.enum;
  assert.equal(en.length, SUBAGENTS.length);
  assert.ok(findSubagent('code-reviewer'));
  assert.ok(subagentGuide().includes('dispatch_subagent'));
});

group('多会话');
test('创建/切换/删除会话，活动会话引用正确同步', () => {
  const store = storeNoWeb(createStore());
  store.createCheckpoint('A');
  store.pushMessage({ role: 'user', text: '会话A的消息' });
  const s1 = store.state.activeSessionId;
  const s2 = store.createSession();
  assert.equal(store.state.messages.length, 0, '新会话应为空');
  store.pushMessage({ role: 'user', text: '会话B的消息' });
  assert.ok(store.switchSession(s1));
  assert.equal(store.state.messages.length, 1);
  assert.equal(store.state.messages[0].text, '会话A的消息');
  assert.equal(store.state.sessions.find((s) => s.id === s1).title, '会话A的消息', '自动标题');
  assert.ok(store.deleteSession(s2.id));
  assert.equal(store.state.sessions.length, 1);
  assert.equal(store.state.activeSessionId, s1);
});
test('删除最后一个会话时自动补新会话', () => {
  const store = storeNoWeb(createStore());
  const id = store.state.activeSessionId;
  store.deleteSession(id);
  assert.equal(store.state.sessions.length, 1);
  assert.notEqual(store.state.activeSessionId, id);
});

group('导入会话');
test('importSession：导入导出 JSON 会新建并激活会话', () => {
  const store = storeNoWeb(createStore());
  const before = store.state.sessions.length;
  const s = store.importSession({
    title: '我的导出会话',
    messages: [
      { id: 'old-1', role: 'user', text: '你好', attachments: [{ kind: 'text', name: 'a.txt', size: 12, stripped: true }] },
      { id: 'old-2', role: 'assistant', text: '你好！', usage: { input_tokens: 3, output_tokens: 2 } },
      { role: 'tool', toolCallId: 't1', name: 'read_file', content: 'ok' },
    ],
  });
  assert.ok(s, '返回新会话');
  assert.equal(store.state.sessions.length, before + 1);
  assert.equal(store.state.activeSessionId, s.id, '导入后立即激活');
  assert.equal(s.title, '我的导出会话', '优先用导出标题');
  assert.equal(s.messages.length, 3);
  assert.notEqual(s.messages[0].id, 'old-1', '消息重新分配 id');
  assert.equal(s.messages[0].attachments[0].data, null, '附件不携带内容（stripped）');
  assert.equal(store.state.messages[1].text, '你好！', '根级引用同步到导入会话');
  assert.equal(store.state.stats.totalMs, 0, '新会话计时从零开始');
});
test('importSession：非法数据返回 null 且不改变状态', () => {
  const store = storeNoWeb(createStore());
  const before = store.state.sessions.length;
  assert.equal(store.importSession(null), null);
  assert.equal(store.importSession({}), null);
  assert.equal(store.importSession({ messages: [] }), null);
  assert.equal(store.importSession({ messages: [{ role: 'system' }] }), null, '无有效角色消息');
  assert.equal(store.state.sessions.length, before);
});

group('多模态标识');
test('supportsVision：按型号家族判定图片输入支持', async () => {
  const { supportsVision } = await import('../js/config.js');
  assert.ok(supportsVision('claude-sonnet-5'), 'Claude 全系');
  assert.ok(supportsVision('gpt-5.6-sol') && supportsVision('gpt-4o'), 'GPT 4o/5/6');
  assert.ok(supportsVision('gemini-3.8-flash'), 'Gemini 全系');
  assert.ok(supportsVision('deepseek-vision') && supportsVision('glm-4.5v'), 'vision/v 字样');
  assert.ok(!supportsVision('deepseek-v4-pro'), 'deepseek-v4 是版本号非视觉');
  assert.ok(!supportsVision('glm-5.3-flash') && !supportsVision(''), '文本模型/空值');
});

group('Markdown 渲染');
test('renderMarkdown：完整 Markdown（markdown-it）+ KaTeX 公式', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const vm = await import('node:vm');
  const loadUmd = (rel) => {
    const p = fileURLToPath(new URL(rel, import.meta.url));
    const sandbox = {};
    sandbox.self = sandbox; sandbox.window = sandbox; sandbox.globalThis = sandbox;
    vm.runInNewContext(readFileSync(p, 'utf8'), sandbox, { filename: rel });
    return sandbox;
  };
  globalThis.markdownit = loadUmd('../assets/md/markdown-it.min.js').markdownit;
  globalThis.katex = loadUmd('../assets/katex/katex.min.js').katex;
  assert.equal(typeof globalThis.markdownit, 'function', 'markdown-it UMD 加载失败');
  assert.equal(typeof globalThis.katex, 'object', 'katex UMD 加载失败');
  // 全新模块实例（顶部静态 import 的实例已在无全局环境下把引擎缓存为 null）
  const { renderMarkdown } = await import('../js/ui.js?md=' + Date.now());
  // 表格
  const table = renderMarkdown('| 模型 | 价格 |\n|---|---|\n| A | $0 |');
  assert.ok(table.includes('<table>') && table.includes('<th>模型</th>'), '表格渲染');
  // 任务列表 / 删除线 / 分割线 / 嵌套列表 / 引用
  const task = renderMarkdown('- [x] 完成\n- [ ] 待办');
  assert.ok(task.includes('type="checkbox"') && task.includes('checked'), '任务列表');
  assert.ok(renderMarkdown('~~旧~~').includes('<s>'), '删除线');
  assert.ok(renderMarkdown('---').includes('<hr'), '分割线');
  const nested = renderMarkdown('- a\n  - b');
  assert.equal((nested.match(/<ul>/g) || []).length, 2, '嵌套列表');
  assert.ok(renderMarkdown('> 引用').includes('<blockquote>'), '引用块');
  // 自动链接（新窗口 + noopener）
  const link = renderMarkdown('见 https://example.com');
  assert.ok(link.includes('href="https://example.com"') && link.includes('target="_blank"') && link.includes('noopener'), '自动链接');
  // XSS：原始 HTML 必须被转义
  assert.ok(!renderMarkdown('<script>alert(1)</script>').includes('<script>'), '原始 HTML 转义');
  // 代码块：语言标注 + 复制按钮 + 不套 <p>
  const pre = renderMarkdown('```python\nprint(1)\n```');
  assert.ok(pre.includes('data-lang="python"') && pre.includes('copy-code'), '围栏代码块');
  assert.ok(!/<p><pre/.test(pre), '代码块不包 p');
  // 公式：行内 + 块级
  assert.ok(renderMarkdown('行内 $a^2$ 结束').includes('class="katex"'), '行内公式');
  assert.ok(renderMarkdown('$$\\frac{a}{b}$$').includes('katex-display'), '块级公式');
});
test('renderMarkdown：markdown-it 缺失时回退精简渲染器', async () => {
  const savedMd = globalThis.markdownit;
  globalThis.markdownit = undefined;
  // 重新载入模块以获得未初始化状态的渲染器
  const { renderMarkdown } = await import('../js/ui.js?fallback=' + Date.now());
  const out = renderMarkdown('**粗** 和 `code` 与 $x^2$');
  assert.ok(out.includes('<strong>粗</strong>'), '回退渲染加粗');
  assert.ok(out.includes('<code>code</code>'), '回退渲染行内代码');
  assert.ok(!out.includes('<script>'), '回退渲染安全');
  globalThis.markdownit = savedMd;
});
test('systemPrompt / 子智能体：注入输出规范', async () => {
  const { systemPrompt, OUTPUT_SPEC } = await import('../js/config.js');
  assert.ok(OUTPUT_SPEC.includes('Markdown') && OUTPUT_SPEC.includes('KaTeX'), '规范含 Markdown/KaTeX');
  assert.ok(OUTPUT_SPEC.includes('表格') && OUTPUT_SPEC.includes('围栏代码块'), '规范含表格/代码块要求');
  assert.ok(systemPrompt().includes('输出规范'), '主提示词含输出规范');
});

group('持久化（P0-3 回归：关闭页面不得丢最后一轮）');
test('save(true) 同步落盘，不依赖 300ms 防抖定时器', async () => {
  // 先排空前序用例遗留的 300ms 防抖定时器：否则它的写入会落进本用例的 localStorage 桩，
  // 使「防抖未触发前不写入」的断言变成时序竞速（偶发误判）
  await drainSaves();
  const realLS = globalThis.localStorage;
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
  try {
    // 全新模块实例，确保读到上面这个 localStorage 桩
    const { createStore } = await import('../js/state.js?imm=' + Date.now());
    const store = storeNoWeb(createStore());
    store.pushMessage({ role: 'user', text: '最后一轮对话' });
    const key = 'teamo-agent-state-v1-v2';

    // 防抖版：定时器未触发前不应写入
    store.save();
    assert.equal(mem.get(key), undefined, '防抖版 save() 不应立即写入');

    // 同步版（beforeunload / visibilitychange 走这条）：必须立刻写入
    store.save(true);
    const raw = mem.get(key);
    assert.ok(raw, 'save(true) 必须立即落盘');
    const saved = JSON.parse(raw);
    assert.ok(
      saved.sessions.some((s) => (s.messages || []).some((m) => m.text === '最后一轮对话')),
      '最后一轮对话必须已持久化',
    );
  } finally {
    if (realLS === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = realLS;
  }
});

group('持久化体积（P1-3：先预估再序列化，超限自动瘦身）');
test('小体积状态：图片 dataUrl 原样持久化', async () => {
  await drainSaves();
  const mem = new Map();
  const realLS = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
  try {
    const { createStore } = await import('../js/state.js?small=' + Date.now());
    const store = storeNoWeb(createStore());
    store.pushMessage({ role: 'user', text: '看图', attachments: [{ kind: 'image', name: 'p.png', size: 10, dataUrl: 'data:image/png;base64,AAA' }] });
    store.save(true);
    const saved = JSON.parse(mem.get('teamo-agent-state-v1-v2'));
    const att = saved.sessions[0].messages.find((m) => m.role === 'user').attachments[0];
    assert.equal(att.dataUrl, 'data:image/png;base64,AAA', '小体积不应剥离图片');
  } finally {
    if (realLS === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = realLS;
  }
});
test('超大状态（含 5MB 图片）：走瘦身路径，剥离 dataUrl 且不破坏结构', async () => {
  await drainSaves();
  const mem = new Map();
  const realLS = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
  try {
    const { createStore } = await import('../js/state.js?big=' + Date.now());
    const store = storeNoWeb(createStore());
    store.pushMessage({
      role: 'user', text: '大图',
      attachments: [{ kind: 'image', name: 'big.png', size: 5 * 1024 * 1024, dataUrl: 'data:image/png;base64,' + 'A'.repeat(5 * 1024 * 1024) }],
    });
    store.save(true);
    const raw = mem.get('teamo-agent-state-v1-v2');
    assert.ok(raw && raw.length < 100000, `瘦身后应远小于原图体积（实际 ${raw.length}）`);
    const saved = JSON.parse(raw);
    const att = saved.sessions[0].messages.find((m) => m.role === 'user').attachments[0];
    assert.equal(att.dataUrl, undefined, '超限必须剥离 dataUrl');
    assert.equal(att.stripped, true, '标记已省略（后续请求发送省略说明）');
  } finally {
    if (realLS === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = realLS;
  }
});

group('Agent 工具循环（mock SSE 端到端）');
// ── mock fetch 工具：把协议事件序列封装成 SSE 响应 ──
const sseEv = (o) => 'data: ' + JSON.stringify(o) + '\n\n';
const sseDone = 'data: [DONE]\n\n';
const sseResponse = (text, status = 200) => new Response(
  new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } }),
  { status, headers: { 'content-type': 'text/event-stream' } },
);
const openaiToolTurn = (id, name, argsJson) => sseResponse(
  sseEv({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: argsJson } }] } }] })
  + sseEv({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + sseDone);
const openaiTextTurn = (text) => sseResponse(
  sseEv({ choices: [{ delta: { content: text } }] })
  + sseEv({ usage: { prompt_tokens: 7, completion_tokens: 3 }, choices: [] })
  + sseEv({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + sseDone);
const anthropicTextTurn = (text) => sseResponse(
  sseEv({ type: 'message_start', message: { usage: { input_tokens: 20, output_tokens: 1 } } })
  + sseEv({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  + sseEv({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
  + sseEv({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } })
  + sseEv({ type: 'message_stop' }) + sseDone);
// Claude 回合：思考块（含 signature）+ tool_use —— P0-2 的核心场景
const anthropicThinkingToolTurn = () => sseResponse(
  sseEv({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } })
  + sseEv({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
  + sseEv({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '需要写入文件' } })
  + sseEv({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-replay' } })
  + sseEv({ type: 'content_block_stop', index: 0 })
  + sseEv({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_r1', name: 'write_file' } })
  + sseEv({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"r.txt",' } })
  + sseEv({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"content":"replay"}' } })
  + sseEv({ type: 'content_block_stop', index: 1 })
  + sseEv({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 60 } })
  + sseEv({ type: 'message_stop' }) + sseDone);

const realFetch = globalThis.fetch;
const mockFetch = (responses, calls) => {
  globalThis.fetch = async (url, opts) => {
    const call = { url: String(url), opts };
    try { call.body = JSON.parse(opts && opts.body); } catch { /* GET 无 body */ }
    calls.push(call);
    return responses.shift();
  };
};

test('工具循环：调用 → 结果回填 → 结束回合（OpenAI 协议）', async () => {
  const calls = [];
  mockFetch([
    openaiToolTurn('call_1', 'write_file', JSON.stringify({ path: 'a.txt', content: 'hi' })),
    openaiTextTurn('已写入'),
  ], calls);
  try {
    const store = storeNoWeb(createStore());
    store.state.apiKey = 'sk-teamo-test';
    store.state.model = 'gpt-5.6-sol';
    const agent = createAgent(store, {});
    await agent.send('创建文件 a.txt 内容 hi');
    const roles = store.state.messages.map((m) => m.role);
    assert.deepEqual(roles, ['user', 'assistant', 'tool', 'assistant']);
    assert.equal(store.state.messages[1].toolCalls[0].name, 'write_file');
    assert.ok(store.state.messages[2].content.includes('a.txt'), '工具结果应回填');
    assert.equal(store.state.messages[3].text, '已写入');
    assert.equal(store.state.messages[3].usage.output, 3, 'usage 归一');
    assert.equal(agent.fs.read('a.txt'), 'hi', '工具副作用对虚拟 FS 可见');
    assert.equal(calls.length, 2);
    assert.ok(calls[0].url.includes('/v1/chat/completions'));
    // 第二次请求必须携带 tool 结果
    assert.ok(calls[1].body.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_1'));
    assert.equal(agent.getStatus(), 'done');
  } finally { globalThis.fetch = realFetch; }
});

test('工具循环：迭代上限（TOOL_LOOP_MAX）后停止并告知用户', async () => {
  const { TOOL_LOOP_MAX } = await import('../js/config.js');
  let n = 0;
  globalThis.fetch = async () => { n++; return openaiToolTurn(`call_${n}`, 'write_file', JSON.stringify({ path: `f${n}.txt`, content: 'x' })); };
  try {
    const store = storeNoWeb(createStore());
    store.state.apiKey = 'sk-teamo-test';
    store.state.model = 'gpt-5.6-sol';
    const agent = createAgent(store, {});
    await agent.send('一直写文件');
    assert.equal(n, TOOL_LOOP_MAX, '应按上限停止请求');
    const last = store.state.messages[store.state.messages.length - 1];
    assert.ok(last.text.includes('上限'), '上限提示落盘');
    assert.equal(agent.getStatus(), 'done');
  } finally { globalThis.fetch = realFetch; }
});

test('工具循环：坏 JSON 参数不执行，反馈模型纠错', async () => {
  const calls = [];
  mockFetch([
    openaiToolTurn('call_bad', 'write_file', '{broken json'),
    openaiTextTurn('已修正'),
  ], calls);
  try {
    const store = storeNoWeb(createStore());
    store.state.apiKey = 'sk-teamo-test';
    store.state.model = 'gpt-5.6-sol';
    const agent = createAgent(store, {});
    await agent.send('写文件');
    const toolMsg = store.state.messages.find((m) => m.role === 'tool');
    assert.ok(toolMsg.content.includes('不是合法 JSON'), '反馈而非执行');
    assert.equal(agent.fs.list().length, 0, '坏参数不应产生副作用');
    assert.ok(calls[1].body.messages.some((m) => m.role === 'tool' && m.content.includes('不是合法 JSON')), '反馈送回模型');
  } finally { globalThis.fetch = realFetch; }
});

test('P0-2 端到端：Claude 思考+工具调用，第二次请求回传思考块（含 signature）', async () => {
  const calls = [];
  mockFetch([anthropicThinkingToolTurn(), anthropicTextTurn('完成')], calls);
  try {
    const store = storeNoWeb(createStore());
    store.state.apiKey = 'sk-teamo-test';
    store.state.model = 'claude-replay-test';
    store.state.settings.thinking = true;
    const agent = createAgent(store, {});
    await agent.send('写个文件');
    assert.equal(calls.length, 2);
    assert.ok(calls[0].url.endsWith('/v1/messages'), 'Claude 走原生协议');
    assert.deepEqual(calls[0].body.thinking, { type: 'enabled', budget_tokens: 4096 });
    assert.equal(calls[0].body.max_tokens, 16384, '思考模式 max_tokens 自动抬升');
    // 关键断言：第二次请求的 assistant 消息以思考块开头并携带 signature
    const asst = calls[1].body.messages.find((m) => m.role === 'assistant');
    assert.equal(asst.content[0].type, 'thinking');
    assert.equal(asst.content[0].thinking, '需要写入文件');
    assert.equal(asst.content[0].signature, 'sig-replay');
    assert.equal(asst.content[1].type, 'tool_use');
    // 后续是合并的 tool_result
    const next = calls[1].body.messages[calls[1].body.messages.indexOf(asst) + 1];
    assert.equal(next.role, 'user');
    assert.equal(next.content[0].type, 'tool_result');
    // 思考块随消息持久化；且没有触发降级
    const asstMsg = store.state.messages.find((m) => m.role === 'assistant' && m.toolCalls);
    assert.equal(asstMsg.thinkingBlocks[0].signature, 'sig-replay');
    assert.equal(thinkingDisabledFor('claude-replay-test'), false, '不得再静默关闭思考');
    assert.equal(store.state.messages[store.state.messages.length - 1].text, '完成');
  } finally { globalThis.fetch = realFetch; }
});

test('思考参数 400：去掉参数重试、记录模型并通知上层（不再静默）', async () => {
  __resetThinkingFallbackForTests();
  const calls = [];
  let notified = null;
  mockFetch([
    sseResponse(JSON.stringify({ error: { message: 'thinking is not supported for this model' } }), 400),
    anthropicTextTurn('好的'),
  ], calls);
  try {
    const store = storeNoWeb(createStore());
    store.state.apiKey = 'sk-teamo-test';
    store.state.model = 'claude-fallback-test';
    store.state.settings.thinking = true;
    const agent = createAgent(store, { onThinkingFallback: (m) => { notified = m; } });
    await agent.send('你好');
    assert.equal(notified, 'claude-fallback-test', '降级必须可感知');
    assert.ok(thinkingDisabledFor('claude-fallback-test'));
    assert.equal(calls.length, 2);
    assert.ok(calls[0].body.thinking, '首次尝试带思考参数');
    assert.equal(calls[1].body.thinking, undefined, '重试去掉思考参数');
    assert.equal(store.state.messages[store.state.messages.length - 1].text, '好的');
  } finally {
    globalThis.fetch = realFetch;
    __resetThinkingFallbackForTests();
  }
});

test('中断：流式中途 abort() → 状态 cancelled、消息标记 cancelled', async () => {
  globalThis.fetch = (url, opts) => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseEv({ choices: [{ delta: { content: '正在写…' } }] })));
        opts.signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
      },
    });
    return Promise.resolve(new Response(stream, { status: 200 }));
  };
  try {
    const store = storeNoWeb(createStore());
    store.state.apiKey = 'sk-teamo-test';
    store.state.model = 'gpt-5.6-sol';
    const agent = createAgent(store, {});
    const p = agent.send('长任务');
    await new Promise((r) => setTimeout(r, 80));
    agent.abort();
    await p;
    assert.equal(agent.getStatus(), 'cancelled');
    const last = store.state.messages[store.state.messages.length - 1];
    assert.equal(last.cancelled, true);
    assert.equal(last.done, true);
  } finally { globalThis.fetch = realFetch; }
});

group('生图模型目录（GPT Image 2 / 2.5 系列）');
test('生图模型可被识别，且不出现在对话模型兜底列表中', () => {
  const { IMAGE_MODELS, isImageModel, isImageGenModel, FALLBACK_MODELS, DEFAULT_IMAGE_MODEL } = cfg;
  const ids = IMAGE_MODELS.map((m) => m.id);
  for (const want of ['gpt-image-2', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare']) {
    assert.ok(ids.includes(want), `目录应包含 ${want}`);
  }
  for (const id of ids) {
    assert.ok(!FALLBACK_MODELS.some((m) => m.id === id), `${id} 不应作为可选对话模型`);
  }
  assert.ok(isImageModel('gpt-image-2.5-flare') && isImageGenModel('gpt-image-2'), '识别函数命中');
  assert.ok(!isImageModel('gpt-5.5') && !isImageModel('claude-sonnet-5'), '对话模型不被误判为生图模型');
  assert.equal(DEFAULT_IMAGE_MODEL, 'gpt-image-2');
});
test('模型目录对齐文档：移除已下线模型、补齐多模态模型', () => {
  const ids = cfg.FALLBACK_MODELS.map((m) => m.id);
  assert.ok(!ids.includes('gemini-3.1-flash-lite-preview'), 'gemini-3.1-flash-lite-preview 已不可用，应移除');
  assert.ok(ids.includes('deepseek-v4-flash-vision-exp'), '缺少的多模态模型应补入');
  assert.ok(cfg.supportsVision('deepseek-v4-flash-vision-exp'), '该模型应标记支持图片输入');
});
test('Kimi 供应商识别与品牌图标映射', async () => {
  assert.equal(providerOf('kimi-k2-0905'), 'Kimi');
  assert.equal(providerOf('moonshot-v1-8k'), 'Kimi');
  assert.ok(cfg.PROVIDER_ORDER.includes('Kimi'), '分组顺序中应包含 Kimi');
  const { PROVIDER_ICON } = await import('../js/icons.js');
  assert.equal(PROVIDER_ICON.Kimi.file, 'kimi.svg');
  const fs = await import('node:fs');
  const svg = fs.readFileSync(new URL('../assets/icons/kimi.svg', import.meta.url), 'utf8');
  assert.ok(svg.includes('#1783FF') && svg.includes('#FFFFFF'), '图标含品牌蓝折角与白色 K 字形');
  assert.ok(svg.length < 4096, '图标已精简（原始 1.0MB 描摹文件 → <4KB）');
});

group('图生文 / 文生图 API 层');
test('parseImageResponse：b64_json 优先，退回 url，缺数据时报错', () => {
  const { parseImageResponse } = api;
  const b64 = Buffer.from('fake').toString('base64');
  const a = parseImageResponse({ data: [{ b64_json: b64 }] }, 'png');
  assert.equal(a.dataUrl, `data:image/png;base64,${b64}`);
  assert.equal(a.ext, 'png');
  const j = parseImageResponse({ data: [{ b64_json: b64 }] }, 'jpeg');
  assert.ok(j.dataUrl.startsWith('data:image/jpeg;base64,') && j.ext === 'jpg', 'jpeg 走 image/jpeg + .jpg');
  const u = parseImageResponse({ data: [{ url: 'https://cdn/x.png' }] });
  assert.equal(u.dataUrl, 'https://cdn/x.png');
  assert.throws(() => parseImageResponse({ data: [] }), /data 为空数组/);
  assert.throws(() => parseImageResponse({}), /缺少 data 数组/);
});
test('dataUrlToBytes / bytesToDataUrl：base64 与字节往返一致', () => {
  const { dataUrlToBytes, bytesToDataUrl } = api;
  const src = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 250, 255]);
  const url = bytesToDataUrl(src, 'image/png');
  assert.ok(url.startsWith('data:image/png;base64,'));
  const back = dataUrlToBytes(url);
  assert.equal(back.mime, 'image/png');
  assert.deepEqual(Array.from(back.bytes), Array.from(src));
  assert.throws(() => dataUrlToBytes('not-a-data-url'), /data URL/);
});

group('generate_image 工具（Agent 调用生图，而非直接选模型）');
test('工具已注册且参数齐全', () => {
  const def = TOOL_DEFS.find((t) => t.name === 'generate_image');
  assert.ok(def, 'TOOL_DEFS 应包含 generate_image');
  assert.ok(def.description.includes('/v1/images/edits'), '描述应说明编辑模式');
  const props = def.parameters.properties;
  for (const k of ['prompt', 'reference_paths', 'size', 'quality', 'output_format', 'model']) {
    assert.ok(props[k], `参数 ${k} 缺失`);
  }
  assert.deepEqual(def.parameters.required, ['prompt']);
});
test('生成模式：POST /v1/images/generations + 图片落沙箱 outputs/', async () => {
  const realFetch = globalThis.fetch;
  let captured = null;
  const b64 = Buffer.from('fake-png-bytes').toString('base64');
  globalThis.fetch = async (url, opts) => {
    captured = { url, headers: opts.headers, body: JSON.parse(opts.body) };
    return new Response(JSON.stringify({ created: 1, data: [{ b64_json: b64 }] }), { status: 200 });
  };
  try {
    const fs = createFS();
    const events = [];
    const res = await executeTool('generate_image',
      { prompt: '一只在键盘上打字的橘猫，插画风格', size: '1024x1024', quality: 'high' },
      { fs, apiKey: 'sk-teamo-test', imageModel: 'gpt-image-2.5-sunburst', onUi: (p) => events.push(p) });
    assert.ok(captured.url.endsWith('/v1/images/generations'), '应走生图端点');
    assert.equal(captured.headers.Authorization, 'Bearer sk-teamo-test', '生图用 Bearer 鉴权');
    assert.equal(captured.headers['Content-Type'], 'application/json');
    assert.equal(captured.body.model, 'gpt-image-2.5-sunburst', '使用会话选定的生图模型');
    assert.equal(captured.body.size, '1024x1024');
    assert.equal(captured.body.quality, 'high');
    assert.equal(captured.body.output_format, 'png');
    assert.ok(/outputs\/image-001\.png/.test(res), '返回文案包含沙箱输出路径');
    assert.equal(fs.read('outputs/image-001.png'), `data:image/png;base64,${b64}`, '图片写入沙箱可复用');
    const ok = events.find((e) => e.status === 'ok' && e.image);
    assert.ok(ok, 'onUi 应回传 ok + 图片，供芯片渲染');
    assert.equal(ok.imagePath, 'outputs/image-001.png');
  } finally { globalThis.fetch = realFetch; }
});
test('编辑模式：reference_paths 走 /v1/images/edits（multipart，原图字节还原）', async () => {
  const realFetch = globalThis.fetch;
  let captured = null;
  const b64 = Buffer.from('edited-bytes').toString('base64');
  globalThis.fetch = async (url, opts) => {
    captured = { url, headers: opts.headers, body: opts.body };
    return new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), { status: 200 });
  };
  try {
    const origin = Buffer.from('origin-png-bytes').toString('base64');
    const fs = createFS({ 'uploads/cat.png': `data:image/png;base64,${origin}` });
    const res = await executeTool('generate_image',
      { prompt: '把背景换成雪山', reference_paths: ['uploads/cat.png'], size: '1024x1024' },
      { fs, apiKey: 'sk-teamo-test', imageModel: 'gpt-image-2', onUi: () => {} });
    assert.ok(captured.url.endsWith('/v1/images/edits'), '应走编辑端点');
    assert.ok(!captured.headers['Content-Type'], '不能手动设 Content-Type（boundary 由 FormData 生成）');
    assert.ok(captured.body instanceof FormData, '请求体应为 multipart FormData');
    assert.equal(captured.body.get('model'), 'gpt-image-2');
    assert.equal(captured.body.get('prompt'), '把背景换成雪山');
    assert.equal(captured.body.get('size'), '1024x1024');
    const file = captured.body.get('image');
    assert.equal(file.name, 'cat.png');
    assert.equal(file.type, 'image/png');
    assert.equal(Buffer.from(await file.arrayBuffer()).toString('base64'), origin, '上传字节 = 沙箱内原图字节');
    assert.ok(/outputs\/image-001\.png/.test(res), '编辑结果同样落沙箱');
    assert.ok(res.includes('reference_paths=["outputs/image-001.png"]'), '文案应提示继续编辑的方式');
  } finally { globalThis.fetch = realFetch; }
});
test('未配置 Key / 缺 prompt：不发请求并返回可读错误', async () => {
  const realFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called++; return new Response('{}', { status: 200 }); };
  try {
    const fs = createFS();
    const noKey = await executeTool('generate_image', { prompt: 'x' }, { fs, apiKey: '', onUi: () => {} });
    assert.ok(noKey.includes('API Key'), '无 Key 应提示配置');
    const noPrompt = await executeTool('generate_image', {}, { fs, apiKey: 'k', onUi: () => {} });
    assert.ok(noPrompt.includes('prompt'), '缺 prompt 应提示参数');
    assert.equal(called, 0, '两种情况都不应发起网络请求');
  } finally { globalThis.fetch = realFetch; }
});

group('用户附件自动复制到沙箱 uploads/');
test('文本与图片都落 uploads/，同名同内容复用、不同内容加序号', () => {
  const fs = createFS();
  const a = copyAttachmentsToFS(fs, [
    { kind: 'text', name: 'note.md', text: '# 会议纪要\n第一条' },
    { kind: 'image', name: 'cat.png', dataUrl: 'data:image/png;base64,AAA' },
  ]);
  assert.deepEqual(a, ['uploads/note.md', 'uploads/cat.png']);
  assert.equal(fs.read('uploads/note.md'), '# 会议纪要\n第一条');
  assert.equal(fs.read('uploads/cat.png'), 'data:image/png;base64,AAA');
  assert.deepEqual(copyAttachmentsToFS(fs, [{ kind: 'image', name: 'cat.png', dataUrl: 'data:image/png;base64,AAA' }]),
    ['uploads/cat.png'], '内容相同不应重复占位');
  assert.deepEqual(copyAttachmentsToFS(fs, [{ kind: 'image', name: 'cat.png', dataUrl: 'data:image/png;base64,BBB' }]),
    ['uploads/cat-2.png'], '同名不同内容应加序号，不覆盖上一轮');
  assert.equal(fs.read('uploads/cat.png'), 'data:image/png;base64,AAA', '原文件保持不变');
});
test('文件名安全化：路径分隔与控制字符不越出 uploads/', () => {
  const fs = createFS();
  const out = copyAttachmentsToFS(fs, [{ kind: 'text', name: '../../etc/passwd', text: 'x' }]);
  assert.deepEqual(out, ['uploads/.._.._etc_passwd']);
  assert.ok(!out[0].includes('\\') && out[0].startsWith('uploads/'));
  const empty = copyAttachmentsToFS(fs, [{ kind: 'text', name: 'a.txt', text: '' }, { kind: 'image', name: 'b.png' }]);
  assert.deepEqual(empty, [], '空内容/无数据不应写入');
});

group('会话级模型（修复：切会话后模型名被当前选择覆盖）');
test('每个会话记住自己的模型与生图模型', async () => {
  await drainSaves();
  const { createStore: makeStore } = await import('../js/state.js?sessmodel=' + Date.now());
  const store = makeStore();
  store.state.model = 'gpt-5.5';
  store.state.imageModel = 'gpt-image-2.5-flare';
  store.notify();
  const firstId = store.state.activeSessionId;
  store.createSession();
  store.state.model = 'claude-opus-5';
  store.state.imageModel = 'gpt-image-2';
  store.notify();
  const secondId = store.state.activeSessionId;
  assert.equal(store.state.sessions.find((s) => s.id === secondId).model, 'claude-opus-5');
  store.switchSession(firstId);
  assert.equal(store.state.model, 'gpt-5.5', '切回旧会话应恢复它自己的对话模型');
  assert.equal(store.state.imageModel, 'gpt-image-2.5-flare', '生图模型同样按会话恢复');
  store.switchSession(secondId);
  assert.equal(store.state.model, 'claude-opus-5', '来回切换互不污染');
});
test('assistant 消息记录生成时所用模型；连接阶段状态可见', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(sseResponse(
    sseEv({ choices: [{ delta: { content: '好的' } }] }) + sseEv({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + sseDone,
  ));
  try {
    const store = storeNoWeb(createStore());
    store.state.apiKey = 'sk-teamo-test';
    store.state.model = 'gpt-5.4-mini';
    const seen = [];
    const agent = createAgent(store, { onStatus: (s) => seen.push(s) });
    await agent.send('在吗');
    const last = [...store.state.messages].reverse().find((m) => m.role === 'assistant');
    assert.equal(last.model, 'gpt-5.4-mini', '消息应带上当轮实际使用的模型');
    assert.ok(seen.includes('connecting'), '应上报「连接模型中」阶段');
    assert.ok(seen.indexOf('connecting') < seen.indexOf('streaming'), '收到首字后切到生成中');
  } finally { globalThis.fetch = realFetch; }
});
test('大图片不写入 localStorage（沙箱 data URL 瘦身）', async () => {
  await drainSaves();
  const mem = new Map();
  const realLS = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
  try {
    const { createStore: makeStore } = await import('../js/state.js?slim=' + Date.now());
    const store = makeStore();
    store.state.files = {
      'notes/small.txt': '短文本要保留',
      'uploads/big.png': 'data:image/png;base64,' + 'A'.repeat(5 * 1024 * 1024),
    };
    store.save(true);
    const saved = JSON.parse(mem.get('teamo-agent-state-v1-v2'));
    const files = saved.sessions[0].files;
    assert.equal(files['notes/small.txt'], '短文本要保留', '小文本文件照常持久化');
    assert.ok(!('uploads/big.png' in files), '超限时剥离沙箱内的大图片（避免顶穿 4MB 配额）');  } finally {
    if (realLS === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = realLS;
  }
});

group('沙箱打包下载（ZIP）');
test('fileBytesFromValue / withExtension：图片还原字节、补扩展名', async () => {
  const zip = await import('../js/zip.js');
  const raw = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255, 128]);
  const url = 'data:image/png;base64,' + Buffer.from(raw).toString('base64');
  const got = zip.fileBytesFromValue(url);
  assert.equal(got.mime, 'image/png');
  assert.deepEqual(Array.from(got.bytes), Array.from(raw));
  assert.deepEqual(Array.from(zip.fileBytesFromValue('纯文本').bytes), Array.from(new TextEncoder().encode('纯文本')));
  assert.deepEqual(Array.from(zip.fileBytesFromValue(null).bytes), []);
  assert.equal(zip.withExtension('uploads/cat', 'image/png'), 'uploads/cat.png');
  assert.equal(zip.withExtension('uploads/cat.png', 'image/png'), 'uploads/cat.png', '已有扩展名不重复追加');
  assert.equal(zip.withExtension('a/b.txt', 'text/plain'), 'a/b.txt');
});
test('createZip：本地头/中心目录/EOCD 结构与 CRC 自洽', async () => {
  const zip = await import('../js/zip.js');
  const noteTxt = '# 标题\nhello zip';
  const pngBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 250]);
  const blob = zip.createZip([
    { name: 'uploads/note.md', bytes: new TextEncoder().encode(noteTxt) },
    { name: 'outputs/image-001.png', bytes: pngBytes },
  ]);
  const buf = Buffer.from(await blob.arrayBuffer());
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  assert.equal(buf.length > 22, true);
  assert.equal(view.getUint32(0, true), 0x04034b50, '首条目为 Local File Header');
  assert.equal(view.getUint32(buf.length - 22, true), 0x06054b50, 'EOCD 签名位于末尾');
  assert.equal(view.getUint16(buf.length - 12, true), 2, 'EOCD 条目数');
  // 第二个条目：名称长度以 UTF-8 字节计（中文 3 字节/字，不能按字符数切）
  const firstBody = new TextEncoder().encode(noteTxt);
  const nameLen = view.getUint16(26, true);
  const firstData = buf.subarray(30 + nameLen, 30 + nameLen + firstBody.length).toString();
  assert.equal(firstData, noteTxt, '正文按 STORE 原样存放');
  assert.equal(view.getUint32(18, true), firstBody.length, '压缩后大小 = UTF-8 字节数');
  const crcField = view.getUint32(14, true);
  assert.equal(crcField, zip.crc32(firstBody), '头里的 CRC32 与正文一致');
  assert.equal(zip.crc32(new Uint8Array(0)), 0, '空内容 CRC32 = 0');
  assert.equal(zip.crc32(new TextEncoder().encode('123456789')), 0xCBF43926, 'CRC32 标准向量');
});


group('生图模型名归一（实测 400「模型 \'2.5 Sunburst\' 暂不可用」的修复）');
test('显示名 / 大小写 / 代号简写都解析为网关真实 ID', () => {
  const r = (x, fb) => cfg.resolveImageModel(x, fb);
  assert.equal(r('2.5 Sunburst').id, 'gpt-image-2.5-sunburst', '纯显示名（复现场景）');
  assert.equal(r('GPT Image 2.5 Flare').id, 'gpt-image-2.5-flare');
  assert.equal(r('gpt-image-2.5-flare').id, 'gpt-image-2.5-flare', '已经是 ID 时保持不变');
  assert.equal(r('GPT-Image-2').id, 'gpt-image-2');
  assert.equal(r('flare').id, 'gpt-image-2.5-flare', '只给代号也能定位');
  assert.equal(r('  2.5-SUNBURST  ').id, 'gpt-image-2.5-sunburst', '前后空格与大小写容错');
  assert.equal(r('gpt-image-2.5-flare').corrected, false, '规范输入不算“被纠正”');
  assert.equal(r('2.5 Sunburst').corrected, true, '别名输入要标记为已纠正，便于告知模型');
});
test('缺省沿用会话选定模型；非法名退回默认而不是把垃圾发给网关', () => {
  assert.equal(cfg.resolveImageModel('', 'gpt-image-2.5-flare').id, 'gpt-image-2.5-flare');
  assert.equal(cfg.resolveImageModel(undefined, 'gpt-image-2.5-flare').id, 'gpt-image-2.5-flare');
  const bad = cfg.resolveImageModel('最新的图片模型', 'gpt-image-2');
  assert.equal(bad.id, 'gpt-image-2', '中文描述串不应透传');
  assert.equal(bad.unknown, true, '要标记 unknown，工具层据此提示模型改用 ID');
  const foreign = cfg.resolveImageModel('gemini-3.1-flash-image', 'gpt-image-2');
  assert.equal(foreign.id, 'gemini-3.1-flash-image', '形状像网关 ID 的透传，便于使用 /v1/models 里的其它生图模型');
  assert.equal(foreign.passthrough, true);
  assert.equal(cfg.resolveImageModel('2.5', 'nope').id, cfg.DEFAULT_IMAGE_MODEL, '兜底值非法时用默认');
  assert.ok(cfg.IMAGE_MODEL_IDS.every((id) => cfg.isImageGenModel(id)));
});
test('工具 Schema 用 enum 限定模型 ID，提示词给出可选值', () => {
  const def = TOOL_DEFS.find((t) => t.name === 'generate_image');
  const m = def.parameters.properties.model;
  assert.deepEqual(m.enum, cfg.IMAGE_MODEL_IDS, 'enum 约束比自由文本更难被模型写错');
  assert.ok(/不要传/.test(m.description), '描述里要明确“不要传显示名”');
  const sys = cfg.systemPrompt();
  assert.ok(/gpt-image-2\.5-sunburst/.test(sys), '系统提示词列出真实 ID');
  assert.ok(/不要传「2.5 Sunburst」/.test(sys), '系统提示词包含反例');
  assert.ok(sys.indexOf('gpt-image-2.5-sunburst') < sys.indexOf('## 规则'), 'ID 说明位于工具清单内');
  assert.notEqual(sys, cfg.systemPrompt.toString(), '断言的是提示词正文而非函数源码（防止自证）');
});

group('图像响应解析：不再把任何异常都说成「缺少 data[0]」');
test('PNG/JPEG/WebP 头部解析真实尺寸与格式', () => {
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(png.buffer).setUint32(16, 1024); new DataView(png.buffer).setUint32(20, 1536);
  assert.deepEqual({ ...api.sniffImage(png) }, { mime: 'image/png', ext: 'png', width: 1024, height: 1536 });
  // JPEG SOF0：FF C0 <len:2> <precision:1> <height:2> <width:2>
  const jpg = new Uint8Array(32);
  jpg.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08], 0);
  new DataView(jpg.buffer).setUint16(7, 480); new DataView(jpg.buffer).setUint16(9, 640);
  const j = api.sniffImage(jpg);
  assert.equal(j.mime, 'image/jpeg'); assert.equal(j.width, 640); assert.equal(j.height, 480);
  const webp = new Uint8Array(40);
  webp.set([0x52, 0x49, 0x46, 0x46, 32, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58], 0);
  webp[24] = 0xff; webp[25] = 0x03; webp[26] = 0; // canvas width - 1 = 1023（24bit LE）
  webp[27] = 0xff; webp[28] = 0x07; webp[29] = 0; // canvas height - 1 = 2047
  const w = api.sniffImage(webp);
  assert.equal(w.ext, 'webp'); assert.equal(w.mime, 'image/webp');
  assert.equal(w.width, 1024); assert.equal(w.height, 2048);
  assert.deepEqual(api.sniffImage(new Uint8Array([1, 2, 3])), {}, '非图片字节返回空对象而不是抛错');
});
test('网关无视 output_format 时按字节头纠正扩展名', () => {
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(png.buffer).setUint32(16, 1024); new DataView(png.buffer).setUint32(20, 1024);
  const b64 = Buffer.from(png).toString('base64');
  const out = api.parseImageResponse({ data: [{ b64_json: b64 }] }, 'webp');
  assert.equal(out.ext, 'png', '实际是 PNG 就不该写成 .webp');
  assert.ok(out.dataUrl.startsWith('data:image/png;base64,'));
  assert.equal(out.width, 1024, '用头部尺寸补全 width/height');
});
test('多张结果全部返回（n>1 时不丢图）', () => {
  const b64 = Buffer.from('x').toString('base64');
  const out = api.parseImageResponse({ data: [{ b64_json: b64 }, { b64_json: b64 + 'y' }, { b64_json: b64 + 'z' }] }, 'png');
  assert.equal(out.images.length, 3);
  assert.equal(out.dataUrl, out.images[0].dataUrl, '首张仍是 .dataUrl，兼容老调用方');
});
test('HTTP 200 + error：直接暴露网关文案并标记可重试', () => {
  assert.throws(
    () => api.parseImageResponse({ error: { message: '上游繁忙，请稍后重试', type: 'overloaded' }, data: undefined }, 'png'),
    (e) => /上游繁忙/.test(e.message) && e.retryable === true,
  );
  assert.throws(
    () => api.parseImageResponse({ message: 'quota exceeded' }, 'png'),
    (e) => /quota exceeded/.test(e.message),
  );
});
test('非 JSON 响应体不再伪装成「缺少 data」', () => {
  assert.throws(() => api.parseImageResponse('<html>502 Bad Gateway</html>', 'png', { status: 200, raw: '<html>502 Bad Gateway</html>' }),
    (e) => /未返回 JSON/.test(e.message) && /HTTP 200/.test(e.message));
});

group('图像请求重试策略');
test('瞬时失败重放一次即成功；确定性错误不重放', async () => {
  const b64 = Buffer.from('img').toString('base64');
  let calls = 0;
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) return new Response('<html>bad gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } });
      return new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), { status: 200 });
    };
    const out = await api.postImageWithRetry('/v1/images/generations',
      { apiKey: 'sk-teamo-test', body: '{}', format: 'png', timeoutMs: 5000 },
      { retryDelayMs: 1, retries: 1, parse: (j) => api.parseImageResponse(j, 'png') });
    assert.equal(out.dataUrl, `data:image/png;base64,${b64}`, '第二次成功即返回');
    assert.equal(calls, 2, '只补一次');
    calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ error: { message: '模型不存在' } }), { status: 404 }); };
    await assert.rejects(() => api.postImageWithRetry('/v1/images/generations',
      { apiKey: 'sk-teamo-test', body: '{}', format: 'png', timeoutMs: 5000 },
      { retryDelayMs: 1, retries: 1, parse: (j) => api.parseImageResponse(j, 'png') }), /HTTP 404/);
    assert.equal(calls, 1, '4xx 参数/模型类错误重试无意义，不应重放');
  } finally {
    globalThis.fetch = realFetch;
  }
});
test('空 data 触发重试（网关偶发吞掉上游结果）', async () => {
  const b64 = Buffer.from('img2').toString('base64');
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    const body = calls === 1 ? { data: [] } : { data: [{ b64_json: b64 }] };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    const out = await api.postImageWithRetry('/v1/images/generations',
      { apiKey: 'k', body: '{}', format: 'png', timeoutMs: 5000 },
      { retryDelayMs: 1, retries: 1, parse: (j) => api.parseImageResponse(j, 'png') });
    assert.equal(calls, 2);
    assert.ok(out.dataUrl.includes(b64));
  } finally { globalThis.fetch = realFetch; }
});

group('generate_image 端到端（真实代码路径 + 桩网关）');
test('model 传显示名时被纠正，且请求体里是真实 ID', async () => {
  const realFetch = globalThis.fetch;
  let sent = null;
  const b64 = Buffer.from('cube').toString('base64');
  globalThis.fetch = async (url, opts) => {
    sent = JSON.parse(opts.body);
    return new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), { status: 200 });
  };
  try {
    const fs = createFS();
    const res = await executeTool('generate_image',
      { prompt: 'a red cube', model: '2.5 Sunburst' },
      { fs, apiKey: 'sk-teamo-test', imageModel: 'gpt-image-2' });
    assert.equal(sent.model, 'gpt-image-2.5-sunburst', '不再把 "2.5 Sunburst" 发给网关（实测会 400）');
    assert.match(res, /已把模型名「2.5 Sunburst」解析为 gpt-image-2.5-sunburst/, '文案里说明纠正，便于模型学习');
  } finally { globalThis.fetch = realFetch; }
});
test('n>1 时多张图全部写入沙箱', async () => {
  const realFetch = globalThis.fetch;
  const one = Buffer.from('a').toString('base64');
  const two = Buffer.from('b').toString('base64');
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ b64_json: one }, { b64_json: two }] }), { status: 200 });
  try {
    const fs = createFS();
    const res = await executeTool('generate_image', { prompt: 'two cubes', n: 2 }, { fs, apiKey: 'k', imageModel: 'gpt-image-2' });
    assert.ok(fs.read('outputs/image-001.png') && fs.read('outputs/image-002.png'), '两张都落盘');
    assert.match(res, /共 2 张/);
    assert.match(res, /image-001\.png、outputs\/image-002\.png/);
  } finally { globalThis.fetch = realFetch; }
});
test('参考图缺失时在发请求前就报错（不浪费 40 秒生图）', async () => {
  const realFetch = globalThis.fetch;
  let hit = false;
  globalThis.fetch = async () => { hit = true; return new Response('{}', { status: 200 }); };
  try {
    const fs = createFS({ 'uploads/real.png': 'data:image/png;base64,AA==' });
    const res = await executeTool('generate_image',
      { prompt: 'edit it', reference_paths: ['uploads/ghost.png'] },
      { fs, apiKey: 'k', imageModel: 'gpt-image-2' });
    assert.equal(hit, false, '不应发起网络请求');
    assert.match(res, /沙箱中找不到参考图/);
    assert.match(res, /uploads\/real\.png/, '列出现有图片，方便模型改用正确路径');
  } finally { globalThis.fetch = realFetch; }
});
test('网关 400 时错误文案保留上游消息与 trace 提示', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "模型 'gpt-image-9' 暂不可用，请稍后重试。", type: 'model_not_available' }, trace_id: 't1' }), { status: 400 });
  try {
    const fs = createFS();
    const res = await executeTool('generate_image', { prompt: 'x', model: 'gpt-image-9' }, { fs, apiKey: 'k', imageModel: 'gpt-image-2' });
    assert.match(res, /暂不可用/);
    assert.match(res, /HTTP 400/);
  } finally { globalThis.fetch = realFetch; }
});

group('文件面板目录树（js/filetree.js）');
const ft = await import('../js/filetree.js');
test('buildFileTree：按 / 还原层级并汇总大小与数量', () => {
  const tree = ft.buildFileTree([
    { path: 'uploads/cat.png', size: 100 },
    { path: 'uploads/spec.md', size: 50 },
    { path: 'outputs/nested/deep.md', size: 10 },
    { path: 'root.txt', size: 1 },
  ]);
  assert.deepEqual(tree.map((n) => `${n.type}:${n.name}`), ['dir:outputs', 'dir:uploads', 'file:root.txt'], '目录在前、同级按名称排序');
  const uploads = tree[1];
  assert.equal(uploads.size, 150);
  assert.equal(uploads.count, 2);
  assert.deepEqual(uploads.children.map((c) => c.name), ['cat.png', 'spec.md']);
  const outputs = tree[0];
  assert.equal(outputs.count, 1, '嵌套目录的文件数汇总到上层');
  assert.equal(outputs.dirs, 1, '直接子目录数');
  assert.equal(outputs.children[0].path, 'outputs/nested');
  assert.equal(outputs.children[0].children[0].path, 'outputs/nested/deep.md', '子节点保留完整路径');
});
test('排序用自然数序：image-2 在 image-10 之前', () => {
  const tree = ft.buildFileTree([{ path: 'o/image-10.png', size: 1 }, { path: 'o/image-2.png', size: 1 }, { path: 'o/image-1.png', size: 1 }]);
  assert.deepEqual(tree[0].children.map((c) => c.name), ['image-1.png', 'image-2.png', 'image-10.png']);
});
test('脏路径（多余斜杠 / 空段 / 非字符串）不产生空目录', () => {
  const tree = ft.buildFileTree([{ path: '/a//b.txt', size: 3 }, { path: '  ', size: 9 }, null, { path: 'c/', size: 4 }]);
  assert.deepEqual(tree.map((n) => `${n.type}:${n.name}`), ['dir:a', 'file:c']);
  assert.equal(tree[0].children[0].path, 'a/b.txt', '空段被清掉');
  assert.equal(ft.treeStats(tree).files, 2);
});
test('collectPaths：目录打包时收集全部后代文件', () => {
  const tree = ft.buildFileTree([{ path: 'a/x.txt', size: 1 }, { path: 'a/b/y.txt', size: 2 }, { path: 'z.txt', size: 3 }]);
  assert.deepEqual(ft.collectPaths(tree[0]).sort(), ['a/b/y.txt', 'a/x.txt']);
  assert.deepEqual(ft.collectPaths(tree[1]), ['z.txt']);
  assert.deepEqual(ft.collectPaths(null), []);
});
test('flattenTree：折叠的目录不输出子项，深度驱动缩进', () => {
  const tree = ft.buildFileTree([{ path: 'a/b/c.txt', size: 1 }, { path: 'a/top.txt', size: 1 }]);
  const flat = ft.flattenTree(tree, { isCollapsed: () => false });
  assert.deepEqual(flat.map((n) => `${n.depth}:${n.name}`), ['0:a', '1:b', '2:c.txt', '1:top.txt']);
  assert.equal(flat[0].hasChildren, true);
  const closed = ft.flattenTree(tree, { isCollapsed: (p) => p === 'a/b' });
  assert.deepEqual(closed.map((n) => `${n.depth}:${n.name}`), ['0:a', '1:b', '1:top.txt'], '折叠后其子树消失');
  assert.deepEqual(ft.flattenTree(tree, {}).map((n) => n.name), ['a', 'b', 'c.txt', 'top.txt'], '未传 isCollapsed 时全展开');
});
test('treeStats：目录不重复计数', () => {
  const tree = ft.buildFileTree([{ path: 'a/x.txt', size: 10 }, { path: 'a/b/y.txt', size: 5 }, { path: 'z.txt', size: 1 }]);
  const st = ft.treeStats(tree);
  assert.deepEqual({ files: st.files, dirs: st.dirs, size: st.size }, { files: 3, dirs: 2, size: 16 });
  assert.deepEqual(ft.treeStats([]), { files: 0, dirs: 0, size: 0 });
});
test('界面图标为 currentColor 线性 SVG（随主题与选中态自动反色）', async () => {
  const { ICON } = await import('../js/icons.js');
  for (const k of ['bolt', 'download', 'folder', 'folderOpen', 'file', 'image', 'chevRight', 'x']) {
    assert.ok(ICON[k].startsWith('<svg') && ICON[k].includes('stroke="currentColor"') && !ICON[k].includes('#'), `${k} 应为 currentColor 单色 SVG`);
    assert.ok(/fill="none"/.test(ICON[k]), `${k} 线性描边而非填充`);
  }
});

group('空状态任务示例（js/suggestions.js）');
const sg = await import('../js/suggestions.js');
test('示例池覆盖多类能力且文案不重复', () => {
  assert.ok(sg.SUGGESTIONS.length >= 12, `池子应有 ≥12 条，实际 ${sg.SUGGESTIONS.length}`);
  const texts = sg.SUGGESTIONS.map((x) => x.text);
  assert.equal(new Set(texts).size, texts.length, '存在重复文案');
  // 用户要求：示例卡前面不加「任务类型」标签 → 池子里也不该再有 tag 字段
  assert.ok(sg.SUGGESTIONS.every((x) => x.tag === undefined), '示例条目不应再带 tag（任务类型标签已移除）');
  const joined = sg.SUGGESTIONS.map((x) => x.text).join('\n');
  for (const kw of ['沙箱', 'generate_image', 'ZIP', 'code-reviewer', '回滚', 'models']) { // 标签去掉后按正文关键词判定覆盖面
    assert.ok(joined.includes(kw), `示例应覆盖「${kw}」`);
  }
});
test('pickSuggestions：随机 3 条、不重复', () => {
  let seed = 1;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const picks = sg.pickSuggestions(sg.SUGGESTIONS, 3, rnd);
    assert.equal(picks.length, 3, `第 ${i} 轮抽到 ${picks.length} 条`);
    assert.equal(new Set(picks.map((x) => x.text)).size, 3, '同一轮内不应重复');
    picks.forEach((x) => seen.add(x.text));
  }
  assert.ok(seen.size >= 8, `40 轮应覆盖到多条示例，实际 ${seen.size} 条 → 随机性不足`);
  // 不改动原数组顺序（渲染层依赖池子稳定）
  assert.equal(sg.SUGGESTIONS[0].text, '用沙箱计算：前 100 个斐波那契数中有多少个质数？');
});
test('边界：n 超过池子 / 空池 / 脏数据', () => {
  assert.equal(sg.pickSuggestions([{ text: 'a' }], 3).length, 1);
  assert.deepEqual(sg.pickSuggestions([], 3), []);
  // 契约：不传 list 走默认池（JS 默认参数语义），传空数组才是「没有示例」
  assert.equal(sg.pickSuggestions(undefined, 3).length, 3);
  assert.equal(sg.pickSuggestions(null, 3).length, 0, 'null 不套默认值，按空池处理');
  assert.equal(sg.pickSuggestions([{ text: '' }, null, { text: 'x', tag: 'X' }], 3).length, 1, '空文案与非对象项应被过滤');
  const small = [{ text: 'a', tag: 'A' }, { text: 'b', tag: 'A' }]; // 标签冲突但池子不够
  assert.equal(sg.pickSuggestions(small, 3).length, 2, '标签去重后不足时用剩余项补齐');
});
test('shuffled 不改动入参且长度守恒', () => {
  const src = [1, 2, 3, 4, 5];
  const out = sg.shuffled(src, () => 0.99);
  assert.deepEqual(src, [1, 2, 3, 4, 5]);
  assert.equal(out.length, 5);
  assert.deepEqual([...out].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
});

group('视图层故障隔离（缓存版本错配的防线）');
test('UI 钩子抛错或缺失，都不能打断对话循环', async () => {
  const warns = [];
  const origWarn = console.warn;
  const origFetch = globalThis.fetch;
  try {
    console.warn = (...a) => warns.push(a.map(String).join(' '));
    // ① 钩子存在但抛错（真实故障形态：旧 ui.js 上调用不存在的方法）
    mockFetch([openaiTextTurn('好的')], []);
    const s1 = storeNoWeb(createStore());
    s1.state.apiKey = 'sk-teamo-test'; s1.state.model = 'gpt-5.6-sol';
    const a1 = createAgent(s1, {
      setStatus() { throw new TypeError('boom: setStatus'); },
      onUserMessage() { throw new TypeError('ui.onUserMessage is not a function'); },
      onAssistantStart() { throw new TypeError('ui.onAssistantStart is not a function'); },
      onDelta() { throw new TypeError('boom: onDelta'); },
      onTurnEnd() { throw new TypeError('boom: onTurnEnd'); },
    });
    await a1.send('你好');
    const last1 = s1.state.messages[s1.state.messages.length - 1];
    assert.equal(last1.role, 'assistant');
    assert.equal(last1.text, '好的', '视图抛错不应影响模型回复落地');
    assert.equal(a1.getStatus(), 'done', '状态机应正常收尾');
    assert.ok(warns.some((w) => /hooks\.onUserMessage 异常/.test(w)), '异常要可在控制台定位');
    assert.ok(warns.some((w) => /hooks\.onDelta 异常/.test(w)), '每个钩子独立隔离');
    // ② 旧版 UI：压根没有 onUserMessage 方法
    globalThis.fetch = origFetch;
    mockFetch([openaiTextTurn('收到')], []);
    const s2 = storeNoWeb(createStore());
    s2.state.apiKey = 'sk-teamo-test'; s2.state.model = 'gpt-5.6-sol';
    const a2 = createAgent(s2, { onAssistantStart() {} });
    await a2.send('你好呀');
    assert.equal(a2.getStatus(), 'done');
    assert.ok(s2.state.messages.some((m) => m.role === 'user' && m.text === '你好呀'), '缺钩子时消息仍应入列');
    assert.equal(s2.state.messages[s2.state.messages.length - 1].text, '收到');
  } finally {
    console.warn = origWarn;
    globalThis.fetch = origFetch;
  }
});
test('index.html 入口资源用 ?v=APP_VERSION 穿透 Pages 缓存', async () => {
  const fsp = await import('node:fs');
  const html = fsp.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const { APP_VERSION } = await import('../js/config.js');
  assert.match(APP_VERSION, /^\d{4}\.\d{2}\.\d{2}\.\d+$/, '版本形如 2026.09.21.2');
  for (const asset of ['css/styles\\.css', 'js/main\\.js']) {
    const m = new RegExp(`${asset}\\?v=([\\d.]+)`).exec(html);
    assert.ok(m, `${asset.replace(/\\/g, '')} 应带 ?v=`);
    assert.equal(m[1], APP_VERSION, '?v= 必须与 APP_VERSION 同步（发版一起 bump）');
  }
  assert.match(html, /id="build-stamp"/, '侧栏要有可见的构建标识');
  // 模块间 import 不带版本（无构建器），因此必须靠 emit() 兜住混版 —— 见上一条用例
  const mainSrc = fsp.readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  assert.match(mainSrc, /ui && ui\.onUserMessage\(msg\)/, 'main.js 仍显式接上用户消息上屏');
});


group('工具可用性：沙箱开关只该管住代码执行');
test('toolsFor：关闭沙箱只摘掉三个代码执行工具', async () => {
  const { toolsFor, CODE_TOOL_NAMES } = await import('../js/tools.js');
  const off = toolsFor(false).map((t) => t.name);
  const on = toolsFor(true).map((t) => t.name);
  assert.deepEqual(on, TOOL_DEFS.map((t) => t.name), '开启时应是全部工具');
  for (const n of CODE_TOOL_NAMES) assert.ok(!off.includes(n), `${n} 应被关掉`);
  for (const n of ['write_file', 'read_file', 'list_files', 'dispatch_subagent', 'generate_image', 'get_current_time']) {
    assert.ok(off.includes(n), `${n} 与代码执行无关，关沙箱也要可用`);
  }
});
test('executeTool：沙箱关闭时拒绝执行代码（未显式关闭的旧调用方不受影响）', async () => {
  const r = await executeTool('execute_javascript', { code: '1+1' }, { fs: createFS(), sandboxEnabled: false });
  assert.match(r, /沙箱已关闭/, '应给出可纠错的说明而不是悄悄执行');
  const legacy = await executeTool('list_files', {}, { fs: createFS({ 'a.txt': 'x' }) });
  assert.match(legacy, /a\.txt/, 'ctx 未标 sandboxEnabled 时不应误伤');
});
test('subagentTools：沙箱关闭时子智能体保留文件工具，不整体退化成纯推理', async () => {
  const { subagentTools } = await import('../js/agent.js');
  const names = (list) => (list || []).map((t) => t.name);
  const writer = findSubagent('doc-writer');
  assert.deepEqual(names(subagentTools(false, writer)).sort(), ['list_files', 'read_file', 'write_file']);
  const analyst = findSubagent('data-analyst');
  assert.ok(names(subagentTools(true, analyst)).includes('execute_python'), '开沙箱时该有代码执行');
  assert.ok(!names(subagentTools(false, analyst)).some((n) => n.startsWith('execute_')), '关沙箱时不该有代码执行');
  assert.equal(subagentTools(true, findSubagent('code-reviewer')), null, '纯推理子智能体不给工具');
  for (const a of SUBAGENTS) {
    assert.ok(!names(subagentTools(true, a)).includes('dispatch_subagent'), `${a.id} 不得再委派（防递归）`);
  }
});

test('agent.js 与 tools.js 的沙箱工具清单一致（本地副本，防 link 期混版）', async () => {
  const fsp = await import('node:fs');
  const src = fsp.readFileSync(new URL('../js/agent.js', import.meta.url), 'utf8');
  assert.ok(!/import\s*\{[^}]*toolsFor/.test(src), 'agent.js 不得 import 新增具名导出（混版缓存会白屏）');
  const tools = await import('../js/tools.js');
  const local = /const CODE_TOOL_NAMES = \[([^\]]*)\]/.exec(src)[1].split(',').map((x) => x.trim().replace(/'/g, ''));
  assert.deepEqual(local, tools.CODE_TOOL_NAMES, '两份清单必须同步');
});
group('子智能体自主委派（提示词层）');
test('systemPrompt 里列出了 dispatch_subagent（不再只靠开关后附加的指引）', async () => {
  const sys = cfg.systemPrompt();
  assert.match(sys, /dispatch_subagent/, '能力清单必须包含委派工具');
  assert.match(sys, /不要等用户点名/, '要写明无需用户点名即可委派');
  assert.match(sys, /同一轮/, '要允许一轮内并行发起多个工具调用');
  assert.match(sys, /代码执行工具需要用户开启/, '沙箱开关的作用范围要说清');
});
test('subagentGuide 给触发条件与并行规则，而不是劝阻委派', async () => {
  const g = subagentGuide();
  for (const key of ['何时应当主动委派', '同一轮', 'task 必须自包含', '不要把冗长报告原样转贴', '报告异常或为空时，自己补做']) {
    assert.ok(g.includes(key), `指引缺少「${key}」`);
  }
  assert.ok(!/不要为了委派而委派/.test(g), '旧措辞会压掉所有主动委派');
  const ids = SUBAGENTS.map((a) => a.id);
  for (const id of ids) assert.ok(g.includes(id), `指引应列出 ${id}`);
});
test('关闭沙箱时委派指引照样注入（旧写法整段被开关藏起来）', async () => {
  const calls = [];
  mockFetch([openaiTextTurn('你好')], calls);
  try {
    const store = storeNoWeb(createStore());
    store.state.apiKey = 'sk-teamo-test';
    store.state.model = 'gpt-5.6-sol';
    store.state.settings.sandboxEnabled = false;
    const agent = createAgent(store, {});
    await agent.send('随便聊聊');
    const sys = calls[0].body.messages.find((m) => m.role === 'system');
    assert.match(sys.content, /子智能体委派（dispatch_subagent）/);
    assert.ok(calls[0].body.tools.some((t) => t.function.name === 'dispatch_subagent'), '关沙箱也要能委派');
    assert.ok(!calls[0].body.tools.some((t) => t.function.name === 'execute_python'), '关沙箱不能出现代码执行');
  } finally { globalThis.fetch = realFetch; }
});
test('同一轮的多个 dispatch_subagent 并发执行，结果仍按调用顺序回填', async () => {
  // 三个子智能体并发委派：靠「总耗时 < 串行耗时」证明它们真的一起跑
  const seen = [];
  let mainTurns = 0;
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    seen.push(body);
    // 子智能体的请求一定以「你是…体系中的…」作为 system（首轮只有 system+user 两条）
    const isSub = String((body.messages || [])[0]?.content || '').includes('体系中的');
    if (isSub) { await delay(140); return openaiTextTurn('子报告'); }
    if (++mainTurns === 1) {
      // 主 Agent 第一次回答：同一轮里发出 3 个互不依赖的委派
      const mk = (i) => sseEv({ choices: [{ delta: { tool_calls: [{ index: i, id: `c${i}`, function: { name: 'dispatch_subagent', arguments: JSON.stringify({ agent: 'explainer', task: `任务${i}` }) } }] } }] });
      return sseResponse(mk(0) + mk(1) + mk(2) + sseEv({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + sseDone);
    }
    return openaiTextTurn('整合完成');
  };
  try {
    const store = storeNoWeb(createStore());
    store.state.apiKey = 'sk-teamo-test';
    store.state.model = 'gpt-5.6-sol';
    const agent = createAgent(store, {});
    const t0 = Date.now();
    await agent.send('同时找三个专家看看');
    const ms = Date.now() - t0;
    const toolMsgs = store.state.messages.filter((m) => m.role === 'tool');
    assert.equal(toolMsgs.length, 3, '三个委派都要有结果');
    assert.deepEqual(toolMsgs.map((m) => m.toolCallId), ['c0', 'c1', 'c2'], '结果顺序必须与调用顺序一致');
    assert.equal(seen.filter((b) => String((b.messages || [])[0]?.content || '').includes('体系中的')).length, 3, '应各发一次子智能体请求');
    assert.ok(ms < 140 * 2, `三个子智能体应并发跑（串行至少 ${140 * 3}ms，实测 ${ms}ms）`);
  } finally { globalThis.fetch = realFetch; }
});

group('本轮审查修掉的真实缺陷');
test('write_file / read_file 路径归一，非法路径不再造出 undefined 文件', async () => {
  const { normalizeFsPath } = await import('../js/tools.js');
  assert.equal(normalizeFsPath('/data/a.md'), 'data/a.md');
  assert.equal(normalizeFsPath('./notes.txt'), 'notes.txt');
  assert.equal(normalizeFsPath('a//b.txt'), 'a/b.txt');
  for (const bad of ['', '   ', '/', '..', 'a/../b', undefined, null]) assert.equal(normalizeFsPath(bad), '', `${bad} 应判非法`);
  const fs = createFS();
  assert.match(await executeTool('write_file', { content: 'x' }, { fs }), /缺少合法的 path/);
  assert.deepEqual(Object.keys(fs.export()), [], '不能写出名为 undefined 的文件');
  assert.match(await executeTool('read_file', {}, { fs }), /缺少合法的 path/);
  await executeTool('write_file', { path: '/deep/./x.txt', content: 'ok' }, { fs });
  assert.equal(fs.read('deep/x.txt'), 'ok', '前导 / 与 ./ 要归一，别分裂成两棵目录树');
});
test('generate_image 输出序号按最大值递增（删过文件也不覆盖旧图）', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const fs = createFS({ 'outputs/image-001.png': png, 'outputs/image-002.png': png, 'outputs/image-004.png': png });
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ b64_json: png.split(',')[1] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const out = await executeTool('generate_image', { prompt: 'p' }, { fs, apiKey: 'sk-teamo-test', imageModel: 'gpt-image-2' });
    assert.match(out, /image-005\.png/, `应接在最大序号后面：${out.split('\n')[2] || out}`);
    assert.equal(fs.read('outputs/image-001.png'), png, '已有文件不能被覆盖');
  } finally { globalThis.fetch = realFetch; }
});
test('api：200 但响应体为空时给出可读错误，不再抛 reading undefined', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200, ok: true, body: null, headers: new Map(), text: async () => '' });
  try {
    await assert.rejects(
      api.streamChat({ model: 'gpt-5.6-sol', apiKey: 'k', messages: [{ role: 'user', text: 'hi' }], onEvent() {} }),
      /空响应体/,
    );
  } finally { globalThis.fetch = origFetch; }
});
test('沙箱输出被截断只在预算不足时发生（回归：历史轮次工具结果分级收紧）', () => {
  const long = 'x'.repeat(20000);
  const msgs = [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }, { role: 'user', text: 'q2' }, { role: 'tool', toolCallId: 'c', name: 'execute_javascript', content: long }];
  const rich = compactMessages(msgs, 200000);
  assert.equal(rich.messages[3].content.length, long.length, '预算富余时不得截断');
  const tight = compactMessages(msgs, 4000);
  assert.ok(tight.messages[3].content.length < long.length, '预算紧张时才收紧历史工具结果');
});
test('导入会话在回合进行中必须先判忙再改 store（防半轮丢失）', async () => {
  const fsp = await import('node:fs');
  const src = fsp.readFileSync(new URL('../js/ui.js', import.meta.url), 'utf8');
  const at = src.indexOf("store.importSession(data)");
  const busy = src.lastIndexOf("if (getBusy())", at);
  assert.ok(busy > 0 && busy < at, 'getBusy 判定必须排在 importSession 之前');
});
test('死代码不再回来：zip 便捷入口 / 文件树 direct 字段 / 双重 import', async () => {
  const fsp = await import('node:fs');
  const zip = await import('../js/zip.js');
  assert.ok(!('zipFileMap' in zip), 'zipFileMap 无调用方，已删除');
  const main = fsp.readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  assert.ok(!/agent\.fs\.import\(store\.state\.files\)/.test(main), 'createAgent 已用同一份 files 建 fs，重复 import 会复活被清空的文件');
  const tree = await import('../js/filetree.js');
  const [node] = tree.buildFileTree([{ path: 'a/b.txt', size: 3 }]);
  assert.ok(!('direct' in node), '无人读取的 direct 字段应删掉');
});
test('Worker 侧 Pyodide API 名称与陈旧全局（回归锚点）', async () => {
  const fsp = await import('node:fs');
  const src = fsp.readFileSync(new URL('../js/worker-py.js', import.meta.url), 'utf8');
  assert.ok(!/pyodide\.toJS\s*\(/.test(src), 'Pyodide 只有实例方法 proxy.toJs，没有 pyodide.toJS（调用它会被 catch 静默吞掉）');
  assert.match(src, /toJs\(\{[^}]*dict_converter: Object\.fromEntries/,'dict 默认转 Map，不指定 dict_converter 会把整个 FS 清空');
  assert.match(src, /globals\.delete\('result'\)/, '常驻 Worker 必须先清掉上一轮的 result');
});



// ───────────────────────── 会话记录（入列时机 / 自动标题 / 一键清空）─────────────────────────
const withLS = async (fn) => {
  const realLS = globalThis.localStorage;
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  try { return await fn(); } finally {
    if (realLS === undefined) delete globalThis.localStorage; else globalThis.localStorage = realLS;
  }
};

group('会话记录：入列时机 / 改名 / 一键清空');
test('空草稿不进侧栏列表，有第一条消息后才入列', async () => withLS(async () => {
  const { createStore } = await import('../js/state.js?' + Date.now());
  const st = storeNoWeb(createStore());
  st.createSession();
  assert.deepEqual(st.listableSessions().map((x) => x.title), [], '空会话不应出现在 listableSessions');
  assert.ok(st.sortedSessions().length >= 1, 'sortedSessions 仍能看到草稿（切换/复用要用）');
  st.pushMessage({ role: 'user', text: '把结果写到 out.txt' });
  assert.equal(st.listableSessions().length, 1, '发出第一条消息后立刻入列');
  assert.equal(st.state.title || st.listableSessions()[0].title, '把结果写到 out.txt'.slice(0, 24), '入列时先用首条消息截断兜底');
  await drainSaves();
}));
test('ensureDraft 复用空草稿，不堆积 invisible 会话', async () => withLS(async () => {
  const { createStore } = await import('../js/state.js?' + Date.now());
  const st = storeNoWeb(createStore());
  const a = st.ensureDraft();
  const b = st.ensureDraft();
  assert.equal(a.id, b.id, '当前已是空会话时不应再造一个');
  st.pushMessage({ role: 'user', text: '有内容了' });
  const c = st.ensureDraft();
  assert.notEqual(c.id, b.id, '已有内容 → 新建');
  await drainSaves();
}));
test('clearAllSessions 只留一个空草稿并返回被删条数', async () => withLS(async () => {
  const { createStore } = await import('../js/state.js?' + Date.now());
  const st = storeNoWeb(createStore());
  st.pushMessage({ role: 'user', text: '会话一' });
  st.state.files['a.txt'] = '1';
  st.createSession();
  st.pushMessage({ role: 'user', text: '会话二' });
  const n = st.clearAllSessions();
  assert.equal(n, 2, '两条有内容的会话被清掉');
  assert.equal(st.state.sessions.length, 1, '留一个可用草稿');
  assert.equal(st.state.messages.length, 0, '当前消息清空');
  assert.deepEqual(st.state.files, {}, '会话记录里的文件也一并清掉');
  assert.equal(st.listableSessions().length, 0);
  await drainSaves();
}));
test('renameSession 记为 user 并拒绝空标题', async () => withLS(async () => {
  const { createStore } = await import('../js/state.js?' + Date.now());
  const st = storeNoWeb(createStore());
  st.pushMessage({ role: 'user', text: "「关于沙箱的一些问题」" });
  const id = st.state.activeSessionId;
  assert.equal(st.renameSession(id, '  '), false, '空标题不改名');
  assert.equal(st.renameSession(id, '「沙箱读写」'), true);
  const s = st.state.sessions.find((x) => x.id === id);
  assert.equal(s.title, '沙箱读写', 'cleanTitle 去掉书名号');
  assert.equal(s.titleSource, 'user');
  assert.equal(s.titled, true);
  await drainSaves();
}));
test('needsTitle 只在「有已完成的回答且没总结过」时为真', async () => withLS(async () => {
  const { createStore } = await import('../js/state.js?' + Date.now());
  const st = storeNoWeb(createStore());
  st.pushMessage({ role: 'user', text: '问题' });
  const a = st.pushMessage({ role: 'assistant', text: '输出中', done: false });
  assert.equal(st.needsTitle(), null, '回答还没结束，先不起标题');
  st.updateMessage(a.id, { done: true });
  assert.equal(st.needsTitle()?.question, '问题');
  st.setAutoTitle(st.state.activeSessionId, '测试总结');
  assert.equal(st.needsTitle(), null, '一个会话只总结一次');
  await drainSaves();
}));
test('setAutoTitle 不覆盖用户改名，空结果只标记已尝试', async () => withLS(async () => {
  const { createStore } = await import('../js/state.js?' + Date.now());
  const st = storeNoWeb(createStore());
  st.pushMessage({ role: 'user', text: '问题' });
  st.pushMessage({ role: 'assistant', text: '回答', done: true });
  assert.equal(st.setAutoTitle(st.state.activeSessionId, '   '), false, '空标题不改内容');
  assert.equal(st.state.sessions.find((x) => x.id === st.state.activeSessionId).titled, true, '但标记已尝试，避免每轮重复消耗');
  const id = st.state.activeSessionId;
  st.renameSession(id, '我自己起的名字');
  assert.equal(st.setAutoTitle(id, 'Agent 又总结了'), false, '用户改过的名不许被覆盖');
  assert.equal(st.state.sessions.find((x) => x.id === id).title, '我自己起的名字');
  await drainSaves();
}));

group('titler：Agent 总结标题');
test('summarizeTitle 只取第一行非空文本', async () => {
  const t = await import('../js/titler.js');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => openaiTextTurn('\n\n「虚拟文件系统」\n\n补充说明：这段不该进标题');
  try {
    const got = await t.summarizeTitle({ apiKey: 'k', model: 'gpt-5.6-sol', question: 'q', answer: 'a' });
    assert.equal(got, '「虚拟文件系统」', `实际得到：${JSON.stringify(got)}`);
  } finally { globalThis.fetch = realFetch; }
});
test('autoTitle：无 Key 时不消耗也不标记', async () => withLS(async () => {
  const t = await import('../js/titler.js');
  const { createStore } = await import('../js/state.js?' + Date.now());
  const st = storeNoWeb(createStore());
  st.pushMessage({ role: 'user', text: 'q' });
  st.pushMessage({ role: 'assistant', text: 'a', done: true });
  const r = await t.autoTitle(st, { summarize: async () => { throw new Error('不该被调用'); } });
  assert.equal(r.reason, 'no-key');
  assert.equal(st.needsTitle() !== null, true, '配好 Key 后下一轮还会重试');
  await drainSaves();
}));
test('autoTitle：成功写回 auto 标题；失败标记已尝试', async () => withLS(async () => {
  const t = await import('../js/titler.js');
  const { createStore } = await import('../js/state.js?' + Date.now());
  const st = storeNoWeb(createStore());
  st.state.apiKey = 'sk-test';
  st.state.model = 'gpt-5.6-sol';
  st.pushMessage({ role: 'user', text: '帮我把π算到小数点后 50 位' });
  const a = st.pushMessage({ role: 'assistant', text: '结果：3.14…', done: true });
  let seen = null;
  const ok = await t.autoTitle(st, { summarize: async (arg) => { seen = arg; return 'π 高精度计算'; } });
  assert.equal(ok.ok, true);
  assert.equal(seen.question, '帮我把π算到小数点后 50 位', '总结要拿到本轮问答');
  assert.equal(st.state.sessions.find((x) => x.id === st.state.activeSessionId).title, 'π 高精度计算');
  st.setAutoTitle(st.state.activeSessionId, ''); // 复位为「已尝试但无结果」
  st.state.sessions.find((x) => x.id === st.state.activeSessionId).titled = false;
  const bad = await t.autoTitle(st, { summarize: async () => { throw new Error('上游 500'); } });
  assert.match(bad.reason, /failed: 上游 500/);
  assert.equal(st.needsTitle(), null, '失败也不每轮重试（省 token）');
  await drainSaves();
}));

group('net.js：抓取/搜索/git 的分层兜底');
const htmlDoc = `<html><head><title>Pyodide &#8212; 浏览器里的 Python</title><style>.a{color:red}</style></head>
<body><script>var x = 1 < 2;</script><h1>标题</h1><p>第一段 &amp; 实体 &#8212; 破折号</p><p>第二段</p><br><div>第三段</div></body></html>`;
test('htmlToText 去标签/脚本/样式并解实体', async () => {
  const net = await import('../js/net.js');
  const txt = net.htmlToText(htmlDoc);
  assert.ok(txt.includes('第一段 & 实体 — 破折号'), txt);
  assert.ok(!txt.includes('var x') && !txt.includes('color:red'), 'script/style 内容必须丢掉');
  assert.ok(!/<[a-z]/i.test(txt), '不应残留标签');
  assert.equal(net.pageTitle(htmlDoc), 'Pyodide — 浏览器里的 Python');
});
test('slugFromUrl 生成安全的落盘名', async () => {
  const net = await import('../js/net.js');
  assert.equal(net.slugFromUrl('https://docs.example.com/a/b/c.md?x=1#y'), 'docs.example.com/c.md');
  assert.match(net.slugFromUrl('not a url'), /^page\/index$/);
});
const jsonResponse = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const withNetFetch = async (handler, fn) => {
  const net = await import('../js/net.js');
  const real = globalThis.fetch;
  net.resetRelayProbe();
  globalThis.fetch = (url, opts) => handler(String(url), opts || {});
  try { return await fn(net); } finally { globalThis.fetch = real; net.resetRelayProbe(); }
};
const NO_RELAY = { '/api/health': () => new Response('<html>404</html>', { status: 404, headers: { 'content-type': 'text/html' } }) };
test('net.webSearch 只保留兼容桩，不再发起任何第三方搜索请求', async () => {
  await withNetFetch(async () => { throw new Error('不该发请求'); }, async (net) => {
    const r = await net.webSearch({ query: '随便' });
    assert.equal(r.provider, 'none');
    assert.match(r.note, /模型 API 自带|顶栏「联网」/, '桩里要写清联网改哪儿了');
  });
});
test('fetch_url 只接受 http(s) 绝对地址', async () => {
  await withNetFetch(async () => { throw new Error('不该发请求'); }, async (net) => {
    for (const bad of ['ftp://x/y', 'example.com', '/etc/passwd', '']) {
      const r = await net.fetchPage({ url: bad });
      assert.equal(r.ok, false, `${bad} 应被拒绝`);
      assert.match(r.error, /只接受 http\(s\) 绝对地址/);
    }
  });
});
test('fetch_url 直连抓 HTML：去标签 + 长文写入沙箱（savePath 生效）', async () => {
  const { createFS } = await import('../js/sandbox.js');
  await withNetFetch(async (url) => {
    if (url.startsWith('/api/health')) return NO_RELAY['/api/health']();
    // 1500×5=7500 字符：超过落盘阈值(2000)也超过预览上限(6000)，两个分支一起验
    return new Response('<html><body><p>' + '正文内容。'.repeat(1500) + '</p></body></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }, async (net) => {
    const fs = createFS();
    const r = await net.fetchPage({ url: 'https://example.com/doc.html', fs, savePath: 'web/自定义/页面.md' });
    assert.equal(r.ok, true);
    assert.ok(r.chars > 2000, `字符数应超过阈值：${r.chars}`);
    assert.equal(r.savedTo, 'web/自定义/页面.md');
    assert.ok(fs.read('web/自定义/页面.md').includes('正文内容。'), '全文要能在沙箱里读到');
    assert.match(r.preview, /全文已写入沙箱/, '预览里指出全文落盘位置');
  });
});
test('fetch_url 命中二进制/JS 渲染页面时给出可读原因', async () => {
  await withNetFetch(async (url) => {
    if (url.startsWith('/api/health')) return NO_RELAY['/api/health']();
    return new Response('PK\u0003\u0004', { status: 200, headers: { 'content-type': 'application/zip', 'content-length': '4' } });
  }, async (net) => {
    const r = await net.fetchPage({ url: 'https://example.com/a.zip' });
    assert.equal(r.ok, false);
    assert.match(r.error, /不是文本/);
  });
  await withNetFetch(async (url) => (url.startsWith('/api/health') ? NO_RELAY['/api/health']() : new Response('   ', { status: 200, headers: { 'content-type': 'text/html' } })),
    async (net) => {
      const r = await net.fetchPage({ url: 'https://example.com/spa' });
      assert.equal(r.ok, false);
      assert.match(r.error, /mode="raw"/, '空页面要提示改用 raw 自己解析（markdown 抽取器是第三方，已移除）');
    });
});
test('run_git：无中继明确拒绝（浏览器执行不了外部程序）', async () => {
  await withNetFetch(async (url) => (url.startsWith('/api/health') ? NO_RELAY['/api/health']() : jsonResponse({})), async (net) => {
    const r = await net.gitRun({ command: 'git status' });
    assert.equal(r.ok, false);
    assert.match(r.error, /需要本地中继/);
    assert.match(r.error, /python3 server\.py/);
  });
});
test('run_git：中继回退出码非 0 时算失败但保留输出', async () => {
  await withNetFetch(async (url) => {
    if (url.startsWith('/api/health')) return jsonResponse({ ok: true, git: true });
    assert.equal(url, '/api/git');
    return jsonResponse({ code: 128, cwd: 'workspace', stdout: '', stderr: 'fatal: not a git repository' });
  }, async (net) => {
    const r = await net.gitRun({ command: 'git status', repo: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 128);
    assert.match(r.text, /fatal: not a git repository/);
  });
});
test('run_git：POST 体带 command/repo/timeout 且成功判定看退出码', async () => {
  let sent = null;
  await withNetFetch(async (url, opts) => {
    if (url.startsWith('/api/health')) return jsonResponse({ ok: true, git: true });
    sent = JSON.parse(opts.body);
    return jsonResponse({ code: 0, cwd: 'workspace/demo', stdout: 'On branch main', stderr: '' });
  }, async (net) => {
    const r = await net.gitRun({ command: 'git status', repo: 'demo', timeoutSec: 8 });
    assert.equal(r.ok, true);
    assert.deepEqual(sent, { command: 'git status', repo: 'demo', timeout: 8 });
    assert.match(r.text, /On branch main/);
  });
});

group('联网：模型 API 自带的网页搜索请求格式');
const web = await import('../js/websearch.js');
// 能力表以「拿 key 真打过网关」的实测为准（2026-09-21，tests/live-web.mjs 里是同款断言）：
//   Claude / GPT 真联网；Kimi/GLM/Grok/Gemini 走不通 → 一律不联网，不让 UI 假装能查
test('按实测结果挑原生格式：只认 Claude 与 GPT', async () => {
  assert.equal(web.webCapFor('claude-sonnet-5').endpoint, 'messages');
  assert.equal(web.webCapFor('claude-haiku-4-5').endpoint, 'messages');
  assert.equal(web.webCapFor('gpt-5.6-sol').endpoint, 'responses', 'GPT 的自带格式在 /v1/responses');
  assert.equal(web.webCapFor('gpt-6-astra').endpoint, 'responses');
  // 实测：Kimi 的 $web_search 网关不执行、GLM 400、Grok 只把工具调用当文本吐回来
  for (const m of ['kimi-k3', 'glm-5.3', 'grok-4.6', 'gemini-3.5-flash', 'deepseek-v4-pro', '']) {
    assert.equal(web.webCapFor(m), null, `${m} 没有可用的原生格式，必须返回 null（不许改道第三方）`);
  }
  assert.match(web.webCapNote(null), /没有可用的原生联网格式/);
  assert.match(web.webCapNote(null), /Claude 或 GPT/);
  assert.match(web.webCapNote(web.webCapFor('claude-sonnet-5')), /web_search_20250305/);
});
test('诚实性护栏：正文声称「已联网」但没有检索事件时能被识别', async () => {
  const yes = [
    '我已经请求了模型的原生网页搜索功能，今日中间价为 7.28。',
    '已联网查询：今日美元兑人民币中间价为 7.28。',
    '已联网检索到 3 条来源。',
    '根据网络搜索结果，最新版本是 1.2.3。',
    '我刚上网查到该模型已下线。',
    'I used web_search to check this.',
    '刚才调用搜索工具确认过',
  ];
  const no = [
    '当前未联网，无法核实这个实时数据。',
    '我没有联网，不能给出今天的汇率。',
    '无法联网检索，建议你自行核实。',
    '联网开关是关的，所以本轮没有查询。',
    '这段代码的作用是发起一次 HTTP 请求。',
    '',
  ];
  for (const x of yes) assert.equal(web.claimsWebSearch(x), true, `应判为「声称联网」：${x}`);
  for (const x of no) assert.equal(web.claimsWebSearch(x), false, `不该判为「声称联网」：${x}`);
});

test('注入的请求体只加原生字段，不新增任何 host', async () => {
  const a = web.injectWeb({ model: 'claude-sonnet-5', messages: [] }, web.webCapFor('claude-sonnet-5'));
  assert.deepEqual(a.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]);
  const r = web.injectWeb({ model: 'gpt-5.6-sol', input: [] }, web.webCapFor('gpt-5.6-sol'));
  assert.deepEqual(r.tools, [{ type: 'web_search', search_context_size: 'medium' }]);
  assert.deepEqual(r.include, ['web_search_call.action.sources'], 'Responses 要 include 来源才有引用');
  // 实测走不通的厂商：请求体必须原样不动（连一个联网字段都不许塞）
  for (const m of ['kimi-k3', 'glm-5.3', 'grok-4.6', 'gemini-3.5-flash']) {
    const raw = { model: m, messages: [] };
    assert.deepEqual(web.injectWeb({ ...raw }, web.webCapFor(m)), raw, `${m} 不该被注入任何联网字段`);
  }
  for (const body of [a, r]) {
    assert.ok(!/duckduckgo|brave|tavily|serper|jina/i.test(JSON.stringify(body)), '请求体里不能出现第三方搜索服务');
  }
  assert.deepEqual(web.injectWeb({ model: 'deepseek-v4-pro', messages: [] }, null).tools, undefined);
});
test('已有客户端工具时原生工具是追加而不是替换', async () => {
  const cap = web.webCapFor('claude-sonnet-5');
  const body = web.injectWeb({ tools: [{ name: 'write_file' }], messages: [] }, cap);
  assert.deepEqual(body.tools.map((t) => t.name), ['write_file', 'web_search']);
});
test('Responses API 请求体：system→instructions，工具与附件映射成 input items', async () => {
  const { instructions, input } = web.buildResponsesInput([
    { role: 'system', text: '你是…' },
    { role: 'user', text: '看这张图', attachments: [{ kind: 'image', name: 'a.png', dataUrl: 'data:image/png;base64,AAA' }] },
    { role: 'assistant', text: '先写文件', toolCalls: [{ id: 'call_9', name: 'write_file', args: { path: 'a.txt' } }] },
    { role: 'tool', toolCallId: 'call_9', content: '已写入' },
  ]);
  assert.equal(instructions, '你是…');
  assert.deepEqual(input.map((x) => x.type), ['message', 'message', 'function_call', 'function_call_output']);
  assert.deepEqual(input[0].content[1], { type: 'input_image', image_url: 'data:image/png;base64,AAA' });
  assert.deepEqual(input[2], { type: 'function_call', call_id: 'call_9', name: 'write_file', arguments: '{"path":"a.txt"}' });
  assert.deepEqual(input[3], { type: 'function_call_output', call_id: 'call_9', output: '已写入' });
  const onlyUser = web.buildResponsesInput([{ role: 'user', text: 'hi' }]);
  assert.equal(onlyUser.instructions, '', '没有 system 时不要塞空 instructions');
});
test('Responses 流事件归一到与另两种协议相同的事件词汇', async () => {
  const evs = [];
  const h = web.createResponsesStream((e) => evs.push(e));
  h({ type: 'response.created', response: { id: 'resp_1' } });
  h({ type: 'response.output_item.added', item: { type: 'web_search_call', status: 'in_progress' } });
  h({ type: 'response.output_text.delta', delta: '查到 ' });
  h({ type: 'response.output_text.delta', delta: '3 条' });
  h({ type: 'response.output_item.done', item: { type: 'web_search_call', action: { query: 'pyodide 版本', sources: [{ url: 'https://a.test' }, { url: 'https://b.test' }] } } });
  h({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_1', name: 'write_file', arguments: '' } });
  h({ type: 'response.function_call_arguments.delta', delta: '{"path":"x"}' });
  h({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 11, output_tokens: 5 }, output: [] } });
  assert.deepEqual(evs.map((e) => e.type), ['web_search', 'text', 'text', 'web_search', 'tool_delta', 'tool_delta', 'usage', 'finish']);
  assert.equal(evs[1].text + evs[2].text, '查到 3 条');
  assert.equal(evs[3].status, 'done');
  assert.deepEqual(evs[3].queries, ['pyodide 版本']);
  assert.equal(evs[3].sources.length, 2, '引用来源要带出来');
  assert.equal(evs[4].name, 'write_file');
  assert.equal(evs[4].id, 'call_1');
  assert.deepEqual({ input: evs[6].usage.input, output: evs[6].usage.output }, { input: 11, output: 5 });
  assert.equal(evs[7].reason, 'stop');
  const err = [];
  web.createResponsesStream((e) => err.push(e))({ type: 'response.failed', error: { message: '上游炸了' } });
  assert.equal(err[0].message, '上游炸了', '失败要冒泡成 error 事件，不能静默结束');
  // 并行两个 function_call 且协议不给 output_index：不能塌成同一个 index（参数会糊成一坨）
  const acc = api.createToolCallAccumulator();
  const h2 = web.createResponsesStream((e) => { if (e.type === 'tool_delta') acc.push(e); });
  for (const it of [{ type: 'function_call', call_id: 'A', name: 'f1', arguments: '' }, { type: 'function_call', call_id: 'B', name: 'f2', arguments: '' }]) {
    h2({ type: 'response.output_item.added', item: it });
  }
  h2({ type: 'response.function_call_arguments.delta', call_id: 'A', delta: '{"p":1}' });
  h2({ type: 'response.function_call_arguments.delta', call_id: 'B', delta: '{"p":2}' });
  h2({ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'A', name: 'f1', arguments: '{"p":1}' } });
  h2({ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'B', name: 'f2', arguments: '{"p":2}' } });
  assert.deepEqual(acc.result().map((c) => [c.name, c.args.p]), [['f1', 1], ['f2', 2]], JSON.stringify(acc.result()));
});
test('Anthropic 流里的服务端联网块被归一为 web_search 事件', async () => {
  const evs = [];
  const h = api.createAnthropicStream((e) => evs.push(e));
  h({ type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} } });
  h({ type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: 'https://a.test', title: 'A' }, { type: 'web_search_result', url: 'https://b.test', title: 'B' }] } });
  h({ type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } });
  h({ type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: '据来源 A、B' } });
  assert.deepEqual(evs.map((e) => e.type), ['web_search', 'web_search', 'text']);
  assert.equal(evs[0].status, 'searching');
  assert.equal(evs[1].status, 'done');
  assert.equal(evs[1].results, 2);
  assert.deepEqual(evs[1].sources[0], { url: 'https://a.test', title: 'A' });
});
test('服务端联网块不进客户端工具累积器（否则会凭空多出一个空名工具调用）', async () => {
  const acc = api.createToolCallAccumulator();
  const evs = [];
  const h = api.createAnthropicStream((e) => { evs.push(e); if (e.type === 'tool_delta') acc.push(e); });
  // 实测网关会把网页工具混成两种块：server_tool_use 与名叫 web_search/web_fetch 的普通 tool_use
  h({ type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 's1', name: 'web_search', input: {} } });
  h({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"今天' } });
  h({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '日期"}' } });
  h({ type: 'content_block_stop', index: 0 });
  h({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'web_fetch', input: {} } });
  h({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"url":"https://a.test"}' } });
  h({ type: 'content_block_stop', index: 1 });
  // 真正的客户端工具照旧要收进累积器
  h({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu2', name: 'write_file', input: {} } });
  h({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":"a.txt"}' } });
  const calls = acc.result();
  assert.equal(calls.length, 1, `只应有 write_file，实际 ${JSON.stringify(calls)}`);
  assert.equal(calls[0].name, 'write_file');
  const q = evs.filter((e) => e.type === 'web_search' && e.status === 'query' && e.kind !== 'fetch');
  assert.deepEqual(q.map((e) => e.query), ['今天日期'], '分片要拼成完整查询词（且同一个词只报一次）');
  assert.equal(evs.some((e) => e.type === 'web_search' && e.status === 'query' && e.kind === 'fetch'), true, '抓取按 URL 上报');
});

test('Anthropic 抓取失败（web_search_tool_result_error）：如实报错而不是「0 条来源」', async () => {
  const evs = [];
  const h = api.createAnthropicStream((e) => evs.push(e));
  h({ type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'x' } } });
  h({ type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 's1', content: { type: 'web_search_tool_result_error', error_code: 'unavailable' } } });
  const err = evs.find((e) => e.type === 'web_search' && e.status === 'error');
  assert.ok(err, '要有 error 事件');
  assert.equal(err.message, 'unavailable');
  assert.equal(evs.some((e) => e.type === 'web_search' && e.status === 'done' && e.results > 0), false);
});

test('Anthropic 引用补标题：citations_delta 归一为 sources 事件', async () => {
  const evs = [];
  const h = api.createAnthropicStream((e) => evs.push(e));
  h({ type: 'content_block_delta', index: 0, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://a.test', title: '来源 A', cited_text: '正文' } } });
  const s = evs.find((e) => e.type === 'web_search' && e.status === 'sources');
  assert.deepEqual(s.sources, [{ url: 'https://a.test', title: '来源 A' }]);
});

test('streamChat：GPT 联网走 /v1/responses，Claude 联网走 /v1/messages 的服务器工具', async () => {
  const calls = [];
  api.__resetWebFallbackForTests();
  mockFetch([
    sseResponse('data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: '联网答完了' }) + '\n\ndata: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 3, output_tokens: 2 }, output: [] } }) + '\n\ndata: [DONE]\n\n', 200),
    api.anthropicTextTurnForTest ? api.anthropicTextTurnForTest('x') : sseResponse('data: ' + JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) + '\n\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'claude 联网答完' } }) + '\n\ndata: ' + JSON.stringify({ type: 'message_stop' }) + '\n\ndata: [DONE]\n\n', 200),
  ], calls);
  try {
    const msgs = [{ role: 'system', text: 'S' }, { role: 'user', text: '今天几点' }];
    let got = '';
    await api.streamChat({ model: 'gpt-5.6-sol', apiKey: 'k', messages: msgs, webEnabled: true, onEvent: (ev) => { if (ev.type === 'text') got += ev.text; } });
    assert.equal(got, '联网答完了');
    assert.ok(calls[0].url.endsWith('/v1/responses'), calls[0].url);
    assert.equal(calls[0].body.instructions, 'S', 'system 要落到 instructions');
    assert.deepEqual(calls[0].body.tools, [{ type: 'web_search', search_context_size: 'medium' }]);
    assert.equal(calls[0].body.stream, true);
    got = '';
    await api.streamChat({ model: 'claude-sonnet-5', apiKey: 'k', messages: msgs, webEnabled: true, onEvent: (ev) => { if (ev.type === 'text') got += ev.text; } });
    assert.ok(calls[1].url.endsWith('/v1/messages'), calls[1].url);
    assert.deepEqual(calls[1].body.tools.map((t) => t.type), ['web_search_20250305']);
    assert.equal(got, 'claude 联网答完');
  } finally { globalThis.fetch = realFetch; api.__resetWebFallbackForTests(); }
});
test('关掉联网就完全没有原生字段；无原生格式的模型也不联网', async () => {
  const calls = [];
  mockFetch([openaiTextTurn('ok'), openaiTextTurn('ok2')], calls);
  try {
    const msgs = [{ role: 'user', text: 'q' }];
    await api.streamChat({ model: 'gpt-5.6-sol', apiKey: 'k', messages: msgs, webEnabled: false, onEvent: () => {} });
    assert.ok(calls[0].url.endsWith('/v1/chat/completions'), '关联网时仍走 Chat Completions');
    assert.ok(!('tools' in calls[0].body) || calls[0].body.tools.every((t) => t.type === 'function'));
    await api.streamChat({ model: 'deepseek-v4-pro', apiKey: 'k', messages: msgs, webEnabled: true, onEvent: () => {} });
    assert.ok(calls[1].url.endsWith('/v1/chat/completions'), 'DeepSeek 没有原生格式 → 不改端点');
    assert.ok(!JSON.stringify(calls[1].body).includes('web_search'), '也不能塞任何联网字段');
  } finally { globalThis.fetch = realFetch; }
});
test('Responses 端点被拒 → 自动退回 Chat Completions、剥掉联网并告知', async () => {
  const calls = [];
  api.__resetWebFallbackForTests();
  mockFetch([
    new Response(JSON.stringify({ error: { message: 'responses api is only supported for gpt models' } }), { status: 400, headers: { 'content-type': 'application/json' } }),
    openaiTextTurn('退回后答完了'),
    openaiTextTurn('下一轮直接走 chat'), // 记住降级后第二次调用不该再碰 /v1/responses
  ], calls);
  let why = '';
  try {
    let got = '';
    await api.streamChat({
      model: 'gpt-5.6-sol', apiKey: 'k', messages: [{ role: 'user', text: 'q' }], webEnabled: true,
      onEvent: (ev) => { if (ev.type === 'text') got += ev.text; },
      onWebFallback: (m, note) => { why = note; },
    });
    assert.equal(got, '退回后答完了');
    assert.equal(calls.length, 2, '第一次被拒后必须重放一次');
    assert.ok(calls[1].url.endsWith('/v1/chat/completions'), calls[1].url);
    assert.ok(!JSON.stringify(calls[1].body).includes('web_search'), '重放时联网字段要摘掉');
    assert.match(why, /Responses API 端点被拒/);
    // 记住这个模型：后续回合不再白白试一次 Responses
    await api.streamChat({ model: 'gpt-5.6-sol', apiKey: 'k', messages: [{ role: 'user', text: 'q2' }], webEnabled: true, onEvent: () => {} });
    assert.ok(calls[2].url.endsWith('/v1/chat/completions'), '第二次直接走 chat 端点');
  } finally { globalThis.fetch = realFetch; api.__resetWebFallbackForTests(); }
});
test('联网字段被模型拒收 → 剥离重试并记入降级表（用 Claude 这条仍然支持的原生格式）', async () => {
  const calls = [];
  api.__resetWebFallbackForTests();
  mockFetch([
    new Response(JSON.stringify({ error: { message: "Invalid tool type 'web_search' for this model" } }), { status: 400, headers: { 'content-type': 'application/json' } }),
    anthropicTextTurn('没联网也答完了'),
    anthropicTextTurn('记住之后不带联网字段'),
  ], calls);
  const notes = [];
  try {
    let got = '';
    await api.streamChat({
      model: 'claude-sonnet-5', apiKey: 'k', messages: [{ role: 'user', text: 'q' }], webEnabled: true,
      onEvent: (ev) => { if (ev.type === 'text') got += ev.text; },
      onWebFallback: (m, note) => notes.push([m, note]),
    });
    assert.equal(got, '没联网也答完了');
    assert.equal(notes.length, 1);
    assert.match(notes[0][1], /拒绝原生联网字段/);
    assert.ok(api.webFallbackFor('claude-sonnet-5'), '该模型进入降级表，本会话不再重复尝试');
    assert.deepEqual(calls[0].body.tools.map((t) => t.type), ['web_search_20250305'], '第一次带原生联网工具');
    assert.equal(JSON.stringify(calls[1].body).includes('web_search'), false, '重放时已摘掉联网工具');
    await api.streamChat({ model: 'claude-sonnet-5', apiKey: 'k', messages: [{ role: 'user', text: 'q2' }], webEnabled: true, onEvent: () => {} });
    assert.ok(!JSON.stringify(calls[2].body).includes('web_search'), '记住之后连第一次请求都不带联网字段');
  } finally { globalThis.fetch = realFetch; api.__resetWebFallbackForTests(); }
});
test('Agent 回合：联网来源写进消息（切会话后还在），提示词按开关说明联网', async () => {
  const calls = [];
  api.__resetWebFallbackForTests();
  mockFetch([
    sseResponse(['data: ' + JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} } }) + '\n\n',
      'data: ' + JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [{ type: 'web_search_result', url: 'https://src.test/x', title: '来源一' }] } }) + '\n\n',
      'data: ' + JSON.stringify({ type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } }) + '\n\n',
      'data: ' + JSON.stringify({ type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: '据来源一' } }) + '\n\n',
      'data: ' + JSON.stringify({ type: 'message_stop' }) + '\n\n', 'data: [DONE]\n\n'].join(''), 200),
    anthropicTextTurn('未联网时照样能答'),
  ], calls);
  let seen = null;
  try {
    const store = createStore();
    store.state.apiKey = 'sk-teamo-test';
    store.state.model = 'claude-sonnet-5';
    store.state.settings.webEnabled = true;
    const agent = createAgent(store, { onWebSearch: (m, w) => { seen = w; } });
    await agent.send('今天有什么新闻');
    assert.equal(seen.results, 1, 'UI 要收到「检索到 1 条来源」');
    const done = [...store.state.messages].reverse().find((m) => m.role === 'assistant');
    assert.equal(done.webSearch.sources[0].url, 'https://src.test/x', '来源随消息持久化');
    const sys = calls[0].body.system || calls[0].body.messages[0].content;
    assert.match(sys, /本轮已按当前模型的原生格式开启服务端网页搜索/, '开联网时提示词要说明能力从哪来');
    assert.match(sys, /不必等用户点名/);
    // 关掉联网后必须换成「别声称能联网」的说法
    store.state.settings.webEnabled = false;
    await agent.send('再来一轮');
    const sys2 = calls[1].body.system || calls[1].body.messages[0].content;
    assert.match(sys2, /本轮未联网（本项目不接任何第三方搜索接口）/);
    assert.ok(!/web_search_20250305/.test(String(sys2)), '关联网时不要再宣称已开启服务端搜索');
    assert.ok(!('tools' in calls[1].body) || calls[1].body.tools.every((t) => t.name !== 'web_search'), '也不能带原生联网工具');
  } finally { globalThis.fetch = realFetch; api.__resetWebFallbackForTests(); await drainSaves(); }
});
group('工具层：抓取与 git 工具的对外契约');
test('TOOL_DEFS 注册齐全且参数必填项正确', async () => {
  const byName = Object.fromEntries(TOOL_DEFS.map((t) => [t.name, t]));
  for (const n of ['fetch_url', 'run_git']) assert.ok(byName[n], `缺少工具 ${n}`);
  assert.ok(!byName.web_search, '不能再有 web_search 工具：联网由模型 API 自带格式完成（用户明确要求不接第三方搜索）');
  assert.deepEqual(byName.fetch_url.parameters.required, ['url']);
  assert.deepEqual(byName.fetch_url.parameters.properties.mode.enum, ['text', 'raw'], 'markdown 模式依赖第三方抽取器，必须移除');
  assert.ok(byName.run_git.parameters.required.includes('command'));
  assert.ok(/git /.test(byName.run_git.description), '描述里要写清 git 走本地中继');
  assert.ok(TOOL_DEFS.length >= 10, `工具总数：${TOOL_DEFS.length}`);
});
test('系统提示词提到了抓取与 git、并说明联网不是工具（漂移守卫）', async () => {
  const sp = cfg.systemPrompt();
  for (const kw of ['fetch_url', 'run_git', '联网']) assert.ok(sp.includes(kw), `提示词缺少 ${kw}`);
  assert.match(sp, /不要去找一个叫 web_search 的工具/, '要说明联网不是工具');
  assert.match(sp, /查不到就明说没查到|明确说无法核实/, '要有「查不到就明说」的自主性规则');
});
test('executeTool(fetch_url) 用 save_path 落盘并在芯片里标记 fsChange', async () => {
  await withNetFetch(async (url) => {
    if (url.startsWith('/api/health')) return NO_RELAY['/api/health']();
    return new Response('<h1>Doc</h1>' + '<p>段落</p>'.repeat(700), { status: 200, headers: { 'content-type': 'text/html' } });
  }, async () => {
    const fs = createFS();
    const ev = [];
    const out = await executeTool('fetch_url', { url: 'https://example.com/d', save_path: 'web/notes.md' }, { fs, onUi: (p) => ev.push(p) });
    assert.match(out, /^\[抓取完成\] https:\/\/example\.com\/d/, out.slice(0, 80));
    assert.ok(fs.read('web/notes.md').includes('段落'), 'save_path 必须真的生效');
    assert.ok(ev.some((p) => p.fsChange === true), '芯片要告知文件面板刷新');
  });
});
test('executeTool(fetch_url) 失败时返回可读原因（不抛）', async () => {
  const out = await executeTool('fetch_url', { url: 'javascript:alert(1)' }, { fs: createFS(), onUi: () => {} });
  assert.match(out, /^fetch_url 失败：/, out);
});
test('executeTool(run_git) 无中继时返回带修复说明的失败', async () => {
  await withNetFetch(async (url) => (url.startsWith('/api/health') ? NO_RELAY['/api/health']() : jsonResponse({})), async () => {
    const ev = [];
    const out = await executeTool('run_git', { command: 'git status' }, { fs: createFS(), onUi: (p) => ev.push(p) });
    assert.match(out, /^run_git 失败：git 命令需要本地中继/, out.slice(0, 40));
    assert.equal(ev[ev.length - 1].status, 'error');
    assert.match(ev[ev.length - 1].error.message, /python3 server\.py/);
  });
});
test('抓取与 git 工具在关闭沙箱时依然可用（它们不依赖 Worker）', async () => {
  const names = (await import('../js/tools.js')).toolsFor(false).map((t) => t.name);
  for (const n of ['fetch_url', 'run_git']) assert.ok(names.includes(n), `关沙箱后 ${n} 不应被摘掉`);
  assert.ok(!names.includes('execute_python'), '代码执行工具仍应被摘掉');
});

// ── 顺序执行（async 测试逐个 await）──
for (const item of queue) {
  if (item.group) { console.log(item.group); continue; }
  await item.fn();
  passed++;
  console.log(`  ✓ ${item.name}`);
}
console.log(`\n${passed} 项测试全部通过 ✅`);
