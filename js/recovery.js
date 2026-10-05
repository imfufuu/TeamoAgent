// ─── Dubhe Helix 2.5（天枢2.5） · P1 执行检查点与恢复（Checkpoint & Resume）──────────
// 目标（对应 P1「引入可恢复的检查点和幂等机制」，阶段目标：工具失败、刷新、中断可恢复）：
//   多步任务每走完一波工具调用就落一个检查点，刷新 / 中断后按检查点判断——
//     ① 已完成的步骤哪些能复用（结果是否仍然有效）
//     ② 产物状态是否已经被外部改变（文件被改过 / 被删掉）
//     ③ 未完成的步骤是否仍然有效（能力是否还在、参数是否还成立）
//     ④ 是否需要用户重新确认（高风险步骤 + 授权/能力发生变化）
//   注意与 state.js 里「会话回滚检查点（对话级）」区分：这里是**执行级**检查点，
//   记录的是工具步骤、产物摘要与状态摘要，用于续跑而不是对话回滚。

import { sha256Hex } from './nexus.js';

export const RECOVERY_POLICY_VERSION = 'recovery-policy-2.5.0';
export const CHECKPOINT_SCHEMA_VERSION = 'exec-checkpoint-schema-1';
export const CHECKPOINT_MAX = 12;

const MAX_ARTIFACT_PREVIEW = 96;

// ── 状态与产物摘要 ─────────────────────────────────────────────────────
export function digestArtifact(value) {
  const s = typeof value === 'string' ? value : String(value == null ? '' : value);
  return { size: s.length, digest: sha256Hex(s).slice(0, 16) };
}

export function digestFiles(files = {}) {
  const lines = Object.keys(files || {}).sort().map((p) => {
    const v = String(files[p] == null ? '' : files[p]);
    return `${p}\u0000${v.length}\u0000${sha256Hex(v).slice(0, 16)}`;
  });
  return { fileCount: Object.keys(files || {}).length, digest: sha256Hex(lines.join('\n')).slice(0, 32) };
}

// 状态摘要：把「消息 + 产物 + 记忆 + 执行阶段 + 幂等键」绑成一个可比较的摘要
export function digestState({ messages = [], files = {}, memory = [], executionState = '', idempotencyKeys = [] } = {}) {
  const msgLines = (Array.isArray(messages) ? messages : []).slice(-12).map((m) => {
    const role = m && m.role ? m.role : '?';
    const body = String((m && (m.text || m.content)) || '').slice(0, 200);
    return `${role}:${sha256Hex(body).slice(0, 16)}`;
  });
  const memIds = (Array.isArray(memory) ? memory : []).map((m) => (m && m.id) || '').filter(Boolean).sort();
  const parts = {
    messages: sha256Hex(msgLines.join('|')).slice(0, 16),
    files: digestFiles(files).digest,
    memory: sha256Hex(memIds.join(',')).slice(0, 16),
    executionState: String(executionState || ''),
    idempotency: sha256Hex((idempotencyKeys || []).slice().sort().join(',')).slice(0, 16),
  };
  return { stateDigest: sha256Hex(JSON.stringify(parts)).slice(0, 32), parts };
}

// 前后两份文件快照的差异（只比较内容摘要，不搬运大字符串）
export function diffFileState(before = {}, after = {}) {
  const added = [], changed = [], removed = [];
  for (const p of Object.keys(after)) {
    const a = digestArtifact(after[p]);
    if (!(p in before)) added.push({ path: p, size: a.size, digest: a.digest });
    else {
      const b = digestArtifact(before[p]);
      if (b.digest !== a.digest) changed.push({ path: p, size: a.size, digest: a.digest, prevSize: b.size });
    }
  }
  for (const p of Object.keys(before)) if (!(p in after)) removed.push({ path: p, size: digestArtifact(before[p]).size });
  return { added, changed, removed, touched: [...new Set([...added, ...changed, ...removed].map((x) => x.path))] };
}

// ── 检查点 ─────────────────────────────────────────────────────────────
export function buildCheckpoint({
  checkpointId = '', turnId = '', sessionId = 'local', executionState = '', completedSteps = [],
  pendingStep = '', artifacts = [], files = {}, messages = [], memory = [], budget = null,
  riskLevel = 'L0', idempotencyKeys = [], note = '', now = () => Date.now(),
} = {}) {
  const state = digestState({ messages, files, memory, executionState, idempotencyKeys });
  const artifactList = (artifacts || []).map((a) => {
    const path = typeof a === 'string' ? a : a.path;
    const exists = Object.prototype.hasOwnProperty.call(files || {}, path);
    const d = exists ? digestArtifact(files[path]) : { size: 0, digest: '' };
    return {
      path,
      exists,
      size: d.size,
      digest: d.digest,
      preview: exists ? String(files[path]).slice(0, MAX_ARTIFACT_PREVIEW) : '',
      step: (typeof a === 'object' && a.step) || '',
    };
  });
  return {
    checkpointId: checkpointId || `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    policyVersion: RECOVERY_POLICY_VERSION,
    turnId,
    sessionId,
    executionState,
    completedSteps: (completedSteps || []).map((s) => (typeof s === 'string' ? { name: s, status: 'succeeded' } : { ...s })),
    pendingStep: String(pendingStep || ''),
    artifacts: artifactList,
    stateDigest: state.stateDigest,
    stateParts: state.parts,
    filesDigest: digestFiles(files).digest,
    budget: budget || null,
    riskLevel,
    idempotencyKeys: (idempotencyKeys || []).slice(-16),
    note: String(note || ''),
    createdAt: now(),
  };
}

export function createCheckpointStore({ max = CHECKPOINT_MAX, entries = [], now = () => Date.now() } = {}) {
  const list = Array.isArray(entries) ? entries.filter((c) => c && c.checkpointId).slice(-max) : [];
  const api = {
    max,
    now,
    get size() { return list.length; },
    latest(sessionId = null) {
      const pool = sessionId ? list.filter((c) => c.sessionId === sessionId) : list;
      return pool.length ? pool[pool.length - 1] : null;
    },
    list(sessionId = null) {
      return sessionId ? list.filter((c) => c.sessionId === sessionId) : [...list];
    },
    record(cp, { coalesce = false } = {}) {
      const entry = cp && cp.checkpointId ? cp : buildCheckpoint({ ...(cp || {}), now });
      const last = list[list.length - 1];
      // 可选的合并：调用方明确要求时才把「同一进度点的重复落盘」合并成一条，
      // 默认每条落盘都是独立检查点（谁在什么阶段存的，可逐条回溯）
      if (coalesce && last && last.turnId === entry.turnId && last.pendingStep === entry.pendingStep
        && last.stateParts && entry.stateParts && last.stateDigest === entry.stateDigest) {
        list[list.length - 1] = entry;
        return entry;
      }
      list.push(entry);
      while (list.length > max) list.shift();
      return entry;
    },
    clear(sessionId = null) {
      if (!sessionId) { list.length = 0; return; }
      for (let i = list.length - 1; i >= 0; i--) if (list[i].sessionId === sessionId) list.splice(i, 1);
    },
    toJSON() { return list.map((c) => ({ ...c })); },
  };
  return api;
}

// ── 校验：产物是否被外部改变 / 步骤是否还能复用 ────────────────────────
export function verifyCheckpoint(checkpoint, { files = {}, capabilities = null, now = () => Date.now() } = {}) {
  if (!checkpoint) return { ok: false, drift: 'no-checkpoint', reason: '没有检查点，无法判断恢复位置', artifacts: [], completedSteps: [], needsUserReconfirmation: false };
  const artifacts = (checkpoint.artifacts || []).map((a) => {
    const exists = Object.prototype.hasOwnProperty.call(files || {}, a.path);
    const d = exists ? digestArtifact(files[a.path]) : { size: 0, digest: '' };
    let status = 'intact';
    if (!exists && a.exists) status = 'missing';
    else if (exists && !a.exists) status = 'appeared';
    else if (exists && a.digest && d.digest !== a.digest) status = 'changed';
    return { path: a.path, step: a.step || '', status, expectedDigest: a.digest, actualDigest: d.digest, size: d.size, prevSize: a.size };
  });
  const changedArtifacts = artifacts.filter((a) => a.status === 'changed');
  const missingArtifacts = artifacts.filter((a) => a.status === 'missing');

  const completedSteps = (checkpoint.completedSteps || []).map((s) => {
    // 步骤与产物的关联有两条来源：产物自身的 step 标签，以及步骤自己登记的 artifacts 路径
    const declared = new Set([...(Array.isArray(s.artifacts) ? s.artifacts : []), ...artifacts.filter((a) => a.step && a.step === s.name).map((a) => a.path)]);
    const touched = artifacts.filter((a) => declared.has(a.path));
    const stale = touched.some((a) => a.status !== 'intact');
    return {
      name: s.name,
      status: s.status || 'succeeded',
      reusable: (s.status || 'succeeded') === 'succeeded' && !stale,
      stale,
      reason: stale
        ? '该步骤的产物已被外部修改或删除，结果不可直接复用，需要重新核验'
        : ((s.status || 'succeeded') === 'succeeded' ? '已完成且产物未变，可复用' : '该步骤未成功，需重做'),
    };
  });

  const capDrift = [];
  if (capabilities && checkpoint.capabilityCode && checkpoint.capabilityCode !== capabilities.capCode) {
    capDrift.push(`能力掩码已变化：${checkpoint.capabilityCode} → ${capabilities.capCode}`);
  }
  if (capabilities && checkpoint.pendingNeedsSandbox && capabilities.sandbox && capabilities.sandbox.enabled === false) {
    capDrift.push('未完成步骤需要沙箱，但沙箱当前已关闭');
  }
  const drift = missingArtifacts.length ? 'artifact-missing'
    : changedArtifacts.length ? 'artifact-drift'
      : (capDrift.length ? 'capability-drift' : 'none');
  const needsUserReconfirmation = checkpoint.riskLevel === 'L3' || capDrift.length > 0;

  return {
    ok: true,
    drift,
    artifacts,
    changedArtifacts,
    missingArtifacts,
    completedSteps,
    capabilityDrift: capDrift,
    needsUserReconfirmation,
    reason: [
      changedArtifacts.length ? `${changedArtifacts.length} 个产物已被外部修改` : '',
      missingArtifacts.length ? `${missingArtifacts.length} 个产物已不存在` : '',
      ...capDrift,
    ].filter(Boolean).join('；') || '产物与能力状态均未变化',
    checkedAt: now(),
  };
}

// ── 恢复计划：可续跑吗、从哪个入口进、先核验什么、要不要重新确认 ────────
export function planResume(checkpoint, { files = {}, capabilities = null, budget = null, userText = '', now = () => Date.now() } = {}) {
  const verdict = verifyCheckpoint(checkpoint, { files, capabilities, now });
  if (!verdict.ok) {
    return {
      resumable: false, entryState: 'RECEIVED', completedSteps: [], verificationSteps: [],
      needsConfirmation: false, blockers: [verdict.reason], summary: '没有可恢复的执行检查点，按新任务处理。',
      policyVersion: RECOVERY_POLICY_VERSION, verdict,
    };
  }
  const reusable = verdict.completedSteps.filter((s) => s.reusable);
  const verificationSteps = [];
  for (const a of verdict.artifacts) {
    if (a.status === 'changed' || a.status === 'missing') verificationSteps.push(`read_file ${a.path}（核验产物当前状态）`);
  }
  for (const a of verdict.artifacts) {
    if (a.status === 'intact' && a.step) verificationSteps.push(`list_files（确认 ${a.path} 仍在预期位置）`);
  }
  const uncertain = (checkpoint.idempotencyKeys || []).length
    ? [`若中断发生在写操作中：先 read_file 核验 ${(checkpoint.idempotencyKeys || []).length} 个幂等键对应的目标，再决定是否重发`]
    : [];
  const blockers = [];
  if (capabilities && checkpoint.pendingNeedsSandbox && capabilities.sandbox && capabilities.sandbox.enabled === false) {
    blockers.push('未完成步骤需要沙箱，但沙箱当前关闭：请打开沙箱开关或改用不依赖沙箱的方案');
  }
  const needsConfirmation = verdict.needsUserReconfirmation;
  const pending = checkpoint.pendingStep || '';
  // P2 修正：resumable 不能只看「有没有阻塞」。一个什么都没做的检查点也会被判成
  // 「可续跑」，于是下一轮被塞进一条毫无内容的续跑提示——这类噪音会让计划本身失效。
  // 必须真的存在可推进的内容（可复用步骤 / 待核验产物 / 未完成步骤）才算可续跑。
  const actionable = (reusable.length + verificationSteps.length) > 0 || !!pending;
  const summary = [
    `上一轮停在「${checkpoint.executionState || 'UNKNOWN'}」，已完成 ${reusable.length}/${verdict.completedSteps.length} 步（可复用）`,
    pending ? `未完成步骤：${pending}` : '没有明确的未完成步骤',
    verdict.drift !== 'none' ? `状态漂移：${verdict.reason}` : '产物状态与检查点一致',
    needsConfirmation ? '存在高风险（L3）或能力变化：续跑前需要用户重新确认' : '',
    actionable ? '' : '检查点里没有可复用的步骤、可核验的产物或未完成步骤：按新任务处理，不注入续跑计划',
  ].filter(Boolean).join('；') + '。';
  return {
    resumable: blockers.length === 0 && actionable,
    actionable,
    entryState: checkpoint.executionState === 'RECOVERY_PENDING' ? 'RECOVERY_PENDING' : 'RECOVERY_PENDING',
    phaseLabel: checkpoint.executionState || '',
    completedSteps: verdict.completedSteps,
    reusableSteps: reusable.map((s) => s.name),
    pendingStep: pending,
    verificationSteps: [...new Set([...verificationSteps, ...uncertain])].slice(0, 6),
    needsConfirmation,
    blockers,
    drift: verdict.drift,
    summary,
    policyVersion: RECOVERY_POLICY_VERSION,
    verdict,
    plannedAt: now(),
  };
}

export function formatResumePlan(plan, { maxSteps = 4 } = {}) {
  if (!plan || !plan.completedSteps) return '';
  const lines = ['【执行内核 · 断点续跑计划】', plan.summary];
  if (plan.reusableSteps && plan.reusableSteps.length) {
    lines.push(`· 可直接复用：${plan.reusableSteps.slice(0, 8).join('、')}（已完成且产物未变，不要重复执行）`);
  }
  if (plan.verificationSteps && plan.verificationSteps.length) {
    lines.push(`· 续跑前先核验（副作用可能已发生）：${plan.verificationSteps.slice(0, maxSteps).join('；')}`);
  }
  if (plan.pendingStep) lines.push(`· 未完成步骤：${plan.pendingStep}`);
  if (plan.needsConfirmation) lines.push('· 该续跑涉及高风险操作或能力变化：需要用户明确确认后再执行');
  if (plan.blockers && plan.blockers.length) lines.push(`· 阻塞：${plan.blockers.join('；')}`);
  return lines.join('\n');
}

export function formatCheckpointLine(cp) {
  if (!cp) return '';
  const okSteps = (cp.completedSteps || []).filter((s) => (s.status || 'succeeded') === 'succeeded').length;
  return `【检查点 ${cp.checkpointId}】阶段=${cp.executionState || '-'} · 完成 ${okSteps}/${(cp.completedSteps || []).length} 步 · 产物 ${(cp.artifacts || []).length} 个 · 状态摘要 ${String(cp.stateDigest || '').slice(0, 10)}`;
}

// 轨迹级检查点质量：用于遥测（检查点是否可续、漂移多少）
export function summarizeCheckpointHealth({ checkpoints = [], files = {}, capabilities = null } = {}) {
  const latest = checkpoints.length ? checkpoints[checkpoints.length - 1] : null;
  if (!latest) return { count: 0, health: 'no-checkpoint', resumable: false, drift: 'none' };
  const verdict = verifyCheckpoint(latest, { files, capabilities });
  return {
    count: checkpoints.length,
    health: verdict.drift === 'none' ? 'intact' : verdict.drift,
    resumable: verdict.artifacts.every((a) => a.status === 'intact'),
    drift: verdict.drift,
    reusableSteps: verdict.completedSteps.filter((s) => s.reusable).length,
    totalSteps: verdict.completedSteps.length,
    checkpointId: latest.checkpointId,
  };
}
