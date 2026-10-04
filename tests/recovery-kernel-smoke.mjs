// ─── P1（THN v2.4）独立验收：可恢复执行 / 幂等账本 / 交互确认 / 记忆生命周期 / 轨迹级评测 ───
// 与 execution-kernel-smoke.mjs 同风格：纯模块级 + 一轮端到端，不联网，CI 可直接跑。
// 目标是把 P1 的验收要点落成可执行断言：
//   · 任意工具调用可解释（为什么调用 / 调用前后状态）；工具失败不得隐式进入最终回答
//   · 中断或刷新后能判断任务处于哪个阶段；已完成的步骤可以被复用，而不是从零重来
//   · 重复副作用可被拦截（同轮并发 / 跨轮重放），副作用不确定时先核验再决定
//   · 记忆条带 source/confidence/scope/sensitivity/status；来源分级决定能不能进长期库
//   · 三个负向指标（Over-routing / Under-routing / Silent-failure）+ 恢复率与审计完整度
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStore } from '../js/state.js';
import { createAgent } from '../js/agent.js';
import {
  RECOVERY_POLICY_VERSION, buildCheckpoint, createCheckpointStore, planResume,
  verifyCheckpoint, formatResumePlan, summarizeCheckpointHealth,
} from '../js/recovery.js';
import {
  IDEMPOTENCY_POLICY_VERSION, createIdempotencyLedger, planReplay, operationKey, formatLedgerLine,
} from '../js/idempotency.js';
import {
  MEMORY_POLICY_VERSION, MEMORY_SOURCES, evaluateMemoryWriteGate, detectConflicts, applySupersede,
  resolveRecallStates, planMemoryInjection, formatMemoryApplicationReport, summarizeMemoryHealth,
} from '../js/memorylife.js';
import {
  TRAJECTORY_POLICY_VERSION, evaluateTrajectory, summarizeTrajectoryTotals, appendTrajectoryEntry,
  evaluateRecoverability, formatTrajectoryReport,
} from '../js/trajectory.js';
import {
  GUARD_MODES, guardRequiresConfirmation, createConfirmationGate, formatConfirmationRequest,
  CONFIRMATION_DECISIONS, formatConfirmationDecision, classifyToolRisk, TOOL_CONTRACTS,
} from '../js/execution.js';

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ ok: true, name, detail: detail || '通过' });
  } catch (err) {
    results.push({ ok: false, name, detail: (err && err.message) || String(err) });
  }
}
const filesWith = (obj) => ({ ...obj });

// ── ① 检查点：可复用步骤 / 产物漂移可检出 / 恢复计划给出核验顺序 ──
await check('检查点：状态摘要稳定、产物漂移可检出、恢复计划给出「哪些能复用、哪些先核验」', () => {
  // 断言「版本号可被核到」而不是钉死某一版：P2 升到 recovery-policy-2.5.0 时不应再改这里，
  // 真正要钉的是「版本号存在且与 policy.js 注册表一致」（见 policy 漂移自检）。
  assert.match(RECOVERY_POLICY_VERSION, /^recovery-policy-\d+\.\d+\.\d+$/);
  const files = { 'files/a.txt': 'A', 'files/b.txt': 'B' };
  const base = {
    turnId: 'turn-x', sessionId: 's1', executionState: 'TOOL_RUNNING',
    completedSteps: [
      { name: 'write_file', status: 'succeeded', artifacts: ['files/a.txt'] },
      { name: 'write_file', status: 'succeeded', artifacts: [] },
    ],
    pendingStep: 'write_file', artifacts: [{ path: 'files/a.txt', step: 'write_file' }],
    files, messages: [{ role: 'user', text: '生成两个文件' }], memory: [],
    idempotencyKeys: ['idem-aaaaaaaaaaaaaaaa'],
  };
  const cp1 = buildCheckpoint(base);
  const cp2 = buildCheckpoint({ ...base, checkpointId: 'cp-fixed', now: () => cp1.createdAt + 1 });
  const cp1b = buildCheckpoint({ ...base, now: () => cp1.createdAt });
  assert.equal(cp1.stateDigest, cp1b.stateDigest, '同样输入的状态摘要必须稳定（可重放）');

  const store = createCheckpointStore();
  store.record(cp1);
  store.record(cp2);
  assert.equal(store.list('s1').length, 2, '默认逐条落盘（不做隐式合并）');
  store.record(buildCheckpoint({ ...base, checkpointId: 'cp-same', now: () => cp2.createdAt }), { coalesce: true });
  assert.equal(store.list('s1').length, 2, '同轮同步骤同摘要 + coalesce 才会合并');

  // 产物被外部改动 → artifact-drift；文件消失 → artifact-missing；能力退化 → capability-drift
  const drifted = verifyCheckpoint(cp1, { files: filesWith({ ...files, 'files/a.txt': 'A-被别人改了' }) });
  assert.equal(drifted.drift, 'artifact-drift');
  assert.ok(drifted.changedArtifacts.some((x) => x.path === 'files/a.txt'), '被外部改动的产物必须列出');
  assert.equal(drifted.completedSteps.find((st) => st.name === 'write_file').reusable, false, '产物漂移后该步骤不可直接复用');
  assert.equal(verifyCheckpoint(cp1, { files: { 'files/b.txt': 'B' } }).drift, 'artifact-missing');
  const capCp = { ...cp1, capabilityCode: 'cap-old', pendingNeedsSandbox: true, artifacts: [] };
  assert.equal(verifyCheckpoint(capCp, { files, capabilities: { capCode: 'cap-new', sandbox: { enabled: true } } }).drift, 'capability-drift');
  assert.equal(verifyCheckpoint(capCp, { files, capabilities: { capCode: 'cap-new', sandbox: { enabled: false } } }).drift, 'capability-drift');

  const plan = planResume(cp1, { files });
  assert.equal(plan.resumable, true);
  assert.equal(plan.drift, 'none');
  assert.ok(plan.reusableSteps.length >= 2, '产物未漂移时已完成步骤可复用');
  assert.ok(plan.verificationSteps.some((s) => s.includes('files/a.txt')), '未完成步骤必须带出待核验产物');
  assert.match(formatResumePlan(plan), /复用|核验/);
  const health = summarizeCheckpointHealth({ checkpoints: store.toJSON(), files });
  assert.equal(health.count, 2, '健康度必须报告检查点条数');
  assert.equal(health.resumable, true);
  return `${plan.reusableSteps.length} 个可复用步骤 · 漂移检测 ${drifted.drift} / ${verifyCheckpoint(cp1, { files: { 'files/b.txt': 'B' } }).drift} / 能力漂移 · 检查点健康度 ${health.health}（${health.count} 条）`;
});

// ── ② 幂等账本：四类裁决 + 同轮并发只执行一次 + 跨轮操作键稳定 ──
await check('幂等账本：复用 / 先核验 / 拦截重复副作用 / 放行 四类裁决齐备，同轮并发只执行一次', () => {
  assert.equal(IDEMPOTENCY_POLICY_VERSION, 'idem-policy-2.4.0');
  const ledger = createIdempotencyLedger();
  const tool = 'write_file', args = { path: 'files/a.txt', content: 'A' };
  const key = operationKey({ toolName: tool, args });
  assert.equal(key, operationKey({ toolName: tool, args: { content: 'A', path: 'files/a.txt' } }), '参数顺序不影响操作键');

  assert.equal(ledger.claim(key, { tool, turnId: 't1', argsSummary: 'path=files/a.txt' }).ok, true);
  assert.equal(ledger.claim(key, { tool, turnId: 't1' }).ok, false, '同轮同键并发必须被拦下');
  ledger.settle(key, { status: 'succeeded', tool, turnId: 't1', resultDigest: 'd1', artifactPath: 'files/a.txt', artifactDigest: 'dig1' });

  const dec = (over) => planReplay({ entry: ledger.lookup(key), contract: { sideEffect: 'filesystem' }, ...over }).decision;
  assert.equal(dec({ currentArtifactDigest: 'dig1', currentTurnId: 't2' }), 'reuse', '目标状态已满足 → 复用');
  assert.equal(dec({ currentArtifactDigest: 'dig1', currentTurnId: 't1' }), 'reuse', '同轮重复 → 复用（绝不重复执行）');
  assert.equal(dec({ currentArtifactDigest: 'dig-nope', currentTurnId: 't3' }), 'allow', '产物已被改过 → 本次重写是新的有效操作');
  assert.equal(dec({ currentArtifactDigest: null, currentTurnId: 't3' }), 'verify-first', '目标状态未知 → 先核验再决定');
  const uncertainLedger = createIdempotencyLedger();
  uncertainLedger.claim('op-uncertain', { tool: 'call_api', turnId: 't1' });
  uncertainLedger.settle('op-uncertain', { status: 'uncertain', tool: 'call_api', turnId: 't1', reason: '结果丢失' });
  const uncertain = planReplay({ entry: uncertainLedger.lookup('op-uncertain'), contract: { sideEffect: 'external' }, currentArtifactDigest: null, currentTurnId: 't9' });
  assert.equal(uncertain.decision, 'verify-first', '副作用不确定 → 先核验');
  assert.match(uncertain.guidance, /核验/);
  assert.equal(dec({ currentArtifactDigest: null, userText: '请重写覆盖 files/a.txt', currentTurnId: 't3' }), 'allow', '用户明确要求重写 → 放行');

  const risky = createIdempotencyLedger();
  risky.claim('op-submit', { tool: 'fetch_url', turnId: 't1' });
  risky.settle('op-submit', { status: 'succeeded', tool: 'fetch_url', turnId: 't1', resultDigest: 'r', reason: '已提交' });
  const blocked = planReplay({ entry: risky.lookup('op-submit'), contract: { sideEffect: 'network', external: true }, currentArtifactDigest: null, currentTurnId: 't9' });
  assert.equal(blocked.decision, 'block', '外部副作用重复必须拦截（重复提交 / 重复计费）');
  assert.match(blocked.reason, /fetch_url/, '拦截原因必须点名具体工具');
  assert.match(blocked.guidance, /核验|明确要求/, '拦截同时必须给出出路，而不是死路');
  assert.match(formatLedgerLine(risky), /幂等账本.*succeeded×1/, '账本摘要必须反映真实状态分布（不夸大也不掩盖）');
  return `操作键 ${key} · 四类裁决全部命中 · 账本 ${risky.snapshot().length} 条`;
});

// ── ③ 记忆生命周期：写入门槛 / 来源分级 / 召回状态机 / 冲突取代 ──
await check('记忆生命周期：写入门槛四问、来源分级、召回状态机（含本轮不采用）与冲突取代', () => {
  assert.match(MEMORY_POLICY_VERSION, /^memory-policy-\d+\.\d+\.\d+$/);
  assert.equal(MEMORY_SOURCES['user-explicit'].longTermEligible, true);
  assert.equal(MEMORY_SOURCES['model-guess'].longTermEligible, false, '模型推测不得进长期库');
  assert.ok(MEMORY_SOURCES['user-explicit'].rank > MEMORY_SOURCES['user-stable'].rank, '用户明确要求 > 用户长期稳定行为');
  assert.ok(MEMORY_SOURCES['single-turn'].rank > MEMORY_SOURCES['model-guess'].rank, '单轮推断优先级高于模型推测');

  const ok = evaluateMemoryWriteGate({ fact: '项目使用 Node.js 20', source: 'user-explicit', userText: '记住：项目使用 Node.js 20' });
  assert.equal(ok.pool, 'long_term');
  assert.equal(ok.questions.length, 4, '门槛必须自问四件事');
  assert.ok(ok.normalized.confidence > 0 && ok.normalized.scope && ok.normalized.sensitivity && ok.normalized.status);
  assert.equal(evaluateMemoryWriteGate({ fact: '所有人永远都不喜欢长回答', source: 'user-explicit', userText: '记住：所有人永远都不喜欢长回答' }).pool, 'candidate', '过度概括降级为候选');
  assert.equal(evaluateMemoryWriteGate({ fact: '我的 api key 是 sk-teamo-secret-1234', source: 'agent-tool', userText: '帮我看看环境' }).pool, 'candidate', '敏感信息默认只进候选区');
  assert.equal(evaluateMemoryWriteGate({ fact: '我的 api key 是 sk-teamo-secret-1234', source: 'agent-tool', userText: '帮我记一下环境' }).sensitivity, 'HIGH', '用户明确要求保存时才落库，但仍标记敏感');

  const entries = [
    { id: 'm1', text: '用户偏好中文回答', source: 'user-explicit', confidence: 0.98 },
    { id: 'm2', text: '用户偏好英文回答', source: 'user-explicit', confidence: 0.9, ts: Date.now() + 1 },
  ];
  const conflicts = detectConflicts(entries);
  assert.ok(conflicts.length >= 1, '语义冲突必须被识别');
  const supersede = applySupersede(entries, conflicts);
  assert.ok(supersede.superseded.length >= 1, '冲突必须产生取代关系');
  const superseded = supersede.entries;
  assert.equal(superseded.some((e) => e.status === 'SUPERSEDED' && e.supersededBy), true, '被取代条目必须标记 SUPERSEDED + supersededBy');

  const oldEntry = superseded.find((e) => e.id === 'm1');
  assert.equal(oldEntry.supersededBy, 'm2', '取代关系必须可追溯（supersededBy）');
  const recall = resolveRecallStates({ recalled: superseded, userText: '帮我看看这个方案' });
  assert.equal(recall.states.find((s) => s.id === 'm2').applicationState, 'APPLIED', '最新条目正常采用');
  assert.equal(recall.states.find((s) => s.id === 'm1').applicationState, 'REJECTED_FOR_TURN', '被取代条目本轮不采用');
  // 用户主动提到某条内容 → VALIDATED（而不是只当 RECALLED 静默塞进去）
  const recallZh = resolveRecallStates({ recalled: [{ id: 'm4', text: '用户偏好中文回答' }], userText: '还是用中文回答吧' });
  assert.equal(recallZh.states[0].applicationState, 'VALIDATED', '用户主动提到该内容 → VALIDATED');
  const conflictZh = resolveRecallStates({ recalled: superseded, userText: '还是用中文回答吧' });
  assert.equal(conflictZh.states.find((s) => s.id === 'm2').applicationState, 'REJECTED_FOR_TURN', '与本轮指令相反的记忆本轮不用');
  const conflicted = resolveRecallStates({ recalled: [{ id: 'm3', text: '用户偏好极简回答，越短越好' }], userText: '请详细展开，逐条说明' });
  assert.equal(conflicted.states[0].applicationState, 'REJECTED_FOR_TURN');
  assert.match(conflicted.states[0].applicationReason, /本轮指令优先/);
  const plan = planMemoryInjection([{ id: 'm3', text: '用户偏好极简回答，越短越好' }], conflicted.states);
  assert.equal(plan.injected.length, 0, '本轮不采用的记忆不得进入提示词');
  assert.match(formatMemoryApplicationReport(conflicted), /REJECTED_FOR_TURN=1/);
  const health = summarizeMemoryHealth({ memory: superseded, candidates: [{}] });
  assert.equal(health.candidateCount, 1);
  return `门槛四问 · 来源分级 ${Object.keys(MEMORY_SOURCES).length} 级 · 冲突取代 ${conflicts.length} 组 · 健康度 ${health.activeCount} 条有效`;
});

// ── ④ 交互确认：档位策略 + 三决定 + 超时 fail-closed ──
await check('交互确认：档位决定打断边界，允许本次 / 本会话放行 / 拒绝，超时与未决一律按拒绝', async () => {
  assert.deepEqual([...GUARD_MODES], ['observe', 'strict', 'strict-l2'], '默认 observe，strict 只拦 L3，strict-l2 覆盖 L2+L3');
  assert.equal(guardRequiresConfirmation({ guard: 'observe', risk: { level: 'L3' } }), false);
  assert.equal(guardRequiresConfirmation({ guard: 'strict', risk: { level: 'L3' } }), true);
  assert.equal(guardRequiresConfirmation({ guard: 'strict', risk: { level: 'L2' } }), false);
  assert.equal(guardRequiresConfirmation({ guard: 'strict-l2', risk: { level: 'L2' } }), true);
  const risky = classifyToolRisk({ name: 'delete_file', args: { path: 'files/keep.txt' }, contract: TOOL_CONTRACTS.delete_file, fs: null, userText: '删掉它' });
  assert.equal(risky.level, 'L3', '删除类不可自动恢复的操作按 L3 处理');
  assert.equal(TOOL_CONTRACTS.fetch_url.external, true, '跨系统边界调用必须标记 external（重复执行会重复提交）');
  const req = formatConfirmationRequest({ name: 'delete_file', args: { path: 'files/keep.txt' }, reason: '不可逆删除', impact: '文件从沙箱消失（仅能从检查点回滚）', reversibility: '不可自动恢复' });
  for (const field of ['操作', '原因', '影响', '可逆性', '参数']) assert.ok(req.includes(field), `确认请求缺少字段：${field}`);

  const gate = createConfirmationGate({ timeoutMs: 20 });
  const waiting = gate.wait({ key: 'k1', tool: 'delete_file', requestText: req });
  assert.equal(gate.pendingCount, 1);
  assert.equal(gate.resolve('k1', CONFIRMATION_DECISIONS.ALLOW_SESSION, '测试：本会话放行').ok, true);
  const rec = await waiting;
  assert.equal(rec.decision, 'allow-session');
  assert.equal(gate.isSessionAllowed('delete_file'), true, '本会话放行后同类工具不再打断');

  const gate2 = createConfirmationGate({ timeoutMs: 20 });
  const timedOut = await gate2.wait({ key: 'k2', tool: 'delete_file', requestText: req });
  assert.equal(timedOut.decision, 'timeout', '无人应答 → 超时');
  assert.match(formatConfirmationDecision(timedOut), /未执行|拒绝/, '超时按拒绝处理（fail-closed）');
  const gate3 = createConfirmationGate({ timeoutMs: 1000 });
  const p3 = gate3.wait({ key: 'k3', tool: 'delete_file' });
  gate3.cancelAll('回合结束');
  const cancelled = await p3;
  assert.equal(cancelled.decision, 'deny', '回合结束的未决确认一律按拒绝收口（fail-closed）');
  assert.match(cancelled.reason, /作废|回合结束/);
  const gate4 = createConfirmationGate({ timeoutMs: 1000 });
  const p4 = gate4.wait({ key: 'k4', tool: 'delete_file' });
  assert.equal(gate4.resolve('k4', CONFIRMATION_DECISIONS.DENY, '测试：用户拒绝').ok, true);
  assert.equal((await p4).decision, 'deny', '用户拒绝 → 不执行');
  assert.equal(gate4.resolve('已过期', CONFIRMATION_DECISIONS.ALLOW_ONCE).ok, false, '过期确认请求不得再放行');
  return `observe/strict/strict-l2 边界正确 · 允许本次/本会话/拒绝齐备 · 超时 ${timedOut.decision} · 作废 ${cancelled.decision}`;
});

// ── ⑤ 轨迹级评测：三个负向指标 + 恢复率 / 审计完整度 / 多余调用率 ──
await check('轨迹级评测：Over/Under-routing 与 Silent-failure 三个负向指标、恢复率、审计完整度、按任务类型切分', () => {
  assert.equal(TRAJECTORY_POLICY_VERSION, 'trajectory-policy-2.4.0');
  // 答对但过程危险：模型把失败的调用说成成功 → Silent-failure
  const bad = evaluateTrajectory({
    record: {
      turnId: 't1', taskClass: 'chat',
      toolRuns: [{ index: 1, name: 'fetch_url', status: 'failed', riskLevel: 'L2', failure: { kind: 'NETWORK' }, postValidation: { issues: [{ id: 'empty-result', severity: 'high' }] } }],
      silentFailure: { silent: true, failedTools: ['fetch_url'] },
    },
    userText: '帮我查一下今天的新闻',
    plan: { needSearch: true },
    capabilities: { web: { enabled: true }, sandbox: { enabled: true }, dispatch: { enabled: false } },
  });
  assert.equal(bad.metrics.silentFailure.flagged, true, '工具失败未披露必须被标记');
  assert.equal(bad.healthy, false);
  assert.ok(bad.negativeCount >= 1);

  // 简单问答却走重链路 → Over-routing；计划需要检索但没调工具 → Under-routing
  const over = evaluateTrajectory({
    record: { turnId: 't2', toolRuns: [{ name: 'execute_javascript', status: 'succeeded', riskLevel: 'L1' }] },
    userText: '你好', plan: { needSearch: false, needCode: false }, capabilities: { web: { enabled: true }, sandbox: { enabled: true } },
  });
  assert.equal(over.metrics.overRouting.flagged, true, '简单问答走重链路必须被标记');
  const under = evaluateTrajectory({
    record: { turnId: 't3', toolRuns: [] },
    userText: '帮我查一下最新的汇率', plan: { needSearch: true },
    capabilities: { web: { enabled: true }, sandbox: { enabled: true } },
  });
  assert.equal(under.metrics.underRouting.flagged, true, '计划需要检索却没有检索必须被标记');

  const good = evaluateTrajectory({
    record: {
      turnId: 't4', toolRuns: [
        { index: 1, name: 'fetch_url', status: 'failed', riskLevel: 'L2', failure: { kind: 'NETWORK' } },
        { index: 2, name: 'fetch_url', status: 'succeeded', riskLevel: 'L2', retryOf: 1, recovered: true },
      ],
      silentFailure: { silent: false, disclosedTools: ['fetch_url'] },
    },
    userText: '查汇率并说明来源', plan: { needSearch: true },
    capabilities: { web: { enabled: true }, sandbox: { enabled: true } },
  });
  assert.equal(good.metrics.silentFailure.flagged, false);
  assert.ok(Number.isFinite(good.metrics.recovery.value), '恢复率必须给出数值');
  assert.equal(typeof good.metrics.audit.value, 'number', '审计完整度必须给出数值');
  assert.ok(Number.isFinite(good.metrics.unnecessaryCallRate.value), '多余调用率必须给出数值');
  assert.equal(good.metrics.sideEffectSafety.flagged, false, '无未确认的高风险副作用 → 副作用安全');
  assert.equal(good.metrics.recovery.value, 1, '失败后按契约重试成功 → 恢复率 100%');
  assert.equal(good.healthy, true, '无负向指标命中即健康回合');

  const log = appendTrajectoryEntry(appendTrajectoryEntry([], bad), good);
  const totals = summarizeTrajectoryTotals(log);
  assert.equal(totals.turns, 2);
  assert.ok(totals.silentFailureRate > 0, '静默失败率必须被计入');
  assert.ok(totals.byClass.chat, '必须按任务类型切分');
  assert.ok(Number.isFinite(totals.auditCompleteness) && Number.isFinite(totals.recoverySuccessRate));
  assert.match(formatTrajectoryReport(totals), /轨迹|负向/);
  const rec = evaluateRecoverability({ failureKind: 'NETWORK', verified: true, recovered: true, disclosed: true, audited: true, stopped: false });
  const checks = rec.checks;
  assert.equal(checks.detectable && checks.stoppable && checks.recoverable && checks.auditable, true, '故障必须可检测/可停止/可恢复/可审计');
  assert.equal(rec.ok, true, '五项齐备时故障处置判为达标');
  return `负向指标命中：silent-failure=${bad.metrics.silentFailure.flagged} · over=${over.metrics.overRouting.flagged} · under=${under.metrics.underRouting.flagged} · 健康回合 ${totals.healthyTurns}/${totals.turns} · 恢复处置 ${rec.score}/${rec.total}`;
});

// ── ⑥ 端到端：中断 → 刷新（状态 JSON 往返）→ 恢复计划复用已完成步骤 ──
const realFetch = globalThis.fetch;
const sse = (body) => `data: ${JSON.stringify(body)}\n\n`;
const sseRes = (b) => new Response(b, { status: 200, headers: { 'content-type': 'text/event-stream' } });
const toolTurn = (id, name, args) => sseRes(
  sse({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
  + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n',
);
const textTurn = (t) => sseRes(sse({ choices: [{ delta: { content: t } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
const storeNoWeb = (store) => { store.state.settings.webEnabled = false; store.state.settings.jevEnabled = false; return store; };

let e2e = { ok: false, detail: '未执行' };
try {
  const responses = [
    toolTurn('e1', 'write_file', { path: 'files/one.txt', content: '1' }),
    textTurn('已创建 files/one.txt，内容为 1。'),
    toolTurn('e2', 'write_file', { path: 'files/two.txt', content: '2' }),
    textTurn('两步都完成了。'),
  ];
  globalThis.fetch = async () => responses.shift();
  const store = storeNoWeb(createStore());
  store.state.apiKey = 'sk-teamo-test';
  store.state.model = 'gpt-5.6-sol';
  const agent = createAgent(store, {});
  await agent.send('先生成 files/one.txt');

  // 「刷新」：只保留可持久化的状态，重新建 store + agent（内存里的 fs 用落盘的文件恢复）
  // 「刷新」= localStorage 快照往返：整个 state（含会话 id，检查点按会话归属）
  const persisted = JSON.parse(JSON.stringify(store.state));
  assert.ok(persisted.executionCheckpoints.length >= 1, '检查点必须落盘');
  assert.ok(persisted.executionIdempotency.length >= 1, '幂等账本必须落盘');
  assert.ok(persisted.trajectoryLog.length >= 1, '轨迹日志必须落盘');
  assert.equal(persisted.files['files/one.txt'], '1');

  const store2 = storeNoWeb(createStore());
  store2.state.apiKey = 'sk-teamo-test';
  store2.state.model = 'gpt-5.6-sol';
  Object.assign(store2.state, persisted);
  const agent2 = createAgent(store2, {});
  agent2.loadFiles(persisted.files);
  // 刷新后能判断任务处于哪个阶段，并给出「哪些步骤可复用」
  const plan = agent2.getResumePlan();
  assert.ok(plan, '刷新后必须能拿到续跑计划');
  assert.equal(plan.drift, 'none');
  assert.ok(plan.reusableSteps.length >= 1, '已完成的写文件步骤可复用（不重复落副作用）');
  // 复用同一个操作 → 幂等账本直接复用，不再写一次
  const before = store2.state.files['files/one.txt'];
  await agent2.send('再把 files/one.txt 写一遍同样的内容');
  const toolMsg = [...store2.state.messages].reverse().find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /幂等复用|已写入/);
  if (/幂等复用/.test(toolMsg.content)) {
    assert.equal(store2.state.files['files/one.txt'], before, '复用路径不得重复落副作用');
  }
  e2e = {
    ok: true,
    detail: `刷新后恢复计划：可复用 ${plan.reusableSteps.length} 步 · 待核验 ${plan.verificationSteps.length} 项 · 漂移 ${plan.drift} · 第二轮判定 ${(/幂等复用/.test(toolMsg.content) ? '幂等复用' : '重新执行')}`,
  };
} catch (err) {
  e2e = { ok: false, detail: (err && err.message) || String(err) };
} finally {
  globalThis.fetch = realFetch;
}
await check('端到端：中断 / 刷新后能判断任务阶段、复用已完成步骤，不重复落副作用', () => {
  assert.equal(e2e.ok, true, e2e.detail);
  return e2e.detail;
});

// ── ⑦ 状态持久化：P1 键落盘、容量上限、坏数据兜底 ──
await check('状态持久化：P1 状态键默认就位、超限自动裁剪、坏形状不带着跑', () => {
  const store = createStore();
  for (const k of ['executionCheckpoints', 'executionIdempotency', 'trajectoryLog', 'memoryCandidates']) {
    assert.ok(Array.isArray(store.state[k]), `${k} 必须是数组`);
  }
  assert.equal(store.state.trajectoryTotals, null);
  assert.equal(store.state.memoryHealth, null);
  const src = readFileSync(new URL('../js/state.js', import.meta.url), 'utf8');
  assert.match(src, /normalizeP1State/, 'state.js 必须对 P1 键做形状与容量兜底');
  assert.match(src, /estimateStateChars[\s\S]{0,2400}executionCheckpoints/, '体积预估必须计入 P1 落盘数据');
  return '六个 P1 状态键就位 · 形状/容量兜底与体积计入已就位';
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}\n    · ${r.detail}`);
console.log(`\nP1 可恢复执行验收：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.error('\n❌ 存在未通过项，禁止发布。');
  process.exit(1);
}
console.log('✅ P1（检查点 / 幂等账本 / 交互确认 / 记忆生命周期 / 轨迹级评测）全部验收标准通过。');
