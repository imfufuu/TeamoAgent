// ─── Dubhe Helix 2.5（天枢2.5） · P1 幂等账本（Idempotency Ledger，预写日志语义）──────
// P0 已经在调用前算幂等键 `idem = hash(turnId + toolName + 规范化参数)` 并拦下「副作用不确定」的重发；
// P1 把它升级成一份可持久化、可跨轮查询的账本（write-ahead log）：
//   · claim  → 执行前登记「本键正在执行」（同键并发调用直接复用同一次执行，绝不重复落副作用）
//   · settle → 执行后落定终态（succeeded / failed / blocked / uncertain），并把结果摘要写进账本
//   · planReplay → 下轮遇到同键调用时给出裁决：
//       reuse（目标状态已满足，直接复用旧结论）
//       verify-first（上次副作用不确定，必须先核验再决定）
//       block（非幂等 + 外部副作用：重复调用会造成重复扣费 / 重复提交，默认不放行）
//       allow（状态已变化或用户明确要求，按新调用执行）
// 定位说明：账本只做「同一逻辑操作不要重复执行」的因果去重，不宣称能证明副作用是否真的发生过。

import { sha256Hex } from './nexus.js';
import { canonicalJSON } from './execution.js';

export const IDEMPOTENCY_POLICY_VERSION = 'idem-policy-2.4.0';
export const LEDGER_SCHEMA_VERSION = 'exec-idem-ledger-1';
export const LEDGER_MAX = 48;

export const LEDGER_STATES = Object.freeze(['in-flight', 'succeeded', 'failed', 'blocked', 'uncertain']);

const AUTHORIZE_RE = /(?:再写|重写|覆盖|重新生成|再来一?次|再跑|重跑|重新执行|强制|无条件|覆盖掉|push|发布|重发|再发|again|re-?run|re-?write|overwrite|force)/i;

function normalizeEntry(raw, now) {
  if (!raw || !raw.key) return null;
  return {
    key: String(raw.key),
    tool: String(raw.tool || ''),
    turnId: String(raw.turnId || ''),
    status: LEDGER_STATES.includes(raw.status) ? raw.status : 'succeeded',
    at: Number(raw.at) || now(),
    resultDigest: raw.resultDigest || '',
    artifactDigest: raw.artifactDigest || '',
    artifactPath: raw.artifactPath || '',
    argsSummary: String(raw.argsSummary || '').slice(0, 160),
    reason: String(raw.reason || '').slice(0, 200),
    schemaVersion: LEDGER_SCHEMA_VERSION,
  };
}

// 操作键（跨轮稳定）：hash(工具名 + 规范化参数)，与轮次无关。
// 与 P0 的 idempotencyKey = hash(turnId + 工具名 + 参数) 分工不同：
//   · idempotencyKey 是「这一次调用」的身份（审计与同轮不确定态拦截用）；
//   · operationKey 是「同一个逻辑操作」的身份（跨轮判定重复副作用、复用已完成结果用）。
export function operationKey({ toolName = '', args = null } = {}) {
  return `op-${sha256Hex(`${toolName}|${canonicalJSON(args || {})}`).slice(0, 16)}`;
}

export function createIdempotencyLedger({ entries = [], max = LEDGER_MAX, now = () => Date.now() } = {}) {
  const map = new Map();
  for (const raw of Array.isArray(entries) ? entries : []) {
    const e = normalizeEntry(raw, now);
    if (e) map.set(e.key, e);
  }
  const api = {
    policyVersion: IDEMPOTENCY_POLICY_VERSION,
    schemaVersion: LEDGER_SCHEMA_VERSION,
    max,
    get size() { return map.size; },
    lookup(key) { return map.get(String(key)) || null; },
    has(key) { return map.has(String(key)); },
    claim(key, { tool = '', turnId = '', argsSummary = '' } = {}) {
      const k = String(key);
      const prev = map.get(k);
      if (prev && prev.status === 'in-flight' && prev.turnId === String(turnId)) {
        return { ok: false, state: prev.status, entry: prev, reason: '同一轮内已有同键调用正在执行（并发去重）' };
      }
      const entry = normalizeEntry({ key: k, tool, turnId, status: 'in-flight', at: now(), argsSummary }, now);
      map.set(k, entry);
      return { ok: true, state: 'in-flight', entry };
    },
    settle(key, { status = 'succeeded', tool = '', turnId = '', resultDigest = '', artifactDigest = '', artifactPath = '', reason = '' } = {}) {
      const k = String(key);
      const prev = map.get(k) || normalizeEntry({ key: k, tool, turnId }, now);
      const entry = {
        ...prev,
        tool: tool || prev.tool,
        turnId: turnId || prev.turnId,
        status: LEDGER_STATES.includes(status) ? status : prev.status,
        at: now(),
        resultDigest: resultDigest || prev.resultDigest,
        artifactDigest: artifactDigest || prev.artifactDigest,
        artifactPath: artifactPath || prev.artifactPath,
        reason: reason || prev.reason,
      };
      map.set(k, entry);
      while (map.size > max) {
        const oldest = [...map.entries()].sort((a, b) => (a[1].at || 0) - (b[1].at || 0))[0];
        if (!oldest) break;
        map.delete(oldest[0]);
      }
      return entry;
    },
    drop(key) { return map.delete(String(key)); },
    snapshot(limit = 20) {
      return [...map.values()].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, limit).map((e) => ({ ...e }));
    },
    toJSON() {
      // 只持久化有副作用的键（纯读/计算类换轮重跑是合理的，不必回放拦截）
      return [...map.values()].filter((e) => e.status !== 'in-flight').map((e) => ({ ...e }));
    },
  };
  return api;
}

// 回放裁决：给「上一次同键调用」一个结论
export function planReplay({ entry = null, contract = null, userText = '', currentArtifactDigest = null, currentTurnId = '' } = {}) {
  if (!entry) return { decision: 'allow', reason: '账本无同键记录，按新调用执行' };
  const c = contract || {};
  const authorized = AUTHORIZE_RE.test(String(userText || ''));
  // 同一轮内的重复调用（模型一次发了两个完全相同的调用）：直接复用，绝不重复执行
  if (entry.turnId && currentTurnId && entry.turnId === String(currentTurnId) && entry.status === 'succeeded') {
    return {
      decision: 'reuse',
      reason: `同一轮内已有完全相同的调用成功执行过（${entry.tool}，幂等键 ${entry.key}）`,
      guidance: '直接使用已有结果，不要重复执行。',
    };
  }

  if (entry.status === 'in-flight') {
    return {
      decision: 'reuse',
      reason: `同键调用正在执行（第 ${entry.at} 次登记），复用同一次执行结果而不是再发一次`,
      guidance: '等待该调用结束后直接使用其结果。',
    };
  }
  if (entry.status === 'uncertain') {
    return {
      decision: 'verify-first',
      reason: `上一次同键调用（${entry.tool}）副作用状态不确定`,
      guidance: '禁止盲目重发：先用 read_file / list_files 核验目标状态，确认未生效后再决定重试。',
    };
  }
  if (entry.status === 'failed' || entry.status === 'blocked') {
    return {
      decision: 'allow',
      reason: `上一次同键调用未成功（${entry.status}），本次按新调用执行`,
      guidance: entry.reason ? `上次结论：${entry.reason}` : '',
    };
  }

  // status === 'succeeded'
  if (c.sideEffect === 'none') {
    return { decision: 'allow', reason: '纯读/纯计算工具：跨轮重跑是合理的（结果可能已变化），仅同轮去重' };
  }
  if (authorized) {
    return { decision: 'allow', reason: '用户在本次指令中明确要求重做（再写/覆盖/重跑/强制），按新调用执行并全程记录' };
  }
  if (c.sideEffect === 'filesystem') {
    if (currentArtifactDigest && entry.artifactDigest && currentArtifactDigest === entry.artifactDigest) {
      return {
        decision: 'reuse',
        reason: `目标状态已满足：同参数的写操作此前已成功，${entry.artifactPath || '目标文件'} 当前内容与当时一致`,
        guidance: '不要重复写入；如需强制重写，请调整内容（会生成新的幂等键）或明确要求覆盖。',
      };
    }
    if (currentArtifactDigest && entry.artifactDigest && currentArtifactDigest !== entry.artifactDigest) {
      return { decision: 'allow', reason: '目标文件当前内容与上次写入不同（已被修改），本次重写是新的有效操作' };
    }
    return {
      decision: 'verify-first',
      reason: `同一写操作此前已成功（${entry.tool}，幂等键 ${entry.key}）`,
      guidance: '先核验目标当前状态，避免重复写入或覆盖用户的新改动。',
    };
  }
  if (c.sideEffect === 'memory') {
    return {
      decision: 'reuse',
      reason: '同一条记忆此前已写入（记忆库按文本去重）',
      guidance: '无需重复调用；如需更新请说明新内容。',
    };
  }
  // cost / remote / network：重复调用会重复扣费、重复提交或重复推送
  return {
    decision: 'block',
    reason: `同参数的外部副作用调用此前已成功（${entry.tool}），重复执行会造成重复${c.sideEffect === 'cost' ? '计费' : '外部提交'}`,
    guidance: '如确实需要重跑：调整参数（生成新幂等键），或在指令中明确要求重做；也可以先核验上次产出的结果。',
  };
}

export function formatLedgerLine(ledger) {
  if (!ledger) return '';
  const snap = ledger.snapshot(6);
  const counts = snap.reduce((acc, e) => { acc[e.status] = (acc[e.status] || 0) + 1; return acc; }, {});
  return `【幂等账本】共 ${ledger.size} 键 · 最近 ${snap.length}：${Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(' · ') || '空'}`;
}

export function digestResultText(text) {
  return sha256Hex(String(text == null ? '' : text)).slice(0, 16);
}
