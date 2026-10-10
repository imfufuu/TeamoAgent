import { appendToolStream } from './toolflow.js?v=2026.10.9.4';
// ─── 工具运行器（P4 拆分：从 agent.js 抽出「单个工具调用的执行与记账」）────────────────────
// 拥有：① 同一波工具调用的调度（只读并发 / 写串行 / 委派限流：batchToolCalls · planToolWaves · runWithCategoryLimits）；
//       ② 每次调用的完整生命周期——契约预检（validateToolCallPre）→ 风险分级与确认闸门 → 预算扣减 → 幂等账本回放
//          → 执行（executeTool）→ 结果核验（validateToolResultPost）→ 自动重试 → 检查点 → 版本化审计轨迹（beginToolRun/endToolRun）；
//       ③ 工具执行上下文（toolCtxFor：fs / 记忆 / 子智能体委派 / UI 事件回调）。
// 不拥有：模型请求循环、系统提示组装、回合收尾记账（agent.js runLoop / turnfinalizer.js）、工具本身的实现（tools.js）。
// 注入而非 import 的四样东西：store（状态）、emit（UI 钩子）、getFs（回合内 fs 指针会被换成临时层，所以是 getter）、
// runSubagent（住在 agent.js，避免循环依赖）。P1（预算）/ P2（持久）类修正都会碰这段代码——先抽出来再改。
import { PARALLEL_TOOL_NAMES, NETWORK_TOOL_NAMES } from './capabilities.js';
import { executeTool } from './tools.js';
import { findSubagent } from './subagents.js';
import {
  EXECUTION_STATES, CONFIRMATION_DECISIONS,
  validateToolCallPre, validateToolResultPost, classifyToolRisk, summarizeArgs, fsDigest,
  guardRequiresConfirmation, formatConfirmationRequest, formatConfirmationDecision,
  formatBudgetLedger, formatBudgetRecovery,
} from './execution.js?v=2026.10.9.4';
import { buildCheckpoint, diffFileState, digestArtifact } from './recovery.js?v=2026.10.9.4';
import { operationKey, planReplay, digestResultText } from './idempotency.js?v=2026.10.9.4';
import { toolName } from './executionContext.js?v=2026.10.9.4';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 一次委派最多并发几个子智能体（再高就是自己跟自己抢网关并发额度了）
const DISPATCH_CONCURRENCY = 3;
// 只读 / 无共享可变状态的工具可以并发（Hermes ThreadPoolExecutor 的浏览器等价物）。
// 写沙箱、跑代码、生图、git 仍串行，避免交错后说不清基于哪一版文件。
export const PARALLEL_TOOLS = new Set(PARALLEL_TOOL_NAMES); // Helix 3.0：由能力登记处派生（capabilities.js parallel 位 + 旧别名）
const hasBadArgs = (call) => !!(call && call.args && typeof call.args === 'object' && '__raw' in call.args);

export function batchToolCalls(calls) {
  const batches = [];
  let i = 0;
  const list = calls || [];
  while (i < list.length) {
    if (list[i].name === 'dispatch_subagent' && !hasBadArgs(list[i])) {
      let j = i;
      while (j < list.length && list[j].name === 'dispatch_subagent' && !hasBadArgs(list[j])) j++;
      batches.push({ kind: 'dispatch', start: i, end: j });
      i = j;
      continue;
    }
    if (PARALLEL_TOOLS.has(list[i].name) && !hasBadArgs(list[i])) {
      let j = i;
      while (j < list.length && PARALLEL_TOOLS.has(list[j].name) && !hasBadArgs(list[j])) j++;
      batches.push({ kind: 'parallel', start: i, end: j });
      i = j;
      continue;
    }
    batches.push({ kind: 'serial', start: i, end: i + 1 });
    i++;
  }
  return batches;
}


// ─── 依赖图调度（V1.7.1）────────────────────────────────────────────────
// batchToolCalls 只合并「相邻」的只读调用：[read a, write b, read c] 会退化成 3 批串行。
// planToolWaves 为每次调用推导路径级读写集，仅在真有数据依赖（写-读 / 读-写 / 写-写，
// 含目录前缀覆盖）时才排到后一波；无依赖的写入（不同路径）也可以同波并行。
// 看不清读写集的工具（沙箱执行 / 生图 / zip / git / 记忆 / 参数坏掉的调用）视为全局屏障。
const ACCESS_ANY = '*';
const strList = (v) => (typeof v === 'string' && v.trim() ? [v.trim().replace(/^\.\//, '')] : []);
const pathList = (v) => (Array.isArray(v) ? v.flatMap(strList) : strList(v));
export function toolAccessSet(call) {
  const name = call && call.name;
  const a = call && call.args && typeof call.args === 'object' ? call.args : {};
  if (hasBadArgs(call)) return { reads: [ACCESS_ANY], writes: [ACCESS_ANY] };
  const outOrAny = (fallbackWrites) => (strList(a.out).length ? strList(a.out) : fallbackWrites);
  switch (name) {
    case 'dispatch_subagent': return { reads: [ACCESS_ANY], writes: [ACCESS_ANY], dispatch: true };
    case 'read_file': return { reads: strList(a.path).length ? strList(a.path) : [ACCESS_ANY], writes: [] };
    case 'list_files': case 'search_files': return { reads: [ACCESS_ANY], writes: [] };
    case 'write_file': case 'delete_file': return { reads: [], writes: strList(a.path).length ? strList(a.path) : [ACCESS_ANY] };
    case 'copy_file': {
      const from = strList(a.from); const to = strList(a.to);
      if (!from.length || !to.length) return { reads: [ACCESS_ANY], writes: [ACCESS_ANY] };
      return { reads: from, writes: a.move ? [...to, ...from] : to };
    }
    case 'hash': case 'codec': case 'unicode': case 'json_tool':
      return { reads: strList(a.path), writes: [] };
    case 'csv_tool': case 'text_tool':
      return { reads: strList(a.path), writes: strList(a.out) };
    case 'data_tool': // P6 伞工具：kind=qr 不传 out 时写 outputs/qr-NNN.svg（路径未知 → ANY）
      return { reads: strList(a.path), writes: a.kind === 'qr' ? outOrAny([ACCESS_ANY]) : strList(a.out) };
    case 'render_mermaid': case 'render_dot':
      return { reads: strList(a.path), writes: outOrAny([ACCESS_ANY]) };
    case 'diff_text': return { reads: [...strList(a.left_path), ...strList(a.right_path)], writes: [] };
    case 'analyze_image': return { reads: [...strList(a.path), ...pathList(a.paths)], writes: [] };
    case 'analyze_pdf': return { reads: a.path ? strList(a.path) : [ACCESS_ANY], writes: [] };
    case 'analyze_video': return { reads: a.path ? strList(a.path) : [ACCESS_ANY], writes: [] };
    case 'fetch_url': return { reads: [], writes: strList(a.save_path) };
    case 'browser_sandbox': return { reads: [ACCESS_ANY], writes: [ACCESS_ANY] };
    case 'download_file': return { reads: [], writes: a.path ? strList(a.path) : [ACCESS_ANY] };
    default:
      if (PARALLEL_TOOLS.has(name)) return { reads: [], writes: [] };
      return { reads: [ACCESS_ANY], writes: [ACCESS_ANY] };
  }
}
const pathsOverlap = (x, y) => x === ACCESS_ANY || y === ACCESS_ANY || x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
const setsOverlap = (xs, ys) => xs.some((x) => ys.some((y) => pathsOverlap(x, y)));
export function toolCallsConflict(a, b) {
  if (a.dispatch && b.dispatch) return false; // 委派之间彼此独立，沿用 DISPATCH_CONCURRENCY 并发
  return setsOverlap(a.writes, b.reads) || setsOverlap(a.reads, b.writes) || setsOverlap(a.writes, b.writes);
}
// 同一波内按工具类别限流：一次放出十几个 fetch_url 会同时打满中继与目标站点（也更容易被限流），
// 网络类 ≤ 4 并发；其余本地工具 ≤ 8。限流只影响同波内的启动时机，不改变波次与结果下标。
export const NETWORK_TOOLS = new Set(NETWORK_TOOL_NAMES); // Helix 3.0：由能力登记处派生（kind=network）
export const PARALLEL_LIMITS = Object.freeze({ network: 4, default: 8 });
export const toolCategoryOf = (name) => (NETWORK_TOOLS.has(name) ? 'network' : 'default');
export function plannedConcurrency(names, limits = PARALLEL_LIMITS) {
  const counts = {};
  for (const n of names) { const c = toolCategoryOf(n); counts[c] = (counts[c] || 0) + 1; }
  return Object.entries(counts).reduce((sum, [c, k]) => sum + Math.min(k, limits[c] || limits.default), 0);
}
export async function runWithCategoryLimits(items, run, limits = PARALLEL_LIMITS) {
  // items: [{ index, name }]；run(index) → Promise<result>。按原序启动，每类别一个信号量；
  // 任一任务失败不影响其它任务（run 自身负责把异常转成结果字符串）。
  const active = {};
  const waiters = {};
  const acquire = (cat) => new Promise((resolve) => {
    const cap = limits[cat] || limits.default;
    const tryGo = () => {
      if ((active[cat] || 0) < cap) { active[cat] = (active[cat] || 0) + 1; resolve(); return true; }
      return false;
    };
    if (!tryGo()) (waiters[cat] = waiters[cat] || []).push(tryGo);
  });
  const release = (cat) => {
    active[cat] = Math.max(0, (active[cat] || 0) - 1);
    const q = waiters[cat] || [];
    while (q.length && q[0]()) q.shift();
  };
  const results = new Array(items.length);
  await Promise.all(items.map(async (it, i) => {
    const cat = toolCategoryOf(it.name);
    await acquire(cat);
    try { results[i] = await run(it.index); } finally { release(cat); }
  }));
  return results;
}

// 返回 [{ kind: 'serial' | 'parallel' | 'dispatch', indices: number[] }, …]，indices 为原始下标（保持原序）。
export function planToolWaves(calls) {
  const list = calls || [];
  const access = list.map(toolAccessSet);
  const wave = new Array(list.length).fill(0);
  for (let i = 0; i < list.length; i++) {
    let w = 0;
    for (let j = 0; j < i; j++) if (toolCallsConflict(access[j], access[i])) w = Math.max(w, wave[j] + 1);
    // 委派只能与委派同波：若本波已有非委派调用（或反之），顺延一波
    for (let j = 0; j < i; j++) if (wave[j] === w && !!access[j].dispatch !== !!access[i].dispatch) { w += 1; j = -1; }
    wave[i] = w;
  }
  const waves = [];
  const count = list.length ? Math.max(...wave) + 1 : 0;
  for (let w = 0; w < count; w++) {
    const indices = [];
    for (let i = 0; i < list.length; i++) if (wave[i] === w) indices.push(i);
    if (!indices.length) continue;
    const kind = access[indices[0]].dispatch ? 'dispatch' : (indices.length === 1 ? 'serial' : 'parallel');
    waves.push({ kind, indices });
  }
  return waves;
}

/**
 * 创建工具运行器。返回 { runToolCalls, toolCtxFor }；runToolCalls(calls, turn, exec) 的签名与 agent.js 旧内联版本完全一致。
 * @param {object} deps { store, emit, getFs, runSubagent }
 */
export function createToolRunner({ store, emit, getFs, runSubagent } = {}) {
  function toolCtxFor(call, turn) {
    const fs = getFs();
    return {
      fs,
      memory: store.state.memory,
      memoryArchive: store.state.memoryArchive,
      setMemory: (next) => {
        store.state.memory = Array.isArray(next) ? next : [];
        if (typeof store.notify === 'function') store.notify();
        else if (typeof store.save === 'function') store.save(true);
      },
      apiKey: turn.apiKey,
      imageModel: turn.imageModel,
      visionModel: turn.visionModel,
      videoModel: turn.videoModel,
      sandboxEnabled: turn.sandboxEnabled,
      remoteCpp: turn.remoteCpp !== false,
      allowDispatch: !!turn.canDispatch,
      webEnabled: !!turn.webEnabled, // .35：沙箱内受控 fetch 是否放行（与网页工具同一开关）
      signal: turn.signal,
      onUi: (patch) => {
        if (turn.signal?.aborted) return;
        if (patch?.stream) { appendToolStream(call, patch); patch = { ...patch, liveOutput: call.liveOutput }; }
        if (['running', 'ok', 'error'].includes(patch?.status)) call.status = patch.status;
        if (patch && patch.billing) call.billing = patch.billing;
        emit('onToolEvent', call, patch);
      },
      dispatch: async (agentId, subTask, onNote) => {
        const def = findSubagent(agentId);
        if (!def) return `未知子智能体：${agentId}。请用 enum 中列出的 ID。`;
        onNote && onNote(`子智能体「${def.name}」思考中…`);
        const report = await runSubagent(def, subTask, {
          apiKey: turn.apiKey,
          model: turn.model,
          thinking: turn.thinking,
          reasoningLevel: turn.reasoningLevel,
          sandboxEnabled: turn.sandboxEnabled,
          remoteCpp: turn.remoteCpp !== false,
          webEnabled: turn.webEnabled,
          imageModel: turn.imageModel,
          visionModel: turn.visionModel,
          videoModel: turn.videoModel,
          memory: store.state.memory,
          onThinkingFallback: (m) => emit('onThinkingFallback', m),
          onWebFallback: (m, why) => emit('onWebFallback', m, why),
          onSubagentUsage: (b) => {
            if (!b || !b.usage) return;
            const billing = { kind: 'subagent', model: b.model || turn.model, fastMode: !!turn.fastMode, usage: b.usage };
            call.billing = billing;
            emit('onToolEvent', call, { billing });
          },
          fs,
          signal: turn.signal,
        });
        if (turn && Array.isArray(turn.subagentReports)) {
          turn.subagentReports.push({ agent: def.id, name: def.name, task: subTask, report });
        }
        return `[子智能体报告 · ${def.name}（${def.tag}）]\n${report}`;
      },
    };
  }

  // 从工具参数里取「目标文件路径」，用于幂等账本比对产物是否已满足（不依赖 tools.js 导出，保持跨模块解耦）
  function extractFilePath(args) {
    const a = args && typeof args === 'object' ? args : {};
    for (const k of ['path', 'out', 'db']) if (typeof a[k] === 'string' && a[k].trim()) return a[k].trim();
    return '';
  }

  // 同一轮里：dispatch_subagent 并发；只读工具并发；写/执行串行。
  // 结果仍按调用原顺序写回对话，两种协议的 tool_use/tool_result 配对都不受影响。
  //
  // P0 执行内核接线点：每次调用都走「调用前契约校验 → 预算扣减 → 执行 → 调用后核验」，
  // 并把调用前状态 / 调用后状态 / 理由 / 风险等级 / 幂等键 / 副作用摘要写进版本化审计轨迹。
  async function runToolCalls(calls, turn, exec) {
    const fs = getFs();
    const out = new Array(calls.length);
    const waveRuns = [];
    const toolDefByName = new Map(exec.toolList.map((t) => [t.name, t]));
    if (exec.machine.canTransition(EXECUTION_STATES.TOOL_PENDING)) {
      exec.machine.transition(EXECUTION_STATES.TOOL_PENDING, `模型请求 ${calls.length} 次工具调用`, { tools: calls.map((c) => c.name) });
    }
    exec.machine.transition(EXECUTION_STATES.TOOL_RUNNING, `开始执行 ${calls.length} 次调用（依赖图调度 ${planToolWaves(calls).length} 波：${planToolWaves(calls).map((b) => `${b.kind}×${b.indices.length}`).join('+')}）`);

    const recordBlocked = (call, { reason, failure, risk, idempotencyKey, notes = [] }) => {
      // 调用前被拦截也算失败：写回 call，界面重建芯片后仍显示 ✗（而不是按结果文本猜）
      call.status = 'error';
      call.errorNote = String(reason || (failure && failure.label) || '调用前被拦截').slice(0, 200);
      if (call.durationMs == null) call.durationMs = 1;
      const run = exec.machine.beginToolRun({ callId: call.id, name: call.name, args: call.args, reason, risk, idempotencyKey });
      const closed = exec.machine.endToolRun(run, { status: 'blocked', failure, notes });
      waveRuns.push(closed);
      if (idempotencyKey) exec.seenIdempotency.set(idempotencyKey, { status: 'blocked', index: closed.index });
      return closed;
    };

    const runOne = async (call) => {
      if (turn.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      emit('onToolStart', call);
      let toolDef = toolDefByName.get(call.name) || null;

      // ①a P6 按需挂载：模型调用了能力上允许、但本轮没下发 schema 的工具 → 明确回执（不是静默失败），
      //    同时把它挂进本轮工具表（后续迭代请求体里就有它），模型可以直接重试或改用 execute_javascript。
      if (!toolDef && exec.deferredTools instanceof Map && exec.deferredTools.has(call.name)) {
        const def = exec.deferredTools.get(call.name);
        exec.deferredTools.delete(call.name);
        if (def && !exec.toolList.some((t) => t && t.name === call.name)) exec.toolList.push(def);
        if (def) toolDefByName.set(call.name, def);
        exec.machine.audit.record('tool-lazy-mount', { name: call.name, mountedCount: exec.toolList.length });
        emit('onToolEvent', call, { status: 'error', note: '本轮未启用（已临时挂载，可重试）' });
        recordBlocked(call, {
          reason: `工具 ${call.name} 本轮未启用（按需挂载表之外）`,
          failure: {
            kind: 'ENVIRONMENT', label: '工具未挂载', handling: '内核已临时挂载：可直接重试一次，或改用 execute_javascript',
            retryable: true, maxRetries: 1, verifyFirst: false,
            guidance: `再次调用 ${call.name}（内核已挂载），或用 execute_javascript 完成同样的事。`,
          },
          risk: { level: 'L0', levelLabel: '未执行', reasons: ['工具本轮未启用'], hasExternalSideEffect: false, irreversible: false, requiresConfirmation: false },
        });
        return `该工具本轮未启用，可用 execute_javascript 完成；内核已临时挂载 ${call.name}，如确需也可直接重试一次。`;
      }

      // ① 参数 JSON 都没解析出来 → 回喂纠错，绝不产生副作用（不进契约层）
      if (hasBadArgs(call)) {
        emit('onToolEvent', call, { status: 'error', note: '参数解析失败' });
        recordBlocked(call, {
          reason: '模型给出的工具参数不是合法 JSON',
          failure: { kind: 'INVALID_ARGS', label: '参数错误', handling: '修正参数后最多重试一次', retryable: false, maxRetries: 0, verifyFirst: false, guidance: '把参数改成合法 JSON 后重新调用。' },
          risk: { level: 'L0', levelLabel: '参数未解析', reasons: ['参数不是合法 JSON'], hasExternalSideEffect: false, irreversible: false, requiresConfirmation: false },
        });
        return `工具参数不是合法 JSON，原始内容：${String(call.args.__raw).slice(0, 500)}。请修正参数后重新调用。`;
      }

      // ② 调用前契约校验：Schema / 能力掩码 / 能力约束 / 预算 / 幂等键（同一份判决同时进审计）
      const pre = validateToolCallPre({
        name: call.name,
        args: call.args,
        toolDef,
        tools: exec.toolList,
        capabilities: exec.capabilities,
        budget: exec.budgetGov,
        seenIdempotency: exec.seenIdempotency,
        turnBudget: { turnId: exec.execCtx.turnId },
      });
      const risk = classifyToolRisk({ name: call.name, args: call.args, contract: pre.contract, fs, userText: exec.execCtx.userIntent });
      exec.machine.audit.record('tool-preflight', {
        name: call.name, decision: pre.decision, errors: pre.errors.map((e) => e.id),
        riskLevel: risk.level, riskReasons: risk.reasons, requiresConfirmation: risk.requiresConfirmation,
        idempotencyKey: pre.idempotencyKey, budgetRemaining: exec.budgetGov.remaining('toolCalls'),
      });

      if (!pre.ok) {
        emit('onToolEvent', call, { status: 'error', note: pre.errors.map((e) => e.detail).join('；') });
        const budgetBlocked = pre.errors.some((e) => e.id === 'budget-tool-calls-exhausted' || e.id === 'budget-tokens-exhausted');
        recordBlocked(call, {
          reason: `调用前校验未通过：${pre.errors.map((e) => e.id).join(', ')}`,
          failure: {
            kind: budgetBlocked ? 'ENVIRONMENT' : 'PERMISSION',
            label: budgetBlocked ? '预算耗尽' : '契约/能力拦截',
            handling: '不重试：按裁决原因改道或如实披露',
            retryable: false, maxRetries: 0, verifyFirst: false,
            guidance: pre.errors.map((e) => e.recovery).filter(Boolean).join('；') || '换用其它可用工具或调整参数。',
            idempotencyKey: pre.idempotencyKey,
          },
          risk, idempotencyKey: pre.idempotencyKey, notes: pre.errors.map((e) => e.id),
        });
        return budgetBlocked
          ? `${pre.message}\n${formatBudgetLedger(exec.budgetGov)}\n${formatBudgetRecovery(pre.errors.some((e) => e.id === 'budget-tokens-exhausted') ? 'tokens' : 'toolCalls', exec.budgetGov)}`
          : pre.message;
      }

      // ②b 幂等回放裁决（P1）：同一个逻辑操作不重复执行——满足则复用，不确定则先核验，外部副作用重复则拦截
      const opKey = operationKey({ toolName: call.name, args: call.args });
      const ledgerEntry = exec.ledger.lookup(opKey);
      if (ledgerEntry) {
        const targetPath = (pre.contract && pre.contract.sideEffect === 'filesystem') ? (extractFilePath(call.args) || '') : '';
        const filesNow = fs.export();
        const currentArtifactDigest = targetPath && Object.prototype.hasOwnProperty.call(filesNow, targetPath)
          ? digestArtifact(filesNow[targetPath]).digest : null;
        const replay = planReplay({
          entry: ledgerEntry, contract: pre.contract,
          userText: exec.execCtx.userIntent, currentArtifactDigest,
          currentTurnId: exec.execCtx.turnId,
        });
        exec.machine.audit.record('idempotency-replay', {
          name: call.name, key: pre.idempotencyKey, entryStatus: ledgerEntry.status, decision: replay.decision, reason: replay.reason,
        });
        if (replay.decision === 'reuse' && ledgerEntry.status === 'in-flight' && exec.inflight.has(opKey)) {
          const shared = await exec.inflight.get(opKey);
          const run0 = exec.machine.beginToolRun({ callId: call.id, name: call.name, args: call.args, reason: `并发同键调用：复用同一次执行（${replay.reason}）`, risk, idempotencyKey: pre.idempotencyKey });
          run0.opKey = opKey;
          const closed0 = exec.machine.endToolRun(run0, { status: 'succeeded', notes: ['duplicate-in-flight'] });
          waveRuns.push(closed0);
          return `${shared}\n\n[执行内核] 本次调用与同轮的另一处调用幂等键相同（${pre.idempotencyKey}），已复用同一次执行结果，未重复落副作用。`;
        }
        if (replay.decision === 'reuse') {
          const run1 = exec.machine.beginToolRun({ callId: call.id, name: call.name, args: call.args, reason: `幂等复用：${replay.reason}`, risk, idempotencyKey: pre.idempotencyKey });
          exec.machine.endToolRun(run1, { status: 'succeeded', notes: ['idempotent-reuse'] });
          waveRuns.push(run1);
          return `[执行内核 · 幂等复用] ${replay.reason}。${replay.guidance || ''}${ledgerEntry.resultDigest ? `（上次结果摘要 ${ledgerEntry.resultDigest}）` : ''}`;
        }
        if (replay.decision === 'verify-first' || replay.decision === 'block') {
          const isVerify = replay.decision === 'verify-first';
          emit('onToolEvent', call, { status: 'error', note: replay.reason });
          recordBlocked(call, {
            reason: replay.reason,
            failure: {
              kind: isVerify ? 'SIDE_EFFECT_UNCERTAIN' : 'PERMISSION',
              label: isVerify ? '副作用不确定' : '重复副作用拦截',
              handling: isVerify ? '禁止盲目重试：先核验目标状态' : '不重复执行：避免重复扣费 / 重复提交',
              retryable: false, maxRetries: 0, verifyFirst: isVerify,
              guidance: replay.guidance || '',
            },
            risk, idempotencyKey: pre.idempotencyKey, notes: [`idem-${replay.decision}`],
          });
          return `⛔ 执行内核（幂等账本）拦截：${replay.reason}。\n${replay.guidance || ''}`;
        }
      }

      // ②c 授权复核（P2）：每次调用都重新读一遍用户决定。
      // 之前「允许本会话」只活在内存闸门里，用户在第二步撤销授权不会被任何人读到——
      // 撤权和授权必须一样即时生效，否则「可停止」只是纸面属性。
      const approvals = (store.state.settings.toolApprovals || {});
      const approval = approvals[call.name];
      if (approval === 'deny') {
        exec.machine.audit.record('approval-denied', { name: call.name, source: 'settings.toolApprovals' });
        recordBlocked(call, {
          reason: '用户已撤销对该工具的授权',
          failure: { kind: 'PERMISSION', label: '授权已撤销', handling: '不执行：授权被用户撤销后立即生效', retryable: false, maxRetries: 0, verifyFirst: false, guidance: '不要重试；如需继续，请向用户说明目的并请其重新授权。' },
          risk, idempotencyKey: pre.idempotencyKey, notes: ['approval-revoked'],
        });
        return `⛔ ${call.name} 的授权已被用户撤销，本次未执行。请说明目的并请用户重新授权后再试。`;
      }

      // ③ 交互确认（P1/P2）：L2/L3 按生效档位停下来等用户决定；无人应答或超时一律按拒绝（fail-closed）
      // 生效档位可能来自策略实验变体（未开灰度时等于用户设置，行为不变）
      const guardMode = exec.effectiveGuard || 'observe';
      const sessionAllowedBySettings = approval === 'allow-session';
      if (guardRequiresConfirmation({ guard: guardMode, risk }) && !sessionAllowedBySettings && !exec.confirmGate.isSessionAllowed(call.name)) {
        const request = formatConfirmationRequest({
          name: call.name, args: call.args,
          reason: risk.reasons[0] || '', impact: undefined,
          reversibility: risk.irreversible ? '不可自动恢复' : undefined,
        });
        const confirmKey = `cf-${exec.execCtx.turnId}-${call.id || call.name}`;
        exec.machine.audit.record('confirmation-requested', { name: call.name, key: confirmKey, riskLevel: risk.level, guardMode, reasons: risk.reasons });
        emit('onConfirmationRequest', call, request, confirmKey);
        const decisionRec = await exec.confirmGate.wait({ key: confirmKey, tool: call.name, requestText: request });
        exec.machine.audit.record('confirmation-decision', {
          name: call.name, key: confirmKey, decision: decisionRec.decision,
          reason: decisionRec.reason || '', waitedMs: decisionRec.waitedMs,
        });
        emit('onConfirmationResolved', call, decisionRec);
        if (decisionRec.decision !== CONFIRMATION_DECISIONS.ALLOW_ONCE && decisionRec.decision !== CONFIRMATION_DECISIONS.ALLOW_SESSION) {
          recordBlocked(call, {
            reason: `用户未放行（${decisionRec.decision}）`,
            failure: { kind: 'PERMISSION', label: '未获确认', handling: '不执行：用户未允许该高风险操作', retryable: false, maxRetries: 0, verifyFirst: false, guidance: '不要重试该调用；如确实需要，请说明影响并请用户明确同意。' },
            risk, idempotencyKey: pre.idempotencyKey, notes: [`confirm-${decisionRec.decision}`],
          });
          return `⏸ ${formatConfirmationDecision(decisionRec)}：${call.name} 未执行。请不要重复请求同一操作（除非用户明确要求）。`;
        }
        risk.confirmed = true;
        risk.confirmationDecision = decisionRec.decision;
        if (decisionRec.decision === 'allow-session') {
          // 「本会话允许该工具」写进设置层：既能跨轮生效，也能被用户显式撤销（settings.toolApprovals）
          store.state.settings.toolApprovals = { ...(store.state.settings.toolApprovals || {}), [call.name]: 'allow-session' };
        }
        emit('onToolEvent', call, { status: 'running', note: `用户已放行（${decisionRec.decision}）` });
      }

      // ④ 预算扣减：工具调用 /（如有）外部副作用 —— 扣减失败即拒绝，不再执行
      const spendTool = exec.budgetGov.spend('toolCalls', 1, { tool: call.name });
      if (!spendTool.ok) {
        recordBlocked(call, {
          reason: '工具调用预算耗尽',
          failure: { kind: 'ENVIRONMENT', label: '预算耗尽', handling: '不重试：本轮预算已用尽', retryable: false, maxRetries: 0, verifyFirst: false, guidance: '给出阶段性结论并披露未完成部分。' },
          risk, idempotencyKey: pre.idempotencyKey, notes: ['budget-tool-calls-exhausted'],
        });
        return `⛔ 执行内核：${spendTool.reason}。请立即收敛结论并如实披露未完成的部分。\n${formatBudgetLedger(exec.budgetGov)}\n${formatBudgetRecovery('toolCalls', exec.budgetGov)}`;
      }
      exec.machine.audit.record('budget-spend', {
        channel: 'toolCalls', amount: 1, spent: spendTool.spent,
        limit: exec.budgetGov.budget.maxToolCalls, tool: call.name,
      });
      if (risk.hasExternalSideEffect) {
        const spendExt = exec.budgetGov.spend('externalSideEffects', 1, { tool: call.name });
        if (!spendExt.ok) {
          // P2 修正：外部副作用预算耗尽之前只是「不记账、照发」——等于预算声明挂空。
          // 跨边界调用一旦发出就无法收回，必须在扣减失败时当场拒绝，而不是事后才发现超支。
          recordBlocked(call, {
            reason: '外部副作用预算耗尽',
            failure: { kind: 'ENVIRONMENT', label: '预算耗尽', handling: '不重试：本轮外部副作用额度已用尽', retryable: false, maxRetries: 0, verifyFirst: false, guidance: '不要改参数重试该调用；给出阶段性结论并说明还有哪些外部动作未执行。' },
            risk, idempotencyKey: pre.idempotencyKey, notes: ['budget-external-side-effects-exhausted'],
          });
          return `⛔ 执行内核：${spendExt.reason}。该调用跨越外部边界，发出即不可撤回，已在本轮额度用尽时拦下。\n${formatBudgetLedger(exec.budgetGov)}\n${formatBudgetRecovery('externalSideEffects', exec.budgetGov)}`;
        }
        exec.machine.audit.record('budget-spend', {
          channel: 'externalSideEffects', amount: 1, spent: spendExt.spent,
          limit: exec.budgetGov.budget.maxExternalSideEffects, tool: call.name,
        });
      }

      // ⑤ 执行 + 调用后核验（含契约允许的退避重试，绝不盲目重试）
      const run = exec.machine.beginToolRun({
        callId: call.id, name: call.name, args: call.args,
        reason: `契约允许（${pre.contract ? pre.contract.sideEffect : 'unknown'} 副作用 · 超时 ${pre.contract ? pre.contract.timeoutMs : '-'}ms）· 风险 ${risk.level}`,
        risk, idempotencyKey: pre.idempotencyKey,
      });
      const toolCtx = { ...toolCtxFor(call, turn), execution: exec.execCtx };
      // 幂等账本：执行前登记（in-flight），并发同键调用会命中上面的复用分支
      exec.ledger.claim(opKey, { tool: call.name, turnId: exec.execCtx.turnId, argsSummary: summarizeArgs(call.name, call.args) });
      // 快照必须在启动执行之前取（否则 await 之前的同步写入会让前后快照一致，diff 为空）
      let filesBefore = fs.export();
      let fsBefore = fsDigest(filesBefore);
      // P2 故障注入（默认不装配）：只在显式开启时给这一次调用挂上故障
      const injectedFault = exec.faultInjector ? exec.faultInjector.beforeToolCall({ name: call.name, args: call.args }) : null;
      let execError = null;
      const inflightPromise = (async () => {
        try {
          const raw = String(await executeTool(call.name, call.args, toolCtx));
          if (injectedFault && exec.faultInjector) {
            const mutated = exec.faultInjector.afterToolResult({ fault: injectedFault, result: raw, name: call.name });
            if (mutated.error) throw mutated.error;
            exec.faultNote = [exec.faultNote, mutated.note].filter(Boolean).join('\n');
            return mutated.result;
          }
          return raw;
        } catch (err) {
          execError = err;
          return `工具执行失败: ${err && err.message ? err.message : String(err)}`;
        }
      })();
      exec.inflight.set(opKey, inflightPromise);
      const t0 = Date.now();
      let result = '';
      try {
        result = await inflightPromise;
      } catch (err) {
        execError = err;
        result = `工具执行失败: ${err && err.message ? err.message : String(err)}`;
      } finally {
        exec.inflight.delete(opKey);
      }
      let filesAfter = fs.export();
      let fsAfter = fsDigest(filesAfter);
      let delta = diffFileState(filesBefore, filesAfter);
      let post = validateToolResultPost({
        name: call.name, args: call.args, contract: pre.contract, result, ok: !execError,
        durationMs: Date.now() - t0, fsBefore, fsAfter, error: execError,
        timedOut: /超时|timed out|timeout/i.test(String(result)),
      });
      let failure = post.failureKind;
      let retried = false;
      let retryNote = '';

      // 契约允许（幂等 + 可退避）的暂时性失败：内核有限退避重试一次；否则交给模型决策
      if (failure && failure.retryable && exec.budgetGov.canSpend('retries', 1).ok) {
        exec.machine.transition(EXECUTION_STATES.RETRY_PENDING, `${call.name} 判定为${failure.label}，按契约退避重试（幂等键 ${pre.idempotencyKey}）`);
        const spendRetry = exec.budgetGov.spend('retries', 1, { tool: call.name });
        if (spendRetry.ok) {
          exec.machine.audit.record('budget-spend', {
            channel: 'retries', amount: 1, spent: spendRetry.spent,
            limit: exec.budgetGov.budget.maxRetries, tool: call.name,
          });
        }
        emit('onToolEvent', call, { status: 'running', note: `第 1 次失败（${failure.label}），按契约自动重试 1 次` });
        await sleep(600);
        exec.machine.transition(EXECUTION_STATES.TOOL_RUNNING, `${call.name} 重试第 1 次`);
        const tR = Date.now();
        filesBefore = fs.export();
        fsBefore = fsDigest(filesBefore);
        try {
          result = await executeTool(call.name, call.args, toolCtx);
          execError = null;
        } catch (err) {
          execError = err;
          result = `工具执行失败: ${err && err.message ? err.message : String(err)}`;
        }
        filesAfter = fs.export();
        fsAfter = fsDigest(filesAfter);
        delta = diffFileState(filesBefore, filesAfter);
        post = validateToolResultPost({
          name: call.name, args: call.args, contract: pre.contract, result, ok: !execError,
          durationMs: Date.now() - tR, fsBefore, fsAfter, error: execError,
          timedOut: /超时|timed out|timeout/i.test(String(result)),
        });
        failure = post.failureKind;
        retried = true;
        retryNote = `\n[执行内核] 首次调用被判定为暂时性失败，已按契约幂等重试 1 次（幂等键 ${pre.idempotencyKey}）`;
      } else if (failure && failure.retryable) {
        exec.machine.audit.record('tool-retry-deferred', { name: call.name, idempotencyKey: pre.idempotencyKey, reason: '重试预算已用尽' });
      }

      const status = (execError || post.failureSignalled || post.failureKind) ? 'failed' : 'succeeded';
      // 把结论写回 call 本身：工具芯片重建（合并到同轮最后一条消息 / 刷新页面）后仍能显示 成功 / 失败 与耗时
      call.status = status === 'failed' ? 'error' : 'ok';
      call.durationMs = Math.max(1, Date.now() - t0);   // 本地小工具常在 1ms 内结束：记 1ms 而不是 0，界面上才有耗时可显示
      if (status === 'failed') call.errorNote = String((execError && execError.message) || (failure && failure.label) || '').slice(0, 200);
      const closed = exec.machine.endToolRun(run, {
        status,
        failure,
        postValidation: post,
        fsDigestBefore: fsBefore.digest,
        fsDigestAfter: fsAfter.digest,
        recovered: retried && status === 'succeeded',
        notes: [
          ...(risk.confirmed ? ['confirmed'] : []),
          ...(retried ? ['auto-retry'] : []),
          ...post.issues.map((i) => i.id),
        ],
      });
      waveRuns.push(closed);
      exec.seenIdempotency.set(pre.idempotencyKey, {
        status: failure && failure.verifyFirst ? 'uncertain' : (status === 'failed' ? 'failed' : 'succeeded'),
        index: closed.index,
      });
      // P1 幂等账本落定：记录结果摘要与「本步产物」摘要，供下轮做复用/拦截裁决
      const primaryPath = delta.touched.length ? delta.touched[0] : extractFilePath(call.args);
      closed.changedFiles = delta.touched;
      closed.opKey = opKey;
      exec.ledger.settle(opKey, {
        status: failure && failure.verifyFirst ? 'uncertain' : (status === 'failed' ? 'failed' : 'succeeded'),
        tool: call.name,
        turnId: exec.execCtx.turnId,
        resultDigest: digestResultText(result).slice(0, 16),
        artifactPath: primaryPath || '',
        artifactDigest: primaryPath && Object.prototype.hasOwnProperty.call(filesAfter, primaryPath)
          ? digestArtifact(filesAfter[primaryPath]).digest : '',
        reason: failure ? `${failure.label}${failure.verifyFirst ? '（副作用不确定）' : ''}` : '',
      });
      exec.completedSteps.push({
        name: call.name,
        status,
        argsSummary: closed.argsSummary,
        artifacts: delta.touched,
        at: closed.startedAt,
      });
      for (const f of delta.added.concat(delta.changed)) {
        if (!exec.artifacts.some((a) => a.path === f.path)) exec.artifacts.push({ path: f.path, step: call.name });
      }
      exec.changedPaths.push(...delta.touched);

      // ⑥ 结果回喂模型：失败归类 + 恢复路径 + 副作用不确定的硬提示（禁止盲目重试）
      // 状态类故障（外部改文件 / 中途撤销授权）先落地：模拟真实世界里「工具说自己成功了，
      // 但环境已经变了 / 用户改主意了」——这类变化必须出现在回喂内容里，而不是等下一轮才发现
      if (exec.faultInjector) {
        const applied = exec.faultInjector.afterToolCall({ store, index: closed.index, name: call.name, fs });
        if (applied.length) exec.faultNote = [exec.faultNote, `[故障注入] ${applied.map((a) => a.kind).join('、')}`].filter(Boolean).join('\n');
      }
      let notes = exec.faultNote ? `${exec.faultNote}\n` : '';
      exec.faultNote = '';
      if (failure && failure.verifyFirst) {
        notes += `\n\n⚠️ 执行内核：该调用可能已经产生了副作用但结果丢失（幂等键 ${pre.idempotencyKey}）。${failure.guidance}`;
      } else if (failure) {
        notes += `\n\n[执行内核] 失败归类：${failure.label}（${failure.handling}）。${failure.guidance || ''}`;
      }
      const highIssues = post.issues.filter((i) => i.severity === 'high');
      for (const issue of highIssues) {
        if (!(failure && failure.verifyFirst)) notes += `\n\n⚠️ 执行内核：${issue.detail}`;
      }
      if (risk.level === 'L3') notes += `\n\n[执行内核] 本次操作风险等级 L3（${risk.levelLabel}）：${risk.reasons.join('；')}`;
      if (retryNote) notes += retryNote;
      const left = exec.budgetGov.remaining('toolCalls');
      if (Number.isFinite(left) && left <= 1) notes += `\n\n⚠️ 执行内核：本轮工具调用预算即将用尽（剩余 ${left}），后续调用会被拒绝，请尽快收敛结论。`;
      return `${String(result)}${notes}`;
    };

    for (const b of planToolWaves(calls)) {
      if (b.kind === 'serial') {
        out[b.indices[0]] = await runOne(calls[b.indices[0]]);
        continue;
      }
      if (b.kind === 'dispatch') {
        const limit = DISPATCH_CONCURRENCY;
        for (let k = 0; k < b.indices.length; k += limit) {
          const group = b.indices.slice(k, k + limit);
          exec.budgetGov.spend('parallelTasks', group.length, { batch: b.kind });
          const rs = await Promise.all(group.map((n) => runOne(calls[n])));
          group.forEach((n, m) => { out[n] = rs[m]; });
        }
        continue;
      }
      // parallel：整波一起下发，但按类别限流（网络 ≤ 4 / 本地 ≤ 8）
      const items = b.indices.map((n) => ({ index: n, name: calls[n].name }));
      exec.budgetGov.spend('parallelTasks', plannedConcurrency(items.map((it) => it.name)), { batch: b.kind });
      const rs = await runWithCategoryLimits(items, (n) => runOne(calls[n]));
      b.indices.forEach((n, m) => { out[n] = rs[m]; });
    }

    // 波次收尾：工具态必须闭环到 TOOL_SUCCEEDED / TOOL_FAILED（绝不停留在 RUNNING），
    // 再把「下一步」显式标注为 RECOVERY_PENDING（副作用不确定）或 RETRY_PENDING（可重试但预算/次数已尽）。
    const failedRuns = waveRuns.filter((r) => r.status === 'failed' || r.status === 'blocked');
    const uncertainRuns = failedRuns.filter((r) => r.failure && r.failure.verifyFirst);
    const deferrableRuns = failedRuns.filter((r) => r.failure && r.failure.retryable && !r.recovered);
    if (failedRuns.length) {
      exec.machine.transition(EXECUTION_STATES.TOOL_FAILED,
        `${failedRuns.length}/${waveRuns.length} 次调用未成功：${failedRuns.map((r) => `${r.name}(${(r.failure && r.failure.label) || '失败'})`).join('、')}`);
      if (uncertainRuns.length) {
        exec.machine.transition(EXECUTION_STATES.RECOVERY_PENDING,
          `副作用状态不确定：${uncertainRuns.map((r) => r.name).join('、')}。恢复路径=先核验目标状态再决定是否重发`,
          { idempotencyKeys: uncertainRuns.map((r) => r.idempotencyKey) });
      } else if (deferrableRuns.length) {
        exec.machine.transition(EXECUTION_STATES.RETRY_PENDING,
          `可重试失败待重发：${deferrableRuns.map((r) => r.name).join('、')}（退避重试次数/预算已用尽，交由下一轮决定）`,
          { idempotencyKeys: deferrableRuns.map((r) => r.idempotencyKey) });
      }
    } else {
      exec.machine.transition(EXECUTION_STATES.TOOL_SUCCEEDED, `${waveRuns.length} 次调用全部成功`);
    }

    // P1 检查点：本波结束后落盘「已完成步骤 / 待完成步骤 / 产物摘要 / 状态摘要」，
    // 刷新或中断后据此判断哪些步骤可复用、哪些必须先核验。
    const cp = exec.checkpoints.record(buildCheckpoint({
      turnId: exec.execCtx.turnId,
      sessionId: exec.execCtx.sessionId,
      executionState: exec.machine.state,
      completedSteps: exec.completedSteps,
      pendingStep: `完成用户请求：${exec.execCtx.userIntent.slice(0, 60) || '（未记录）'}`,
      artifacts: exec.artifacts,
      files: fs.export(),
      messages: store.state.messages,
      memory: store.state.memory,
      budget: exec.budgetGov.snapshot(),
      riskLevel: deriveTurnRiskLevel(waveRuns),
      idempotencyKeys: waveRuns.map((r) => r.idempotencyKey).filter(Boolean),
      note: `${waveRuns.length} 次调用：${waveRuns.map((r) => `${r.name}(${r.status})`).join('、')}`,
    }));
    cp.capabilityCode = exec.capabilities.capCode;
    cp.pendingNeedsSandbox = waveRuns.some((r) => r.status === 'failed' || r.status === 'blocked');
    exec.lastCheckpoint = cp;
    store.state.executionCheckpoints = exec.checkpoints.toJSON();
    exec.machine.audit.record('checkpoint', {
      checkpointId: cp.checkpointId, stateDigest: cp.stateDigest, filesDigest: cp.filesDigest,
      completedSteps: cp.completedSteps.length, artifacts: cp.artifacts.length, riskLevel: cp.riskLevel,
    });
    return out;
  }

  // 本波最高风险等级（检查点用：L3 的续跑点必须重新确认）
  function deriveTurnRiskLevel(runs) {
    const order = ['L0', 'L1', 'L2', 'L3'];
    return (runs || []).reduce((acc, r) => {
      const lv = (r.risk && r.risk.level) || 'L0';
      return order.indexOf(lv) > order.indexOf(acc) ? lv : acc;
    }, 'L0');
  }
  return { runToolCalls, toolCtxFor };
}
