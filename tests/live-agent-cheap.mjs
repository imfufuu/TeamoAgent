// ─── 便宜的真网关 Agent 工具循环（预算内，不做生图矩阵）────────────────
// TEAMO_API_KEY=sk-teamo-xxx node tests/live-agent-cheap.mjs
// 只用免费/最低价模型：get_current_time + write_file 各一轮。
import assert from 'node:assert/strict';
import { createStore } from '../js/state.js';
import { createAgent } from '../js/agent.js';
import { fetchModels } from '../js/api.js';

const API_KEY = process.env.TEAMO_API_KEY;
if (!API_KEY) {
  console.log('⏭  tests/live-agent-cheap.mjs 跳过：未设置 TEAMO_API_KEY');
  process.exit(0);
}

let pass = 0, fail = 0;
const rows = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const info = await fn();
    pass++;
    rows.push(`  ✓ ${name}${info ? ' — ' + info : ''} (${Date.now() - t0}ms)`);
  } catch (e) {
    fail++;
    rows.push(`  ✗ ${name} — ${e.message} (${Date.now() - t0}ms)`);
  }
  console.log(rows[rows.length - 1]);
}

console.log('═══ TeamoAgent 便宜工具循环实测 ═══\n');

let models = [];
await step('GET /v1/models', async () => {
  models = await fetchModels(API_KEY);
  assert.ok(models.length > 3, `仅 ${models.length} 个`);
  return `${models.length} 个`;
});
const model = models.find((m) => m === 'deepseek-flash-free')
  || models.find((m) => m.endsWith('-free'))
  || models.find((m) => m === 'gpt-5.4-mini')
  || models[0];
console.log(`选用模型: ${model}\n`);

await step(`Agent 工具循环 write_file + 收尾 (${model})`, async () => {
  const store = createStore();
  store.state.apiKey = API_KEY;
  store.state.model = model;
  store.state.settings.webEnabled = false;
  store.state.settings.jevEnabled = false;
  store.state.settings.thinking = false;
  store.state.settings.sandboxEnabled = true;
  const agent = createAgent(store, {});
  await agent.send('请调用 write_file 把字符串 hello-live 写入 live.txt，然后用一句话确认路径。不要生图。');
  const roles = store.state.messages.map((m) => m.role);
  const tool = store.state.messages.find((m) => m.role === 'tool');
  const last = [...store.state.messages].reverse().find((m) => m.role === 'assistant' && m.done);
  let fsHit = '';
  try { fsHit = agent.fs.read('live.txt'); } catch { /* 模型可能写了别的路径 */ }
  const listed = agent.fs.list().map((f) => f.path);
  const wrote = listed.some((p) => {
    try { return String(agent.fs.read(p)).includes('hello-live'); } catch { return false; }
  });
  assert.ok(roles.includes('tool') || wrote, `未调用工具也未写入：roles=${roles} files=${listed} last=${(last && last.text || '').slice(0, 80)}`);
  if (wrote || fsHit.includes('hello-live')) {
    return `写入成功 files=${listed.join(',') || '(live.txt)'} status=${agent.getStatus()}`;
  }
  return `调用了工具但内容未命中 hello-live · tool=${(tool && tool.content || '').slice(0, 80)} · ${agent.getStatus()}`;
});

await step(`get_current_time 工具 (${model})`, async () => {
  const store = createStore();
  store.state.apiKey = API_KEY;
  store.state.model = model;
  store.state.settings.webEnabled = false;
  store.state.settings.jevEnabled = false;
  store.state.settings.thinking = false;
  const agent = createAgent(store, {});
  await agent.send('现在几点？必须调用 get_current_time 工具，不要自己编时间。');
  const tool = store.state.messages.find((m) => m.role === 'tool' && m.name === 'get_current_time');
  assert.ok(tool, `未调用 get_current_time。roles=${store.state.messages.map((m) => m.role + ':' + (m.name || ''))}`);
  assert.match(String(tool.content), /ISO|T\d{2}:\d{2}|20\d{2}/);
  return String(tool.content).slice(0, 80);
});

console.log(`\n═══ 结果: ${pass} 通过 / ${fail} 失败 ═══`);
process.exit(fail ? 1 : 0);
