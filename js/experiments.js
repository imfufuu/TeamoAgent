// ─── P2（THN v2.5）：策略实验与在线反馈闭环 ─────────────────────────────
// 目标（P2 第 3/4 阶段）：让路由、档位、确认等策略可以**受控演进**，并且能安全回退。
// 三条硬约束：
//   1. 默认不灰度：实验注册表里的 enabled 一律 false，未显式开启时所有主体都落 control，
//      行为与开启前完全一致（避免「升级即变行为」这种不可解释的漂移）。
//   2. 分配确定性：bucket = hash(experimentId + subjectId)，同一会话反复进入同一变体；
//      不做随机掷骰，否则问题难以复现。
//   3. 结论要能被推翻：提升需要「变体优于对照且置信区间不重叠」，回退只需要「护栏被触碰」
//      或「明显退化」——回退门槛刻意低于提升门槛（fail-fast 比 fail-safe 更贵）。
import { computeWilsonConfidenceInterval } from './memory.js';

export const EXPERIMENT_POLICY_VERSION = 'experiment-policy-2.5.0';
export const EXPERIMENT_SCHEMA_VERSION = 'experiment-schema-1';

// 实验定义：每个实验声明变体、流量、指标口径、护栏与判定阈值。
export const EXPERIMENT_REGISTRY = Object.freeze({
  // 高风险确认档位的默认值：control = 现状（observe 只记录），treatment = 默认 strict（仅 L3 打断）
  'guard-default': Object.freeze({
    id: 'guard-default',
    label: '确认档位默认值',
    description: 'control=observe（只记录与披露）／treatment=strict（L3 执行前停下等待确认）',
    enabled: false,          // 灰度默认关闭：开启后按 allocation 分配
    allocation: 0.1,         // 进入 treatment 的比例（仅在 enabled=true 时生效）
    metric: { key: 'guardAskRate', label: '确认打断率', direction: 'neutral' },
    guardrails: {
      maxConfirmAbandonRate: 0.3,  // 确认卡被忽略/超时的比例上限
      maxTurnLatencyMs: 120000,
    },
    decision: { minSamples: 12, minDelta: 0.05, maxRegression: 0.05 },
    variants: Object.freeze([
      Object.freeze({ id: 'control', weight: 1, params: Object.freeze({ executionGuard: 'observe' }) }),
      Object.freeze({ id: 'treatment', weight: 1, params: Object.freeze({ executionGuard: 'strict' }) }),
    ]),
  }),

  // 记忆候选区提示：control = 仅长期库注入，treatment = 额外注入「候选（未确认）」提示
  'memory-candidate-hint': Object.freeze({
    id: 'memory-candidate-hint',
    label: '候选记忆提示',
    description: 'control=只注入长期库记忆／treatment=额外把候选区条目作为「未确认信息」提示给模型',
    enabled: false,
    allocation: 0.2,
    metric: { key: 'memoryUtilityRate', label: '记忆采用率', direction: 'up' },
    guardrails: { maxPromptGrowthChars: 1200 },
    decision: { minSamples: 10, minDelta: 0.03, maxRegression: 0.03 },
    variants: Object.freeze([
      Object.freeze({ id: 'control', weight: 1, params: Object.freeze({ candidateHint: false }) }),
      Object.freeze({ id: 'treatment', weight: 1, params: Object.freeze({ candidateHint: true }) }),
    ]),
  }),
});

export const EXPERIMENT_DECISIONS = Object.freeze({
  PROMOTE: 'promote',   // 变体胜出：提升为默认（由人确认后写入注册表）
  KEEP: 'keep',         // 证据不足：维持现状，继续采样
  ROLLBACK: 'rollback', // 护栏被触碰或明显退化：立刻退回 control 并停掉灰度
});

// 稳定的 32 位散列（FNV-1a 变体）：只用于分桶，密码学场景一律用 sha256
function bucketHash(input) {
  let h = 0x811c9dc5;
  const s = String(input);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 把主体稳定分到 [0, 10000) 的桶。 */
export function experimentBucket(experimentId, subjectId) {
  return bucketHash(`${experimentId}::${subjectId}`) % 10000;
}

/**
 * 解析某个主体应进入哪个变体。
 * overrides（settings.experiments[expId]）形态：{ enabled, allocation, forceVariant, paused }
 * 返回 { experimentId, variantId, inExperiment, reason, params }
 */
export function resolveExperimentAssignment({ experiment, subjectId = 'anonymous', overrides = null } = {}) {
  const def = typeof experiment === 'string' ? EXPERIMENT_REGISTRY[experiment] : experiment;
  if (!def) return { experimentId: '', variantId: '', inExperiment: false, reason: '实验未注册', params: {} };
  const control = def.variants.find((v) => v.id === 'control') || def.variants[0];
  const ov = overrides && typeof overrides === 'object' ? overrides : {};
  if (ov.paused) {
    return { experimentId: def.id, variantId: control.id, inExperiment: false, reason: '实验已暂停（回退到对照）', params: control.params };
  }
  if (ov.forceVariant && def.variants.some((v) => v.id === ov.forceVariant)) {
    const forced = def.variants.find((v) => v.id === ov.forceVariant);
    return { experimentId: def.id, variantId: forced.id, inExperiment: true, reason: `人工指定变体：${forced.id}`, params: forced.params };
  }
  const enabled = ov.enabled === true || (ov.enabled === undefined && def.enabled === true);
  if (!enabled) {
    return { experimentId: def.id, variantId: control.id, inExperiment: false, reason: '灰度未开启（默认走对照，行为与开启前一致）', params: control.params };
  }
  const allocation = typeof ov.allocation === 'number' ? ov.allocation : def.allocation;
  const bucket = experimentBucket(def.id, subjectId);
  const inTreatment = bucket < Math.round(Math.max(0, Math.min(1, allocation)) * 10000);
  const chosen = inTreatment ? (def.variants.find((v) => v.id !== control.id) || control) : control;
  return {
    experimentId: def.id, variantId: chosen.id, inExperiment: inTreatment, bucket,
    reason: inTreatment ? `命中实验桶（${bucket}/10000 < ${allocation}）` : `未命中实验桶（${bucket}/10000 ≥ ${allocation}）`,
    params: chosen.params,
  };
}

/** 实时把实验参数翻译成策略覆盖（目前只支持确认档位与候选提示两个参数）。 */
export function experimentPolicyOverrides(assignment) {
  const p = (assignment && assignment.params) || {};
  const out = {};
  if (p.executionGuard) out.executionGuard = p.executionGuard;
  if (typeof p.candidateHint === 'boolean') out.candidateHint = p.candidateHint;
  return out;
}

function rate(numerator, denominator) {
  if (!denominator) return 0;
  return Number((numerator / denominator).toFixed(4));
}

/**
 * 汇总一次实验的在线样本：
 * samples = [{ variantId, metrics: { guardAskRate, confirmAbandonRate, turnLatencyMs, ... }, ts }]
 * 返回各变体的样本量、指标均值、对照差值、护栏违规与判定。
 */
export function summarizeExperiment({ experiment, samples = [] } = {}) {
  const def = typeof experiment === 'string' ? EXPERIMENT_REGISTRY[experiment] : experiment;
  if (!def) return { ok: false, reason: '实验未注册' };
  const byVariant = {};
  for (const v of def.variants) byVariant[v.id] = [];
  for (const s of samples || []) {
    if (s && byVariant[s.variantId]) byVariant[s.variantId].push(s);
  }
  const control = byVariant.control || [];
  const variant = def.variants.find((v) => v.id !== 'control') || def.variants[1] || def.variants[0];
  const treatment = byVariant[variant.id] || [];
  const mean = (list, key) => {
    const nums = list.map((x) => Number(x.metrics && x.metrics[key])).filter((n) => Number.isFinite(n));
    return nums.length ? Number((nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(4)) : null;
  };
  const metricKey = def.metric.key;
  const controlMean = mean(control, metricKey);
  const treatmentMean = mean(treatment, metricKey);
  const delta = (controlMean === null || treatmentMean === null) ? null : Number((treatmentMean - controlMean).toFixed(4));

  // 比率类指标给 95% Wilson 区间；非比率（如延迟）不给区间，也不据此提升
  const ciFor = (list) => {
    const nums = list.map((x) => Number(x.metrics && x.metrics[metricKey])).filter((n) => Number.isFinite(n));
    if (!nums.length) return null;
    const k = nums.filter((n) => n > 0).length;
    return computeWilsonConfidenceInterval(k, nums.length);
  };
  const controlCi = ciFor(control);
  const treatmentCi = ciFor(treatment);

  // 护栏（先算违规，违规直接盖过一切「提升」结论）
  const violations = [];
  const g = def.guardrails || {};
  if (g.maxConfirmAbandonRate !== undefined) {
    const abandon = mean(treatment, 'confirmAbandonRate');
    if (abandon !== null && abandon > g.maxConfirmAbandonRate) {
      violations.push(`确认放弃率 ${abandon} > 上限 ${g.maxConfirmAbandonRate}`);
    }
  }
  if (g.maxTurnLatencyMs !== undefined) {
    const lat = mean(treatment, 'turnLatencyMs');
    if (lat !== null && lat > g.maxTurnLatencyMs) violations.push(`平均回合耗时 ${Math.round(lat)}ms > 上限 ${g.maxTurnLatencyMs}ms`);
  }
  if (g.maxPromptGrowthChars !== undefined) {
    const growth = mean(treatment, 'promptGrowthChars');
    if (growth !== null && growth > g.maxPromptGrowthChars) violations.push(`提示词增长 ${Math.round(growth)} 字符 > 上限 ${g.maxPromptGrowthChars}`);
  }

  const d = def.decision || {};
  const minSamples = d.minSamples || 10;
  const minDelta = d.minDelta || 0.05;
  const maxRegression = d.maxRegression || 0.05;
  const enough = control.length >= minSamples && treatment.length >= minSamples;

  let action = EXPERIMENT_DECISIONS.KEEP;
  let reason = '';
  if (violations.length) {
    action = EXPERIMENT_DECISIONS.ROLLBACK;
    reason = `护栏被触碰：${violations.join('；')} —— 立即退回对照并停止灰度`;
  } else if (delta !== null && delta <= -maxRegression) {
    action = EXPERIMENT_DECISIONS.ROLLBACK;
    reason = `变体明显退化（${metricKey} ${delta} ≤ -${maxRegression}）`;
  } else if (!enough) {
    action = EXPERIMENT_DECISIONS.KEEP;
    reason = `样本不足（对照 ${control.length} / 变体 ${treatment.length}，需各 ≥ ${minSamples}）`;
  } else if (delta !== null && delta >= minDelta && treatmentCi && controlCi && treatmentCi.lower > controlCi.upper) {
    action = EXPERIMENT_DECISIONS.PROMOTE;
    reason = `变体优于对照（${metricKey} ${delta} ≥ ${minDelta}，且 95% 区间不重叠 [${treatmentCi.lower}, ${treatmentCi.upper}] vs [${controlCi.lower}, ${controlCi.upper}]）`;
  } else {
    action = EXPERIMENT_DECISIONS.KEEP;
    reason = delta === null ? '缺少可比指标' : `差异未达提升门槛（${metricKey} ${delta}，需 ≥ ${minDelta} 且区间不重叠）`;
  }

  return {
    ok: true,
    policyVersion: EXPERIMENT_POLICY_VERSION,
    experimentId: def.id,
    metricKey,
    control: { variantId: 'control', samples: control.length, mean: controlMean, ci: controlCi },
    treatment: { variantId: variant.id, samples: treatment.length, mean: treatmentMean, ci: treatmentCi },
    delta,
    guardrailViolations: violations,
    action,
    reason,
    decidedAt: Date.now(),
  };
}

/**
 * 离线对拍：同一批用例在两个变体下各跑一遍，比 P/R/F1。
 * runs = { control: { cases: [{ id, category, ok, expected, predicted }] }, treatment: {...} }
 */
export function compareOfflineVariants({ experiment, runs = {}, tolerance = 0.02 } = {}) {
  const summarize = (list) => {
    const cases = Array.isArray(list) ? list : [];
    const tp = cases.filter((c) => c.expected === true && c.predicted === true).length;
    const fp = cases.filter((c) => c.expected === false && c.predicted === true).length;
    const fn = cases.filter((c) => c.expected === true && c.predicted === false).length;
    const tn = cases.filter((c) => c.expected === false && c.predicted === false).length;
    const precision = rate(tp, tp + fp);
    const recall = rate(tp, tp + fn);
    const f1 = (precision + recall) ? Number(((2 * precision * recall) / (precision + recall)).toFixed(4)) : 0;
    return { n: cases.length, tp, fp, fn, tn, precision, recall, f1, failures: cases.filter((c) => c.expected !== c.predicted) };
  };
  const control = summarize(runs.control);
  const treatment = summarize(runs.treatment);
  const f1Delta = Number((treatment.f1 - control.f1).toFixed(4));
  const byCategory = {};
  for (const cat of new Set([...control.failures, ...treatment.failures].map((c) => c.category))) {
    const cF = control.failures.filter((c) => c.category === cat).length;
    const tF = treatment.failures.filter((c) => c.category === cat).length;
    byCategory[cat] = { controlFailures: cF, treatmentFailures: tF, delta: tF - cF };
  }
  const def = typeof experiment === 'string' ? EXPERIMENT_REGISTRY[experiment] : experiment;
  const minDelta = (def && def.decision && def.decision.minDelta) || 0.05;
  let action = EXPERIMENT_DECISIONS.KEEP;
  let reason = '';
  if (f1Delta <= -tolerance) {
    action = EXPERIMENT_DECISIONS.ROLLBACK;
    reason = `离线 F1 退化 ${f1Delta}（超过容差 -${tolerance}）：不上线，回退变体`;
  } else if (f1Delta >= minDelta) {
    action = EXPERIMENT_DECISIONS.PROMOTE;
    reason = `离线 F1 提升 ${f1Delta} ≥ ${minDelta}：可进入小流量灰度`;
  } else {
    action = EXPERIMENT_DECISIONS.KEEP;
    reason = `离线差异 ${f1Delta} 在容差与提升门槛之间：保持现状，不灰度`;
  }
  return {
    ok: true, policyVersion: EXPERIMENT_POLICY_VERSION,
    experimentId: def ? def.id : '', metricKey: 'f1',
    control, treatment, f1Delta, byCategory, action, reason, decidedAt: Date.now(),
  };
}

export function formatExperimentReport(result) {
  if (!result || !result.ok) return `【策略实验】${(result && result.reason) || '无数据'}`;
  const pct = (x) => (x === null || x === undefined ? '-' : `${(x * 100).toFixed(1)}%`);
  const lines = [
    `【策略实验 · ${result.experimentId}】指标 ${result.metricKey}`,
    `  · 对照 ${result.control.variantId}：n=${result.control.samples} 均值 ${pct(result.control.mean)}${result.control.ci ? `（95% CI ${pct(result.control.ci.lower)}–${pct(result.control.ci.upper)}）` : ''}`,
    `  · 变体 ${result.treatment.variantId}：n=${result.treatment.samples} 均值 ${pct(result.treatment.mean)}${result.treatment.ci ? `（95% CI ${pct(result.treatment.ci.lower)}–${pct(result.treatment.ci.upper)}）` : ''}`,
    `  · 差值 ${result.delta === null ? '-' : result.delta} · 判定 ${result.action}：${result.reason}`,
  ];
  if (result.guardrailViolations && result.guardrailViolations.length) {
    lines.push(`  · 护栏违规：${result.guardrailViolations.join('；')}`);
  }
  return lines.join('\n');
}

export function formatOfflineAB(result) {
  if (!result || !result.ok) return '【离线对拍】无数据';
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const lines = [
    `【离线对拍 · ${result.experimentId}】control F1 ${pct(result.control.f1)}（n=${result.control.n}） vs treatment F1 ${pct(result.treatment.f1)}（n=${result.treatment.n}）`,
    `  · 差值 ${result.f1Delta} · 判定 ${result.action}：${result.reason}`,
  ];
  for (const [cat, v] of Object.entries(result.byCategory || {})) {
    lines.push(`  · ${cat}：对照失败 ${v.controlFailures} / 变体失败 ${v.treatmentFailures}（${v.delta > 0 ? '+' : ''}${v.delta}）`);
  }
  return lines.join('\n');
}

/** 实验台账：记录本次分配与结果，便于事后复现与回退决策。 */
export function appendExperimentSample(log = [], sample = {}, max = 64) {
  const next = [...(Array.isArray(log) ? log : []), { ...sample, at: sample.at || Date.now() }];
  return next.slice(-max);
}

export function summarizeExperimentHealth(state = {}) {
  const assignments = state.experimentAssignments || {};
  const samples = state.experimentSamples || [];
  const inExperiment = Object.values(assignments).filter((a) => a && a.inExperiment).length;
  const rolledBack = (state.experimentRollbacks || []).length;
  return {
    registered: Object.keys(EXPERIMENT_REGISTRY).length,
    enabled: Object.values(EXPERIMENT_REGISTRY).filter((e) => e.enabled).length,
    activeAssignments: inExperiment,
    samples: samples.length,
    rollbacks: rolledBack,
  };
}
