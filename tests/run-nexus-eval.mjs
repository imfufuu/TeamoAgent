// ─── Dubhe Helix 2.5（天枢2.5） · P0 独立离线基准评测与 Wilson 95% 置信区间验收脚本（npm run eval:nexus）──
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import {
  ROUTE_ESCALATION_BENCHMARK,
  evaluateRouteEscalationConfusionMatrix,
  verifyCapabilityOrthogonalityMatrix,
  resolveEffectiveReasoningState,
  verifyPromptToolAlignment,
  buildDegradationDiagnostics,
  arbitrateUnifiedEvidence,
  sha256Hex,
  createFaithfulTraceRecorder,
  GENESIS_TURN_DIGEST,
  buildDecisionFootprint,
  auditFootprintAgainstStore,
  resolveNexusExecutionProfile,
  formatNexusAcceptanceReport,
} from '../js/nexus.js';
import { systemPrompt } from '../js/config.js';
import { TOOL_DEFS } from '../js/tools.js';
import {
  MEMORY_GATEKEEPER_BENCHMARK,
  evaluateMemoryGatekeeperConfusionMatrix,
  computeWilsonConfidenceInterval,
  forgetMemoryFact,
  purgeMemoryFact,
} from '../js/memory.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const corpusPath = resolve(__dirname, 'nexus-eval-corpus.json');
const corpusJson = JSON.parse(readFileSync(corpusPath, 'utf8'));

console.log('================================================================================');
console.log('  Dubhe Helix 2.5（天枢2.5） v2.5.0 · 离线基准评测、OOD 留出集与 Wilson 95% CI');
console.log('================================================================================\n');

// 1. 语料库完整性与样本量验证（N=120 + N=120 = 240）
assert.equal(corpusJson.routeEscalationCorpus.length, 120, '路由升档语料应包含 120 条样本 (60 In-Domain + 60 OOD)');
assert.equal(corpusJson.memoryGatekeeperCorpus.length, 120, '记忆守门人语料应包含 120 条样本 (60 In-Domain + 60 OOD)');
assert.equal(ROUTE_ESCALATION_BENCHMARK.length, 120);
assert.equal(MEMORY_GATEKEEPER_BENCHMARK.length, 120);

// 2. 路由升档混淆矩阵与 Wilson 95% CI 评测
const routeEval = evaluateRouteEscalationConfusionMatrix(corpusJson.routeEscalationCorpus, corpusJson.costWeights.routeEscalation);
const rAccCi = routeEval.wilson95CI.accuracy;
const rRecCi = routeEval.wilson95CI.recall;
const rPreCi = routeEval.wilson95CI.precision;
console.log('[1] Stage 1 · 路由升档代价加权混淆矩阵（N=120 = In-Domain 60 + OOD Holdout 60，代价权重：5·FN + 1·FP）');
console.log(`    混淆矩阵 : TP=${routeEval.confusionMatrix.tp} | FP=${routeEval.confusionMatrix.fp} | TN=${routeEval.confusionMatrix.tn} | FN=${routeEval.confusionMatrix.fn}`);
console.log(`    Accuracy : ${(routeEval.accuracy * 100).toFixed(1)}%  (95% Wilson CI: [${(rAccCi.lower * 100).toFixed(1)}%, ${(rAccCi.upper * 100).toFixed(1)}%], 半宽 ±${(rAccCi.halfWidth * 100).toFixed(2)}%)`);
console.log(`    Recall   : ${(routeEval.recall * 100).toFixed(1)}%  (95% Wilson CI: [${(rRecCi.lower * 100).toFixed(1)}%, ${(rRecCi.upper * 100).toFixed(1)}%])`);
console.log(`    Precision: ${(routeEval.precision * 100).toFixed(1)}%  (95% Wilson CI: [${(rPreCi.lower * 100).toFixed(1)}%, ${(rPreCi.upper * 100).toFixed(1)}%])`);
console.log(`    F1 Score : ${(routeEval.f1 * 100).toFixed(1)}% | 误升档率(FPR): ${(routeEval.falsePositiveRate * 100).toFixed(1)}% | 代价加权误差: ${routeEval.costWeightedError}`);
console.log(`    拆分对比 : In-Domain (N=${routeEval.splits.inDomain.totalSamples}) F1=${(routeEval.splits.inDomain.f1 * 100).toFixed(1)}% | OOD Holdout (N=${routeEval.splits.oodHoldout.totalSamples}) F1=${(routeEval.splits.oodHoldout.f1 * 100).toFixed(1)}%`);
console.log(`    基线对比 : vs ${routeEval.baselineComparison.baselineName} (F1=${(routeEval.baselineComparison.baselineF1 * 100).toFixed(1)}%, 误差=${routeEval.baselineComparison.baselineCostWeightedError}) → F1 提升 +${(routeEval.baselineComparison.f1Lift * 100).toFixed(1)}%, 误差降低 -${routeEval.baselineComparison.costErrorReduction}`);
if (routeEval.failedSamples.length) {
  console.log('    公开披露的 OOD 边界失败样本（不掩盖规则预筛在隐式长尾上的局限）：');
  for (const f of routeEval.failedSamples) {
    console.log(`      - [${f.type}][${f.split}] ${f.id} (${f.category}): "${f.text}" -> ${f.note}`);
  }
}
console.log('');

// 3. 记忆守门人混淆矩阵与 Wilson 95% CI 评测
const memEval = evaluateMemoryGatekeeperConfusionMatrix(corpusJson.memoryGatekeeperCorpus, corpusJson.costWeights.memoryGatekeeper);
const mAccCi = memEval.wilson95CI.accuracy;
const mPreCi = memEval.wilson95CI.precision;
const mRecCi = memEval.wilson95CI.recall;
console.log('[2] Stage 2 · 记忆写入守门人代价加权混淆矩阵（N=120 = In-Domain 60 + OOD Holdout 60，代价权重：4·FP + 1·FN）');
console.log(`    混淆矩阵 : TP=${memEval.confusionMatrix.tp} | FP=${memEval.confusionMatrix.fp} | TN=${memEval.confusionMatrix.tn} | FN=${memEval.confusionMatrix.fn}`);
console.log(`    Accuracy : ${(memEval.accuracy * 100).toFixed(1)}%  (95% Wilson CI: [${(mAccCi.lower * 100).toFixed(1)}%, ${(mAccCi.upper * 100).toFixed(1)}%], 半宽 ±${(mAccCi.halfWidth * 100).toFixed(2)}%)`);
console.log(`    Precision: ${(memEval.precision * 100).toFixed(1)}%  (95% Wilson CI: [${(mPreCi.lower * 100).toFixed(1)}%, ${(mPreCi.upper * 100).toFixed(1)}%])`);
console.log(`    Recall   : ${(memEval.recall * 100).toFixed(1)}%  (95% Wilson CI: [${(mRecCi.lower * 100).toFixed(1)}%, ${(mRecCi.upper * 100).toFixed(1)}%])`);
console.log(`    F1 Score : ${(memEval.f1 * 100).toFixed(1)}% | 误写入率(FPR): ${(memEval.falsePositiveRate * 100).toFixed(1)}% | 代价加权误差: ${memEval.costWeightedError}`);
console.log(`    拆分对比 : In-Domain (N=${memEval.splits.inDomain.totalSamples}) F1=${(memEval.splits.inDomain.f1 * 100).toFixed(1)}% | OOD Holdout (N=${memEval.splits.oodHoldout.totalSamples}) F1=${(memEval.splits.oodHoldout.f1 * 100).toFixed(1)}%`);
console.log(`    基线对比 : vs ${memEval.baselineComparison.baselineName} (F1=${(memEval.baselineComparison.baselineF1 * 100).toFixed(1)}%, 误差=${memEval.baselineComparison.baselineCostWeightedError}) → F1 提升 +${(memEval.baselineComparison.f1Lift * 100).toFixed(1)}%, 误差降低 -${memEval.baselineComparison.costErrorReduction}`);
if (memEval.failedSamples.length) {
  console.log('    公开披露的 OOD 边界失败样本（不掩盖静态正则守门人的局限）：');
  for (const f of memEval.failedSamples) {
    console.log(`      - [${f.type}][${f.split}] ${f.id} (${f.category}): "${f.text}" -> ${f.note}`);
  }
}
console.log('');

// 联合 N=240 样本量置信区间半宽验证（解决 N=20 时 ±18% 置信区间过宽问题，N=240 下半宽 < ±3.5%）
const totalSamples = routeEval.totalSamples + memEval.totalSamples;
const totalCorrect = (routeEval.confusionMatrix.tp + routeEval.confusionMatrix.tn)
  + (memEval.confusionMatrix.tp + memEval.confusionMatrix.tn);
const combinedCi = computeWilsonConfidenceInterval(totalCorrect, totalSamples);
assert.equal(totalSamples, 240);
assert.ok(combinedCi.halfWidth <= 0.04, `N=240 联合评测集的 95% Wilson CI 半宽应 <= 4%，实测 ${(combinedCi.halfWidth * 100).toFixed(2)}%`);

// 4. 4 位能力向量正交性与档位-工具表一致性锁验证
const ortho = verifyCapabilityOrthogonalityMatrix();
assert.equal(ortho.totalCombinations, 64, '四个主能力位与两个 Worker 子能力应覆盖 64 种组合');
assert.equal(ortho.disjointPartitionVerified, true);

// 遍历 thinking=(true/false) × reasoningLevel=('off','low','medium','high','max','ultra') 共 12 种组合，验证绝不出现 ULTRA vs dispatch_subagent 自相矛盾
let alignmentChecks = 0;
for (const thinking of [true, false]) {
  for (const reasoningLevel of ['off', 'low', 'medium', 'high', 'max', 'ultra']) {
    const state = resolveEffectiveReasoningState({ thinking, reasoningLevel });
    const turnTools = TOOL_DEFS.filter((t) => t.name !== 'dispatch_subagent' || state.canDispatch);
    const sysText = systemPrompt(new Date(), {
      webEnabled: false,
      allowDispatch: state.canDispatch,
      reasoningLevel: state.effectiveLevel,
    });
    const degs = buildDegradationDiagnostics({
      relayOk: false,
      webEnabled: false,
      sandboxEnabled: true,
      canDispatch: state.canDispatch,
      thinking,
      reasoningLevel,
      tools: turnTools,
    });
    const arb = arbitrateUnifiedEvidence({
      canDispatch: state.canDispatch,
      thinking,
      reasoningLevel,
      tools: turnTools,
      userText: '请评估并对比这两套架构的优缺点',
    });
    const check = verifyPromptToolAlignment({
      tools: turnTools,
      thinking,
      reasoningLevel,
      canDispatch: state.canDispatch,
      systemPromptText: sysText,
      degradationItems: degs,
      arbitration: arb,
    });
    assert.equal(check.aligned, true, `档位与工具表一致性校验失败 (thinking=${thinking}, level=${reasoningLevel}): ${check.discrepancies.join('; ')}`);
    alignmentChecks++;
  }
}
console.log('[3] 4 位能力向量正交性与档位-工具表一致性锁（Tier-Tool Alignment Invariant）');
console.log(`    遍历组合数 : ${ortho.totalCombinations} (2^6：四个核心位 + Worker search/crawl 子能力) + ${alignmentChecks} 种思考开关×档位组合`);
console.log(`    子集不相交 : ${ortho.disjointPartitionVerified} | 档位-提示词-L2诊断-工具表 100% 对齐 : true\n`);

// 5. 软归档 vs 物理清除双通道验证
const initMem = [
  { id: 'mem-1', text: '用户偏好深色模式界面' },
  { id: 'mem-2', text: '测试私密 Token: sk-secret-999' },
];
const archive = [];
const afterForget = forgetMemoryFact(initMem, '深色模式', { archivePool: archive });
assert.equal(afterForget.removed.length, 1);
assert.equal(afterForget.recoverable, true);
assert.equal(afterForget.archived.length, 1);

const afterPurge = purgeMemoryFact(afterForget.next, '深色模式', { archivePool: afterForget.archived });
assert.equal(afterPurge.purged.length, 1);
assert.equal(afterPurge.recoverable, false);
assert.equal(afterPurge.nextArchive.length, 0);
console.log('[4] 记忆删除双通道验证（Soft-Archive vs Physical Purge）');
console.log(`    Soft-Archive (forget) : recoverable=${afterForget.recoverable}, 冷备库保留=${afterForget.archived.length} 条`);
console.log(`    Physical Purge (purge): recoverable=${afterPurge.recoverable}, 活跃库剩余=${afterPurge.next.length} 条, 冷备库剩余=${afterPurge.nextArchive.length} 条\n`);

// 6. SHA-256 跨轮次哈希链与 Store 独立交叉审计验证
const shaSample = sha256Hex('dubhe-helix-2.5');
assert.equal(shaSample.length, 64, 'SHA-256 摘要应为 64 位十六进制字符串');
const rec = createFaithfulTraceRecorder({ prevTurnDigest: GENESIS_TURN_DIGEST });
rec.record('route:full-nexus', 'full-nexus');
rec.record('tools:executed', 'evaluate_expression');
const prof = resolveNexusExecutionProfile({ userText: '计算并对比两个方案', plan: { route: { choice: 'tools' } } });
const fp = buildDecisionFootprint({
  profile: prof,
  usedTools: ['evaluate_expression'],
  traceRecorder: rec,
  prevTurnDigest: GENESIS_TURN_DIGEST,
});
const auditOk = auditFootprintAgainstStore(fp, {
  assistantMsg: { toolCalls: [{ name: 'evaluate_expression' }] },
  turnMessages: [{ role: 'tool', name: 'evaluate_expression', content: '42' }],
});
const auditFake = auditFootprintAgainstStore(fp, {
  assistantMsg: { toolCalls: [] },
  turnMessages: [],
});
assert.equal(auditOk.passed, true);
assert.equal(auditFake.passed, false, '当足迹声称调用了工具但 Store 中无记录时，交叉审计必须拦截');
console.log('[5] SHA-256 跨轮次追加哈希链与 Store 独立交叉审计验证');
console.log(`    哈希算法   : ${fp.hashAlgorithm} | Turn Digest: ${fp.turnDigest.slice(0, 24)}...`);
console.log(`    真实轨迹审计: passed=${auditOk.passed} | 伪造轨迹拦截: passed=${auditFake.passed} (${auditFake.discrepancies.join(', ')})\n`);

console.log(formatNexusAcceptanceReport());
console.log('\n✅ Dubhe Helix 2.5（天枢2.5） · P0 离线基准评测（N=240）与全部架构不变量校验通过。');
