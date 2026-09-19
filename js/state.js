// ─── 会话状态：多会话记录、消息、检查点（回滚）、持久化 ────────────────
// 侧栏展示「会话记录」；回滚操作全部发生在对话区（消息级按钮 + 撤销浮条）
import { STORAGE_KEY } from './config.js';

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

function newSession(title = '') {
  return { id: uid(), title, createdAt: Date.now(), updatedAt: Date.now(), messages: [], checkpoints: [], undoBranch: null, files: {} };
}

export function createStore(onChange) {
  const state = {
    apiKey: '',
    model: 'claude-sonnet-5',
    models: [],
    settings: { sandboxEnabled: true, fastMode: false, theme: 'light', thinking: true },
    sessions: [newSession()],
    activeSessionId: null,
    // 根级字段 = 活动会话的实时引用（由 hydrate/commit 同步，其余代码零改动）
    messages: [], checkpoints: [], files: {}, undoBranch: null,
  };
  state.activeSessionId = state.sessions[0].id;

  const sess = () => state.sessions.find((s) => s.id === state.activeSessionId) || state.sessions[0];
  const hydrate = () => {
    const s = sess();
    state.messages = s.messages;
    state.checkpoints = s.checkpoints;
    state.files = s.files;
    state.undoBranch = s.undoBranch;
  };
  const commit = () => {
    const s = sess();
    s.messages = state.messages;
    s.checkpoints = state.checkpoints;
    s.files = state.files;
    s.undoBranch = state.undoBranch;
    s.updatedAt = Date.now();
    if (!s.title) {
      const firstUser = s.messages.find((m) => m.role === 'user');
      if (firstUser && firstUser.text) s.title = firstUser.text.slice(0, 24);
    }
  };

  // ── 持久化（v2 结构；自动迁移 v1 单会话数据）──
  let saveTimer = null;
  const slimState = () => ({
    ...state,
    sessions: state.sessions.map((s) => ({
      ...s,
      messages: s.messages.map((m) => m.attachments ? {
        ...m,
        attachments: m.attachments.map((a) => ({ ...a, dataUrl: undefined, text: a.text != null ? String(a.text).slice(0, 1000) : undefined, stripped: true })),
      } : m),
    })),
  });
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        commit();
        let json = JSON.stringify(state);
        if (json.length > 4000000) json = JSON.stringify(slimState());
        localStorage.setItem(STORAGE_KEY + '-v2', json);
      } catch {
        try { localStorage.setItem(STORAGE_KEY + '-v2', JSON.stringify(slimState())); } catch { /* 放弃本次持久化 */ }
      }
    }, 300);
  };
  const notify = () => { commit(); save(); onChange && onChange(state); };

  try {
    const raw = localStorage.getItem(STORAGE_KEY + '-v2');
    if (raw) {
      const parsed = JSON.parse(raw);
      Object.assign(state, parsed);
      if (!state.sessions || !state.sessions.length) state.sessions = [newSession()];
      if (!state.sessions.some((s) => s.id === state.activeSessionId)) state.activeSessionId = state.sessions[0].id;
    } else {
      const v1 = localStorage.getItem(STORAGE_KEY);
      if (v1) { // v1 单会话 → 迁移为一个会话
        const old = JSON.parse(v1);
        const s = newSession();
        s.messages = old.messages || [];
        s.checkpoints = old.checkpoints || [];
        s.files = old.files || {};
        state.sessions = [s];
        state.activeSessionId = s.id;
        state.apiKey = old.apiKey || '';
        state.model = old.model || state.model;
        state.models = old.models || [];
        state.settings = { ...state.settings, ...(old.settings || {}) };
      }
    }
  } catch { /* 损坏数据忽略 */ }
  hydrate();

  return {
    state,
    notify,
    save,

    // ── 多会话 ──
    createSession() {
      const s = newSession();
      state.sessions.unshift(s);
      state.activeSessionId = s.id;
      hydrate();
      notify();
      return s;
    },
    switchSession(id) {
      if (id === state.activeSessionId) return false;
      if (!state.sessions.some((s) => s.id === id)) return false;
      commit(); // 先落盘当前会话
      state.activeSessionId = id;
      hydrate();
      notify();
      return true;
    },
    deleteSession(id) {
      const idx = state.sessions.findIndex((s) => s.id === id);
      if (idx < 0) return false;
      state.sessions.splice(idx, 1);
      if (!state.sessions.length) state.sessions = [newSession()];
      if (!state.sessions.some((s) => s.id === state.activeSessionId)) {
        state.activeSessionId = state.sessions[Math.min(idx, state.sessions.length - 1)].id;
      }
      hydrate();
      notify();
      return true;
    },
    sortedSessions() {
      return [...state.sessions].sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
    },

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

    // ── 检查点 / 回滚（触发入口都在对话区）──
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
    rollbackBeforeMessage(messageId) {
      const idx = state.messages.findIndex((m) => m.id === messageId);
      if (idx < 0) return false;
      let userIdx = idx;
      while (userIdx >= 0 && state.messages[userIdx].role !== 'user') userIdx--;
      const targetCount = userIdx >= 0 ? userIdx : idx;
      let cpIdx = -1;
      for (let i = state.checkpoints.length - 1; i >= 0; i--) {
        if (state.checkpoints[i].messageCount === targetCount) { cpIdx = i; break; }
      }
      if (cpIdx >= 0) return this.rollbackTo(state.checkpoints[cpIdx].id);
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
    dropLastAssistantTurn() {
      let i = state.messages.length - 1;
      while (i >= 0 && state.messages[i].role !== 'user') i--;
      if (i < 0) return 0;
      const removed = state.messages.length - (i + 1);
      state.messages = state.messages.slice(0, i + 1);
      notify();
      return removed;
    },

    clearFiles() {
      state.files = {};
      notify();
    },
  };
}
