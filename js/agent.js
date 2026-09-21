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
export async function runSubagent(def, task, { apiKey, model, thinking, sandboxEnabled, fs, signal, onThinkingFallback }) {
  const subTools = sandboxEnabled && def.tools.length
    ? TOOL_DEFS.filter((t) => def.tools.includes(t.name) && t.name !== 'dispatch_subagent')
    : null;
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
      const res = await executeTool(c.name, c.args, { fs, onUi: () => {}, apiKey, imageModel: null, signal });
      messages.push({ role: 'tool', toolCallId: c.id, name: c.name, content: truncateToolContent(res, 4000) });
    }
  }
  return finalText || '（子智能体未产生最终报告）';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  function buildMessages() {
    const { messages, model } = store.state;
    const budget = contextBudgetFor(model);
    const { messages: compacted, droppedCount } = compactMessages(messages, budget);
    const sys = [{ role: 'system', text: systemPrompt() + fsNote() + (store.state.settings.sandboxEnabled ? subagentGuide() : '') }];
    if (droppedCount) sys.push({ role: 'system', text: `（上下文管理：为适配 ${model} 的窗口预算，已省略最早 ${droppedCount} 条消息）` });
    return [...sys, ...compacted];
  }

  function fsNote() {
    const list = fs.list();
    if (!list.length) return '';
    return `\n\n## 当前沙箱文件\n${list.slice(0, 40).map((f) => `- ${f.path} (${f.size}B)`).join('\n')}${list.length > 40 ? `\n…等共 ${list.length} 个` : ''}`;
  }

  async function runLoop({ regenerate = false } = {}) {
    const { apiKey, model, settings } = store.state;
    if (!apiKey) { emit('onNeedKey'); return; }
    if (status === 'connecting' || status === 'streaming' || status === 'thinking' || status === 'executing') return;

    const t0 = performance.now(); // 整轮计时：思考 + 生成 + 沙箱执行
    abortController = new AbortController();
    const signal = abortController.signal;
    const tools = settings.sandboxEnabled ? TOOL_DEFS : null;
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
              messages: buildMessages(),
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
        });
        emit('onAssistantDone', assistantMsg);

        // ── 无工具调用 → 回合结束 ──
        if (!toolCalls.length) { setStatus('done'); emit('onTurnEnd'); return; }

        // ── 执行工具，结果写回对话（模型侧截断保护，UI 侧全量展示）──
        setStatus('executing');
        for (const call of toolCalls) {
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
          emit('onToolStart', call);
          let result;
          if (call.args && typeof call.args === 'object' && '__raw' in call.args) {
            // 参数 JSON 解析失败 → 不执行，反馈模型自行纠错（成熟的工具循环必备）
            result = `工具参数不是合法 JSON，原始内容：${String(call.args.__raw).slice(0, 500)}。请修正参数后重新调用。`;
            emit('onToolEvent', call, { status: 'error', note: '参数解析失败' });
          } else {
            result = await executeTool(call.name, call.args, {
              fs,
              apiKey: store.state.apiKey,
              imageModel: store.state.imageModel || DEFAULT_IMAGE_MODEL,
              signal,
              onUi: (patch) => emit('onToolEvent', call, patch),
              dispatch: async (agentId, subTask, onNote) => {
                const def = findSubagent(agentId);
                if (!def) return `未知子智能体：${agentId}。请用 enum 中列出的 ID。`;
                onNote && onNote(`子智能体「${def.name}」思考中…`);
                const report = await runSubagent(def, subTask, {
                  apiKey: store.state.apiKey,
                  model: store.state.model,
                  thinking: store.state.settings.thinking !== false,
                  sandboxEnabled: store.state.settings.sandboxEnabled,
                  onThinkingFallback: (m) => emit('onThinkingFallback', m),
                  fs, signal,
                });
                return `[子智能体报告 · ${def.name}（${def.tag}）]\n${report}`;
              },
            });
          }
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
      await runLoop({ regenerate: true });
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
