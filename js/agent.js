// ─── Agent 核心：工具调用循环（ReAct 式状态机）────────────────────────
// idle → thinking → streaming → tool_executing → (loop) → done / error / cancelled
//
// 架构要点：
//   · 上下文管理：按模型预算压缩历史（整轮丢弃，绝不产生孤儿 tool 消息）
//   · 健壮性：HTTP 层与流层双重重试；工具参数 JSON 解析失败自动反馈纠错
//   · 可观测：usage 归一、传输通道标记、工具结果截断保护上下文
//   · 附件：全部附件（文本 + 图片）自动复制到沙箱 uploads/，图片另走多模态协议块
//   · 生图：不作为对话模型直接调用，统一由主智能体经 generate_image 工具发起

import { streamChat, createToolCallAccumulator, createThinkingTracker, getTransport } from './api.js';
import { TOOL_DEFS, executeTool } from './tools.js';
import { createFS } from './sandbox.js';
import { compactMessages, contextBudgetFor, truncateToolContent } from './context.js';
import { findSubagent, subagentGuide } from './subagents.js';
import { TOOL_LOOP_MAX, SUBAGENT_LOOP_MAX, systemPrompt, OUTPUT_SPEC, DEFAULT_IMAGE_MODEL } from './config.js';

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
const RELAY_ONLY_TOOLS = new Set(['fetch_url', 'run_git']);
const RELAY_OFF_NOTE = '\n\n【工具可用性】本环境没有本地中继（server.py 未运行），因此 fetch_url 与 run_git '
  + '本轮不在工具表里。要查资料就用上面说的「服务器网页搜索工具」，不要试图用其它办法抓网页，也不要因此说不能联网。';

// 附件落盘文件名：去掉路径分隔与控制字符，避免越权写到 uploads/ 之外
const safeName = (n) => String(n || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 120) || 'file';

// 用户附件 → 沙箱 uploads/（文本写原文，图片写 data URL 以便编辑/打包下载）
// 同名且内容相同则复用路径；内容不同则追加序号，避免覆盖上一轮上传
export function copyAttachmentsToFS(fs, attachments = []) {
  const written = [];
  const taken = new Set(fs.list().map((f) => f.path));
  for (const a of attachments || []) {
    const content = a.kind === 'image' ? a.dataUrl : a.text;
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

export async function runSubagent(def, task, { apiKey, model, thinking, sandboxEnabled, webEnabled, fs, signal, onThinkingFallback, onWebFallback, imageModel }) {
  const subTools = subagentTools(sandboxEnabled, def);
  const messages = [
    { role: 'system', text: `${def.prompt}\n\n你是 TeamoAgent 体系中的「${def.name}」子智能体。直接产出最终报告，不要寒暄。当前时间：${new Date().toISOString()}\n\n${OUTPUT_SPEC}` },
    { role: 'user', text: task },
  ];
  let finalText = '';
  for (let i = 0; i < SUBAGENT_LOOP_MAX; i++) {
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const acc = createToolCallAccumulator();
    const tb = createThinkingTracker(); // 思考块需随 tool_use 回合回传，否则下一轮 400
    let text = '';
    await streamChat({
      model, apiKey, thinking, signal, tools: subTools,
      onThinkingFallback,
      webEnabled: !!webEnabled, onWebFallback,
      messages,
      onEvent: (ev) => {
        if (ev.type === 'text') text += ev.text;
        else if (ev.type === 'reasoning') tb.delta(ev.index, ev.text);
        else if (ev.type === 'block_start' && ev.block && (ev.block.type === 'thinking' || ev.block.type === 'redacted_thinking')) tb.start(ev.index, ev.block);
        else if (ev.type === 'signature_delta') tb.signature(ev.index, ev.signature);
        else if (ev.type === 'tool_delta') acc.push(ev);
        else if (ev.type === 'error') throw new Error(ev.message);
      },
    });
    finalText = text;
    const calls = acc.result();
    if (!calls.length) break;
    const blocks = tb.blocks();
    messages.push({ role: 'assistant', text, toolCalls: calls, ...(blocks.length ? { thinkingBlocks: blocks } : {}) });
    for (const c of calls) {
      // imageModel 要透传：否则子智能体出图会绕开用户在模型菜单里选定的生图模型
      const res = await executeTool(c.name, c.args, { fs, onUi: () => {}, apiKey, imageModel: imageModel || null, sandboxEnabled, signal });
      // 中继工具真跑通了 → 记下「本会话中继可用」，后续回合把 fetch_url / run_git 放回工具表
      if (RELAY_ONLY_TOOLS.has(c.name) && res && res.ok) store.state.relayOk = true;
      messages.push({ role: 'tool', toolCallId: c.id, name: c.name, content: truncateToolContent(res, 4000) });
    }
  }
  return finalText || '（子智能体未产生最终报告）';
}

// 联网开关的提示词：联网用的是模型 API 自带的网页搜索请求格式，所以这里不挂我们自己的搜索工具，
// 只告诉模型「能力从哪来」。文本放在本模块内而不是给 config.js 新增具名导出再 import —— 那会在
// 「新 agent.js + 旧 config.js」的混版缓存下触发 ESM link 错误（整页白屏），历史上真踩过。
const WEB_ON_NOTE = '\n\n【联网】本轮已按当前模型的原生格式开启服务端网页搜索'
  + '（Claude：/v1/messages 的 tools:[{type:"web_search_20250305"}]；GPT：/v1/responses 的 tools:[{type:"web_search"}]；'
  + '其它厂商经实测没有可用的原生格式，本轮不联网）。搜索由模型服务端自己完成，结果带引用回流进本轮上下文：'
  + '遇到「最新/当下/版本号/今天/价格/汇率/近期」这类光靠权重参数答不了的问题就直接联网，不必等用户点名；'
  + '回答里给出来源链接。要抓某个具体网页的正文用 fetch_url（走本地中继，没开中继时它会直接失败），需要 git 用 run_git。\n'
  + '\n【优先用它】要联网查资料时，直接用本轮已开启的服务器网页搜索工具，不要拿 fetch_url 去代替：'
  + 'fetch_url 需要本地中继（网页版没有中继时必然失败），服务器搜索不需要任何本地依赖。'
  + '\n【硬性要求】只有当你这一轮**真的**调用了网页搜索工具、并拿到结果时，才可以说「已联网查询 / 搜索到」；'
  + '没有拿到检索结果时，绝不允许用「我已经联网搜索了」这类说法给记忆里的数字背书 —— 那样用户会当真。'
  + '这种情况请直说「本轮没能取得检索结果」，并说明数字仅供记忆参考或建议用户手动核实。';
const WEB_OFF_NOTE = '\n\n【联网】本轮未联网（本项目不接任何第三方搜索接口）。不要声称自己能查实时信息：'
  + '涉及时效性问题就直说「当前未联网，无法核实」，或建议用户打开顶栏的「联网」开关；'
  + '确定的知识可以直接答，但别把记忆包装成「刚查到的」。';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 一次委派最多并发几个子智能体（再高就是自己跟自己抢网关并发额度了）
const DISPATCH_CONCURRENCY = 3;

export function createAgent(store, hooks = {}) {
  const fs = createFS(store.state.files);
  let abortController = null;
  let status = 'idle'; // idle | thinking | streaming | executing | done | error | cancelled

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
  function buildMessages(lockModel, relayOk = true) {
    const { messages } = store.state;
    const model = lockModel || store.state.model;
    const budget = contextBudgetFor(model);
    const { messages: compacted, droppedCount } = compactMessages(messages, budget);
    // subagentGuide 无条件注入：委派子智能体不依赖代码沙箱开关（开关只决定子智能体
    // 自己能用的工具集合），旧写法把整段名录藏在开关后面，关掉沙箱就等于没有子智能体。
    const sys = [{ role: 'system', text: systemPrompt(new Date(), { webEnabled: store.state.settings.webEnabled !== false }) + fsNote()
      + (store.state.settings.webEnabled !== false ? WEB_ON_NOTE : WEB_OFF_NOTE)
      + (relayOk ? '' : RELAY_OFF_NOTE) + subagentGuide() }];
    if (droppedCount) sys.push({ role: 'system', text: `（上下文管理：为适配 ${model} 的窗口预算，已省略最早 ${droppedCount} 条消息）` });
    return [...sys, ...compacted];
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
      apiKey: turn.apiKey,
      imageModel: turn.imageModel,
      sandboxEnabled: turn.sandboxEnabled,
      signal: turn.signal,
      onUi: (patch) => emit('onToolEvent', call, patch),
      dispatch: async (agentId, subTask, onNote) => {
        const def = findSubagent(agentId);
        if (!def) return `未知子智能体：${agentId}。请用 enum 中列出的 ID。`;
        onNote && onNote(`子智能体「${def.name}」思考中…`);
        const report = await runSubagent(def, subTask, {
          apiKey: turn.apiKey,
          model: turn.model,
          thinking: turn.thinking,
          sandboxEnabled: turn.sandboxEnabled,
          webEnabled: turn.webEnabled,
          imageModel: turn.imageModel,
          onThinkingFallback: (m) => emit('onThinkingFallback', m),
          onWebFallback: (m, why) => emit('onWebFallback', m, why),
          fs,
          signal: turn.signal,
        });
        return `[子智能体报告 · ${def.name}（${def.tag}）]\n${report}`;
      },
    };
  }

  const badArgs = (call) => !!(call.args && typeof call.args === 'object' && '__raw' in call.args);

  // 同一轮里的多个 dispatch_subagent 并发执行（子智能体上下文彼此不可见，天然独立），
  // 其余工具保持串行：沙箱代码会改虚拟文件，交错跑就说不清「基于哪一版文件」。
  // 结果仍按调用原顺序写回对话，两种协议的 tool_use/tool_result 配对都不受影响。
  async function runToolCalls(calls, turn) {
    const out = new Array(calls.length);
    const runOne = async (call) => {
      if (turn.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      emit('onToolStart', call);
      if (badArgs(call)) {
        // 参数 JSON 解析失败 → 不执行，反馈模型自行纠错（成熟的工具循环必备）
        emit('onToolEvent', call, { status: 'error', note: '参数解析失败' });
        return `工具参数不是合法 JSON，原始内容：${String(call.args.__raw).slice(0, 500)}。请修正参数后重新调用。`;
      }
      return executeTool(call.name, call.args, toolCtxFor(call, turn));
    };
    let i = 0;
    while (i < calls.length) {
      const delegating = calls[i].name === 'dispatch_subagent' && !badArgs(calls[i]);
      if (!delegating) { out[i] = await runOne(calls[i]); i++; continue; }
      let j = i;
      while (j < calls.length && calls[j].name === 'dispatch_subagent' && !badArgs(calls[j])) j++;
      for (let k = i; k < j; k += DISPATCH_CONCURRENCY) {
        const group = [];
        for (let n = k; n < Math.min(k + DISPATCH_CONCURRENCY, j); n++) group.push(n);
        const rs = await Promise.all(group.map((n) => runOne(calls[n])));
        group.forEach((n, m) => { out[n] = rs[m]; });
      }
      i = j;
    }
    return out;
  }

  async function runLoop() {
    // 整轮锁定 apiKey/model/settings：中途用户换模型不会让后续迭代与子智能体错位
    //（旧写法一处读 store.state、一处读快照，等于两个来源）
    const { apiKey, model, settings } = store.state;
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
    const tools = toolsFor(settings.sandboxEnabled).filter((t) => relayOk || !RELAY_ONLY_TOOLS.has(t.name));
    const turn = {
      apiKey, model, signal,
      thinking: settings.thinking !== false,
      sandboxEnabled: settings.sandboxEnabled,
      webEnabled: settings.webEnabled !== false, // 联网默认开（搜不搜由模型自己判断）
      imageModel: store.state.imageModel || DEFAULT_IMAGE_MODEL,
    };
    let iterations = 0;

    try {
      while (iterations < TOOL_LOOP_MAX) {
        iterations++;
        setStatus('thinking');

        // ── 一次 LLM 流式调用（流层早期失败自动重试一次）──
        const acc = createToolCallAccumulator();
        let tb = createThinkingTracker(); // Anthropic 思考块（含 signature），随消息持久化并在下一轮回传
        let text = '', reasoning = '';
        let sawToolDelta = false, lastChipPaint = 0;
        let web = null; // 服务端联网进度：{status, queries, sources, results}
        const usage = {};
        let finishReason = null;

        const assistantMsg = store.pushMessage({ role: 'assistant', text: '', model, usage: null });
        emit('onAssistantStart', assistantMsg);
        setStatus('connecting'); // 已发出请求、尚未收到首个 token：UI 显示连接动画
        let streamed = false;

        let attempt = 0;
        while (true) {
          try {
            await streamChat({
              model, apiKey, tools, signal,
              fastMode: settings.fastMode,
              thinking: settings.thinking !== false, // 思考模式默认开启（settings.thinking 未显式关闭即开）
              onThinkingFallback: (m) => emit('onThinkingFallback', m), // 思考参数 400 降级 → 提示用户（不再静默）
              webEnabled: turn.webEnabled, // 联网：注入模型 API 自带的网页搜索请求格式
              onWebFallback: (m, why) => emit('onWebFallback', m, why), // 被拒 → 剥掉字段重试并说明
              messages: buildMessages(model, relayOk),
              onEvent: (ev) => {
                if (!streamed) { streamed = true; setStatus('streaming'); }
                switch (ev.type) {
                  case 'text':
                    text += ev.text;
                    store.updateMessage(assistantMsg.id, { text });
                    emit('onDelta', assistantMsg, text);
                    break;
                  case 'reasoning':
                    reasoning += ev.text;
                    tb.delta(ev.index, ev.text);
                    store.updateMessage(assistantMsg.id, { reasoning });
                    emit('onReasoning', assistantMsg, reasoning);
                    break;
                  case 'block_start':
                    if (ev.block && (ev.block.type === 'thinking' || ev.block.type === 'redacted_thinking')) tb.start(ev.index, ev.block);
                    break;
                  case 'signature_delta':
                    tb.signature(ev.index, ev.signature);
                    break;
                  case 'tool_delta': {
                    acc.push(ev);
                    sawToolDelta = true;
                    // 流式期间增量刷新工具芯片（节流 300ms）
                    const now = performance.now();
                    if (now - lastChipPaint > 300) {
                      lastChipPaint = now;
                      store.updateMessage(assistantMsg.id, { toolCalls: acc.result() });
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

        const toolCalls = acc.result();
        const thinkingBlocks = tb.blocks();
        store.updateMessage(assistantMsg.id, {
          text, reasoning: reasoning || undefined, toolCalls: toolCalls.length ? toolCalls : undefined,
          // 思考块（含 signature）随消息持久化：下一轮请求需原样回传（P0-2）
          thinkingBlocks: thinkingBlocks.length ? thinkingBlocks : undefined,
          usage: usage.input != null || usage.output != null ? { ...usage } : undefined,
          finishReason, done: true, transport: getTransport(),
          webSearch: web && (web.sources.length || web.results) ? web : undefined,
        });
        emit('onAssistantDone', assistantMsg);

        // ── 无工具调用 → 回合结束 ──
        if (!toolCalls.length) { setStatus('done'); emit('onTurnEnd'); return; }

        // ── 执行工具，结果写回对话（模型侧截断保护，UI 侧全量展示）──
        setStatus('executing');
        const results = await runToolCalls(toolCalls, turn);
        for (const [i, call] of toolCalls.entries()) {
          const result = results[i];
          syncFS();
          store.pushMessage({ role: 'tool', toolCallId: call.id, name: call.name, content: truncateToolContent(result, 8000) });
          emit('onToolResult', call, result);
        }
      }
      // 达到迭代上限
      store.pushMessage({ role: 'assistant', text: `⚠️ 已达到工具调用上限（${TOOL_LOOP_MAX} 次迭代），本轮停止。可以让我继续，或调整任务。`, model, done: true });
      setStatus('done');
      emit('onTurnEnd');
    } catch (err) {
      if (err.name === 'AbortError' || signal.aborted) {
        setStatus('cancelled');
        const last = [...store.state.messages].reverse().find((m) => m.role === 'assistant' && !m.done);
        if (last) store.updateMessage(last.id, { cancelled: true, done: true });
        emit('onCancelled');
      } else {
        setStatus('error');
        emit('onError', err);
      }
    } finally {
      abortController = null;
      syncFS();
      store.notify();
      emit('onTurnTiming', Math.round(performance.now() - t0)); // emit 内部已吞掉视图层异常
    }
  }

  return {
    getStatus: () => status,
    abort: () => { abortController && abortController.abort(); },

    async send(userText, attachments = []) {
      // 所有附件（文本 + 图片）自动复制到沙箱 uploads/：文本存原文、图片存 data URL，
      // 工具循环可直接 read_file 读取，图片也能作为 generate_image 的 reference_paths 编辑
      const copied = copyAttachmentsToFS(fs, attachments);
      if (copied.length) { syncFS(); store.notify(); emit('onFsChange', copied); }
      store.createCheckpoint(userText || (attachments[0] ? `[附件] ${attachments[0].name}` : ''));
      const userMsg = store.pushMessage({ role: 'user', text: userText, attachments: attachments.length ? attachments : undefined });
      // 先让 UI 把用户这一条画出来（不能等 AI 输出完才看到自己的输入）
      emit('onUserMessage', userText, userMsg);
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
