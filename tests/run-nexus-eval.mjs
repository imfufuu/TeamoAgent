#!/usr/bin/env node
// ─── 天枢 THN v2.1 · 独立离线评测脚本（Offline Reproducible Benchmark Runner）────
// 运行方式：node tests/run-nexus-eval.mjs 或 npm run eval:nexus
// 读取独立标注语料 tests/nexus-eval-corpus.json，输出：
//   1. L1 路由升档判定混淆矩阵（TP/FP/TN/FN、Precision、Recall、F1、代价加权误差 5·FN+1·FP 与失败边界样本）
//   2. L3 记忆写入守门人混淆矩阵（TP/FP/TN/FN、Precision、Recall、FPR、代价加权误差 4·FP+1·FN 与失败边界样本）
//   3. L2 4 位正交能力向量 2^4 = 16 全组合真值表与工具集不相交性验证
//   4. L3/L4 软归档可恢复通道（forget/restore）与合规物理清除通道（purge）隔离验证
//   5. L6 SHA-256 跨轮次追加哈希链与外部 Store 消息记录独立交叉审计（含防篡改拦截测试）

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import {
  evaluateRouteEscalationConfusionMatrix,
  verifyCapabilityOrthogonalityMatrix,
  createFaithfulTraceRecorder,
  buildDecisionFootprint,
  auditFootprintAgainstStore,
  GENESIS_TURN_DIGEST,
} from '../js/nexus.js';
import {
  evaluateMemoryGatekeeperConfusionMatrix,
  upsertFacts,
  forgetMemoryFact,
  restoreMemoryFact,
  purgeMemoryFact,
  getSoftArchivedMemories,
} from '../js/memory.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const corpusPath = path.join(__dirname, 'nexus-eval-corpus.json');
const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));

console.log('================================================================================');
console.log(`  ${corpus.benchmarkName} (schema v${corpus.schemaVersion})`);
console.log('================================================================================\n');

// 1. 路由升档混淆矩阵
const routeEval = evaluateRouteEscalationConfusionMatrix(
  corpus.routeEscalationSamples,
  corpus.costModel.routeEscalation,
);
console.log('1) [Stage 1 · 路由升档判定离线评测] (N = ' + routeEval.totalSamples + ')');
console.log(`   Confusion Matrix : TP=${routeEval.confusionMatrix.tp}, FP=${routeEval.confusionMatrix.fp}, TN=${routeEval.confusionMatrix.tn}, FN=${routeEval.confusionMatrix.fn}`);
console.log(`   Metrics          : Recall=${(routeEval.recall * 100).toFixed(1)}% | Precision=${(routeEval.precision * 100).toFixed(1)}% | F1=${(routeEval.f1 * 100).toFixed(1)}% | FPR=${(routeEval.falsePositiveRate * 100).toFixed(1)}%`);
console.log(`   Weighted Cost    : 5*FN + 1*FP = ${routeEval.costWeightedError}`);
console.log('   Disclosed Boundary Failure Samples:');
for (const f of routeEval.failedSamples) {
  console.log(`     - [${f.type}] ${f.id} (${f.category}): "${f.text}" -> ${f.note}`);
}
console.log('');

// 2. 记忆守门人混淆矩阵
const memEval = evaluateMemoryGatekeeperConfusionMatrix(corpus.memoryGatekeeperSamples);
console.log('2) [Stage 2 · 记忆写入守门人离线评测] (N = ' + memEval.totalSamples + ')');
console.log(`   Confusion Matrix : TP=${memEval.confusionMatrix.tp}, FP=${memEval.confusionMatrix.fp}, TN=${memEval.confusionMatrix.tn}, FN=${memEval.confusionMatrix.fn}`);
console.log(`   Metrics          : Precision=${(memEval.precision * 100).toFixed(1)}% | Recall=${(memEval.recall * 100).toFixed(1)}% | F1=${(memEval.f1 * 100).toFixed(1)}% | FPR=${(memEval.falsePositiveRate * 100).toFixed(1)}%`);
console.log(`   Weighted Cost    : 4*FP + 1*FN = ${memEval.weightedCost}`);
console.log('   Disclosed Boundary Failure Samples:');
for (const f of memEval.failedSamples) {
  console.log(`     - [${f.type}] ${f.id} (${f.category}): "${f.text}" -> ${f.note}`);
}
console.log('');

// 3. 4 位正交能力向量 16 组合验证
const ortho = verifyCapabilityOrthogonalityMatrix();
console.log(`3) [Stage 1 · 4 位正交能力向量真值表] (Combinations = ${ortho.totalCombinations})`);
console.log(`   Disjoint Tool Partition Verified : ${ortho.disjointPartitionVerified}`);
assert.equal(ortho.totalCombinations, 16);
assert.equal(ortho.disjointPartitionVerified, true);
console.log('');

// 4. 软归档可恢复 vs 物理彻底清除（Purge）双通道验证
let activeMem = upsertFacts([], [
  { text: '用户的常规开发语言偏好为 TypeScript', source: 'user-explicit' },
  { text: '用户的临时私有令牌是 sk-secret-9999', source: 'user-explicit' },
]);
const archivePool = [];
const forgotten = forgetMemoryFact(activeMem, 'TypeScript', { archivePool });
assert.equal(forgotten.recoverable, true);
const restored = restoreMemoryFact(forgotten.next, 'TypeScript', { archivePool });
assert.equal(restored.restored.length, 1);

// 先把敏感条目软归档，再执行物理 purge，验证活跃库与冷备库均被物理抹除且不可恢复
const softRemovedSecret = forgetMemoryFact(restored.next, 'sk-secret-9999', { archivePool });
const purged = purgeMemoryFact(softRemovedSecret.next, 'sk-secret-9999', { archivePool });
assert.equal(purged.recoverable, false);
assert.equal(purged.purged.length >= 1, true);
const tryRestorePurged = restoreMemoryFact(purged.next, 'sk-secret-9999', { archivePool });
assert.equal(tryRestorePurged.restored.length, 0);
const coldLeft = getSoftArchivedMemories(archivePool).filter((m) => m.text.includes('sk-secret-9999'));
assert.equal(coldLeft.length, 0);
console.log('4) [Stage 2 · 双通道生命周期隔离验证]');
console.log('   Soft-Archive (forget -> restore) : Recoverable = true (1/1 restored)');
console.log('   Physical Purge (purge -> restore): Recoverable = false (0/1 in active & 0/1 in cold archive)\n');

// 5. SHA-256 跨轮次哈希链与外部 Store 交叉审计验证
const rec1 = createFaithfulTraceRecorder({ prevTurnDigest: GENESIS_TURN_DIGEST });
rec1.record('route:full-nexus', 'full-nexus').record('tools:executed', 'read_file');
const fp1 = buildDecisionFootprint({
  profile: { mode: 'full-nexus', fastPath: false, escalated: false },
  usedTools: ['read_file'],
  traceRecorder: rec1,
  prevTurnDigest: GENESIS_TURN_DIGEST,
});
const audit1 = auditFootprintAgainstStore(fp1, {
  assistantMsg: { toolCalls: [{ name: 'read_file' }] },
  turnMessages: [{ role: 'tool', name: 'read_file', content: 'file content' }],
});
assert.equal(audit1.passed, true);

// 构造篡改场景：足迹谎报未执行工具，外部 Store 实际包含 delete_file
const forgedAudit = auditFootprintAgainstStore(fp1, {
  assistantMsg: { toolCalls: [{ name: 'read_file' }, { name: 'delete_file' }] },
  turnMessages: [
    { role: 'tool', name: 'read_file', content: 'ok' },
    { role: 'tool', name: 'delete_file', content: 'deleted' },
  ],
});
assert.equal(forgedAudit.passed, false);
console.log('5) [Stage 3 · SHA-256 跨轮次哈希链与独立 Store 交叉审计]');
console.log(`   Turn #1 SHA-256 Digest           : ${fp1.turnDigest}`);
console.log(`   Authentic Store Cross-Audit      : passed=${audit1.passed} (${audit1.passedChecks}/${audit1.checksRun} checks)`);
console.log(`   Tampered Tool-Call Detection     : blocked=${!forgedAudit.passed} (${forgedAudit.discrepancies[0]})`);
console.log('================================================================================');
