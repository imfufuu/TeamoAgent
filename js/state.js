// ─── 会话状态：消息、检查点（回滚）、持久化 ────────────────────────────
import { STORAGE_KEY } from './config.js';

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

export function createStore(onChange) {
  const state = {
    apiKey: '',
    model: 'claude-sonnet-5',
    models: [],            // 从 /v1/models 拉取的实时列表（为空则用兜底表）
    messages: [],          // {id, role, text?, content?, toolCalls?, toolCallId?, usage?, error?, cancelled?, ts}
    checkpoints: [],       // {id, label, messageCount, ts}
    undoBranch: null,      // 回滚撤销栈（一步）：{checkpointId, discarded}
    files: {},             // 虚拟文件系统
    settings: { sandboxEnabled: true, fastMode: false, theme: 'light' },
  };

  let saveTimer = null;
  // 附件（尤其 base64 图片）可能超出 localStorage 配额：超限时剥离图片数据、截断文本
  const slimState = () => ({
    ...state,
    messages: state.messages.map((m) => m.attachments ? {
      ...m,
      attachments: m.attachments.map((a) => ({
        ...a,
        dataUrl: undefined,
        text: a.text != null ? String(a.text).slice(0, 1000) : undefined,
        stripped: true,
      })),
    } : m),
  });
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        let json = JSON.stringify(state);
        if (json.length > 4000000) json = JSON.stringify(slimState());
        localStorage.setItem(STORAGE_KEY, json);
      } catch {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(slimState())); } catch { /* 仍失败则放弃本次持久化 */ }
      }
    }, 300);
  };
  const notify = () => { save(); onChange && onChange(state); };

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) Object.assign(state, JSON.parse(raw));
  } catch { /* 损坏数据忽略 */ }

  return {
    state,
    notify,
    save,

    // ── 消息 ──
    pushMessage(msg) {
      const m = { id: uid(), ts: Date.now(), ...msg };
      state.messages.push(m);
      notify();
      return m;
    },
    updateMessage(id, patch) {
      const m = state.messages.find((x) => x.id === id);
      if (m) Object.assign(m, patch);
      notify();
      return m;
    },

    // ── 检查点 / 回滚 ──
    createCheckpoint(label) {
      const cp = { id: uid(), label: String(label || '').slice(0, 40), messageCount: state.messages.length, ts: Date.now() };
      state.checkpoints.push(cp);
      state.undoBranch = null;
      notify();
      return cp;
    },
    rollbackTo(checkpointId) {
      const idx = state.checkpoints.findIndex((c) => c.id === checkpointId);
      if (idx < 0) return false;
      const cp = state.checkpoints[idx];
      const discarded = state.messages.slice(cp.messageCount);
      state.undoBranch = { checkpointId, discarded };
      state.messages = state.messages.slice(0, cp.messageCount);
      state.checkpoints = state.checkpoints.slice(0, idx + 1);
      notify();
      return true;
    },
    // 回滚到某条消息所在轮次的起点（该 user 消息之前）
    rollbackBeforeMessage(messageId) {
      const idx = state.messages.findIndex((m) => m.id === messageId);
      if (idx < 0) return false;
      // 找到该消息之前（含自身）最近的 user 消息位置，再找对应检查点
      let userIdx = idx;
      while (userIdx >= 0 && state.messages[userIdx].role !== 'user') userIdx--;
      const targetCount = userIdx >= 0 ? userIdx : idx;
      const cpIdx = findCheckpointAt(state.checkpoints, targetCount);
      if (cpIdx >= 0) return this.rollbackTo(state.checkpoints[cpIdx].id);
      // 没有精确检查点时按消息数直接截断
      const discarded = state.messages.slice(targetCount);
      state.undoBranch = { checkpointId: null, discarded };
      state.messages = state.messages.slice(0, targetCount);
      notify();
      return true;
    },
    undoRollback() {
      if (!state.undoBranch) return false;
      state.messages = state.messages.concat(state.undoBranch.discarded);
      state.undoBranch = null;
      notify();
      return true;
    },
    // 丢弃最后一轮 assistant 输出（重新生成用）：保留 user 消息
    dropLastAssistantTurn() {
      let i = state.messages.length - 1;
      while (i >= 0 && state.messages[i].role !== 'user') i--;
      if (i < 0) return 0;
      const removed = state.messages.length - (i + 1);
      state.messages = state.messages.slice(0, i + 1);
      notify();
      return removed;
    },

    clearChat() {
      state.messages = [];
      state.checkpoints = [];
      state.undoBranch = null;
      notify();
    },
    clearFiles() {
      state.files = {};
      notify();
    },
  };
}

function findCheckpointAt(checkpoints, messageCount) {
  for (let i = checkpoints.length - 1; i >= 0; i--) {
    if (checkpoints[i].messageCount === messageCount) return i;
  }
  return -1;
}
