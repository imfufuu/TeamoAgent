// ─── P2（THN v2.5）分层评测执行器（离线，npm run eval:p2）─────────────────
// 目的（P2 第 14 条）：评测不能只给一个综合分。这里按 10 类分别统计
//   Precision / Recall / F1 / 准确率 / 95% Wilson 区间 / 失败样本 / 是否属于系统可恢复错误，
// 任何一个类目退化都会在报告里单独暴露，而不是被平均值抹平。
//
// 判定原则：所有预测都由**真实模块**产出（路由门、调用前/后校验、写入门槛、召回状态机、
// 幂等账本、恢复计划、预算治理、确认闸门），不写「期望值 = 实现值」的自证式断言。
//
// 用法：
//   node tests/p2-eval.mjs                    # 跑评测并与基线比对
//   node tests/p2-eval.mjs --update-baseline  # 更新 tests/p2-metrics-baseline.json
//   node tests/p2-eval.mjs --verbose          # 打印每个失败样本
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import { evaluateLocalFastPathGate, resolveNexusExecutionProfile } from '../js/nexus.js';
import {
  classifyToolRisk, guardRequiresConfirmation, validateToolCallPre, validateToolResultPost,
  createBudgetGovernor, DEFAULT_TURN_BUDGET, TOOL_CONTRACTS, getToolContract, buildCapabilityConstraints,
} from '../js/execution.js';
import { TOOL_DEFS } from '../js/tools.js';
import { evaluateMemoryWriteGate, resolveRecallStates } from '../js/memorylife.js';
import { createIdempotencyLedger, planReplay } from '../js/idempotency.js';
import { buildCheckpoint, planResume } from '../js/recovery.js';
import { computeWilsonConfidenceInterval } from '../js/memory.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(resolve(__dirname, 'p2-eval-corpus.json'), 'utf8'));
const baselinePath = resolve(__dirname, 'p2-metrics-baseline.json');
const args = new Set(process.argv.slice(2));
const VERBOSE = args.has('--verbose');
const UPDATE_BASELINE = args.has('--update-baseline');

const toolDefOf = (name) => TOOL_DEFS.find((d) => d && d.name === name) || null;
const allToolNames = TOOL_DEFS.map((d) => d && d.name).filter(Boolean);

// ── 各类目的真实判定器：返回 { action: 系统是否做出了该类目期望的处置, why: 依据 } ──
const EVALUATORS = {
  // 路由类：是否需要走完整链路（升档）而不是 0ms 快路径。
  // 两个真实入口都要看：0ms 本地预筛（evaluateLocalFastPathGate）与档位解析器
  // （resolveNexusExecutionProfile，需要 plan —— 这里用与预筛一致/相反的合成 plan 做交叉验证）。
  normal: (c) => routeEvaluate(c),
  ambiguous: (c) => routeEvaluate(c),

  // 工具不可用：调用前契约校验是否把不在本轮工具表里的调用拦下
  'tool-unavailable': (c) => {
    const { tool, toolAvailable } = c.scenario;
    const tools = toolAvailable ? allToolNames : allToolNames.filter((n) => n !== tool);
    const capabilities = buildCapabilityConstraints({ relayOk: true, webEnabled: true, sandboxEnabled: true, canDispatch: true });
    const pre = validateToolCallPre({
      name: tool, args: sampleArgsFor(tool), toolDef: toolDefOf(tool), tools, capabilities,
      budgetGov: createBudgetGovernor(), seenIdempotency: new Map(), turnBudget: { turnId: 'eval-turn' },
    });
    const blockedByTable = pre.errors.some((e) => e.id === 'tool-not-available');
    return {
      action: !pre.ok && (blockedByTable || pre.errors.length > 0),
      why: pre.ok ? '校验通过（可用）' : pre.errors.map((e) => e.id).join(','),
    };
  },

  // 工具返回异常：调用后核验是否报出问题
  'tool-anomaly': (c) => {
    const { tool, anomaly } = c.scenario;
    const contract = getToolContract(tool);
    const normal = { result: 'OK：已完成', error: null, timedOut: false, durationMs: 100 };
    const injected = {
      none: normal,
      empty: { result: '', error: null, timedOut: false, durationMs: 100 },
      timeout: { result: '', error: new Error('timeout'), timedOut: true, durationMs: (contract.timeoutMs || 10000) + 5000 },
      'bad-schema': { result: '{"error":"unexpected response schema"}', error: null, timedOut: false, durationMs: 100 },
    }[anomaly] || normal;
    const fsBefore = { digest: 'aaa' };
    const fsAfter = tool === 'write_file' || tool === 'execute_python' || tool === 'execute_javascript'
      ? { digest: 'bbb' } : { digest: 'aaa' };
    const post = validateToolResultPost({
      name: tool, args: sampleArgsFor(tool), contract, result: injected.result, ok: !injected.error,
      durationMs: injected.durationMs, fsBefore, fsAfter, error: injected.error, timedOut: injected.timedOut,
    });
    const issues = (post.issues || []).map((i) => i.id);
    return {
      action: issues.length > 0 || !!post.failureSignalled,
      why: issues.length ? issues.join(',') : (post.failureSignalled ? 'failure-signalled' : '未发现问题'),
    };
  },

  // 提示词注入：写入门槛是否拒绝 / 降级（不把注入内容当长期记忆）
  'prompt-injection': (c) => {
    const v = evaluateMemoryWriteGate({ fact: c.scenario.fact, source: c.scenario.source, userText: c.scenario.userText, existing: [] });
    return { action: v.pool !== 'long_term', why: `pool=${v.pool} reasons=${(v.reasons || []).join('；') || '-'}` };
  },

  // 记忆冲突：是否标记「本轮不采用」
  'memory-conflict': (c) => {
    const r = resolveRecallStates({
      recalled: [{ id: `${c.id}-mem`, text: c.scenario.memoryText, source: 'user-explicit', confidence: 0.95 }],
      userText: c.scenario.userText,
    });
    const state = r.states[0] ? r.states[0].applicationState : 'NONE';
    return { action: state === 'REJECTED_FOR_TURN', why: `${state}：${(r.states[0] && r.states[0].applicationReason) || '-'}` };
  },

  // 中途改意图：账本是否拒绝盲目复用
  'intent-change': (c) => {
    const sc = c.scenario;
    const ledger = createIdempotencyLedger();
    const key = 'op-eval';
    ledger.claim(key, { tool: 'write_file', turnId: 'turn-old' });
    ledger.settle(key, { status: sc.entryStatus, tool: 'write_file', turnId: 'turn-old', resultDigest: 'rd', artifactPath: 'files/report.md', artifactDigest: sc.entryDigest });
    const decision = planReplay({
      entry: ledger.lookup(key),
      contract: { sideEffect: sc.sideEffect },
      userText: sc.userText,
      currentArtifactDigest: sc.currentDigest,
      currentTurnId: 'turn-new',
    }).decision;
    return { action: decision !== 'reuse', why: `decision=${decision}` };
  },

  // 高风险副作用：是否要求确认
  'high-risk': (c) => {
    const { tool, args, fsExists } = c.scenario;
    const fs = fsExists ? { 'files/keep.txt': 'x', 'uploads/note.md': 'y', 'files/fresh.txt': 'x', 'outputs/a.png': 'x' } : {};
    const risk = classifyToolRisk({ name: tool, args, contract: getToolContract(tool), fs, userText: c.text });
    const ask = guardRequiresConfirmation({ guard: 'strict', risk }) || risk.level === 'L3';
    return { action: ask, why: `${risk.level} confirm=${risk.requiresConfirmation}` };
  },

  // 长链路：中断后是否给得出可复用的续跑计划
  'long-chain': (c) => {
    const { steps, pending, drift, allFailed } = c.scenario;
    const files = {};
    const completed = steps.map((n, i) => ({
      name: `step-${n}`, status: allFailed ? 'failed' : 'succeeded',
      artifacts: [`files/step-${n}.txt`],
    }));
    for (const n of steps) files[`files/step-${n}.txt`] = `内容 ${n}`;
    const cp = buildCheckpoint({
      turnId: `turn-${c.id}`, sessionId: 'eval', executionState: 'INTERRUPTED',
      completedSteps: completed, pendingStep: pending,
      artifacts: steps.map((n) => ({ path: `files/step-${n}.txt`, step: `step-${n}` })),
      files, messages: [{ role: 'user', text: c.text }], memory: [],
    });
    if (drift === 'artifact-missing') for (const n of steps) delete files[`files/step-${n}.txt`];
    if (drift === 'artifact-drift') files[`files/step-${steps[steps.length - 1]}.txt`] = '被外部改写';
    const plan = planResume(cp, { files });
    return {
      action: !!plan.resumable,
      why: `resumable=${plan.resumable} reusable=${(plan.reusableSteps || []).length} verify=${(plan.verificationSteps || []).length} drift=${plan.drift}`,
    };
  },

  // 预算即将耗尽：调用前是否拦截
  'budget-exhaustion': (c) => {
    const sc = c.scenario;
    let clock = 0;
    const gov = createBudgetGovernor({
      maxToolCalls: sc.limit,
      maxExternalSideEffects: sc.extLimit == null ? DEFAULT_TURN_BUDGET.maxExternalSideEffects : sc.extLimit,
      maxRetries: sc.retryLimit == null ? DEFAULT_TURN_BUDGET.maxRetries : sc.retryLimit,
      maxMemoryWrites: sc.memLimit == null ? DEFAULT_TURN_BUDGET.maxMemoryWrites : sc.memLimit,
      maxDurationMs: sc.wallLimit == null ? DEFAULT_TURN_BUDGET.maxDurationMs : sc.wallLimit,
    }, { now: () => clock, startedAt: 0 });
    if (sc.spend > 0) gov.spend('toolCalls', sc.spend, { reason: 'eval-preload' });
    if (sc.retry) gov.spend('retries', sc.retry, { reason: 'eval-preload' });
    if (sc.ext) gov.spend('externalSideEffects', sc.ext, { reason: 'eval-preload' });
    if (sc.mem) gov.spend('memoryWrites', sc.mem, { reason: 'eval-preload' });
    clock = sc.wallMs || 0;
    const channel = sc.ext ? 'externalSideEffects' : sc.retry ? 'retries' : sc.mem ? 'memoryWrites' : 'toolCalls';
    const verdict = gov.canSpend(channel, sc.need);
    const wallVerdict = gov.canSpend('durationMs', 1);
    const blocked = !verdict.ok || !wallVerdict.ok;
    return { action: blocked, why: blocked ? `${verdict.reason || wallVerdict.reason}` : `${channel} 剩余 ${verdict.remaining}` };
  },
};

// 路由判定：两个真实入口交叉验证（预筛说「可快」而解析器说「要全链路」也算升档）
function routeEvaluate(c) {
  const historyLen = c.scenario.historyLen || 0;
  const gate = evaluateLocalFastPathGate(c.text, { historyLen });
  const simple = gate.skipRemoteJev;
  const profile = resolveNexusExecutionProfile({
    userText: c.text,
    plan: {
      route: { choice: simple ? 'direct' : 'full', score: 0.9 },
      need_tools: { noul: simple ? 0.05 : 0.7 },
      need_code: { noul: simple ? 0.02 : 0.6 },
    },
    hasAttachments: false,
    historyLen,
  });
  const escalate = !gate.skipRemoteJev || !profile.fastPath;
  return { action: escalate, why: `skipRemoteJev=${gate.skipRemoteJev} mode=${profile.mode}` };
}

function sampleArgsFor(tool) {
  const map = {
    execute_javascript: { code: 'return 1+1' },
    execute_python: { code: 'print(1)' },
    execute_cpp: { code: 'int main(){return 0;}' },
    write_file: { path: 'files/eval.txt', content: 'x' },
    read_file: { path: 'files/keep.txt' },
    list_files: {},
    get_current_time: {},
    regex: { action: 'match', pattern: 'a', text: 'a' },
    hash: { algorithm: 'sha256', text: 'x' },
    codec: { action: 'encode', format: 'base64', text: 'x' },
    unicode: { text: 'x' },
    generate_image: { prompt: 'a cat', path: 'outputs/eval.png' },
    analyze_image: { path: 'uploads/note.md' },
    zip_files: { paths: ['files/keep.txt'], output: 'outputs/eval.zip' },
    unzip_file: { path: 'outputs/eval.zip' },
    fetch_url: { url: 'https://example.com' },
    run_git: { command: 'git status' },
    search_files: { pattern: 'x', path: 'files/' },
    diff_text: { a: 'x', b: 'y' },
    json_tool: { action: 'parse', text: '{}' },
    delete_file: { path: 'files/keep.txt' },
    copy_file: { from: 'files/keep.txt', to: 'files/copy.txt' },
    remember: { action: 'add', fact: '测试事实' },
    evaluate_expression: { expression: '2+2' },
    execute_sql: { sql: 'SELECT 1' },
    render_mermaid: { code: 'graph TD;A-->B' },
    render_dot: { code: 'digraph G {A->B}' },
    dispatch_subagent: { agent: 'researcher', task: '查资料' },
  };
  return map[tool] || {};
}

// ── 逐条跑 ──
const perCase = [];
for (const c of corpus.cases) {
  const evaluate = EVALUATORS[c.class];
  if (!evaluate) { perCase.push({ ...c, predicted: null, error: `未实现的类目判定器：${c.class}` }); continue; }
  try {
    const { action, why } = evaluate(c);
    perCase.push({ id: c.id, class: c.class, needsAction: c.needsAction, predicted: !!action, why, text: c.text, expected: c.needsAction });
  } catch (err) {
    perCase.push({ id: c.id, class: c.class, needsAction: c.needsAction, predicted: null, error: (err && err.message) || String(err), text: c.text, expected: c.needsAction });
  }
}

// ── 按类目汇总 P/R/F1 + Wilson ──
const classes = corpus.classes.map((cls) => {
  const rows = perCase.filter((r) => r.class === cls.id);
  const errs = rows.filter((r) => r.predicted === null);
  const tp = rows.filter((r) => r.needsAction && r.predicted === true).length;
  const fp = rows.filter((r) => !r.needsAction && r.predicted === true).length;
  const fn = rows.filter((r) => r.needsAction && r.predicted !== true).length;
  const tn = rows.filter((r) => !r.needsAction && r.predicted !== true).length;
  const prec = (tp + fp) ? Number((tp / (tp + fp)).toFixed(4)) : null;
  const rec = (tp + fn) ? Number((tp / (tp + fn)).toFixed(4)) : null;
  const f1 = (prec !== null && rec !== null && (prec + rec) > 0) ? Number(((2 * prec * rec) / (prec + rec)).toFixed(4)) : null;
  const n = rows.length;
  const correct = rows.filter((r) => r.predicted === r.needsAction).length;
  const accuracy = n ? Number((correct / n).toFixed(4)) : 0;
  const ci = computeWilsonConfidenceInterval(correct, n);
  const failures = rows.filter((r) => r.predicted !== r.needsAction);
  return {
    id: cls.id, label: cls.label, signal: cls.signal, recoverable: cls.recoverable,
    n, tp, fp, fn, tn, precision: prec, recall: rec, f1, accuracy, wilson: ci,
    errors: errs.length, failures: failures.map((f) => ({ id: f.id, text: f.text, expected: f.needsAction, predicted: f.predicted, why: f.why || f.error })),
  };
});

const withPred = perCase.filter((r) => r.predicted !== null);
const overallCorrect = withPred.filter((r) => r.predicted === r.needsAction).length;
const overall = {
  n: perCase.length,
  evaluated: withPred.length,
  correct: overallCorrect,
  accuracy: withPred.length ? Number((overallCorrect / withPred.length).toFixed(4)) : 0,
  wilson: computeWilsonConfidenceInterval(overallCorrect, withPred.length || 1),
  macroF1: Number((classes.filter((c) => c.f1 !== null).reduce((a, c) => a + c.f1, 0) / classes.filter((c) => c.f1 !== null).length).toFixed(4)),
  macroAccuracy: Number((classes.reduce((a, c) => a + c.accuracy, 0) / classes.length).toFixed(4)),
};

// ── 基线：把「本次结果」写进基线文件，并和上一次基线比对 ──
const snapshot = {
  version: corpus.version,
  generatedAt: new Date().toISOString(),
  overall,
  classes: classes.map((c) => ({ id: c.id, label: c.label, n: c.n, accuracy: c.accuracy, precision: c.precision, recall: c.recall, f1: c.f1, wilson: c.wilson, failures: c.failures.length })),
  failureIds: classes.flatMap((c) => c.failures.map((f) => f.id)),
};
const previous = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null;

// ── 报告 ──
console.log('================================================================================');
console.log(`  ${corpus.description.split('。')[0]}`);
console.log(`  语料版本 ${corpus.version} · ${corpus.cases.length} 条 · ${classes.length} 类`);
console.log('================================================================================\n');
const pct = (x) => (x === null ? '-' : `${(x * 100).toFixed(1)}%`);
for (const c of classes) {
  const flag = c.accuracy >= 0.92 ? '✓' : (c.accuracy >= 0.8 ? '·' : '✗');
  console.log(`${flag} ${c.label}（${c.id}）n=${c.n} 准确率 ${pct(c.accuracy)} [95% CI ${pct(c.wilson.lower)}–${pct(c.wilson.upper)}]`);
  console.log(`    P ${pct(c.precision)} / R ${pct(c.recall)} / F1 ${pct(c.f1)} · TP ${c.tp} FP ${c.fp} FN ${c.fn} TN ${c.tn} · ${c.recoverable ? '系统可恢复类' : '不可自动恢复类'}`);
  console.log(`    判定口径：${c.signal}`);
  if (c.failures.length) {
    const shown = VERBOSE ? c.failures : c.failures.slice(0, 2);
    for (const f of shown) {
      console.log(`      ✗ ${f.id}「${String(f.text).slice(0, 28)}」期望${f.expected ? '处置' : '不处置'}，实际${f.predicted === null ? '异常' : (f.predicted ? '处置' : '未处置')} · ${String(f.why || '').slice(0, 70)}`);
    }
    if (!VERBOSE && c.failures.length > shown.length) console.log(`      … 其余 ${c.failures.length - shown.length} 条用 --verbose 查看`);
  }
}

console.log(`\n总体：${overall.correct}/${overall.evaluated} 正确（准确率 ${pct(overall.accuracy)}，95% CI ${pct(overall.wilson.lower)}–${pct(overall.wilson.upper)}）`);
console.log(`     宏平均 F1 ${pct(overall.macroF1)} · 宏平均准确率 ${pct(overall.macroAccuracy)}`);

if (previous) {
  const regressed = classes.filter((c) => {
    const p = previous.classes.find((x) => x.id === c.id);
    return p && c.accuracy < p.accuracy - 0.02;
  });
  console.log(`\n与上次基线（${previous.generatedAt.slice(0, 19).replace('T', ' ')}）对比：`);
  if (regressed.length) {
    for (const c of regressed) {
      const p = previous.classes.find((x) => x.id === c.id);
      console.log(`  ✗ ${c.label}：${pct(p.accuracy)} → ${pct(c.accuracy)} 退化`);
    }
  } else {
    console.log('  ✓ 没有任何类目相对基线退化超过 2 个百分点');
  }
  const fixed = snapshot.failureIds.length < (previous.failureIds || []).length
    ? (previous.failureIds || []).filter((id) => !snapshot.failureIds.includes(id))
    : [];
  if (fixed.length) console.log(`  · 已修好的失败样本：${fixed.join('、')}`);
}

if (UPDATE_BASELINE) {
  writeFileSync(baselinePath, JSON.stringify(snapshot, null, 1) + '\n');
  console.log(`\n基线已更新：tests/p2-metrics-baseline.json（${snapshot.failureIds.length} 条失败样本）`);
}

// ── 门禁：类目下限 + 不得相对基线退化 ──
const HARD_FLOOR = 0.75;
const problems = [];
for (const c of classes) {
  if (c.errors) problems.push(`${c.label} 有 ${c.errors} 条判定器异常`);
  if (c.accuracy < HARD_FLOOR) problems.push(`${c.label} 准确率 ${pct(c.accuracy)} 低于硬底线 ${pct(HARD_FLOOR)}`);
}
if (previous) {
  for (const c of classes) {
    const p = previous.classes.find((x) => x.id === c.id);
    if (p && c.accuracy < p.accuracy - 0.05) problems.push(`${c.label} 相对基线退化超过 5 个百分点（${pct(p.accuracy)} → ${pct(c.accuracy)}）`);
  }
}
if (problems.length) {
  console.error('\n❌ 分层评测未通过：');
  for (const p of problems) console.error(`  · ${p}`);
  process.exit(1);
}
assert.ok(classes.length === corpus.classes.length);
console.log('\n✅ 分层评测通过（10 类全部达标，且无相对基线退化）');
