// ─── 启动引导 ──────────────────────────────────────────────────────────
import { createStore } from './state.js';
import { createAgent } from './agent.js';
import { mountUI, toast } from './ui.js';

const store = createStore();

// UI 先挂载（agent hooks 需要引用 ui 方法），再创建 agent 注入 hooks
let ui = null;
const hooks = {
  onStatus: (s) => ui && ui.setStatus(s),
  onUserMessage: () => { ui && ui.renderCheckpoints(); ui && ui.renderFiles(); ui && ui.updateStats(); ui && ui.scrollToBottom(); },
  onAssistantStart: (m) => ui && ui.onAssistantStart(m),
  onDelta: (m, text) => ui && ui.onDelta(m, text),
  onAssistantDone: (m) => ui && ui.onAssistantDone(m),
  onToolStart: (call) => ui && ui.onToolStart(call),
  onToolResult: (call, result) => ui && ui.onToolResult(call, result),
  onToolEvent: (call, patch) => ui && ui.onToolEvent(call, patch),
  onTurnEnd: () => { ui && ui.renderFiles(); ui && ui.renderCheckpoints(); ui && ui.updateStats(); },
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

// 沙箱内 files 与 store 双向同步：state.files 作为持久化源
agent.fs.import(store.state.files);

window.addEventListener('beforeunload', () => store.save());
console.log('%c◐ TeamoAgent', 'font-weight:800;font-size:16px', '· TeamoRouter Gateway');
