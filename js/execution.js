// ─── Dubhe Helix 2.5（天枢2.5） · P0 执行内核（Execution Kernel）──────────────────────
// 目标（对应 P0 三件事）：把 Dubhe Helix 2.5 从「能选择工具的 Agent」提升为「能安全管理执行过程的 Agent」。
//
//   1. 统一执行状态机：路由 / 工具 / 审计 / 重试共用一条显式状态轨迹，
//      每次转移都记录 { turnId, from, to, reason, timestamp, policyVersion }。
//   2. 预算与风险治理：Token 之外的资源预算（工具调用 / 重试 / 墙钟 / 并发 / 记忆写 / 外部副作用）
//      实时扣减并写入轨迹；工具风险按 L0–L3 分级，高风险操作生成「最小信息确认请求」。
//   3. 工具调用前后契约校验：每个工具声明输入 Schema、副作用、幂等性、重试策略、
//      超时与回滚；调用前做 Schema / 能力 / 约束 / 预算 / 幂等键校验，调用后做结果与副作用核验。
//
// 设计纪律（与全仓一致，不夸大）：
//   · 纯函数优先、无副作用、可离线单测（node tests/agent.test.mjs）；
//   · 只回答「谁在什么时候基于什么理由进了哪个状态」，不做安全证明、不宣称绝对正确；
//   · 每次拦截 / 降级都必须带 reason + recovery（可解释 + 可恢复）；
//   · 所有策略独立版本化，并绑定进审计事件哈希（版本不一致的轨迹不会被误认为同一条）。
//
// 与既有模块的关系：本模块只依赖 nexus.js 的 SHA-256 实现（FIPS 180-4），
// 不反向被 nexus.js 依赖，因此不存在循环引用。SHA-256 轨迹的边界声明（完整性/完备性/真实性）：
// 覆盖「完整性」（记录是否被改动），部分覆盖「完备性」（与 Store 消息对账），
// 不能证明「真实性」（事件是否真由指定执行环境产生，需硬件远程证明，本架构不做此声明）。

import { sha256Hex, GENESIS_TURN_DIGEST } from './nexus.js';

// ── 0. 策略版本（一次执行的审计记录必须记录这些版本，否则无法归因退化来源）──
export const EXECUTION_KERNEL_VERSION = '2.3.0';
export const EXECUTION_POLICY_VERSION = 'policy-2.5.0';
export const TOOL_CONTRACT_VERSION = 'tool-contract-2.4.1';
export const BUDGET_POLICY_VERSION = 'budget-policy-2.3.0';
export const RISK_POLICY_VERSION = 'risk-policy-2.5.0';
export const PROMISE_POLICY_VERSION = 'prompt-contract-2.3.0';
export const AUDIT_SCHEMA_VERSION = 'exec-audit-schema-1';
export const STATE_SCHEMA_VERSION = 'exec-state-schema-1';
export const TRANSITION_TABLE_VERSION = 'transition-table-2.3.0';

// ── 1. 显式执行状态机 ────────────────────────────────────────────────────
// 正常路径：RECEIVED → CLASSIFIED → PLANNED → TOOL_PENDING → TOOL_RUNNING
//           → TOOL_SUCCEEDED → …（多步循环）… → ANSWERING → VERIFIED → COMMITTED
// 异常路径（必须显式建模，不允许「失败后悄悄进入最终回答」）：
//   TOOL_FAILED → RETRY_PENDING            （暂时性错误，有限退避重试）
//   TOOL_FAILED → RECOVERY_PENDING         （副作用不确定 / 需先核验状态）
//   TOOL_FAILED → ANSWERING_WITH_LIMITATION（不可重试，带限制作答并披露）
//   TOOL_RUNNING → INTERRUPTED             （用户中止 / 页面刷新 / 网络中断）
export const EXECUTION_STATES = Object.freeze({
  RECEIVED: 'RECEIVED',
  CLASSIFIED: 'CLASSIFIED',
  PLANNED: 'PLANNED',
  TOOL_PENDING: 'TOOL_PENDING',
  TOOL_RUNNING: 'TOOL_RUNNING',
  TOOL_SUCCEEDED: 'TOOL_SUCCEEDED',
  TOOL_FAILED: 'TOOL_FAILED',
  RETRY_PENDING: 'RETRY_PENDING',
  RECOVERY_PENDING: 'RECOVERY_PENDING',
  ANSWERING: 'ANSWERING',
  ANSWERING_WITH_LIMITATION: 'ANSWERING_WITH_LIMITATION',
  VERIFIED: 'VERIFIED',
  COMMITTED: 'COMMITTED',
  INTERRUPTED: 'INTERRUPTED',
});

export const EXECUTION_STATE_ORDER = Object.freeze(Object.values(EXECUTION_STATES));
export const TERMINAL_STATES = Object.freeze([EXECUTION_STATES.COMMITTED, EXECUTION_STATES.INTERRUPTED]);
// 被中断 / 刷新后可以续跑的入口态（resumeExecutionState 使用）
export const RESUME_ENTRY_STATES = Object.freeze([
  EXECUTION_STATES.RECOVERY_PENDING,
  EXECUTION_STATES.TOOL_PENDING,
  EXECUTION_STATES.ANSWERING,
]);

export const EXECUTION_STATE_LABELS = Object.freeze({
  RECEIVED: '已接收',
  CLASSIFIED: '已分类（任务类型 + 能力掩码已定）',
  PLANNED: '已计划',
  TOOL_PENDING: '等待工具调用',
  TOOL_RUNNING: '工具执行中',
  TOOL_SUCCEEDED: '工具成功',
  TOOL_FAILED: '工具失败',
  RETRY_PENDING: '等待重试',
  RECOVERY_PENDING: '等待恢复（需先核验状态）',
  ANSWERING: '生成回答',
  ANSWERING_WITH_LIMITATION: '带限制作答（已披露未完成项）',
  VERIFIED: '已回答核验',
  COMMITTED: '已提交',
  INTERRUPTED: '已中断',
});

// 合法转移表。关键约束（由 validateTransitionTable 断言）：
//   · COMMITTED 只能从 VERIFIED 进入 —— 工具失败绝不可能「隐式成功收尾」；
//   · 工具态不允许自环（TOOL_RUNNING → TOOL_RUNNING 非法）—— 每次转移都必须有可辨识的事件。
export const LEGAL_TRANSITIONS = Object.freeze({
  RECEIVED: ['CLASSIFIED', 'INTERRUPTED'],
  CLASSIFIED: ['PLANNED', 'ANSWERING', 'INTERRUPTED'],
  PLANNED: ['TOOL_PENDING', 'ANSWERING', 'INTERRUPTED'],
  TOOL_PENDING: ['TOOL_RUNNING', 'ANSWERING_WITH_LIMITATION', 'INTERRUPTED'],
  TOOL_RUNNING: ['TOOL_SUCCEEDED', 'TOOL_FAILED', 'RETRY_PENDING', 'RECOVERY_PENDING', 'INTERRUPTED'],
  TOOL_SUCCEEDED: ['TOOL_PENDING', 'ANSWERING', 'INTERRUPTED'],
  TOOL_FAILED: ['RETRY_PENDING', 'RECOVERY_PENDING', 'TOOL_PENDING', 'ANSWERING_WITH_LIMITATION', 'INTERRUPTED'],
  RETRY_PENDING: ['TOOL_RUNNING', 'TOOL_PENDING', 'TOOL_FAILED', 'ANSWERING_WITH_LIMITATION', 'INTERRUPTED'],
  RECOVERY_PENDING: ['TOOL_RUNNING', 'TOOL_PENDING', 'TOOL_FAILED', 'ANSWERING_WITH_LIMITATION', 'INTERRUPTED'],
  ANSWERING: ['VERIFIED', 'ANSWERING_WITH_LIMITATION', 'INTERRUPTED'],
  ANSWERING_WITH_LIMITATION: ['VERIFIED', 'INTERRUPTED'],
  VERIFIED: ['COMMITTED', 'INTERRUPTED'],
  COMMITTED: [],
  INTERRUPTED: [],
});

export function isValidExecutionTransition(from, to) {
  const list = LEGAL_TRANSITIONS[String(from)];
  return Array.isArray(list) && list.includes(String(to));
}

// 转移表不变量自检：状态全集可达、非终态有出路、关键异常路径齐全、无自环、COMMITTED 只从 VERIFIED 进入
export function validateTransitionTable() {
  const states = EXECUTION_STATE_ORDER;
  const problems = [];

  for (const s of states) {
    if (!Array.isArray(LEGAL_TRANSITIONS[s])) problems.push(`missing-transition-row:${s}`);
    if ((LEGAL_TRANSITIONS[s] || []).includes(s)) problems.push(`self-loop:${s}`);
  }

  // 可达性（从 RECEIVED 出发）
  const reachable = new Set([EXECUTION_STATES.RECEIVED]);
  const stack = [EXECUTION_STATES.RECEIVED];
  while (stack.length) {
    const cur = stack.pop();
    for (const nxt of LEGAL_TRANSITIONS[cur] || []) {
      if (!reachable.has(nxt)) { reachable.add(nxt); stack.push(nxt); }
    }
  }
  for (const s of states) if (!reachable.has(s)) problems.push(`unreachable-state:${s}`);

  // 非终态必须有出路
  for (const s of states) {
    if (TERMINAL_STATES.includes(s)) continue;
    if (!(LEGAL_TRANSITIONS[s] || []).length) problems.push(`dead-end-state:${s}`);
  }

  // COMMITTED 只允许从 VERIFIED 进入（杜绝工具失败隐式收尾）
  for (const s of states) {
    if (s === EXECUTION_STATES.VERIFIED) continue;
    if ((LEGAL_TRANSITIONS[s] || []).includes(EXECUTION_STATES.COMMITTED)) {
      problems.push(`illegal-commit-entry:${s}->COMMITTED`);
    }
  }

  // 关键异常路径必须存在
  const requiredPaths = [
    [EXECUTION_STATES.TOOL_FAILED, EXECUTION_STATES.RETRY_PENDING],
    [EXECUTION_STATES.TOOL_FAILED, EXECUTION_STATES.RECOVERY_PENDING],
    [EXECUTION_STATES.TOOL_FAILED, EXECUTION_STATES.ANSWERING_WITH_LIMITATION],
    [EXECUTION_STATES.TOOL_RUNNING, EXECUTION_STATES.INTERRUPTED],
    [EXECUTION_STATES.RETRY_PENDING, EXECUTION_STATES.TOOL_RUNNING],
    [EXECUTION_STATES.RECOVERY_PENDING, EXECUTION_STATES.ANSWERING_WITH_LIMITATION],
  ];
  for (const [f, t] of requiredPaths) {
    if (!isValidExecutionTransition(f, t)) problems.push(`missing-exception-path:${f}->${t}`);
  }
  if (isValidExecutionTransition(EXECUTION_STATES.TOOL_FAILED, EXECUTION_STATES.COMMITTED)) {
    problems.push('tool-failed-can-commit-directly');
  }

  return {
    ok: problems.length === 0,
    checkedStates: states.length,
    checkedEdges: states.reduce((n, s) => n + (LEGAL_TRANSITIONS[s] || []).length, 0),
    transitionTableVersion: TRANSITION_TABLE_VERSION,
    problems,
  };
}

// ── 2. 版本化审计日志（事件哈希绑定 schema/会话/轮次/序号/前序/类型/载荷/策略版本）──
// 说明：这里解决的是「不同版本、不同会话、不同规范化方式产生形态相同的轨迹」，
// 属完整性/完备性范畴；真实性（谁真的执行了它）不在链式哈希能力范围内。
const AUDIT_MAX_PAYLOAD = 400;

export function canonicalizeValue(value, depth = 0) {
  if (value === null || value === undefined) return null;
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value) ? value : String(value);
  if (t === 'boolean') return value;
  if (t === 'bigint') return String(value);
  if (t === 'string') return value.length > AUDIT_MAX_PAYLOAD ? `${value.slice(0, AUDIT_MAX_PAYLOAD)}…[+${value.length - AUDIT_MAX_PAYLOAD}]` : value;
  if (t === 'function') return '[function]';
  if (t === 'symbol') return String(value);
  if (depth > 4) return '[deep]';
  if (Array.isArray(value)) return value.slice(0, 40).map((v) => canonicalizeValue(v, depth + 1));
  if (t === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const v = value[key];
      if (v === undefined) continue;
      out[key] = canonicalizeValue(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

export function canonicalJSON(value) {
  return JSON.stringify(canonicalizeValue(value));
}

export function createExecutionAuditLog({
  sessionId = 'local',
  turnId = 'turn-local',
  policyVersion = EXECUTION_POLICY_VERSION,
  schemaVersion = AUDIT_SCHEMA_VERSION,
  prevDigest = GENESIS_TURN_DIGEST,
  now = () => Date.now(),
} = {}) {
  const events = [];
  let head = String(prevDigest || GENESIS_TURN_DIGEST);

  const bindHash = (index, eventType, payload, previousDigest) => sha256Hex([
    schemaVersion,
    String(sessionId),
    String(turnId),
    String(index),
    String(previousDigest),
    String(eventType),
    canonicalJSON(payload),
    String(policyVersion),
  ].join('|'));

  return {
    sessionId, turnId, policyVersion, schemaVersion, events,
    prevDigest: String(prevDigest || GENESIS_TURN_DIGEST),
    get digest() { return head; },
    get eventCount() { return events.length; },
    record(eventType, payload = {}) {
      const index = events.length + 1;
      const normalized = canonicalizeValue(payload);
      const prevHash = head;
      const eventHash = bindHash(index, eventType, normalized, prevHash);
      head = eventHash;
      const ev = {
        index,
        eventType: String(eventType),
        sessionId: String(sessionId),
        turnId: String(turnId),
        prevDigest: prevHash,
        eventHash,
        payload: normalized,
        ts: now(),
        policyVersion,
        schemaVersion,
      };
      events.push(ev);
      return ev;
    },
    snapshot() {
      return { sessionId, turnId, policyVersion, schemaVersion, digest: head, eventCount: events.length };
    },
  };
}

// 独立校验器：逐事件重算哈希并检查前序衔接（任何一格被改动 / 插删都会暴露）
export function verifyExecutionAudit(input) {
  const events = Array.isArray(input) ? input : (input && Array.isArray(input.events) ? input.events : null);
  if (!events) return { valid: false, checked: 0, mismatches: ['missing-audit-events'], digest: '' };
  const mismatches = [];
  let cursor = events.length ? (events[0].prevDigest || GENESIS_TURN_DIGEST) : GENESIS_TURN_DIGEST;
  let digest = cursor;
  for (const ev of events) {
    const expected = sha256Hex([
      String(ev.schemaVersion || AUDIT_SCHEMA_VERSION),
      String(ev.sessionId || (input && input.sessionId) || 'local'),
      String(ev.turnId || (input && input.turnId) || 'turn-local'),
      String(ev.index),
      String(cursor),
      String(ev.eventType),
      canonicalJSON(ev.payload),
      String(ev.policyVersion || EXECUTION_POLICY_VERSION),
    ].join('|'));
    if (ev.prevDigest !== cursor) mismatches.push(`broken-chain-at#${ev.index}`);
    if (ev.eventHash !== expected) mismatches.push(`hash-mismatch-at#${ev.index}`);
    cursor = ev.eventHash;
    digest = ev.eventHash;
  }
  return { valid: mismatches.length === 0, checked: events.length, mismatches, digest };
}

export function replayExecutionEvents(events = []) {
  const ordered = [...(Array.isArray(events) ? events : [])].sort((a, b) => (a.index || 0) - (b.index || 0));
  const transitions = ordered.filter((e) => e.eventType === 'state-transition').map((e) => ({
    seq: e.payload && e.payload.seq,
    from: e.payload && e.payload.from,
    to: e.payload && e.payload.to,
    reason: e.payload && e.payload.reason,
    timestamp: e.payload && e.payload.timestamp,
    policyVersion: e.policyVersion,
  }));
  const violations = [];
  let cursor = 'RECEIVED';
  for (const t of transitions) {
    if (!isValidExecutionTransition(t.from, t.to)) violations.push(`illegal:${t.from}->${t.to}@${t.timestamp}`);
    if (t.from !== cursor && !violations.length) violations.push(`out-of-order:${t.from}!==${cursor}`);
    cursor = t.to;
  }
  const integrity = verifyExecutionAudit(ordered);
  return {
    transitionCount: transitions.length,
    transitions,
    reached: cursor,
    violations,
    integrityValid: integrity.valid,
    digest: integrity.digest,
    replayable: violations.length === 0 && integrity.valid,
  };
}

// ── 3. 执行状态机 ────────────────────────────────────────────────────────
// 每次转移都写入版本化审计日志（可重放），并可挂载「工具运行」级记录：
// 任意一次工具调用都能回答——为什么调用、调用前是什么状态、调用后发生了什么。
export function createExecutionStateMachine({
  turnId = 'turn-local',
  sessionId = 'local',
  policyVersion = EXECUTION_POLICY_VERSION,
  initialState = EXECUTION_STATES.RECEIVED,
  prevDigest = GENESIS_TURN_DIGEST,
  now = () => Date.now(),
} = {}) {
  if (!EXECUTION_STATE_ORDER.includes(initialState)) throw new Error(`未知初始状态：${initialState}`);
  const audit = createExecutionAuditLog({ sessionId, turnId, policyVersion, prevDigest, now });
  const transitions = [];
  const violations = [];
  const toolRuns = [];
  let state = initialState;

  if (initialState !== EXECUTION_STATES.RECEIVED) {
    // 续跑入口（刷新 / 中断后恢复）：先记一条恢复入口事件，再开始的都是显式转移
    audit.record('resume-entry', { entryState: initialState, resumedFrom: prevDigest });
  }

  const machine = {
    turnId, sessionId, policyVersion,
    audit,
    get state() { return state; },
    get phaseLabel() { return EXECUTION_STATE_LABELS[state] || state; },
    get isTerminal() { return TERMINAL_STATES.includes(state); },
    transitions,
    violations,
    toolRuns,
    get toolRunsCount() { return toolRuns.length; },

    canTransition(to) { return isValidExecutionTransition(state, to); },

    transition(to, reason = '', meta = {}) {
      const from = state;
      if (!isValidExecutionTransition(from, to)) {
        const violation = {
          kind: 'illegal-transition', from, to, reason: String(reason || ''),
          timestamp: now(), policyVersion,
        };
        violations.push(violation);
        audit.record('state-transition-rejected', violation);
        return { ok: false, violation, from, to, state };
      }
      state = to;
      const record = {
        seq: transitions.length + 1,
        turnId, sessionId,
        from, to,
        reason: String(reason || ''),
        timestamp: now(),
        policyVersion,
        ...(meta && Object.keys(meta).length ? { meta: canonicalizeValue(meta) } : {}),
      };
      transitions.push(record);
      audit.record('state-transition', record);
      return { ok: true, record, from, to, state };
    },

    // 开始一次工具调用：记录调用前状态与理由（预检结论 / 风险 / 幂等键）
    beginToolRun({ callId = '', name = '', args = null, reason = '', risk = null, idempotencyKey = '', retryOf = null } = {}) {
      const run = {
        index: toolRuns.length + 1,
        callId, name,
        argsSummary: summarizeArgs(name, args),
        preState: state,
        startedAt: now(),
        durationMs: 0,
        status: 'running',
        reason: String(reason || ''),
        risk,
        idempotencyKey,
        retryOf,
        failure: null,
        postValidation: null,
        notes: [],
      };
      audit.record('tool-call-start', {
        index: run.index, name, preState: run.preState, reason: run.reason,
        riskLevel: risk && risk.level, idempotencyKey, retryOf,
        argsSummary: run.argsSummary,
      });
      return run;
    },

    endToolRun(run, patch = {}) {
      if (!run || run.__closed) return run;
      Object.assign(run, patch, {
        __closed: true,
        postState: state,
        durationMs: patch.durationMs != null ? patch.durationMs : Math.max(0, now() - run.startedAt),
      });
      toolRuns.push(run);
      audit.record('tool-call-end', {
        index: run.index, name: run.name, status: run.status, preState: run.preState, postState: run.postState,
        durationMs: run.durationMs, idempotencyKey: run.idempotencyKey,
        failureKind: run.failure && run.failure.kind,
        issues: run.postValidation && run.postValidation.issues ? run.postValidation.issues.map((i) => i.id) : [],
        fsDigestBefore: patch.fsDigestBefore, fsDigestAfter: patch.fsDigestAfter,
      });
      return run;
    },

    describe() {
      const last = transitions[transitions.length - 1];
      return `${state}（${EXECUTION_STATE_LABELS[state] || state}）${last ? ` · 最近一次转移理由：${last.reason}` : ''}`;
    },

    snapshot() {
      return {
        schemaVersion: STATE_SCHEMA_VERSION,
        turnId, sessionId, policyVersion,
        state,
        phaseLabel: EXECUTION_STATE_LABELS[state] || state,
        transitions: transitions.map((t) => ({ ...t })),
        violations: violations.map((v) => ({ ...v })),
        toolRuns: toolRuns.map((r) => ({ ...r })),
        audit: audit.snapshot(),
      };
    },
  };
  return machine;
}

// 刷新 / 中断后判断任务处于哪个阶段：可续跑吗？下一步是什么？
export function resumeExecutionState(record) {
  const snap = record && record.machine ? record.machine : record;
  const state = snap && (snap.state || (snap.machine && snap.machine.state));
  if (!state || !EXECUTION_STATE_ORDER.includes(state)) {
    return { resumable: false, phase: 'UNKNOWN', phaseLabel: '未知阶段', pendingStep: '', hint: '没有可恢复的执行记录' };
  }
  const lastRun = Array.isArray(snap.toolRuns) && snap.toolRuns.length ? snap.toolRuns[snap.toolRuns.length - 1] : null;
  const pendingStep = lastRun && lastRun.status === 'running'
    ? `${lastRun.name}（调用未确认结束）`
    : (state === EXECUTION_STATES.TOOL_PENDING ? '等待下一批工具调用' : '');
  if (TERMINAL_STATES.includes(state)) {
    const midTool = !!(lastRun && lastRun.status === 'running');
    if (state === EXECUTION_STATES.INTERRUPTED && midTool) {
      return {
        resumable: true,
        phase: state,
        phaseLabel: '中断（工具执行中）',
        pendingStep: `${lastRun.name}（调用未确认结束）`,
        lastTool: lastRun.name,
        entryState: EXECUTION_STATES.RECOVERY_PENDING,
        hint: '上一轮在工具执行中被中断：副作用状态不确定，续跑前必须先核验目标文件/状态（read_file / list_files），再决定是否重跑。',
      };
    }
    return {
      resumable: false, phase: state, phaseLabel: EXECUTION_STATE_LABELS[state], pendingStep: '',
      hint: state === EXECUTION_STATES.COMMITTED ? '上一轮已完成' : '上一轮已中断，可直接发起新的指令续做',
    };
  }
  const hint = state === EXECUTION_STATES.TOOL_RUNNING || (lastRun && lastRun.status === 'running')
    ? '上一轮在工具执行中被中断：副作用状态不确定，续跑前必须先核验目标文件/状态（read_file / list_files），再决定是否重跑。'
    : '上一轮在生成或等待阶段被中断：可从当前进度继续，无需重放已完成的工具步骤。';
  return {
    resumable: true,
    phase: state,
    phaseLabel: EXECUTION_STATE_LABELS[state],
    pendingStep,
    lastTool: lastRun ? lastRun.name : '',
    entryState: RESUME_ENTRY_STATES.includes(state) ? state : EXECUTION_STATES.RECOVERY_PENDING,
    hint,
  };
}

// ── 4. 统一执行上下文（ExecutionContext）────────────────────────────────
// 路由器 / 工具编排 / 记忆模块共用同一个上下文对象，杜绝「系统声明允许 Web，
// 但实际工具表没有 Web」这类状态分裂（由 assertContextToolAlignment 在运行期断言）。
export const TASK_CLASSES = Object.freeze(['chat', 'compute', 'code', 'research', 'file', 'image']);

export const TASK_CLASS_RULES = Object.freeze([
  { id: 'image', re: /(?:画|绘制|生图|出图|配图|插图|logo|海报|封面|image|draw|illustrat|poster|icon)/i },
  { id: 'code', re: /(?:代码|函数|算法|写个|实现|重构|调试|bug|报错|编译|运行|跑一下|单元测试|python|javascript|typescript|c\+\+|sql 查询优化|正则)/i },
  { id: 'compute', re: /(?:计算|算一下|求值|数值|统计|概率|置信区间|矩阵|积分|方程|是多少|sql|数据库|表格数据)/i },
  { id: 'research', re: /(?:搜索|搜一下|查一下|最新|调研|对比|资料|来源|引用|联网|网页|https?:\/\/)/i },
  { id: 'file', re: /(?:文件|目录|沙箱|上传|附件|导出|打包|zip|压缩|读取|写入|删除)/i },
]);

export function classifyTaskClass(userText = '', { attachments = [], plan = null } = {}) {
  const atts = Array.isArray(attachments) ? attachments : [];
  if (atts.some((a) => a && a.kind === 'image')) return 'image';
  const s = String(userText || '');
  for (const rule of TASK_CLASS_RULES) {
    if (rule.id === 'image' && !/(?:画|绘制|生图|出图|配图|插图|image|draw|illustrat)/i.test(s)) continue;
    if (rule.re.test(s)) return rule.id;
  }
  if (atts.length) return 'file';
  if (plan && plan.needCode && plan.needCode > 0.5 && plan.needCode >= (plan.needSearch || 0)) return 'code';
  return 'chat';
}

export const REASONING_STATES = Object.freeze(['OFF', 'LOW', 'MEDIUM', 'HIGH', 'MAX', 'ULTRA']);

export function normalizeReasoningState(reasoningLevel = 'medium', thinking = true) {
  if (thinking === false) return 'OFF';
  const lv = String(reasoningLevel || 'medium').toLowerCase().trim();
  if (lv === 'off' || lv === 'none') return 'OFF';
  const up = lv.toUpperCase();
  return REASONING_STATES.includes(up) ? up : 'MEDIUM';
}

export function createExecutionContext({
  turnId = 'turn-local',
  sessionId = 'local',
  userIntent = '',
  taskClass = 'chat',
  reasoningState = 'MEDIUM',
  capabilityMask = { relay: false, web: false, sandbox: false, dispatch: false },
  budget = null,
  risk = { level: 'L0', requiresConfirmation: false, hasExternalSideEffect: false },
  memory = { recalledIds: [], candidateWrite: false },
  traceId = '',
  policyVersion = EXECUTION_POLICY_VERSION,
} = {}) {
  const klass = TASK_CLASSES.includes(taskClass) ? taskClass : 'chat';
  const level = REASONING_STATES.includes(String(reasoningState).toUpperCase()) ? String(reasoningState).toUpperCase() : 'MEDIUM';
  const mask = {
    relay: !!capabilityMask.relay,
    web: !!capabilityMask.web,
    sandbox: !!capabilityMask.sandbox,
    dispatch: !!capabilityMask.dispatch,
  };
  return {
    turnId, sessionId,
    userIntent: String(userIntent || '').slice(0, 400),
    userIntentDigest: sha256Hex(String(userIntent || '')).slice(0, 16),
    taskClass: klass,
    reasoningState: level,
    capabilityMask: mask,
    budget: budget ? { ...budget } : { ...DEFAULT_TURN_BUDGET },
    risk: { level: risk.level || 'L0', requiresConfirmation: !!risk.requiresConfirmation, hasExternalSideEffect: !!risk.hasExternalSideEffect },
    memory: {
      recalledIds: Array.isArray(memory.recalledIds) ? [...memory.recalledIds] : [],
      candidateWrite: !!memory.candidateWrite,
    },
    traceId: traceId || `${sessionId}:${turnId}`,
    policyVersion,
  };
}

// 运行期断言：上下文声明的能力必须与实际 tool 表一一对应（双向）
export function assertContextToolAlignment(ctx, tools = []) {
  const names = new Set((Array.isArray(tools) ? tools : []).map(toolNameOf).filter(Boolean));
  const mask = (ctx && ctx.capabilityMask) || {};
  const discrepancies = [];
  const want = [
    ['web', 'fetch_url'],
    ['sandbox', 'execute_javascript'],
    ['dispatch', 'dispatch_subagent'],
  ];
  for (const [bit, tool] of want) {
    const declared = !!mask[bit];
    const present = names.has(tool);
    if (declared && !present) discrepancies.push(`declares-${bit}-without-tool:${tool}`);
    if (!declared && present) discrepancies.push(`has-tool-without-${bit}:${tool}`);
  }
  if (['MAX', 'ULTRA'].includes(String(ctx && ctx.reasoningState)) && !mask.dispatch) {
    discrepancies.push('reasoning-max-ultra-without-dispatch');
  }
  return { aligned: discrepancies.length === 0, discrepancies, checkedTools: names.size };
}

// ── 5. 能力 + 约束（Capability = Availability + Scope + Budget + Risk）──
// 单纯的布尔掩码只能表达「工具在不在」，表达不了「在什么条件下能用」。
export const DEFAULT_CAPABILITY_CONSTRAINTS = Object.freeze({
  web: Object.freeze({ allowedHosts: [], maxFetchesPerTurn: 8 }),
  sandbox: Object.freeze({ network: true, maxRuntimeMs: 120000, maxExecutionsPerTurn: 12, allowedPaths: [] }),
  dispatch: Object.freeze({ maxParallelTasks: 3, maxTotalTasks: 8 }),
  filesystem: Object.freeze({ writeOverwrite: 'allow', protectedPaths: ['uploads/'] }),
});

export function buildCapabilityConstraints({
  relayOk = false,
  webEnabled = false,
  sandboxEnabled = true,
  canDispatch = false,
  overrides = null,
} = {}) {
  const webOn = Boolean(relayOk && webEnabled);
  const base = DEFAULT_CAPABILITY_CONSTRAINTS;
  const ov = overrides || {};
  return {
    bits: { relay: relayOk ? 1 : 0, web: webOn ? 1 : 0, sandbox: sandboxEnabled ? 1 : 0, dispatch: canDispatch ? 1 : 0 },
    capCode: `R${relayOk ? 1 : 0}·W${webOn ? 1 : 0}·S${sandboxEnabled ? 1 : 0}·D${canDispatch ? 1 : 0}`,
    web: { enabled: webOn, ...base.web, ...(ov.web || {}) },
    sandbox: { enabled: !!sandboxEnabled, ...base.sandbox, ...(ov.sandbox || {}) },
    dispatch: { enabled: !!canDispatch, ...base.dispatch, ...(ov.dispatch || {}) },
    filesystem: { ...base.filesystem, ...(ov.filesystem || {}) },
  };
}

export function describeCapabilityConstraints(c) {
  if (!c) return '';
  const bits = [
    `中继=${c.bits.relay ? 'on' : 'off'}`,
    `Web=${c.web.enabled ? (c.web.allowedHosts && c.web.allowedHosts.length ? `限 ${c.web.allowedHosts.length} 个域名` : '全开放') : 'off'}`,
    `Sandbox=${c.sandbox.enabled ? `网络${c.sandbox.network ? '允许' : '禁止'}·≤${Math.round(c.sandbox.maxRuntimeMs / 1000)}s` : 'off'}`,
    `Dispatch=${c.dispatch.enabled ? `并发≤${c.dispatch.maxParallelTasks}` : 'off'}`,
    `覆盖策略=${c.filesystem.writeOverwrite}`,
  ];
  return `[${c.capCode}] ${bits.join(' · ')}`;
}

// 沙箱内网络访问意图探测（约束表达用；不改变沙箱本身的能力）
const SANDBOX_NETWORK_INTENT_RE = /(?:fetch\s*\(|XMLHttpRequest|WebSocket\s*\(|urllib|requests\.|http\.client|socket\.|socket\.socket|micropip|urlopen|httpx|aiohttp|pip\s+install)/i;

export function detectSandboxNetworkIntent(code = '') {
  return SANDBOX_NETWORK_INTENT_RE.test(String(code || ''));
}

const PRIVATE_HOST_RE = /^(?:localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1\]?$)/i;

// 工具表可以是「定义对象数组」也可以是「名字数组」——两种都接受，避免调用方各写一套
export function toolNameOf(entry) {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object') return '';
  return entry.name || (entry.function && entry.function.name) || '';
}

export function hostOf(url = '') {
  const s = String(url || '').trim();
  try {
    const u = new URL(s);
    return u.hostname.toLowerCase();
  } catch {
    const m = /^([a-z0-9.\-]+)(?::\d+)?(?:\/|$)/i.exec(s.replace(/^\/\//, ''));
    return m ? m[1].toLowerCase() : '';
  }
}

function hostAllowed(host, allowedHosts = []) {
  if (!Array.isArray(allowedHosts) || !allowedHosts.length) return true;
  const h = String(host || '').toLowerCase();
  return allowedHosts.some((rule) => {
    const r = String(rule || '').toLowerCase().trim().replace(/^\*\./, '');
    if (!r) return false;
    return h === r || h.endsWith(`.${r}`);
  });
}

function pathAllowed(path, allowedPaths = []) {
  if (!Array.isArray(allowedPaths) || !allowedPaths.length) return true;
  const p = String(path || '').replace(/^\.?\//, '');
  return allowedPaths.some((prefix) => p === String(prefix).replace(/\/$/, '') || p.startsWith(String(prefix)));
}

const FS_PATH_ARGS = ['path', 'out', 'db', 'stdin_path', 'dir'];

// 沙箱路径是否存在：兼容 createFS 实例（list）、导出对象（hasOwnProperty）与自定义 has()
export function fsHasPath(fsOrFiles, path) {
  const p = String(path || '').replace(/^\.?\//, '');
  if (!p) return false;
  try {
    if (fsOrFiles && typeof fsOrFiles.has === 'function') return !!fsOrFiles.has(p);
    if (fsOrFiles && typeof fsOrFiles.list === 'function') {
      return (fsOrFiles.list() || []).some((f) => f && String(f.path) === p);
    }
    if (fsOrFiles && typeof fsOrFiles === 'object') return Object.prototype.hasOwnProperty.call(fsOrFiles, p);
  } catch { return false; }
  return false;
}

export function extractTargetPath(args = {}) {
  for (const k of FS_PATH_ARGS) {
    if (args && typeof args[k] === 'string' && args[k].trim()) return args[k].trim();
  }
  return '';
}

// 调用前的约束判定：返回 allow / confirm / deny（deny 才真正拦截，且必须带恢复路径）
export function checkCapabilityConstraints({ name = '', args = {}, capabilities = null, toolNames = [] } = {}) {
  const caps = capabilities || buildCapabilityConstraints({});
  const a = args && typeof args === 'object' ? args : {};
  const names = new Set((Array.isArray(toolNames) ? toolNames : []).map(toolNameOf).filter(Boolean));

  if (['fetch_url', 'search_web', 'crawl_site'].includes(name)) {
    if (!caps.web.enabled) {
      return {
        allowed: false, decision: 'deny', constraintId: 'capability-web-off',
        reason: `联网能力未开启（无可用中继或顶栏「联网」已关闭），${name} 本轮不应出现在工具表里`,
        recovery: '启动 `python3 server.py` 或配置可用 Cloudflare Worker，并打开顶栏「联网」；也可改用已提供的本地资料作答',
      };
    }
    const feature = name === 'search_web' ? 'search' : (name === 'crawl_site' ? 'crawl' : '');
    if (feature && caps.web[feature] === false) {
      return {
        allowed: false, decision: 'deny', constraintId: `relay-${feature}-unavailable`,
        reason: `当前中继未声明 ${feature === 'search' ? '搜索' : '站点爬取'}能力`,
        recovery: '部署带有相应 /api/search 或 /api/crawl 路由的新版本 relay/worker.js 后重试',
      };
    }
    if (name === 'search_web') {
      return { allowed: true, decision: 'allow', constraintId: 'web-search-ok', reason: '中继声明支持网页搜索' };
    }
    const host = hostOf(a.url || a.href || '');
    if (PRIVATE_HOST_RE.test(host)) {
      return {
        allowed: false, decision: 'confirm', constraintId: 'ssrf-private-host',
        reason: `目标主机 ${host || '(空)'} 属于内网/回环地址，跨出了外网边界`,
        recovery: '如确实需要访问内网地址，明确说明用途后由用户确认放行',
      };
    }
    if (!hostAllowed(host, caps.web.allowedHosts)) {
      return {
        allowed: false, decision: 'deny', constraintId: 'web-host-not-allowed',
        reason: `目标主机 ${host || '(空)'} 不在本轮允许的域名白名单内`,
        recovery: `允许的域名：${caps.web.allowedHosts.join('、')}；如需扩展请调整能力约束`,
      };
    }
    return { allowed: true, decision: 'allow', constraintId: name === 'crawl_site' ? 'web-crawl-ok' : 'web-ok', reason: `主机 ${host || '未指定'} 在白名单策略内` };
  }

  if (['execute_javascript', 'execute_python', 'execute_cpp'].includes(name)) {
    if (!caps.sandbox.enabled) {
      return {
        allowed: false, decision: 'deny', constraintId: 'sandbox-off',
        reason: '代码沙箱已关闭',
        recovery: '沙箱已关闭，调用未执行。请让用户打开「沙箱」开关，或改用 read_file / write_file / dispatch_subagent。',
      };
    }
    if (caps.sandbox.network === false && detectSandboxNetworkIntent(a.code)) {
      return {
        allowed: false, decision: 'deny', constraintId: 'sandbox-network-disabled',
        reason: '本轮沙箱约束禁止网络访问，而代码里出现了联网调用（fetch / urllib / requests / 包安装）',
        recovery: '改为纯本地计算（不联网、不装包），或请用户放开沙箱网络约束后重试',
      };
    }
    const target = extractTargetPath(a);
    if (target && !pathAllowed(target, caps.sandbox.allowedPaths)) {
      return {
        allowed: false, decision: 'deny', constraintId: 'path-outside-scope',
        reason: `路径 ${target} 超出本轮允许范围（${caps.sandbox.allowedPaths.join('、')}）`,
        recovery: '把产物写到允许的目录（如 outputs/），或请用户放宽沙箱路径约束',
      };
    }
    return { allowed: true, decision: 'allow', constraintId: 'sandbox-ok', reason: '沙箱可用且约束满足' };
  }

  if (name === 'dispatch_subagent') {
    if (!caps.dispatch.enabled) {
      return {
        allowed: false, decision: 'deny', constraintId: 'dispatch-tier-gated',
        reason: '当前有效思考档位不满足子智能体并发条件（需开启思考并处于 Max / Ultra）',
        recovery: '开启思考并切到 Max / Ultra，或改用单模型正反自检完成本轮任务',
      };
    }
    return { allowed: true, decision: 'allow', constraintId: 'dispatch-ok', reason: '委派能力可用' };
  }

  // 文件系统类约束（写 / 覆盖 / 删除 / 复制）
  if (['write_file', 'delete_file', 'copy_file', 'unzip_file', 'render_mermaid', 'render_dot', 'zip_files', 'execute_sql'].includes(name)) {
    const target = extractTargetPath(a);
    if (target && !pathAllowed(target, caps.sandbox.allowedPaths)) {
      return {
        allowed: false, decision: 'deny', constraintId: 'path-outside-scope',
        reason: `路径 ${target} 超出本轮允许范围（${caps.sandbox.allowedPaths.join('、')}）`,
        recovery: '把产物写到允许的目录（如 outputs/），或请用户放宽路径约束',
      };
    }
    if (name === 'write_file') {
      const mode = String(a.mode || 'overwrite').toLowerCase();
      const protectedHit = (caps.filesystem.protectedPaths || []).some((p) => String(target || '').startsWith(p));
      if (mode !== 'append' && protectedHit && caps.filesystem.writeOverwrite === 'deny') {
        return {
          allowed: false, decision: 'deny', constraintId: 'protected-path-overwrite',
          reason: `目标 ${target} 属于受保护路径（${caps.filesystem.protectedPaths.join('、')}），本轮覆盖策略为 deny`,
          recovery: '改为 append 或另存新路径；如确需覆盖用户原件，请用户显式确认',
        };
      }
    }
    if (a.files !== undefined && Array.isArray(a.files)) {
      const bad = a.files.map((p) => String(p)).find((p) => p && !pathAllowed(p, caps.sandbox.allowedPaths));
      if (bad) {
        return {
          allowed: false, decision: 'deny', constraintId: 'path-outside-scope',
          reason: `附带路径 ${bad} 超出本轮允许范围`,
          recovery: '只提交允许目录内的文件',
        };
      }
    }
    if (name === 'delete_file' && !names.size) {
      return { allowed: true, decision: 'allow', constraintId: 'fs-ok', reason: '路径约束满足' };
    }
    return { allowed: true, decision: 'allow', constraintId: 'fs-ok', reason: '路径约束满足' };
  }

  return { allowed: true, decision: 'allow', constraintId: 'no-constraint', reason: '该工具无额外能力约束' };
}

// ── 6. 工具契约层 ────────────────────────────────────────────────────────
// 每个工具不只暴露名称与参数，还声明副作用、幂等性、重试策略、超时与回滚。
export const SIDE_EFFECT_LABELS = Object.freeze({
  none: '无副作用（纯计算/只读）',
  sandbox: '沙箱内执行代码（可能写沙箱文件）',
  filesystem: '写入沙箱文件系统',
  memory: '持久化长期记忆',
  network: '访问外部网络',
  remote: '调用外部服务（远程编译 / 视觉 / 网关）',
  cost: '产生外部调用成本',
});

const contract = (o) => Object.freeze({
  sideEffect: 'none',
  idempotent: true,
  requiresConfirmation: false,
  retryPolicy: 'never', // never | once | backoff
  timeoutMs: 10000,
  rollback: 'none',     // none | snapshot-fs | restore-memory
  riskLevel: 'L0',
  verifyAfterRun: false,
  ...o,
});

export const TOOL_CONTRACTS = Object.freeze({
  execute_javascript: contract({ sideEffect: 'sandbox', idempotent: false, timeoutMs: 8000, riskLevel: 'L2', verifyAfterRun: true, note: '代码可写沙箱文件，执行后需核验副作用' }),
  execute_python: contract({ sideEffect: 'sandbox', idempotent: false, timeoutMs: 120000, riskLevel: 'L2', verifyAfterRun: true, note: 'Pyodide 首次加载慢，超时阈值按运行时常驻放宽' }),
  execute_cpp: contract({ sideEffect: 'remote', idempotent: true, retryPolicy: 'once', timeoutMs: 45000, riskLevel: 'L2', external: true, note: '远程 Compiler Explorer 调用' }),
  write_file: contract({ sideEffect: 'filesystem', idempotent: false, timeoutMs: 10000, riskLevel: 'L2', rollback: 'snapshot-fs', verifyAfterRun: true, note: '覆盖已有文件不可自动恢复' }),
  read_file: contract({ idempotent: true, retryPolicy: 'backoff', timeoutMs: 5000, riskLevel: 'L1' }),
  list_files: contract({ idempotent: true, retryPolicy: 'backoff', timeoutMs: 5000, riskLevel: 'L1' }),
  get_current_time: contract({ idempotent: true, timeoutMs: 2000, riskLevel: 'L0' }),
  get_browser_environment: contract({ idempotent: true, timeoutMs: 2000, riskLevel: 'L0', note: '用户显式请求时读取有限的浏览器公开信息；不读 Cookie 或精确定位' }),
  regex: contract({ idempotent: true, timeoutMs: 5000, riskLevel: 'L0' }),
  hash: contract({ idempotent: true, timeoutMs: 5000, riskLevel: 'L0' }),
  codec: contract({ idempotent: true, timeoutMs: 5000, riskLevel: 'L0' }),
  unicode: contract({ idempotent: true, timeoutMs: 5000, riskLevel: 'L0' }),
  generate_image: contract({ sideEffect: 'cost', idempotent: false, timeoutMs: 180000, riskLevel: 'L2', external: true, note: '外部生图调用（计费）' }),
  analyze_image: contract({ sideEffect: 'remote', idempotent: true, retryPolicy: 'once', timeoutMs: 60000, riskLevel: 'L1', external: true, note: '图片上行到网关做视觉分析' }),
  zip_files: contract({ sideEffect: 'filesystem', idempotent: false, timeoutMs: 15000, riskLevel: 'L2', verifyAfterRun: true }),
  unzip_file: contract({ sideEffect: 'filesystem', idempotent: false, timeoutMs: 15000, riskLevel: 'L2', verifyAfterRun: true, note: '批量写入文件' }),
  fetch_url: contract({ sideEffect: 'network', idempotent: true, retryPolicy: 'backoff', timeoutMs: 30000, riskLevel: 'L2', external: true }),
  search_web: contract({ sideEffect: 'network', idempotent: true, retryPolicy: 'once', timeoutMs: 30000, riskLevel: 'L2', external: true, note: '搜索词会发送给 Worker 配置的搜索服务，结果需核验' }),
  crawl_site: contract({ sideEffect: 'network', idempotent: true, retryPolicy: 'once', timeoutMs: 60000, riskLevel: 'L2', external: true, note: '严格限制同源、页数与深度的只读抓取' }),
  run_git: contract({ sideEffect: 'filesystem', idempotent: false, timeoutMs: 30000, riskLevel: 'L2', external: true, verifyAfterRun: true, note: '远端操作（clone/push/pull）跨系统边界时升为 L3' }),
  search_files: contract({ idempotent: true, retryPolicy: 'backoff', timeoutMs: 8000, riskLevel: 'L1' }),
  diff_text: contract({ idempotent: true, timeoutMs: 5000, riskLevel: 'L1' }),
  json_tool: contract({ idempotent: true, timeoutMs: 5000, riskLevel: 'L1' }),
  delete_file: contract({ sideEffect: 'filesystem', idempotent: false, timeoutMs: 10000, riskLevel: 'L3', rollback: 'snapshot-fs', requiresConfirmation: true, verifyAfterRun: true, note: '删除不可自动恢复' }),
  copy_file: contract({ sideEffect: 'filesystem', idempotent: false, timeoutMs: 10000, riskLevel: 'L2', verifyAfterRun: true }),
  remember: contract({ sideEffect: 'memory', idempotent: false, timeoutMs: 5000, riskLevel: 'L2', rollback: 'restore-memory', note: 'purge 为不可恢复的物理抹除（升为 L3）' }),
  evaluate_expression: contract({ idempotent: true, timeoutMs: 3000, riskLevel: 'L0' }),
  csv_tool: contract({ idempotent: true, timeoutMs: 8000, riskLevel: 'L1', note: 'out 参数写沙箱时为 filesystem 副作用' }),
  date_calc: contract({ idempotent: true, timeoutMs: 2000, riskLevel: 'L0' }),
  text_tool: contract({ idempotent: true, timeoutMs: 8000, riskLevel: 'L1', note: 'out 参数写沙箱时为 filesystem 副作用' }),
  convert_units: contract({ idempotent: true, timeoutMs: 2000, riskLevel: 'L0' }),
  qr_code: contract({ sideEffect: 'filesystem', idempotent: false, timeoutMs: 8000, riskLevel: 'L1', verifyAfterRun: true }),
  execute_sql: contract({ sideEffect: 'filesystem', idempotent: false, timeoutMs: 15000, riskLevel: 'L2', verifyAfterRun: true, note: 'DROP/DELETE 升为 L3' }),
  render_mermaid: contract({ sideEffect: 'filesystem', idempotent: false, timeoutMs: 15000, riskLevel: 'L1', verifyAfterRun: true }),
  render_dot: contract({ sideEffect: 'filesystem', idempotent: false, timeoutMs: 15000, riskLevel: 'L1', verifyAfterRun: true }),
  dispatch_subagent: contract({ sideEffect: 'cost', idempotent: false, timeoutMs: 600000, riskLevel: 'L2', external: true, note: '独立上下文子智能体，产生额外推理成本' }),
});

export function getToolContract(name) {
  return TOOL_CONTRACTS[String(name)] || null;
}

export function verifyToolContractCoverage(toolNames = []) {
  const names = [...new Set((Array.isArray(toolNames) ? toolNames : []).map((n) => String(n)).filter(Boolean))].sort();
  const contractNames = Object.keys(TOOL_CONTRACTS).sort();
  const missing = names.filter((n) => !TOOL_CONTRACTS[n]);
  const extra = contractNames.filter((n) => !names.includes(n));
  return {
    contractVersion: TOOL_CONTRACT_VERSION,
    toolCount: names.length,
    coveredCount: names.length - missing.length,
    coverageRate: names.length ? Number(((names.length - missing.length) / names.length).toFixed(4)) : 1,
    missing,
    extra,
    ok: missing.length === 0,
  };
}

export function summarizeArgs(name, args, maxLen = 160) {
  if (!args || typeof args !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(args)) {
    if (k === '__raw') continue;
    let s;
    if (typeof v === 'string') s = v.length > 40 ? `${v.slice(0, 40)}…(${v.length}字)` : v;
    else if (Array.isArray(v)) s = `[${v.length}项]`;
    else if (v && typeof v === 'object') s = '{…}';
    else s = String(v);
    parts.push(`${k}=${s}`);
    if (parts.join(', ').length > maxLen) break;
  }
  const out = parts.join(', ');
  return out.length > maxLen ? `${out.slice(0, maxLen)}…` : out;
}

// 幂等键：hash(turnId + toolName + 规范化参数)——用于识别「同一次调用」并禁止盲目重试
export function idempotencyKey({ turnId = '', toolName = '', args = null } = {}) {
  const basis = `${turnId}|${toolName}|${canonicalJSON(args || {})}`;
  return `idem-${sha256Hex(basis).slice(0, 16)}`;
}

// ── 7. 调用前契约校验（Schema / 能力 / 约束 / 预算 / 副作用 / 幂等）──────
const TYPEOF_LABEL = { string: '字符串', number: '数字', boolean: '布尔', array: '数组', object: '对象', integer: '整数' };

function jsonTypeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

export function validateToolArgs(args, parameters = null) {
  const errors = [];
  const warnings = [];
  const schema = parameters && parameters.properties ? parameters : null;
  if (!schema) return { ok: true, errors, warnings, checked: 0 };
  const a = args && typeof args === 'object' ? args : null;
  if (!a) return { ok: false, errors: [{ id: 'args-not-object', detail: '参数必须是 JSON 对象' }], warnings, checked: 0 };

  let checked = 0;
  for (const req of Array.isArray(schema.required) ? schema.required : []) {
    if (a[req] === undefined || a[req] === null || a[req] === '') {
      errors.push({ id: `missing-required:${req}`, detail: `缺少必填参数 ${req}` });
      checked++;
    }
  }
  for (const [key, spec] of Object.entries(schema.properties || {})) {
    if (!(key in a) || a[key] === undefined) continue;
    checked++;
    const val = a[key];
    const want = spec && spec.type;
    const actual = jsonTypeOf(val);
    const typeOk = !want
      || want === actual
      || (want === 'number' && actual === 'integer')
      || (want === 'string' && actual === 'string');
    if (!typeOk) {
      errors.push({ id: `type-mismatch:${key}`, detail: `${key} 期望 ${TYPEOF_LABEL[want] || want}，实际是 ${TYPEOF_LABEL[actual] || actual}` });
      continue;
    }
    if (Array.isArray(spec.enum) && spec.enum.length && !spec.enum.includes(val)) {
      errors.push({ id: `enum-violation:${key}`, detail: `${key}=${String(val)} 不在允许值 [${spec.enum.map((x) => String(x)).slice(0, 8).join(', ')}] 内` });
      continue;
    }
    if (spec.type === 'array' && spec.items && spec.items.type === 'string' && Array.isArray(val)) {
      const bad = val.find((v) => typeof v !== 'string');
      if (bad !== undefined) errors.push({ id: `items-type:${key}`, detail: `${key} 的元素必须是字符串` });
    }
  }
  for (const key of Object.keys(a)) {
    if (key === '__raw') continue;
    if (!(schema.properties || {})[key]) warnings.push({ id: `unknown-arg:${key}`, detail: `${key} 不是该工具的声明参数（已忽略）` });
  }
  return { ok: errors.length === 0, errors, warnings, checked };
}

// 调用前总闸门：任何一条 deny 都要给出可执行的原因与恢复路径，并写进审计
export function validateToolCallPre({
  name = '', args = null, toolDef = null, tools = [], capabilities = null, budget = null, risk = null,
  seenIdempotency = null, turnBudget = null,
} = {}) {
  const contractDef = getToolContract(name);
  const errors = [];
  const warnings = [];
  const names = (Array.isArray(tools) ? tools : []).map(toolNameOf).filter(Boolean);

  if (!contractDef) errors.push({ id: 'missing-contract', detail: `工具 ${name} 没有声明契约（禁止直接执行）` });
  if (names.length && !names.includes(name)) errors.push({ id: 'tool-not-available', detail: `工具 ${name} 不在本轮工具表中（能力掩码已裁剪）` });

  const hasRaw = !!(args && typeof args === 'object' && '__raw' in args);
  if (!hasRaw) {
    const argCheck = validateToolArgs(args, toolDef && toolDef.parameters ? toolDef.parameters : null);
    errors.push(...argCheck.errors);
    warnings.push(...argCheck.warnings);
  }

  const idemKey = idempotencyKey({ turnId: (turnBudget && turnBudget.turnId) || '', toolName: name, args: hasRaw ? { __unparsed: true } : args });
  const capabilityCheck = checkCapabilityConstraints({ name, args: args || {}, capabilities, toolNames: names });
  if (capabilityCheck.decision === 'deny') errors.push({ id: capabilityCheck.constraintId, detail: capabilityCheck.reason, recovery: capabilityCheck.recovery });

  let budgetVerdict = { ok: true };
  if (budget && typeof budget.canSpend === 'function') {
    budgetVerdict = budget.canSpend('toolCalls');
    if (!budgetVerdict.ok) {
      errors.push({ id: 'budget-tool-calls-exhausted', detail: budgetVerdict.reason, recovery: '等待下一轮，或让用户放宽工具调用预算' });
    } else {
      // Token 预算（第七路）：不是「不让你算」，而是「别再扩大上下文与调用面」——
      // 继续调工具只会让上下文更长，所以在这里就转带限制作答。
      const tokenVerdict = budget.canSpend('tokens');
      if (!tokenVerdict.ok) {
        errors.push({ id: 'budget-tokens-exhausted', detail: tokenVerdict.reason, recovery: '不再发起新的工具调用，直接用已有信息作答并说明未完成的步骤。' });
      }
    }
  }

  const priors = seenIdempotency && typeof seenIdempotency.get === 'function' ? seenIdempotency.get(idemKey) : null;
  if (priors && priors.status === 'uncertain') {
    errors.push({
      id: 'idempotency-uncertain',
      detail: `该调用与第 ${priors.index} 次调用幂等键相同（${idemKey}），上一次副作用状态不确定`,
      recovery: '禁止盲目重试。请先用 read_file / list_files 核验目标状态，确认未生效后再重新发起。',
    });
  }

  const riskInfo = risk || classifyToolRisk({ name, args: args || {}, contract: contractDef });
  const ok = errors.length === 0;
  return {
    ok,
    blocked: !ok,
    errors,
    warnings,
    idempotencyKey: idemKey,
    risk: riskInfo,
    constraint: capabilityCheck,
    budgetVerdict,
    contract: contractDef,
    decision: !ok ? 'deny' : (riskInfo.requiresConfirmation ? 'confirm' : 'allow'),
    message: ok ? '' : formatPreflightRejection({ name, errors, constraint: capabilityCheck }),
  };
}

export function formatPreflightRejection({ name = '', errors = [], constraint = null }) {
  const head = `⛔ 执行内核在调用前拦截了 ${name || '该工具'}：`;
  const body = errors.map((e) => `- ${e.detail}${e.recovery ? `；恢复方式：${e.recovery}` : ''}`).join('\n');
  const tail = constraint && constraint.recovery && !errors.some((e) => e.recovery === constraint.recovery)
    ? `\n恢复方式：${constraint.recovery}` : '';
  return `${head}\n${body}${tail}`;
}

// ── 8. 调用后契约校验（结果形态 / 副作用是否真的发生 / 是否需继续或降级）──
export function fsDigest(fsOrFiles) {
  let files = {};
  try {
    if (fsOrFiles && typeof fsOrFiles.export === 'function') files = fsOrFiles.export() || {};
    else if (fsOrFiles && typeof fsOrFiles === 'object') files = fsOrFiles;
  } catch { files = {}; }
  const paths = Object.keys(files).sort();
  const lines = paths.map((p) => {
    const v = typeof files[p] === 'string' ? files[p] : String(files[p] == null ? '' : JSON.stringify(files[p]));
    return `${p}\u0000${v.length}\u0000${v.slice(0, 64)}\u0000${v.slice(-64)}`;
  });
  return { count: paths.length, digest: sha256Hex(lines.join('\n')).slice(0, 32) };
}

const TOOL_FAILURE_TEXT_RE = /(?:失败|报错|错误|异常|超时|未执行|拒绝执行|不可用|未找到|找不到|cannot|failed|error|timeout|not\s+allowed|denied)/i;

export function validateToolResultPost({
  name = '', args = null, contract: contractDef = null, result = '', ok = true, durationMs = 0,
  fsBefore = null, fsAfter = null, error = null, timedOut = false,
} = {}) {
  const c = contractDef || getToolContract(name);
  const text = result == null ? '' : String(result);
  const issues = [];
  const stateChanged = !!(fsBefore && fsAfter && fsBefore.digest !== fsAfter.digest);
  const failureSignalled = !ok || TOOL_FAILURE_TEXT_RE.test(text.slice(0, 160));

  if (c && c.timeoutMs && durationMs > c.timeoutMs) {
    issues.push({ id: 'timeout-exceeded', severity: 'warn', detail: `耗时 ${Math.round(durationMs)}ms 超过契约超时 ${c.timeoutMs}ms` });
  }
  if (c && c.verifyAfterRun && !failureSignalled && !stateChanged) {
    issues.push({ id: 'side-effect-missing', severity: 'warn', detail: '工具声称成功，但沙箱文件系统无任何变化（可能未真正写入，或写入内容与现值相同）' });
  }
  if (c && c.sideEffect !== 'none' && failureSignalled && stateChanged) {
    issues.push({ id: 'side-effect-applied-despite-error', severity: 'high', detail: '工具回报失败，但文件系统确实发生了变化：副作用状态不确定，禁止盲目重试' });
  }
  if (c && (c.sideEffect === 'none' || c.idempotent) && !failureSignalled && !text.trim()) {
    issues.push({ id: 'empty-result', severity: 'warn', detail: '工具没有返回任何内容（返回结构异常）' });
  }
  const high = issues.filter((i) => i.severity === 'high');
  const failureKind = high.length ? classifyToolFailure({ name, args, result: text, contract: c, stateChanged })
    : (failureSignalled ? classifyToolFailure({ name, args, result: text, contract: c, stateChanged, error, timedOut }) : null);
  return {
    ok: high.length === 0,
    issues,
    failureSignalled,
    stateChanged,
    fsDigestBefore: fsBefore && fsBefore.digest,
    fsDigestAfter: fsAfter && fsAfter.digest,
    failureKind,
    summary: issues.length ? issues.map((i) => `${i.id}(${i.severity})`).join(', ') : '契约一致',
  };
}

// ── 9. 失败分类（不是所有失败都该重试）──────────────────────────────────
export const FAILURE_KINDS = Object.freeze({
  INVALID_ARGS: 'INVALID_ARGS',
  ENVIRONMENT: 'ENVIRONMENT',
  TRANSIENT: 'TRANSIENT',
  PERMISSION: 'PERMISSION',
  DATA: 'DATA',
  SIDE_EFFECT_UNCERTAIN: 'SIDE_EFFECT_UNCERTAIN',
});

export const FAILURE_KIND_META = Object.freeze({
  INVALID_ARGS: { label: '参数错误', handling: '修正参数后最多重试一次', retryable: true, maxRetries: 1, verifyFirst: false },
  ENVIRONMENT: { label: '环境错误', handling: '不重试：解释原因并给出恢复路径', retryable: false, maxRetries: 0, verifyFirst: false },
  TRANSIENT: { label: '暂时性错误', handling: '有限指数退避重试', retryable: true, maxRetries: 2, verifyFirst: false },
  PERMISSION: { label: '权限错误', handling: '不重试：路径/权限不允许', retryable: false, maxRetries: 0, verifyFirst: false },
  DATA: { label: '数据错误', handling: '标记工具异常，改用其它路径取数', retryable: false, maxRetries: 0, verifyFirst: false },
  SIDE_EFFECT_UNCERTAIN: { label: '副作用不确定', handling: '禁止盲目重试：先核验目标状态', retryable: false, maxRetries: 0, verifyFirst: true },
});

const FAILURE_PATTERNS = [
  { kind: 'PERMISSION', re: /(?:无权|权限|不允许|拒绝|forbidden|permission|not allowed|outside|越权)/i },
  { kind: 'ENVIRONMENT', re: /(?:沙箱已关闭|沙箱创建失败|沙箱不可用|未开启|不可用|不存在|未安装|未就绪|no relay|中继|Pyodide|WASM|Worker|not available|unavailable)/i },
  { kind: 'TRANSIENT', re: /(?:超时|timed?\s*out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|网络中断|网络|fetch failed|429|50\d|暂时|重试)/i },
  { kind: 'INVALID_ARGS', re: /(?:参数|不是合法 JSON|必须|缺少|schema|invalid)/i },
  { kind: 'DATA', re: /(?:返回结构|空结果|解析失败|unexpected|malformed|empty)/i },
];

export function classifyToolFailure({ name = '', args = null, result = '', error = null, timedOut = false, contract: contractDef = null, stateChanged = false } = {}) {
  const c = contractDef || getToolContract(name) || {};
  const text = `${result == null ? '' : String(result)} ${error && error.message ? String(error.message) : ''}`;
  let kind = null;

  if (stateChanged && c.sideEffect && c.sideEffect !== 'none') kind = 'SIDE_EFFECT_UNCERTAIN';
  else if (timedOut && c.sideEffect && c.sideEffect !== 'none' && c.idempotent === false) kind = 'SIDE_EFFECT_UNCERTAIN';
  else {
    for (const p of FAILURE_PATTERNS) {
      if (p.re.test(text)) { kind = p.kind; break; }
    }
  }
  if (!kind) kind = /(?:超时|timeout)/i.test(text) ? 'TRANSIENT' : 'DATA';
  const meta = FAILURE_KIND_META[kind];
  const retryLimit = Math.min(meta.maxRetries, c.retryPolicy === 'backoff' ? 2 : (c.retryPolicy === 'once' ? 1 : meta.maxRetries));
  const retryable = meta.retryable && c.idempotent === true && c.retryPolicy !== 'never' && retryLimit > 0;
  return {
    kind,
    label: meta.label,
    handling: meta.handling,
    retryable,
    maxRetries: retryable ? retryLimit : 0,
    verifyFirst: meta.verifyFirst,
    idempotencyKey: idempotencyKey({ turnId: '', toolName: name, args }),
    guidance: meta.verifyFirst
      ? '该调用可能已经产生了副作用（写入/提交/扣费），结果丢失。禁止盲目重试：先用 read_file / list_files 核验目标状态。'
      : (retryable ? '可按有限退避重试一次，若仍失败则转入带限制作答并如实披露。' : ''),
  };
}

// ── 10. 预算与资源治理（Token 之外的资源同样要计量）─────────────────────
// P2 修正（P0 遗留的口径分裂）：文档与 CHANGELOG 一直声明「32 · 2 · 600s · 3 · 4 · 6」，
// 而代码是 24 · 2 · 300s · 3 · 4 · 2。两者必须只有一个真相，否则「预算治理」在文档里与运行时不同。
// 以文档口径为准（它同时更符合真实用法：一轮里并发 3 个子智能体是受支持的常态，
// 旧值 2 会让第 3 个委派被外部副作用预算拦下——预算太紧和预算没生效一样糟）。
export const DEFAULT_TURN_BUDGET = Object.freeze({
  maxToolCalls: 32,
  maxRetries: 2,
  maxDurationMs: 600000,
  maxParallelTasks: 3,
  maxMemoryWrites: 4,
  maxExternalSideEffects: 6,
  // 第七路：Token（输入 + 输出合计）。Token 是最容易被忽略的一路——它不像工具调用那样
  // 有明确边界，一轮里「多说几句」就能翻倍；限额设宽（20 万）默认几乎不触发，
  // 但一旦逼近上限必须能拦下后续工具调用，而不是让成本无声膨胀。
  maxTokens: 200000,
  maxOutputTokens: null,
});

export const BUDGET_CHANNELS = Object.freeze(['toolCalls', 'retries', 'durationMs', 'parallelTasks', 'memoryWrites', 'externalSideEffects', 'tokens']);

export function createBudgetGovernor(budget = {}, { now = () => Date.now(), startedAt = null } = {}) {
  const limits = { ...DEFAULT_TURN_BUDGET, ...(budget || {}) };
  const limitKeyOf = (channel) => `max${channel.charAt(0).toUpperCase()}${channel.slice(1)}`;
  const limitOf = (channel) => {
    const key = limitKeyOf(channel);
    return limits[key] == null ? null : Number(limits[key]);
  };
  const started = startedAt != null ? startedAt : now();
  const spent = { toolCalls: 0, retries: 0, durationMs: 0, parallelTasks: 0, memoryWrites: 0, externalSideEffects: 0, tokens: 0 };
  const events = [];
  const exhausted = new Set();

  const remainingOf = (channel) => {
    const limit = limitOf(channel);
    if (limit == null) return Infinity;
    if (channel === 'durationMs') return Math.max(0, limit - (now() - started));
    return Math.max(0, limit - spent[channel]);
  };

  return {
    budget: limits,
    startedAt: started,
    spent, events,
    get exhaustedChannels() { return [...exhausted]; },
    remaining: remainingOf,
    // 墙钟是流动的：每次判定都要显式同步一次已消耗时长
    syncDuration() {
      spent.durationMs = Math.max(0, now() - started);
      if (limitOf('durationMs') != null && spent.durationMs >= limitOf('durationMs')) exhausted.add('durationMs');
      return spent.durationMs;
    },
    canSpend(channel, n = 1) {
      if (!BUDGET_CHANNELS.includes(channel)) return { ok: true, reason: '' };
      if (channel === 'durationMs') this.syncDuration();
      const remaining = remainingOf(channel);
      if (remaining < n) {
        exhausted.add(channel);
        return { ok: false, channel, remaining, reason: `预算耗尽：${BUDGET_LABEL[channel] || channel} 剩余 ${remaining}，需要 ${n}` };
      }
      return { ok: true, channel, remaining };
    },
    spend(channel, n = 1, meta = null) {
      const verdict = this.canSpend(channel, n);
      if (!verdict.ok) {
        events.push({ channel, amount: 0, denied: true, reason: verdict.reason, at: now() });
        return verdict;
      }
      if (channel === 'parallelTasks') spent[channel] = Math.max(spent[channel], n);
      else spent[channel] += n;
      if (channel === 'durationMs') this.syncDuration();
      const ev = { channel, amount: n, spent: spent[channel], limit: limitOf(channel), at: now(), ...(meta ? { meta } : {}) };
      events.push(ev);
      const limit = limitOf(channel);
      if (limit != null && spent[channel] >= limit) exhausted.add(channel);
      return { ok: true, channel, spent: spent[channel], remaining: remainingOf(channel), event: ev };
    },
    snapshot() {
      this.syncDuration();
      return {
        policyVersion: BUDGET_POLICY_VERSION,
        budget: { ...limits },
        spent: { ...spent },
        remaining: BUDGET_CHANNELS.reduce((acc, ch) => { acc[ch] = remainingOf(ch) === Infinity ? null : remainingOf(ch); return acc; }, {}),
        exhaustedChannels: [...exhausted],
        withinBudget: exhausted.size === 0,
      };
    },
  };
}

const BUDGET_LABEL = Object.freeze({
  toolCalls: '工具调用', retries: '重试次数', durationMs: '墙钟时长', parallelTasks: '并发任务',
  memoryWrites: '记忆写入', externalSideEffects: '外部副作用', tokens: 'Token 消耗',
});

export function formatBudgetLedger(gov) {
  if (!gov) return '';
  gov.syncDuration();
  const s = gov.snapshot();
  const show = (ch, unit = '') => {
    const limit = s.budget[`max${ch.charAt(0).toUpperCase()}${ch.slice(1)}`];
    const used = ch === 'durationMs' ? `${(s.spent.durationMs / 1000).toFixed(1)}s` : s.spent[ch];
    const cap = limit == null ? '∞' : (ch === 'durationMs' ? `${Math.round(limit / 1000)}s` : limit);
    return `${BUDGET_LABEL[ch]} ${used}${unit}/${cap}`;
  };
  return `【执行内核 · 预算】${['toolCalls', 'retries', 'durationMs', 'parallelTasks', 'memoryWrites', 'externalSideEffects'].map((ch) => show(ch)).join(' · ')}${s.exhaustedChannels.length ? ` ⚠ 已耗尽：${s.exhaustedChannels.map((c) => BUDGET_LABEL[c] || c).join('、')}` : ''}`;
}

// ── 11. 风险分级（L0–L3）与最小信息确认请求 ─────────────────────────────
export const RISK_LEVELS = Object.freeze(['L0', 'L1', 'L2', 'L3']);

export const RISK_LEVEL_META = Object.freeze({
  L0: { label: '纯解释 / 计算 / 只读分析', defaultAction: '自动执行' },
  L1: { label: '读文件 / 生成临时输出', defaultAction: '自动执行' },
  L2: { label: '修改文件 / 持久化记忆 / 批量处理', defaultAction: '记录并可配置确认' },
  L3: { label: '外部网络写入 / 删除 / 提交 / 发送', defaultAction: '必须确认或严格策略放行' },
});

const REMOTE_GIT_RE = /\b(?:clone|push|pull|fetch|remote|submodule|ls-remote)\b/i;
const SQL_DESTRUCTIVE_RE = /\b(?:drop|truncate|alter)\b/i;
const SQL_WRITE_RE = /\b(?:delete|update|insert)\b/i;
const EXPLICIT_AUTHORIZATION_RE = /(?:删除|清空|抹除|彻底删除|覆盖|重写|替换|提交|推送|发布|上传|执行|运行|跑一下|purge|delete|remove|overwrite|push|commit|deploy)/i;

export function classifyToolRisk({ name = '', args = null, contract: contractDef = null, fs = null, userText = '' } = {}) {
  const c = contractDef || getToolContract(name) || {};
  const a = args && typeof args === 'object' ? args : {};
  const reasons = [];
  let level = c.riskLevel || 'L0';
  let irreversible = false;
  let requiresConfirmation = !!c.requiresConfirmation;

  if (name === 'write_file') {
    const target = extractTargetPath(a);
    const exists = !!(target && fsHasPath(fs, target));
    const mode = String(a.mode || 'overwrite').toLowerCase();
    if (exists && mode !== 'append') {
      level = maxRisk(level, 'L2');
      reasons.push(`覆盖已有文件 ${target}`);
      if (String(target).startsWith('uploads/')) {
        level = 'L3';
        irreversible = true;
        requiresConfirmation = true;
        reasons.push('目标是用户上传的原件，覆盖后无法自动恢复');
      }
    }
  }
  if (name === 'delete_file') {
    level = 'L3';
    irreversible = true;
    requiresConfirmation = true;
    reasons.push('删除文件（不可自动恢复，仅能从检查点回滚）');
  }
  if (name === 'remember') {
    const action = String(a.action || '').toLowerCase();
    if (action === 'purge') {
      level = 'L3';
      irreversible = true;
      requiresConfirmation = true;
      reasons.push('物理抹除长期记忆（活跃库与冷备库同步擦除，不可恢复）');
    } else if (action) {
      level = maxRisk(level, 'L2');
      reasons.push(`长期记忆写操作：${action}`);
    }
  }
  if (name === 'execute_sql') {
    const sql = String(a.sql || '');
    if (SQL_DESTRUCTIVE_RE.test(sql)) {
      level = 'L3';
      irreversible = true;
      // P2 修正：L3 必须与「需要确认」一致——破坏性 DDL 之前只升了等级却没置确认位，
      // 结果是默认档位下「显示为最高风险但没人被要求确认」，等于把风险声明挂空。
      requiresConfirmation = true;
      reasons.push('DDL 破坏性语句（DROP / TRUNCATE / ALTER），不可自动恢复');
    } else if (SQL_WRITE_RE.test(sql)) {
      level = maxRisk(level, 'L2');
      reasons.push('数据写入语句（INSERT / UPDATE / DELETE）');
    }
  }
  if (name === 'run_git') {
    const gitArgs = `${a.args ? (Array.isArray(a.args) ? a.args.join(' ') : String(a.args)) : ''} ${a.command || ''}`;
    if (REMOTE_GIT_RE.test(gitArgs)) {
      level = 'L3';
      reasons.push('Git 远端操作跨越外部系统边界（clone / push / pull）');
    }
  }
  if (name === 'fetch_url') {
    const host = hostOf(a.url || '');
    if (PRIVATE_HOST_RE.test(host)) {
      level = 'L3';
      requiresConfirmation = true;
      reasons.push(`访问内网/回环地址 ${host}`);
    }
  }
  if (name === 'unzip_file') {
    level = maxRisk(level, 'L2');
    reasons.push('解压会批量写入文件');
  }

  const hasExternalSideEffect = !!(c.external || c.sideEffect === 'network' || c.sideEffect === 'cost' || c.sideEffect === 'remote');
  if (hasExternalSideEffect) reasons.push(`跨外部边界：${SIDE_EFFECT_LABELS[c.sideEffect] || c.sideEffect}`);

  // 一致性不变量（P2 修正）：等级为 L3 就必须走确认流程。
  // 之前 delete_file / 覆盖 uploads / purge / 内网抓取各自置确认位，而远端 Git 与破坏性 DDL 只升了等级，
  // 结果是「显示最高风险、默认档位下却没人被要求确认」——声明与行为不一致比漏标更危险。
  if (level === 'L3') requiresConfirmation = true;

  const authorizedByIntent = EXPLICIT_AUTHORIZATION_RE.test(String(userText || ''));
  if (requiresConfirmation && authorizedByIntent) {
    requiresConfirmation = false;
    reasons.push('用户本轮已明确要求该类操作，按授权放行（仍全程记录）');
  }
  return {
    policyVersion: RISK_POLICY_VERSION,
    level,
    levelLabel: RISK_LEVEL_META[level].label,
    defaultAction: RISK_LEVEL_META[level].defaultAction,
    reasons: [...new Set(reasons)],
    hasExternalSideEffect,
    irreversible,
    requiresConfirmation,
    authorizedByIntent,
  };
}

function maxRisk(a, b) {
  return RISK_LEVELS.indexOf(a) >= RISK_LEVELS.indexOf(b) ? a : b;
}

// 确认请求的最小信息格式：操作 / 原因 / 影响 / 可逆性 / 参数摘要（不能只问「是否继续」）
export function formatConfirmationRequest({
  name = '', args = null, reason = '', impact = '', reversibility = '', summary = '',
} = {}) {
  const c = getToolContract(name);
  const risk = classifyToolRisk({ name, args, contract: c });
  return [
    '【执行内核 · 需要确认】',
    `操作：${name}${extractTargetPath(args || {}) ? ` → ${extractTargetPath(args || {})}` : ''}`,
    `原因：${reason || risk.reasons[0] || '该操作属于高风险等级'}`,
    `影响：${impact || SIDE_EFFECT_LABELS[c && c.sideEffect] || c && c.sideEffect || '未知'}`,
    `可逆性：${reversibility || (risk.irreversible ? '不可自动恢复' : `可回滚（${c && c.rollback}）`)}`,
    `参数摘要：${summary || summarizeArgs(name, args)}`,
    `风险等级：${risk.level}（${risk.levelLabel}）· 默认行为：${risk.defaultAction}`,
  ].join('\n');
}

// ── 11b. P1 交互确认（风险分级 → 用户决定，fail-closed）──────────────────
// P0 只做到「记录 + 严格模式拦截」；P1 把确认接成一次真实的等待：
// 请求 → 用户决定（允许一次 / 本会话允许该工具 / 拒绝）→ 决定写进审计；超时或无人应答一律拒绝。
export const CONFIRMATION_POLICY_VERSION = 'confirm-policy-2.5.0';
export const CONFIRMATION_DECISIONS = Object.freeze({
  ALLOW_ONCE: 'allow-once',
  ALLOW_SESSION: 'allow-session',
  DENY: 'deny',
  TIMEOUT: 'timeout',
});
export const GUARD_MODES = Object.freeze(['observe', 'strict', 'strict-l2']);

export function guardRequiresConfirmation({ guard = 'observe', risk = null } = {}) {
  if (!risk) return false;
  const mode = GUARD_MODES.includes(guard) ? guard : 'observe';
  if (mode === 'observe') return false;
  if (mode === 'strict') return risk.level === 'L3';
  return risk.level === 'L3' || risk.level === 'L2';
}

export function createConfirmationGate({ timeoutMs = 180000, now = () => Date.now() } = {}) {
  const pending = new Map();
  const sessionAllow = new Set();
  const history = [];
  return {
    policyVersion: CONFIRMATION_POLICY_VERSION,
    timeoutMs,
    allowlist: sessionAllow,
    get pendingCount() { return pending.size; },
    get history() { return [...history]; },
    pendingKeys() { return [...pending.keys()]; },
    isSessionAllowed(tool) { return sessionAllow.has(String(tool)); },
    allowForSession(tool) { sessionAllow.add(String(tool)); return [...sessionAllow]; },
    // 等待用户决定：resolveConfirmation(key, decision) 或超时（默认拒绝）
    wait({ key, tool = '', requestText = '' } = {}) {
      const k = String(key);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (!pending.has(k)) return;
          pending.delete(k);
          const rec = { key: k, tool, decision: CONFIRMATION_DECISIONS.TIMEOUT, reason: `等待确认超时（${Math.round(timeoutMs / 1000)}s，默认拒绝）`, waitedMs: timeoutMs, at: now() };
          history.push(rec);
          resolve(rec);
        }, timeoutMs);
        pending.set(k, {
          tool, requestText, createdAt: now(),
          resolve: (decision, reason = '') => {
            clearTimeout(timer);
            pending.delete(k);
            const rec = { key: k, tool, decision, reason, waitedMs: Math.max(0, now() - (pending.get(k) ? pending.get(k).createdAt : now())), at: now() };
            history.push(rec);
            resolve(rec);
          },
        });
      });
    },
    resolve(key, decision, reason = '') {
      const k = String(key);
      const entry = pending.get(k);
      if (!entry) return { ok: false, reason: '该确认请求不存在或已过期' };
      const normalized = Object.values(CONFIRMATION_DECISIONS).includes(decision) ? decision : CONFIRMATION_DECISIONS.DENY;
      if (normalized === CONFIRMATION_DECISIONS.ALLOW_SESSION) sessionAllow.add(entry.tool);
      entry.resolve(normalized, reason);
      return { ok: true, decision: normalized, tool: entry.tool };
    },
    cancelAll(reason = '回合结束，未决确认一律作废') {
      for (const [k, entry] of [...pending.entries()]) {
        pending.delete(k);
        entry.resolve(CONFIRMATION_DECISIONS.DENY, reason);
      }
    },
  };
}

export function formatConfirmationDecision(rec) {
  if (!rec) return '';
  const label = {
    [CONFIRMATION_DECISIONS.ALLOW_ONCE]: '用户允许本次执行',
    [CONFIRMATION_DECISIONS.ALLOW_SESSION]: '用户允许本会话内该工具的同类操作',
    [CONFIRMATION_DECISIONS.DENY]: '用户拒绝执行',
    [CONFIRMATION_DECISIONS.TIMEOUT]: '等待确认超时，按默认拒绝处理',
  }[rec.decision] || rec.decision;
  return `【执行内核 · 确认结果】${label}${rec.reason ? `（${rec.reason}）` : ''}`;
}

// ── 12. 静默失败检测（「工具失败但最终回答未披露」）──────────────────────
// 披露判定是启发式的（工具名可能是中文动作词，如 read_file → 「读取」）：
// 宁可判定「已披露」（不追加），也不能把明显已经如实说明的回答再补一条。
const DISCLOSURE_PATTERNS = [
  /(?:工具|调用|执行|沙箱|中继|接口|任务|读取|写入|抓取|查询|搜索|计算|文件|网络|联网)[^。；\n]{0,24}(?:失败|出错|报错|超时|未能|无法|未成功|不可用|受限|被拦截|未执行|没查到)/,
  /(?:失败|报错|超时|拦截|出错)[^。；\n]{0,20}(?:工具|调用|沙箱|中继|接口|执行|文件|网络|联网|读取|写入|抓取|查询|搜索|计算)/,
  /(?:没查到|查不到|未取到|未拿到|取数失败|未能完成|部分完成|未完成|无法核实|无法确认)/,
  /(?:failed|error|timeout|unable to|could not|couldn't|not available|blocked)/i,
];

export function detectSilentFailure({ toolRuns = [], answerText = '' } = {}) {
  const failed = (Array.isArray(toolRuns) ? toolRuns : []).filter((r) => r && (r.status === 'failed' || r.status === 'blocked' || (r.failure && r.failure.kind)));
  const answer = String(answerText || '');
  if (!failed.length) return { silent: false, failedTools: [], disclosed: true, matched: [], unrecoveredCount: 0 };
  const matched = DISCLOSURE_PATTERNS.filter((re) => re.test(answer)).map((re) => String(re));
  const namesMentioned = failed.filter((r) => r.name && answer.includes(r.name)).length;
  const disclosed = matched.length > 0 || (namesMentioned > 0 && /(?:失败|报错|超时|错误|fail|error)/i.test(answer));
  return {
    silent: !disclosed,
    failedTools: failed.map((r) => r.name),
    failedRuns: failed,
    disclosed,
    matched,
    unrecoveredCount: failed.length,
  };
}

export function formatSilentFailureDisclosure({ failedTools = [], toolRuns = [] } = {}) {
  const names = [...new Set((Array.isArray(failedTools) ? failedTools : []).filter(Boolean))];
  if (!names.length) return '';
  const detail = (Array.isArray(toolRuns) ? toolRuns : [])
    .filter((r) => r && r.failure && names.includes(r.name))
    .slice(0, 3)
    .map((r) => `${r.name}（${r.failure.label}：${String(r.failure.handling || '').slice(0, 40)}）`)
    .join('；');
  return [
    '',
    `> ⚠️ 执行内核披露：本轮有 ${names.length} 次工具调用未取得成功（${names.join('、')}），上述结论不包含它们的贡献。`,
    detail ? `> 失败归类：${detail}。` : '',
    '> 如需继续，可让我先核验状态再重试，或调整为不依赖该工具的方案。',
  ].filter(Boolean).join('\n');
}

// ── 13. 回合收尾：把「回答 → 核验 → 提交」跑成显式状态轨迹 ──────────────
export function finalizeExecutionTurn({
  machine = null,
  toolRuns = [],
  answerText = '',
  budget = null,
  extraLimitations = [],
  auditDigest = '',
} = {}) {
  const limitations = [...(Array.isArray(extraLimitations) ? extraLimitations : [])];
  const silent = detectSilentFailure({ toolRuns, answerText });
  if (silent.silent) limitations.push(`silent-failure:${silent.failedTools.join('|')}`);

  const failedUnrecovered = (Array.isArray(toolRuns) ? toolRuns : []).filter((r) => r && r.status === 'failed' && !r.recovered);
  if (failedUnrecovered.length) limitations.push(`unrecovered-tools:${failedUnrecovered.map((r) => r.name).join('|')}`);
  const blockedRuns = (Array.isArray(toolRuns) ? toolRuns : []).filter((r) => r && r.status === 'blocked');
  if (blockedRuns.length) limitations.push(`blocked-tools:${blockedRuns.map((r) => r.name).join('|')}`);
  if (budget && typeof budget.snapshot === 'function') {
    const snap = budget.snapshot();
    if (snap.exhaustedChannels.length) limitations.push(`budget-exhausted:${snap.exhaustedChannels.join('|')}`);
  }

  const disclosure = silent.silent ? formatSilentFailureDisclosure({ failedTools: silent.failedTools, toolRuns }) : '';
  const finalText = disclosure ? `${answerText}${disclosure}` : answerText;

  const limiting = silent.silent || failedUnrecovered.length > 0 || blockedRuns.length > 0
    || limitations.some((l) => l.startsWith('budget-exhausted') || l.startsWith('limitation:'));
  let state = machine && machine.state;
  if (machine) {
    if (isValidExecutionTransition(state, EXECUTION_STATES.ANSWERING) || isValidExecutionTransition(state, EXECUTION_STATES.ANSWERING_WITH_LIMITATION)) {
      // 有未恢复的失败 / 被拦截调用 / 预算耗尽 → 一律走「带限制作答」，绝不假装干净收尾
      const prefer = limiting ? EXECUTION_STATES.ANSWERING_WITH_LIMITATION : EXECUTION_STATES.ANSWERING;
      const fallback = prefer === EXECUTION_STATES.ANSWERING ? EXECUTION_STATES.ANSWERING_WITH_LIMITATION : EXECUTION_STATES.ANSWERING;
      const target = isValidExecutionTransition(state, prefer) ? prefer : fallback;
      machine.transition(target, limiting
        ? `存在未结清的执行条件（${limitations.join(', ') || '未列明'}），转入带限制作答`
        : '模型给出最终回答，前置工具全部成功');
    }
    if (machine.state === EXECUTION_STATES.ANSWERING) {
      machine.transition(EXECUTION_STATES.VERIFIED, '回答核验：工具结果一致且失败已披露');
    } else if (machine.state === EXECUTION_STATES.ANSWERING_WITH_LIMITATION) {
      machine.transition(EXECUTION_STATES.VERIFIED, `带限制核验通过（${limitations.join(', ') || '未列明限制'}）`);
    }
    if (machine.state === EXECUTION_STATES.VERIFIED) {
      machine.transition(EXECUTION_STATES.COMMITTED, '提交本轮执行记录（含审计摘要）', auditDigest ? { auditDigest } : {});
    }
    state = machine.state;
  }
  return {
    state,
    silentFailure: silent,
    disclosure,
    finalText,
    limitations,
    verifyPolicy: PROMISE_POLICY_VERSION,
  };
}

// ── 14. 执行记录摘要（落盘 + 遥测 + 提示词可读）─────────────────────────
export function summarizeExecutionRecord({ machine = null, budget = null, toolRuns = null, silentFailure = null, auditDigest = '' } = {}) {
  const snap = machine && typeof machine.snapshot === 'function' ? machine.snapshot() : null;
  const runs = toolRuns || (snap ? snap.toolRuns : []);
  const failed = (runs || []).filter((r) => r && r.status === 'failed');
  const blocked = (runs || []).filter((r) => r && r.status === 'blocked');
  const retried = (runs || []).filter((r) => r && r.retryOf);
  const uncertain = (runs || []).filter((r) => r && r.failure && r.failure.verifyFirst);
  const riskCounts = { L0: 0, L1: 0, L2: 0, L3: 0 };
  for (const r of runs || []) if (r && r.risk && riskCounts[r.risk.level] != null) riskCounts[r.risk.level] += 1;
  return {
    kernelVersion: EXECUTION_KERNEL_VERSION,
    policyVersion: EXECUTION_POLICY_VERSION,
    stateSchemaVersion: STATE_SCHEMA_VERSION,
    auditSchemaVersion: AUDIT_SCHEMA_VERSION,
    toolContractVersion: TOOL_CONTRACT_VERSION,
    budgetPolicyVersion: BUDGET_POLICY_VERSION,
    riskPolicyVersion: RISK_POLICY_VERSION,
    state: snap ? snap.state : 'RECEIVED',
    phaseLabel: snap ? snap.phaseLabel : EXECUTION_STATE_LABELS.RECEIVED,
    transitions: snap ? snap.transitions : [],
    violations: snap ? snap.violations : [],
    toolRuns: (runs || []).slice(-40).map((r) => ({
      index: r.index, name: r.name, status: r.status, preState: r.preState, postState: r.postState,
      durationMs: r.durationMs, argsSummary: r.argsSummary, idempotencyKey: r.idempotencyKey,
      riskLevel: r.risk && r.risk.level, failureKind: r.failure && r.failure.kind,
      issues: r.postValidation && r.postValidation.issues ? r.postValidation.issues.map((i) => i.id) : [],
      // P1：幂等/确认标记与产物清单随执行记录一并保留（轨迹级评测与续跑核验都要用）
      notes: Array.isArray(r.notes) ? [...r.notes] : [],
      opKey: r.opKey || '',
      retryOf: r.retryOf || null,
      recovered: !!r.recovered,
      changedFiles: Array.isArray(r.changedFiles) ? [...r.changedFiles] : [],
      statusLabel: r.status,
    })),
    toolCallCount: (runs || []).length,
    failedCount: failed.length,
    blockedCount: blocked.length,
    retryCount: retried.length,
    uncertainCount: uncertain.length,
    riskCounts,
    silentFailure: silentFailure ? { silent: !!silentFailure.silent, failedTools: silentFailure.failedTools, disclosed: !!silentFailure.disclosed } : null,
    budget: budget && typeof budget.snapshot === 'function' ? budget.snapshot() : null,
    auditDigest: auditDigest || (snap && snap.audit ? snap.audit.digest : ''),
    auditEventCount: snap && snap.audit ? snap.audit.eventCount : 0,
  };
}

export function formatExecutionRecordLine(record) {
  if (!record) return '';
  const bits = [
    `阶段=${record.state}`,
    `转移=${(record.transitions || []).length}`,
    `工具=${record.toolCallCount}（失败 ${record.failedCount} / 拦截 ${record.blockedCount} / 重试 ${record.retryCount}）`,
    `风险 L2×${record.riskCounts ? record.riskCounts.L2 : 0}·L3×${record.riskCounts ? record.riskCounts.L3 : 0}`,
  ];
  if (record.silentFailure && record.silentFailure.silent) bits.push(`静默失败=${record.silentFailure.failedTools.join('|')}`);
  if (record.auditDigest) bits.push(`审计=${String(record.auditDigest).slice(0, 10)}`);
  return `【执行内核 v${record.kernelVersion}】${bits.join(' · ')}`;
}

// ── 15. P0 验收自检（不夸大：只报告能验证的不变量）───────────────────────
export function evaluateExecutionKernelAcceptance({ toolNames = [], sampleTurnId = 'turn-acceptance', smoke = true } = {}) {
  const checks = [];
  const table = validateTransitionTable();
  checks.push({
    id: 'explicit-state-machine',
    label: '统一执行状态机：转移表自洽（可达 / 无死路 / 无自环 / COMMITTED 仅从 VERIFIED 进入 / 异常路径齐全）',
    ok: table.ok,
    detail: `${table.checkedStates} 状态 · ${table.checkedEdges} 条合法边 · ${table.transitionTableVersion}${table.problems.length ? ` · ${table.problems.join(',')}` : ''}`,
  });

  const coverage = verifyToolContractCoverage(toolNames);
  checks.push({
    id: 'tool-contracts',
    label: '工具契约层：全部工具都有输入/输出 Schema、副作用、幂等性、重试策略、超时与回滚声明',
    ok: coverage.ok,
    detail: `覆盖率 ${(coverage.coverageRate * 100).toFixed(1)}%（${coverage.coveredCount}/${coverage.toolCount}）${coverage.missing.length ? ` · 缺声明：${coverage.missing.join(',')}` : ''}`,
  });

  if (smoke) {
    // 状态机行为冒烟：失败不允许隐式收尾
    const m = createExecutionStateMachine({ turnId: smoke ? sampleTurnId : 'turn-x', sessionId: 'acceptance', now: () => 0 });
    m.transition('CLASSIFIED', 'smoke');
    m.transition('PLANNED', 'smoke');
    m.transition('TOOL_PENDING', 'smoke');
    m.transition('TOOL_RUNNING', 'smoke');
    m.transition('TOOL_FAILED', 'smoke');
    const illegalCommit = m.transition('COMMITTED', 'smoke: 工具失败后直接收尾');
    const toLimit = m.transition('ANSWERING_WITH_LIMITATION', 'smoke: 带限制作答');
    const toVerified = m.transition('VERIFIED', 'smoke');
    const toCommitted = m.transition('COMMITTED', 'smoke');
    checks.push({
      id: 'no-silent-success',
      label: '工具失败后不会隐式进入最终回答（TOOL_FAILED → COMMITTED 被拒绝，必须先带限制作答并核验）',
      ok: illegalCommit.ok === false && toLimit.ok && toVerified.ok && toCommitted.ok && m.violations.length === 1,
      detail: `拦截理由=${illegalCommit.violation ? illegalCommit.violation.reason : '未拦截'}`,
    });

    // 审计可重放 + 防篡改
    const replay = replayExecutionEvents(m.audit.events);
    const tampered = m.audit.events.map((e, i) => (i === 2 ? { ...e, payload: { ...e.payload, reason: 'tampered' } } : e));
    const tamperCheck = verifyExecutionAudit(tampered);
    checks.push({
      id: 'auditable-replay',
      label: '所有状态转移可在审计记录中重放，且版本绑定的哈希链能检出篡改',
      ok: replay.replayable === true && tamperCheck.valid === false,
      detail: `重放 ${replay.transitionCount} 次转移（终态 ${replay.reached}），篡改检出 ${tamperCheck.mismatches.length} 处`,
    });

    // 预算治理
    const gov = createBudgetGovernor({ maxToolCalls: 2, maxRetries: 1, maxDurationMs: 1000, maxParallelTasks: 2, maxMemoryWrites: 1, maxExternalSideEffects: 0 });
    gov.spend('toolCalls'); gov.spend('toolCalls');
    const third = gov.canSpend('toolCalls');
    const ext = gov.canSpend('externalSideEffects');
    const ledger = formatBudgetLedger(gov);
    checks.push({
      id: 'budget-governance',
      label: '预算治理：工具调用 / 重试 / 墙钟 / 并发 / 记忆写 / 外部副作用六路预算实时扣减并拦截超额',
      ok: third.ok === false && ext.ok === false && /工具调用 2\/2/.test(ledger),
      detail: third.reason || ledger,
    });

    // 幂等键 + 副作用不确定保护
    const keyA = idempotencyKey({ turnId: 't1', toolName: 'write_file', args: { path: 'a.txt', content: 'x' } });
    const keyB = idempotencyKey({ turnId: 't1', toolName: 'write_file', args: { content: 'x', path: 'a.txt' } });
    const keyC = idempotencyKey({ turnId: 't2', toolName: 'write_file', args: { path: 'a.txt', content: 'x' } });
    checks.push({
      id: 'idempotency-key',
      label: '幂等键：同一轮同一工具同一参数稳定一致，参数顺序无关、轮次变化即不同（用于阻止盲目重试）',
      ok: keyA === keyB && keyA !== keyC && keyA.startsWith('idem-'),
      detail: `${keyA} / ${keyC}`,
    });

    // 静默失败检测
    const runs = [{ name: 'fetch_url', status: 'failed', failure: { kind: 'ENVIRONMENT', label: '环境错误' } }];
    const silentHit = detectSilentFailure({ toolRuns: runs, answerText: '根据我的知识，答案是 42。' });
    const disclosed = detectSilentFailure({ toolRuns: runs, answerText: '联网抓取失败（未检测到本地中继），因此无法核实最新数值。' });
    checks.push({
      id: 'silent-failure-detection',
      label: '「工具失败但回答未披露」可被检测，并生成披露文本；已披露的回答不误报',
      ok: silentHit.silent === true && disclosed.silent === false,
      detail: `未披露检出=${silentHit.silent} · 已披露误报=${disclosed.silent}`,
    });
  }

  const passed = checks.filter((c) => c.ok).length;
  return {
    kernelVersion: EXECUTION_KERNEL_VERSION,
    policyVersion: EXECUTION_POLICY_VERSION,
    checks,
    passed,
    total: checks.length,
    ok: passed === checks.length,
    checkedAt: Date.now(),
  };
}

export function formatExecutionKernelAcceptanceReport(result = evaluateExecutionKernelAcceptance()) {
  return [
    `【天枢2.5 v${result.kernelVersion} · P0 执行内核自检（${result.passed}/${result.total} 通过）】`,
    ...result.checks.map((c) => `  ${c.ok ? '✓' : '✗'} ${c.label}\n    · ${c.detail}`),
  ].join('\n');
}
