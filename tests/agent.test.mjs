// ─── 核心解析逻辑单测（node tests/agent.test.mjs）─────────────────────
import assert from 'node:assert/strict';
import {
  createSSEParser, createOpenAIStream, createAnthropicStream,
  createToolCallAccumulator, buildOpenAIMessages, buildAnthropicPayload,
  authHeaders, toOpenAITools, toAnthropicTools,
} from '../js/api.js';
import { protocolOf, providerOf, supportsFastMode } from '../js/config.js';
import { renderMarkdown } from '../js/ui.js';
import { createFS } from '../js/sandbox.js';
import { createStore } from '../js/state.js';
import { estimateTokens, compactMessages, truncateToolContent, contextBudgetFor } from '../js/context.js';
import { thinkingParamsFor } from '../js/config.js';
import { SUBAGENTS, findSubagent, subagentGuide } from '../js/subagents.js';
import { TOOL_DEFS } from '../js/tools.js';

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
test('坏 JSON 参数降级为 __raw', () => {
  const acc = createToolCallAccumulator();
  acc.push({ index: 0, id: 'x', name: 'f', argsText: '{broken' });
  assert.deepEqual(acc.result()[0].args, { __raw: '{broken' });
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
  const store = createStore();
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
  const store = createStore();
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
test('compactMessages 整轮丢弃，不产生孤儿 tool 消息', () => {
  const msgs = [];
  for (let i = 0; i < 30; i++) {
    msgs.push({ role: 'user', text: `问题${i} ${'x'.repeat(2000)}` });
    msgs.push({ role: 'assistant', text: '', toolCalls: [{ id: `c${i}`, name: 'f', args: {} }] });
    msgs.push({ role: 'tool', toolCallId: `c${i}`, content: `结果${i} ${'y'.repeat(3000)}` });
    msgs.push({ role: 'assistant', text: `回答${i}`, done: true });
  }
  const { messages, droppedCount } = compactMessages(msgs, 20000);
  assert.ok(droppedCount > 0, '应有丢弃');
  assert.ok(estimateTokens(messages) <= 20000, `压缩后 ${estimateTokens(messages)}`);
  // 关键不变量：每个 tool 消息前面必须存在携带对应 toolCall 的 assistant
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== 'tool') continue;
    const owner = messages.slice(0, i).reverse().find((m) => m.role === 'assistant' && (m.toolCalls || []).some((t) => t.id === messages[i].toolCallId));
    assert.ok(owner, `孤儿 tool 消息: ${messages[i].toolCallId}`);
  }
  // 最新消息必须保留
  assert.equal(messages[messages.length - 1].text, '回答29');
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
  const store = createStore();
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
  const store = createStore();
  const id = store.state.activeSessionId;
  store.deleteSession(id);
  assert.equal(store.state.sessions.length, 1);
  assert.notEqual(store.state.activeSessionId, id);
});

group('导入会话');
test('importSession：导入导出 JSON 会新建并激活会话', () => {
  const store = createStore();
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
  const store = createStore();
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

// ── 顺序执行（async 测试逐个 await）──
for (const item of queue) {
  if (item.group) { console.log(item.group); continue; }
  await item.fn();
  passed++;
  console.log(`  ✓ ${item.name}`);
}
console.log(`\n${passed} 项测试全部通过 ✅`);
