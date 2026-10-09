import { CORE_TOOL_NAMES, TOOL_MOUNT_RULES as REG_TOOL_MOUNT_RULES } from './capabilities.js';
// ─── P2（Dubhe Helix 2.5）：统一执行上下文（单一真相源）───────────────────────────
// 对应 P2 验收要点第 1 条：**统一 ExecutionContext，避免「声明允许 Web 但工具表没有 Web」
// 这类状态分裂**。
//
// 为什么要有这一层：能力掩码（谁能用）、工具表（有哪些工具）、预算（能用多少）、风险上限
// （最多能干到什么程度）、确认策略（哪些必须问人）以前分散在 agent.js 的几段代码里各自计算。
// 只要其中一处被改而另一处没跟上，就会出现「上下文说可以联网，但工具表里网页工具缺失」
// 这种自相矛盾——模型会去调一个不存在的工具，浪费一轮，而且审计记录无法解释到底哪个口径生效。
//
// 本模块把「一轮执行的完整状态」收进一个冻结对象，并让工具表**由它派生**（deriveToolWhitelist），
// 于是两者在构造上就不可能不一致；再用 assertExecutionContextConsistency 主动检出
// 四类经典分裂（能力/工具、约束/能力、预算/档位、策略/审计），把它们当缺陷报出来。
//
// 混版纪律：本文件不 import 任何其它 js/ 模块（能力约束对象由调用方注入），
// 这样旧缓存下缺任何一侧都不会白屏，最坏情况是上下文退化成纯布尔掩码。

export const EXECUTION_CONTEXT_VERSION = 'exec-context-2.5.0';

/** 上下文的固定分区：报告/面板按这个顺序渲染，缺分区显示「未记录」而不是塌掉。 */
export const CONTEXT_SECTIONS = Object.freeze([
  'identity', 'intent', 'capability', 'budget', 'risk', 'memory', 'policy', 'experiment', 'audit', 'recovery',
]);

/** 可检出的状态分裂类型（报错口径要稳定，测试与面板都按 code 断言）。 */
export const CONTEXT_SPLIT_CODES = Object.freeze({
  capabilityWithoutTool: 'capability-declared-without-tool',
  toolWithoutCapability: 'tool-present-without-capability',
  constraintShadowsCapability: 'constraint-shadows-capability',
  reasoningWithoutDispatch: 'reasoning-high-without-dispatch',
  budgetBelowDispatchParallel: 'budget-cannot-serve-declared-parallelism',
  riskCeilingAboveGuard: 'risk-ceiling-above-guard-mode',
  auditContextIncomplete: 'audit-context-incomplete',
  policyUnpinned: 'policy-version-unpinned',
  toolTableDrift: 'tool-table-drift-from-context',
  claimDiffersEffective: 'declared-capability-differs-effective',
});

const CAPABILITY_TOOLS = Object.freeze([
  ['relay', null],                       // relay 是通道前提，不绑定单一工具
  ['web', 'fetch_url'],                  // 基础网页抓取能力
  ['web', 'search_web', 'search'],       // Worker 可选路由，由 health.capabilities 声明
  ['web', 'crawl_site', 'crawl'],
  ['web', 'download_file', 'file'],    // 跨域文件拉取路由，同样由 health.capabilities 声明
  ['web', 'screenshot_web', 'screenshot'], // 网页截图（Browser Run）路由，同样由 health.capabilities 声明
  ['sandbox', 'execute_javascript'],
  ['dispatch', 'dispatch_subagent'],
]);

// 只在中继（本地服务）可用、且不依赖具体能力位的工具：中继不在就必须摘掉
export const RELAY_DEPENDENT_TOOLS = Object.freeze(['fetch_url', 'search_web', 'crawl_site', 'download_file', 'screenshot_web']);

// 受沙箱能力位管辖的工具（与 js/tools.js 的 CODE_TOOL_NAMES 必须一致；有单测钉住）
export const SANDBOX_GATED_TOOLS = Object.freeze(['execute_javascript', 'execute_python', 'execute_cpp']);

function nz(v, fallback = '') {
  return v === undefined || v === null ? fallback : v;
}

/**
 * 构造一轮执行的统一上下文。
 *
 * @param {object} p
 * @param {object} p.capability   buildCapabilityConstraints(...) 的返回值（Availability+Scope+Budget+Risk）
 * @param {object} p.policy       policy.js 的 snapshotPolicies()（策略版本快照）
 * @param {object} p.audit        audit.js 的审计绑定字段（schemaVersion/prevDigest/eventIndex…）
 * @param {object} p.experiment   实验分配（resolveExperimentAssignment 结果）
 * @param {object} p.recovery     { checkpointId, resumable, drift }（可选）
 * @param {object} p.budget       预算快照（createBudgetGovernor(...).budget 或 .snapshot()）
 */
export function createTurnExecutionContext({
  turnId = 'turn-local',
  sessionId = 'local',
  userIntent = '',
  intentDigest = '',
  taskClass = 'chat',
  attachments = 0,
  reasoningState = 'MEDIUM',
  mode = '',
  capability = null,
  budget = null,
  risk = null,
  memory = null,
  policy = null,
  experiment = null,
  audit = null,
  recovery = null,
  claimedBits = null,      // 「对外声明的」能力（提示词/路由按它说话）。真实可用性永远看 bits。
} = {}) {
  const bits = (capability && capability.bits) || { relay: 0, web: 0, sandbox: 0, dispatch: 0 };
  // 声明能力：只覆盖调用方**显式给出**的那几位，其余沿用实际值——
  // 否则「只声明 web」会被读成「同时声明 sandbox=0」，凭空多报三项分裂。
  const claimed = {
    relay: claimedBits && claimedBits.relay !== undefined ? !!claimedBits.relay : !!bits.relay,
    web: claimedBits && claimedBits.web !== undefined ? !!claimedBits.web : !!bits.web,
    sandbox: claimedBits && claimedBits.sandbox !== undefined ? !!claimedBits.sandbox : !!bits.sandbox,
    dispatch: claimedBits && claimedBits.dispatch !== undefined ? !!claimedBits.dispatch : !!bits.dispatch,
  };
  const ctx = {
    version: EXECUTION_CONTEXT_VERSION,
    identity: Object.freeze({
      turnId,
      sessionId,
      traceId: `${sessionId}:${turnId}`,
      mode: nz(mode),
    }),
    intent: Object.freeze({
      text: String(userIntent || '').slice(0, 400),
      digest: nz(intentDigest),
      taskClass,
      reasoningState: String(reasoningState || 'MEDIUM').toUpperCase(),
      attachments: Number(attachments) || 0,
    }),
    // 能力 = 可用性（bits）+ 约束（constraints）：sandbox 是否禁网、允许路径、并发上限、
    // 用户原件是否可覆盖，全都挂在同一个对象上，不允许别处再存一份「差不多」的副本。
    capability: Object.freeze({
      // bits = 实际可用（工具表按它派生，模型的实际能力）；claimed = 对外声明（提示词/界面口径）。
      // 两者不一致就是「状态分裂」，本模块负责把它变成可断言的对象，而不是让模型去撞墙。
      bits: Object.freeze({ relay: !!bits.relay, web: !!bits.web, sandbox: !!bits.sandbox, dispatch: !!bits.dispatch }),
      claimed: Object.freeze(claimed),
      capCode: (capability && capability.capCode) || 'R0·W0·S0·D0',
      constraints: capability || null,
    }),
    budget: Object.freeze({ ...((budget && (budget.budget || budget)) || {}) }),
    risk: Object.freeze({
      ceiling: (risk && risk.ceiling) || 'L3',
      requiresConfirmation: !!(risk && risk.requiresConfirmation),
      hasExternalSideEffect: !!(risk && risk.hasExternalSideEffect),
      ...(risk && risk.policyVersion ? { policyVersion: risk.policyVersion } : {}),
    }),
    memory: Object.freeze({ recalledIds: [], candidateWrite: false, ...(memory || {}) }),
    policy: Object.freeze({
      registryVersion: (policy && policy.registryVersion) || '',
      versions: Object.freeze({ ...((policy && policy.versions) || {}) }),
    }),
    experiment: Object.freeze({ experimentId: '', variantId: '', inExperiment: false, ...(experiment || {}) }),
    audit: Object.freeze({
      schemaVersion: (audit && audit.schemaVersion) || '',
      policyVersion: (audit && audit.policyVersion) || '',
      eventIndex: Number((audit && audit.eventIndex) || 0),
      prevDigest: (audit && audit.prevDigest) || '',
    }),
    recovery: Object.freeze({
      checkpointId: '',
      resumable: false,
      drift: [],
      ...(recovery || {}),
    }),
  };
  return Object.freeze(ctx);
}

/**
 * 工具表白名单**由上下文派生**——这是本模块存在的理由。
 * 纯函数：同一上下文永远给出同一张表（顺序保持 allTools 原序）。
 * @returns {{ allowed: Array, dropped: Array<{name, reason}> }}
 */
export function deriveToolWhitelist(ctx, allTools = []) {
  const list = Array.isArray(allTools) ? allTools : [];
  const bits = (ctx && ctx.capability && ctx.capability.bits) || {};
  const allowed = [];
  const dropped = [];
  for (const tool of list) {
    const name = toolName(tool);
    if (!name) { dropped.push({ name: '(unnamed)', reason: 'no-tool-name' }); continue; }
    if (RELAY_DEPENDENT_TOOLS.includes(name) && !bits.web) {
      // 摘除理由分两层说清楚：是通道没通（中继不在），还是开关关了（联网被关）
      dropped.push({ name, reason: bits.relay ? 'capability-web-off' : 'relay-offline' });
      continue;
    }
    const webConstraints = ctx && ctx.capability && ctx.capability.constraints && ctx.capability.constraints.web;
    // 可选 Worker 路由必须有明确的 health capability 声明；缺省/未知不能推断为可用。
    if (name === 'search_web' && (!webConstraints || webConstraints.search !== true)) {
      dropped.push({ name, reason: 'relay-search-unavailable' });
      continue;
    }
    if (name === 'crawl_site' && (!webConstraints || webConstraints.crawl !== true)) {
      dropped.push({ name, reason: 'relay-crawl-unavailable' });
      continue;
    }
    if (name === 'download_file' && (!webConstraints || webConstraints.file !== true)) {
      dropped.push({ name, reason: 'relay-file-unavailable' });
      continue;
    }
    if (name === 'screenshot_web' && (!webConstraints || webConstraints.screenshot !== true)) {
      dropped.push({ name, reason: 'relay-screenshot-unavailable' });
      continue;
    }
    if (RELAY_DEPENDENT_TOOLS.includes(name) && !bits.relay) { dropped.push({ name, reason: 'relay-offline' }); continue; }
    if (name === 'dispatch_subagent' && !bits.dispatch) { dropped.push({ name, reason: 'capability-dispatch-off' }); continue; }
    if (SANDBOX_GATED_TOOLS.includes(name) && !bits.sandbox) { dropped.push({ name, reason: 'capability-sandbox-off' }); continue; }
    if (name === 'execute_cpp' && ctx && ctx.capability && ctx.capability.constraints && ctx.capability.constraints.sandbox
        && ctx.capability.constraints.sandbox.remoteCpp === false) { dropped.push({ name, reason: 'remote-cpp-off' }); continue; }
    allowed.push(tool);
  }
  return { allowed, dropped };
}

// ─── P3 修正：能力门控不透明 ─────────────────────────────────────────────
// dropped[].reason 以前只进审计记录；UI 与系统提示各自推导一套「为什么不可用」的说法。
// 这里给每个 reason 一份固定中文文案 + 一个直达修复动作，UI 弹层与提示词共用，不再出现两种口径。
export const DROP_REASON_LABEL = Object.freeze({
  'capability-dispatch-off': '思考档位需 Max/Ultra',
  'capability-web-off': '顶栏「联网」已关',
  'relay-offline': '网页中继未通过健康检查',
  'relay-search-unavailable': '中继未声明 search',
  'relay-crawl-unavailable': '中继未声明 crawl',
  'relay-file-unavailable': '中继未声明 file',
  'relay-screenshot-unavailable': '中继未声明 screenshot',
  'capability-sandbox-off': '顶栏「沙箱」已关',
  'remote-cpp-off': '远程 C++ 已关',
  'no-tool-name': '工具定义缺少名称',
});

/** 直达开关：kind 由 UI 映射到实际操作（切档位 / 开开关 / 重探中继 / 打开设置）。 */
export const DROP_REASON_FIX = Object.freeze({
  'capability-dispatch-off': Object.freeze({ kind: 'reasoning-max', label: '切到 Max' }),
  'capability-web-off': Object.freeze({ kind: 'web-on', label: '打开联网' }),
  'relay-offline': Object.freeze({ kind: 'relay-reprobe', label: '重新探测中继' }),
  'relay-search-unavailable': Object.freeze({ kind: 'relay-reprobe', label: '重新探测中继' }),
  'relay-crawl-unavailable': Object.freeze({ kind: 'relay-reprobe', label: '重新探测中继' }),
  'relay-file-unavailable': Object.freeze({ kind: 'relay-reprobe', label: '重新探测中继' }),
  'relay-screenshot-unavailable': Object.freeze({ kind: 'relay-reprobe', label: '重新探测中继' }),
  'capability-sandbox-off': Object.freeze({ kind: 'sandbox-on', label: '打开沙箱' }),
  'remote-cpp-off': Object.freeze({ kind: 'settings', label: '打开设置' }),
});

export function describeDropReason(reason) {
  return DROP_REASON_LABEL[reason] || String(reason || '未知原因');
}

/** 「已禁用 N 个：a（原因）、b（原因）」——UI 弹层与系统提示同一句话；没有裁剪返回空串。 */
export function formatDroppedTools(dropped, { max = 16 } = {}) {
  const list = (Array.isArray(dropped) ? dropped : []).filter((d) => d && d.name && d.name !== '(unnamed)');
  if (!list.length) return '';
  const shown = list.slice(0, max).map((d) => `${d.name}（${describeDropReason(d.reason)}）`);
  const more = list.length > max ? `…等 ${list.length} 个` : '';
  return `已禁用 ${list.length} 个：${shown.join('、')}${more}`;
}

/**
 * 从「当前开关态」直接派生工具表（不必先构造整轮上下文）。
 * 顶栏能力条在发送前就要回答「现在能用什么、为什么不能」，口径必须与 deriveToolWhitelist 完全一致——
 * 所以这里只是把开关态装成 deriveToolWhitelist 认识的最小 ctx 形状，再调用同一个函数。
 */
export function deriveToolWhitelistFromBits({
  relay = false, web = false, sandbox = true, dispatch = false,
  search = false, crawl = false, file = false, screenshot = false, remoteCpp = true,
} = {}, allTools = []) {
  const ctx = {
    capability: {
      bits: { relay: !!relay, web: !!web, sandbox: !!sandbox, dispatch: !!dispatch },
      constraints: {
        web: { search: search === true, crawl: crawl === true, file: file === true, screenshot: screenshot === true },
        sandbox: { remoteCpp: remoteCpp !== false },
      },
    },
  };
  return deriveToolWhitelist(ctx, allTools);
}

/** 兼容 TOOL_DEFS / OpenAI 两种形状（P0 教训：TOOL_DEFS 条目没有 .function）。 */
export function toolName(tool) {
  if (!tool) return '';
  if (typeof tool === 'string') return tool;
  if (typeof tool.name === 'string' && tool.name) return tool.name;
  if (tool.function && typeof tool.function.name === 'string') return tool.function.name;
  return '';
}

/**
 * 一致性自检：把「状态分裂」变成可断言的对象。
 * 只报告不修改——修与不修由调用方决定（例如 agent.js 会把它记进审计违规）。
 */
export function assertExecutionContextConsistency(ctx, tools = [], { legacyToolNames = null } = {}) {
  const splits = [];
  const add = (code, detail) => splits.push({ code, detail });
  const bits = (ctx && ctx.capability && ctx.capability.bits) || {};
  const c = (ctx && ctx.capability && ctx.capability.constraints) || null;
  const names = new Set((Array.isArray(tools) ? tools : []).map(toolName).filter(Boolean));

  // ① 声明能力 ↔ 实际可用：自称能联网、实际没通道，就是最经典的状态分裂
  const claimed = (ctx && ctx.capability && ctx.capability.claimed) || bits;
  for (const bit of ['relay', 'web', 'sandbox', 'dispatch']) {
    if (!!claimed[bit] !== !!bits[bit]) {
      add(CONTEXT_SPLIT_CODES.claimDiffersEffective, `声明 ${bit}=${claimed[bit] ? 1 : 0}，实际 ${bit}=${bits[bit] ? 1 : 0}`);
    }
  }

  // ② 声明能力 ↔ 工具表（双向）：声明允许 Web 却拿不到 fetch_url，或反过来有工具但能力位是 0
  for (const [bit, tool, feature] of CAPABILITY_TOOLS) {
    if (!tool) continue;
    // 基础 Web 工具 fetch_url 由 web bit 控制；search/crawl 只有 health 明确声明时才成为必需工具。
    const featureAvailable = !feature || !!(c && c.web && c.web[feature] === true);
    const featureUnavailable = !!(feature && c && c.web && c.web[feature] === false);
    if (claimed[bit] && featureAvailable && !names.has(tool)) add(CONTEXT_SPLIT_CODES.capabilityWithoutTool, `能力位 ${bit}=1${feature ? ` 且 Worker 声明 ${feature}=1` : ''} 但工具表没有 ${tool}`);
    if (!bits[bit] && names.has(tool)) add(CONTEXT_SPLIT_CODES.toolWithoutCapability, `工具表有 ${tool} 但能力位 ${bit}=0`);
    if (featureUnavailable && names.has(tool)) add(CONTEXT_SPLIT_CODES.toolWithoutCapability, `Worker 未声明 ${feature}，工具表却有 ${tool}`);
  }

  // ② 约束 ↔ 能力：sandbox 关着却声明禁网/允许路径，等于给一个不存在的执行环境写规则
  if (c && c.sandbox && !bits.sandbox && (c.sandbox.network === false || (c.sandbox.allowedPaths || []).length)) {
    add(CONTEXT_SPLIT_CODES.constraintShadowsCapability, 'sandbox 已关闭，但约束里仍写着禁网/允许路径');
  }
  if (c && c.web && !bits.web && (c.web.allowedHosts || []).length) {
    add(CONTEXT_SPLIT_CODES.constraintShadowsCapability, 'Web 已关闭，但约束里仍写着允许域名');
  }

  // ③ 档位 ↔ 委派：MAX/ULTRA 默认需要委派能力，缺了会导致「说好能拆任务却拆不出去」
  if (['MAX', 'ULTRA'].includes(String(ctx && ctx.intent && ctx.reasoningState || ctx && ctx.reasoningState)) && !bits.dispatch) {
    add(CONTEXT_SPLIT_CODES.reasoningWithoutDispatch, '档位 MAX/ULTRA 但 dispatch 能力为 0');
  }

  // ④ 预算 ↔ 并发声明：并发上限 3 却只给 2 次外部副作用额度，第 3 个委派必被拦（P0 踩过）
  const b = (ctx && ctx.budget) || {};
  if (c && c.dispatch && c.dispatch.enabled && Number.isFinite(Number(b.maxExternalSideEffects))
      && Number(b.maxExternalSideEffects) < Number(c.dispatch.maxParallelTasks)) {
    add(CONTEXT_SPLIT_CODES.budgetBelowDispatchParallel,
      `外部副作用额度 ${b.maxExternalSideEffects} < 声明的并发上限 ${c.dispatch.maxParallelTasks}`);
  }

  // ⑤ 策略版本未钉住：审计里出现「当时生效的策略未知」，事后无法归因
  const pv = (ctx && ctx.policy && ctx.policy.registryVersion) || '';
  if (!pv) add(CONTEXT_SPLIT_CODES.policyUnpinned, '策略快照缺少 registryVersion');

  // ⑥ 审计绑定字段不全：链式哈希绑不上上下文，真实性问题会被误当成完整性通过
  const a = (ctx && ctx.audit) || {};
  const missing = ['schemaVersion', 'policyVersion', 'prevDigest'].filter((k) => !a[k]);
  if (missing.length) add(CONTEXT_SPLIT_CODES.auditContextIncomplete, `审计绑定字段缺失：${missing.join('、')}`);

  // ⑦ 派生工具表 vs 旧路径工具表（迁移期交叉验证；两边不一致说明有人只改了一处）
  if (Array.isArray(legacyToolNames)) {
    const legacy = new Set(legacyToolNames.filter(Boolean));
    const diffAdded = [...names].filter((n) => !legacy.has(n));
    const diffRemoved = [...legacy].filter((n) => !names.has(n));
    if (diffAdded.length || diffRemoved.length) {
      add(CONTEXT_SPLIT_CODES.toolTableDrift,
        `上下文派生工具表与旧路径不一致：多 ${diffAdded.join(',') || '无'}／少 ${diffRemoved.join(',') || '无'}`);
    }
  }

  return {
    consistent: splits.length === 0,
    version: EXECUTION_CONTEXT_VERSION,
    splits,
    checks: ['claim-vs-effective', 'capability-tool', 'constraint-capability', 'reasoning-dispatch', 'budget-parallelism', 'policy-pinned', 'audit-binding', 'tool-table-drift'],
    checkedTools: names.size,
  };
}

/** 审计事件绑定的上下文字段（恰好是 P2 要求的八项）。 */
export function contextAuditFields(ctx, { eventType = '', eventIndex = 0, normalizedPayload = '' } = {}) {
  return {
    schemaVersion: nz(ctx && ctx.audit && ctx.audit.schemaVersion),
    sessionId: nz(ctx && ctx.identity && ctx.identity.sessionId),
    turnId: nz(ctx && ctx.identity && ctx.identity.turnId),
    eventIndex: Number(eventIndex) || 0,
    prevDigest: nz(ctx && ctx.audit && ctx.audit.prevDigest),
    eventType,
    normalizedPayload: typeof normalizedPayload === 'string' ? normalizedPayload : JSON.stringify(normalizedPayload || {}),
    policyVersion: nz(ctx && ctx.audit && ctx.audit.policyVersion),
  };
}

/** 一行摘要（写进状态行 / 执行记录）：能力 + 约束 + 档位 + 风险上限。 */
export function describeExecutionContext(ctx) {
  if (!ctx) return '（无执行上下文）';
  const b = ctx.capability.bits;
  const c = ctx.capability.constraints;
  const scope = [];
  if (c) {
    if (c.sandbox && c.sandbox.enabled) scope.push(`沙箱网络${c.sandbox.network ? '允许' : '禁止'}·≤${Math.round(c.sandbox.maxRuntimeMs / 1000)}s`);
    if (c.dispatch && c.dispatch.enabled) scope.push(`并发≤${c.dispatch.maxParallelTasks}`);
    if (c.filesystem && (c.filesystem.protectedPaths || []).length) scope.push(`保护路径 ${c.filesystem.protectedPaths.length}`);
  }
  return `${ctx.capability.capCode} · 档位=${ctx.intent.reasoningState} · 风险上限=${ctx.risk.ceiling}`
    + ` · 意图=${ctx.intent.taskClass}${scope.length ? ` · 约束[${scope.join(' | ')}]` : ''}`
    + ` · 策略=${ctx.policy.registryVersion || '未钉住'}`
    + (b.web ? '' : ' · Web 不可用');
}

/** 两份上下文之间的差异（同轮内用户中途改设置、实验换臂时必须能说清「变了什么」）。 */
export function diffExecutionContexts(a, b) {
  const changes = [];
  const walk = (x, y, path) => {
    const keys = new Set([...Object.keys(x || {}), ...Object.keys(y || {})]);
    for (const k of keys) {
      const xv = x ? x[k] : undefined;
      const yv = y ? y[k] : undefined;
      const p = path ? `${path}.${k}` : k;
      if (xv && yv && typeof xv === 'object' && typeof yv === 'object' && !Array.isArray(xv) && !Array.isArray(yv)) { walk(xv, yv, p); continue; }
      if (JSON.stringify(xv) !== JSON.stringify(yv)) changes.push({ path: p, from: xv, to: yv });
    }
  };
  walk(a, b, '');
  return { changed: changes.length > 0, count: changes.length, changes };
}

/** 面板/报告用的上下文分区打印（缺分区如实显示「未记录」，不假装有值）。 */
export function formatContextPanel(ctx) {
  if (!ctx) return '【执行上下文】未记录';
  const lines = [`【执行上下文】${ctx.version} · ${describeExecutionContext(ctx)}`];
  const sec = (name, text) => lines.push(`  · ${name}：${text || '未记录'}`);
  sec('身份', `${ctx.identity.traceId}${ctx.identity.mode ? ` · 模式=${ctx.identity.mode}` : ''}`);
  sec('意图', `${ctx.intent.taskClass} · ${ctx.intent.digest || '(无摘要)'} · 附件 ${ctx.intent.attachments}`);
  sec('能力', `${ctx.capability.capCode}（Web=${ctx.capability.bits.web ? 'on' : 'off'} / Sandbox=${ctx.capability.bits.sandbox ? 'on' : 'off'} / 委派=${ctx.capability.bits.dispatch ? 'on' : 'off'}）`);
  sec('预算', Object.entries(ctx.budget).map(([k, v]) => `${k}=${v}`).join(' ') || '未记录');
  sec('风险', `上限 ${ctx.risk.ceiling}${ctx.risk.requiresConfirmation ? ' · 本轮含需确认操作' : ''}${ctx.risk.hasExternalSideEffect ? ' · 含外部副作用' : ''}`);
  sec('记忆', `召回 ${ctx.memory.recalledIds.length} 条${ctx.memory.candidateWrite ? ' · 有候选写入' : ''}`);
  sec('策略', `${ctx.policy.registryVersion || '未钉住'}（${Object.keys(ctx.policy.versions).length} 项）`);
  sec('实验', ctx.experiment.experimentId ? `${ctx.experiment.experimentId} / ${ctx.experiment.variantId}${ctx.experiment.inExperiment ? '（在组内）' : '（对照组）'}` : '未参与');
  sec('审计', ctx.audit.schemaVersion ? `${ctx.audit.schemaVersion} · 策略 ${ctx.audit.policyVersion}` : '未绑定');
  sec('恢复', ctx.recovery.checkpointId ? `${ctx.recovery.checkpointId}${ctx.recovery.resumable ? ' · 可续跑' : ' · 不可续跑'}` : '本轮无检查点');
  return lines.join('\n');
}

// ─── P6 修正：工具选择熵过高 ─────────────────────────────────────────────
// 以前 deriveToolWhitelist 只按能力位「摘除」，剩下的全量下发（39 份 schema 每轮都进请求体），
// 模型要在 39 个名字里挑，本地工作台与 execute_javascript 又互相重叠。
// 这里再加一层**按需挂载**：核心工具每轮必带；其余按用户消息、附件类型、近几轮用量、点名挂载。
// 纯函数：同样的输入永远给出同样的表（顺序保持 allowed 原序），可被测试与 p2-eval 直接复算。
export const CORE_TOOLS = CORE_TOOL_NAMES;

// 按需挂载规则：命中任一 text 正则 / 附件类型即挂载。规则刻意保守——宁可多挂一个，也不要让该用的工具缺席
// （缺席时模型仍可点名调用，内核会当场挂载，见 agent/toolrunner 的「本轮未启用」回执）。
// 规则正文与核心表已迁入能力登记处（Helix 3.0）：capabilities.js / capabilities-mount.js。这里只做再导出，保持既有 import 路径不变。
export const TOOL_MOUNT_RULES = REG_TOOL_MOUNT_RULES;

const ATTACHMENT_KIND_RE = Object.freeze({
  pdf: /\.pdf$/i, video: /\.(?:mp4|webm|mov|m4v)$/i, zip: /\.zip$/i, csv: /\.(?:csv|tsv)$/i,
});
/** 附件 → 挂载规则认识的类型（pdf / video / zip / csv / image / text / other），只看名字、kind、source、dataUrl 前缀。 */
export function attachmentKindOf(a) {
  if (!a || typeof a !== 'object') return 'other';
  const name = String(a.name || '');
  for (const [kind, re] of Object.entries(ATTACHMENT_KIND_RE)) if (re.test(name)) return kind;
  if (a.source === 'video' || /^data:video\//.test(String(a.dataUrl || ''))) return 'video';
  if (/^data:application\/pdf/.test(String(a.dataUrl || ''))) return 'pdf';
  if (a.kind === 'image' || /^data:image\//.test(String(a.dataUrl || ''))) return 'image';
  if (a.kind === 'text') return 'text';
  return 'other';
}

/**
 * 两层下发：核心工具必带，其余按需。
 * @param {object} p
 * @param {Array} p.allowed             能力裁剪后的工具表（deriveToolWhitelist().allowed），本函数只会从中挑选
 * @param {string} p.text               本轮用户消息
 * @param {Array} p.attachments         本轮附件
 * @param {string[]} p.recentTools      近几轮实际调用过的工具名（粘性挂载，避免多轮任务中途掉工具）
 * @param {string[]} p.forceMount       强制挂载（例如本轮中模型点名了未挂载工具、内核已临时挂载）
 * @returns {{ mounted: Array, deferred: Array<{name, reason}>, reasons: Object<string,string>, core: string[] }}
 */
export function selectToolsForTurn({ allowed = [], text = '', attachments = [], recentTools = [], forceMount = [] } = {}) {
  const list = Array.isArray(allowed) ? allowed : [];
  const msg = String(text || '');
  const attKinds = new Set((Array.isArray(attachments) ? attachments : []).map(attachmentKindOf));
  const recent = new Set((Array.isArray(recentTools) ? recentTools : []).map(String));
  const forced = new Set((Array.isArray(forceMount) ? forceMount : []).map(String));
  const mounted = [];
  const deferred = [];
  const reasons = {};
  for (const tool of list) {
    const name = toolName(tool);
    if (!name) continue;
    let why = '';
    if (CORE_TOOLS.includes(name)) why = 'core';
    else if (forced.has(name)) why = 'forced';
    else if (msg.includes(name)) why = 'mentioned';
    else if (recent.has(name)) why = 'recent';
    else {
      const rule = TOOL_MOUNT_RULES[name];
      if (!rule) why = 'no-rule'; // 没写规则的工具按旧行为全量下发，不会因为漏写规则而悄悄消失
      else if (rule.attachments && rule.attachments.some((k) => attKinds.has(k))) why = `attachment:${rule.attachments.find((k) => attKinds.has(k))}`;
      else if (rule.text && rule.text.test(msg) && !(rule.exclude && rule.exclude.test(msg))) why = 'keyword';
    }
    if (why) { mounted.push(tool); reasons[name] = why; } else deferred.push({ name, reason: 'on-demand' });
  }
  return { mounted, deferred, reasons, core: CORE_TOOLS.filter((n) => list.some((t) => toolName(t) === n)) };
}

/** 【工具表】段里给模型看的一行：只列名字（≈5 token/个），schema 不下发；点名即挂载。 */
export function formatDeferredTools(deferred, { max = 24 } = {}) {
  const names = (Array.isArray(deferred) ? deferred : []).map((d) => (d && d.name) || d).filter(Boolean);
  if (!names.length) return '';
  const shown = names.slice(0, max).join('、');
  const more = names.length > max ? `…等 ${names.length} 个` : '';
  return `另有 ${names.length} 个工具本轮按需未挂载：${shown}${more}（确有需要时直接调用，内核会当场挂载并让你重试；小任务优先用已挂载工具或 execute_javascript）`;
}

/** 从会话消息里取近几轮实际调用过的工具名（粘性挂载的输入）。 */
export function recentToolNames(messages, { turns = 2 } = {}) {
  const out = [];
  let seenUser = 0;
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0 && seenUser <= turns; i--) {
    const m = list[i];
    if (!m) continue;
    if (m.role === 'user') { seenUser += 1; continue; }
    if (m.role === 'assistant' && Array.isArray(m.toolCalls)) {
      for (const c of m.toolCalls) if (c && c.name && !out.includes(c.name)) out.push(c.name);
    }
  }
  return out;
}
