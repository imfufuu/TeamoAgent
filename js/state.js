// ─── 会话状态：多会话记录、消息、检查点（回滚）、持久化 ────────────────
// 侧栏展示「会话记录」；回滚操作全部发生在对话区（消息级按钮 + 撤销浮条）
import { STORAGE_KEY, DEFAULT_IMAGE_MODEL, DEFAULT_CHAT_MODEL, isImageModel, isImageGenModel } from './config.js';
import { isJevModel } from './jev.js';
import { blobsSupported, blobPut, blobGet, blobPrune } from './blobstore.js';

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

function newSession(title = '', model = '', imageModel = '') {
  return { id: uid(), title, model, imageModel, createdAt: Date.now(), updatedAt: Date.now(), messages: [], checkpoints: [], undoBranch: null, files: {}, stats: { lastMs: 0, totalMs: 0 } };
}

const sortByUpdated = (list) => [...(list || [])].sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
const cleanTitle = (t) => String(t || '').replace(/[\r\n\t]+/g, ' ').replace(/^[「“"'`\s]+|[」”"'`\s]+$/g, '').replace(/[。.]$/, '').trim().slice(0, 48);

// 会话未记录模型时（历史数据），回退到最后一条 assistant 消息所用的模型
function sessionModel(s) {
  if (s && s.model) return s.model;
  const last = [...((s && s.messages) || [])].reverse().find((m) => m.role === 'assistant' && m.model);
  return last ? last.model : '';
}

// ── 大对象外置（IndexedDB）：哪些字段算「重数据」──
// 附件图片 / 沙箱里的 data URL（生成的图）/ 工具芯片的预览图 / 超长附件文本。
// 这些留在一个 ~5MB 的 localStorage 里迟早爆配额，爆了就是「刷新后附件和沙箱全没了」。
const ATT_TEXT_KEEP = 20000; // 附件文本：localStorage 只留前 2 万字符，全文进 IDB
const FILE_KEEP = 16 * 1024; // 沙箱文件 / data URL 超过 16KB 就外置（图片基本都在此列，localStorage 只留文本类小文件）

/** 收集当前状态里所有外置 key（水合时按这些 key 去 IDB 取） */
export function collectBlobKeys(state) {
  const keys = [];
  for (const s of state.sessions || []) {
    for (const k of Object.values(s.blobFiles || {})) keys.push(k);
    for (const m of s.messages || []) {
      for (const k of Object.values(m.blobAtts || {})) keys.push(k);
      for (const k of Object.values(m.blobChips || {})) keys.push(k);
    }
  }
  return [...new Set(keys)];
}

/** 把重数据抽出来：返回 { light（可安全写 localStorage 的快照）, blobs: [[key, value]] } */
export function extractBlobs(state, { ready = false } = {}) {
  const blobs = [];
  const sessions = (state.sessions || []).map((s) => {
    const sid = s.id;
    const files = { ...(s.files || {}) };
    const blobFiles = { ...(s.blobFiles || {}) };
    const originalPaths = new Set(Object.keys(s.files || {}));
    for (const [path, val] of Object.entries(files)) {
      if (typeof val === 'string' && val.length > FILE_KEEP) {
        const key = `f:${sid}:${path}`;
        blobFiles[path] = key; blobs.push([key, val]); delete files[path];
      } else if (blobFiles[path]) delete blobFiles[path]; // 变回普通文本/已删除 → 不再外置
    }
    // 水合完成之后，files 是真相：索引里多出来、内存里已经没有的路径 = 用户删了，该丢掉。
    // 水合完成之前绝不能走这条 —— 那时大文件本来就不在 files 里，丢掉索引等于刷新后图全没。
    if (ready) {
      for (const path of Object.keys(blobFiles)) {
        if (!originalPaths.has(path)) delete blobFiles[path];
      }
    }
    const messages = (s.messages || []).map((m) => {
      const out = { ...m };
      const blobAtts = { ...(m.blobAtts || {}) };
      if (m.attachments && m.attachments.length) {
        out.attachments = m.attachments.map((a, i) => {
          if (a.dataUrl && String(a.dataUrl).length > FILE_KEEP) {
            const key = `a:${sid}:${m.id}:${i}`;
            blobAtts[i] = key; blobs.push([key, a.dataUrl]);
            return { ...a, dataUrl: undefined, stripped: true };
          }
          if (a.text && String(a.text).length > ATT_TEXT_KEEP) {
            const key = `t:${sid}:${m.id}:${i}`;
            blobAtts[i] = key; blobs.push([key, a.text]);
            return { ...a, text: String(a.text).slice(0, ATT_TEXT_KEEP), stripped: true, textTruncated: true };
          }
          // 还没从 IDB 取回来：dataUrl 是空的、stripped 占位。必须保留索引，否则下一次
          // save()（启动后 300ms 内任何 notify）会把 blobAtts 抹掉，紧接着 blobPrune([]) 清空 IDB。
          if (blobAtts[i] && (a.stripped || a.textTruncated || (a.kind === 'image' && !a.dataUrl))) return a;
          delete blobAtts[i];
          return a;
        });
      } else if (ready) {
        for (const i of Object.keys(blobAtts)) delete blobAtts[i];
      }
      const blobChips = { ...(m.blobChips || {}) };
      if (m.toolCalls && m.toolCalls.length) {
        out.toolCalls = m.toolCalls.map((c) => {
          if (!c) return c;
          if (c.image && String(c.image).length > FILE_KEEP) {
            const key = `c:${sid}:${c.id}`;
            blobChips[c.id] = key; blobs.push([key, c.image]);
            return { ...c, image: undefined, imageStripped: true };
          }
          if (blobChips[c.id] && (c.imageStripped || !c.image)) return c;
          delete blobChips[c.id];
          return c;
        });
      } else if (ready) {
        for (const id of Object.keys(blobChips)) delete blobChips[id];
      }
      if (Object.keys(blobAtts).length) out.blobAtts = blobAtts; else delete out.blobAtts;
      if (Object.keys(blobChips).length) out.blobChips = blobChips; else delete out.blobChips;
      return out;
    });
    const out = { ...s, messages };
    if (Object.keys(blobFiles).length) { out.files = files; out.blobFiles = blobFiles; }
    else { out.files = files; delete out.blobFiles; }
    return out;
  });
  const active = sessions.find((s) => s.id === state.activeSessionId) || sessions[0] || { messages: [], files: {} };
  const light = { ...state, sessions, messages: active.messages, files: active.files };
  delete light._blobsReady; // 运行时标记，不进快照
  if (active.blobFiles) light.blobFiles = active.blobFiles; else delete light.blobFiles;
  return { light, blobs, keys: collectBlobKeys(light) };
}

/** 把 IDB 里取回的重数据填回状态（原地修改 state，返回填了几处） */
export function applyBlobs(state, map) {
  if (!map || !map.size) return 0;
  let filled = 0;
  for (const s of state.sessions || []) {
    if (s.blobFiles) {
      for (const [path, key] of Object.entries(s.blobFiles)) {
        if (!map.has(key)) continue;
        s.files = s.files || {}; s.files[path] = map.get(key); filled++;
      }
    }
    for (const m of s.messages || []) {
      if (m.blobAtts) {
        for (const [i, key] of Object.entries(m.blobAtts)) {
          const a = (m.attachments || [])[Number(i)];
          if (!a || !map.has(key)) continue;
          if (String(key).startsWith('a:')) { a.dataUrl = map.get(key); a.stripped = false; }
          else { a.text = map.get(key); a.stripped = false; a.textTruncated = false; }
          filled++;
        }
      }
      if (m.blobChips && m.toolCalls) {
        for (const [callId, key] of Object.entries(m.blobChips)) {
          const c = m.toolCalls.find((x) => x && x.id === callId);
          if (!c || !map.has(key)) continue;
          c.image = map.get(key); c.imageStripped = false; filled++;
        }
      }
    }
  }
  const active = (state.sessions || []).find((s) => s.id === state.activeSessionId) || (state.sessions || [])[0];
  if (active) { state.messages = active.messages; state.files = active.files; }
  return filled;
}

export function createStore(onChange) {
  const state = {
    apiKey: '',
    model: DEFAULT_CHAT_MODEL,
    imageModel: DEFAULT_IMAGE_MODEL, // 生图模型（由 generate_image 工具使用，与会话绑定）
    models: [],
    // webEnabled：联网开关。开着时按当前模型 API 自带的网页搜索请求格式发请求
    // （见 js/websearch.js）—— 没有第三方搜索接口，所以模型没有原生格式就等于不联网。
    settings: { sandboxEnabled: true, fastMode: false, theme: 'light', thinking: true, webEnabled: true, jevEnabled: true },
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
    if (isImageModel(state.model) || isJevModel(state.model)) state.model = DEFAULT_CHAT_MODEL;
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
    // 兜底标题（首条消息截断）只在还没有像样标题时生成；
    // Agent 总结出的（titleSource:'auto'）与用户手改的（'user'）都不覆盖。
    if (!s.title && s.titleSource !== 'user') {
      const firstUser = s.messages.find((m) => m.role === 'user');
      if (firstUser && firstUser.text) s.title = cleanTitle(firstUser.text).slice(0, 24) || '新对话';
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
    try { commit(); } catch { /* 提交失败也不能影响主流程 */ }
    const KEY = STORAGE_KEY + '-v2';
    if (blobsSupported()) {
      // 有 IndexedDB：重数据外置，localStorage 只存轻量状态（不再有 4MB 天花板）
      let entries = [], keep = [];
      try {
        const ex = extractBlobs(state, { ready: !!state._blobsReady });
        entries = ex.blobs;
        // 必须按「轻量快照里还引用着的 key」来 prune，而不是「这一轮新抽出的 key」。
        // 水合完成前 extractBlobs.blobs 经常是空的（大文件还不在内存里），旧逻辑 keep=[]
        // 会把 IDB 里已有的图全部删掉 —— 刷新后再刷新，附件和沙箱图就没了。
        keep = ex.keys;
        localStorage.setItem(KEY, JSON.stringify(ex.light));
      } catch {
        try { localStorage.setItem(KEY, JSON.stringify(slimState())); } catch { /* 放弃本次持久化 */ }
      }
      const afterPut = () => blobPrune(keep);
      if (entries.length) {
        blobPut(entries)
          // 落库失败（隐私模式 / 配额）：退回把完整状态塞进 localStorage，至少别丢
          .catch((e) => {
            console.warn('[persist] IndexedDB 写入失败，退回 localStorage：', e && e.message);
            try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* 放不下就算了 */ }
          })
          .then(afterPut)
          .catch((e) => console.warn('[persist] 清理孤儿数据失败：', e && e.message));
      } else {
        blobPrune(keep).catch(() => {}); // 会话/消息删掉后不留孤儿；有引用的 key 会被保留
      }
      return;
    }
    // 没有 IndexedDB（老环境）：沿用旧路径
    try {
      // 先预估再决定序列化目标；预估偏低时仍有全量兜底检查
      let json = estimateStateChars() > 4000000 ? JSON.stringify(slimState()) : JSON.stringify(state);
      if (json.length > 4000000) json = JSON.stringify(slimState());
      localStorage.setItem(KEY, json);
    } catch {
      try { localStorage.setItem(KEY, JSON.stringify(slimState())); } catch { /* 放弃本次持久化 */ }
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

  // 刷新页面后把外置的重数据（附件图片 / 沙箱里的图 / 芯片预览图）从 IDB 取回来。
  // 失败或环境不支持时返回 0，界面按「已省略」渲染，不阻塞启动。
  async function hydrateBlobs() {
    const done = (n) => { state._blobsReady = true; return n; };
    if (!blobsSupported()) return done(0);
    const keys = collectBlobKeys(state);
    if (!keys.length) return done(0);
    try {
      const map = await blobGet(keys);
      const n = applyBlobs(state, map);
      if (n) hydrate();
      return done(n);
    } catch { return done(0); }
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY + '-v2');
    if (raw) {
      const parsed = JSON.parse(raw);
      Object.assign(state, parsed);
      // 旧快照里没有的开关要补上默认值（整块 settings 被 parsed 覆盖时不能留下 undefined）
      state.settings = Object.assign({ sandboxEnabled: true, fastMode: false, theme: 'light', thinking: true, webEnabled: true, jevEnabled: true }, state.settings || {});
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
    hydrateBlobs,

    // ── 多会话 ──
    // 空的「新对话」草稿不进侧栏（第一条消息发出后才出现）；反复点「＋ 新建」
    // 复用同一个草稿，否则 invisible 的空会话会在 localStorage 里越堆越多。
    ensureDraft() {
      const cur = sess();
      if (cur && !(cur.messages || []).length) { hydrate(); notify(); return cur; }
      return this.createSession();
    },
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
      return sortByUpdated(state.sessions);
    },
    // 侧栏只列有内容的会话（导入/历史数据都带消息，正常显示）
    listableSessions() {
      return sortByUpdated(state.sessions.filter((s) => (s.messages || []).length > 0));
    },
    // 一键清除所有会话记录：全部丢掉，只留一个新的空草稿
    clearAllSessions() {
      const removed = state.sessions.filter((x) => (x.messages || []).length > 0).length;
      const fresh = newSession('', state.model, state.imageModel);
      state.sessions = [fresh];
      state.activeSessionId = fresh.id;
      hydrate();
      notify();
      return removed;
    },
    // 手动改名（titleSource='user'，Agent 不再覆盖）
    renameSession(id, title) {
      const s = state.sessions.find((x) => x.id === id);
      if (!s) return false;
      const t = cleanTitle(title);
      if (!t) return false;
      s.title = t;
      s.titleSource = 'user';
      s.titled = true;
      s.updatedAt = Date.now();
      hydrate();
      notify();
      return true;
    },
    // Agent 总结的标题：只在用户没改过名时生效，且每会话只尝试一次
    setAutoTitle(id, title) {
      const s = state.sessions.find((x) => x.id === id);
      if (!s) return false;
      s.titled = true;
      const t = cleanTitle(title);
      if (!t || s.titleSource === 'user') { notify(); return false; }
      s.title = t;
      s.titleSource = 'auto';
      notify();
      return true;
    },
    needsTitle() {
      const s = sess();
      if (!s || s.titled || s.titleSource === 'user') return null;
      const firstUser = (s.messages || []).find((m) => m.role === 'user');
      const lastAssistant = [...(s.messages || [])].reverse().find((m) => m.role === 'assistant' && m.done);
      if (!firstUser || !lastAssistant) return null;
      return { sessionId: s.id, question: String(firstUser.text || '').slice(0, 600), answer: String(lastAssistant.text || '').slice(0, 600) };
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
            // 导出 JSON 经常不带 done。缺省当成已经结束，否则 paintAssistant 会给每条回复画一个去不掉的光标。
            done: m.done !== false,
            cancelled: !!m.cancelled,
            reasoning: m.reasoning,
            webSearch: m.webSearch,
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
