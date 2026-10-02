// ─── P3 增量（THN v2.5.1）：任务后自清理 —— 让「删掉无用文件」成为习惯 ────
// 用户诉求：「养成 Agent 习惯在每次完成任务后删除无用文件」。
//
// 为什么不能只写进提示词：
//   提示词只能「希望」模型记得删；模型忘了、被预算截断、或干脆没意识到自己留了垃圾，
//   文件就永久留在沙箱里。所以这里把「清理」做成**内核行为**：回合正常结束后由内核过一遍
//   文件系统，按规则删掉它自己产生的临时产物，并把每一次删除的理由如实记账、告知用户。
//
// 三条硬约束（宁可漏删，不可错删）：
//   1) 只删「本 Agent 自己创建的」文件（有创建台账），用户上传的原件与外部文件一律不碰；
//   2) 受保护路径（uploads/ 等）、被回答/提问引用到的文件、以及不在允许范围内的路径一律保留；
//   3) 每一次删除都必须给出规则 id 与理由，保留的也要能说出为什么保留（no silent decision）。
//
// 本模块是纯策略：不认识 store / fs，删除动作由调用方通过 io 适配器注入，便于测试。

export const CLEANUP_POLICY_VERSION = 'cleanup-policy-2.5.1';
export const CLEANUP_SCHEMA_VERSION = 'cleanup-schema-1';

/**
 * 三档策略（默认 strip）：
 *   strip —— 任务完成后真的删除（用户诉求：「养成习惯」）
 *   report —— 只列出「本来会删什么」，一个文件都不动（先观察，再放心开）
 *   off —— 连检查都不做
 * 三档都不影响三条硬约束：只删创建台账内的文件 / 受保护路径与引用文件一律保留 / 每次删除都要给出理由。
 */
export const CLEANUP_MODES = Object.freeze({
  strip: { id: 'strip', label: '自动清理', run: true, del: true, hint: '任务完成后删除 Agent 自建的临时文件（受保护路径与交付物不动）' },
  report: { id: 'report', label: '只报告', run: true, del: false, hint: '只列出可清理项与理由，不删除任何文件' },
  off: { id: 'off', label: '关闭', run: false, del: false, hint: '回合结束后不做文件检查' },
});

export function normalizeCleanupPolicy(value) {
  const v = String(value == null ? '' : value).toLowerCase().trim();
  return CLEANUP_MODES[v] ? v : 'strip';
}

export function cleanupPolicyOf(settings = {}) {
  return CLEANUP_MODES[normalizeCleanupPolicy(settings && settings.cleanupPolicy)] || CLEANUP_MODES.strip;
}

/** 临时目录：写这些位置的产物默认被当作中间产物。 */
export const SCRATCH_DIRS = Object.freeze(['tmp/', 'temp/', 'scratch/', '.scratch/', 'intermediate/', 'logs/']);

/** 临时后缀：显式标了临时性质的产物。 */
export const SCRATCH_EXTS = Object.freeze(['.tmp', '.temp', '.part', '.bak', '.draft', '.swp', '.scratch', '.log', '.tmp.txt']);

/** 临时命名：文件名里带这些词（按 `-_.` 或首尾切分，避免误伤 report-tempest.md 这类词）。 */
export const SCRATCH_TOKENS = Object.freeze(['tmp', 'temp', 'scratch', 'draft', 'dummy', 'wip', '临时', '草稿', '中间产物', '废弃']);

/** 删除规则（每条都要能解释）：id 稳定，报告与测试都按它断言。 */
export const CLEANUP_RULES = Object.freeze({
  scratchDir: { id: 'scratch-dir', label: '位于临时目录' },
  scratchExt: { id: 'scratch-ext', label: '临时后缀' },
  scratchName: { id: 'scratch-name', label: '临时命名' },
  emptyAgentFile: { id: 'empty-agent-file', label: 'Agent 创建的空文件' },
});

/** 保留原因（保留也要有理由，不能「悄悄放过」）。 */
export const CLEANUP_KEEP_REASONS = Object.freeze({
  protectedPath: { id: 'protected-path', label: '受保护路径（用户原件等）' },
  referencedInAnswer: { id: 'referenced-in-answer', label: '最终回答引用了它（视为交付物）' },
  referencedByUser: { id: 'referenced-by-user', label: '本轮的提问里提到了它' },
  notAgentCreated: { id: 'not-agent-created', label: '不是本 Agent 创建的（没有创建台账）' },
  noRuleMatched: { id: 'no-scratch-rule', label: '不符合任何临时文件规则' },
  outsideScope: { id: 'outside-scope', label: '不在本轮允许的路径范围内' },
  disabled: { id: 'disabled', label: '自动清理已关闭' },
});

function norm(path) {
  return String(path == null ? '' : path).replace(/^\.\//, '').trim();
}

function extOf(path) {
  const base = String(path || '').split('/').pop() || '';
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i).toLowerCase() : '';
}

function baseOf(path) {
  return String(path || '').split('/').pop() || '';
}

/** 是否位于临时目录。 */
export function isScratchDir(path) {
  const p = norm(path);
  return SCRATCH_DIRS.some((d) => p === d.replace(/\/$/, '') || p.startsWith(d));
}

/** 是否带临时后缀。 */
export function isScratchExt(path) {
  const p = norm(path).toLowerCase();
  const e = extOf(p);
  return SCRATCH_EXTS.includes(e) || SCRATCH_EXTS.some((x) => p.endsWith(x));
}

/** 文件名是否含临时词（按分隔符切分，避免 report-tempest / template.md 之类误伤）。 */
export function isScratchName(path) {
  const base = baseOf(norm(path)).toLowerCase().replace(/\.[a-z0-9]{1,8}$/, '');
  if (!base) return false;
  const parts = base.split(/[-_.\s]+/).filter(Boolean);
  if (parts.some((x) => SCRATCH_TOKENS.includes(x))) return true;
  // 中文没有分隔符：直接包含
  return SCRATCH_TOKENS.some((t) => /[\u4e00-\u9fa5]/.test(t) && base.includes(t));
}

export function isProtectedPath(path, protectedPaths = ['uploads/']) {
  const p = norm(path);
  return (protectedPaths || []).some((pre) => pre && (p === String(pre).replace(/\/$/, '') || p.startsWith(String(pre))));
}

function pathAllowed(path, allowedPaths = []) {
  if (!Array.isArray(allowedPaths) || !allowedPaths.length) return true;
  const p = norm(path);
  return allowedPaths.some((pre) => p === String(pre).replace(/\/$/, '') || p.startsWith(String(pre)));
}

/** 文本里是否提到这个文件（全路径 / 文件名 / 去 ./ 前缀）。 */
export function isReferenced(path, texts = []) {
  const p = norm(path);
  if (!p) return false;
  const base = baseOf(p);
  const noExt = base.replace(/\.[a-z0-9]{1,8}$/i, '');
  return (texts || []).some((t) => {
    const s = String(t || '');
    if (!s) return false;
    if (s.includes(p)) return true;
    if (base && s.includes(base)) return true;
    // 只写了不带扩展名的名字（例如回答里写 outputs/report，实际文件是 report.md）
    if (noExt && noExt.length >= 3 && new RegExp(`(?:^|[^\\w.-])${noExt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^\\w.-])`).test(s)) return true;
    return false;
  });
}

/** 字符体积（面板展示用；真实字节数由 TextEncoder 在 apply 时算，避免每轮全量编码）。 */
export function charCount(text) {
  return String(text == null ? '' : text).length;
}

/**
 * 生成清理计划。纯函数：**不改任何东西**，只给「删哪些 / 留哪些 / 为什么」。
 *
 * @param {object} p
 * @param {object} p.files          { path: content }（沙箱全量文件）
 * @param {Array}  p.artifacts      Agent 创建台账 [{path, at, turnId, tool}]（只有这里的文件才可能被删）
 * @param {string} p.answerText     本轮最终回答（引用到的文件视为交付物）
 * @param {string} p.userText       本轮用户提问
 * @param {Array}  p.protectedPaths 受保护路径前缀（默认 uploads/）
 * @param {Array}  p.allowedPaths   允许范围（空数组 = 不限制）
 * @param {boolean} p.enabled       自动清理开关（关闭时只出计划、不删）
 */
export function planCleanup({
  files = {},
  artifacts = [],
  answerText = '',
  userText = '',
  protectedPaths = ['uploads/'],
  allowedPaths = [],
  enabled = true,
  maxDeletes = 24,
} = {}) {
  const ledger = new Set((Array.isArray(artifacts) ? artifacts : []).map((a) => norm(a && a.path)).filter(Boolean));
  const deletes = [];
  const keeps = [];
  const paths = Object.keys(files || {}).filter(Boolean).map(norm);
  for (const path of paths) {
    const content = files[path];
    const chars = charCount(content);
    const push = (rule, extra = {}) => {
      if (keeps.length <= 400) keeps.push({ path, rule, reason: (CLEANUP_KEEP_REASONS[rule] || {}).label || rule, chars, ...extra });
    };
    if (isProtectedPath(path, protectedPaths)) { push('protectedPath'); continue; }
    if (!ledger.has(path)) { push('notAgentCreated'); continue; }
    if (!pathAllowed(path, allowedPaths)) { push('outsideScope'); continue; }
    if (isReferenced(path, [answerText, userText])) { push(isReferenced(path, [answerText]) ? 'referencedInAnswer' : 'referencedByUser'); continue; }
    let matched = null;
    if (isScratchDir(path)) matched = CLEANUP_RULES.scratchDir;
    else if (isScratchExt(path)) matched = CLEANUP_RULES.scratchExt;
    else if (isScratchName(path)) matched = CLEANUP_RULES.scratchName;
    else if (chars === 0) matched = CLEANUP_RULES.emptyAgentFile;
    if (!matched) { push('noRuleMatched'); continue; }
    deletes.push({
      path,
      rule: matched.id,
      ruleLabel: matched.label,
      reason: `${matched.label}（本 Agent 创建，未被回答或提问引用）`,
      chars,
      // 预览：面板里点开能看清理前的那几行长什么样，避免「删了什么都不知道」
      preview: String(content == null ? '' : content).slice(0, 160),
    });
  }
  // 稳定排序：先临时目录，再按体积从大到小（一次清理优先腾出空间）
  deletes.sort((a, b) => (Number(isScratchDir(b.path)) - Number(isScratchDir(a.path))) || (b.chars - a.chars) || a.path.localeCompare(b.path));
  const trimmed = deletes.slice(0, Math.max(0, maxDeletes));
  const deferred = deletes.slice(Math.max(0, maxDeletes)).map((d) => ({ ...d, rule: 'deferred', reason: '超出单轮清理上限，留待下一轮' }));
  const keptChars = keeps.reduce((acc, k) => acc + k.chars, 0);
  return {
    policyVersion: CLEANUP_POLICY_VERSION,
    schemaVersion: CLEANUP_SCHEMA_VERSION,
    enabled: !!enabled,
    scanned: paths.length,
    ledgerSize: ledger.size,
    deletes: trimmed,
    deferred,
    keeps,
    deleteChars: trimmed.reduce((acc, d) => acc + d.chars, 0),
    keepChars: keptChars,
    // 关闭开关时也要给出「本来会删什么」——否则用户看不到代价
    wouldDelete: trimmed.length,
    at: Date.now(),
  };
}

/**
 * 执行清理计划（io 由调用方注入，便于单测与「先核验后删除」）。
 * io: { remove(path), read(path), exists(path) }
 */
export function applyCleanup({ plan = null, io = {} } = {}) {
  if (!plan || !Array.isArray(plan.deletes) || !io || typeof io.remove !== 'function') {
    return { ok: true, skipped: true, reason: '没有可执行的清理计划', deleted: [], failed: [], verified: true };
  }
  const deleted = [];
  const failed = [];
  for (const item of plan.deletes) {
    try {
      io.remove(item.path);
      deleted.push({ ...item, ok: true });
    } catch (err) {
      failed.push({ ...item, ok: false, error: String((err && err.message) || err).slice(0, 120) });
    }
  }
  // 删除后必须真的验证：说删了却还在（或被别的路径拦下）要当缺陷处理，而不是报个成功
  const survivors = [];
  if (typeof io.exists === 'function') {
    for (const d of deleted) {
      try { if (io.exists(d.path)) survivors.push(d.path); } catch { /* 校验失败不阻塞 */ }
    }
  }
  return {
    ok: failed.length === 0 && survivors.length === 0,
    skipped: false,
    deleted,
    failed,
    survivors,
    verified: survivors.length === 0,
    deletedChars: deleted.reduce((acc, d) => acc + (Number(d.chars) || 0), 0),
    policyVersion: CLEANUP_POLICY_VERSION,
  };
}

/**
 * 合并本 Agent 的创建台账（跨轮保留）：
 * 只有出现在台账里的文件才有资格被自清理，所以台账要如实、去重、限容。
 */
export function mergeArtifacts(existing = [], created = [], { max = 200, at = Date.now(), turnId = '' } = {}) {
  const map = new Map();
  for (const a of Array.isArray(existing) ? existing : []) {
    const p = norm(a && a.path);
    if (p) map.set(p, { ...a, path: p });
  }
  for (const c of Array.isArray(created) ? created : []) {
    const p = norm(c && c.path);
    if (!p) continue;
    const prev = map.get(p);
    map.set(p, { path: p, at: at, turnId: turnId || (c && c.turnId) || '', tool: (c && c.tool) || (prev && prev.tool) || '', chars: Number(c && c.chars) || (prev && prev.chars) || 0 });
  }
  const list = [...map.values()];
  return list.slice(-max);
}

/** 从清理结果里移除已经不在文件系统里的台账项（删干净了就不必一直背着）。 */
export function pruneArtifacts(artifacts = [], files = {}) {
  const live = new Set(Object.keys(files || {}).map(norm));
  return (Array.isArray(artifacts) ? artifacts : []).filter((a) => live.has(norm(a && a.path)));
}

export function formatCleanupBrief(result, { maxNames = 3 } = {}) {
  if (!result || result.skipped) return '';
  const list = result.deleted || [];
  if (!list.length) return '';
  const names = list.slice(0, maxNames).map((d) => d.path);
  const more = list.length > names.length ? ` 等 ${list.length} 个` : '';
  return `🧹 已清理 ${list.length} 个临时文件（${names.join('、')}${more}，共 ${formatChars(result.deletedChars)}）`;
}

export function formatChars(chars) {
  const n = Number(chars) || 0;
  if (n < 1000) return `${n} 字符`;
  if (n < 1000 * 1000) return `${(n / 1000).toFixed(1)}K 字符`;
  return `${(n / 1000000).toFixed(2)}M 字符`;
}

/** `/cleanup` 详情报告：删了什么、留了什么、为什么。 */
export function formatCleanupReport(plan, applied = null, { maxKeeps = 8, maxDeletes = 12 } = {}) {
  if (!plan) return '【文件清理】没有可用的计划';
  const lines = [`【文件清理 · ${plan.policyVersion}】扫描 ${plan.scanned} 个文件（创建台账 ${plan.ledgerSize} 条）`];
  if (applied && applied.deleted && applied.deleted.length) {
    lines.push(`  · 已删除 ${applied.deleted.length} 个（${formatChars(applied.deletedChars)}）${applied.verified ? '，删除后已核验' : `，⚠ ${applied.survivors.length} 个仍在文件系统里`}`);
    for (const d of applied.deleted.slice(0, maxDeletes)) lines.push(`      - ${d.path} ｜ ${d.ruleLabel || d.rule} ｜ ${formatChars(d.chars)}`);
    if (applied.deleted.length > maxDeletes) lines.push(`      - …另有 ${applied.deleted.length - maxDeletes} 个`);
  } else if (plan.deletes && plan.deletes.length) {
    lines.push(`  · 待删除 ${plan.deletes.length} 个（${formatChars(plan.deleteChars)}）${plan.enabled ? '' : '——自动清理已关闭，本次只报告不删除'}`);
    for (const d of plan.deletes.slice(0, maxDeletes)) lines.push(`      - ${d.path} ｜ ${d.ruleLabel || d.rule} ｜ ${formatChars(d.chars)}`);
    if (plan.deletes.length > maxDeletes) lines.push(`      - …另有 ${plan.deletes.length - maxDeletes} 个`);
  } else {
    lines.push('  · 没有需要清理的临时文件');
  }
  if (plan.deferred && plan.deferred.length) lines.push(`  · 超出单轮上限、留待下一轮：${plan.deferred.length} 个`);
  const keeps = (plan.keeps || []).filter((k) => k.rule !== 'notAgentCreated' && k.rule !== 'noRuleMatched');
  if (keeps.length) {
    lines.push(`  · 明确保留 ${keeps.length} 个（受保护 / 被引用）`);
    for (const k of keeps.slice(0, maxKeeps)) lines.push(`      - ${k.path} ｜ ${k.reason}`);
  }
  if (applied && applied.failed && applied.failed.length) {
    lines.push(`  · ⚠ 删除失败 ${applied.failed.length} 个：${applied.failed.map((f) => f.path).join('、')}`);
  }
  return lines.join('\n');
}
