// ─── 会话状态：多会话记录、消息、检查点（回滚）、持久化 ────────────────
// 侧栏展示「会话记录」；回滚操作全部发生在对话区（消息级按钮 + 撤销浮条）
import { STORAGE_KEY, DEFAULT_IMAGE_MODEL, DEFAULT_CHAT_MODEL, isImageModel, isImageGenModel } from './config.js?v=2026.10.9.4';
import { readLocal } from './legacy-keys.js';
import { isJevModel } from './jev.js';
import { blobsSupported, blobPut, blobGet, blobPrune } from './blobstore.js';
import { pruneMemoryFacts } from './memory.js';
import { pruneLearnedSkills } from './skills.js';

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

function newSession(title = '', model = '', imageModel = '') {
  return { id: uid(), title, model, imageModel, createdAt: Date.now(), updatedAt: Date.now(), messages: [], checkpoints: [], undoBranch: null, files: {}, stats: { lastMs: 0, totalMs: 0 } };
}

const sessionActivityAt = (s) => {
  const msgs = (s && Array.isArray(s.messages)) ? s.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const ts = Number(msgs[i] && msgs[i].ts);
    if (ts > 0) return ts;
  }
  return Number((s && (s.createdAt || s.updatedAt)) || 0);
};
const sortByActivity = (list) => [...(list || [])].sort((a, b) => sessionActivityAt(b) - sessionActivityAt(a));
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
    // webEnabled：联网开关。控制模型原生联网格式与已探测到的 Worker 搜索/抓取工具；
    // fetch_url/search_web/crawl_site 仍须存在相应 relay capability 才会进入工具表。
    settings: { sandboxEnabled: true, fastMode: false, theme: 'light', thinking: true, reasoningLevel: 'medium', webEnabled: true, jevEnabled: true, visionModel: 'deepseek-v4-flash-vision-exp', videoModel: 'gemini-3.5-flash-lite', imageRemoteReview: true },
    sessions: [newSession()],
    activeSessionId: null,
    // 根级字段 = 活动会话的实时引用（由 hydrate/commit 同步，其余代码零改动）
    messages: [], checkpoints: [], files: {}, undoBranch: null, stats: { lastMs: 0, totalMs: 0 },
    memory: [],
    learnedSkills: [],
    // P1（Dubhe Helix 2.5）：可恢复执行与记忆生命周期的根级状态。
    // 容量上限与各自模块保持一致（recovery.CHECKPOINT_MAX / idempotency.LEDGER_MAX /
    // trajectory.TRAJECTORY_LOG_MAX / memorylife 候选区 8 条）——这里刻意不 import 那些模块，
    // 避免 state.js 被拖进执行内核的依赖图（混版缓存时 state 必须最先可用）。
    executionCheckpoints: [],   // 执行检查点（环形，最多 12）：恢复计划与产物漂移核验的数据源
    executionIdempotency: [],   // 幂等账本（环形，最多 48）：跨轮判定「同一操作不必再做」
    trajectoryLog: [],          // 轨迹日志（环形，最多 24）：负向指标（过度路由/漏路由/静默失败）的样本
    trajectoryTotals: null,     // 轨迹累计计数（健康回合 / 恢复成功率 / P95 等）
    memoryCandidates: [],       // 记忆候选区（最多 8）：未通过长期库门槛的条目先在这里等确认
    memoryHealth: null,         // 记忆健康度快照（来源分级 / 敏感条目数 / 冲突数）
    // P2（Dubhe Helix 2.5）：策略演进 / 故障注入 / 统一指标 / 审计对账的根级状态。
    // 同样刻意不 import 各 P2 模块——state.js 必须是最先可用的那一层，混版缓存时不炸。
    policySnapshot: null,       // 策略版本快照（会话首轮写入；用于漂移对比「同一会话里策略换过没有」）
    policyDrift: null,          // 策略漂移自检结果（注册表声明 vs 模块实际导出）
    experimentAssignments: {},  // 实验分配（实验 id → { variantId, inExperiment, reason }），分桶稳定不重摇
    experimentSamples: [],      // 在线实验样本（环形，最多 200）：每轮对照/变体各一条
    faultInjection: null,       // 待注入的故障清单（一次性，装配后立即置空）
    lastFaultReport: null,      // 最近一次故障验收报告（五性质：可检测/可解释/可停止/可恢复/可审计）
    faultHistory: [],           // 故障卡片历史（环形，最多 24）
    metricsSnapshot: null,      // 统一指标快照（12 指标 × 7 维切分）
    metricsBaseline: null,      // 指标基线（用户/CI 显式设定，用于门禁对比，不自动改）
    metricsGate: null,          // 最近一次指标门禁结论（是否退化、退化在哪些维度）
    auditReconcile: null,       // 审计三层目标对账（完整性 / 完备性 / 真实性边界声明）
    lastExecutionContext: null, // 最近一轮的统一执行上下文（能力/约束/工具表裁剪/一致性自检结论）
  };
  state.activeSessionId = state.sessions[0].id;

  // P1 状态键的形状与容量兜底：坏数据不能让续跑 / 评测 / 记忆面板炸掉
  const P1_STATE_CAPS = { executionCheckpoints: 12, executionIdempotency: 48, trajectoryLog: 24, memoryCandidates: 8 };
  const normalizeP1State = () => {
    for (const [key, cap] of Object.entries(P1_STATE_CAPS)) {
      state[key] = Array.isArray(state[key]) ? state[key].slice(-cap) : [];
    }
    if (!state.trajectoryTotals || typeof state.trajectoryTotals !== 'object') state.trajectoryTotals = null;
    if (!state.memoryHealth || typeof state.memoryHealth !== 'object') state.memoryHealth = null;
  };
  normalizeP1State();

  // P2 状态键：同样的形状兜底——坏数据只能让面板显示「暂无数据」，不能让执行内核崩
  const P2_STATE_CAPS = { experimentSamples: 200, faultHistory: 24 };
  const normalizeP2State = () => {
    for (const [key, cap] of Object.entries(P2_STATE_CAPS)) {
      state[key] = Array.isArray(state[key]) ? state[key].slice(-cap) : [];
    }
    for (const key of ['policySnapshot', 'policyDrift', 'faultInjection', 'lastFaultReport', 'metricsSnapshot', 'metricsBaseline', 'metricsGate', 'auditReconcile', 'lastExecutionContext']) {
      if (state[key] && typeof state[key] !== 'object') state[key] = null;
    }
    if (!state.experimentAssignments || typeof state.experimentAssignments !== 'object' || Array.isArray(state.experimentAssignments)) state.experimentAssignments = {};
  };
  normalizeP2State();


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
    // 思考开关与级别按会话记：切会话时恢复该对话自己的档位
    if (typeof s.thinking === 'boolean') state.settings.thinking = s.thinking;
    if (s.reasoningLevel) state.settings.reasoningLevel = s.reasoningLevel;
  };
  const commit = () => {
    // /system 隐藏通道（.17）：真实会话零写入——通道内的消息是隔离草稿，
    // 会话记录 / 检查点 / 文件 / 会话级模型统统不碰，退出通道后由 UI 恢复现场
    if (state.model === '__system__') return;
    const s = sess();
    s.messages = state.messages;
    s.checkpoints = state.checkpoints;
    s.files = state.files;
    s.undoBranch = state.undoBranch;
    s.stats = state.stats;
    s.model = state.model;           // 会话级模型（修复：切换会话后模型名被当前选择覆盖）
    s.imageModel = state.imageModel; // 会话级生图模型
    s.thinking = state.settings.thinking !== false;
    s.reasoningLevel = state.settings.reasoningLevel || 'medium';
    s.updatedAt = Date.now();
    // 若首条消息违规被拦截，且当前会话尚未命名，先将标题设为「未命名对话」，
    // 待下一个不违规的任务结束后再由 AI 总结标题（Requirement 4）。
    const firstUser = s.messages.find((m) => m.role === 'user' && !m.transientModeration && !m.moderationPending && !m.silent);
    const hasBlockedModeration = s.messages.some((m) => m && m.moderation && m.moderation.blocked);
    if (!firstUser && hasBlockedModeration && !s.titled && s.titleSource !== 'user') {
      s.title = '未命名对话';
      s.untitledFromModeration = true;
    }
    // 兜底标题（首条消息截断）只在还没有像样标题且未处于「违规首条等待 AI 总结」状态时生成；
    // Agent 总结出的（titleSource:'auto'）与用户手改的（'user'）都不覆盖。
    if (!s.title && !s.untitledFromModeration && s.titleSource !== 'user') {
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
    // P1 根级状态（检查点 / 幂等账本 / 轨迹日志 / 候选区）也是落盘内容，必须计入体积，
    // 否则「瘦身阈值」判断会漏算这部分，配额吃紧时又回到「整个 state 塞不进 localStorage」
    c += JSON.stringify({
      cps: state.executionCheckpoints || [],
      ledger: state.executionIdempotency || [],
      traj: state.trajectoryLog || [],
      cands: state.memoryCandidates || [],
      totals: state.trajectoryTotals || null,
      health: state.memoryHealth || null,
      // P2 根级状态（策略快照 / 实验样本 / 故障卡片 / 指标快照 / 审计对账）同样是落盘内容
      policies: state.policySnapshot || null,
      exp: state.experimentSamples || [],
      faults: state.faultHistory || [],
      metrics: state.metricsSnapshot || null,
      audit: state.auditReconcile || null,
    }).length + 768;
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
    const raw = readLocal(STORAGE_KEY + '-v2'); // 新键缺失时自动从旧品牌键迁移
    if (raw) {
      const parsed = JSON.parse(raw);
      Object.assign(state, parsed);
      // 旧快照里没有的开关要补上默认值（整块 settings 被 parsed 覆盖时不能留下 undefined）
      state.settings = Object.assign({ sandboxEnabled: true, remoteCppEnabled: true, fastMode: false, theme: 'light', thinking: true, reasoningLevel: 'medium', webEnabled: true, jevEnabled: true, visionModel: 'deepseek-v4-flash-vision-exp', videoModel: 'gemini-3.5-flash-lite', imageRemoteReview: true }, state.settings || {});
      state.memory = pruneMemoryFacts(Array.isArray(state.memory) ? state.memory : []);
      state.learnedSkills = pruneLearnedSkills(Array.isArray(state.learnedSkills) ? state.learnedSkills : []);
      normalizeP1State(); // 旧快照没有这些键 → 补默认；坏形状 → 丢弃而不是带着跑
      if (!state.sessions || !state.sessions.length) state.sessions = [newSession()];
      if (!state.sessions.some((s) => s.id === state.activeSessionId)) state.activeSessionId = state.sessions[0].id;
      // /system 是运行时通道不持久化：旧快照异常退出时若卡在 __system__，回退到会话自己的模型
      if (state.model === '__system__') {
        const s0 = state.sessions.find((x) => x.id === state.activeSessionId) || state.sessions[0];
        state.model = (s0 && s0.model) || DEFAULT_CHAT_MODEL;
      }
    } else {
      // 首次运行跟随系统明暗偏好（a11y P2-3），之后以用户手动切换为准
      if (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches) {
        state.settings.theme = 'dark';
      }
      const v1 = readLocal(STORAGE_KEY);
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
  // Drop retired auto-prune metadata from all old snapshot formats; never scan or delete user files.
  for (const key of ['cleanupArtifacts', 'lastCleanupReport', 'cleanupHistory', 'cleanupTotals']) delete state[key];
  delete state.settings.cleanupPolicy;
  for (const session of state.sessions || []) for (const message of session.messages || []) delete message.cleanup;
  for (const message of state.messages || []) delete message.cleanup;
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
      return sortByActivity(state.sessions);
    },
    // 侧栏只列有内容的会话（导入/历史数据都带消息，正常显示）
    listableSessions() {
      return sortByActivity(state.sessions.filter((s) => (s.messages || []).length > 0));
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
      delete s.untitledFromModeration;
      const t = cleanTitle(title);
      if (s.titleSource === 'user') { notify(); return false; }
      if (!t) {
        if (!s.title || s.title === '未命名对话') {
          const firstUser = (s.messages || []).find((m) => m.role === 'user' && !m.transientModeration && !m.moderationPending && !m.silent);
          if (firstUser && firstUser.text) s.title = cleanTitle(firstUser.text).slice(0, 24) || '新对话';
        }
        notify();
        return false;
      }
      s.title = t;
      s.titleSource = 'auto';
      notify();
      return true;
    },
    needsTitle() {
      const s = sess();
      if (!s || s.titled || s.titleSource === 'user') return null;
      const firstUser = (s.messages || []).find((m) => m.role === 'user' && !m.transientModeration && !m.moderationPending && !m.silent);
      const lastAssistant = [...(s.messages || [])].reverse().find((m) => m.role === 'assistant' && m.done && !m.transientModeration && !m.moderation && !m.cancelled);
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
          const atts = Array.isArray(m.attachments) ? m.attachments.map((a) => {
            const dataUrl = a.dataUrl || a.data || null;
            return {
              kind: a.kind, name: a.name || '文件', size: a.size || 0,
              data: dataUrl, dataUrl: dataUrl || undefined,
              text: a.text || '', mime: a.mime || '', stripped: a.stripped != null ? !!a.stripped : (!dataUrl && !a.text),
            };
          }) : [];
          return {
            id: uid(), role: m.role, text: m.text || '',
            content: typeof m.content === 'string' ? m.content : (m.content || ''),
            model: m.model, // 保留每条消息实际使用的模型（会话头展示用）
            toolCalls: m.toolCalls, toolCallId: m.toolCallId, name: m.name, usage: m.usage, ts: m.ts,
            // 导出 JSON 经常不带 done。缺省当成已经结束，否则 paintAssistant 会给每条回复画一个去不掉的光标。
            done: m.done !== false,
            cancelled: !!m.cancelled,
            reasoning: m.reasoning,
            reasoningMs: m.reasoningMs,
            reasoningLevel: m.reasoningLevel,
            durationMs: m.durationMs,
            thinkingBlocks: m.thinkingBlocks,
            thoughtHidden: m.thoughtHidden,
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
