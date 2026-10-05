// ─── P0 执行内核独立验收脚本（node tests/execution-kernel-smoke.mjs / npm run test:kernel）──
// 与主测试套件互补：这里不跑全仓回归，而是把 P0 三件事的验收标准逐条打印成报告——
//   1. 统一执行状态机（含失败不可隐式收尾、可重放、刷新可续跑）
//   2. 预算与风险治理（六路预算扣减、L0–L3 分级、最小信息确认请求）
//   3. 工具调用前后契约校验（28 工具契约覆盖率、失败六分类、幂等键）
// 外加一轮真实的端到端回合（stub 掉网关）：工具失败但回答未披露 → 内核补披露并提交执行记录。

import assert from 'node:assert/strict';
import { TOOL_DEFS } from '../js/tools.js';
import { createStore } from '../js/state.js';
import { createAgent } from '../js/agent.js';
import {
  EXECUTION_POLICY_VERSION,
  EXECUTION_KERNEL_VERSION,
  createExecutionStateMachine,
  resumeExecutionState,
  replayExecutionEvents,
  verifyExecutionAudit,
  evaluateExecutionKernelAcceptance,
  formatExecutionKernelAcceptanceReport,
  verifyToolContractCoverage,
  createBudgetGovernor,
  classifyToolRisk,
  formatConfirmationRequest,
  classifyToolFailure,
  detectSilentFailure,
  summarizeExecutionRecord,
  isValidExecutionTransition,
} from '../js/execution.js';

const results = [];
const check = (name, fn) => {
  try {
    const detail = fn();
    results.push({ ok: true, name, detail: detail || '' });
  } catch (err) {
    results.push({ ok: false, name, detail: err && err.message ? err.message : String(err) });
  }
};

console.log(`天枢2.5 执行内核 v${EXECUTION_KERNEL_VERSION}（${EXECUTION_POLICY_VERSION}）· P0 独立验收\n`);

// ── 1. 验收标准：任意一次工具调用可回答「为什么调用 / 调用前状态 / 调用后发生了什么」──
check('状态机：一次工具调用可完整回答前因后果', () => {
  const m = createExecutionStateMachine({ turnId: 'smoke-1', sessionId: 'smoke', now: () => 0 });
  m.transition('CLASSIFIED', '任务类型=code · 能力掩码=R1·W1·S1·D0');
  m.transition('PLANNED', 'Jev 预判完成');
  m.transition('TOOL_PENDING', '模型请求 1 次工具调用');
  m.transition('TOOL_RUNNING', '开始执行 write_file（沙箱能力可用）');
  const run = m.beginToolRun({ name: 'write_file', args: { path: 'files/a.txt' }, reason: '契约允许（filesystem 副作用）', risk: { level: 'L2' }, idempotencyKey: 'idem-smoke' });
  m.transition('TOOL_FAILED', '权限错误：目标路径只读');
  m.endToolRun(run, { status: 'failed', failure: { kind: 'PERMISSION', label: '权限错误' } });
  assert.equal(run.preState, 'TOOL_RUNNING');
  assert.equal(run.postState, 'TOOL_FAILED');
  assert.match(run.reason, /契约允许/);
  return `preState=${run.preState} · postState=${run.postState} · reason=${run.reason}`;
});

// ── 2. 验收标准：工具失败后不会隐式进入最终回答 ──
check('状态机：TOOL_FAILED → COMMITTED 被拒绝（无隐式成功收尾）', () => {
  const m = createExecutionStateMachine({ turnId: 'smoke-2', sessionId: 'smoke', now: () => 0 });
  ['CLASSIFIED', 'PLANNED', 'TOOL_PENDING', 'TOOL_RUNNING', 'TOOL_FAILED'].forEach((s) => m.transition(s, 'smoke'));
  const illegal = m.transition('COMMITTED', '偷懒收尾');
  assert.equal(illegal.ok, false);
  assert.equal(m.state, 'TOOL_FAILED');
  assert.ok(m.transition('ANSWERING_WITH_LIMITATION', '带限制作答并披露').ok);
  assert.ok(m.transition('VERIFIED', '核验').ok);
  assert.ok(m.transition('COMMITTED', '提交').ok);
  return `非法转移被拦截并记录：${m.violations[0].from}→${m.violations[0].to}`;
});

// ── 3. 验收标准：所有状态转移都可以在审计记录中重放 ──
check('审计：状态转移可重放，且版本绑定哈希链能检出篡改', () => {
  const m = createExecutionStateMachine({ turnId: 'smoke-3', sessionId: 'smoke-A', now: () => 0 });
  ['CLASSIFIED', 'PLANNED', 'ANSWERING', 'VERIFIED', 'COMMITTED'].forEach((s) => m.transition(s, 'smoke'));
  const replay = replayExecutionEvents(m.audit.events);
  assert.equal(replay.replayable, true);
  assert.equal(replay.reached, 'COMMITTED');
  const tampered = m.audit.events.map((e, i) => (i === 1 ? { ...e, payload: { ...e.payload, to: 'COMMITTED' } } : e));
  assert.equal(verifyExecutionAudit(tampered).valid, false);
  const other = createExecutionStateMachine({ turnId: 'smoke-3', sessionId: 'smoke-B', now: () => 0 });
  other.transition('CLASSIFIED', 'smoke');
  assert.notEqual(m.audit.events[0].eventHash, other.audit.events[0].eventHash, '不同会话不得产生相同哈希');
  return `${replay.transitionCount} 次转移可重放 · 篡改检出 ✓ · 跨会话哈希不碰撞 ✓`;
});

// ── 4. 验收标准：刷新 / 中断后能判断任务处于哪个阶段 ──
check('续跑：工具执行中被中断 → 判定阶段并给出核验优先入口', () => {
  const m = createExecutionStateMachine({ turnId: 'smoke-4', sessionId: 'smoke', now: () => 0 });
  ['CLASSIFIED', 'PLANNED', 'TOOL_PENDING', 'TOOL_RUNNING'].forEach((s) => m.transition(s, 'smoke'));
  const run = m.beginToolRun({ name: 'write_file', args: { path: 'files/b.txt' }, reason: 'write' });
  m.transition('INTERRUPTED', '页面刷新');
  m.endToolRun(run, { status: 'running' });
  const info = resumeExecutionState(m.snapshot());
  assert.equal(info.resumable, true);
  assert.equal(info.entryState, 'RECOVERY_PENDING');
  return `${info.phaseLabel} · 未完成步骤=${info.pendingStep} · 入口=${info.entryState}`;
});

// ── 5. 验收标准：每个工具都有契约，新增工具漏声明会红灯 ──
check('契约层：全部工具契约覆盖（覆盖率 = 100%）', () => {
  const cov = verifyToolContractCoverage(TOOL_DEFS.map((t) => t.name));
  assert.equal(cov.ok, true, `缺契约：${cov.missing.join(', ')}`);
  return `${cov.coveredCount}/${cov.toolCount} 覆盖 · ${cov.contractVersion}`;
});

// ── 6. 预算与风险治理 ──
check('预算：六路资源实时扣减，超额拦截并留痕', () => {
  const gov = createBudgetGovernor({ maxToolCalls: 2, maxExternalSideEffects: 0 });
  gov.spend('toolCalls'); gov.spend('toolCalls');
  assert.equal(gov.canSpend('toolCalls').ok, false);
  assert.equal(gov.canSpend('externalSideEffects').ok, false);
  return `拦截理由：${gov.canSpend('toolCalls').reason}`;
});

check('风险：L0–L3 分级 + 最小信息确认请求字段齐全', () => {
  const l0 = classifyToolRisk({ name: 'evaluate_expression', args: { expression: '1+1' } });
  const l3 = classifyToolRisk({ name: 'delete_file', args: { path: 'files/a.txt' } });
  assert.equal(l0.level, 'L0');
  assert.equal(l3.level, 'L3');
  const req = formatConfirmationRequest({ name: 'delete_file', args: { path: 'files/a.txt' }, reason: '用户要求清理' });
  for (const f of ['操作：', '原因：', '影响：', '可逆性：', '参数摘要：', '风险等级：']) assert.ok(req.includes(f), `缺字段 ${f}`);
  return `L0 自动执行 · L3 需确认（确认请求 ${req.split('\n').length} 行）`;
});

// ── 7. 失败分类与静默失败检测 ──
check('失败分类：副作用不确定禁止盲目重试，暂时性失败才允许退避', () => {
  const uncertain = classifyToolFailure({ name: 'write_file', result: '写入超时', timedOut: true, stateChanged: true });
  const transient = classifyToolFailure({ name: 'fetch_url', result: '请求超时 timeout' });
  assert.equal(uncertain.kind, 'SIDE_EFFECT_UNCERTAIN');
  assert.equal(uncertain.verifyFirst, true);
  assert.equal(transient.retryable, true);
  return `${uncertain.label}→先核验 · ${transient.label}→可退避重试`;
});

check('静默失败：未披露被检出，已披露不误报', () => {
  const runs = [{ name: 'read_file', status: 'failed', failure: { kind: 'ENVIRONMENT', label: '环境错误' } }];
  assert.equal(detectSilentFailure({ toolRuns: runs, answerText: '答案是 42。' }).silent, true);
  assert.equal(detectSilentFailure({ toolRuns: runs, answerText: '读取失败，无法给出答案。' }).silent, false);
  return '未披露=true · 已披露=false';
});

// ── 8. 内核自检（与运行期 store.state.lastExecutionAcceptance 同一入口）──
const acceptance = evaluateExecutionKernelAcceptance({ toolNames: TOOL_DEFS.map((t) => t.name) });

// ── 9. 端到端回合：工具失败 + 回答未披露 ──
const sseEv = (j) => `data: ${JSON.stringify(j)}\n\n`;
const sseDone = 'data: [DONE]\n\n';
const sseResponse = (body) => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
const openaiToolTurn = (id, name, argsJson) => sseResponse(
  sseEv({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: argsJson } }] } }] })
  + sseEv({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + sseDone);
const openaiTextTurn = (text) => sseResponse(
  sseEv({ choices: [{ delta: { content: text } }] })
  + sseEv({ usage: { prompt_tokens: 7, completion_tokens: 3 }, choices: [] })
  + sseEv({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + sseDone);

const realFetch = globalThis.fetch;
const responses = [
  openaiToolTurn('call_s1', 'read_file', JSON.stringify({ path: 'files/not-there.txt' })),
  openaiTextTurn('根据我的分析，答案是 42。'),
];
globalThis.fetch = async () => responses.shift();
let e2e = { ok: false, detail: '未执行' };
try {
  const store = createStore();
  store.state.settings.webEnabled = false;
  store.state.settings.jevEnabled = false;
  store.state.apiKey = 'sk-teamo-smoke';
  store.state.model = 'gpt-5.6-sol';
  const agent = createAgent(store, {});
  await agent.send('读一下那个文件，然后回答问题');

  const last = store.state.messages[store.state.messages.length - 1];
  const rec = store.state.lastExecutionRecord;
  assert.match(last.text, /执行内核披露/, '未披露失败的最终回答必须由内核补披露');
  assert.equal(last.execution.state, 'COMMITTED');
  assert.match(last.execution.auditDigest, /^[0-9a-f]{64}$/);
  assert.equal(rec.failedCount, 1);
  assert.equal(rec.violations.length, 0);
  let cursor = 'RECEIVED';
  for (const t of rec.transitions) {
    assert.equal(t.from, cursor, `状态轨迹断裂：${JSON.stringify(t)}`);
    assert.ok(isValidExecutionTransition(t.from, t.to));
    cursor = t.to;
  }
  assert.equal(cursor, 'COMMITTED');
  const summary = summarizeExecutionRecord({ machine: null, budget: null, toolRuns: null, silentFailure: rec.silentFailure });
  assert.ok(summary.kernelVersion);
  e2e = {
    ok: true,
    detail: `阶段 ${rec.state} · 转移 ${rec.transitions.length} 次 · 工具 ${rec.toolCallCount} 次（失败 ${rec.failedCount}）· 审计事件 ${rec.auditEventCount} 条 · 静默失败已补披露`,
  };
} catch (err) {
  e2e = { ok: false, detail: err && err.message ? err.message : String(err) };
} finally {
  globalThis.fetch = realFetch;
}
check('端到端：工具失败未披露 → 内核补披露并提交可重放执行记录', () => {
  assert.equal(e2e.ok, true, e2e.detail);
  return e2e.detail;
});

console.log(formatExecutionKernelAcceptanceReport(acceptance));
console.log('');
for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}\n    · ${r.detail}`);

const failed = results.filter((r) => !r.ok);
console.log(`\nP0 执行内核验收：${results.length - failed.length}/${results.length} 通过${acceptance.ok ? ' · 内核自检 ' + acceptance.passed + '/' + acceptance.total : ''}`);
if (failed.length || !acceptance.ok) {
  console.error('\n❌ 存在未通过项，禁止发布。');
  process.exit(1);
}
console.log('✅ P0 执行内核（统一状态机 / 预算与风险治理 / 工具调用前后契约校验）全部验收标准通过。');
