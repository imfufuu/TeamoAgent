// ─── P2（Dubhe Helix 2.5）：策略版本注册表与执行级快照 ──────────────────────────
// 目标（对应 P2 第 19 条）：一次执行的审计记录必须能回答「当时生效的是哪套策略」。
// 没有这层绑定，效果退化时无法判断是模型、路由规则、提示词还是工具契约导致的差异。
//
// 设计取舍：
//   · 注册表是**静态常量**，不在这里 import 各模块——避免 policy.js 变成一个把所有模块
//     拖进依赖图的中转站（混版缓存下最先可用的模块不该被拖累）。
//   · 版本漂移靠 verifyPolicyRegistry() 在测试/`/nexus` 里**动态 import** 各模块比对，
//     任何模块升版但注册表没跟 → 直接红灯，而不是悄悄给出错误的审计口径。
export const POLICY_REGISTRY_VERSION = 'policy-registry-2.5.0';

// key = 审计里用的字段名；module = 拥有该版本的模块；exportName = 该模块导出的常量
export const POLICY_SOURCES = Object.freeze({
  routerPolicyVersion: { module: './nexus.js', exportName: 'DUBHE_ROUTER_POLICY_VERSION', label: '路由 / 档位策略' },
  toolPolicyVersion: { module: './execution.js', exportName: 'TOOL_CONTRACT_VERSION', label: '工具契约策略' },
  riskPolicyVersion: { module: './execution.js', exportName: 'RISK_POLICY_VERSION', label: '风险分级策略' },
  budgetPolicyVersion: { module: './execution.js', exportName: 'BUDGET_POLICY_VERSION', label: '预算治理策略' },
  promptContractVersion: { module: './execution.js', exportName: 'PROMISE_POLICY_VERSION', label: '提示词契约' },
  auditSchemaVersion: { module: './execution.js', exportName: 'AUDIT_SCHEMA_VERSION', label: '审计结构' },
  executionPolicyVersion: { module: './execution.js', exportName: 'EXECUTION_POLICY_VERSION', label: '执行内核总策略' },
  confirmationPolicyVersion: { module: './execution.js', exportName: 'CONFIRMATION_POLICY_VERSION', label: '交互确认策略' },
  recoveryPolicyVersion: { module: './recovery.js', exportName: 'RECOVERY_POLICY_VERSION', label: '检查点 / 恢复策略' },
  idempotencyPolicyVersion: { module: './idempotency.js', exportName: 'IDEMPOTENCY_POLICY_VERSION', label: '幂等 / 回放策略' },
  memoryPolicyVersion: { module: './memorylife.js', exportName: 'MEMORY_POLICY_VERSION', label: '记忆生命周期策略' },
  trajectoryPolicyVersion: { module: './trajectory.js', exportName: 'TRAJECTORY_POLICY_VERSION', label: '轨迹评测策略' },
  experimentPolicyVersion: { module: './experiments.js', exportName: 'EXPERIMENT_POLICY_VERSION', label: '策略实验 / 灰度' },
});

// 当前生效版本（静态声明；与各模块的漂移由 verifyPolicyRegistry 兜住）
export const POLICY_VERSIONS = Object.freeze({
  routerPolicyVersion: 'dubhe-router-policy-2.5.0',
  toolPolicyVersion: 'tool-contract-2.4.1',
  riskPolicyVersion: 'risk-policy-2.5.0',
  budgetPolicyVersion: 'budget-policy-2.3.0',
  promptContractVersion: 'prompt-contract-2.3.0',
  auditSchemaVersion: 'exec-audit-schema-1',
  executionPolicyVersion: 'policy-2.5.0',
  confirmationPolicyVersion: 'confirm-policy-2.5.0',
  recoveryPolicyVersion: 'recovery-policy-2.5.0',
  idempotencyPolicyVersion: 'idem-policy-2.4.1',
  memoryPolicyVersion: 'memory-policy-2.5.0',
  trajectoryPolicyVersion: 'trajectory-policy-2.4.0',
  experimentPolicyVersion: 'experiment-policy-2.5.0',
});

/** 执行级策略快照：冻结对象，直接塞进审计/执行记录，事后可逐条比对。 */
export function snapshotPolicies({ now = () => Date.now() } = {}) {
  return Object.freeze({
    registryVersion: POLICY_REGISTRY_VERSION,
    takenAt: now(),
    versions: Object.freeze({ ...POLICY_VERSIONS }),
  });
}

/** 两份快照之间有哪些策略发生了变更（用于「同一会话前后两次执行的策略对比」）。 */
export function diffPolicySnapshots(a, b) {
  const left = (a && a.versions) || {};
  const right = (b && b.versions) || {};
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])];
  const changes = [];
  for (const k of keys) {
    if (left[k] !== right[k]) changes.push({ key: k, from: left[k] || '(缺失)', to: right[k] || '(缺失)' });
  }
  return { changed: changes.length > 0, changes, count: changes.length };
}

/**
 * 漂移自检：动态加载各模块，比对注册表声明。
 * 返回 { ok, mismatches: [{ key, declared, actual, module }] }。
 * 只在测试与 /nexus 报告里调用（动态 import，不进启动路径）。
 */
export async function verifyPolicyRegistry() {
  const mismatches = [];
  const checked = [];
  for (const [key, src] of Object.entries(POLICY_SOURCES)) {
    const declared = POLICY_VERSIONS[key];
    try {
      const mod = await import(src.module);
      const actual = mod[src.exportName];
      if (actual === undefined) {
        mismatches.push({ key, declared, actual: '(模块未导出)', module: src.module, exportName: src.exportName });
      } else if (String(actual) !== String(declared)) {
        mismatches.push({ key, declared, actual: String(actual), module: src.module, exportName: src.exportName });
      } else {
        checked.push(key);
      }
    } catch (err) {
      mismatches.push({ key, declared, actual: `(加载失败：${(err && err.message) || err})`, module: src.module });
    }
  }
  return { ok: mismatches.length === 0, registryVersion: POLICY_REGISTRY_VERSION, checked: checked.length, total: Object.keys(POLICY_SOURCES).length, mismatches };
}

export function formatPolicyLine(snapshot = snapshotPolicies()) {
  const v = snapshot.versions || {};
  return `【策略版本】${snapshot.registryVersion} · 路由 ${v.routerPolicyVersion} · 工具契约 ${v.toolPolicyVersion} · 风险 ${v.riskPolicyVersion} · 记忆 ${v.memoryPolicyVersion} · 轨迹 ${v.trajectoryPolicyVersion} · 实验 ${v.experimentPolicyVersion}`;
}

export function formatPolicyDriftReport(result) {
  if (!result) return '';
  if (result.ok) return `策略版本一致：${result.checked}/${result.total} 项与各模块导出一致（注册表 ${result.registryVersion}）`;
  const lines = [`⚠️ 策略版本漂移 ${result.mismatches.length} 项（注册表声明 ≠ 模块实际导出）：`];
  for (const m of result.mismatches) {
    lines.push(`  · ${m.key}：声明 ${m.declared} ≠ 实际 ${m.actual}（${m.module}::${m.exportName || '-'}）`);
  }
  return lines.join('\n');
}
