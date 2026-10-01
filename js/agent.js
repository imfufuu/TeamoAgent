// ─── Agent 核心：工具调用循环（Hermes 式回合生命周期）────────────────
// idle → moderating → thinking → streaming → tool_executing → (loop) → done / error / cancelled
//
// 回合（对齐 hermes-agent conversation_loop）：
//   1. 追加 user  2. Jev System-1（fail-open）  3. 装配/复用 cached 系统提示
//   4. 预检压缩（>50% 窗口）  5. 注入 ephemeral（Jev / 技能正文 / 预算）
//   6. 可中断流式调用  7. 有 tool_calls → 并行安全工具并发，写回，回到 5
//   8. 终态：蒸馏会话技能；长效记忆只来自 remember / 右侧面板（不自动记闲聊）
//
// 架构要点：
//   · 提示词稳定：身份+技能目录不随时间/Jev/沙箱快照抖动（见 js/prompt.js）
//   · 上下文管理：按模型预算压缩历史（整轮丢弃，绝不产生孤儿 tool 消息）
//   · 健壮性：HTTP 层与流层双重重试；工具参数 JSON 解析失败自动反馈纠错
//   · 可观测：usage 归一、传输通道标记、工具结果截断保护上下文
//   · 附件：全部附件（文本 + 图片）自动复制到沙箱 uploads/，图片另走多模态协议块
//   · 生图：不作为对话模型直接调用，统一由主智能体经 generate_image 工具发起

import { streamChat, createToolCallAccumulator, createThinkingTracker, getTransport } from './api.js';
import { TOOL_DEFS, executeTool } from './tools.js';
import { createFS } from './sandbox.js';
import { effectiveApiKey } from './adminkey.js';
import { compactMessages, contextBudgetFor } from './context.js';
import { findSubagent, subagentGuide } from './subagents.js';
import { TOOL_LOOP_MAX, SUBAGENT_LOOP_MAX, systemPrompt, OUTPUT_SPEC, DEFAULT_IMAGE_MODEL } from './config.js';
import { planTurn } from './jev.js';
import { assembleSystemLayers, formatRuntime, formatBudgetNote } from './prompt.js';
import { formatSkillsIndex, selectSkillBodies, distillSkill, rememberSkill, pruneLearnedSkillsWithReport } from './skills.js';
import { formatMemory, formatActiveMemoryReminder, extractAutoMemoryFacts, upsertFacts, pruneMemoryFacts, recallArchivedMemories } from './memory.js';
import {
  discoverWorkspaceContext,
  shouldTriggerSessionRecall,
  searchCrossSessionMemory,
  formatSessionRecallNote,
  flushDroppedTurnsToMemory,
  refineSkillWithTelemetry,
  analyzeToolTrajectory,
  formatReflectionNote,
  createTaskLedger,
  formatTaskLedgerNote,
  evaluateLocalFastPathGate,
  resolveNexusExecutionProfile,
  escalateNexusProfile,
  recommendExecutionEngine,
  formatExecutionRoutingHint,
  arbitrateSubagentReports,
  formatSubagentArbitrationNote,
  resolveEffectiveReasoningState,
  computeCapabilityVector,
  arbitrateUnifiedEvidence,
  buildDegradationDiagnostics,
  formatDegradationDiagnostics,
  budgetEphemeralGovernanceNotes,
  createFaithfulTraceRecorder,
  GENESIS_TURN_DIGEST,
  auditFootprintAgainstStore,
  buildDecisionFootprint,
  formatDecisionFootprintForPrompt,
  createTurnTelemetry,
  recordRouteLatencySample,
  evaluateNexusAcceptanceMetrics,
} from './nexus.js';
import { moderateUserTurn } from './moderation.js?v=2026.10.1.12';
// ─── P0 执行内核（THN v2.3）：统一状态机 + 预算与风险治理 + 工具契约校验 ───
// 新模块单独成文件并带 ?v=（混版纪律）：旧版 agent.js 不 import 它，不会因缺导出白屏。
import {
  EXECUTION_STATES,
  EXECUTION_POLICY_VERSION,
  DEFAULT_TURN_BUDGET,
  createExecutionStateMachine,
  resumeExecutionState,
  classifyTaskClass,
  normalizeReasoningState,
  createExecutionContext,
  assertContextToolAlignment,
  buildCapabilityConstraints,
  describeCapabilityConstraints,
  validateToolCallPre,
  validateToolResultPost,
  classifyToolRisk,
  formatConfirmationRequest,
  createBudgetGovernor,
  formatBudgetLedger,
  fsDigest,
  finalizeExecutionTurn,
  summarizeExecutionRecord,
  evaluateExecutionKernelAcceptance,
} from './execution.js?v=2026.10.1.12';

// 沙箱开关只该管住代码执行 —— 这份列表与 tools.js 里的 CODE_TOOL_NAMES 必须一致
//（有单测钉住）。故意不在这里 import toolsFor/CODE_TOOL_NAMES：静态站点没有构建器，
// 跨模块「新增具名导出」在混版缓存下会让整个模块图 link 失败（表现为页面直接白屏），
// 而 TOOL_DEFS 是新旧两版都存在的导出，用它本地过滤最稳。
const CODE_TOOL_NAMES = ['execute_javascript', 'execute_python', 'execute_cpp'];
const toolsFor = (sandboxEnabled) =>
  sandboxEnabled ? TOOL_DEFS : TOOL_DEFS.filter((t) => !CODE_TOOL_NAMES.includes(t.name));
// 只在中继里能用的工具：网页版（GitHub Pages）没有 server.py，这两个调到必然失败。
// 实测后果：模型会拿 fetch_url 去「联网」，失败后要么编数字、要么说一堆环境限制，
// 而真正可用的服务器网页搜索就在同一份请求里。没有中继时直接不提供，别给死路。
const RELAY_ONLY_TOOLS = new Set(['fetch_url']);
const RELAY_OFF_NOTE = '\n\n【工具可用性】本环境没有本地中继（GitHub Pages / 未运行 server.py），因此 fetch_url '
  + '本轮不在工具表里，顶栏「联网」也不可用；run_git 仍可用内置沙箱 Git（不支持 clone/push 等远端网络操作）。不要声称已经搜过网页。';

// 附件落盘文件名：去掉路径分隔与控制字符，避免越权写到 uploads/ 之外
const safeName = (n) => String(n || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 120) || 'file';

// 用户附件 → 沙箱 uploads/（文本写原文，图片写 data URL 以便编辑/打包下载）
// 同名且内容相同则复用路径；内容不同则追加序号，避免覆盖上一轮上传
export function copyAttachmentsToFS(fs, attachments = []) {
  const written = [];
  const taken = new Set(fs.list().map((f) => f.path));
  for (const a of attachments || []) {
    const content = a.kind === 'text' ? a.text : (a.dataUrl || a.text);
    if (content == null || content === '') continue;
    const base = `uploads/${safeName(a.name)}`;
    let path = base;
    if (taken.has(path) && fs.read(path) !== content) {
      const dot = base.lastIndexOf('.');
      for (let n = 2; taken.has(path); n++) {
        path = dot > 0 ? `${base.slice(0, dot)}-${n}${base.slice(dot)}` : `${base}-${n}`;
      }
    }
    fs.write(path, content);
    taken.add(path);
    written.push(path);
  }
  return written;
}

// ─── 子智能体运行器：独立上下文的迷你工具循环（不可再委派，防递归）────
// （导出以供 tests/live-smoke.mjs 对真实 API 验证）
export function subagentTools(sandboxEnabled, def) {
  // 按「本轮实际可用的工具」取交集：沙箱关闭时代码执行工具不可用，
  // 但读写文件之类不执行任意代码的工具仍应留给子智能体（旧写法直接给了 null，
  // 等于一关沙箱就把所有子智能体退化成纯推理）。
  const allow = new Set(toolsFor(sandboxEnabled).map((t) => t.name));
  if (!def.tools.length) return null;
  const list = TOOL_DEFS.filter((t) => def.tools.includes(t.name) && t.name !== 'dispatch_subagent' && allow.has(t.name));
  return list.length ? list : null;
}

export async function runSubagent(def, task, { apiKey, model, thinking, reasoningLevel, sandboxEnabled, webEnabled, fs, signal, onThinkingFallback, onWebFallback, imageModel, onSubagentUsage, memory }) {
  const subTools = subagentTools(sandboxEnabled, def);
  const memBlock = formatMemory(memory);
  const messages = [
    { role: 'system', text: `${def.prompt}\n\n你是 TeamoAgent 体系中的「${def.name}」子智能体。直接产出最终报告，不要寒暄。当前时间：${new Date().toISOString()}${memBlock ? `\n\n${memBlock}` : ''}\n\n${OUTPUT_SPEC}` },
    { role: 'user', text: task },
  ];
  let finalText = '';
  let subInput = 0;
  let subOutput = 0;
  let subReasoning = 0;
  for (let i = 0; SUBAGENT_LOOP_MAX <= 0 || i < SUBAGENT_LOOP_MAX; i++) {
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const acc = createToolCallAccumulator();
    const tb = createThinkingTracker(); // 思考块需随 tool_use 回合回传，否则下一轮 400
    let text = '';
    const roundUsage = { input: 0, output: 0, reasoning: 0 };
    await streamChat({
      model, apiKey, thinking, reasoningLevel, signal, tools: subTools,
      subagentId: def.id, iteration: i + 1,
      onThinkingFallback,
      webEnabled: !!webEnabled, onWebFallback,
      messages,
      onEvent: (ev) => {
        if (ev.type === 'text') text += ev.text;
        else if (ev.type === 'reasoning') tb.delta(ev.index, ev.text);
        else if (ev.type === 'block_start' && ev.block && (ev.block.type === 'thinking' || ev.block.type === 'redacted_thinking')) tb.start(ev.index, ev.block);
        else if (ev.type === 'signature_delta') tb.signature(ev.index, ev.signature);
        else if (ev.type === 'tool_delta') acc.push(ev);
        else if (ev.type === 'usage' && ev.usage) {
          if (ev.usage.input != null) roundUsage.input = ev.usage.input;
          if (ev.usage.output != null) roundUsage.output = ev.usage.output;
          if (ev.usage.reasoning != null) roundUsage.reasoning = ev.usage.reasoning;
        }
        else if (ev.type === 'error') throw new Error(ev.message);
      },
    });
    subInput += roundUsage.input;
    subOutput += roundUsage.output;
    subReasoning += roundUsage.reasoning;
    finalText = text;
    const calls = acc.result();
    if (!calls.length) break;
    const blocks = tb.blocks();
    messages.push({ role: 'assistant', text, toolCalls: calls, ...(blocks.length ? { thinkingBlocks: blocks } : {}) });
    for (const c of calls) {
      // imageModel 要透传：否则子智能体出图会绕开用户在模型菜单里选定的生图模型
      const res = await executeTool(c.name, c.args, { fs, onUi: () => {}, apiKey, imageModel: imageModel || null, sandboxEnabled, signal });
      messages.push({ role: 'tool', toolCallId: c.id, name: c.name, content: res });
    }
  }
  if (typeof onSubagentUsage === 'function' && (subInput || subOutput || subReasoning)) {
    try { onSubagentUsage({ model, usage: { input: subInput, output: subOutput, ...(subReasoning ? { reasoning: subReasoning } : {}) } }); } catch { /* noop */ }
  }
  return finalText || '（子智能体未产生最终报告）';
}

// 联网开关的提示词：联网用的是模型 API 自带的网页搜索请求格式，所以这里不挂我们自己的搜索工具，
// 只告诉模型「能力从哪来」。文本放在本模块内而不是给 config.js 新增具名导出再 import —— 那会在
// 「新 agent.js + 旧 config.js」的混版缓存下触发 ESM link 错误（整页白屏），历史上真踩过。
const WEB_ON_NOTE = '\n\n【联网】本轮已开。用 fetch_url 经本地中继抓取具体网址；不要声称已经做过网页搜索。没有检索结果就直说没查到。';
const WEB_OFF_NOTE = '\n\n【联网】本轮未联网。没有本地中继时顶栏「联网」是灰色且点不了。不要声称自己能查实时信息：'
  + '涉及时效性问题就直说「当前未联网，无法核实」；确定的知识可以直接答，但别把记忆包装成「刚查到的」。';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 一次委派最多并发几个子智能体（再高就是自己跟自己抢网关并发额度了）
const DISPATCH_CONCURRENCY = 3;
// 只读 / 无共享可变状态的工具可以并发（Hermes ThreadPoolExecutor 的浏览器等价物）。
// 写沙箱、跑代码、生图、git 仍串行，避免交错后说不清基于哪一版文件。
export const PARALLEL_TOOLS = new Set(['read_file', 'list_files', 'get_current_time', 'fetch_url', 'regex', 'hash', 'codec', 'unicode', 'evaluate_expression']);
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

export function createAgent(store, hooks = {}) {
  const fs = createFS(store.state.files);
  let abortController = null;
  let status = 'idle'; // idle | moderating | thinking | streaming | executing | done | error | cancelled

  // UI 钩子统一经 emit 分发：钩子缺失或抛错都不得打断对话循环。
  // 线上教训：GitHub Pages 对 JS 子资源有 ~10 分钟缓存，浏览器可能拿到「新版 main.js +
  // 旧版 ui.js」；旧 ui.js 没有 onUserMessage，直接调用会 TypeError 冒泡到 send()，
  // 表现成「发了提示词界面毫无反应」。视图层的异常只该降级，不该 brick 整轮对话。
  const emit = (name, ...args) => {
    const fn = hooks[name];
    if (typeof fn !== 'function') return undefined;
    try {
      return fn(...args);
    } catch (err) {
      console.warn(`[TeamoAgent] hooks.${name} 异常（已忽略，不影响本轮对话）`, err);
      return undefined;
    }
  };

  const setStatus = (s) => { status = s; emit('onStatus', s); };
  const syncFS = () => { store.state.files = fs.export(); };

  // lockModel：本轮锁定的模型（runLoop 开头取的快照），保证预算与提示词不会因
  // 用户中途切换模型而和本轮上下文错位
  // cached 前缀（身份 + 技能目录 + 子智能体指引）按用户回合复用；
  // volatile（记忆/沙箱/时间/联网）每轮迭代重建；ephemeral 只放 Jev/技能正文/预算。
  let cachedPrefix = null;
  function buildMessages(lockModel, relayOk = true, jevNote = '', plan = null, iteration = 1, nexusState = null) {
    // 审核拦截提示只用于界面反馈，绝不进入后续模型上下文。
    const messages = (store.state.messages || []).filter((m) => !m.transientModeration);
    const model = lockModel || store.state.model;
    const budget = contextBudgetFor(model);
    const { messages: compacted, droppedCount, droppedDigest } = compactMessages(messages, budget, { preflight: true });
    if (droppedCount > 0 && droppedDigest) {
      store.state.memory = flushDroppedTurnsToMemory(store.state.memory, droppedDigest);
    }
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const userText = lastUser && lastUser.text ? String(lastUser.text) : '';
    const webOn = store.state.settings.webEnabled !== false && relayOk;
    const st = store.state.settings || {};
    const turnTools = nexusState && Array.isArray(nexusState.turnTools) ? nexusState.turnTools : null;
    const tierState = resolveEffectiveReasoningState({
      thinking: st.thinking,
      reasoningLevel: st.reasoningLevel || 'medium',
      tools: turnTools,
    });
    const lv = tierState.effectiveLevel;
    const canDispatch = tierState.canDispatch;
    if (!cachedPrefix) {
      // 回合开始前先跑一次记忆与技能整理：噪声条目（如 learned-这个呢）硬清除，超期条目转入软归档冷库，并按用户问题唤醒冷备记忆
      store.state.memoryArchive = Array.isArray(store.state.memoryArchive) ? store.state.memoryArchive : [];
      store.state.memory = pruneMemoryFacts(store.state.memory, { archiveSink: store.state.memoryArchive });
      const arcRecall = recallArchivedMemories(userText, {
        activeFacts: store.state.memory,
        archivePool: store.state.memoryArchive,
      });
      if (arcRecall.recalled.length) {
        store.state.memory = arcRecall.nextActive;
        if (nexusState) nexusState.revivedMemories = arcRecall.recalled;
      }
      const skillGc = pruneLearnedSkillsWithReport(store.state.learnedSkills);
      store.state.learnedSkills = skillGc.kept;
      if (nexusState) {
        if (skillGc.prunedIds.length) nexusState.prunedSkillIds = skillGc.prunedIds;
        if (skillGc.archivedIds && skillGc.archivedIds.length) nexusState.archivedSkillIds = skillGc.archivedIds;
      }
      const wsCtx = discoverWorkspaceContext(fs);
      const subGuide = subagentGuide({ allow: canDispatch, ultra: canDispatch && lv === 'ultra' });
      cachedPrefix = assembleSystemLayers({
        identity: systemPrompt(new Date(), { webEnabled: webOn, allowDispatch: canDispatch, reasoningLevel: lv }),
        skillsIndex: formatSkillsIndex(store.state.learnedSkills),
        contextFiles: [subGuide, wsCtx].filter(Boolean).join('\n\n'),
      }).cached;
    }
    const hasAtts = !!(lastUser && Array.isArray(lastUser.attachments) && lastUser.attachments.length);
    const localGate = !plan
      ? evaluateLocalFastPathGate(userText, { hasAttachments: hasAtts, historyLen: Math.max(0, messages.length - 1) })
      : null;
    const effectivePlan = plan || (localGate && localGate.syntheticPlan) || null;
    const baseProfile = (nexusState && nexusState.profile) || resolveNexusExecutionProfile({
      userText,
      plan: effectivePlan,
      hasAttachments: hasAtts,
      iteration,
      toolCallsCount: nexusState && nexusState.stepHistory ? nexusState.stepHistory.length : 0,
    });
    const execProfile = escalateNexusProfile(baseProfile, {
      iteration,
      toolCallsCount: nexusState && nexusState.stepHistory ? nexusState.stepHistory.length : 0,
      userText,
    });
    if (nexusState) nexusState.profile = execProfile;

    const recallT0 = Date.now();
    const shouldRecallNow = !execProfile.fastPath
      && (iteration === 1 || execProfile.escalated)
      && shouldTriggerSessionRecall(userText)
      && Array.isArray(store.state.sessions);
    const recallHits = shouldRecallNow
      ? searchCrossSessionMemory(store.state.sessions, userText, { excludeSessionId: store.state.activeSessionId })
      : [];
    const skillBodyNote = selectSkillBodies(effectivePlan, userText, store.state.learnedSkills);
    const matchedSkillIds = skillBodyNote
      ? [...skillBodyNote.matchAll(/## (?:Skill|Learned skill):\s*([^\n\r]+)/g)].map((m) => m[1].trim())
      : [];
    const engineRec = !execProfile.fastPath
      ? recommendExecutionEngine(userText, { sandboxEnabled: store.state.settings.sandboxEnabled !== false, webEnabled: webOn })
      : null;
    const engineRoutingNote = iteration === 1 ? formatExecutionRoutingHint(engineRec) : '';
    const activeMemReminder = formatActiveMemoryReminder(store.state.memory);
    const reflectionNote = (!execProfile.fastPath && nexusState && nexusState.stepHistory)
      ? formatReflectionNote(analyzeToolTrajectory(nexusState.stepHistory))
      : '';
    const ledgerNote = (!execProfile.fastPath && nexusState && nexusState.ledger)
      ? formatTaskLedgerNote(nexusState.ledger)
      : '';
    const unifiedArb = !execProfile.fastPath
      ? arbitrateUnifiedEvidence({
        canDispatch,
        thinking: st.thinking !== false,
        reasoningLevel: st.reasoningLevel || 'medium',
        tools: turnTools,
        userText,
        stepHistory: nexusState ? nexusState.stepHistory : [],
        subagentReports: nexusState ? nexusState.subagentReports : [],
      })
      : { mode: 'none', modeLabel: '轻快旁路', hasConflict: false, note: '' };
    const degradations = buildDegradationDiagnostics({
      relayOk,
      webEnabled: webOn,
      sandboxEnabled: store.state.settings.sandboxEnabled !== false,
      canDispatch,
      thinking: st.thinking !== false,
      reasoningLevel: st.reasoningLevel || 'medium',
      tools: turnTools,
    });
    const capVec = computeCapabilityVector({
      relayOk,
      webEnabled: webOn,
      sandboxEnabled: store.state.settings.sandboxEnabled !== false,
      canDispatch,
    });
    const usedToolNamesNow = nexusState && nexusState.stepHistory ? nexusState.stepHistory.map((s) => s.name) : [];
    const prevAssistantWithFp = [...store.state.messages].reverse().find((m) => m.role === 'assistant' && m.nexusFootprint && m.nexusFootprint.turnDigest);
    const prevTurnDigest = (prevAssistantWithFp && prevAssistantWithFp.nexusFootprint.turnDigest) || GENESIS_TURN_DIGEST;
    const traceRec = createFaithfulTraceRecorder({ prevTurnDigest });
    traceRec.record(execProfile.escalated ? 'route:escalated' : (execProfile.fastPath ? 'route:fast-path' : 'route:full-nexus'), execProfile.mode);
    if (Array.isArray(store.state.memory) && store.state.memory.length > 0) {
      traceRec.record('memory:injected', String(store.state.memory.length));
    }
    if (usedToolNamesNow.length > 0) {
      traceRec.record('tools:executed', usedToolNamesNow.join(','));
    }
    const footprint = buildDecisionFootprint({
      profile: execProfile,
      memories: store.state.memory,
      recalledArchivedMemories: (nexusState && nexusState.revivedMemories) || [],
      recalledSessions: recallHits,
      matchedSkillIds,
      prunedSkillIds: (nexusState && nexusState.prunedSkillIds) || [],
      archivedSkillIds: (nexusState && nexusState.archivedSkillIds) || [],
      usedTools: usedToolNamesNow,
      arbitration: unifiedArb,
      degradations,
      traceRecorder: traceRec,
      prevTurnDigest,
    });
    const govBudget = budgetEphemeralGovernanceNotes({
      fastPath: execProfile.fastPath,
      userText,
      footprint,
      degradations,
      capCode: capVec.code,
      arbitrationNote: unifiedArb.note || '',
      engineRoutingNote,
    });
    if (nexusState) nexusState.lastFootprint = footprint;
    if (nexusState && nexusState.telemetry) {
      nexusState.telemetry.fastPath = execProfile.fastPath;
      nexusState.telemetry.escalated = !!execProfile.escalated;
      nexusState.telemetry.activeMemoryCount = Array.isArray(store.state.memory) ? store.state.memory.length : 0;
      nexusState.telemetry.recalledSessions = recallHits.length;
      nexusState.telemetry.recalledSkills = matchedSkillIds.length;
      if (unifiedArb.hasConflict) nexusState.telemetry.subagentConflicts = 1;
      nexusState.telemetry.recordLayer('L2+L3', Date.now() - recallT0);
    }
    const layers = assembleSystemLayers({
      identity: cachedPrefix,
      memory: formatMemory(store.state.memory),
      runtime: formatRuntime({
        now: new Date(),
        model,
        imageModel: store.state.imageModel || DEFAULT_IMAGE_MODEL,
        filesNote: fsNote(),
        webNote: webOn ? WEB_ON_NOTE : WEB_OFF_NOTE,
        relayNote: relayOk ? '' : RELAY_OFF_NOTE,
      }),
      ephemeral: [
        govBudget.footprintNote,
        activeMemReminder,
        govBudget.degradationNote,
        jevNote || '',
        skillBodyNote,
        govBudget.engineRoutingNote,
        formatSessionRecallNote(recallHits),
        govBudget.arbitrationNote,
        ledgerNote,
        reflectionNote,
        droppedCount ? `（上下文管理：为适配 ${model} 的窗口预算，已省略最早 ${droppedCount} 条消息）` : '',
        formatBudgetNote(iteration, TOOL_LOOP_MAX),
      ].filter((s) => s && String(s).trim()).join('\n\n'),
    });
    return [...layers.messages, ...compacted];
  }

  function fsNote() {
    const list = fs.list();
    if (!list.length) return '';
    return `\n\n## 当前沙箱文件\n${list.slice(0, 40).map((f) => `- ${f.path} (${f.size}B)`).join('\n')}${list.length > 40 ? `\n…等共 ${list.length} 个` : ''}`;
  }

  // 单个工具的执行上下文（含子智能体委派闭包）。本轮的 apiKey/model/thinking 等一律
  // 来自 runLoop 开头的快照，避免「中途换模型 → 子智能体跟着换」的错位。
  function toolCtxFor(call, turn) {
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
      sandboxEnabled: turn.sandboxEnabled,
      allowDispatch: !!turn.canDispatch,
      signal: turn.signal,
      onUi: (patch) => {
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
          webEnabled: turn.webEnabled,
          imageModel: turn.imageModel,
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

  // 同一轮里：dispatch_subagent 并发；只读工具并发；写/执行串行。
  // 结果仍按调用原顺序写回对话，两种协议的 tool_use/tool_result 配对都不受影响。
  //
  // P0 执行内核接线点：每次调用都走「调用前契约校验 → 预算扣减 → 执行 → 调用后核验」，
  // 并把调用前状态 / 调用后状态 / 理由 / 风险等级 / 幂等键 / 副作用摘要写进版本化审计轨迹。
  async function runToolCalls(calls, turn, exec) {
    const out = new Array(calls.length);
    const waveRuns = [];
    const toolDefByName = new Map(exec.toolList.map((t) => [t.name, t]));
    if (exec.machine.canTransition(EXECUTION_STATES.TOOL_PENDING)) {
      exec.machine.transition(EXECUTION_STATES.TOOL_PENDING, `模型请求 ${calls.length} 次工具调用`, { tools: calls.map((c) => c.name) });
    }
    exec.machine.transition(EXECUTION_STATES.TOOL_RUNNING, `开始执行 ${calls.length} 次调用（批处理：${batchToolCalls(calls).map((b) => b.kind).join('+')}）`);

    const recordBlocked = (call, { reason, failure, risk, idempotencyKey, notes = [] }) => {
      const run = exec.machine.beginToolRun({ callId: call.id, name: call.name, args: call.args, reason, risk, idempotencyKey });
      const closed = exec.machine.endToolRun(run, { status: 'blocked', failure, notes });
      waveRuns.push(closed);
      if (idempotencyKey) exec.seenIdempotency.set(idempotencyKey, { status: 'blocked', index: closed.index });
      return closed;
    };

    const runOne = async (call) => {
      if (turn.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      emit('onToolStart', call);
      const toolDef = toolDefByName.get(call.name) || null;

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
        const budgetBlocked = pre.errors.some((e) => e.id === 'budget-tool-calls-exhausted');
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
          ? `${pre.message}\n${formatBudgetLedger(exec.budgetGov)}`
          : pre.message;
      }

      // ③ 严格模式下的高风险确认（默认 observe：只记录风险等级并放行；P1 才接交互确认）
      if (risk.requiresConfirmation && store.state.settings.executionGuard === 'strict') {
        const request = formatConfirmationRequest({
          name: call.name, args: call.args,
          reason: risk.reasons[0] || '', impact: undefined,
          reversibility: risk.irreversible ? '不可自动恢复' : undefined,
        });
        emit('onConfirmationRequest', call, request);
        recordBlocked(call, {
          reason: '高风险操作在严格模式下等待用户确认',
          failure: { kind: 'PERMISSION', label: '等待用户确认', handling: '严格模式：需用户确认后才执行', retryable: false, maxRetries: 0, verifyFirst: false, guidance: '向用户展示确认请求，得到明确同意后再重新调用。' },
          risk, idempotencyKey: pre.idempotencyKey, notes: ['awaiting-confirmation'],
        });
        return `⏸ 该操作风险等级 ${risk.level}（${risk.levelLabel}），当前严格模式下需要用户确认后才执行：\n${request}`;
      }

      // ④ 预算扣减：工具调用 /（如有）外部副作用 —— 扣减失败即拒绝，不再执行
      const spendTool = exec.budgetGov.spend('toolCalls', 1, { tool: call.name });
      if (!spendTool.ok) {
        recordBlocked(call, {
          reason: '工具调用预算耗尽',
          failure: { kind: 'ENVIRONMENT', label: '预算耗尽', handling: '不重试：本轮预算已用尽', retryable: false, maxRetries: 0, verifyFirst: false, guidance: '给出阶段性结论并披露未完成部分。' },
          risk, idempotencyKey: pre.idempotencyKey, notes: ['budget-tool-calls-exhausted'],
        });
        return `⛔ 执行内核：${spendTool.reason}。请立即收敛结论并如实披露未完成的部分。\n${formatBudgetLedger(exec.budgetGov)}`;
      }
      exec.machine.audit.record('budget-spend', {
        channel: 'toolCalls', amount: 1, spent: spendTool.spent,
        limit: exec.budgetGov.budget.maxToolCalls, tool: call.name,
      });
      if (risk.hasExternalSideEffect) {
        const spendExt = exec.budgetGov.spend('externalSideEffects', 1, { tool: call.name });
        if (spendExt.ok) {
          exec.machine.audit.record('budget-spend', {
            channel: 'externalSideEffects', amount: 1, spent: spendExt.spent,
            limit: exec.budgetGov.budget.maxExternalSideEffects, tool: call.name,
          });
        }
      }

      // ⑤ 执行 + 调用后核验（含契约允许的退避重试，绝不盲目重试）
      const run = exec.machine.beginToolRun({
        callId: call.id, name: call.name, args: call.args,
        reason: `契约允许（${pre.contract ? pre.contract.sideEffect : 'unknown'} 副作用 · 超时 ${pre.contract ? pre.contract.timeoutMs : '-'}ms）· 风险 ${risk.level}`,
        risk, idempotencyKey: pre.idempotencyKey,
      });
      const toolCtx = { ...toolCtxFor(call, turn), execution: exec.execCtx };
      let fsBefore = fsDigest(fs);
      const t0 = Date.now();
      let result = '';
      let execError = null;
      try {
        result = await executeTool(call.name, call.args, toolCtx);
      } catch (err) {
        execError = err;
        result = `工具执行失败: ${err && err.message ? err.message : String(err)}`;
      }
      let fsAfter = fsDigest(fs);
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
        fsBefore = fsDigest(fs);
        try {
          result = await executeTool(call.name, call.args, toolCtx);
          execError = null;
        } catch (err) {
          execError = err;
          result = `工具执行失败: ${err && err.message ? err.message : String(err)}`;
        }
        fsAfter = fsDigest(fs);
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
      const closed = exec.machine.endToolRun(run, {
        status,
        failure,
        postValidation: post,
        fsDigestBefore: fsBefore.digest,
        fsDigestAfter: fsAfter.digest,
        recovered: retried && status === 'succeeded',
        notes: [...(retried ? ['auto-retry'] : []), ...post.issues.map((i) => i.id)],
      });
      waveRuns.push(closed);
      exec.seenIdempotency.set(pre.idempotencyKey, {
        status: failure && failure.verifyFirst ? 'uncertain' : (status === 'failed' ? 'failed' : 'succeeded'),
        index: closed.index,
      });

      // ⑥ 结果回喂模型：失败归类 + 恢复路径 + 副作用不确定的硬提示（禁止盲目重试）
      let notes = '';
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

    for (const b of batchToolCalls(calls)) {
      if (b.kind === 'serial') {
        out[b.start] = await runOne(calls[b.start]);
        continue;
      }
      const limit = b.kind === 'dispatch' ? DISPATCH_CONCURRENCY : (b.end - b.start);
      for (let k = b.start; k < b.end; k += limit) {
        const group = [];
        for (let n = k; n < Math.min(k + limit, b.end); n++) group.push(n);
        exec.budgetGov.spend('parallelTasks', group.length, { batch: b.kind });
        const rs = await Promise.all(group.map((n) => runOne(calls[n])));
        group.forEach((n, m) => { out[n] = rs[m]; });
      }
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
    return out;
  }

  async function runLoop() {
    // 整轮锁定 apiKey/model/settings：中途用户换模型不会让后续迭代与子智能体错位
    //（旧写法一处读 store.state、一处读快照，等于两个来源）
    // 管理员别名（admin-…）在这里换成真密钥：密钥只在内存里，且不进本轮日志/导出
    const { model, settings } = store.state;
    const apiKey = effectiveApiKey(store.state.apiKey);
    if (!apiKey) { emit('onNeedKey'); return; }
    if (status === 'connecting' || status === 'streaming' || status === 'thinking' || status === 'executing') return;

    const t0 = performance.now(); // 整轮计时：思考 + 生成 + 沙箱执行
    abortController = new AbortController();
    const signal = abortController.signal;
    // 沙箱关闭时仍保留文件/生图/时间/委派工具（只有代码执行三件套被摘掉）
    // 中继不在（静态站点常见）时，再把只在本地中继里能用的工具摘掉。
    // 状态来自 main.js 启动时的一次探测（store.state.relayOk），没探过就当「可能在」，
    // 避免每次回合都多发一个 /api/health 请求，也避免测试桩被这层探测打乱。
    const relayOk = store.state.relayOk !== false;
    const initTier = resolveEffectiveReasoningState({
      thinking: settings.thinking,
      reasoningLevel: settings.reasoningLevel || 'medium',
    });
    const lv = initTier.effectiveLevel;
    const canDispatch = initTier.canDispatch;
    const tools = toolsFor(settings.sandboxEnabled)
      .filter((t) => {
        if (t.name === 'fetch_url') return relayOk && settings.webEnabled !== false;
        return relayOk || !RELAY_ONLY_TOOLS.has(t.name);
      })
      .filter((t) => t.name !== 'dispatch_subagent' || canDispatch);
    const turn = {
      apiKey, model, signal,
      fastMode: !!settings.fastMode,
      thinking: settings.thinking !== false,
      reasoningLevel: lv,
      canDispatch,
      sandboxEnabled: settings.sandboxEnabled,
      webEnabled: settings.webEnabled !== false && relayOk,
      imageModel: store.state.imageModel || DEFAULT_IMAGE_MODEL,
      subagentReports: [],
    };
    let iterations = 0;
    cachedPrefix = null;
    // Jev 只在本轮开头跑一次（工具循环里不再打），失败则 jevNote 为空、对话照常。
    let jevNote = '';
    let turnPlan = null;
    const usedTools = [];
    const stepHistory = [];
    let hadToolError = false;
    let lastStepFailed = false;
    const lastUserInit = [...store.state.messages].reverse().find((m) => m.role === 'user');
    const taskLedger = createTaskLedger(lastUserInit && lastUserInit.text);
    const telemetry = createTurnTelemetry({
      model,
      activeMemoryCount: Array.isArray(store.state.memory) ? store.state.memory.length : 0,
    });
    const nexusState = { stepHistory, ledger: taskLedger, subagentReports: turn.subagentReports, telemetry, turnTools: tools };

    // ── P0 执行内核初始化（THN v2.3）──────────────────────────────────
    // 一个回合一条状态轨迹：路由/工具/审计/重试共用同一状态机，杜绝各模块各自维护状态。
    const sessionId = store.state.activeSessionId || 'session-local';
    const prevRecord = store.state.lastExecutionRecord && store.state.lastExecutionRecord.sessionId === sessionId
      ? store.state.lastExecutionRecord : null;
    const resumeInfo = prevRecord ? resumeExecutionState(prevRecord) : null;
    const capabilities = buildCapabilityConstraints({
      relayOk,
      webEnabled: settings.webEnabled !== false,
      sandboxEnabled: settings.sandboxEnabled !== false,
      canDispatch,
      overrides: store.state.settings.capabilityConstraints || null,
    });
    const budgetGov = createBudgetGovernor({ ...DEFAULT_TURN_BUDGET, ...(store.state.settings.executionBudget || {}) });
    const machine = createExecutionStateMachine({
      turnId: `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      policyVersion: EXECUTION_POLICY_VERSION,
      prevDigest: (prevRecord && prevRecord.auditDigest) || GENESIS_TURN_DIGEST,
    });
    const userIntentText = (lastUserInit && lastUserInit.text) || '';
    const execCtx = createExecutionContext({
      turnId: machine.turnId,
      sessionId,
      userIntent: userIntentText,
      taskClass: classifyTaskClass(userIntentText, { attachments: lastUserInit && lastUserInit.attachments }),
      reasoningState: normalizeReasoningState(turn.reasoningLevel, turn.thinking),
      capabilityMask: capabilities.bits,
      budget: budgetGov.budget,
      memory: { recalledIds: (store.state.memory || []).slice(0, 8).map((m) => m.id || 'mem'), candidateWrite: false },
      traceId: `${sessionId}:${machine.turnId}`,
    });
    const alignment = assertContextToolAlignment(execCtx, tools);
    const exec = {
      machine, capabilities, budgetGov, execCtx, alignment,
      toolList: tools,
      seenIdempotency: new Map(),
      resumeInfo,
      resumeNote: '',
      silentFailure: null,
      record: null,
      finalized: false,
    };
    turn.execution = execCtx;
    machine.audit.record('turn-received', {
      taskClass: execCtx.taskClass,
      reasoningState: execCtx.reasoningState,
      capabilityMask: execCtx.capabilityMask,
      capCode: capabilities.capCode,
      constraints: describeCapabilityConstraints(capabilities),
      budget: budgetGov.budget,
      toolCount: tools.length,
      contextAlignment: alignment.aligned,
      alignmentDiscrepancies: alignment.discrepancies,
      userIntentPreview: userIntentText.slice(0, 60),
      userIntentDigest: execCtx.userIntentDigest,
      model, fastMode: !!settings.fastMode,
    });
    machine.transition(EXECUTION_STATES.CLASSIFIED,
      `任务类型=${execCtx.taskClass} · 有效档位=${execCtx.reasoningState} · 能力掩码=${capabilities.capCode}${alignment.aligned ? '' : ` · ⚠ 上下文/工具表口径不一致：${alignment.discrepancies.join(',')}`}`);
    if (resumeInfo && resumeInfo.resumable && !prevRecord.resumeHintConsumed) {
      prevRecord.resumeHintConsumed = true;
      exec.resumeNote = `\n\n【执行内核 · 断点续跑】上一轮在「${resumeInfo.phaseLabel}」阶段被中断${resumeInfo.pendingStep ? `（未完成步骤：${resumeInfo.pendingStep}）` : ''}。${resumeInfo.hint}`;
    } else if (resumeInfo && !resumeInfo.resumable && resumeInfo.phase === EXECUTION_STATES.INTERRUPTED) {
      exec.resumeNote = '';
    }

    try {
      if (settings.jevEnabled !== false) {
        const jevT0 = Date.now();
        setStatus(turn.thinking ? 'thinking' : 'connecting');
        const lastUser = [...store.state.messages].reverse().find((m) => m.role === 'user');
        const plan = await planTurn({
          apiKey, model, settings, signal,
          text: lastUser ? lastUser.text : '',
          attachments: lastUser && lastUser.attachments,
        });
        telemetry.recordLayer('L1-jev', Date.now() - jevT0);
        if (plan && plan.ok && plan.note) {
          turnPlan = plan;
          jevNote = '\n\n' + plan.note;
          if (lastUser) {
            store.updateMessage(lastUser.id, {
              jev: { summary: plan.summary, route: plan.route, needSearch: plan.needSearch, difficulty: plan.difficulty },
            });
            emit('onJevPlan', lastUser, plan);
          }
        }
      }
      // 计划已定（Jev 失败/未启用也如实记为「按默认计划」）；断点续跑提示只注入一次
      if (exec.resumeNote) jevNote += exec.resumeNote;
      exec.machine.transition(EXECUTION_STATES.PLANNED,
        turnPlan ? `Jev 预判完成（route=${turnPlan.route || 'chat'}）` : 'Jev 未启用或未返回计划，按默认计划执行');

      while (TOOL_LOOP_MAX <= 0 || iterations < TOOL_LOOP_MAX) {
        iterations++;
        setStatus(turn.thinking ? 'thinking' : 'connecting');

        // ── 一次 LLM 流式调用（流层早期失败自动重试一次）──
        const acc = createToolCallAccumulator();
        let tb = createThinkingTracker(); // Anthropic 思考块（含 signature），随消息持久化并在下一轮回传
        let text = '', reasoning = '';
        let reasonT0 = 0;
        let sawToolDelta = false, lastChipPaint = 0;
        let web = null; // 服务端联网进度：{status, queries, sources, results}
        const usage = {};
        let finishReason = null;

        const assistantMsg = store.pushMessage({
          role: 'assistant', text: '', model, usage: null,
          fastMode: !!settings.fastMode,
          reasoningLevel: turn.thinking ? (turn.reasoningLevel || 'medium') : 'off',
        });
        emit('onAssistantStart', assistantMsg);
        setStatus('connecting'); // 已发出请求、尚未收到首个 token：UI 显示连接动画
        let streamed = false;
        const streamT0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

        const pull = () => streamChat({
              model, apiKey, tools, signal,
              fastMode: settings.fastMode,
              thinking: turn.thinking, // Off 时不发思考参数；流里若仍夹带 reasoning 也不入库
              reasoningLevel: turn.reasoningLevel,
              plan: turnPlan,
              iteration: iterations,
              onThinkingFallback: (m) => emit('onThinkingFallback', m), // 思考参数 400 降级 → 提示用户（不再静默）
              webEnabled: turn.webEnabled, // 联网：注入模型 API 自带的网页搜索请求格式
              onWebFallback: (m, why) => emit('onWebFallback', m, why), // 被拒 → 剥掉字段重试并说明
              messages: buildMessages(model, relayOk, jevNote, turnPlan, iterations, nexusState),
              onEvent: (ev) => {
                if (!streamed) { streamed = true; setStatus('streaming'); }
                switch (ev.type) {
                  case 'text':
                    text += ev.text;
                    store.updateMessage(assistantMsg.id, { text });
                    emit('onDelta', assistantMsg, text);
                    break;
                  case 'reasoning':
                    // Off 后模型仍可能自己吐 reasoning_content；不入库、不画「思考过程」
                    if (!turn.thinking) break;
                    if (!reasonT0) reasonT0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                    reasoning += ev.text;
                    tb.delta(ev.index, ev.text);
                    store.updateMessage(assistantMsg.id, { reasoning });
                    emit('onReasoning', assistantMsg, reasoning);
                    break;
                  case 'block_start':
                    if (turn.thinking && ev.block && (ev.block.type === 'thinking' || ev.block.type === 'redacted_thinking')) tb.start(ev.index, ev.block);
                    break;
                  case 'signature_delta':
                    tb.signature(ev.index, ev.signature);
                    break;
                  case 'tool_delta': {
                    acc.push(ev);
                    sawToolDelta = true;
                    // 流式期间把半成品 toolCalls 推到界面（节流约一帧），不能只写 store 不 emit
                    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                    if (now - lastChipPaint > 50) {
                      lastChipPaint = now;
                      store.updateMessage(assistantMsg.id, { toolCalls: acc.result() });
                      emit('onToolDelta', assistantMsg);
                    }
                    break;
                  }
                  case 'web_search': {
                    // 联网进度/来源：并进消息（重开会话后引用还在），同时通知 UI 画状态
                    const prev = web || { status: 'idle', sources: [], results: 0, queries: [] };
                    const mergeSources = (rows) => (rows && rows.length)
                      ? [...new Map([...prev.sources, ...rows].map((x) => [x.url, x])).values()]
                      : prev.sources;
                    if (ev.status === 'searching') web = { ...prev, status: 'searching', name: ev.name || prev.name };
                    else if (ev.status === 'done') web = { ...prev, status: 'done',
                      results: ev.results != null ? ev.results : prev.results,
                      queries: (ev.queries && ev.queries.length) ? [...new Set([...prev.queries, ...ev.queries])] : prev.queries,
                      sources: mergeSources(ev.sources) };
                    else if (ev.status === 'sources') web = { ...prev, sources: mergeSources(ev.sources) };
                    // 查询词：Claude 走 server_tool_use 的 input_json_delta 分片到达，凑齐才发过来
                    else if (ev.status === 'query' && ev.query) web = { ...prev, queries: [...new Set([...prev.queries, String(ev.query)])] };
                    else if (ev.status === 'error') web = { ...prev, status: 'error', message: ev.message };
                    store.updateMessage(assistantMsg.id, { webSearch: web });
                    emit('onWebSearch', assistantMsg, web);
                    break;
                  }
                  case 'usage':
                    // Anthropic 分两段上报（message_start: input；message_delta: output 累计值），取最新即可
                    if (ev.usage.input != null) usage.input = ev.usage.input;
                    if (ev.usage.output != null) usage.output = ev.usage.output;
                    if (ev.usage.reasoning != null) usage.reasoning = ev.usage.reasoning;
                    break;
                  case 'finish':
                    finishReason = ev.reason;
                    break;
                  case 'error':
                    throw new Error(ev.message);
                  default: break;
                }
              },
            });
        let attempt = 0;
        while (true) {
          try {
            await pull();
            break; // 流正常结束
          } catch (err) {
            const transient = err.status === undefined || err.status >= 500 || err.status === 429;
            if (attempt === 0 && !text && !sawToolDelta && transient && !signal.aborted && err.name !== 'AbortError') {
              attempt++;
              tb = createThinkingTracker(); // 重放前清空可能收到的半个思考块
              reasoning = ''; // 思考流先于正文到达，重放时同样不能叠加
              store.updateMessage(assistantMsg.id, { reasoning: undefined });
              await sleep(1200);
              continue; // 尚未收到任何内容 → 安全重放整次调用
            }
            throw err;
          }
        }

        let lengthContinues = 0;
        while (
          !acc.result().length
          && /^(length|max_tokens|max_output_tokens)$/i.test(String(finishReason || ''))
          && lengthContinues < 2
          && text
          && !signal.aborted
        ) {
          lengthContinues++;
          const cont = store.pushMessage({
            role: 'user',
            text: '请从截断处接着写完，不要重复已经输出的内容。',
            silent: true,
          });
          finishReason = null;
          try { await pull(); } catch { break; }
          const ix = store.state.messages.findIndex((m) => m.id === cont.id);
          if (ix >= 0) store.state.messages.splice(ix, 1);
        }

        const toolCalls = acc.result();
        const thinkingBlocks = turn.thinking ? tb.blocks() : [];
        const nowT = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        telemetry.recordUsage({ input_tokens: usage.input, output_tokens: usage.output });
        store.updateMessage(assistantMsg.id, {
          text,
          reasoning: turn.thinking && reasoning ? reasoning : undefined,
          toolCalls: toolCalls.length ? toolCalls : undefined,
          // 思考块（含 signature）随消息持久化：下一轮请求需原样回传（P0-2）
          thinkingBlocks: thinkingBlocks.length ? thinkingBlocks : undefined,
          reasoningMs: turn.thinking && reasonT0 ? Math.round(nowT - reasonT0) : undefined,
          reasoningLevel: turn.thinking ? (turn.reasoningLevel || 'medium') : 'off',
          durationMs: Math.round(nowT - streamT0),
          usage: usage.input != null || usage.output != null || usage.reasoning != null ? { ...usage } : undefined,
          jevUsage: iterations === 1 && turnPlan && turnPlan.usage ? { ...turnPlan.usage } : undefined,
          fastMode: !!settings.fastMode,
          thoughtHidden: !!(turn.thinking && !reasoning && (thinkingBlocks.length || usage.reasoning)),
          // 自学标记：该模型真实出现过「有思考但无可见正文」→ 模型菜单标「思考链已加密」
          ...(!!(turn.thinking && !reasoning && (thinkingBlocks.length || usage.reasoning)) ? (() => { try { store.state.observedHiddenThink = { ...(store.state.observedHiddenThink || {}), [model]: true }; } catch { /* 忽略 */ } return {}; })() : {}),
          finishReason, done: true, lengthContinues: lengthContinues || undefined, transport: getTransport(),
          webSearch: web && (web.sources.length || web.results) ? web : undefined,
          nexusFootprint: nexusState.lastFootprint ? { ...nexusState.lastFootprint, usedTools: [...new Set(usedTools)] } : undefined,
        });
        emit('onAssistantDone', assistantMsg);

        // ── 无工具调用 → 回合结束（执行内核：回答 → 核验 → 提交）──
        if (!toolCalls.length) {
          const fin = finalizeExecutionTurn({
            machine: exec.machine,
            toolRuns: exec.machine.toolRuns,
            answerText: text,
            budget: exec.budgetGov,
            auditDigest: exec.machine.audit.digest,
          });
          exec.silentFailure = fin.silentFailure;
          exec.finalized = true;
          if (fin.disclosure) {
            // 工具失败但回答未披露 → 由内核补一条披露（界面与后续上下文都能看到）
            text = fin.finalText;
            store.updateMessage(assistantMsg.id, { text });
          }
          exec.record = summarizeExecutionRecord({
            machine: exec.machine, budget: exec.budgetGov,
            toolRuns: exec.machine.toolRuns, silentFailure: fin.silentFailure,
          });
          store.updateMessage(assistantMsg.id, {
            execution: {
              state: exec.record.state,
              kernelVersion: exec.record.kernelVersion,
              policyVersion: exec.record.policyVersion,
              toolCalls: exec.record.toolCallCount,
              failed: exec.record.failedCount,
              blocked: exec.record.blockedCount,
              retries: exec.record.retryCount,
              riskLevels: exec.record.riskCounts,
              silentFailure: exec.record.silentFailure,
              auditDigest: exec.record.auditDigest,
            },
          });
          setStatus('done');
          exec.recordEmitted = true;
          emit('onExecutionRecord', exec.record);
          emit('onTurnEnd');
          return;
        }

        // ── 执行工具，结果写回对话（模型侧截断保护，UI 侧全量展示）──
        setStatus('executing');
        const toolWaveT0 = Date.now();
        const results = await runToolCalls(toolCalls, turn, exec);
        const waveMs = Math.max(1, Date.now() - toolWaveT0);
        store.updateMessage(assistantMsg.id, { toolCalls: toolCalls.map((c) => ({ ...c })) });
        let roundHasError = false;
        for (const [i, call] of toolCalls.entries()) {
          const result = results[i];
          usedTools.push(call.name);
          const isErr = typeof result === 'string' && /(失败|报错|错误|参数不是合法 JSON|未执行|拒绝执行)/.test(result.slice(0, 120));
          if (isErr) { hadToolError = true; roundHasError = true; }
          stepHistory.push({ name: call.name, args: call.args, isError: isErr });
          const engine = call.name === 'execute_python'
            ? 'pyodide-wasm'
            : call.name === 'execute_javascript'
              ? 'worker-8ms'
              : (call.name === 'dispatch_subagent' || call.name === 'generate_image' || call.name === 'analyze_image')
                ? 'gateway-api'
                : 'browser-0ms';
          telemetry.recordTool(call.name, Math.round(waveMs / Math.max(1, toolCalls.length)), { engine, ok: !isErr });
          syncFS();
          store.pushMessage({ role: 'tool', toolCallId: call.id, name: call.name, content: result });
          emit('onToolResult', call, result);
        }
        telemetry.subagentDispatches = turn.subagentReports.length;
        lastStepFailed = roundHasError;
        taskLedger.advance(iterations + 1, toolCalls.map((c) => c.name), roundHasError);
      }
      // 达到迭代上限
      if (TOOL_LOOP_MAX > 0) {
        store.pushMessage({ role: 'assistant', text: `⚠️ 已达到工具调用上限（${TOOL_LOOP_MAX} 次迭代），本轮停止。可以让我继续，或调整任务。`, model, done: true });
      }
      setStatus('done');
      emit('onTurnEnd');
    } catch (err) {
      if (err.name === 'AbortError' || signal.aborted) {
        setStatus('cancelled');
        // 中断是显式状态：不留「工具还在跑」的模糊态，刷新后据此判断可续跑阶段
        exec.machine.transition(EXECUTION_STATES.INTERRUPTED, '用户中止（Abort）', { phase: exec.machine.state });
        const last = [...store.state.messages].reverse().find((m) => m.role === 'assistant' && !m.done);
        if (last) store.updateMessage(last.id, { cancelled: true, done: true });
        emit('onCancelled');
      } else {
        setStatus('error');
        exec.machine.transition(EXECUTION_STATES.INTERRUPTED, `执行出错：${String((err && err.message) || err).slice(0, 80)}`, { phase: exec.machine.state });
        emit('onError', err);
      }
    } finally {
      abortController = null;
      // 只在正常结束时蒸馏技能并自动捕获显式长期记忆点
      if (status === 'done') {
        const lastUser = [...store.state.messages].reverse().find((m) => m.role === 'user');
        const autoFacts = extractAutoMemoryFacts(lastUser && lastUser.text);
        if (autoFacts.length) {
          store.state.memory = upsertFacts(store.state.memory, autoFacts);
        }
        const rawLearned = distillSkill({
          userText: lastUser && lastUser.text,
          toolNames: usedTools,
          iterations,
          unrecoveredError: hadToolError && lastStepFailed,
        });
        if (rawLearned) {
          const learned = refineSkillWithTelemetry(rawLearned, {
            toolSequence: usedTools,
            hadErrors: hadToolError,
            recovered: hadToolError && !lastStepFailed,
            durationMs: Math.round(performance.now() - t0),
          });
          store.state.learnedSkills = rememberSkill(store.state.learnedSkills, learned);
        }
      }
      telemetry.activeMemoryCount = Array.isArray(store.state.memory) ? store.state.memory.length : 0;

      // ── P0 执行内核收尾：状态轨迹 / 预算账本 / 审计摘要落盘（刷新后可判断任务处于哪个阶段）──
      if (!exec.machine.isTerminal) {
        exec.machine.transition(EXECUTION_STATES.INTERRUPTED,
          status === 'cancelled' ? '回合被中止，未提交' : (status === 'error' ? '回合异常退出，未提交' : '回合未走到提交（迭代上限或提前返回）'));
      }
      if (!exec.record) {
        exec.record = summarizeExecutionRecord({
          machine: exec.machine, budget: exec.budgetGov,
          toolRuns: exec.machine.toolRuns, silentFailure: exec.silentFailure,
        });
      }
      exec.record.sessionId = sessionId;
      exec.record.resumeHint = resumeExecutionState({ ...exec.record, machine: exec.machine.snapshot() });
      store.state.lastExecutionRecord = {
        ...exec.record,
        transitions: (exec.record.transitions || []).slice(-24),
        toolRuns: (exec.record.toolRuns || []).slice(-12),
        resumeHintConsumed: false,
      };
      store.state.lastExecutionAcceptance = evaluateExecutionKernelAcceptance({ toolNames: exec.toolList.map((t) => t.name) });
      if (nexusState.lastFootprint) {
        // 足迹绑定执行内核摘要：工具名/顺序之外，还能核到状态轨迹与审计摘要
        nexusState.lastFootprint.executionDigest = exec.record.auditDigest;
        nexusState.lastFootprint.executionState = exec.record.state;
        nexusState.lastFootprint.executionToolCalls = exec.record.toolCallCount;
      }
      if (!exec.recordEmitted) { exec.recordEmitted = true; emit('onExecutionRecord', exec.record); }

      store.state.lastNexusTelemetry = {
        ...telemetry.finish(),
        execution: {
          kernelVersion: exec.record.kernelVersion,
          policyVersion: exec.record.policyVersion,
          state: exec.record.state,
          phaseLabel: exec.record.phaseLabel,
          toolCalls: exec.record.toolCallCount,
          failed: exec.record.failedCount,
          blocked: exec.record.blockedCount,
          retries: exec.record.retryCount,
          uncertain: exec.record.uncertainCount,
          riskCounts: exec.record.riskCounts,
          silentFailure: exec.record.silentFailure,
          auditDigest: exec.record.auditDigest,
          violations: (exec.record.violations || []).length,
          budget: exec.record.budget,
        },
      };
      recordRouteLatencySample({
        fastPath: !!(nexusState.profile && nexusState.profile.fastPath),
        totalMs: telemetry.totalDurationMs,
        probeOverheadMs: 0,
      });
      if (nexusState.lastFootprint) {
        const lastAssistant = [...store.state.messages].reverse().find((m) => m.role === 'assistant');
        nexusState.lastFootprint.storeAudit = auditFootprintAgainstStore(nexusState.lastFootprint, {
          assistantMsg: lastAssistant && lastAssistant.toolCalls ? lastAssistant : null,
        });
      }
      store.state.lastNexusScorecard = evaluateNexusAcceptanceMetrics({
        memory: store.state.memory,
        memoryArchive: store.state.memoryArchive || [],
        telemetry,
        footprint: nexusState.lastFootprint,
      });
      syncFS();
      store.notify();
      emit('onTurnTiming', Math.round(performance.now() - t0)); // emit 内部已吞掉视图层异常
    }
  }

  async function runContentModeration(userText, attachments) {
    // 默认由 main.js 为正式应用打开；测试/嵌入方未显式开启时不额外加载模型。
    if (store.state.settings.contentModeration !== true) return { blocked: false, skipped: 'disabled' };
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    abortController = ctrl;
    setStatus('moderating');
    try {
      const apiKey = effectiveApiKey(store.state.apiKey);
      return await moderateUserTurn({ text: userText, attachments, apiKey, signal: ctrl ? ctrl.signal : undefined });
    } catch (err) {
      if (err && (err.name === 'AbortError' || (ctrl && ctrl.signal && ctrl.signal.aborted))) throw err;
      const reason = err && err.name === 'ModerationTimeoutError' ? '总预算超时' : '审核异常';
      const imgTurn = Array.isArray(attachments) && attachments.some((a) => a && a.kind === 'image');
      if (typeof globalThis !== 'undefined' && globalThis.__teamoModPush) globalThis.__teamoModPush({ stage: imgTurn ? 'turn:fail-closed' : 'turn:fail-open', reason, error: String(err && err.message || err).slice(0, 220) });
      if (imgTurn) {
        // 带图回合 fail-closed：审核没跑完就不放行，图片绝不进沙箱（模型在后台继续预热，用户可重试）
        console.warn(`[TeamoAgent] 图片审核${reason}，已 fail-closed 拦截本轮`, err);
        emit('onModerationFailClosed', reason);
        return { blocked: true, timeout: true, image: { blocked: true, timeout: true, reason } };
      }
      console.warn(`[TeamoAgent] 内容审核${reason}，已 fail-open 放行本轮（纯文本，规则层已兜底）`, err);
      emit('onModerationFailOpen', reason);
      return { blocked: false, error: err && err.message ? err.message : String(err) };
    } finally {
      if (abortController === ctrl) abortController = null;
      if (status === 'moderating') setStatus('idle');
    }
  }

  function clearTransientModeration() {
    const before = store.state.messages.length;
    store.state.messages = store.state.messages.filter((m) => !m.transientModeration);
    const removed = before - store.state.messages.length;
    if (removed > 0) { store.notify(); emit('onModerationCleared', removed); }
    return removed;
  }

  function removePreviewTurn(userMsg, checkpoint) {
    let changed = false;
    if (userMsg && userMsg.id) {
      const before = store.state.messages.length;
      store.state.messages = store.state.messages.filter((m) => m.id !== userMsg.id);
      changed = changed || before !== store.state.messages.length;
    }
    if (checkpoint && checkpoint.id && Array.isArray(store.state.checkpoints)) {
      const before = store.state.checkpoints.length;
      store.state.checkpoints = store.state.checkpoints.filter((c) => c.id !== checkpoint.id);
      changed = changed || before !== store.state.checkpoints.length;
    }
    if (changed) { store.notify(); emit('onModerationCleared', 1); }
  }

  function blockByModeration(result) {
    setStatus('cancelled');
    const timedOut = !!(result && result.image && result.image.timeout);
    const assistantMsg = store.pushMessage({
      role: 'assistant',
      text: timedOut
        ? '⚠ 图片审核超时（模型资源下载过慢或不可达），本轮已阻止，图片未进沙箱。模型正在后台继续预热，请稍后重发。'
        : '该内容已被审核',
      model: 'Moderator',
      done: true,
      transientModeration: true,
      moderation: { blocked: true, text: result && result.text, image: result && result.image },
    });
    emit('onAssistantStart', assistantMsg);
    emit('onAssistantDone', assistantMsg);
    emit('onModerationBlocked', assistantMsg, result);
    store.notify();
  }

  return {
    getStatus: () => status,
    abort: () => {
      const ctrl = abortController;
      if (ctrl) ctrl.abort();
      if (status === 'moderating') setStatus('cancelled');
    },

    async send(userText, attachments = []) {
      clearTransientModeration();
      // 先把发送气泡画出来，再进入本地审核状态；审核通过前它是 transient，
      // 不进模型上下文，也不会把图片写入沙箱。
      const checkpoint = store.createCheckpoint(userText || (attachments[0] ? `[附件] ${attachments[0].name}` : ''));
      const userMsg = store.pushMessage({
        role: 'user', text: userText,
        attachments: attachments.length ? attachments : undefined,
        transientModeration: true,
        moderationPending: true,
      });
      emit('onUserMessage', userText, userMsg);
      try {
        const moderation = await runContentModeration(userText, attachments);
        if (moderation && moderation.blocked) { removePreviewTurn(userMsg, checkpoint); blockByModeration(moderation); return; }
      } catch (err) {
        if (err && err.name === 'AbortError') { removePreviewTurn(userMsg, checkpoint); setStatus('cancelled'); emit('onCancelled'); return; }
        console.warn('[TeamoAgent] 内容审核异常，已 fail-open 放行本轮', err);
      }
      store.updateMessage(userMsg.id, { transientModeration: false, moderationPending: false });
      const copied = copyAttachmentsToFS(fs, attachments);
      if (copied.length) { syncFS(); store.notify(); emit('onFsChange', copied); }
      await runLoop();
    },

    async regenerate() {
      store.dropLastAssistantTurn();
      await runLoop();
    },

    // 会话切换后重载虚拟文件系统
    loadFiles(obj) {
      fs.clear();
      fs.import(obj || {});
      syncFS();
    },

    fs,
  };
}