// ─── 会话状态：多会话记录、消息、检查点（回滚）、持久化 ────────────────
// 侧栏展示「会话记录」；回滚操作全部发生在对话区（消息级按钮 + 撤销浮条）
import { STORAGE_KEY, DEFAULT_IMAGE_MODEL, DEFAULT_CHAT_MODEL, isImageModel, isImageGenModel } from './config.js';

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

function newSession(title = '', model = '', imageModel = '') {
  return { id: uid(), title, model, imageModel, createdAt: Date.now(), updatedAt: Date.now(), messages: [], checkpoints: [], undoBranch: null, files: {}, stats: { lastMs: 0, totalMs: 0 } };
}

// 会话未记录模型时（历史数据），回退到最后一条 assistant 消息所用的模型
function sessionModel(s) {
  if (s && s.model) return s.model;
  const last = [...((s && s.messages) || [])].reverse().find((m) => m.role === 'assistant' && m.model);
  return last ? last.model : '';
}

export function createStore(onChange) {
  const state = {
    apiKey: '',
    model: DEFAULT_CHAT_MODEL,
    imageModel: DEFAULT_IMAGE_MODEL, // 生图模型（由 generate_image 工具使用，与会话绑定）
    models: [],
    settings: { sandboxEnabled: true, fastMode: false, theme: 'light', thinking: true },
    sessions: [newSession()],
    activeSessionId: null,
    // 根级字段 = 活动会话的实时引用（由 hydrate/commit 同步，其余代码零改动）
    messages: [], checkpoints: [], files: {}, undoBranch: null, stats: { lastMs: 0, totalMs: 0 },
  };
  state.activeSessionId = state.sessions[0].id;

  const sess = () => state.sessions.find((s) => s.id === state.activeSessionId) || state.sessions[0];
  const hydrate = () => {
    const s = sess();
    state.messages = s.messages;
    state.checkpoints = s.checkpoints;
    state.files = s.files;
    state.undoBranch = s.undoBranch;
    state.stats = s.stats || (s.stats = { lastMs: 0, totalMs: 0 });
    // 模型属于会话属性：切换会话时恢复该会话自己的模型，而不是沿用全局当前选择
    state.model = sessionModel(s) || state.model;
    // 生图模型只能由 generate_image 工具调用：历史数据若存着它，回落到默认对话模型
    if (isImageModel(state.model)) state.model = DEFAULT_CHAT_MODEL;
    s.model = state.model;
    // 生图模型同样按会话记忆；缺失或非法值回落到默认
    const wantImage = s.imageModel || state.imageModel;
    state.imageModel = isImageGenModel(wantImage) ? wantImage : DEFAULT_IMAGE_MODEL;
    s.imageModel = state.imageModel;
  };
  const commit = () => {
    const s = sess();
    s.messages = state.messages;
    s.checkpoints = state.checkpoints;
    s.files = state.files;
    s.undoBranch = state.undoBranch;
    s.stats = state.stats;
    s.model = state.model;           // 会话级模型（修复：切换会话后模型名被当前选择覆盖）
    s.imageModel = state.imageModel; // 会话级生图模型
    s.updatedAt = Date.now();
    if (!s.title) {
      const firstUser = s.messages.find((m) => m.role === 'user');
      if (firstUser && firstUser.text) s.title = firstUser.text.slice(0, 24);
    }
  };

  // ── 持久化（v2 结构；自动迁移 v1 单会话数据）──
  let saveTimer = null;
  // 瘦身版快照：剥离附件 dataUrl、截断附件文本。
  // 注意根级 messages 是活动会话消息数组的镜像引用，必须一并替换为瘦身版，
  // 否则瘦身 JSON 里仍会带上完整的大附件（4MB 限制形同虚设）
  const slimMsgs = (msgs) => (msgs || []).map((m) => m.attachments ? {
    ...m,
    attachments: m.attachments.map((a) => ({ ...a, dataUrl: undefined, text: a.text != null ? String(a.text).slice(0, 1000) : undefined, stripped: true })),
  } : m);
  // 沙箱里的图片（data URL，可达数 MB）不落盘：附件与生成图本身已在消息/下载通道处理，
  // 持久化它们会瞬间顶穿 localStorage 4MB 上限并拖慢每次防抖写入
  const BIG_DATA_URL = /^data:[^;,]+;base64,/;
  const slimFiles = (files) => {
    if (!files) return files;
    let changed = false;
    const out = {};
    for (const [k, v] of Object.entries(files)) {
      if (typeof v === 'string' && v.length > 64 * 1024 && BIG_DATA_URL.test(v)) { changed = true; continue; }
      out[k] = v;
    }
    return changed ? out : files;
  };
  const slimState = () => {
    const sessions = state.sessions.map((s) => ({ ...s, messages: slimMsgs(s.messages), files: slimFiles(s.files) }));
    const active = sessions.find((s) => s.id === state.activeSessionId) || sessions[0] || { messages: [] };
    return { ...state, sessions, messages: active.messages, files: active.files };
  };
  // 廉价的序列化体积预估（只数字符，不做 JSON 编码）：
  // 避免「先全量 stringify 带 base64 图片的巨型 state、超限后再扔掉重来」的双重序列化
  // （单张 5MB 图片 ≈ 6.7MB dataURL，旧逻辑每次落盘都白序列化一遍）
  const estimateStateChars = () => {
    let c = 1024;
    for (const s of state.sessions) {
      for (const m of s.messages || []) {
        c += (m.text ? m.text.length : 0) + (m.content ? m.content.length : 0) + (m.reasoning ? m.reasoning.length : 0) + 96;
        if (m.toolCalls) c += JSON.stringify(m.toolCalls).length;
        if (m.thinkingBlocks) c += JSON.stringify(m.thinkingBlocks).length;
        for (const a of m.attachments || []) c += (a.dataUrl ? a.dataUrl.length : 0) + (a.text ? a.text.length : 0) + 128;
      }
      c += JSON.stringify(s.files || {}).length + 256;
    }
    return c;
  };
  const writeNow = () => {
    try {
      commit();
      // 先预估再决定序列化目标；预估偏低时仍有全量兜底检查
      let json = estimateStateChars() > 4000000 ? JSON.stringify(slimState()) : JSON.stringify(state);
      if (json.length > 4000000) json = JSON.stringify(slimState());
      localStorage.setItem(STORAGE_KEY + '-v2', json);
    } catch {
      try { localStorage.setItem(STORAGE_KEY + '-v2', JSON.stringify(slimState())); } catch { /* 放弃本次持久化 */ }
    }
  };
  // immediate=true 立即同步落盘：beforeunload / 页面隐藏时不能用防抖，
  // 否则定时器还没触发页面就被卸载，最后一轮对话会丢失。
  const save = (immediate = false) => {
    clearTimeout(saveTimer);
    if (immediate) { writeNow(); return; }
    saveTimer = setTimeout(writeNow, 300);
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
      // 首次运行跟随系统明暗偏好（a11y P2-3），之后以用户手动切换为准
      if (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches) {
        state.settings.theme = 'dark';
      }
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
      // 新会话继承当前模型选择，之后各会话独立记忆自己的模型
      const s = newSession('', state.model, state.imageModel);
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
    // ── 导入会话：接受本应用导出的 JSON（含 messages 数组），新建一个会话 ──
    importSession(data) {
      if (!data || !Array.isArray(data.messages) || !data.messages.length) return null;
      const s = newSession('');
      s.messages = data.messages
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant' || m.role === 'tool'))
        .map((m) => {
          const atts = Array.isArray(m.attachments) ? m.attachments.map((a) => ({
            kind: a.kind, name: a.name || '文件', size: a.size || 0,
            data: a.data || null, text: a.text || '', mime: a.mime || '', stripped: !a.data,
          })) : [];
          return {
            id: uid(), role: m.role, text: m.text || '',
            content: typeof m.content === 'string' ? m.content : (m.content || ''),
            model: m.model, // 保留每条消息实际使用的模型（会话头展示用）
            toolCalls: m.toolCalls, toolCallId: m.toolCallId, name: m.name, usage: m.usage, ts: m.ts,
            ...(atts.length ? { attachments: atts } : {}),
          };
        });
      if (!s.messages.length) return null;
      const firstUser = s.messages.find((m) => m.role === 'user');
      s.title = String(data.title || (firstUser && firstUser.text) || '导入会话').slice(0, 40);
      if (data.model) s.model = String(data.model);
      if (data.imageModel) s.imageModel = String(data.imageModel);
      s.createdAt = Date.now();
      s.updatedAt = Date.now();
      state.sessions.unshift(s);
      state.activeSessionId = s.id;
      hydrate();
      notify();
      return s;
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
