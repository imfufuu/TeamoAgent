// ─── 回合收尾器（P4 拆分：从 agent.js runLoop 的 finally 尾段抽出）────────────────────
// 拥有：回合结束后一次性、同步的「记账与落盘」——
//   P0 执行内核收尾（未终态则打 INTERRUPTED / 汇总执行记录）→ P1 轨迹级评测 + 检查点健康度 + 幂等账本 + 记忆健康度
//   → P2 收尾①审计三层对账 ②故障注入验收 ③统一指标快照 ④策略实验样本 → 执行记录落 Store → Nexus 验收指标 / 路由时延样本
//   → syncFS() → store.notify() → onTurnTiming。
// 不拥有：模型请求循环、工具执行（toolrunner.js）、技能蒸馏与自动记忆捕获（仍在 runLoop finally 的前半段，因为它们依赖
//   status === 'done' 分支里的局部变量且会改写 fs）。
// 这里不 await、不 return 值：调用方把它放在 finally 里，抛错语义与原先内联时完全一致。
import {
  EXECUTION_STATES,
  resumeExecutionState,
  summarizeExecutionRecord,
  evaluateExecutionKernelAcceptance,
} from './execution.js?v=2026.10.5.30';
import { summarizeCheckpointHealth } from './recovery.js?v=2026.10.5.30';
import { summarizeMemoryHealth } from './memorylife.js?v=2026.10.5.30';
import { evaluateTrajectory, summarizeTrajectoryTotals, appendTrajectoryEntry } from './trajectory.js?v=2026.10.5.30';
import { buildMetricSnapshot, evaluateMetricGate, formatMetricGate } from './metrics.js?v=2026.10.5.30';
import { appendExperimentSample } from './experiments.js?v=2026.10.5.30';
import { reconcileAudit } from './audit.js?v=2026.10.5.30';
import { auditFootprintAgainstStore, recordRouteLatencySample, evaluateNexusAcceptanceMetrics } from './nexus.js';

/**
 * 回合收尾：把一轮的执行状态、轨迹、审计、指标、实验样本写回 store，并触发 UI 刷新。
 * 参数全部来自 runLoop / createAgent 作用域，按名注入（避免 turnfinalizer 反向依赖 agent.js）。
 * @param {object} ctx
 *   store, emit, syncFS, fs（回合内生效的 fs，用于检查点健康度）, turnMemoryPlan, status（回合终态字符串）,
 *   capabilities, exec, machine, nexusState, sessionId, t0, telemetry, turn, turnPlan
 */
export function finalizeTurn({
  store, emit, syncFS, fs, turnMemoryPlan, status,
  capabilities, exec, machine, nexusState, sessionId, t0, telemetry, turn, turnPlan,
}) {
  // ── P0 执行内核收尾：状态轨迹 / 预算账本 / 审计摘要落盘（刷新后可判断任务处于哪个阶段）──
  if (!exec.machine.isTerminal) {
    exec.machine.transition(EXECUTION_STATES.INTERRUPTED,
      status === 'cancelled' ? '回合被中止，未提交' : (status === 'error' ? '回合异常退出，未提交' : '回合未走到提交（迭代上限或提前返回）'));
  }
  if (!exec.record) {
    exec.record = summarizeExecutionRecord({
      machine: exec.machine, budget: exec.budgetGov,
      toolRuns: exec.machine.toolRuns, silentFailure: exec.silentFailure,
    });
  }
  exec.record.sessionId = sessionId;
  // P1 轨迹级评测：三个负向指标（过度路由 / 路由不足 / 静默失败）+ 恢复率 / 审计完整度 / 副作用安全
  exec.trajectory = evaluateTrajectory({
    record: exec.record,
    plan: turnPlan,
    userText: exec.execCtx ? exec.execCtx.userIntent : '',
    taskClass: exec.execCtx ? exec.execCtx.taskClass : 'chat',
    capabilities,
    auditEvents: exec.machine.audit.events,
    ledger: exec.ledger,
    totalMs: Date.now() - t0,
    // P2：指标面板要按「任务类型 / 推理档位 / 工具类型 / In-Domain·OOD / 是否涉及记忆 /
    // 是否发生失败恢复 / 是否产生外部副作用」切分，这些维度必须在轨迹条目里就落好
    route: {
      mode: (exec.execCtx && exec.execCtx.mode) || (nexusState && nexusState.profile ? nexusState.profile.mode : ''),
      escalated: !!(nexusState && nexusState.profile && nexusState.profile.escalated),
      fastPath: !!(nexusState && nexusState.profile && nexusState.profile.fastPath),
      reasoningLevel: (exec.execCtx && exec.execCtx.reasoningState) || turn.reasoningLevel || 'medium',
    },
    toolNames: [...new Set((exec.record.toolRuns || []).map((r) => r.name).filter(Boolean))],
    memoryInvolved: !!(store.state.memory && store.state.memory.length) || !!((turnMemoryPlan && turnMemoryPlan.dropped && turnMemoryPlan.dropped.length)),
    externalSideEffect: !!(exec.record.toolRuns || []).some((r) => r.riskLevel === 'L3' || /network|cost|remote/.test(String(r.sideEffect || ''))),
    budgetExhausted: !!(exec.budgetGov.snapshot().exhaustedChannels || []).length,
    recoveredCount: ((exec.record.toolRuns || []).filter((r) => r.recovered)).length,
  });
  exec.machine.audit.record('trajectory-eval', {
    overRouting: exec.trajectory.metrics.overRouting.flagged,
    underRouting: exec.trajectory.metrics.underRouting.flagged,
    silentFailure: exec.trajectory.metrics.silentFailure.flagged,
    recoverySuccessRate: exec.trajectory.metrics.recovery.value,
    auditCompleteness: exec.trajectory.metrics.audit.value,
    healthy: exec.trajectory.healthy,
  });
  store.state.trajectoryLog = appendTrajectoryEntry(store.state.trajectoryLog, exec.trajectory);
  store.state.trajectoryTotals = summarizeTrajectoryTotals(store.state.trajectoryLog);
  exec.record.trajectory = {
    overRouting: exec.trajectory.metrics.overRouting.flagged,
    underRouting: exec.trajectory.metrics.underRouting.flagged,
    silentFailure: exec.trajectory.metrics.silentFailure.flagged,
    recoverySuccessRate: exec.trajectory.metrics.recovery.value,
    auditCompleteness: exec.trajectory.metrics.audit.value,
    unnecessaryCallRate: exec.trajectory.metrics.unnecessaryCallRate.value,
    healthy: exec.trajectory.healthy,
    negativeCount: exec.trajectory.negativeCount,
  };
  // P1 检查点健康度 + 幂等账本落盘（供刷新/下一轮做续跑与去重裁决）
  const sessionCheckpoints = exec.checkpoints.list(sessionId);
  exec.record.checkpoint = summarizeCheckpointHealth({ checkpoints: sessionCheckpoints, files: fs.export(), capabilities });
  exec.record.ledger = exec.ledger.snapshot(8);
  store.state.executionIdempotency = exec.ledger.toJSON().slice(-48);
  exec.record.resumeHint = resumeExecutionState({ ...exec.record, machine: exec.machine.snapshot() });
  store.state.memoryHealth = summarizeMemoryHealth({
    memory: store.state.memory,
    candidates: store.state.memoryCandidates || [],
  });

  // ── P2 收尾①：审计三层目标对账（完整性 / 完备性 / 真实性边界）──
  // 站在外部 Store 的位置复核内核写下的足迹：链是否自洽、事件是否覆盖每一次调用与转移。
  const auditSnapshotForReconcile = {
    ...exec.machine.audit.snapshot(),   // 含链头 digest / eventCount：故障验收的「可审计」要核这个
    events: exec.machine.audit.events,
  };
  const tampered = exec.faultInjector ? exec.faultInjector.tamperAudit(auditSnapshotForReconcile) : null;
  exec.auditReconcile = reconcileAudit({
    auditEvents: tampered || auditSnapshotForReconcile,
    declared: { schemaVersion: auditSnapshotForReconcile.schemaVersion, policyVersion: auditSnapshotForReconcile.policyVersion, sessionId, turnId: machine.turnId },
    record: exec.record,
    ledgerEntries: exec.ledger.snapshot(48),
    checkpoints: exec.checkpoints.list(sessionId),
    policySnapshot: exec.policySnapshot,
  });
  store.state.auditReconcile = {
    ok: exec.auditReconcile.ok,
    integrity: exec.auditReconcile.integrity,
    completeness: exec.auditReconcile.completeness,
    authenticity: exec.auditReconcile.authenticity,
    statement: exec.auditReconcile.statement,
    at: exec.auditReconcile.checkedAt,
  };
  exec.record.auditReconcile = {
    integrityOk: exec.auditReconcile.integrity.ok,
    completenessOk: exec.auditReconcile.completeness.ok,
    integrityMismatches: exec.auditReconcile.integrity.mismatches.length + exec.auditReconcile.integrity.crossVersion.length,
    missingEvents: exec.auditReconcile.completeness.missing.length,
    authenticityClaimed: false,
  };

  // ── P2 收尾②：故障注入验收（五性质：可检测 / 可解释 / 可停止 / 可恢复 / 可审计）──
  if (exec.faultInjector) {
    const faultResult = exec.faultInjector.verify({
      record: exec.record,
      auditSnapshot: tampered || auditSnapshotForReconcile,
      trajectory: exec.trajectory,
      resumePlan: exec.resumePlan || null,
      memoryApplication: (nexusState && nexusState.memoryApplication) || null,
      // 上下文自检报告的分裂也算「可检测」的证据：能在开工前判定为缺陷，比撞墙更强
      contextConsistency: exec.contextConsistency || null,
    });
    exec.faultReport = faultResult;
    store.state.lastFaultReport = {
      policyVersion: faultResult.policyVersion,
      summary: faultResult.summary,
      ok: faultResult.ok,
      cards: faultResult.cards,
      at: Date.now(),
    };
    store.state.faultHistory = [...(Array.isArray(store.state.faultHistory) ? store.state.faultHistory : []), ...faultResult.cards].slice(-24);
    // 注入是「一次性」的：验收完立刻清残留（假声明留在设置里会污染之后每一轮）
    exec.faultInjector.reset(store);
    exec.machine.audit.record('fault-verification', {
      injected: [...new Set(exec.faultInjector.log
        .filter((l) => l.phase !== 'arm')
        .flatMap((l) => (Array.isArray(l.kinds) ? l.kinds : [l.kind]))
        .filter(Boolean))],
      ok: faultResult.ok,
      summary: faultResult.summary,
    });
  }

  // ── P2 收尾③：统一指标快照（12 项 + 七维切分，只看总体平均没有诊断价值）──
  exec.metrics = buildMetricSnapshot({
    entries: store.state.trajectoryLog,
    memoryHealth: store.state.memoryHealth,
    ledgerEntries: store.state.executionIdempotency,
    checkpoints: store.state.executionCheckpoints,
  });
  store.state.metricsSnapshot = exec.metrics;
  const metricGate = store.state.metricsBaseline ? evaluateMetricGate(exec.metrics, store.state.metricsBaseline) : null;
  if (metricGate) store.state.metricsGate = { ok: metricGate.ok, regressions: metricGate.regressions, checkedAt: Date.now(), text: formatMetricGate(metricGate) };

  // ── P2 收尾④：策略实验在线样本（对照 vs 变体；护栏违规会直接判回退）──
  const confirmHistory = exec.confirmGate.history.filter((r) => r && r.turnId === machine.turnId || true);
  const asked = confirmHistory.filter((r) => r.at >= t0).length;
  const abandoned = confirmHistory.filter((r) => r.at >= t0 && (r.decision === 'timeout' || r.decision === 'deny' || r.decision === 'cancelled')).length;
  for (const [expId, expAssignment] of [['guard-default', exec.experiment], ['memory-candidate-hint', exec.experimentSecond]]) {
    if (!expAssignment || !expAssignment.inExperiment) continue;
    store.state.experimentSamples = appendExperimentSample(store.state.experimentSamples, {
      experimentId: expId,
      variantId: expAssignment.variantId,
      metrics: {
        guardAskRate: asked > 0 ? 1 : 0,
        confirmAbandonRate: asked ? abandoned / asked : 0,
        memoryUtilityRate: (nexusState && nexusState.memoryApplication && nexusState.memoryApplication.injectedCount) ? 1 : 0,
        turnLatencyMs: Date.now() - t0,
        promptGrowthChars: 0,
      },
      ts: Date.now(),
    });
  }
  // 执行记录落 Store 的时机放在 P2 收尾之后：审计对账 / 故障验收 / 指标 / 实验样本
  // 都是这一轮的结论，先落盘再补写会让 /nexus 与面板读到「缺一半」的记录。
  store.state.lastExecutionRecord = {
    ...exec.record,
    transitions: (exec.record.transitions || []).slice(-24),
    toolRuns: (exec.record.toolRuns || []).slice(-12),
    resumeHintConsumed: false,
  };
  store.state.lastExecutionAcceptance = evaluateExecutionKernelAcceptance({ toolNames: exec.toolList.map((t) => t.name) });
  if (nexusState.lastFootprint) {
    // 足迹绑定执行内核摘要：工具名/顺序之外，还能核到状态轨迹与审计摘要
    nexusState.lastFootprint.executionDigest = exec.record.auditDigest;
    nexusState.lastFootprint.executionState = exec.record.state;
    nexusState.lastFootprint.executionToolCalls = exec.record.toolCallCount;
  }
  if (!exec.recordEmitted) { exec.recordEmitted = true; emit('onExecutionRecord', exec.record); }

  store.state.lastNexusTelemetry = {
    ...telemetry.finish(),
    execution: {
      kernelVersion: exec.record.kernelVersion,
      policyVersion: exec.record.policyVersion,
      state: exec.record.state,
      phaseLabel: exec.record.phaseLabel,
      toolCalls: exec.record.toolCallCount,
      failed: exec.record.failedCount,
      blocked: exec.record.blockedCount,
      retries: exec.record.retryCount,
      uncertain: exec.record.uncertainCount,
      riskCounts: exec.record.riskCounts,
      silentFailure: exec.record.silentFailure,
      auditDigest: exec.record.auditDigest,
      violations: (exec.record.violations || []).length,
      budget: exec.record.budget,
      trajectory: exec.record.trajectory || null,
      checkpoint: exec.record.checkpoint || null,
      memoryApplication: nexusState.memoryApplication ? {
        applied: nexusState.memoryApplication.appliedIds.length,
        validated: nexusState.memoryApplication.validatedIds.length,
        rejectedForTurn: nexusState.memoryApplication.rejectedIds.length,
        reasons: nexusState.memoryApplication.rejectedReasons,
      } : null,
      ledgerSize: exec.ledger.size,
    },
    // P2：策略版本 / 指标 / 审计三层目标 / 实验分配 / 故障验收——UI 面板与验收报告直接读这里
    policy: exec.policySnapshot ? { registryVersion: exec.policySnapshot.registryVersion, versions: exec.policySnapshot.versions } : null,
    metrics: exec.metrics ? { samples: exec.metrics.samples, overall: exec.metrics.overall, dimensions: Object.keys(exec.metrics.byDimension || {}) } : null,
    auditGoals: exec.auditReconcile ? {
      integrity: exec.auditReconcile.integrity.ok,
      completeness: exec.auditReconcile.completeness.ok,
      authenticity: null,
      statement: exec.auditReconcile.statement,
    } : null,
    experiment: exec.experiment ? {
      id: exec.experiment.experimentId,
      variantId: exec.experiment.variantId,
      inExperiment: exec.experiment.inExperiment,
      reason: exec.experiment.reason,
    } : null,
    fault: exec.faultReport ? { ok: exec.faultReport.ok, summary: exec.faultReport.summary } : null,
  };
  recordRouteLatencySample({
    fastPath: !!(nexusState.profile && nexusState.profile.fastPath),
    totalMs: telemetry.totalDurationMs,
    probeOverheadMs: 0,
  });
  if (nexusState.lastFootprint) {
    const lastAssistant = [...store.state.messages].reverse().find((m) => m.role === 'assistant');
    nexusState.lastFootprint.storeAudit = auditFootprintAgainstStore(nexusState.lastFootprint, {
      assistantMsg: lastAssistant && lastAssistant.toolCalls ? lastAssistant : null,
    });
  }
  store.state.lastNexusScorecard = evaluateNexusAcceptanceMetrics({
    memory: store.state.memory,
    memoryArchive: store.state.memoryArchive || [],
    telemetry,
    footprint: nexusState.lastFootprint,
  });
  syncFS();
  store.notify();
  emit('onTurnTiming', Math.round(performance.now() - t0)); // emit 内部已吞掉视图层异常
}
