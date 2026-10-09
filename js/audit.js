// ─── P2（Dubhe Helix 2.5）：审计目标分层与对账 ──────────────────────────────────
// 目标（P2 第 16/17 条）：不要把「SHA-256 链式足迹」说成单一的安全证明，而要分清三种目标：
//
//   · 完整性 integrity   —— 记录有没有被改过：逐事件重算哈希 + 前序衔接（链式哈希能覆盖）
//   · 完备性 completeness —— 有没有漏事件：执行记录 / 幂等账本 / 检查点 ↔ 审计事件双向对账
//   · 真实性 authenticity —— 事件是否真由指定执行环境产生（链式哈希**不能**覆盖，需硬件远程证明）
//
// 本模块只做前两项的**独立复核**与第三项的**如实声明**；它不生产审计事件（那是执行内核的事），
// 所以它可以站在「外部 Store」的位置去核对内核写下的东西——这也是它唯一有资格做的事。
import { sha256Hex, GENESIS_TURN_DIGEST } from './nexus.js';
import { AUDIT_SCHEMA_VERSION, canonicalJSON, verifyExecutionAudit } from './execution.js?v=2026.10.9.1';

export const AUDIT_TRACE_POLICY_VERSION = 'audit-trace-2.5.0';

export const AUDIT_GOALS = Object.freeze({
  integrity: {
    id: 'integrity',
    label: '完整性',
    question: '记录是否被修改过？',
    mechanism: '逐事件重算事件哈希 + 前序衔接校验（链式 SHA-256 足迹）',
    covered: true,
  },
  completeness: {
    id: 'completeness',
    label: '完备性',
    question: '是否遗漏了某些工具事件？',
    mechanism: '执行记录 / 幂等账本 / 检查点 ↔ 审计事件双向对账（外部 Store 侧复核）',
    covered: true,
  },
  authenticity: {
    id: 'authenticity',
    label: '真实性',
    question: '事件是否真的由指定执行环境产生？',
    mechanism: '需要硬件远程证明（TEE / 远程证明链）；链式哈希本身不能证明，本架构不做该声明',
    covered: false,
  },
});

/**
 * 上下文与版本绑定：一次执行的所有审计事件都必须能被「哪套策略、哪个版本、哪个会话」唯一确定。
 * 返回绑定摘要（用于事件头与报告展示，不替代内核自己的哈希）。
 */
export function bindAuditContext({
  schemaVersion = AUDIT_SCHEMA_VERSION,
  sessionId = 'local',
  turnId = 'turn-local',
  eventIndex = 0,
  previousDigest = GENESIS_TURN_DIGEST,
  eventType = '',
  payload = {},
  policyVersions = {},
} = {}) {
  const material = [
    String(schemaVersion), String(sessionId), String(turnId), String(eventIndex),
    String(previousDigest), String(eventType), canonicalJSON(payload),
    canonicalJSON(policyVersions),
  ].join('|');
  return { contextDigest: sha256Hex(material), boundKeys: Object.keys(policyVersions || {}).sort(), material };
}

/**
 * 对账：站在外部 Store 的位置，核验一次执行的审计足迹。
 * 输入都是「已经落盘/落记录」的东西，任何一项拿不到就如实标记为不可判定。
 */
export function reconcileAudit({
  auditEvents = null,
  declared = null,
  record = null,
  ledgerEntries = [],
  checkpoints = [],
  policySnapshot = null,
} = {}) {
  const events = Array.isArray(auditEvents) ? auditEvents : (auditEvents && Array.isArray(auditEvents.events) ? auditEvents.events : []);
  const declaredSchema = (declared && declared.schemaVersion) || AUDIT_SCHEMA_VERSION;
  const declaredPolicy = (declared && declared.policyVersion) || '';
  const declaredSession = (declared && declared.sessionId) || (auditEvents && auditEvents.sessionId) || '';
  const declaredTurn = (declared && declared.turnId) || (auditEvents && auditEvents.turnId) || '';

  // ── ① 完整性：链式复核 + 版本/上下文一致性 ──
  const chain = verifyExecutionAudit(events.length ? events : null);
  const crossVersion = [];
  for (const ev of events) {
    if (ev && ev.schemaVersion && String(ev.schemaVersion) !== String(declaredSchema)) {
      crossVersion.push({ index: ev.index, field: 'schemaVersion', value: ev.schemaVersion, declared: declaredSchema });
    }
    if (declaredPolicy && ev && ev.policyVersion && String(ev.policyVersion) !== String(declaredPolicy)) {
      crossVersion.push({ index: ev.index, field: 'policyVersion', value: ev.policyVersion, declared: declaredPolicy });
    }
    if (declaredSession && ev && ev.sessionId && String(ev.sessionId) !== String(declaredSession)) {
      crossVersion.push({ index: ev.index, field: 'sessionId', value: ev.sessionId, declared: declaredSession });
    }
    if (declaredTurn && ev && ev.turnId && String(ev.turnId) !== String(declaredTurn)) {
      crossVersion.push({ index: ev.index, field: 'turnId', value: ev.turnId, declared: declaredTurn });
    }
  }
  const integrity = {
    goal: 'integrity',
    ok: !!chain.valid && crossVersion.length === 0,
    checked: chain.checked || 0,
    mismatches: chain.mismatches || [],
    crossVersion,
    digest: chain.digest || '',
  };

  // ── ② 完备性：记录 ↔ 事件双向对账 ──
  const runs = record && Array.isArray(record.toolRuns) ? record.toolRuns : [];
  const transitions = record && Array.isArray(record.transitions) ? record.transitions : [];
  const starts = events.filter((e) => e && e.eventType === 'tool-call-start');
  const ends = events.filter((e) => e && e.eventType === 'tool-call-end');
  const stateEvents = events.filter((e) => e && e.eventType === 'state-transition');
  const missing = [];
  for (const r of runs) {
    if (!starts.some((e) => e.payload && Number(e.payload.index) === Number(r.index))) missing.push(`tool-call-start#${r.index}(${r.name})`);
    if (!ends.some((e) => e.payload && Number(e.payload.index) === Number(r.index))) missing.push(`tool-call-end#${r.index}(${r.name})`);
  }
  const extraCalls = [...starts, ...ends]
    .filter((e) => e.payload && !runs.some((r) => Number(r.index) === Number(e.payload.index)))
    .map((e) => `${e.eventType}#${e.payload.index}`);
  for (const t of transitions) {
    // 转移记录带 seq 时按 seq 精确核对，否则退化到「存在一条同 from→to 的转移事件」
    const hit = t.seq !== undefined && t.seq !== null
      ? stateEvents.some((e) => e.payload && Number(e.payload.seq) === Number(t.seq))
      : stateEvents.some((e) => e.payload && e.payload.from === t.from && e.payload.to === t.to);
    if (!hit) missing.push(`state-transition:${t.from}→${t.to}`);
  }
  // P1/P2 记录也要能在审计里对上（拿不到就如实标为不可判定，而不是判通过）
  const turnLedger = (ledgerEntries || []).filter((e) => e && e.turnId && (!declaredTurn || e.turnId === declaredTurn));
  const ledgerGaps = turnLedger
    .filter((e) => e.status === 'succeeded')
    .filter((e) => !ends.some((ev) => ev.payload && ev.payload.name === e.tool))
    .map((e) => `${e.tool}(${e.key})`);
  const checkpointGaps = (checkpoints || [])
    .filter((c) => c && c.turnId && (!declaredTurn || c.turnId === declaredTurn))
    .filter((c) => !events.some((ev) => ev && ev.eventType === 'checkpoint' && ev.payload && ev.payload.checkpointId === c.checkpointId))
    .map((c) => c.checkpointId);
  const completeness = {
    goal: 'completeness',
    ok: missing.length === 0 && extraCalls.length === 0 && ledgerGaps.length === 0 && checkpointGaps.length === 0,
    expected: { toolRuns: runs.length, transitions: transitions.length, ledgerEntries: turnLedger.length, checkpoints: (checkpoints || []).length },
    observed: { starts: starts.length, ends: ends.length, stateTransitions: stateEvents.length, events: events.length },
    missing, extraCalls, ledgerGaps, checkpointGaps,
    note: runs.length === 0 && transitions.length === 0 ? '没有执行记录可对账（未发生工具调用的回合）' : '',
  };

  // ── ③ 真实性：不做声明，只如实说明 ──
  const authenticity = {
    goal: 'authenticity',
    ok: null,               // null = 本架构不做该声明（不是通过，也不是失败）
    claimed: false,
    mechanism: AUDIT_GOALS.authenticity.mechanism,
    reason: '链式哈希只能证明「记录未被改动」，不能证明「事件真的由指定环境产生」；需要硬件远程证明，本架构不声明此项。',
  };

  const failing = [];
  if (!integrity.ok) failing.push('完整性');
  if (!completeness.ok) failing.push('完备性');
  const statement = failing.length
    ? `审计复核未通过：${failing.join('、')} 未满足。完整性/完备性问题必须当缺陷处理，不能用「足迹已上链」搪塞过去。`
    : `审计复核：完整性与完备性均通过（${integrity.checked} 条事件链自洽，${completeness.observed.events} 条事件覆盖 ${completeness.expected.toolRuns} 次调用 / ${completeness.expected.transitions} 次转移）；真实性不声明（需硬件远程证明）。`;

  return {
    policyVersion: AUDIT_TRACE_POLICY_VERSION,
    ok: integrity.ok && completeness.ok,
    integrity,
    completeness,
    authenticity,
    policySnapshot: policySnapshot ? { registryVersion: policySnapshot.registryVersion, versions: policySnapshot.versions } : null,
    statement,
    checkedAt: Date.now(),
  };
}

export function formatAuditGoalsReport(result) {
  if (!result) return '【审计目标】无数据';
  const mark = (b) => (b === null ? '不声明' : (b ? '通过' : '未通过'));
  const lines = [
    `【审计目标分层】${result.policyVersion}`,
    `  · 完整性 ${mark(result.integrity.ok)}：${result.integrity.checked} 条事件重算哈希，链不匹配 ${result.integrity.mismatches.length} 处，版本/上下文不一致 ${result.integrity.crossVersion.length} 处`,
    `  · 完备性 ${mark(result.completeness.ok)}：调用 ${result.completeness.expected.toolRuns} 次 / 转移 ${result.completeness.expected.transitions} 次 ↔ 事件 ${result.completeness.observed.events} 条；缺失 ${result.completeness.missing.length} 项、多余 ${result.completeness.extraCalls.length} 项、账本缺事件 ${result.completeness.ledgerGaps.length} 项、检查点缺事件 ${result.completeness.checkpointGaps.length} 项`,
    `  · 真实性 ${mark(result.authenticity.ok)}：${result.authenticity.reason}`,
    `  ${result.statement}`,
  ];
  return lines.join('\n');
}

/** 产品文案 / 界面里应当使用的准确表述（避免把足迹说成安全证明）。 */
export function auditBoundaryStatement() {
  return [
    '完整性：链式 SHA-256 足迹可以检出记录被修改、插删或重排。',
    '完备性：靠外部 Store 对账（执行记录 / 幂等账本 / 检查点 ↔ 审计事件）来发现遗漏。',
    '真实性：本架构不声明——事件是否真由指定执行环境产生需要硬件远程证明。',
  ].join('\n');
}
