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
// 单测默认关掉联网与 Jev：Jev 会先打 /v1/systemone，否则会吃掉 mock 队列里给聊天用的那一格。
const storeNoWeb = (st) => { st.state.settings.webEnabled = false; st.state.settings.jevEnabled = false; return st; };

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
test('OpenAI：图片改为文本提示走 analyze_image，文本附件仍是 text part', () => {
  const [m] = buildOpenAIMessages([{ role: 'user', text: '看图', attachments: [IMG_ATT, TXT_ATT] }]);
  assert.equal(m.content[0].text, '看图');
  assert.equal(m.content[1].type, 'text');
  assert.match(m.content[1].text, /analyze_image/);
  assert.equal(m.content[1].image_url, undefined);
  assert.ok(m.content[2].text.includes('【附件：n.csv】'));
});
test('Anthropic：图片改为文本提示，stripped 附件 → 省略说明', () => {
  const pld = buildAnthropicPayload([{ role: 'user', text: '看图', attachments: [IMG_ATT, { kind: 'text', name: 'x.txt', stripped: true }] }]);
  const content = pld.messages[0].content;
  assert.equal(content[1].type, 'text');
  assert.match(content[1].text, /analyze_image/);
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
test('推理级别 Mini/Low/Medium/High/Max/Ultra 映射到各协议', async () => {
  const r = await import('../js/reasoning.js');
  assert.deepEqual(r.REASONING_LEVELS, ['mini', 'low', 'medium', 'high', 'max', 'ultra']);
  assert.equal(thinkingParamsFor('claude-sonnet-5', 'mini').thinking.budget_tokens, 1024);
  assert.equal(thinkingParamsFor('claude-sonnet-5', 'ultra').thinking.budget_tokens, 32768);
  assert.equal(thinkingParamsFor('gpt-5.6-sol', 'mini').reasoning_effort, 'minimal');
  assert.equal(thinkingParamsFor('gpt-5.6-sol', 'ultra').reasoning_effort, 'xhigh');
  assert.equal(thinkingParamsFor('gemini-3.8-flash', 'ultra').reasoning_effort, 'high');
  assert.equal(thinkingParamsFor('grok-4.6', 'mini').reasoning_effort, 'low');
  assert.equal(r.normalizeReasoningLevel('MAX'), 'max');
  assert.equal(r.normalizeReasoningLevel('nope'), 'medium');
  const fsp = await import('node:fs');
  const html = fsp.readFileSync(new URL('../app.html', import.meta.url), 'utf8');
  const ui = fsp.readFileSync(new URL('../js/ui.js', import.meta.url), 'utf8');
  assert.match(html, /id="think-menu"/);
  assert.match(ui, /REASONING_LEVELS/);
  assert.match(ui, /data-think/);
  assert.match(ui, /data-think="off"><span class="think-lab">Off/);
  assert.match(ui, /msg-actions-user/);
  assert.match(ui, /data-act="copy"/);
  assert.match(ui, /act-danger/);
  assert.ok(ui.includes("classList.toggle('ultra'"));
  assert.equal(html.includes('tab-agents') || html.includes('data-tab="agents"'), false, '子智能体展示面板应删除');
  const cssUltra = fsp.readFileSync(new URL('../css/styles.css', import.meta.url), 'utf8');
  assert.match(cssUltra, /ultra-diag/);
  assert.ok(cssUltra.includes('.pill.ultra'));
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
test('supportsVision：对话通道一律纯文本', async () => {
  const { supportsVision, isImageModel } = await import('../js/config.js');
  for (const id of ['claude-sonnet-5', 'gpt-5.6-sol', 'gemini-3.8-flash', 'deepseek-v4-flash-vision-exp', '']) {
    assert.equal(supportsVision(id), false, id);
  }
  assert.ok(isImageModel('deepseek-v4-flash-vision-exp'), '识图模型不进对话选择器');
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
  assert.match(OUTPUT_SPEC, /完整可运行/, '代码不得写太短太简略');
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

test('工具循环：TOOL_LOOP_MAX=0 表示不限制次数', async () => {
  const { TOOL_LOOP_MAX } = await import('../js/config.js');
  const { formatBudgetNote } = await import('../js/prompt.js');
  assert.equal(TOOL_LOOP_MAX, 0, '上限会掐死多步 Agent，必须关掉');
  assert.equal(formatBudgetNote(8, 0), '');
  assert.equal(formatBudgetNote(99, 0), '');
  const calls = [];
  mockFetch([
    openaiToolTurn('call_1', 'write_file', JSON.stringify({ path: 'a.txt', content: '1' })),
    openaiToolTurn('call_2', 'write_file', JSON.stringify({ path: 'b.txt', content: '2' })),
    openaiToolTurn('call_3', 'write_file', JSON.stringify({ path: 'c.txt', content: '3' })),
    openaiTextTurn('三步完成'),
  ], calls);
  try {
    const store = storeNoWeb(createStore());
    store.state.apiKey = 'sk-teamo-test';
    store.state.model = 'gpt-5.6-sol';
    const agent = createAgent(store, {});
    await agent.send('写三个文件');
    assert.equal(calls.length, 4, '超过旧的 8 次上限之前的多步循环必须跑完');
    assert.equal(store.state.messages[store.state.messages.length - 1].text, '三步完成');
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
    assert.equal(calls[0].body.max_tokens, 12288, '代码任务 + 思考：budget+任务上限');
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

group('生图模型目录（GPT Image 2 / 2.5 系列 · Nano Banana 2）');
test('生图模型可被识别，且不出现在对话模型兜底列表中', () => {
  const { IMAGE_MODELS, isImageModel, isImageGenModel, FALLBACK_MODELS, DEFAULT_IMAGE_MODEL } = cfg;
  const ids = IMAGE_MODELS.map((m) => m.id);
  for (const want of ['gemini-3.1-flash-image', 'gpt-image-2', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare']) {
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
  assert.ok(ids.includes('deepseek-v4-flash-vision-exp'), '识图模型仍在目录（只给工具用）');
  assert.equal(cfg.supportsVision('deepseek-v4-flash-vision-exp'), false, '对话通道不标视觉');
  assert.ok(cfg.isImageModel('deepseek-v4-flash-vision-exp'), '从对话选择器隐藏');
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
test('Nano Banana 生成：POST /v1beta/models/…:generateContent，遍历 parts 取 inlineData', async () => {
  const realFetch = globalThis.fetch;
  let captured = null;
  const b64 = Buffer.from('fake-png-bytes').toString('base64');
  globalThis.fetch = async (url, opts) => {
    captured = { url: String(url), headers: opts.headers, body: JSON.parse(opts.body) };
    return new Response(JSON.stringify({
      candidates: [{
        content: {
          parts: [
            { text: 'here you go' },
            { inlineData: { mimeType: 'image/png', data: b64 } },
          ],
        },
      }],
    }), { status: 200 });
  };
  try {
    const fs = createFS();
    const events = [];
    const res = await executeTool('generate_image',
      { prompt: '一只在键盘上打字的橘猫', size: '16:9', model: 'gpt-image-2' },
      { fs, apiKey: 'sk-teamo-test', imageModel: 'gemini-3.1-flash-image', onUi: (p) => events.push(p) });
    assert.match(captured.url, /\/v1beta\/models\/gemini-3\.1-flash-image:generateContent$/, '应走 Gemini 原生端点');
    assert.ok(!/\/v1\/images\//.test(captured.url), '禁止落到 OpenAI Images 端点');
    assert.equal(captured.headers.Authorization, 'Bearer sk-teamo-test');
    assert.deepEqual(captured.body.generationConfig.responseModalities, ['IMAGE']);
    assert.equal(captured.body.generationConfig.imageConfig.aspectRatio, '16:9');
    assert.equal(captured.body.generationConfig.imageConfig.imageSize, '1K');
    assert.equal(captured.body.contents[0].role, 'user');
    assert.equal(captured.body.contents[0].parts[0].text, '一只在键盘上打字的橘猫');
    assert.ok(/outputs\/image-001\.png/.test(res));
    assert.equal(fs.read('outputs/image-001.png'), `data:image/png;base64,${b64}`);
    const ok = events.find((e) => e.status === 'ok' && e.image);
    assert.ok(ok, 'onUi 应回传 ok + 图片');
    assert.match(res, /忽略工具参数/, '菜单选定优先于工具参数里的 GPT');
  } finally { globalThis.fetch = realFetch; }
});
test('Nano Banana 编辑：同端点，parts 含指令 + inlineData（无 data: 前缀）', async () => {
  const realFetch = globalThis.fetch;
  let captured = null;
  const outB64 = Buffer.from('edited-nano-bytes').toString('base64');
  globalThis.fetch = async (url, opts) => {
    captured = { url: String(url), headers: opts.headers, body: JSON.parse(opts.body) };
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/png', data: outB64 } }] } }],
    }), { status: 200 });
  };
  try {
    const origin = Buffer.from('origin-png-bytes').toString('base64');
    const fs = createFS({ 'uploads/cat.png': `data:image/png;base64,${origin}` });
    const res = await executeTool('generate_image',
      { prompt: '把背景换成雪山', reference_paths: ['uploads/cat.png'], size: '1024x1024' },
      { fs, apiKey: 'sk-teamo-test', imageModel: 'gemini-3.1-flash-image', onUi: () => {} });
    assert.match(captured.url, /\/v1beta\/models\/gemini-3\.1-flash-image:generateContent$/);
    assert.ok(!(captured.body instanceof FormData), '编辑也是 JSON generateContent，不是 multipart Images');
    const parts = captured.body.contents[0].parts;
    assert.equal(parts[0].text, '把背景换成雪山');
    assert.equal(parts[1].inlineData.mimeType, 'image/png');
    assert.equal(parts[1].inlineData.data, origin, 'base64 不得带 data: 前缀');
    assert.ok(!String(parts[1].inlineData.data).startsWith('data:'));
    assert.equal(captured.body.generationConfig.imageConfig.aspectRatio, '1:1');
    assert.equal(captured.body.generationConfig.imageConfig.imageSize, '1K');
    assert.ok(/outputs\/image-001\.png/.test(res));
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
  assert.equal(r('nano banana').id, 'gemini-3.1-flash-image', 'Nano Banana 口语别名');
  assert.equal(r('Nano Banana 2').id, 'gemini-3.1-flash-image');
  assert.equal(r('banana').id, 'gemini-3.1-flash-image');
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
  const cataloged = cfg.resolveImageModel('gemini-3.1-flash-image', 'gpt-image-2');
  assert.equal(cataloged.id, 'gemini-3.1-flash-image', '目录内 ID 精确命中，不再当透传');
  assert.equal(cataloged.passthrough, undefined);
  const foreign = cfg.resolveImageModel('imagen-4.0-generate', 'gpt-image-2');
  assert.equal(foreign.id, 'imagen-4.0-generate', '形状像网关 ID 的透传，便于使用 /v1/models 里的其它生图模型');
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
  assert.ok(/gemini-3\.1-flash-image/.test(sys), '系统提示词列出 Nano Banana 真实 ID');
  assert.ok(/不要传 model/.test(sys), '系统提示词禁止用工具参数覆盖菜单选定');
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
test('会话选定的生图模型优先于工具参数 model', async () => {
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
    assert.equal(sent.model, 'gpt-image-2', '菜单选定覆盖工具参数里的显示名/其它 ID');
    assert.match(res, /忽略工具参数/, '文案里说明忽略，便于模型下次不要传 model');
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
  for (const k of ['bolt', 'download', 'folder', 'folderOpen', 'file', 'image', 'chevRight', 'x', 'thinking', 'tool']) {
    assert.ok(ICON[k].startsWith('<svg') && ICON[k].includes('stroke="currentColor"') && !ICON[k].includes('#'), `${k} 应为 currentColor 单色 SVG`);
    assert.ok(/fill="none"/.test(ICON[k]), `${k} 线性描边而非填充`);
  }
});

group('空状态任务示例（js/suggestions.js）');
const sg = await import('../js/suggestions.js');
test('示例池覆盖多类能力且文案不重复', () => {
  assert.ok(sg.SUGGESTIONS.length >= 12, `池子应有 ≥12 条，实际 ${sg.SUGGESTIONS.length}`);
  const texts = sg.SUGGESTIONS.map((x) => x.text);
  const titles = sg.SUGGESTIONS.map((x) => x.title);
  assert.equal(new Set(texts).size, texts.length, '存在重复文案');
  assert.ok(sg.SUGGESTIONS.every((x) => x.title && x.title.length >= 18 && x.title.length <= 32 && x.text && x.text.length >= 140), '卡片 20–30 字概括，填入约 200 字提示');
  assert.equal(new Set(titles).size, titles.length, '短主题重复');
  assert.ok(sg.SUGGESTIONS.every((x) => x.tag === undefined), '示例条目不应再带 tag（任务类型标签已移除）');
  const joined = sg.SUGGESTIONS.map((x) => x.text).join('\n');
  for (const kw of ['沙箱', '海报', 'zip', 'Python', 'LRU']) {
    assert.ok(joined.includes(kw), `示例应覆盖「${kw}」`);
  }
  assert.equal(joined.includes('code-reviewer'), false);
  assert.equal(['code-reviewer', 'GET /v1/models', '刚上传的图片', '打开「快速」', 'qwen'].some((k) => joined.includes(k)), false, '不要超出能力或依赖未发生的操作');
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
  assert.equal(sg.SUGGESTIONS[0].title, '用 Python 做线性回归并写出带残差表的报告');
  const first = sg.pickSuggestions(sg.SUGGESTIONS, 3, rnd);
  const second = sg.pickSuggestions(sg.SUGGESTIONS, 3, rnd, first.map((x) => x.text));
  assert.equal(second.some((x) => first.some((y) => y.text === x.text)), false, 'exclude 应避开上一批');
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
test('app.html 入口资源用 ?v=APP_VERSION 穿透 Pages 缓存', async () => {
  const fsp = await import('node:fs');
  const html = fsp.readFileSync(new URL('../app.html', import.meta.url), 'utf8');
  const { APP_VERSION } = await import('../js/config.js');
  assert.match(APP_VERSION, /^\d{4}\.\d{1,2}\.\d{1,2}\.\d+$/, '版本形如 2026.9.26.1');
  for (const asset of ['css/styles\\.css', 'js/main\\.js']) {
    const m = new RegExp(`${asset}\\?v=([\\d.]+)`).exec(html);
    assert.ok(m, `${asset.replace(/\\/g, '')} 应带 ?v=`);
    assert.equal(m[1], APP_VERSION, '?v= 必须与 APP_VERSION 同步（发版一起 bump）');
  }
  assert.match(html, /id="build-stamp"/, '侧栏要有可见的构建标识');
  const mainSrc = fsp.readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  assert.match(mainSrc, /ui && ui\.onUserMessage\(msg\)/, 'main.js 仍显式接上用户消息上屏');
});
test('index.html 是产品介绍页并跳转到 app.html', async () => {
  const fsp = await import('node:fs');
  const home = fsp.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const { APP_VERSION } = await import('../js/config.js');
  assert.equal(home.includes('id="messages"'), false, '落地页不应再挂对话 DOM');
  assert.match(home, /href="\.\/app\.html"/);
  assert.match(home, /css\/home\.css\?v=/);
  const m = /css\/home\.css\?v=([\d.]+)/.exec(home);
  assert.equal(m[1], APP_VERSION);
  assert.match(home, /开始对话|进入对话/);
  assert.match(home, /media-src 'self'/);
  assert.match(home, /assets\/audio\/teamo-home\.wav/);
  assert.match(home, /id="score-play"/);
  const homeJs = fsp.readFileSync(new URL('../js/home.js', import.meta.url), 'utf8');
  assert.match(homeJs, /const BPM = 124/);
  assert.match(homeJs, /const BEAT = 60 \/ BPM/);
  assert.match(homeJs, /beat % 4 === 0/);
});


group('工具可用性：沙箱开关只该管住代码执行');
test('toolsFor：关闭沙箱只摘掉三个代码执行工具', async () => {
  const { toolsFor, CODE_TOOL_NAMES } = await import('../js/tools.js');
  const off = toolsFor(false).map((t) => t.name);
  const on = toolsFor(true).map((t) => t.name);
  assert.deepEqual(on, TOOL_DEFS.map((t) => t.name), '开启时应是全部工具');
  for (const n of CODE_TOOL_NAMES) assert.ok(!off.includes(n), `${n} 应被关掉`);
  for (const n of ['write_file', 'read_file', 'list_files', 'delete_file', 'copy_file', 'search_files', 'diff_text', 'json_tool', 'dispatch_subagent', 'generate_image', 'get_current_time', 'analyze_image']) {
    assert.ok(off.includes(n), `${n} 与代码执行无关，关沙箱也要可用`);
  }
});
test('executeTool：沙箱关闭时拒绝执行代码（未显式关闭的旧调用方不受影响）', async () => {
  const r = await executeTool('execute_javascript', { code: '1+1' }, { fs: createFS(), sandboxEnabled: false });
  assert.match(r, /沙箱已关闭/, '应给出可纠错的说明而不是悄悄执行');
  const legacy = await executeTool('list_files', {}, { fs: createFS({ 'a.txt': 'x' }) });
  assert.match(legacy, /a\.txt/, 'ctx 未标 sandboxEnabled 时不应误伤');
});
test('search_files / diff_text / json_tool / copy_file / delete_file 本地工作台', async () => {
  const fs = createFS({
    'src/a.js': 'const n = 42;\nexport function add(a, b) { return a + b; }\n',
    'src/b.js': 'const n = 43;\nexport function add(a, b) { return a + b; }\n',
    'data.json': '{"models":["claude-sonnet-5"],"thinking":false}',
  });
  const hit = await executeTool('search_files', { pattern: 'const n = 42' }, { fs });
  assert.match(hit, /src\/a\.js/);
  const d = await executeTool('diff_text', { left_path: 'src/a.js', right_path: 'src/b.js' }, { fs });
  assert.match(d, /^-const n = 42/m);
  assert.match(d, /^\+const n = 43/m);
  const pretty = await executeTool('json_tool', { action: 'pretty', path: 'data.json' }, { fs });
  assert.match(pretty, /"thinking": false/);
  const got = await executeTool('json_tool', { action: 'get', path: 'data.json', pointer: 'models.0' }, { fs });
  assert.match(got, /claude-sonnet-5/);
  const copied = await executeTool('copy_file', { from: 'data.json', to: 'backup/data.json' }, { fs });
  assert.match(copied, /已复制/);
  assert.equal(fs.read('backup/data.json').includes('thinking'), true);
  const moved = await executeTool('copy_file', { from: 'backup/data.json', to: 'keep.json', move: true }, { fs });
  assert.match(moved, /已移动/);
  let gone = false;
  try { fs.read('backup/data.json'); } catch { gone = true; }
  assert.equal(gone, true);
  const del = await executeTool('delete_file', { path: 'keep.json' }, { fs });
  assert.match(del, /已删除/);
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
  const sys = cfg.systemPrompt(new Date(), { allowDispatch: true });
  assert.match(sys, /dispatch_subagent/, '能力清单必须包含委派工具');
  assert.match(sys, /不要等用户点名/, '要写明无需用户点名即可委派');
  assert.match(sys, /同一轮/, '要允许一轮内并行发起多个工具调用');
  assert.match(sys, /代码执行工具需要用户开启/, '沙箱开关的作用范围要说清');
  const locked = cfg.systemPrompt();
  assert.match(locked, /Max 或 Ultra/, '默认不委派，须点明 Max/Ultra');
  assert.match(locked, /非代码话题|非专业话题|闲聊/);
  assert.match(cfg.OUTPUT_SPEC, /<<<CONTINUE>>>/);
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
    store.state.settings.thinking = true;
    store.state.settings.reasoningLevel = 'max';
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
    store.state.settings.thinking = true;
    store.state.settings.reasoningLevel = 'ultra';
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
test('write_file 支持 append 与 replace 局部修改', async () => {
  const fs = createFS();
  await executeTool('write_file', { path: 'n.md', content: 'hello' }, { fs });
  const a = await executeTool('write_file', { path: 'n.md', mode: 'append', content: ' world' }, { fs });
  assert.match(a, /已追加/);
  assert.equal(fs.read('n.md'), 'hello world');
  const r = await executeTool('write_file', { path: 'n.md', mode: 'replace', old_text: 'world', new_text: 'Teamo' }, { fs });
  assert.match(r, /已局部修改/);
  assert.equal(fs.read('n.md'), 'hello Teamo');
  const miss = await executeTool('write_file', { path: 'n.md', mode: 'replace', old_text: 'nope', new_text: 'x' }, { fs });
  assert.match(miss, /找不到指定片段/);
});
test('analyze_image 缺 path 时列出沙箱图片，不发请求', async () => {
  const png = 'data:image/png;base64,AAA';
  const fs = createFS({ 'uploads/p.png': png, 'uploads/q.jpg': png, 'notes.txt': 'x' });
  let hit = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { hit++; return new Response('{}'); };
  try {
    const out = await executeTool('analyze_image', {}, { fs, apiKey: 'k' });
    assert.match(out, /缺少 path/);
    assert.match(out, /uploads\/p\.png/);
    assert.equal(hit, 0);
  } finally { globalThis.fetch = orig; }
});

test('识图：max_tokens 拉高、length 截断会续写、全文落盘且不摘要', async () => {
  const png = 'data:image/png;base64,AAA';
  const fs = createFS({ 'uploads/shot.png': png });
  const bodies = [];
  const orig = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    n += 1;
    const content = n === 1 ? '第一段OCR' : '第二段OCR';
    const finish = n === 1 ? 'length' : 'stop';
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content }, finish_reason: finish }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const out = await executeTool('analyze_image', { path: 'uploads/shot.png' }, { fs, apiKey: 'k' });
    assert.equal(bodies[0].max_tokens, 16384, '未设 max_tokens 时网关会把 OCR 砍短');
    assert.equal(bodies[0].model, 'deepseek-v4-flash-vision-exp');
    assert.equal(bodies[0].reasoning, false);
    assert.equal(bodies.length, 2, 'finish_reason=length 必须续写');
    assert.match(out, /第一段OCR第二段OCR/);
    assert.match(out, /shot\.ocr\.md/);
    assert.equal(fs.read('uploads/shot.ocr.md'), '第一段OCR第二段OCR');
  } finally { globalThis.fetch = orig; }
});
test('识图：content 为 parts 数组时拼成全文', async () => {
  const { analyzeImage } = await import('../js/vision.js');
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: [{ type: 'text', text: '甲' }, { type: 'text', text: '乙' }] }, finish_reason: 'stop' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const t = await analyzeImage({ apiKey: 'k', dataUrl: 'data:image/png;base64,AAA' });
    assert.equal(t, '甲乙');
  } finally { globalThis.fetch = orig; }
});
test('compactMessages：识图全文在 preflight 时也不截断', () => {
  const ocr = '[识图完成] 模型 x · 文件 uploads/a.png\n\n' + '字'.repeat(20000);
  const one = [
    { role: 'user', text: '看图' },
    { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'analyze_image', args: {} }] },
    { role: 'tool', toolCallId: 'c1', name: 'analyze_image', content: ocr },
    { role: 'user', text: '继续' },
  ];
  const tokens = estimateTokens(one);
  const pf = compactMessages(one, tokens, { preflight: true });
  assert.equal(pf.messages[2].content, ocr, '识图结果不得被 preflight 砍成摘要');
  const py = '结果行\n'.repeat(2000);
  const other = [
    { role: 'user', text: '旧问' },
    { role: 'assistant', text: '', toolCalls: [{ id: 'c2', name: 'execute_python', args: {} }] },
    { role: 'tool', toolCallId: 'c2', name: 'execute_python', content: py },
    { role: 'user', text: '新问' },
  ];
  const chopped = compactMessages(other, Math.floor(estimateTokens(other) * 0.9), { preflight: true });
  assert.ok(chopped.messages[2].content.length < py.length, '非识图工具仍可收紧');
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
test('原生网页搜索已下线：webCapFor 对任何模型都是 null', async () => {
  for (const m of ['claude-sonnet-5', 'gpt-5.6-sol', 'kimi-k3', 'glm-5.3', 'grok-4.6', 'gemini-3.5-flash', 'deepseek-v4-pro', '']) {
    assert.equal(web.webCapFor(m), null, m);
  }
});
test('webRefusal()：认出「我上不了网」式拒答，但别把正常技术回答当拒答', async () => {
  const { webRefusal } = await import('../js/websearch.js');
  const 拒答 = [
    '我无法实时获取今天的美元兑人民币中间价，因为我没有联网查询当前金融数据的能力。',
    '我无法访问当前的实时汇率数据。',
    '我不能浏览互联网或访问实时金融数据源。',
    '我的知识库有截止日期限制，无法访问当前的实时汇率数据。',
    'I cannot access the internet.',
    '我没有访问当前金融数据的能力。',
    '我没有联网。',
    '本模型没有可用的联网工具。',
    '我无法联网检索。',
    '我无法联网，请自行核实。',
    '我无法联网查询实时数据。',
    '本助手没有联网搜索功能。',
  ];
  for (const t of 拒答) assert.equal(webRefusal(t), true, `应判为拒答：${t}`);
  const 正常 = [
    '根据今天的搜索结果，美元兑人民币中间价是 6.7487',
    '已联网查询到 3 条来源',
    '你好，有什么可以帮你？',
    '这段代码会发起一次 HTTP 请求并读取响应体',
    '我没有访问该目录的权限，请先 chmod。',
    '该函数不能访问网络——它是纯计算函数。',
    '如果网络不可用，脚本会抛错。',
    '我的知识截止到 2025 年 8 月，但这条我确定。',
    '我没有联网权限的沙箱里也能跑 pyodide。',
    '沙箱里没有可用的搜索工具，请用 grep。',
  ];
  for (const t of 正常) assert.equal(webRefusal(t), false, `不该判为拒答：${t}`);
  // 声称查过的不算「上不了网」——那条走 claimsWebSearch 的提醒
  assert.equal(webRefusal('我已经请求了模型的原生网页搜索功能'), false);
});

test('重数据外置：附件图片与沙箱里的图不会把 localStorage 顶爆（extractBlobs/applyBlobs）', async () => {
  const { extractBlobs, applyBlobs, collectBlobKeys } = await import('../js/state.js');
  const big = 'data:image/png;base64,' + 'A'.repeat(80 * 1024);   // 80KB data URL
  const txt = 'x'.repeat(30000);
  const state = {
    activeSessionId: 's1',
    sessions: [{
      id: 's1',
      messages: [
        { id: 'm1', role: 'user', text: '看图', attachments: [{ kind: 'image', name: 'a.png', dataUrl: big }, { kind: 'text', name: 'b.txt', text: txt }] },
        { id: 'm2', role: 'assistant', text: '画好了', toolCalls: [{ id: 'c1', name: 'generate_image', args: {}, image: big, imagePath: 'outputs/a.png' }] },
      ],
      files: { 'outputs/a.png': big, 'notes.md': '小文件照旧留在快照里' },
    }],
    messages: [], files: {},
  };
  const ex = extractBlobs(state);
  const json = JSON.stringify(ex.light);
  assert.equal(/data:image\/png;base64/.test(json), false, '轻量快照里不能再有 base64 图');
  // 长附件文本按 ATT_TEXT_KEEP=2 万字符留了预览，所以不是「越小越好」，但要远小于原状态（≈19 万字符）
  assert.ok(json.length < 60000, `轻量快照应远小于原状态，实际 ${json.length}`);
  assert.ok(json.includes('小文件照旧留在快照里'), '普通文本文件照旧留在快照里');
  // 4 份：附件图 + 长附件文本 + 芯片里的生成图 + 沙箱里的同名 data URL 文件
  assert.equal(ex.blobs.length, 4, `应外置 4 份重数据，实际 ${ex.blobs.length}`);
  assert.equal(collectBlobKeys(ex.light).length, 4, '索引 key 要能重新收集出来');
  // 模拟「重新打开网页」：从空状态 + IDB 数据回填
  const restored = JSON.parse(json);
  const n = applyBlobs(restored, new Map(ex.blobs));
  assert.equal(n, 4, '四份都该回填');
  assert.equal(restored.sessions[0].messages[0].attachments[0].dataUrl, big, '附件图回来了');
  assert.equal(restored.sessions[0].messages[0].attachments[1].text, txt, '长附件文本全文回来了');
  assert.equal(restored.sessions[0].messages[1].toolCalls[0].image, big, '生成图回来了');
  assert.equal(restored.sessions[0].files['outputs/a.png'], big, '沙箱里的图回来了');
  assert.equal(restored.sessions[0].messages[0].attachments[0].stripped, false);
  // 没有 IDB 数据时不能崩，只是保持「已省略」
  const lost = JSON.parse(json);
  assert.equal(applyBlobs(lost, new Map()), 0);
  assert.equal(lost.sessions[0].messages[0].attachments[0].dataUrl, undefined);
  assert.equal(lost.sessions[0].messages[0].attachments[0].stripped, true);
});

test('孤儿数据会被清理：会话/消息删掉后不再保留对应的 IDB key', async () => {
  const { extractBlobs, collectBlobKeys } = await import('../js/state.js');
  const big = 'data:image/png;base64,' + 'B'.repeat(70 * 1024);
  const withMsg = { activeSessionId: 's1', sessions: [{ id: 's1', messages: [{ id: 'm1', role: 'user', attachments: [{ kind: 'image', name: 'a.png', dataUrl: big }] }], files: {} }], messages: [], files: {} };
  const noMsg = { activeSessionId: 's1', sessions: [{ id: 's1', messages: [], files: {} }], messages: [], files: {} };
  assert.equal(collectBlobKeys(extractBlobs(withMsg).light).length, 1);
  assert.equal(collectBlobKeys(extractBlobs(noMsg).light).length, 0, '消息删掉后 key 也应消失（blobPrune 据此清理）');
});

group('网关接入点：双域名自动择路（中国大陆网络兼容）');
test('默认接入 .com；探测后能切到 .cn 并记住；失败回退另一个域名', async () => {
  const ep = await import('../js/endpoint.js');
  assert.deepEqual(ep.GATEWAY_HOSTS, ['https://api.teamorouter.com', 'https://api.teamorouter.cn']);
  // 干净起点
  const savedLS = globalThis.localStorage;
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  try {
    ep.setGatewayBase('https://api.teamorouter.com', 'manual');
    assert.equal(ep.gatewayBase(), 'https://api.teamorouter.com');
    assert.equal(ep.otherGatewayBase(), 'https://api.teamorouter.cn');
    // 探测：只有 .cn 可达 → 应选 .cn
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('api.teamorouter.cn')) return new Response('{}', { status: 200 });
      throw new TypeError('Failed to fetch');
    };
    const r = await ep.probeGatewayHosts({ timeoutMs: 500 });
    assert.equal(r.host, 'https://api.teamorouter.cn', `应切到 .cn：${JSON.stringify(r)}`);
    assert.equal(ep.gatewayBase(), 'https://api.teamorouter.cn');
    assert.equal(store.get('teamo-gateway-endpoint'), 'https://api.teamorouter.cn', '选择要落盘记住');
    // 两个都不通：保持原样，不抛
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    const r2 = await ep.probeGatewayHosts({ timeoutMs: 300 });
    assert.equal(r2.by, 'none');
    assert.equal(ep.gatewayBase(), 'https://api.teamorouter.cn', '都不通时不该乱改');
    globalThis.fetch = realFetch;
  } finally {
    if (savedLS === undefined) delete globalThis.localStorage; else globalThis.localStorage = savedLS;
    ep.setGatewayBase('https://api.teamorouter.com', 'manual');
  }
});

test('网络层错误才换域名：HTTP 4xx/5xx 与主动停止都不换', async () => {
  const { isNetworkError } = await import('../js/endpoint.js');
  assert.equal(isNetworkError(new TypeError('Failed to fetch')), true);
  assert.equal(isNetworkError(new Error('Load failed')), true);
  assert.equal(isNetworkError(Object.assign(new Error('Aborted'), { name: 'AbortError' })), false, '用户停止不该换域名重试');
  assert.equal(isNetworkError(new Error('HTTP 401: invalid key')), false, '鉴权失败换域名没用');
  assert.equal(isNetworkError(null), false);
});

test('请求期切换：.com 网络失败 → 自动用 .cn 重放并记住', async () => {
  const api = await import('../js/api.js');
  const ep = await import('../js/endpoint.js');
  const realFetch = globalThis.fetch;
  const savedLS = globalThis.localStorage;
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  ep.setGatewayBase('https://api.teamorouter.com', 'manual');
  const tried = [];
  globalThis.fetch = async (url) => {
    tried.push(String(url));
    if (String(url).startsWith('https://api.teamorouter.com')) throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify({ data: [{ id: 'claude-haiku-4-5' }, { id: 'gpt-5.6-sol' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const list = await api.fetchModels('sk-teamo-test');
    assert.deepEqual(list, ['claude-haiku-4-5', 'gpt-5.6-sol'], `应拿到模型列表：${JSON.stringify(list)}`);
    assert.equal(tried.length, 2, `应该是「先 .com 失败、再 .cn 成功」两次：${tried.join(' , ')}`);
    assert.ok(tried[0].startsWith('https://api.teamorouter.com'));
    assert.ok(tried[1].startsWith('https://api.teamorouter.cn'));
    assert.equal(ep.gatewayBase(), 'https://api.teamorouter.cn', '切换后要记住');
    assert.equal(api.tookEndpointSwitch(), true, '要能被界面感知到（提示一次）');
  } finally {
    globalThis.fetch = realFetch;
    if (savedLS === undefined) delete globalThis.localStorage; else globalThis.localStorage = savedLS;
    ep.setGatewayBase('https://api.teamorouter.com', 'manual');
    api.tookEndpointSwitch();
  }
});

group('管理员密钥：源码里没有明文，口令拉伸后解封');
test('密封常量不含任何明文片段，且解封逻辑正确', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../js/adminkey.js', import.meta.url), 'utf8');
  // 源码里既不能有密钥明文，也不能有口令明文（注释里的示例也算）
  assert.equal(/sk-teamo-[a-z0-9]{8,}/.test(src), false, '源码里不能出现任何形如 sk-teamo-… 的密钥');
  // 真口令同样不能出现在这个测试文件里：用运行时拼出来的片段去查，避免自证式泄漏
  const needles = ['29' + '3846', 'admin-2' + '93', 'k9' + 'M2x7', 'admin-k' + '9M2'];
  assert.equal(needles.some((n) => src.includes(n)), false, '源码里不能出现口令明文');
  const self = (await import('node:fs')).readFileSync(new URL(import.meta.url), 'utf8');
  assert.equal(needles.some((n) => self.includes(n)), false, '测试文件里也不能出现口令明文');
  const { buildNothing } = { buildNothing: null };
  const ak = await import('../js/adminkey.js');
  assert.equal(ak.isAdminAlias('admin-anything'), true);
  assert.equal(ak.isAdminAlias('sk-teamo-xxx'), false);
  // 错口令：拒绝，且不会留下已解封状态
  const bad = await ak.unlockAdminKey('admin-wrong-password');
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'bad-password');
  assert.equal(ak.adminUnlocked(), false);
  // 未解封时别名原样透传（绝不会把半截密钥发出去）
  assert.equal(ak.effectiveApiKey('admin-<示例别名>'), 'admin-<示例别名>');
  assert.equal(ak.effectiveApiKey('sk-teamo-plain'), 'sk-teamo-plain');
  // 有环境变量时做一次真解封（口令不进仓库：CI/本地按需给）
  if (process.env.TEAMO_ADMIN_PW) {
    const ok = await ak.unlockAdminKey(process.env.TEAMO_ADMIN_PW);
    assert.equal(ok.ok, true, '正确口令必须能解封');
    const key = ak.effectiveApiKey(process.env.TEAMO_ADMIN_PW);
    assert.match(key, /^sk-teamo-[a-z0-9]{40,}$/, '解封出来的应是真密钥');
    assert.notEqual(key, process.env.TEAMO_ADMIN_PW, '别名必须被替换成真密钥');
    ak.lockAdminKey();
    assert.equal(ak.effectiveApiKey(process.env.TEAMO_ADMIN_PW), process.env.TEAMO_ADMIN_PW, '上锁后不再替换');
  }
});

test('管理员密钥不会被写进会话导出、也不进 localStorage 的明文位置', async () => {
  const ak = await import('../js/adminkey.js');
  const { createStore } = await import('../js/state.js');
  const store = createStore();
  store.state.apiKey = 'admin-<示例别名>';   // 存的只是别名（用户输入的原样字符串）
  const dump = JSON.stringify(store.state);
  assert.ok(dump.includes('admin-<示例别名>'), '别名本身是可以存的（它就是用户输入）');
  assert.equal(/sk-teamo-[a-z0-9]{40,}/.test(dump), false, '真密钥绝不能被持久化');
  assert.equal(ak.adminUnlocked(), false);
});

test('系统提示词不再自相矛盾：不能说「去找 web_search 工具」也不能说「模型不能联网」', async () => {
  const { systemPrompt } = await import('../js/config.js');
  const sys = systemPrompt();
  // 真踩过的坑：旧句子「不要去找一个叫 web_search 的工具」被模型理解成「本轮没有联网能力」，
  // 于是它在真开着服务器搜索时说自己没有联网工具、改去用 fetch_url。
  assert.equal(/不要去找一个叫\s*web_search/.test(sys), false);
  assert.match(sys, /原生网页搜索/);
  assert.equal(web.webCapFor('claude-sonnet-5'), null);
  assert.ok(sys.includes('analyze_image'));
});

test('没有本地中继时，只在本地可用的工具（fetch_url / run_git）不进请求', async () => {
  const calls = [];
  await withNetFetch(async (url) => { if (url.startsWith('/api/health')) return new Response('<html>404</html>', { status: 404, headers: { 'content-type': 'text/html' } });
    return jsonResponse({ choices: [{ message: { content: 'ok' } }] }); }, async () => {
    mockFetch([openaiTextTurn('中继不在也照样答')], calls);
    try {
      const store = storeNoWeb(createStore());
      store.state.apiKey = 'sk-teamo-test';
      store.state.model = 'gpt-5.6-sol';
      store.state.relayOk = false; // main.js 启动探测的结论
      const agent = createAgent(store, {});
      await agent.send('随便问一句');
      const names = (calls[0].body.tools || []).map((t) => t.function?.name || t.name);
      assert.equal(names.includes('fetch_url'), false, `没中继就不该提供 fetch_url：${names.join(',')}`);
      assert.equal(names.includes('run_git'), false);
      assert.ok(names.includes('write_file'), '其它工具照常提供');
      const sys = calls[0].body.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
      assert.match(sys, /没有本地中继/, '要告诉模型为什么少了两个工具');
    } finally { globalThis.fetch = realFetch; }
  });
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

test('injectWeb 在 webCapFor 恒为 null 时不改请求体', async () => {
  const raw = { model: 'claude-sonnet-5', messages: [], tools: [{ name: 'write_file' }] };
  assert.deepEqual(web.injectWeb({ ...raw }, web.webCapFor('claude-sonnet-5')), raw);
  assert.deepEqual(web.injectWeb({ model: 'gpt-5.6-sol', input: [] }, null).tools, undefined);
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

test('streamChat：不再走原生网页搜索端点', async () => {
  const calls = [];
  mockFetch([openaiTextTurn('纯文本答完'), anthropicTextTurn('claude 纯文本')], calls);
  try {
    const msgs = [{ role: 'system', text: 'S' }, { role: 'user', text: '今天几点' }];
    let got = '';
    await api.streamChat({ model: 'gpt-5.6-sol', apiKey: 'k', messages: msgs, webEnabled: true, onEvent: (ev) => { if (ev.type === 'text') got += ev.text; } });
    assert.equal(got, '纯文本答完');
    assert.ok(calls[0].url.endsWith('/v1/chat/completions'), calls[0].url);
    assert.ok(!JSON.stringify(calls[0].body).includes('web_search'));
    got = '';
    await api.streamChat({ model: 'claude-sonnet-5', apiKey: 'k', messages: msgs, webEnabled: true, onEvent: (ev) => { if (ev.type === 'text') got += ev.text; } });
    assert.ok(calls[1].url.endsWith('/v1/messages'), calls[1].url);
    assert.ok(!JSON.stringify(calls[1].body).includes('web_search_20250305'));
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
    store.state.settings.jevEnabled = false;
    const agent = createAgent(store, { onWebSearch: (m, w) => { seen = w; } });
    await agent.send('今天有什么新闻');
    assert.equal(seen.results, 1, 'UI 要收到「检索到 1 条来源」');
    const done = [...store.state.messages].reverse().find((m) => m.role === 'assistant');
    assert.equal(done.webSearch.sources[0].url, 'https://src.test/x', '来源随消息持久化');
    const sys = calls[0].body.system || calls[0].body.messages[0].content;
    assert.match(sys, /原生网页搜索已下线/);
    // 关掉联网后必须换成「别声称能联网」的说法
    store.state.settings.webEnabled = false;
    await agent.send('再来一轮');
    const sys2 = calls[1].body.system || calls[1].body.messages[0].content;
    assert.match(sys2, /未联网|原生网页搜索已下线/);
    assert.ok(!/web_search_20250305/.test(String(sys2)), '关联网时不要再宣称已开启服务端搜索');
    assert.ok(!('tools' in calls[1].body) || calls[1].body.tools.every((t) => t.name !== 'web_search'), '也不能带原生联网工具');
  } finally { globalThis.fetch = realFetch; api.__resetWebFallbackForTests(); await drainSaves(); }
});
group('工具层：抓取与 git 工具的对外契约');
test('TOOL_DEFS 注册齐全且参数必填项正确', async () => {
  const byName = Object.fromEntries(TOOL_DEFS.map((t) => [t.name, t]));
  for (const n of ['fetch_url', 'run_git', 'search_files', 'diff_text', 'json_tool', 'delete_file', 'copy_file']) assert.ok(byName[n], `缺少工具 ${n}`);
  assert.ok(!byName.web_search, '不能再有 web_search 工具');
  assert.ok(byName.analyze_image, '识图工具');
  assert.ok(byName.write_file.parameters.properties.mode);
  assert.deepEqual(byName.fetch_url.parameters.required, ['url']);
  assert.deepEqual(byName.fetch_url.parameters.properties.mode.enum, ['text', 'raw'], 'markdown 模式依赖第三方抽取器，必须移除');
  assert.ok(byName.run_git.parameters.required.includes('command'));
  assert.ok(/git /.test(byName.run_git.description), '描述里要写清 git 走本地中继');
  assert.ok(TOOL_DEFS.length >= 10, `工具总数：${TOOL_DEFS.length}`);
});
test('系统提示词提到了抓取与 git、并说明联网不是工具（漂移守卫）', async () => {
  const sp = cfg.systemPrompt();
  for (const kw of ['fetch_url', 'run_git', '联网']) assert.ok(sp.includes(kw), `提示词缺少 ${kw}`);
  assert.match(sp, /原生网页搜索/, '原生搜索已下线');
  assert.ok(!/不要去找一个叫\s*web_search/.test(sp), '旧句子会让模型以为自己没有联网能力（真踩过）');
  assert.match(sp, /无法核实|没查到/, '要有「查不到就明说」的自主性规则');
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

test('思考参数 400 降级时不得把联网字段一并剥掉', async () => {
  api.__resetThinkingFallbackForTests();
  api.__resetWebFallbackForTests();
  const calls = [];
  mockFetch([
    sseResponse(JSON.stringify({ error: { message: 'thinking is not supported for this model' } }), 400),
    sseResponse(
      sseEv({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      + sseEv({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '仍联网' } })
      + sseEv({ type: 'message_stop' }) + sseDone,
    ),
  ], calls);
  try {
    let got = '';
    await api.streamChat({
      model: 'claude-sonnet-5', apiKey: 'k', thinking: true, webEnabled: true,
      messages: [{ role: 'user', text: '今天新闻' }],
      onEvent: (ev) => { if (ev.type === 'text') got += ev.text; },
    });
    assert.equal(got, '仍联网');
    assert.equal(calls.length, 2);
    assert.ok(calls[0].body.thinking, '首次应带思考参数');
    assert.ok(!(calls[0].body.tools || []).some((t) => t.type === 'web_search_20250305'), '原生联网已下线');
    assert.equal(calls[1].body.thinking, undefined, '重试去掉思考');
    assert.ok(!(calls[1].body.tools || []).some((t) => t.type === 'web_search_20250305'));
  } finally {
    globalThis.fetch = realFetch;
    api.__resetThinkingFallbackForTests();
    api.__resetWebFallbackForTests();
  }
});

test('extractBlobs：未水合的 stripped 附件必须保留 IDB 索引（否则 prune 会清空图）', async () => {
  const { extractBlobs, collectBlobKeys } = await import('../js/state.js');
  const light = {
    activeSessionId: 's1',
    sessions: [{
      id: 's1',
      blobFiles: { 'outputs/a.png': 'f:s1:outputs/a.png' },
      files: {}, // 水合前大文件不在内存
      messages: [{
        id: 'm1', role: 'user',
        attachments: [{ kind: 'image', name: 'a.png', stripped: true }],
        blobAtts: { 0: 'a:s1:m1:0' },
      }, {
        id: 'm2', role: 'assistant',
        toolCalls: [{ id: 'c1', name: 'generate_image', args: {}, imageStripped: true }],
        blobChips: { c1: 'c:s1:c1' },
      }],
    }],
    messages: [], files: {},
  };
  const ex = extractBlobs(light); // ready 默认 false = 水合前
  assert.equal(ex.light.sessions[0].messages[0].blobAtts[0], 'a:s1:m1:0', '附件索引不能丢');
  assert.equal(ex.light.sessions[0].messages[1].blobChips.c1, 'c:s1:c1', '芯片索引不能丢');
  assert.equal(ex.light.sessions[0].blobFiles['outputs/a.png'], 'f:s1:outputs/a.png', '沙箱索引不能丢');
  assert.equal(ex.blobs.length, 0, '内存里没有大对象，不应再写一份');
  const keep = collectBlobKeys(ex.light);
  assert.equal(keep.length, 3, `prune 白名单应保住 3 个 key，实际 ${JSON.stringify(keep)}`);
  assert.deepEqual(keep.sort(), ['a:s1:m1:0', 'c:s1:c1', 'f:s1:outputs/a.png']);
  // 水合完成后删掉文件：索引应被清掉
  const hydrated = {
    activeSessionId: 's1',
    sessions: [{ id: 's1', blobFiles: { 'outputs/a.png': 'f:s1:outputs/a.png' }, files: {}, messages: [] }],
    messages: [], files: {},
  };
  const gone = extractBlobs(hydrated, { ready: true });
  assert.equal(gone.light.sessions[0].blobFiles, undefined, '水合后内存里没这文件 = 用户删了');
  assert.equal(collectBlobKeys(gone.light).length, 0);
});

test('runSubagent 源码不得引用未定义的 store（子智能体跑 fetch_url 会 ReferenceError）', async () => {
  const fsp = await import('node:fs');
  const src = fsp.readFileSync(new URL('../js/agent.js', import.meta.url), 'utf8');
  const fn = /export async function runSubagent[\s\S]*?^export function createAgent/m.exec(src)
    || /export async function runSubagent[\s\S]*?^export function createAgent/.exec(src)
    || [];
  const body = src.slice(src.indexOf('export async function runSubagent'), src.indexOf('export function createAgent'));
  assert.equal(/\bstore\.state\b/.test(body), false, 'runSubagent 作用域里没有 store');
});

group('Jev（TypeSafe System One）');
test('isJevModel：只认决策模型，不误伤对话模型', async () => {
  const jev = await import('../js/jev.js');
  assert.equal(jev.isJevModel('jev'), true);
  assert.equal(jev.isJevModel('jev-latest'), true);
  assert.equal(jev.isJevModel('typesafe-ai/jev'), true);
  assert.equal(jev.isJevModel('claude-sonnet-5'), false);
  assert.equal(jev.isJevModel('gpt-5.6-sol'), false);
  assert.equal(jev.isJevModel(''), false);
});
test('buildSystemOneBody：严格按文档，不含聊天协议字段', async () => {
  const jev = await import('../js/jev.js');
  const body = jev.buildSystemOneBody({
    state: 'I was charged twice.',
    questions: { department: jev.choice('Which team?', { billing: 'charges', other: 'else' }) },
  });
  assert.equal(body.model, 'jev');
  assert.equal(body.state, 'I was charged twice.');
  assert.equal(body.questions.department.type, 'choice');
  assert.equal('messages' in body, false);
  assert.equal('stream' in body, false);
  assert.equal('temperature' in body, false);
  assert.equal('max_tokens' in body, false);
  assert.equal(jev.JEV_PATH, '/v1/systemone');
});
test('noul/choice/score 解析与 plan 提示词', async () => {
  const jev = await import('../js/jev.js');
  const answers = {
    need_search: { type: 'noul', noul: 0.98 },
    need_code: { type: 'noul', noul: 0.05 },
    need_image: { type: 'noul', noul: 0.01 },
    need_dispatch: { type: 'noul', noul: 0.12 },
    route: { type: 'choice', choice: 'search', confidence: 0.96, probabilities: { search: 0.97, chat: 0.02 } },
    difficulty: { type: 'score', score: 3.2, confidence: 0.8 },
  };
  assert.equal(jev.noulOf(answers, 'need_search'), 0.98);
  assert.equal(jev.choiceOf(answers, 'route'), 'search');
  assert.equal(jev.scoreOf(answers, 'difficulty'), 3.2);
  const note = jev.formatPlanNote(answers, { webEnabled: true, sandboxEnabled: true });
  assert.match(note, /【Jev 决策】/);
  assert.match(note, /服务端网页搜索/);
  assert.match(note, /不要说「已联网」/);
  const summary = jev.summarizePlan(answers);
  assert.match(summary, /search/);
  assert.match(summary, /检索/);
});
test('askJev：POST /v1/systemone + Bearer，读 answers.choice / noul', async () => {
  const jev = await import('../js/jev.js');
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), headers: opts.headers, body: JSON.parse(opts.body) });
    return new Response(JSON.stringify({
      model: 'typesafe-ai/jev',
      answers: {
        need_search: { type: 'noul', noul: 0.98 },
        route: { type: 'choice', choice: 'search', confidence: 0.96 },
      },
      usage: { input_tokens: 40, output_tokens: 8 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const r = await jev.askJev({
      apiKey: 'sk-teamo-test',
      state: '今天美元兑人民币中间价是多少？',
      questions: jev.TURN_QUESTIONS,
    });
    assert.equal(r.ok, true);
    assert.equal(r.answers.route.choice, 'search');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/v1\/systemone$/);
    assert.equal(calls[0].headers.Authorization, 'Bearer sk-teamo-test');
    assert.equal(calls[0].body.model, 'jev');
    assert.equal('stream' in calls[0].body, false);
    assert.equal(calls[0].body.questions.need_search.type, 'noul');
    assert.equal(calls[0].body.questions.route.type, 'choice');
    assert.equal(calls[0].body.questions.difficulty.type, 'score');
  } finally { globalThis.fetch = realFetch; }
});
test('askJev：非 JSON 响应 fail-open，不把 SSE 当决策', async () => {
  const jev = await import('../js/jev.js');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('data: {"choices":[]}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  try {
    const r = await jev.askJev({ apiKey: 'k', state: 'hi', questions: jev.TURN_QUESTIONS });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not-json');
  } finally { globalThis.fetch = realFetch; }
});
test('Agent：Jev 结论写入系统提示；失败时对话照常', async () => {
  const calls = [];
  mockFetch([
    new Response(JSON.stringify({
      model: 'jev',
      answers: {
        need_search: { type: 'noul', noul: 0.1 },
        need_code: { type: 'noul', noul: 0.05 },
        need_image: { type: 'noul', noul: 0.02 },
        need_dispatch: { type: 'noul', noul: 0.08 },
        route: { type: 'choice', choice: 'chat', confidence: 0.9 },
        difficulty: { type: 'score', score: 1 },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
    openaiTextTurn('直接答'),
  ], calls);
  try {
    const store = createStore();
    store.state.apiKey = 'sk-teamo-test';
    store.state.model = 'gpt-5.6-sol';
    store.state.settings.webEnabled = false;
    store.state.settings.jevEnabled = true;
    const agent = createAgent(store, {});
    await agent.send('你好');
    assert.equal(store.state.messages.find((m) => m.role === 'user').jev.route, 'chat');
    assert.ok(calls[0].url.includes('/v1/systemone'), `第一枪应是 Jev：${calls[0].url}`);
    const sys = (calls[1].body.messages || []).filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    assert.match(sys, /【Jev 决策】/);
    assert.match(sys, /可以直接回答/);
    assert.equal(store.state.messages[store.state.messages.length - 1].text, '直接答');
  } finally { globalThis.fetch = realFetch; }
});
test('Agent：Jev 挂了不能挡住聊天（fail-open）', async () => {
  const calls = [];
  mockFetch([
    new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 500, headers: { 'content-type': 'application/json' } }),
    openaiTextTurn('照样答'),
  ], calls);
  try {
    const store = createStore();
    store.state.apiKey = 'sk-teamo-test';
    store.state.model = 'gpt-5.6-sol';
    store.state.settings.webEnabled = false;
    store.state.settings.jevEnabled = true;
    const agent = createAgent(store, {});
    await agent.send('还在吗');
    assert.equal(agent.getStatus(), 'done');
    assert.equal(store.state.messages[store.state.messages.length - 1].text, '照样答');
    assert.equal(store.state.messages.find((m) => m.role === 'user').jev, undefined, '失败时不要写假计划');
  } finally { globalThis.fetch = realFetch; }
});
test('paintAssistant：光标必须叠上忙碌状态（导入后去不掉的根因）', async () => {
  const fsp = await import('node:fs');
  const src = fsp.readFileSync(new URL('../js/ui.js', import.meta.url), 'utf8');
  const paint = src.slice(src.indexOf('function paintAssistant'), src.indexOf('function webNote'));
  assert.match(paint, /const live = !m\.done && getBusy\(\)/, '历史消息缺 done 时不能只靠 !m.done 画光标');
  assert.match(paint, /live && !noOutputYet.*cursor/, '光标只在 live 时出现');
  assert.equal(paint.includes("if (!m.done && !noOutputYet) html += '<span class=\"cursor\""), false, '旧条件会让导入会话的每条回复一直闪光标');
});

group('Hermes 式 harness（提示词分层 / 技能 / 记忆 / 并行工具）');
test('assembleSystemLayers：stable→context→volatile 在 cached，ephemeral 单独一条', async () => {
  const { assembleSystemLayers, formatRuntime, formatBudgetNote } = await import('../js/prompt.js');
  const layers = assembleSystemLayers({
    identity: 'IDENTITY',
    skillsIndex: 'SKILLS',
    contextFiles: 'CONTEXT',
    memory: 'MEMORY',
    runtime: formatRuntime({ now: new Date('2026-09-23T00:00:00Z'), model: 'claude-sonnet-5' }),
    ephemeral: 'JEV-NOTE',
  });
  assert.equal(layers.messages.length, 2);
  assert.equal(layers.messages[0].cache, true);
  assert.match(layers.cached, /IDENTITY[\s\S]*SKILLS[\s\S]*CONTEXT[\s\S]*MEMORY/);
  assert.ok(layers.cached.indexOf('IDENTITY') < layers.cached.indexOf('MEMORY'), '记忆在 volatile，排在身份之后');
  assert.equal(layers.messages[1].text, 'JEV-NOTE');
  assert.ok(!layers.cached.includes('JEV-NOTE'), 'Jev 不得污染 cached 前缀');
  assert.match(layers.cached, /2026-09-23T00:00:00.000Z/);
  assert.equal(formatBudgetNote(1, 8), '');
  assert.match(formatBudgetNote(7, 8), /最后一次/);
});
test('skills：目录进稳定层；匹配才加载正文；蒸馏有门槛', async () => {
  const sk = await import('../js/skills.js');
  const idx = sk.formatSkillsIndex();
  assert.match(idx, /<available_skills>/);
  assert.match(idx, /web-research/);
  assert.equal(sk.BUNDLED_SKILLS.length, 5);
  const searchBody = sk.selectSkillBodies({ route: 'search', needSearch: 0.9 }, '今天汇率');
  assert.match(searchBody, /Skill: web-research/);
  assert.ok(!/Skill: image-generation/.test(searchBody), '不应把无关技能正文全塞进去');
  assert.equal(sk.distillSkill({ userText: 'hi', toolNames: ['read_file'], iterations: 1 }), null);
  const learned = sk.distillSkill({ userText: '把仓库 clone 下来再跑测试', toolNames: ['run_git', 'execute_python', 'read_file'], iterations: 3 });
  assert.ok(learned && learned.id.startsWith('learned-'));
  const list = sk.rememberSkill([], learned);
  assert.equal(list[0].id, learned.id);
});
test('memory：压缩摘要蒸馏为跨会话事实，去重封顶', async () => {
  const mem = await import('../js/memory.js');
  const facts = mem.upsertFacts([], mem.factsFromDigest('用户偏好 Python 3.12 · 正在做 atlas 项目 · 短'));
  assert.ok(facts.some((f) => /Python 3.12/.test(f.text)));
  assert.ok(!facts.some((f) => f.text === '短'), '太短的不配进 MEMORY');
  const block = mem.formatMemory(facts);
  assert.match(block, /Persistent Memory/);
  const dup = mem.upsertFacts(facts, facts);
  assert.equal(dup.length, facts.length, '相同事实去重');
});
test('compactMessages：丢轮时带回 droppedDigest；preflight 在 50% 收紧历史工具结果', () => {
  const msgs = buildRounds(30);
  const tight = compactMessages(msgs, 3000);
  assert.ok(tight.droppedCount > 0);
  assert.ok(typeof tight.droppedDigest === 'string' && tight.droppedDigest.includes('问题'), `digest=${tight.droppedDigest}`);
  const tool = '结果行\n'.repeat(2000);
  const one = [
    { role: 'user', text: '旧问' },
    { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'execute_python', args: {} }] },
    { role: 'tool', toolCallId: 'c1', content: tool },
    { role: 'user', text: '新问' },
  ];
  const budget = estimateTokens(one) + 10; // 刚好够，未过 100%
  const raw = compactMessages(one, budget);
  assert.equal(raw.messages[2].content.length, tool.length, '无 preflight 时预算内零截断');
  const pf = compactMessages(one, Math.floor(estimateTokens(one) * 0.9), { preflight: true });
  assert.ok(pf.messages[2].content.length < tool.length, 'preflight 超过 50% 应收紧历史工具结果');
  assert.equal(pf.messages[3].text, '新问', '本轮用户消息必须保留');
});
test('batchToolCalls：只读工具打成 parallel，写入仍 serial，委派单独成批', async () => {
  const { batchToolCalls } = await import('../js/agent.js');
  const b = batchToolCalls([
    { name: 'read_file', args: { path: 'a' } },
    { name: 'list_files', args: {} },
    { name: 'write_file', args: { path: 'b', content: 'x' } },
    { name: 'dispatch_subagent', args: { agent: 'explainer', task: 't' } },
    { name: 'dispatch_subagent', args: { agent: 'explainer', task: 'u' } },
  ]);
  assert.deepEqual(b.map((x) => [x.kind, x.start, x.end]), [
    ['parallel', 0, 2],
    ['serial', 2, 3],
    ['dispatch', 3, 5],
  ]);
});
test('Agent：系统提示拆成 cached + ephemeral，Jev 只出现在后者', async () => {
  const calls = [];
  mockFetch([openaiTextTurn('拆层成功')], calls);
  try {
    const store = storeNoWeb(createStore());
    store.state.apiKey = 'sk-teamo-test';
    store.state.model = 'gpt-5.6-sol';
    const agent = createAgent(store, {});
    await agent.send('随便聊聊');
    const sys = (calls[0].body.messages || []).filter((m) => m.role === 'system');
    assert.ok(sys.length >= 1);
    assert.match(sys[0].content, /TeamoAgent/);
    assert.match(sys[0].content, /available_skills/);
    assert.match(sys[0].content, /子智能体委派（dispatch_subagent）/);
    assert.match(sys[0].content, /不是 Max\/Ultra/);
    assert.equal((calls[0].body.tools || []).some((t) => (t.function && t.function.name) === 'dispatch_subagent'), false, '默认 Medium 不得委派');
    assert.equal(calls[0].body.max_tokens, 1024, '闲聊输出上限约 1k');
    const joined = sys.map((m) => m.content).join('\n');
    assert.match(joined, /本轮未联网/);
  } finally { globalThis.fetch = realFetch; }
});

group('沙箱占用展示 {已用}/{上限}');
test('fmtMB / filesCountLabel：一位小数 MB，空沙箱仍显示 0.0MB/120.0MB', async () => {
  const s = await import('../js/storagefmt.js');
  assert.equal(s.SANDBOX_STORAGE_CAP, 120 * 1024 * 1024);
  assert.equal(s.fmtMB(0), '0.0MB');
  assert.equal(s.fmtMB(2.7 * 1048576), '2.7MB');
  assert.equal(s.sandboxQuotaLabel(2.7 * 1048576), '2.7MB/120.0MB');
  assert.equal(s.filesCountLabel({ files: 0, dirs: 0, size: 0 }), '0.0MB/120.0MB');
  assert.equal(s.filesCountLabel({ files: 3, dirs: 3, size: 2.7 * 1048576 }), '3 个文件 · 3 个目录 · 2.7MB/120.0MB');
  const q = await s.resolveStorageQuota(s.SANDBOX_STORAGE_CAP);
  assert.ok(q > 0);
});
test('index.html 附件 accept 含 PDF 与 ZIP；提示词说明转图片再识别', async () => {
  const fsp = await import('node:fs');
  const html = fsp.readFileSync(new URL('../app.html', import.meta.url), 'utf8');
  assert.ok(html.includes('application/pdf') && html.includes('.pdf'), 'attach-input accept 应含 PDF');
  assert.ok(html.includes('application/zip') && html.includes('.zip'), 'accept 应含 ZIP');
  const sys = cfg.systemPrompt();
  assert.match(sys, /analyze_image/);
  assert.match(sys, /逐页渲染成 JPEG|转成图片|页图/);
  assert.match(sys, /zip_files/);
  assert.equal(/\.pdf\.txt/.test(sys), false);
});
test('移动端消息头模型名与用量同一行；侧栏 Logo 不省略 TEAMOAGENT', async () => {
  const fsp = await import('node:fs');
  const css = fsp.readFileSync(new URL('../css/styles.css', import.meta.url), 'utf8');
  const html = fsp.readFileSync(new URL('../app.html', import.meta.url), 'utf8');
  assert.match(html, /class="logo-text"[^>]*>TEAMO<i>AGENT<\/i>/);
  const logo = css.slice(css.indexOf('.logo-text {'), css.indexOf('.logo-text i'));
  assert.equal(/text-overflow:\s*ellipsis/.test(logo), false, '品牌名不得裁成省略号');
  assert.match(css, /\.logo-text \{[^}]*flex-shrink:\s*0/);
  assert.equal(/\.msg-meta \{ width: 100%; order: 9/.test(css), false, '用量不得再被挤到下一行');
  assert.match(css, /\.msg-head \{ flex-wrap: nowrap/);
  assert.match(css, /\.msg-meta \{ flex: 0 0 auto; white-space: nowrap/);
  assert.equal(/\.msg-model \{[^}]*flex:\s*1 1 auto/.test(css), false, '模型名不得撑满把 tok 顶到右侧');
});
test('工具调用与深度思考无边框；思考有线性 SVG', async () => {
  const fsp = await import('node:fs');
  const css = fsp.readFileSync(new URL('../css/styles.css', import.meta.url), 'utf8');
  const ui = fsp.readFileSync(new URL('../js/ui.js', import.meta.url), 'utf8');
  const { ICON } = await import('../js/icons.js');
  const chip = css.slice(css.indexOf('.chip {'), css.indexOf('.chip:hover'));
  assert.match(chip, /border:\s*none/, '工具芯片不要边框');
  const reason = css.slice(css.indexOf('.reasoning {'), css.indexOf('.reasoning summary {'));
  assert.match(reason, /border:\s*none/, '思考块不要虚线框');
  assert.ok(ICON.thinking.includes('stroke="currentColor"'));
  assert.match(ui, /ICON\.thinking/, '深度思考提示要带思考图标');
  assert.match(ui, /class="think-ico"/);
});
test('侧栏收起把手在顶栏文档流里，不 fixed 遮挡本轮/思考', async () => {
  const fsp = await import('node:fs');
  const html = fsp.readFileSync(new URL('../app.html', import.meta.url), 'utf8');
  const css = fsp.readFileSync(new URL('../css/styles.css', import.meta.url), 'utf8');
  const top = html.slice(html.indexOf('class="topbar"'), html.indexOf('class="messages"'));
  assert.match(top, /id="sidebar-fab"/, '汉堡必须在顶栏内，和本轮/思考并排而不是盖上去');
  assert.equal(html.indexOf('id="sidebar-fab"') < html.indexOf('id="overlay-backdrop"'), true);
  assert.match(html, /class="topbar"[\s\S]*id="sidebar-fab"[\s\S]*id="time-stats"/);
  const fabBlock = css.slice(css.indexOf('#sidebar-fab {'), css.indexOf('#sidebar-fab:hover'));
  assert.equal(/position:\s*fixed/.test(fabBlock), false, '把手不能 position:fixed');
  assert.match(css, /\.app:has\(\.sidebar\.collapsed\) #sidebar-fab/);
  assert.equal(css.includes('.app:has(.sidebar.collapsed) ~ #sidebar-fab'), false);
});
test('窄屏沙箱面板自底部全屏滑入，面板内关闭键可收回', async () => {
  const fsp = await import('node:fs');
  const ui = fsp.readFileSync(new URL('../js/ui.js', import.meta.url), 'utf8');
  const html = fsp.readFileSync(new URL('../app.html', import.meta.url), 'utf8');
  const css = fsp.readFileSync(new URL('../css/styles.css', import.meta.url), 'utf8');
  assert.match(ui, /#panel-close/, '面板内要有关闭键');
  assert.match(html, /id="panel-close"/);
  assert.match(css, /#sandbox-panel\.collapsed \{ transform: translateY\(105%\)/, '窄屏面板垂直滑入/滑出，不是侧滑半宽');
  assert.match(css, /#sandbox-panel \{[\s\S]*?width:\s*100%/, '窄屏面板铺满屏宽');
  assert.match(css, /height:\s*100dvh/, '窄屏面板铺满视口高度');
  assert.match(css, /z-index:\s*52/, '全屏面板盖住顶栏，关闭靠面板内 ✕');
});
test('模型列表不再标「原生」；底部提示为 AI 生成免责声明', async () => {
  const fsp = await import('node:fs');
  const ui = fsp.readFileSync(new URL('../js/ui.js', import.meta.url), 'utf8');
  assert.equal(/badge ghost">原生/.test(ui), false, 'Claude 行不应再挂「原生」标签');
  assert.match(ui, /badge hot">热门/);
  assert.match(ui, /badge cheap">低价/);
  const html = fsp.readFileSync(new URL('../app.html', import.meta.url), 'utf8');
  assert.match(html, /内容由AI生成，请仔细甄别/);
  assert.equal(html.includes('网关提供路由'), false);
  assert.equal(html.includes('Claude 走'), false);
  const sonnet = cfg.FALLBACK_MODELS.find((m) => m.id === 'claude-sonnet-5');
  assert.equal(sonnet.hot, true, '默认对话模型应标热门');
  const haiku = cfg.FALLBACK_MODELS.find((m) => m.id === 'claude-haiku-4-5');
  assert.equal(haiku.cheap, true, 'haiku 应标低价');
  const css = fsp.readFileSync(new URL('../css/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.badge\.hot/);
  assert.match(css, /\.badge\.cheap/);
});

group('PDF 正文提取（客户端，无 pdf.js）');
const makePdf = (contentStream) => {
  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
    `4 0 obj << /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream\nendobj`,
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
  ];
  return new TextEncoder().encode('%PDF-1.1\n' + objects.join('\n') + '\n%%EOF\n');
};
test('未压缩内容流：Tj 抽出正文', async () => {
  const pdf = await import('../js/pdf.js');
  assert.equal(pdf.isPdfBytes(new Uint8Array([1, 2, 3])), false);
  const bytes = makePdf('BT /F1 12 Tf 10 100 Td (Hello PDF) Tj ET');
  assert.equal(pdf.isPdfBytes(bytes), true);
  const got = await pdf.extractPdfText(bytes);
  assert.equal(got.ok, true, got.error);
  assert.match(got.text, /Hello PDF/);
  assert.equal(pdf.pdfTextName('报告.PDF'), '报告.PDF.txt');
  assert.match(pdf.formatExtractedPdf('a.pdf', got), /Hello PDF/);
});
test('FlateDecode 流也能解出文字', async () => {
  const zlib = await import('node:zlib');
  const pdf = await import('../js/pdf.js');
  const inner = Buffer.from('BT /F1 12 Tf 72 720 Td (Flate Hello) Tj ET', 'latin1');
  const deflated = zlib.deflateSync(inner);
  const payload = Buffer.from(deflated).toString('latin1');
  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >> endobj',
    `4 0 obj << /Length ${deflated.length} /Filter /FlateDecode >>\nstream\n${payload}\nendstream\nendobj`,
  ];
  const bytes = Buffer.from('%PDF-1.1\n' + objects.join('\n') + '\n%%EOF\n', 'latin1');
  const got = await pdf.extractPdfText(bytes);
  assert.equal(got.ok, true, got.error);
  assert.match(got.text, /Flate Hello/);
});
test('提取结果作为文本附件落入 uploads/*.pdf.txt', async () => {
  const pdf = await import('../js/pdf.js');
  const fs = createFS();
  const got = await pdf.extractPdfText(makePdf('BT (Meeting Notes) Tj ET'));
  const name = pdf.pdfTextName('notes.pdf');
  const text = pdf.formatExtractedPdf('notes.pdf', got);
  const written = copyAttachmentsToFS(fs, [{ kind: 'text', name, text }]);
  assert.deepEqual(written, ['uploads/notes.pdf.txt']);
  assert.match(fs.read('uploads/notes.pdf.txt'), /Meeting Notes/);
});
test('非 PDF 字节给出可读失败，不抛', async () => {
  const pdf = await import('../js/pdf.js');
  const got = await pdf.extractPdfText(new TextEncoder().encode('not a pdf'));
  assert.equal(got.ok, false);
  assert.match(got.error, /不是 PDF/);
  assert.match(pdf.formatExtractedPdf('x.pdf', got), /提取失败/);
});


group('2026.09.22.15 布局与高亮');
test('侧栏与沙箱面板共用 860 断点，避免中间宽度错位', async () => {
  const fsp = await import('node:fs');
  const css = fsp.readFileSync(new URL('../css/styles.css', import.meta.url), 'utf8');
  const ui = fsp.readFileSync(new URL('../js/ui.js', import.meta.url), 'utf8');
  assert.equal((css.match(/@media \(max-width: 860px\)/g) || []).length >= 2, true);
  assert.equal(/@media \(max-width: 760px\)/.test(css), false, '面板不再单独用 760');
  assert.match(ui, /max-width: 860px/);
});
test('代码块语言在左侧、复制始终可见；用户气泡反色链接', async () => {
  const fsp = await import('node:fs');
  const hl = fsp.readFileSync(new URL('../assets/hljs/teamo.css', import.meta.url), 'utf8');
  const html = fsp.readFileSync(new URL('../app.html', import.meta.url), 'utf8');
  const ui = fsp.readFileSync(new URL('../js/ui.js', import.meta.url), 'utf8');
  assert.match(hl, /\.code-head/);
  assert.match(hl, /\.copy-code \{[\s\S]*opacity:\s*1/);
  assert.match(hl, /\.msg-user \.bubble\.md-body a \{ color: var\(--bg\)/);
  assert.match(html, /assets\/hljs\/highlight\.min\.js/);
  assert.match(ui, /bubble md-body/);
  assert.match(ui, /Edited file\(s\)/);
});
test('execute_python schema 含 packages', async () => {
  const py = TOOL_DEFS.find((t) => t.name === 'execute_python');
  assert.ok(py.parameters.properties.packages);
});


group('2026.09.22.16 语义 / 键盘 / 容量');
test('命令面板过滤与 token 构成', async () => {
  const cmd = await import('../js/commands.js');
  const items = [
    { group: '模型', label: 'claude-sonnet-5', hint: 'Anthropic' },
    { group: '文件', label: 'uploads/a.png' },
    { group: '子智能体', label: '代码审查员 · code-reviewer', id: 'code-reviewer' },
  ];
  assert.equal(cmd.filterCmds('', items).length, 3);
  assert.equal(cmd.filterCmds('claude', items).map((x) => x.label).join(), 'claude-sonnet-5');
  assert.equal(cmd.filterCmds('审查', items)[0].id, 'code-reviewer');
  const { estimateTokens } = await import('../js/context.js');
  const b = cmd.tokenBreakdown([
    { role: 'user', text: '你好' },
    { role: 'assistant', text: '先写文件', toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'a.txt' } }] },
    { role: 'tool', toolCallId: 'c1', content: '已写入 ' + 'x'.repeat(40) },
    { role: 'user', text: '下一问' },
    { role: 'assistant', text: '好' },
  ], estimateTokens, 80);
  assert.ok(b.system === 80 && b.history > 0 && b.tools > 0 && b.current > 0);
  assert.match(cmd.formatTokBreak(b), /系统/);
  assert.equal(cmd.shortSuggest('短'), '短');
  assert.ok(cmd.shortSuggest('用沙箱计算：前 100 个斐波那契数中有多少个质数？').endsWith('…'));
});
test('工具成功绿色✓、失败红色✗；入参/出参不展开；清空是危险色；占用条上限 120MB', async () => {
  const fsp = await import('node:fs');
  const ui = fsp.readFileSync(new URL('../js/ui.js', import.meta.url), 'utf8');
  const html = fsp.readFileSync(new URL('../app.html', import.meta.url), 'utf8');
  const css = fsp.readFileSync(new URL('../css/styles.css', import.meta.url), 'utf8');
  assert.match(ui, /chip-ok/);
  assert.match(ui, /chip-fail/);
  assert.match(ui, /✗/);
  assert.match(css, /\.chip-ok/);
  assert.match(ui, /closest\('\.chip-copy'\)/);
  assert.equal(ui.includes("state.textContent = patch.note || '✕'"), false);
  assert.match(html, /id="clear-sessions"[^>]*class="mini-btn danger"/);
  assert.match(html, /id="clear-files"[^>]*class="files-icon-btn danger"/);
  assert.match(css, /\.act\.act-danger/);
  assert.match(css, /\.dot\.busy\.thinking/);
  assert.match(ui, /再次确认/);
  assert.match(html, /id="files-count"/);
  assert.match(html, /id="files-n"/);
  assert.match(html, /files-card/);
  assert.match(html, /panel-tab-label/);
  assert.match(ui, /暂无文件/);
  assert.match(css, /\.files-card/);
  assert.match(ui, /产品上限 120MB/);
  assert.equal(/resolveStorageQuota\(SANDBOX_STORAGE_CAP\)\.then/.test(ui), false);
  assert.match(html, /id="cmd-palette"/);
  assert.match(ui, /metaKey \|\| e\.ctrlKey/);
  assert.match(ui, /e\.key === 'b'/);
  assert.match(ui, /chip-copy/);
  assert.match(html, /id="cap-line"/);
  assert.match(ui, /可粘贴或拖入附件/);
  assert.equal(ui.includes('slice(0, 3000)'), false, '工具出参芯片应展示全文，不要截成 3000 字');
  assert.match(ui, /m.cancelled/);
  assert.match(css, /.msg.cancelled .chip .chip-ico/);
});
test('清空会话要二次 confirm', async () => {
  const fsp = await import('node:fs');
  const ui = fsp.readFileSync(new URL('../js/ui.js', import.meta.url), 'utf8');
  const n = (ui.match(/confirm\(/g) || []).length;
  assert.ok(n >= 4, `confirm 次数 ${n}`);
});


group('2026.09.22.17 用户气泡 Markdown 反色');
test('用户气泡表格不用 --bg-soft（避免白底白字），代码块相对气泡叠色', async () => {
  const fsp = await import('node:fs');
  const hl = fsp.readFileSync(new URL('../assets/hljs/teamo.css', import.meta.url), 'utf8');
  assert.match(hl, /\.msg-user \.bubble\.md-body tbody tr:nth-child\(even\)/);
  assert.equal(/\.msg-user[\s\S]{0,400}nth-child\(even\)[\s\S]{0,80}var\(--bg-soft\)/.test(hl), false, '斑马纹不能再用页面底色');
  assert.match(hl, /color-mix\(in srgb, var\(--bg\)/);
  assert.match(hl, /\[data-theme="light"\] \.msg-user \.bubble\.md-body \.hljs-keyword/);
  assert.match(hl, /\[data-theme="dark"\] \.msg-user \.bubble\.md-body \.hljs-keyword/);
  assert.match(hl, /#c4b5fd/, '浅色主题黑气泡用亮色 token');
  assert.match(hl, /#6d28d9/, '深色主题浅气泡用深色 token');
  assert.match(hl, /\.msg-user \.bubble\.md-body \.code-block \{\s*background:\s*transparent/);
  assert.match(hl, /\.msg-user \.bubble\.md-body pre code/);
  assert.match(hl, /:not\(pre\) > code/);
});


group('ZIP 解压与压缩工具');
test('createZip → unpackZip 往返文本与防 zip-slip', async () => {
  const zip = await import('../js/zip.js');
  const un = await import('../js/unzip.js');
  const hello = new TextEncoder().encode('hello zip');
  const blob = zip.createZip([{ name: 'dir/a.txt', bytes: hello }]);
  const buf = new Uint8Array(await blob.arrayBuffer());
  assert.equal(un.isZipBytes(buf), true);
  const got = await un.unpackZip(buf);
  assert.equal(got.ok, true, got.error);
  assert.equal(got.files.length, 1);
  assert.equal(got.files[0].path, 'dir/a.txt');
  assert.equal(got.files[0].kind, 'text');
  assert.equal(got.files[0].content, 'hello zip');
  const evil = zip.createZip([{ name: '../etc/passwd', bytes: hello }]);
  const evilBuf = new Uint8Array(await evil.arrayBuffer());
  const bad = await un.unpackZip(evilBuf);
  assert.ok(!bad.files.some((f) => f.path.includes('..') || f.path.startsWith('/')), JSON.stringify(bad.files));
  const src = (await import('node:fs')).readFileSync(new URL('../js/unzip.js', import.meta.url), 'utf8');
  assert.match(src, /maxFiles = 128/);
});
test('zip_files / unzip_file 工具读写沙箱', async () => {
  const fs = createFS();
  fs.write('notes.md', '# hi');
  const packed = await executeTool('zip_files', { paths: ['notes.md'], out: 'archives/n.zip' }, { fs, onUi: () => {} });
  assert.match(packed, /archives\/n\.zip/);
  assert.ok(fs.read('archives/n.zip').startsWith('data:application/zip;base64,'));
  const out = await executeTool('unzip_file', { path: 'archives/n.zip', dest: 'out' }, { fs, onUi: () => {} });
  assert.match(out, /out\//);
  assert.equal(fs.read('out/notes.md'), '# hi');
});
test('pdfToImages 在无 Canvas 环境给出可读失败', async () => {
  const { pdfToImages } = await import('../js/pdfpages.js');
  const got = await pdfToImages(new Uint8Array([1, 2, 3]));
  assert.equal(got.ok, false);
  assert.match(got.error, /不是 PDF|Canvas|渲染/);
  const src = (await import('node:fs')).readFileSync(new URL('../js/pdfpages.js', import.meta.url), 'utf8');
  assert.ok(src.includes('BASE_SCALE = 2.4'), '页图栅格精度应明显高于 1.35');
  assert.ok(src.includes('JPEG_QUALITY = 0.92'));
  assert.ok(src.includes("intent: 'print'"));
});

group('本地代码小工具（regex / hash / codec / unicode）');
test('工具已注册，关闭沙箱仍可用，提示词点名', () => {
  const names = TOOL_DEFS.map((t) => t.name);
  for (const n of ['regex', 'hash', 'codec', 'unicode']) {
    assert.ok(names.includes(n), `应注册 ${n}`);
    const d = TOOL_DEFS.find((t) => t.name === n);
    assert.ok(d.parameters && d.parameters.properties, `${n} 要有参数表`);
  }
  assert.ok(!cfg.systemPrompt().includes('execute_javascript：') || /regex \/ hash \/ codec \/ unicode/.test(cfg.systemPrompt()));
  assert.match(cfg.systemPrompt(), /regex \/ hash \/ codec \/ unicode/);
  const re = TOOL_DEFS.find((t) => t.name === 'regex');
  assert.ok(re.parameters.required.includes('pattern'));
});
test('regex：match 捕获组 / replace / explain / 非法 flags', async () => {
  const fs = createFS({ 'notes/a.txt': 'foo1 foo22 bar' });
  const m = await executeTool('regex', { action: 'match', pattern: 'foo(\\d+)', flags: 'g', text: 'foo1 foo22 bar' }, { fs, onUi: () => {} });
  assert.match(m, /2 处/);
  assert.match(m, /\$1="1"/);
  assert.match(m, /\$1="22"/);
  const named = await executeTool('regex', { pattern: '(?<num>\\d+)', flags: 'g', text: 'a12' }, { fs, onUi: () => {} });
  assert.match(named, /\$<num>="12"/);
  const rep = await executeTool('regex', { action: 'replace', pattern: 'foo(\\d+)', flags: 'g', text: 'foo1 x foo2', replacement: '[$1]' }, { fs, onUi: () => {} });
  assert.match(rep, /\[1\] x \[2\]/);
  const fromFile = await executeTool('regex', { action: 'test', pattern: 'foo22', path: 'notes/a.txt' }, { fs, onUi: () => {} });
  assert.match(fromFile, /匹配/);
  const ex = await executeTool('regex', { action: 'explain', pattern: '(?<id>\\d+)', flags: 'gi' }, { fs, onUi: () => {} });
  assert.match(ex, /命名组：id/);
  const bad = await executeTool('regex', { pattern: 'a', flags: 'z' }, { fs, onUi: () => {} });
  assert.match(bad, /非法 flags/);
});
test('hash：sha256 / md5 / crc32 标准向量；沙箱文件按字节', async () => {
  const fs = createFS();
  const sha = await executeTool('hash', { algorithm: 'sha256', text: 'abc' }, { fs, onUi: () => {} });
  assert.match(sha, /ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad/);
  const md = await executeTool('hash', { algorithm: 'md5', text: '' }, { fs, onUi: () => {} });
  assert.match(md, /d41d8cd98f00b204e9800998ecf8427e/);
  const crc = await executeTool('hash', { algorithm: 'crc32', text: '123456789' }, { fs, onUi: () => {} });
  assert.match(crc, /cbf43926/i);
  fs.write('k.bin', 'abc');
  const fileSha = await executeTool('hash', { algorithm: 'sha256', path: 'k.bin' }, { fs, onUi: () => {} });
  assert.match(fileSha, /ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad/);
});
test('codec：base64 往返、url、html、uuid、jwt 解码', async () => {
  const fs = createFS();
  const encd = await executeTool('codec', { action: 'encode', format: 'base64', text: '你好' }, { fs, onUi: () => {} });
  assert.match(encd, /5L2g5aW9/);
  const decd = await executeTool('codec', { action: 'decode', format: 'base64', text: '5L2g5aW9' }, { fs, onUi: () => {} });
  assert.match(decd, /你好/);
  const url = await executeTool('codec', { action: 'encode', format: 'url', text: 'a b' }, { fs, onUi: () => {} });
  assert.match(url, /a%20b/);
  const html = await executeTool('codec', { action: 'encode', format: 'html', text: '<a>' }, { fs, onUi: () => {} });
  assert.match(html, /&lt;a&gt;/);
  const id = await executeTool('codec', { action: 'uuid' }, { fs, onUi: () => {} });
  assert.match(id, /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  const jwt = await executeTool('codec', {
    action: 'decode', format: 'jwt',
    text: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjMifQ.sig',
  }, { fs, onUi: () => {} });
  assert.match(jwt, /"alg": "none"/);
  assert.match(jwt, /"sub": "123"/);
});
test('unicode：inspect 码位、from_codes、normalize', async () => {
  const fs = createFS();
  const ins = await executeTool('unicode', { action: 'inspect', text: '你A😀' }, { fs, onUi: () => {} });
  assert.match(ins, /U\+4F60/);
  assert.match(ins, /U\+41\b|U\+0041/);
  assert.match(ins, /U\+1F600/);
  assert.match(ins, /Han/);
  const from = await executeTool('unicode', { action: 'from_codes', codes: 'U+4F60 0x41' }, { fs, onUi: () => {} });
  assert.match(from, /你A/);
  const nf = await executeTool('unicode', { action: 'normalize', form: 'NFC', text: 'e\u0301' }, { fs, onUi: () => {} });
  assert.match(nf, /é|é/);
});
test('关闭沙箱仍能跑 regex；可与只读工具并行', async () => {
  const fs = createFS();
  const out = await executeTool('regex', { action: 'test', pattern: 'a', text: 'a' }, { fs, sandboxEnabled: false, onUi: () => {} });
  assert.match(out, /匹配/);
  const { batchToolCalls } = await import('../js/agent.js');
  const b = batchToolCalls([
    { name: 'regex', args: { pattern: 'a', text: 'a' } },
    { name: 'hash', args: { text: 'x' } },
    { name: 'write_file', args: { path: 'a', content: '1' } },
  ]);
  assert.deepEqual(b.map((x) => [x.kind, x.start, x.end]), [
    ['parallel', 0, 2],
    ['serial', 2, 3],
  ]);
});

// ── 顺序执行（async 测试逐个 await）──
for (const item of queue) {
  if (item.group) { console.log(item.group); continue; }
  await item.fn();
  passed++;
  console.log(`  ✓ ${item.name}`);
}
console.log(`\n${passed} 项测试全部通过 ✅`);
