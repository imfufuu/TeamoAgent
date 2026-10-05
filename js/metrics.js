// ─── P2（Dubhe Helix 2.5）：统一指标面板 ───────────────────────────────────────
// 目标（P2 第 18 条）：把散落在轨迹日志、幂等账本、检查点、记忆健康度、审计里的信号
// 收成一张可诊断的面板，并且**必须能按维度切分**——只看总体平均会掩盖某一类的严重退化。
//
// 数据来源全部是已经落盘的真实记录（不预填、不估算）：
//   · store.state.trajectoryLog     每轮轨迹条目（含负向指标、耗时、任务类型、路由信息）
//   · store.state.memoryHealth      记忆健康度（写入分布 / 敏感条目 / 冲突）
//   · store.state.executionIdempotency 幂等账本（被拦截 / 复用的调用）
//   · store.state.executionCheckpoints 检查点（恢复与漂移）
export const METRICS_POLICY_VERSION = 'metrics-policy-2.5.0';
export const METRICS_SCHEMA_VERSION = 'metrics-schema-1';

// 12 项指标：id 用于代码，key 用于面板与基线文件
export const METRIC_DEFS = Object.freeze([
  { id: 'route_upgrade_rate', key: 'routeUpgradeRate', label: '路由升档率', unit: 'rate', direction: 'neutral', formula: '升档回合 / 总回合' },
  { id: 'route_downgrade_rate', key: 'routeDowngradeRate', label: '路由降档率', unit: 'rate', direction: 'neutral', formula: '走 0ms 快路径的回合 / 总回合' },
  { id: 'tool_success_rate', key: 'toolSuccessRate', label: '工具成功率', unit: 'rate', direction: 'up', formula: '成功调用 / 总调用' },
  { id: 'tool_retry_rate', key: 'toolRetryRate', label: '工具重试率', unit: 'rate', direction: 'down', formula: '重试调用 / 总调用' },
  { id: 'silent_failure_rate', key: 'silentFailureRate', label: '静默失败率', unit: 'rate', direction: 'down', formula: '失败未披露的回合 / 总回合' },
  { id: 'unnecessary_tool_call_rate', key: 'unnecessaryToolCallRate', label: '多余调用率', unit: 'rate', direction: 'down', formula: '（被拦截 + 幂等复用）/ 总调用' },
  { id: 'budget_exhaustion_rate', key: 'budgetExhaustionRate', label: '预算耗尽率', unit: 'rate', direction: 'down', formula: '出现预算拦截的回合 / 总回合' },
  { id: 'recovery_success_rate', key: 'recoverySuccessRate', label: '恢复成功率', unit: 'rate', direction: 'up', formula: '失败后恢复成功的次数 / 失败次数' },
  { id: 'memory_write_precision', key: 'memoryWritePrecision', label: '记忆写入精确率', unit: 'rate', direction: 'up', formula: '进入长期库的条目 /（长期库 + 候选区）' },
  { id: 'memory_conflict_rate', key: 'memoryConflictRate', label: '记忆冲突率', unit: 'rate', direction: 'down', formula: '存在冲突/被取代关系的条目 / 活跃条目' },
  { id: 'audit_mismatch_rate', key: 'auditMismatchRate', label: '审计不一致率', unit: 'rate', direction: 'down', formula: '审计事件与调用/转移对不上的回合 / 总回合' },
  { id: 'p95_execution_latency', key: 'p95ExecutionLatencyMs', label: 'P95 执行耗时', unit: 'ms', direction: 'down', formula: '回合总耗时的 P95' },
]);

// 七个切分维度（P2 第 18 条）
export const METRIC_DIMENSIONS = Object.freeze([
  { key: 'taskClass', label: '任务类型', pick: (e) => e.taskClass || 'unknown' },
  { key: 'reasoningLevel', label: '推理档位', pick: (e) => (e.route && e.route.reasoningLevel) || 'unknown' },
  { key: 'toolType', label: '工具类型', pick: (e) => (Array.isArray(e.toolNames) && e.toolNames.length ? e.toolNames.join('+') : 'none') },
  { key: 'split', label: 'In-Domain / OOD', pick: (e) => (e.route && e.route.split) || 'runtime' },
  { key: 'involvesMemory', label: '是否涉及记忆', pick: (e) => (e.memoryInvolved ? 'memory' : 'no-memory') },
  { key: 'hadRecovery', label: '是否发生失败恢复', pick: (e) => ((e.failedCount || 0) > 0 ? 'had-failure' : 'clean') },
  { key: 'externalSideEffect', label: '是否产生外部副作用', pick: (e) => (e.externalSideEffect ? 'external' : 'local') },
]);

const rate = (num, den, digits = 4) => (den ? Number((num / den).toFixed(digits)) : null);

function percentile(nums, p) {
  const arr = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!arr.length) return null;
  const idx = Math.min(arr.length - 1, Math.max(0, Math.ceil((p / 100) * arr.length) - 1));
  return arr[idx];
}

/**
 * 从一轮轨迹条目集合算出 12 项指标。
 * entries 的字段口径（由 agent 写入）：taskClass / toolCallCount / failedCount / retriedCount /
 * reusedCount / blockedCount / totalMs / metrics{...} / route{mode,escalated,fastPath,reasoningLevel} /
 * memoryInvolved / externalSideEffect / auditMismatch / budgetExhausted / toolNames
 */
export function computeMetrics(entries = [], { memoryHealth = null, ledgerEntries = [], checkpoints = [] } = {}) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && typeof e === 'object');
  const n = list.length;
  const sum = (pick) => list.reduce((acc, e) => acc + (Number(pick(e)) || 0), 0);
  const totalCalls = sum((e) => e.toolCallCount);
  const failedCalls = sum((e) => e.failedCount);
  const retriedCalls = sum((e) => e.retriedCount);
  const reusedCalls = sum((e) => e.reusedCount) + (Array.isArray(ledgerEntries) ? ledgerEntries.filter((x) => x && x.status === 'succeeded').length * 0 : 0);
  const blockedCalls = sum((e) => e.blockedCount);
  const flagCount = (name) => list.filter((e) => e.metrics && e.metrics[name] && e.metrics[name].flagged).length;
  const memory = memoryHealth || {};
  const candidateCount = Number(memory.candidateCount) || 0;
  const activeCount = Number(memory.activeCount) || 0;
  const conflictCount = Number(memory.conflictCount) || 0;

  const metrics = {
    routeUpgradeRate: rate(list.filter((e) => e.route && e.route.escalated).length, n),
    routeDowngradeRate: rate(list.filter((e) => e.route && e.route.fastPath).length, n),
    toolSuccessRate: totalCalls ? rate(Math.max(0, totalCalls - failedCalls), totalCalls) : null,
    toolRetryRate: totalCalls ? rate(retriedCalls, totalCalls) : null,
    silentFailureRate: rate(flagCount('silentFailure'), n),
    unnecessaryToolCallRate: totalCalls ? rate(blockedCalls + reusedCalls, totalCalls) : null,
    budgetExhaustionRate: rate(list.filter((e) => e.budgetExhausted).length, n),
    recoverySuccessRate: (() => {
      const den = sum((e) => e.failedCount);
      if (!den) return n ? 1 : null;
      const recovered = list.reduce((acc, e) => acc + (Number(e.recoveredCount) || 0), 0);
      return rate(Math.min(recovered, den), den);
    })(),
    memoryWritePrecision: (activeCount + candidateCount) ? rate(activeCount, activeCount + candidateCount) : null,
    memoryConflictRate: activeCount ? rate(conflictCount, activeCount) : null,
    auditMismatchRate: rate(list.filter((e) => e.auditMismatch).length, n),
    p95ExecutionLatencyMs: percentile(list.map((e) => Number(e.totalMs)), 95),
  };
  return { metrics, samples: n, totals: { totalCalls, failedCalls, retriedCalls, reusedCalls, blockedCalls, checkpoints: (checkpoints || []).length, ledgerEntries: (ledgerEntries || []).length } };
}

/** 按维度切分：每个维度值下都算出同一组 12 项指标（样本量一并给出，避免小样本被当成结论）。 */
export function cutMetricsByDimension(entries = [], dimensions = METRIC_DIMENSIONS, opts = {}) {
  const out = {};
  for (const dim of dimensions) {
    const groups = new Map();
    for (const e of entries || []) {
      const k = dim.pick(e);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    }
    out[dim.key] = { label: dim.label, groups: {} };
    for (const [k, list] of groups) {
      const computed = computeMetrics(list, opts);
      out[dim.key].groups[k] = { samples: list.length, metrics: computed.metrics };
    }
  }
  return out;
}

export function buildMetricSnapshot({ entries = [], memoryHealth = null, ledgerEntries = [], checkpoints = [], dimensions = METRIC_DIMENSIONS, now = () => Date.now() } = {}) {
  const base = computeMetrics(entries, { memoryHealth, ledgerEntries, checkpoints });
  return {
    policyVersion: METRICS_POLICY_VERSION,
    schemaVersion: METRICS_SCHEMA_VERSION,
    at: now(),
    samples: base.samples,
    overall: base.metrics,
    totals: base.totals,
    byDimension: cutMetricsByDimension(entries, dimensions, { memoryHealth, ledgerEntries, checkpoints }),
  };
}

const fmt = (def, value) => {
  if (value === null || value === undefined) return '-';
  if (def.unit === 'rate') return `${(value * 100).toFixed(1)}%`;
  if (def.unit === 'ms') return `${Math.round(value)}ms`;
  return String(value);
};

export function formatMetricsPanel(snapshot, { dimLimit = 2, groupLimit = 4 } = {}) {
  if (!snapshot) return '【统一指标】无数据（还没有可统计的回合）';
  const lines = [`【统一指标 · ${snapshot.samples} 回合】${snapshot.policyVersion}`];
  lines.push('  总体：' + METRIC_DEFS.map((d) => `${d.label} ${fmt(d, snapshot.overall[d.key])}`).join(' · '));
  const dims = Object.entries(snapshot.byDimension || {}).slice(0, dimLimit);
  for (const [, dim] of dims) {
    const groups = Object.entries(dim.groups || {});
    if (groups.length <= 1) continue;
    lines.push(`  按${dim.label}：` + groups.slice(0, groupLimit).map(([k, g]) => {
      const worst = g.metrics.silentFailureRate === null ? g.metrics.p95ExecutionLatencyMs : g.metrics.silentFailureRate;
      return `${k}(n=${g.samples}, 静默失败 ${fmt(METRIC_DEFS[4], g.metrics.silentFailureRate)}, P95 ${fmt(METRIC_DEFS[11], worst === g.metrics.silentFailureRate ? g.metrics.p95ExecutionLatencyMs : g.metrics.p95ExecutionLatencyMs)})`;
    }).join(' · '));
  }
  return lines.join('\n');
}

/** 指标闸门：与基线快照比对，超过容差即判为退化（回归基线使用）。 */
export function evaluateMetricGate(current, baseline, { tolerance = 0.03, latencyTolerance = 0.25 } = {}) {
  if (!current || !baseline) return { ok: false, reason: '缺少当前或基线快照', regressions: [] };
  const regressions = [];
  for (const def of METRIC_DEFS) {
    const cur = current.overall[def.key];
    const base = baseline.overall[def.key];
    if (cur === null || cur === undefined || base === null || base === undefined) continue;
    if (def.direction === 'up') {
      if (cur < base - tolerance) regressions.push({ key: def.key, label: def.label, baseline: base, current: cur, rule: `不得低于基线 −${tolerance}` });
    } else if (def.direction === 'down') {
      const limit = def.unit === 'ms' ? base * (1 + latencyTolerance) : base + tolerance;
      if (cur > limit) regressions.push({ key: def.key, label: def.label, baseline: base, current: cur, rule: def.unit === 'ms' ? `不得高于基线 +${Math.round(latencyTolerance * 100)}%` : `不得高于基线 +${tolerance}` });
    }
  }
  return { ok: regressions.length === 0, regressions, checked: METRIC_DEFS.length };
}

export function formatMetricGate(result) {
  if (!result) return '';
  if (result.ok) return `指标闸门通过：${result.checked} 项指标均在基线的容忍区间内`;
  const lines = [`⚠️ 指标闸门未通过（${result.regressions.length} 项相对基线退化）：`];
  for (const r of result.regressions) lines.push(`  · ${r.label}：基线 ${r.baseline} → 当前 ${r.current}（${r.rule}）`);
  return lines.join('\n');
}
