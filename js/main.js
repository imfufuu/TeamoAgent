// ─── 启动引导 ──────────────────────────────────────────────────────────
import { createStore } from './state.js';
import { createAgent } from './agent.js';
import { mountUI, toast } from './ui.js';

const store = createStore();

// UI 先挂载（agent hooks 需要引用 ui 方法），再创建 agent 注入 hooks
let ui = null;
const hooks = {
  onStatus: (s) => ui && ui.setStatus(s),
  onUserMessage: (text, msg) => { ui && ui.onUserMessage(msg); ui && ui.renderSessions(); ui && ui.renderFiles(); ui && ui.updateStats(); ui && ui.scrollToBottom(); },
  onFsChange: (paths) => ui && ui.onFsChange && ui.onFsChange(paths),
  onAssistantStart: (m) => ui && ui.onAssistantStart(m),
  onDelta: (m, text) => ui && ui.onDelta(m, text),
  onAssistantDone: (m) => ui && ui.onAssistantDone(m),
  onToolStart: (call) => ui && ui.onToolStart(call),
  onToolResult: (call, result) => ui && ui.onToolResult(call, result),
  onToolEvent: (call, patch) => ui && ui.onToolEvent(call, patch),
  onTurnEnd: () => {
    ui && ui.renderFiles(); ui && ui.renderSessions(); ui && ui.updateStats();
    // 回合结束后让 Agent 给这次会话起个标题（用户手改过的不会被覆盖；失败静默退回兜底标题）
    ui && ui.autoTitle && ui.autoTitle();
  },
  onThinkingFallback: (model) => toast(`${model} 不支持思考参数，本次会话已为其自动关闭思考模式`, 'warn', 5200),
  // 联网：搜索由模型服务端完成（原生请求格式），这里只把进度/来源转给 UI 画引用条；
  // 网关或模型拒收该字段时说明原因（UI 会同时把 pill 的说明刷新成「当前不联网」）
  onWebSearch: (m, web) => ui && ui.onWebSearch && ui.onWebSearch(m, web),
  onWebFallback: (model, why) => {
    toast(`联网已自动关闭：${String(why || '').slice(0, 140)}`, 'warn', 7000);
    ui && ui.onWebFallback && ui.onWebFallback(model, why);
  },
  onTurnTiming: (ms) => ui && ui.onTurnTiming(ms),
  onCancelled: () => { toast('已停止生成', 'warn'); ui && ui.updateStats(); },
  onError: (err) => {
    console.error(err);
    const last = [...store.state.messages].reverse().find((m) => m.role === 'assistant' && !m.done);
    if (last) store.updateMessage(last.id, { error: err.message, done: true });
    else store.pushMessage({ role: 'assistant', text: '', error: err.message, done: true });
    toast(err.message.slice(0, 120), 'err', 5000);
    ui && ui.onAssistantDone(last || store.state.messages[store.state.messages.length - 1]);
    ui && ui.updateStats();
  },
  onNeedKey: () => { window.openKeyModal && window.openKeyModal(); toast('请先配置 API Key', 'warn'); },
};

const agent = createAgent(store, hooks);
ui = mountUI(store, agent);
// 这里不再 fs.import(state.files)：createAgent 已经用同一份 state.files 建好了 fs，
// 再 import 一次不仅多余，还会把「挂载期间被清空的文件」重新灌回去（clearFiles 走的是
// 同一批同步路径），表现为清空后文件又出现。

// 关闭/隐藏页面时同步落盘（防抖版 save 的定时器在卸载时不会触发，会丢最后一轮对话）
window.addEventListener('beforeunload', () => store.save(true));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') store.save(true);
});
console.log('%c◐ TeamoAgent', 'font-weight:800;font-size:16px', '· TeamoRouter Gateway');
