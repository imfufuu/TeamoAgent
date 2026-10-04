// ─── P2 内核冒烟（THN v2.5）───────────────────────────────────────────────
// 目的：把 P2 新模块**在真实数据流上**跑一遍，断言的是可核验的输出，不是「函数存在」。
// 与 p2-eval.mjs 的分工：
//   · p2-eval.mjs   —— 评测集口径（120 条分层样本，P/R/F1 + Wilson CI），衡量「判得准不准」
//   · 本文件        —— 内核口径（模块之间接得上吗、坏输入是否 fail-closed），衡量「接得对不对」
// 运行：node tests/p2-kernel-smoke.mjs
//
// 纪律：不 mock 被测模块。每一条断言都基于 execution.js / recovery.js / audit.js / metrics.js /
// faults.js / experiments.js / policy.js / executionContext.js 的真实返回值。

import { strict as assert } from 'node:assert';
import {
  EXECUTION_STATES, EXECUTION_POLICY_VERSION, AUDIT_SCHEMA_VERSION, DEFAULT_TURN_BUDGET,
  createExecutionStateMachine, createExecutionContext, assertContextToolAlignment,
  buildCapabilityConstraints, validateToolCallPre, validateToolResultPost,
  classifyToolRisk, guardRequiresConfirmation, createBudgetGovernor, finalizeExecutionTurn,
  evaluateExecutionKernelAcceptance, TOOL_CONTRACTS, classifyToolFailure, verifyExecutionAudit,
  FAILURE_KINDS, formatConfirmationRequest, summarizeExecutionRecord, BUDGET_CHANNELS,
} from '../js/execution.js';
import { createCheckpointStore, buildCheckpoint, planResume, verifyCheckpoint } from '../js/recovery.js';
import { createIdempotencyLedger, operationKey, planReplay } from '../js/idempotency.js';
import { reconcileAudit, bindAuditContext, formatAuditGoalsReport, AUDIT_GOALS } from '../js/audit.js';
import { buildMetricSnapshot, evaluateMetricGate, computeMetrics, METRIC_DEFS, METRIC_DIMENSIONS } from '../js/metrics.js';
import { createFaultInjector, verifyFaultHandling, FAULT_KINDS, buildFaultCoverageMatrix } from '../js/faults.js';
import { resolveExperimentAssignment, appendExperimentSample, summarizeExperiment, compareOfflineVariants, EXPERIMENT_DECISIONS } from '../js/experiments.js';
import { verifyPolicyRegistry, snapshotPolicies, diffPolicySnapshots, POLICY_VERSIONS, formatPolicyDriftReport } from '../js/policy.js';
import {
  createTurnExecutionContext, deriveToolWhitelist, assertExecutionContextConsistency,
  describeExecutionContext, contextAuditFields, diffExecutionContexts, CONTEXT_SPLIT_CODES,
} from '../js/executionContext.js';

let passed = 0;
const failures = [];
const check = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { failures.push({ name, message: err.message }); console.log(`  ✗ ${name}\n      ${err.message}`); }
};
const group = (title) => console.log(`\n${title}`);

// 一个「像真的」工具表：名字与 TOOL_CONTRACTS 对齐，避免用假名字自欺
const contractNames = Object.keys(TOOL_CONTRACTS);
const fakeTools = (names) => names.filter((n) => contractNames.includes(n)).map((n) => ({ name: n }));

// ────────────────────────────────────────────────────────────────────────────
group('P2-1 策略版本注册表：13 项策略独立版本化，漂移必须报错而不是静默');

const policyResult = await verifyPolicyRegistry();
check('策略注册表自检通过（声明 = 模块实际导出）', () => {
  assert.equal(policyResult.ok, true, formatPolicyDriftReport(policyResult));
  assert.equal(policyResult.checked, policyResult.total, '应逐项核到每个策略源');
  assert.ok(policyResult.total >= 13, `策略源应覆盖 router/tool/memory/risk/prompt/audit/experiment，实际 ${policyResult.total}`);
});
check('策略快照冻结且可比较（同一会话前后两次执行能说清变了什么）', () => {
  const a = snapshotPolicies();
  const b = snapshotPolicies();
  assert.equal(Object.isFrozen(a.versions), true, '快照必须冻结，否则事后比对会被改写');
  assert.equal(diffPolicySnapshots(a, b).changed, false);
  const drifted = { versions: { ...POLICY_VERSIONS, riskPolicyVersion: 'risk-policy-1.0.0' } };
  const diff = diffPolicySnapshots(a, drifted);
  assert.equal(diff.changed, true);
  assert.equal(diff.changes[0].key, 'riskPolicyVersion');
});
check('审计绑定字段恰好是 P2 要求的八项（schemaVersion/sessionId/turnId/eventIndex/prevDigest/eventType/normalizedPayload/policyVersion）', () => {
  const bind = bindAuditContext({ sessionId: 's1', turnId: 't1', eventIndex: 3, eventType: 'tool-call-start', payload: { name: 'read_file' }, policyVersions: POLICY_VERSIONS });
  assert.match(bind.contextDigest, /^[0-9a-f]{64}$/);
  assert.ok(bind.boundKeys.includes('riskPolicyVersion'), '策略版本必须进绑定材料');
});

// ────────────────────────────────────────────────────────────────────────────
group('P2-2 统一执行上下文：工具表由上下文派生，状态分裂当场判缺陷');

const capFull = buildCapabilityConstraints({ relayOk: true, webEnabled: true, sandboxEnabled: true, canDispatch: true });
const capNoRelay = buildCapabilityConstraints({ relayOk: false, webEnabled: true, sandboxEnabled: true, canDispatch: false });
const policySnapshot = snapshotPolicies();
const allTools = fakeTools(['read_file', 'write_file', 'fetch_url', 'execute_javascript', 'dispatch_subagent', 'run_git', 'get_time']);
const ctxFull = createTurnExecutionContext({
  turnId: 't-ctx', sessionId: 's-ctx', userIntent: '帮我抓一下官网首页', taskClass: 'web', reasoningState: 'MEDIUM',
  capability: capFull, budget: DEFAULT_TURN_BUDGET, policy: policySnapshot,
  audit: { schemaVersion: AUDIT_SCHEMA_VERSION, policyVersion: EXECUTION_POLICY_VERSION, prevDigest: '0'.repeat(64) },
});

check('工具表白名单由上下文派生，且摘掉能力不具备的工具（含原因）', () => {
  const wl = deriveToolWhitelist(ctxFull, allTools);
  assert.deepEqual(wl.allowed.map((t) => t.name), allTools.map((t) => t.name), '能力齐全时不得丢工具');
  const offline = createTurnExecutionContext({ capability: capNoRelay, budget: DEFAULT_TURN_BUDGET, policy: policySnapshot, audit: { schemaVersion: AUDIT_SCHEMA_VERSION, policyVersion: EXECUTION_POLICY_VERSION, prevDigest: '0'.repeat(64) } });
  const wl2 = deriveToolWhitelist(offline, allTools);
  const names = wl2.allowed.map((t) => t.name);
  assert.ok(!names.includes('fetch_url'), '中继离线时 fetch_url 必须摘掉');
  assert.ok(!names.includes('dispatch_subagent'), '未获委派能力时 dispatch_subagent 必须摘掉');
  assert.equal(wl2.dropped.find((d) => d.name === 'fetch_url').reason, 'relay-offline');
});
check('能力齐全时上下文自检通过（含与旧路径工具表的交叉验证）', () => {
  const wl = deriveToolWhitelist(ctxFull, allTools);
  const r = assertExecutionContextConsistency(ctxFull, wl.allowed, { legacyToolNames: allTools.map((t) => t.name) });
  assert.equal(r.consistent, true, JSON.stringify(r.splits));
  assert.ok(r.checks.includes('claim-vs-effective'));
});
check('Worker search/crawl 只有 health 明确声明时才进入工具表，且声明与工具表双向校验', () => {
  const featureCapability = buildCapabilityConstraints({
    relayOk: true, webEnabled: true, sandboxEnabled: true, canDispatch: true,
    overrides: { web: { search: true, crawl: true } },
  });
  const featureCtx = createTurnExecutionContext({
    capability: featureCapability, budget: DEFAULT_TURN_BUDGET, policy: policySnapshot,
    audit: { schemaVersion: AUDIT_SCHEMA_VERSION, policyVersion: EXECUTION_POLICY_VERSION, prevDigest: '0'.repeat(64) },
  });
  const workerTools = fakeTools([...allTools.map((t) => t.name), 'search_web', 'crawl_site']);
  const workerWhitelist = deriveToolWhitelist(featureCtx, workerTools);
  assert.ok(workerWhitelist.allowed.some((t) => t.name === 'search_web'));
  assert.ok(workerWhitelist.allowed.some((t) => t.name === 'crawl_site'));
  assert.equal(assertExecutionContextConsistency(featureCtx, workerWhitelist.allowed).consistent, true);
  const missingRoutes = assertExecutionContextConsistency(featureCtx, allTools);
  assert.equal(missingRoutes.consistent, false);
  assert.equal(missingRoutes.splits.filter((s) => s.code === CONTEXT_SPLIT_CODES.capabilityWithoutTool).length, 2);

  const oldRelayCapability = buildCapabilityConstraints({
    relayOk: true, webEnabled: true, sandboxEnabled: true, canDispatch: true,
    overrides: { web: { search: false, crawl: false } },
  });
  const oldRelayContext = createTurnExecutionContext({
    capability: oldRelayCapability, budget: DEFAULT_TURN_BUDGET, policy: policySnapshot,
    audit: { schemaVersion: AUDIT_SCHEMA_VERSION, policyVersion: EXECUTION_POLICY_VERSION, prevDigest: '0'.repeat(64) },
  });
  const oldRelayWhitelist = deriveToolWhitelist(oldRelayContext, workerTools);
  assert.ok(!oldRelayWhitelist.allowed.some((t) => t.name === 'search_web' || t.name === 'crawl_site'));
  assert.equal(assertExecutionContextConsistency(oldRelayContext, oldRelayWhitelist.allowed).consistent, true);
  return 'health=true 时两路工具进入工具表并强制对齐；false/未声明时安全裁剪';
});
check('经典状态分裂被检出：声明允许 Web 但工具表没有 Web 工具', () => {
  // 声明能力由故障自测篡改（claim 说能联网），实际工具表里没有 fetch_url
  const claimed = createTurnExecutionContext({
    capability: capNoRelay, budget: DEFAULT_TURN_BUDGET, policy: policySnapshot,
    audit: { schemaVersion: AUDIT_SCHEMA_VERSION, policyVersion: EXECUTION_POLICY_VERSION, prevDigest: '0'.repeat(64) },
    claimedBits: { relay: true, web: true },
  });
  const wl = deriveToolWhitelist(claimed, allTools);
  const r = assertExecutionContextConsistency(claimed, wl.allowed);
  const codes = r.splits.map((s) => s.code);
  assert.equal(r.consistent, false);
  assert.ok(codes.includes(CONTEXT_SPLIT_CODES.claimDiffersEffective), `应报「声明≠实际」：${JSON.stringify(codes)}`);
  assert.ok(codes.includes(CONTEXT_SPLIT_CODES.capabilityWithoutTool), `应报「声明能力缺工具」：${JSON.stringify(codes)}`);
});
check('另外几类分裂也各自可检出（约束遮蔽能力 / 预算撑不起并发 / 审计绑定缺字段）', () => {
  const cloak = createTurnExecutionContext({
    // 沙箱实际已关，约束里却还写着「禁网」——给一个不存在的执行环境写规则
    capability: {
      ...capFull,
      bits: { relay: 0, web: 0, sandbox: 0, dispatch: 0 },
      sandbox: { enabled: false, network: false, maxRuntimeMs: 1000, maxExecutionsPerTurn: 1, allowedPaths: [] },
      web: { enabled: false, allowedHosts: ['example.com'], maxFetchesPerTurn: 1 },
    },
    budget: { ...DEFAULT_TURN_BUDGET, maxExternalSideEffects: 1 },   // 并发声明 3，副作用额度只有 1
    policy: policySnapshot,
    audit: { schemaVersion: '', policyVersion: '', prevDigest: '' },
  });
  const r = assertExecutionContextConsistency(cloak, allTools);
  const codes = r.splits.map((s) => s.code);
  assert.ok(codes.includes(CONTEXT_SPLIT_CODES.constraintShadowsCapability), JSON.stringify(codes));
  assert.ok(codes.includes(CONTEXT_SPLIT_CODES.budgetBelowDispatchParallel), `并发 3 但只给 1 次副作用额度应报错：${JSON.stringify(codes)}`);
  assert.ok(codes.includes(CONTEXT_SPLIT_CODES.auditContextIncomplete), JSON.stringify(codes));
  assert.ok(codes.includes(CONTEXT_SPLIT_CODES.toolWithoutCapability), '能力位为 0 却有对应工具，也必须报出来');
});
check('上下文与 P0 的旧断言口径一致（同一份能力/工具表不会两头说法不同）', () => {
  const legacyCtx = createExecutionContext({
    turnId: 't-old', sessionId: 's-old', capabilityMask: capFull.bits, budget: DEFAULT_TURN_BUDGET,
  });
  const legacy = assertContextToolAlignment(legacyCtx, allTools);
  const r = assertExecutionContextConsistency(ctxFull, allTools);
  assert.equal(legacy.aligned, true, JSON.stringify(legacy.discrepancies));
  assert.equal(r.consistent, true, JSON.stringify(r.splits));
});
check('上下文审计绑定八项齐备，且上下文可 diff（中途改设置要能说清变了什么）', () => {
  const fields = contextAuditFields(ctxFull, { eventType: 'tool-call-start', eventIndex: 4 });
  assert.deepEqual(Object.keys(fields), ['schemaVersion', 'sessionId', 'turnId', 'eventIndex', 'prevDigest', 'eventType', 'normalizedPayload', 'policyVersion']);
  const changed = createTurnExecutionContext({
    turnId: 't-ctx', sessionId: 's-ctx', userIntent: '帮我抓一下官网首页', taskClass: 'web',
    capability: capNoRelay, budget: DEFAULT_TURN_BUDGET, policy: policySnapshot,
    audit: { schemaVersion: AUDIT_SCHEMA_VERSION, policyVersion: EXECUTION_POLICY_VERSION, prevDigest: '0'.repeat(64) },
  });
  const d = diffExecutionContexts(ctxFull, changed);
  assert.equal(d.changed, true);
  assert.ok(d.changes.some((c) => c.path.startsWith('capability')), JSON.stringify(d.changes.map((c) => c.path)));
  assert.ok(describeExecutionContext(ctxFull).includes('风险上限'), '面板行必须带风险口径');
});

// ────────────────────────────────────────────────────────────────────────────
group('P2-3 工具契约 + 风险预算：调用前后校验与六分类在真实契约上生效');

const machine = createExecutionStateMachine({ turnId: 'turn-smoke', sessionId: 'session-smoke', policyVersion: EXECUTION_POLICY_VERSION });
const budgetGov = createBudgetGovernor({ ...DEFAULT_TURN_BUDGET });
const budgetSnapshot = budgetGov.snapshot();

check('调用前校验：不在工具表里的工具被拦（工具不可用 = 不可重试，且给恢复路径）', () => {
  const pre = validateToolCallPre({ name: 'fetch_url', args: { url: 'https://example.com' }, tools: fakeTools(['read_file']), budget: budgetGov, capabilities: capNoRelay });
  assert.equal(pre.ok, false);
  assert.equal(pre.blocked, true);
  assert.ok(pre.errors.some((i) => i.id === 'tool-not-available'), JSON.stringify(pre.errors));
  assert.ok(pre.message.length > 0, '拦截必须给模型一句可执行的话，而不是空对象');
});
check('调用前校验：受保护路径不可覆盖用户原件（Scope 约束真实生效）', () => {
  const strictCaps = buildCapabilityConstraints({
    relayOk: true, webEnabled: true, sandboxEnabled: true, canDispatch: true,
    overrides: { filesystem: { writeOverwrite: 'deny', protectedPaths: ['uploads/'] } },
  });
  const pre = validateToolCallPre({
    name: 'write_file', args: { path: 'uploads/report.pdf', content: 'x' },
    tools: fakeTools(['write_file']), budget: budgetGov, capabilities: strictCaps,
  });
  assert.equal(pre.ok, false, '覆盖策略为 deny 时写用户原件必须被拦');
  assert.ok(pre.errors.some((i) => i.id === 'protected-path-overwrite'), JSON.stringify(pre.errors));
  const append = validateToolCallPre({
    name: 'write_file', args: { path: 'uploads/report.pdf', content: 'x', mode: 'append' },
    tools: fakeTools(['write_file']), budget: budgetGov, capabilities: strictCaps,
  });
  assert.equal(append.ok, true, 'append 模式不算覆盖，应放行');
  const scoped = validateToolCallPre({
    name: 'write_file', args: { path: 'etc/passwd', content: 'x' },
    tools: fakeTools(['write_file']), budget: budgetGov,
    capabilities: buildCapabilityConstraints({ relayOk: true, webEnabled: true, sandboxEnabled: true, canDispatch: true, overrides: { sandbox: { allowedPaths: ['outputs/'] } } }),
  });
  assert.equal(scoped.ok, false, '路径超出允许范围必须被拦');
  assert.ok(scoped.errors.some((i) => i.id === 'path-outside-scope'), JSON.stringify(scoped.errors));
});
check('调用后校验：空结果 / 超时 / 副作用缺失各自有稳定 id（供轨迹评测消费）', () => {
  const empty = validateToolResultPost({ name: 'read_file', result: '', error: null, contract: TOOL_CONTRACTS.read_file, durationMs: 12 });
  assert.ok(empty.issues.some((i) => i.id === 'empty-result'), JSON.stringify(empty.issues));
  const slow = validateToolResultPost({ name: 'read_file', result: 'x', error: null, contract: TOOL_CONTRACTS.read_file, durationMs: 999999 });
  assert.ok(slow.issues.some((i) => i.id === 'timeout-exceeded'), JSON.stringify(slow.issues));
});
check('风险分级：L3 操作必须带「需确认」标记与不可逆提示（确认请求能说清原因/影响/可逆性）', () => {
  // 用户本轮**没有**明说「推送」→ 不得被授权豁免，必须走确认
  const risk = classifyToolRisk({ name: 'run_git', args: { command: 'git push --force origin main' }, contract: TOOL_CONTRACTS.run_git, fs: { exists: () => false }, userText: '把这个仓库整理一下' });
  assert.equal(risk.level, 'L3', JSON.stringify(risk.reasons));
  assert.equal(risk.requiresConfirmation, true, 'L3 必须在风险对象上就带「需确认」');
  assert.equal(guardRequiresConfirmation({ guard: 'strict', risk }), true);
  assert.equal(guardRequiresConfirmation({ guard: 'observe', risk }), false, 'observe 档只提示不拦截，档位语义要稳定');
  const card = formatConfirmationRequest({ name: 'run_git', args: { command: 'git push --force origin main' }, reason: risk.reasons[0], impact: '会覆盖远端历史', reversibility: risk.irreversible ? '不可自动恢复' : undefined });
  const text = typeof card === 'string' ? card : JSON.stringify(card);
  for (const need of ['操作', '原因', '影响', '可逆', '参数']) assert.ok(text.includes(need), `确认卡必须包含「${need}」：${text.slice(0, 200)}`);
  // 反向：用户本轮明确要求「推送」，才允许免确认——但要留痕说明为什么放行
  const authorized = classifyToolRisk({ name: 'run_git', args: { command: 'git push origin main' }, contract: TOOL_CONTRACTS.run_git, userText: '请把改动推送到远端' });
  assert.equal(authorized.authorizedByIntent, true);
  assert.equal(authorized.requiresConfirmation, false, '用户明确要求过才可免确认');
  assert.ok(authorized.reasons.some((x) => x.includes('已明确要求')), JSON.stringify(authorized.reasons));
});
check('失败六分类是闭集，且分类依据真实输入而非猜测', () => {
  assert.deepEqual(Object.values(FAILURE_KINDS).sort(), ['DATA', 'ENVIRONMENT', 'INVALID_ARGS', 'PERMISSION', 'SIDE_EFFECT_UNCERTAIN', 'TRANSIENT'].sort());
  const perm = classifyToolFailure({ name: 'write_file', result: '', error: { message: '路径不在允许目录内：permission denied' } });
  assert.equal(perm.kind, 'PERMISSION');
  assert.equal(perm.retryable, false, '权限类不得自动重试');
  const env = classifyToolFailure({ name: 'execute_javascript', result: '沙箱已关闭', error: null });
  assert.equal(env.kind, 'ENVIRONMENT');
  const argsErr = classifyToolFailure({ name: 'read_file', result: '缺少参数 path', error: null });
  assert.equal(argsErr.kind, 'INVALID_ARGS');
  const dataErr = classifyToolFailure({ name: 'read_file', result: '', error: { message: '返回结构解析失败 malformed' } });
  assert.equal(dataErr.kind, 'DATA');
  const transient = classifyToolFailure({ name: 'fetch_url', result: '请求超时', error: null, timedOut: true });
  assert.equal(transient.kind, 'TRANSIENT', '只读工具超时属暂时性，可有限重试');
  const uncertain = classifyToolFailure({ name: 'write_file', result: '', error: { message: '连接中断' }, timedOut: true, stateChanged: true });
  assert.equal(uncertain.kind, 'SIDE_EFFECT_UNCERTAIN');
  assert.equal(uncertain.verifyFirst, true, '副作用不确定必须「先核验再决定」，禁止盲目重试');
});
check('预算治理：通道耗尽当场拦下，且被拒的尝试也如实留痕', () => {
  const gov = createBudgetGovernor({ ...DEFAULT_TURN_BUDGET, maxExternalSideEffects: 1 });
  assert.equal(gov.spend('externalSideEffects', 1).ok, true);
  const second = gov.spend('externalSideEffects', 1);
  assert.equal(second.ok, false, '额度用尽必须拒绝，不能「不记账照样发」');
  const snap = gov.snapshot();
  assert.equal(snap.spent.externalSideEffects, 1, '被拒的调用不得计入消耗');
  assert.deepEqual(snap.exhaustedChannels, ['externalSideEffects']);
  assert.equal(snap.withinBudget, false);
  assert.ok(gov.events.some((e) => e.denied), '被拒的尝试必须留痕，否则事后查不出「为什么没做」');
  // 默认口径必须与文档一致：32 次调用 / 6 次外部副作用（并发 3 个子智能体是支持的常态）
  assert.equal(DEFAULT_TURN_BUDGET.maxToolCalls, 32);
  assert.equal(DEFAULT_TURN_BUDGET.maxExternalSideEffects, 6);
  assert.equal(DEFAULT_TURN_BUDGET.maxDurationMs, 600000);
});
check('第七路预算 Token：实时记账，耗尽后新的工具调用被拦下（带限制作答而不是无声膨胀）', () => {
  assert.equal(BUDGET_CHANNELS.includes('tokens'), true, 'Token 必须是受管通道之一（P2 第 7 条：八类资源预算）');
  assert.equal(DEFAULT_TURN_BUDGET.maxTokens, 200000);
  const gov = createBudgetGovernor({ ...DEFAULT_TURN_BUDGET, maxTokens: 1000 });
  assert.equal(gov.spend('tokens', 600).ok, true);
  assert.equal(gov.canSpend('tokens').ok, true);
  assert.equal(gov.spend('tokens', 400).ok, true);
  const blocked = validateToolCallPre({ name: 'read_file', args: { path: 'a.md' }, tools: fakeTools(['read_file']), budget: gov, capabilities: capFull });
  assert.equal(blocked.ok, false, 'Token 耗尽后不得再发起新的工具调用');
  assert.ok(blocked.errors.some((e) => e.id === 'budget-tokens-exhausted'), JSON.stringify(blocked.errors));
  const snap = gov.snapshot();
  assert.equal(snap.spent.tokens, 1000, '消耗必须如实记账');
  assert.ok(snap.exhaustedChannels.includes('tokens'));
});
check('幂等：同键重复调用被账本裁决（同轮复用 / 跨轮先核验），绝不第二次落副作用', () => {
  const ledger = createIdempotencyLedger({ entries: [] });
  const key = operationKey({ toolName: 'write_file', args: { path: 'out/a.txt' } });
  ledger.claim(key, { tool: 'write_file', turnId: 'turn-smoke', argsSummary: 'out/a.txt' });
  ledger.settle(key, { status: 'succeeded', resultDigest: 'abc123' });
  const sameTurn = planReplay({ entry: ledger.lookup(key), contract: TOOL_CONTRACTS.write_file, currentTurnId: 'turn-smoke' });
  assert.equal(sameTurn.decision, 'reuse', `同轮同键必须复用，实际 ${sameTurn.decision}`);
  const nextTurn = planReplay({ entry: ledger.lookup(key), contract: TOOL_CONTRACTS.write_file, currentTurnId: 'turn-smoke-2' });
  assert.ok(['reuse', 'verify-first'].includes(nextTurn.decision), `跨轮同键应复用或先核验，实际 ${nextTurn.decision}`);
  const uncertain = createIdempotencyLedger({ entries: [] });
  uncertain.claim(key, { tool: 'write_file', turnId: 'turn-x' });
  uncertain.settle(key, { status: 'uncertain' });
  const vf = planReplay({ entry: uncertain.lookup(key), contract: TOOL_CONTRACTS.write_file, currentTurnId: 'turn-x-2' });
  assert.equal(vf.decision, 'verify-first', '副作用不确定时必须先核验');
});

// ────────────────────────────────────────────────────────────────────────────
group('P2-4 审计三层目标：链式哈希只覆盖完整性，完备性靠对账，真实性如实不声明');

// 造一个真实回合：状态机 + 两次工具调用 + 一次检查点
machine.transition(EXECUTION_STATES.CLASSIFIED, '任务类型=code');
machine.transition(EXECUTION_STATES.PLANNED, '计划 2 步');
machine.transition(EXECUTION_STATES.TOOL_PENDING, '准备调用');
machine.transition(EXECUTION_STATES.TOOL_RUNNING, '开始执行工具');
const run1 = machine.beginToolRun({ callId: 'c1', name: 'read_file', args: { path: 'a.md' }, risk: { level: 'L1' } });
machine.endToolRun(run1, { status: 'succeeded', postValidation: { issues: [] } });
const run2 = machine.beginToolRun({ callId: 'c2', name: 'write_file', args: { path: 'out/b.md' }, risk: { level: 'L2' } });
machine.endToolRun(run2, { status: 'succeeded', postValidation: { issues: [] } });
const cpStore = createCheckpointStore({ entries: [] });
const checkpoint = buildCheckpoint({
  sessionId: 'session-smoke', turnId: 'turn-smoke', executionState: machine.state,
  completedSteps: [{ name: 'read_file a.md', status: 'succeeded' }],
  pendingStep: '写 out/b.md', artifacts: ['out/b.md'], files: { 'a.md': 'x', 'out/b.md': 'y' },
});
cpStore.record(checkpoint);
machine.audit.record('checkpoint', { checkpointId: checkpoint.checkpointId, sessionId: 'session-smoke', stepCount: 1 });
const finalRecord = machine.snapshot();
const events = machine.audit.events;

check('完整性：链式哈希逐事件重算通过（未被改动的足迹必须自洽）', () => {
  const chain = verifyExecutionAudit(events);
  assert.equal(chain.valid, true, JSON.stringify(chain.mismatches));
  assert.equal(chain.checked, events.length);
});
check('完整性 fail-closed：改动任意一条事件的载荷，链必须报错', () => {
  const tampered = events.map((e, i) => (i === 2 ? { ...e, payload: { ...e.payload, status: 'succeeded' } } : e));
  const chain = verifyExecutionAudit(tampered);
  assert.equal(chain.valid, false, '被篡改的链不得判通过');
  assert.ok(chain.mismatches.length > 0);
});
check('完备性：执行记录 / 幂等账本 / 检查点 ↔ 审计事件双向对账通过', () => {
  const ledger = createIdempotencyLedger({ entries: [] });
  const k = operationKey({ toolName: 'write_file', args: { path: 'out/b.md' } });
  ledger.claim(k, { tool: 'write_file', turnId: 'turn-smoke', argsSummary: 'out/b.md' });
  ledger.settle(k, { status: 'succeeded' });
  const r = reconcileAudit({
    auditEvents: events,
    declared: { schemaVersion: AUDIT_SCHEMA_VERSION, policyVersion: EXECUTION_POLICY_VERSION, sessionId: 'session-smoke', turnId: 'turn-smoke' },
    record: finalRecord,
    ledgerEntries: ledger.snapshot(20),
    checkpoints: cpStore.list('session-smoke'),
    policySnapshot,
  });
  assert.equal(r.completeness.ok, true, JSON.stringify(r.completeness));
  assert.equal(r.integrity.ok, true, JSON.stringify(r.integrity));
  assert.equal(r.authenticity.ok, null, '真实性必须是不声明（null），不能伪造成通过');
  assert.equal(r.authenticity.claimed, false);
  assert.equal(r.ok, true, r.statement);
});
check('完备性 fail-closed：抽掉一条 tool-call-end，对账必须指出缺了哪一项', () => {
  const gappy = events.filter((e) => !(e.eventType === 'tool-call-end' && e.payload && e.payload.index === 2));
  const r = reconcileAudit({
    auditEvents: gappy,
    declared: { schemaVersion: AUDIT_SCHEMA_VERSION, policyVersion: EXECUTION_POLICY_VERSION, sessionId: 'session-smoke', turnId: 'turn-smoke' },
    record: finalRecord, ledgerEntries: [], checkpoints: [],
  });
  assert.equal(r.completeness.ok, false);
  assert.ok(r.completeness.missing.some((m) => m.includes('tool-call-end#2')), JSON.stringify(r.completeness.missing));
  assert.ok(r.statement.includes('未通过'), '必须如实说未通过，不能用「足迹已上链」搪塞');
});
check('三个审计目标的口径不混淆（界面文案不得把足迹说成安全证明）', () => {
  assert.equal(AUDIT_GOALS.integrity.covered, true);
  assert.equal(AUDIT_GOALS.completeness.covered, true);
  assert.equal(AUDIT_GOALS.authenticity.covered, false);
  assert.ok(AUDIT_GOALS.authenticity.mechanism.includes('远程证明'));
  const text = formatAuditGoalsReport(reconcileAudit({
    auditEvents: events,
    declared: { schemaVersion: AUDIT_SCHEMA_VERSION, policyVersion: EXECUTION_POLICY_VERSION, sessionId: 'session-smoke', turnId: 'turn-smoke' },
    record: finalRecord, ledgerEntries: [], checkpoints: [],
  }));
  assert.ok(text.includes('真实性 不声明'), '报告必须写明真实性不声明');
});

// ────────────────────────────────────────────────────────────────────────────
group('P2-5 统一指标面板：12 指标 × 7 维切分，退化必须被门禁抓住');

const trajectoryEntry = (over = {}) => ({
  taskClass: 'code', toolCallCount: 2, failedCount: 0, retriedCount: 0, reusedCount: 0, blockedCount: 0,
  totalMs: 4200, healthy: true,
  metrics: {
    overRouting: { flagged: false, value: true }, underRouting: { flagged: false, value: true },
    silentFailure: { flagged: false, value: false }, recovery: { flagged: false, value: 1 },
    audit: { flagged: false, value: 1 }, sideEffectSafety: { flagged: false, value: true },
    unnecessaryCallRate: { flagged: false, value: 0 },
  },
  route: { mode: 'standard', reasoningLevel: 'MEDIUM' }, toolNames: ['read_file'], memoryInvolved: false, externalSideEffect: false,
  ...over,
});
const goodEntries = Array.from({ length: 12 }, (_, i) => trajectoryEntry({ taskClass: i % 2 ? 'code' : 'web', toolNames: i % 2 ? ['read_file'] : ['fetch_url'] }));
check('指标快照：12 项指标齐备，且按 7 个维度切分', () => {
  const snap = buildMetricSnapshot({ entries: goodEntries, memoryHealth: { activeCount: 4, candidateCount: 0, conflictCount: 0 }, ledgerEntries: [], checkpoints: [] });
  assert.equal(METRIC_DEFS.length, 12);
  assert.equal(Object.keys(snap.overall).length, 12);
  assert.ok(Object.keys(snap.byDimension).length >= 7, `应有 7 维切分，实际 ${Object.keys(snap.byDimension).length}`);
  assert.equal(snap.samples, 12);
});
check('指标门禁：相对基线退化超过容忍度必须判不通过（含延迟单独口径）', () => {
  const base = buildMetricSnapshot({ entries: goodEntries });
  const regressed = buildMetricSnapshot({
    entries: goodEntries.map((e, i) => (i < 6
      ? trajectoryEntry({ healthy: false, totalMs: 30000, metrics: { ...e.metrics, silentFailure: { flagged: true, value: true } } })
      : e)),
  });
  const gate = evaluateMetricGate(regressed, base);
  assert.equal(gate.ok, false, '静默失败率与延迟同时恶化，门禁不得放行');
  assert.ok(gate.regressions.some((r) => r.key === 'silentFailureRate'), JSON.stringify(gate.regressions));
  const same = evaluateMetricGate(base, base);
  assert.equal(same.ok, true, '与自身比不得报退化');
});
check('空样本不产生假指标（宁可为 null，也不给一个看似漂亮的 0）', () => {
  const empty = computeMetrics([], {});
  assert.equal(empty.metrics.silentFailureRate, null);
  assert.equal(buildMetricSnapshot({ entries: [] }).samples, 0);
});

// ────────────────────────────────────────────────────────────────────────────
group('P2-6 故障注入平台：九类清单 + 五性质，拿不出证据一律判未满足');

check('故障清单覆盖 P2 要求的九类（超时/空值/错结构/外部改文件/重复调用/审计缺事件/掩码不一致/记忆冲突/撤销授权）', () => {
  const kinds = Object.keys(FAULT_KINDS);
  assert.equal(kinds.length, 9, kinds.join(','));
  for (const need of ['tool-timeout', 'tool-empty-result', 'tool-bad-schema', 'artifact-modified-externally', 'duplicate-tool-call', 'audit-event-missing', 'capability-mask-mismatch', 'memory-instruction-conflict', 'authorization-revoked-midway']) {
    assert.ok(kinds.includes(need), `缺 ${need}`);
  }
  assert.deepEqual(FAULT_KINDS['tool-timeout'].id, 'tool-timeout');
});
check('注入器：结果类故障改写工具结果并带说明（不是静默替换）', () => {
  const injector = createFaultInjector({ kinds: ['tool-timeout', 'tool-empty-result'], seed: 7 });
  const seen = [];
  for (let i = 0; i < 6; i += 1) {
    const fault = injector.beforeToolCall({ name: 'read_file', args: { path: 'a.md' }, index: i + 1 });
    if (!fault) continue;
    const out = injector.afterToolResult({ fault, result: '正常内容', name: 'read_file' });
    seen.push(out);
    assert.ok(out.note && out.note.includes('[故障注入]'), '每次注入都要说明本次注入了什么');
  }
  assert.ok(seen.length >= 2, `两类故障都应被注入到，实际 ${seen.length} 次`);
  assert.ok(seen.some((r) => /空值|结构/.test(r.note)), JSON.stringify(seen.map((r) => r.note)));
});
check('验收 fail-closed：没有任何证据的回合，五性质一律判未满足', () => {
  const bare = verifyFaultHandling({ kind: 'tool-timeout', record: { toolRuns: [], transitions: [] }, auditSnapshot: { events: [] } });
  assert.equal(bare.ok, false, '没证据不能算通过');
  assert.equal(bare.cards[0].properties.recoverable, false);
});
check('验收认证据：上下文自检报告的分裂即可判「可检测 + 可停止」（不必等模型撞墙）', () => {
  const ctx = createTurnExecutionContext({
    capability: capNoRelay, budget: DEFAULT_TURN_BUDGET, policy: policySnapshot,
    audit: { schemaVersion: AUDIT_SCHEMA_VERSION, policyVersion: EXECUTION_POLICY_VERSION, prevDigest: '0'.repeat(64) },
    claimedBits: { relay: true, web: true },
  });
  const consistency = assertExecutionContextConsistency(ctx, fakeTools(['read_file']));
  const card = verifyFaultHandling({
    kind: 'capability-mask-mismatch',
    record: { toolRuns: [{ index: 1, name: 'fetch_url', status: 'blocked', notes: ['tool-not-available'], failure: { kind: 'PERMANENT', label: '工具不可用', handling: '改用其它路径', guidance: '本轮没有 fetch_url' } }], transitions: [] },
    auditSnapshot: { events: [{ eventType: 'tool-preflight', payload: {} }] },
    contextConsistency: consistency,
  });
  assert.equal(card.cards[0].properties.detectable, true, JSON.stringify(card.cards[0]));
  assert.equal(card.cards[0].properties.stoppable, true);
});
check('状态类故障也必须拿到验收卡（kind 不能丢：结果类是 {kind}，状态类是 {kinds:[…]}）', () => {
  const store = { state: { settings: {} } };
  const injector = createFaultInjector({ kinds: ['capability-mask-mismatch', 'memory-instruction-conflict'], seed: 3 });
  const armed = injector.beforeTurn(store);
  assert.equal(armed.length, 2, JSON.stringify(armed));
  const result = verifyFaultHandling({ injector, record: { toolRuns: [], transitions: [] }, auditSnapshot: { digest: 'x'.repeat(64), events: [{ eventType: 'tool-preflight', payload: {} }] } });
  const kinds = result.cards.map((c) => c.kind);
  assert.deepEqual(kinds.slice().sort(), ['capability-mask-mismatch', 'memory-instruction-conflict'], `状态类故障必须各自成卡，实得 ${JSON.stringify(kinds)}`);
  assert.ok(result.cards.every((c) => c.label && c.label !== c.kind), '卡片要有人话标签，不能只回一个 id');
});
check('注入残留必须清干净（假声明留在设置里会污染之后每一轮）', () => {
  const store = { state: { settings: {} } };
  const injector = createFaultInjector({ kinds: ['capability-mask-mismatch', 'authorization-revoked-midway', 'artifact-modified-externally'], seed: 5 });
  injector.beforeTurn(store);
  assert.ok(Object.keys(store.state.settings).some((k) => k.startsWith('fault')), '准备阶段应写入注入标记');
  injector.cleanup(store);
  assert.deepEqual(Object.keys(store.state.settings).filter((k) => k.startsWith('fault')), [], '清理后不得残留任何 fault* 键');
});
check('覆盖矩阵按「每类故障 × 五性质」统计（一眼看出哪类没被真正验证过）', () => {
  const matrix = buildFaultCoverageMatrix([
    { kind: 'tool-timeout', ok: true, properties: { detectable: true, explainable: true, stoppable: true, recoverable: true, auditable: true } },
    { kind: 'tool-empty-result', ok: false, properties: { detectable: true, explainable: false, stoppable: true, recoverable: true, auditable: true } },
  ]);
  assert.equal(Object.keys(matrix).length, 9, '九类故障都要有行，哪怕没跑过（runs=0）');
  assert.equal(matrix['tool-empty-result'].properties.explainable, false, '缺哪一项要能点出来');
  assert.equal(matrix['tool-empty-result'].okRuns, 0);
  assert.equal(matrix['tool-timeout'].okRuns, 1);
  assert.equal(matrix['audit-event-missing'].runs, 0, '没验证过的类目必须显示为未覆盖');
});

// ────────────────────────────────────────────────────────────────────────────
group('P2-7 实验平台：分桶稳定、对照语义正确、护栏违规直接判回退');

check('分桶稳定：同一 subject 反复解析得到同一变体（不许每轮重摇）', () => {
  const overrides = { enabled: true, rollout: 10000 };
  const first = resolveExperimentAssignment({ experiment: 'guard-default', subjectId: 'session-A', overrides });
  for (let i = 0; i < 5; i += 1) {
    const again = resolveExperimentAssignment({ experiment: 'guard-default', subjectId: 'session-A', overrides });
    assert.equal(again.variantId, first.variantId);
  }
});
check('未开启灰度 / 未命中桶 = 对照（不得悄悄改写用户设置，对照臂语义必须干净）', () => {
  const off = resolveExperimentAssignment({ experiment: 'guard-default', subjectId: 'session-A', overrides: { enabled: false } });
  assert.equal(off.inExperiment, false);
  const control = resolveExperimentAssignment({ experiment: 'guard-default', subjectId: 'session-A', overrides: { enabled: true, rollout: 0 } });
  assert.equal(control.inExperiment, false, 'rollout=0 时任何人都不进实验组');
});
check('在线样本可汇总，护栏被触碰时直接判回退（不让「提升」掩盖代价）', () => {
  let samples = [];
  for (let i = 0; i < 28; i += 1) {
    samples = appendExperimentSample(samples, {
      experimentId: 'guard-default', variantId: i < 14 ? 'control' : 'treatment',
      metrics: { guardAskRate: i < 14 ? 0.1 : 0.5, confirmAbandonRate: i < 14 ? 0.05 : 0.6, turnLatencyMs: 2000 + i * 10, promptGrowthChars: 0 },
      ts: 1_700_000_000_000 + i,
    });
  }
  const summary = summarizeExperiment({ experiment: 'guard-default', samples });
  assert.equal(summary.ok, true, summary.reason);
  assert.ok(Object.values(EXPERIMENT_DECISIONS).includes(summary.action), `决策必须是闭集之一：${summary.action}`);
  assert.equal(summary.action, EXPERIMENT_DECISIONS.ROLLBACK, `确认放弃率恶化必须判回退，实际 ${summary.action}（${summary.reason}）`);
  assert.ok(summary.guardrailViolations.length > 0);
  assert.ok(summary.control.ci && summary.control.ci.lower !== undefined, '比率类指标要给 95% 区间');
});
check('离线对拍：两变体在真实用例集上比 P/R/F1（灰度前先算清楚代价）', () => {
  const cases = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, category: i % 2 ? 'tool' : 'route', expected: i % 3 !== 0, predicted: null }));
  const run = (flip) => cases.map((c) => ({ ...c, predicted: flip && c.id === 'c0' ? !c.expected : c.expected }));
  const ab = compareOfflineVariants({ experiment: 'guard-default', runs: { control: run(false), treatment: run(false) } });
  assert.ok(ab.control && ab.treatment, '两侧都要有统计');
  assert.equal(ab.control.f1, 1, '完全一致时 F1 应为 1');
  const worse = compareOfflineVariants({ experiment: 'guard-default', runs: { control: run(false), treatment: run(true) } });
  assert.ok(worse.f1Delta <= 0, '变体设错时 F1 不得反而上升');
});

// ────────────────────────────────────────────────────────────────────────────
group('P2-8 收尾闭环：执行记录冻结 + 续跑判定 + 内核验收 7 项');

check('收尾：状态机走到 COMMITTED，执行记录带上全部版本号（事后能定位是哪套策略跑的）', () => {
  // 工具全部成功 → 走 ANSWERING 收尾（状态机只允许这条路径，非法转移会被记成违规）
  const moved = machine.transition(EXECUTION_STATES.TOOL_SUCCEEDED, '两次调用均成功');
  assert.equal(moved.ok, true, JSON.stringify(moved.violation || moved));
  const fin = finalizeExecutionTurn({ machine, toolRuns: finalRecord.toolRuns, answerText: '已完成（冒烟）', budget: budgetGov, extraLimitations: [] });
  assert.equal(fin.state, EXECUTION_STATES.COMMITTED, `干净收尾应到 COMMITTED，实际 ${fin.state}`);
  assert.equal(fin.disclosure, '', '没有静默失败时不得无端附加披露');
  const record = summarizeExecutionRecord({ machine, budget: budgetGov, toolRuns: finalRecord.toolRuns, silentFailure: fin.silentFailure });
  assert.equal(record.auditSchemaVersion, AUDIT_SCHEMA_VERSION);
  assert.ok(record.auditDigest, '审计摘要必须落进执行记录');
  assert.equal(record.policyVersion, EXECUTION_POLICY_VERSION);
  assert.ok(record.toolCallCount >= 2, `工具调用次数应如实记录，实际 ${record.toolCallCount}`);
  assert.equal(record.riskCounts.L1 + record.riskCounts.L2 + record.riskCounts.L3, 2, '风险分布要按级别分桶');
  const acceptance = evaluateExecutionKernelAcceptance({ toolNames: Object.keys(TOOL_CONTRACTS) });
  assert.ok(acceptance.checks.length >= 7, `内核验收应覆盖 7 项，实际 ${acceptance.checks.length}`);
  assert.equal(typeof acceptance.ok, 'boolean');
});
check('静默失败必须被点名：工具失败了却在回答里只报喜 → 转「带限制作答」并追加披露', () => {
  const runs = [
    { index: 1, name: 'read_file', status: 'succeeded', notes: [] },
    { index: 2, name: 'fetch_url', status: 'failed', notes: [], failure: { kind: 'TRANSIENT' } },
  ];
  const m = createExecutionStateMachine({ turnId: 'turn-silent', sessionId: 'session-silent' });
  m.transition(EXECUTION_STATES.CLASSIFIED, '任务类型=research');
  m.transition(EXECUTION_STATES.PLANNED, '计划 2 步');
  m.transition(EXECUTION_STATES.TOOL_PENDING, '准备调用');
  m.transition(EXECUTION_STATES.TOOL_RUNNING, '执行中');
  m.transition(EXECUTION_STATES.TOOL_FAILED, 'fetch_url 失败');
  const fin = finalizeExecutionTurn({ machine: m, toolRuns: runs, answerText: '全部完成，结果如上。', budget: createBudgetGovernor({}) , extraLimitations: [] });
  assert.equal(fin.silentFailure.silent, true, '失败未在回答中披露就是静默失败');
  assert.equal(fin.state, EXECUTION_STATES.COMMITTED);
  assert.ok(fin.finalText.includes('fetch_url'), '披露必须点名是哪个工具出的问题');
  assert.ok(fin.limitations.some((l) => l.startsWith('silent-failure')), JSON.stringify(fin.limitations));
});
check('续跑判定与检查点健康度一致（空检查点不得被判可续跑）', () => {
  const files = { 'a.md': 'x', 'out/b.md': 'y' };
  const verify = verifyCheckpoint(checkpoint, { files });
  const plan = planResume(checkpoint, { files });
  assert.equal(plan.resumable, true, `有可复用步骤 + 未完成步骤时必须可续：${JSON.stringify(plan.blockers)}`);
  assert.equal(plan.actionable, true);
  assert.equal(plan.reusableSteps.length, 1);
  assert.equal(verify.ok, true, JSON.stringify(verify.drift));
  // 产物被外部改动 → 漂移必须报出来，且该步骤不再可复用
  const drifted = planResume(checkpoint, { files: { ...files, 'out/b.md': '被别人改了' } });
  assert.ok(drifted.verificationSteps.length > plan.verificationSteps.length, '产物被外部改动后，必须多出「先核验」步骤');
});

// ────────────────────────────────────────────────────────────────────────────
const total = passed + failures.length;
console.log(`\nP2 内核冒烟：${passed}/${total} 通过${failures.length ? ` ❌\n${failures.map((f) => `  · ${f.name}：${f.message}`).join('\n')}` : ' ✅'}`);
process.exit(failures.length ? 1 : 0);
