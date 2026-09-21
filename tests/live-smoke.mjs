// ─── 协议层全局冒烟测试（真实 TeamoRouter API）─────────────────────────
// 用法: TEAMO_API_KEY=sk-teamo-xxx node tests/live-smoke.mjs
// 原则: 最小化消耗 —— 免费/最低价模型、极短提示词、跳过图像等贵价路径
// 分工: 本文件只覆盖「两条协议 + 流式解析 + 子智能体」；图像/工具循环的真实验证在
//       tests/live-check.mjs，部署后字节校验在 tests/app-boot.mjs（离线 jsdom）。
import assert from 'node:assert/strict';
import { streamChat, fetchModels, createToolCallAccumulator, thinkingDisabledFor } from '../js/api.js';
import { runSubagent } from '../js/agent.js';
import { createFS } from '../js/sandbox.js';
import { findSubagent } from '../js/subagents.js';
import { TOOL_DEFS } from '../js/tools.js';

const API_KEY = process.env.TEAMO_API_KEY;
if (!API_KEY) {
  // 与其它可选的联网测试一致：没有 key 就跳过（退出码 0），不阻断 npm run test:all / CI
  console.log('⏭  tests/live-smoke.mjs 跳过：未设置 TEAMO_API_KEY（真实网关冒烟测试需显式提供 key）');
  process.exit(0);
}

// 直接用应用真实的工具定义，避免测试里的副本与 tools.js 漂移
const get_current_time_TOOL = TOOL_DEFS.find((t) => t.name === 'get_current_time');

let passed = 0, failed = 0;
const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    const info = await fn();
    passed++;
    results.push(`  ✓ ${name}${info ? ' — ' + info : ''} (${Date.now() - t0}ms)`);
    console.log(results[results.length - 1]);
  } catch (err) {
    failed++;
    results.push(`  ✗ ${name} — ${err.message}`);
    console.log(results[results.length - 1]);
  }
}

// 收集流式事件的小工具
function collect(onExtra) {
  const state = { text: '', reasoning: '', usage: {}, finish: null };
  return {
    state,
    onEvent: (ev) => {
      if (ev.type === 'text') state.text += ev.text;
      else if (ev.type === 'reasoning') state.reasoning += ev.text;
      else if (ev.type === 'usage') Object.assign(state.usage, ev.usage);
      else if (ev.type === 'finish') state.finish = ev.reason;
      else if (ev.type === 'error') throw new Error(ev.message);
      onExtra && onExtra(ev, state);
    },
  };
}

console.log('═══ TeamoAgent 全局冒烟测试 ═══\n');

// ── 0. 模型列表（免费）──
let models = [];
await test('GET /v1/models 实时模型列表', async () => {
  models = await fetchModels(API_KEY);
  assert.ok(models.length > 5, `仅 ${models.length} 个`);
  const fams = ['claude', 'gpt', 'gemini', 'deepseek', 'glm', 'grok'].filter((f) => models.some((m) => m.startsWith(f)));
  assert.ok(fams.length >= 4, `家族覆盖不足: ${fams}`);
  return `${models.length} 个模型，家族: ${fams.join('/')}`;
});

const freeModel = models.find((m) => m === 'deepseek-flash-free') || models.find((m) => m.endsWith('-free')) || models[0];
const claudeModel = models.find((m) => m === 'claude-haiku-4-5') || models.find((m) => m.startsWith('claude'));
console.log(`\n选用: 免费模型=${freeModel} | Claude=${claudeModel}\n`);

// ── 1. OpenAI 协议基础流式 ──
await test(`OpenAI 协议流式 (${freeModel})`, async () => {
  const c = collect();
  await streamChat({
    model: freeModel, apiKey: API_KEY, thinking: false,
    messages: [{ role: 'user', text: '只回复两个字母: OK' }],
    onEvent: c.onEvent,
  });
  assert.ok(c.state.text.length > 0, '无文本输出');
  assert.ok(c.state.usage.output > 0, `无 usage: ${JSON.stringify(c.state.usage)}`);
  return `text="${c.state.text.slice(0, 20)}" usage=↑${c.state.usage.input}/↓${c.state.usage.output}`;
});

// ── 2. OpenAI 协议 tool_calls 流式累积 ──
await test(`OpenAI tool_calls 分片累积 (${freeModel})`, async () => {
  const acc = createToolCallAccumulator();
  const c = collect((ev) => { if (ev.type === 'tool_delta') acc.push(ev); });
  await streamChat({
    model: freeModel, apiKey: API_KEY, thinking: false,
    tools: [get_current_time_TOOL],
    messages: [{ role: 'user', text: '现在几点？必须调用工具回答' }],
    onEvent: c.onEvent,
  });
  const calls = acc.result();
  assert.ok(calls.length >= 1, `未产生 tool_calls（text="${c.state.text.slice(0, 30)}"）`);
  assert.equal(calls[0].name, 'get_current_time');
  assert.ok(calls[0].id, '缺 tool_call id');
  return `${calls.length} 个调用: ${calls[0].name}(${JSON.stringify(calls[0].args)})`;
});

// ── 3. Anthropic 原生协议流式 ──
await test(`Anthropic /v1/messages 流式 (${claudeModel})`, async () => {
  const c = collect();
  await streamChat({
    model: claudeModel, apiKey: API_KEY, thinking: false,
    messages: [{ role: 'user', text: '只回复两个字母: OK' }],
    onEvent: c.onEvent,
  });
  assert.ok(c.state.text.length > 0, '无文本输出');
  assert.ok(c.state.usage.input > 0, `无 input usage: ${JSON.stringify(c.state.usage)}`);
  return `text="${c.state.text.slice(0, 20)}" usage=↑${c.state.usage.input}/↓${c.state.usage.output}`;
});

// ── 4. Anthropic 思考模式（thinking_delta 流）──
await test(`Claude 思考模式 thinking_delta (${claudeModel})`, async () => {
  const c = collect();
  await streamChat({
    model: claudeModel, apiKey: API_KEY, thinking: true,
    messages: [{ role: 'user', text: '鸡兔同笼：35 个头 94 只脚，各几只？请先一步步推理，最后一行只给答案。' }],
    onEvent: c.onEvent,
  });
  assert.ok(c.state.text.length > 0, '无最终回答');
  if (thinkingDisabledFor(claudeModel)) {
    return '该模型不支持思考参数 → 自动降级路径生效 ✓（无 thinking 流）';
  }
  // 实测：上游对「要不要思考」有自主权 —— 同一个请求体，简单问题可以整段不返回 thinking 块，
  // 没块不等于我们解析错（解析路径由离线单测与 live-web 覆盖）。这里只在真收到块时校验内容。
  if (!c.state.reasoning.length) {
    return `上游本次未返回 thinking 块（自适应行为），回答="${c.state.text.slice(0, 16)}" ✓`;
  }
  return `reasoning ${c.state.reasoning.length} 字符 → answer="${c.state.text.slice(0, 16)}"`;
});

// ── 5. OpenAI 协议思考参数（接受或自动降级）──
await test(`OpenAI 协议思考参数/自动降级 (${freeModel})`, async () => {
  const c = collect();
  await streamChat({
    model: freeModel, apiKey: API_KEY, thinking: true,
    messages: [{ role: 'user', text: '只回复两个字母: OK' }],
    onEvent: c.onEvent,
  });
  assert.ok(c.state.text.length > 0, '降级后仍应有文本');
  return thinkingDisabledFor(freeModel)
    ? '该模型拒绝思考参数 → 400 自动降级重试生效 ✓'
    : `思考参数被接受${c.state.reasoning ? `，reasoning ${c.state.reasoning.length} 字符` : ''}`;
});

// ── 6. 子智能体真实运行（纯推理型，单次调用）──
await test('子智能体 runSubagent（explainer · 纯推理）', async () => {
  const def = findSubagent('explainer');
  const report = await runSubagent(def, '用一句话（不超过30字）解释什么是 API。', {
    apiKey: API_KEY, model: freeModel, thinking: false, sandboxEnabled: false,
    fs: createFS(), signal: new AbortController().signal,
  });
  assert.ok(report && report.length > 5, `报告异常: ${report}`);
  return `报告 ${report.length} 字符: "${report.slice(0, 40)}…"`;
});

console.log(`\n═══ 结果: ${passed} 通过 / ${failed} 失败 ═══`);
process.exit(failed ? 1 : 0);
