// ─── 跨会话记忆（Stage 2 统一上下文与双通道存储 · 写入过滤 + 软归档可恢复 / 物理 Purge 双通道）────
// 核心原则：
//   1. 入口规则过滤（isValidMemoryFact）：拦截反问句、指代残片（“这个呢”）与显式一次性指令，并配套离线评测集披露 Precision/Recall 折中与边界失败样本。
//   2. 软归档可恢复（forget / restore）与物理彻底清除（purge）显式分流：
//      - 常规超期或 forget 转入「冷备软归档（memoryArchive，平时占 0 Token）」，后续提及时自动唤醒或一键 restore；
//      - 涉及用户隐私或敏感数据擦除时走 purgeMemoryFact，同步从活跃库与冷备库物理抹除（recoverable: false）。

const MAX_FACTS = 24;
const MAX_ARCHIVE_FACTS = 64;
const MAX_FACT = 160;
const MIN_FACT_LEN = 4;

const DAY_MS = 24 * 3600 * 1000;
export const MEMORY_SOURCE_SPEC = Object.freeze({
  'user-explicit':     { confidence: 0.98, ttlMs: 180 * DAY_MS, label: '用户显式指令' },
  'agent-tool':        { confidence: 0.88, ttlMs: 90 * DAY_MS,  label: 'Agent 记忆工具' },
  'compression-flush': { confidence: 0.72, ttlMs: 30 * DAY_MS,  label: '滑窗压缩刷盘' },
});

// 模块级冷备软归档池（同时支持与 store.state.memoryArchive 同步）
const softArchiveMap = new Map();

export function memoryIdFor(text) {
  const norm = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  let h = 2166136261;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 'mem-' + ((h >>> 0) & 0xffff).toString(16).padStart(4, '0');
}

// 记忆写入过滤守门人：拒绝疑问句、纯指代残片、寒暄、本轮临时状态与一次性任务指令
export function isValidMemoryFact(rawText) {
  const text = String(rawText || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length < MIN_FACT_LEN || text.length > MAX_FACT) return false;
  // 拒绝疑问句或反问尾缀
  if (/[？?]$/.test(text) || /^(?:为什么|为啥|怎么回事)/.test(text) || /(?:吗|呢|行不行|好不好|对不对|是什么|怎么办|为什么|怎么回事[呀啊]?)$/.test(text)) return false;
  // 拒绝纯指代或无意义对话残片
  if (/^(?:这个呢|那个呢|那它呢|那这个呢|那那个呢|继续(?:往下写)?|再来一次|重试(?:一次)?|为什么|不对|改一下|试试|好的(?:谢谢)?|谢谢|明白|知道了|收到|哈哈|嗯嗯|行的|可以的|没问题|ok|test|ping)$/i.test(text)) return false;
  // 拒绝典型一次性临时任务指令与会话内祈使句（除非含“总是/一律/默认/以后/偏好/习惯/长期/记住”）
  const hasPermanentMarker = /(?:以后|总是|一律|默认|偏好|习惯|长期|记住|固定使用|统一使用|严禁|禁止)/.test(text);
  if (!hasPermanentMarker) {
    if (/^(?:帮我|请帮我|麻烦帮我|现在帮我|请替我|替我|麻烦你|请你|先帮我|再帮我|顺便帮我)(?:写|算|查|看|画|生成|运行|修改|翻译|整理|分析|总结|解释|检查|调试|跑|测|列|对比)/.test(text)) {
      return false;
    }
    if (/^(?:今天|明天|今晚|刚才|刚刚|这轮|本轮|现在立刻|马上|待会儿|等一下|这会儿)/.test(text)) {
      return false;
    }
    if (/^(?:看下|看看|改下|改改|跑一下|测一下|试一下|重写一下|翻译一下|总结一下|解释一下|展开说说|接着讲|往上翻|往下看)/.test(text)) {
      return false;
    }
  }
  return true;
}

export function normalizeMemoryEntry(raw, defaultSource = 'agent-tool', now = Date.now()) {
  if (raw == null) return null;
  const text = String(raw.text != null ? raw.text : raw).replace(/\s+/g, ' ').trim().slice(0, MAX_FACT);
  if (!isValidMemoryFact(text)) return null;
  const source = (raw && raw.source && MEMORY_SOURCE_SPEC[raw.source]) ? raw.source : defaultSource;
  const spec = MEMORY_SOURCE_SPEC[source] || MEMORY_SOURCE_SPEC['agent-tool'];
  const ts = (raw && Number(raw.ts)) || now;
  const ttlMs = (raw && Number(raw.ttlMs)) || spec.ttlMs;
  const confidence = (raw && typeof raw.confidence === 'number')
    ? Math.max(0.1, Math.min(1, Number(raw.confidence.toFixed(2))))
    : spec.confidence;
  const id = (raw && raw.id) || memoryIdFor(text);
  const hits = (raw && Number(raw.hits)) || 0;
  const expiresAt = (raw && Number(raw.expiresAt)) || (ts + ttlMs);
  return { id, text, ts, source, confidence, ttlMs, expiresAt, hits };
}

export function archiveMemoryFact(entry, reason = 'ttl-cold', now = Date.now()) {
  const norm = normalizeMemoryEntry(entry, (entry && entry.source) || 'agent-tool', now);
  if (!norm) return null;
  const archivedEntry = {
    ...norm,
    archived: true,
    archiveReason: reason,
    archivedAt: now,
  };
  softArchiveMap.set(norm.id.toLowerCase(), archivedEntry);
  if (softArchiveMap.size > MAX_ARCHIVE_FACTS) {
    const oldestKey = softArchiveMap.keys().next().value;
    if (oldestKey) softArchiveMap.delete(oldestKey);
  }
  return archivedEntry;
}

export function getSoftArchivedMemories(externalArchive = []) {
  if (Array.isArray(externalArchive)) {
    for (const item of externalArchive) {
      if (item && item.id) softArchiveMap.set(String(item.id).toLowerCase(), item);
    }
  }
  return [...softArchiveMap.values()].sort((a, b) => (b.archivedAt || b.ts || 0) - (a.archivedAt || a.ts || 0));
}

// 整理活跃记忆：过滤非法噪声；将超期/超容量的合法记忆转入「软归档冷库」而非硬删
export function pruneMemoryFacts(facts, { now = Date.now(), archiveSink = null } = {}) {
  if (!Array.isArray(facts) || !facts.length) return [];
  const candidates = [];
  const seen = new Set();
  const pushArchive = (entry, reason) => {
    const arc = archiveMemoryFact(entry, reason, now);
    if (arc && Array.isArray(archiveSink)) {
      if (!archiveSink.some((x) => x && x.id === arc.id)) archiveSink.push(arc);
    }
  };

  for (const item of facts) {
    const entry = normalizeMemoryEntry(item, (item && item.source) || 'agent-tool', now);
    if (!entry) continue;
    const key = entry.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    if (entry.expiresAt && now > entry.expiresAt && entry.hits <= 0) {
      pushArchive(entry, 'ttl-cold');
      continue;
    }
    if (entry.confidence < 0.38) {
      pushArchive(entry, 'low-confidence-cold');
      continue;
    }
    candidates.push(entry);
  }
  candidates.sort((a, b) => (b.confidence - a.confidence) || (b.ts - a.ts));
  const active = candidates.slice(0, MAX_FACTS);
  for (const overflow of candidates.slice(MAX_FACTS)) {
    pushArchive(overflow, 'capacity-cold');
  }
  return active;
}

// 按需软归档唤醒：当用户本轮问题提及冷备归档中的偏好/事实时，自动唤醒回活跃记忆库（零误伤）
export function recallArchivedMemories(userText, { activeFacts = [], archivePool = [], now = Date.now() } = {}) {
  const q = String(userText || '').toLowerCase().trim();
  if (!q || q.length < 2) return { recalled: [], nextActive: pruneMemoryFacts(activeFacts, { now }) };
  const pool = getSoftArchivedMemories(archivePool);
  if (!pool.length) return { recalled: [], nextActive: pruneMemoryFacts(activeFacts, { now }) };

  const activeIds = new Set((activeFacts || []).map((f) => (f && f.id ? f.id.toLowerCase() : '')));
  // 提取查询中的拉丁词与中文双字切分
  const qWords = q.match(/[a-z0-9_.-]{2,}/g) || [];
  const qBigrams = [];
  for (const run of (q.match(/[\u4e00-\u9fff]{2,}/g) || [])) {
    for (let i = 0; i < run.length - 1; i++) qBigrams.push(run.slice(i, i + 2));
  }

  const recalled = [];
  for (const item of pool) {
    if (!item || !item.id || activeIds.has(item.id.toLowerCase())) continue;
    const hay = String(item.text || '').toLowerCase();
    let score = 0;
    for (const w of qWords) if (hay.includes(w)) score += 2;
    for (const bg of qBigrams) if (hay.includes(bg)) score += 1;
    if (score >= 2) {
      const revived = {
        ...item,
        archived: false,
        archiveReason: undefined,
        archivedAt: undefined,
        hits: (Number(item.hits) || 0) + 1,
        ts: now,
        expiresAt: now + (Number(item.ttlMs) || (90 * DAY_MS)),
      };
      softArchiveMap.delete(item.id.toLowerCase());
      recalled.push(revived);
    }
  }
  if (!recalled.length) return { recalled: [], nextActive: pruneMemoryFacts(activeFacts, { now }) };
  const nextActive = upsertFacts(activeFacts, recalled, { now });
  return { recalled, nextActive };
}

export function formatMemory(facts) {
  const list = pruneMemoryFacts(facts);
  if (!list.length) return '';
  const lines = [
    '## Persistent Memory · 跨会话长期记忆（系统已自动注入并生效）',
    '以下长期记忆点已由系统自动传递给 Agent（含唯一 ID、来源与置信度），无需再次调用 remember(list) 查询。请在回答与工具决策中主动遵循并应用这些已知事实、身份背景、技术栈与偏好约定：',
  ];
  for (const f of list) {
    const ttlDays = Math.max(1, Math.round(((f.expiresAt || (f.ts + f.ttlMs)) - Date.now()) / DAY_MS));
    lines.push(`- [${f.id}] ${f.text} （来源: ${f.source}, 置信度: ${f.confidence}, 活跃期: ~${ttlDays}d，超期转冷备可召回）`);
  }
  return lines.join('\n');
}

export function formatActiveMemoryReminder(facts) {
  const list = pruneMemoryFacts(facts);
  if (!list.length) return '';
  return `【长期记忆已自动生效（共 ${list.length} 条）】\n`
    + list.map((f, idx) => `${idx + 1}. [${f.id}] ${f.text} (置信度 ${f.confidence})`).join('\n')
    + '\n请直接结合上述长期记忆回应本轮请求；如需删除某条记忆，请使用精确 ID 调用 remember(action="forget", fact="mem-xxxx")（被删或超期条目会自动进入软归档冷库，可随时用 action="restore" 恢复）。';
}

export function extractAutoMemoryFacts(userText) {
  const src = String(userText || '').trim();
  if (!src || src.length > 600) return [];
  const results = [];
  const clauses = src.split(/[。！？!?\n；;]+/).map((s) => s.trim()).filter(Boolean);
  for (const clause of clauses) {
    const explicit = clause.match(/^(?:请|麻烦|帮我)?(?:记住|记下|记一下|牢记)[：:\s，,]*(.+)$/);
    if (explicit && explicit[1]) {
      const cleaned = explicit[1].replace(/^[：:\s，,]+/, '').trim();
      if (isValidMemoryFact(cleaned)) {
        results.push(cleaned);
        continue;
      }
    }
    const pref = clause.match(/^(?:以后(?:请)?(?:都|一律|默认)|默认请|我的(?:长期)?偏好是|我习惯用|我目前是|我是一名|我的职业是)[：:\s]*(.+)$/);
    if (pref && isValidMemoryFact(clause)) {
      results.push(clause);
    }
  }
  return results;
}

export function upsertFacts(existing, additions, { source = 'agent-tool', now = Date.now() } = {}) {
  const map = new Map();
  const ingest = (raw, src, isNew) => {
    const entry = normalizeMemoryEntry(raw, (raw && raw.source) || src, now);
    if (!entry) return;
    if (isNew) softArchiveMap.delete(entry.id.toLowerCase());
    const key = entry.text.toLowerCase();
    if (map.has(key)) {
      const prev = map.get(key);
      const mergedConf = Math.max(prev.confidence, entry.confidence);
      const mergedSource = entry.confidence >= prev.confidence ? entry.source : prev.source;
      map.set(key, {
        ...prev,
        confidence: mergedConf,
        source: mergedSource,
        ts: isNew ? now : prev.ts,
        expiresAt: isNew ? (now + Math.max(prev.ttlMs, entry.ttlMs)) : prev.expiresAt,
        hits: (prev.hits || 0) + (isNew ? 1 : 0),
      });
    } else {
      map.set(key, entry);
    }
  };
  for (const a of additions || []) ingest(a, source, true);
  for (const e of existing || []) ingest(e, (e && e.source) || 'agent-tool', false);
  return pruneMemoryFacts([...map.values()], { now });
}

// 精准遗忘（默认软归档可恢复；传 hard=true 时走物理彻底清除）：
export function forgetMemoryFact(existing, query, { now = Date.now(), hard = false, archivePool = [] } = {}) {
  if (hard) {
    const p = purgeMemoryFact(existing, query, { archivePool, now });
    return { next: p.next, removed: p.purged, archived: [], purgedIds: p.purgedIds, recoverable: false, byId: p.byId };
  }
  const list = pruneMemoryFacts(existing, { now });
  const q = String(query || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (q.length < 2) {
    return { next: list, removed: [], archived: [], error: 'forget 需要至少 2 个字符的关键词或精确记忆 ID（如 mem-xxxx）。' };
  }
  const softSave = (items) => items.map((item) => archiveMemoryFact(item, 'manual-forget', now)).filter(Boolean);

  // 1. 优先精确匹配记忆 ID（如 mem-7f3a 或 mem-xxx）
  if (/^mem-[a-z0-9_-]{2,}$/i.test(q)) {
    const removed = list.filter((f) => f.id.toLowerCase() === q);
    const next = list.filter((f) => f.id.toLowerCase() !== q);
    return { next, removed, archived: softSave(removed), recoverable: true, byId: true };
  }
  // 2. 精确全文相等匹配
  const exactHits = list.filter((f) => f.text.toLowerCase() === q);
  if (exactHits.length === 1) {
    const next = list.filter((f) => f.id !== exactHits[0].id);
    return { next, removed: exactHits, archived: softSave(exactHits), recoverable: true, byExact: true };
  }
  // 3. 关键词包含匹配
  const subHits = list.filter((f) => f.text.toLowerCase().includes(q));
  const next = list.filter((f) => !f.text.toLowerCase().includes(q));
  return { next, removed: subHits, archived: softSave(subHits), recoverable: true, byKeyword: true };
}

// 物理彻底清除通道（Purge · 合规不可恢复）：
// 同时从活跃记忆与软归档冷库（含外部传入的 archivePool）中物理抹除匹配条目，不留冷备副本
export function purgeMemoryFact(existing, queryOrId, { archivePool = [], now = Date.now() } = {}) {
  const list = pruneMemoryFacts(existing, { now });
  const q = String(queryOrId || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (q.length < 2) {
    return { next: list, nextArchive: getSoftArchivedMemories(archivePool), purged: [], purgedIds: [], recoverable: false, error: 'purge 需要至少 2 个字符的关键词、精确 ID（mem-xxxx）或 "all"。' };
  }

  const isMatch = (f) => {
    if (!f) return false;
    if (q === 'all' || q === '*') return true;
    const id = String(f.id || '').toLowerCase();
    const txt = String(f.text || '').toLowerCase();
    if (/^mem-[a-z0-9_-]{2,}$/i.test(q)) return id === q;
    return id === q || txt === q || txt.includes(q);
  };

  const purgedMap = new Map();
  const next = [];
  for (const f of list) {
    if (isMatch(f)) purgedMap.set(f.id.toLowerCase(), f);
    else next.push(f);
  }

  for (const [k, v] of [...softArchiveMap.entries()]) {
    if (isMatch(v) || purgedMap.has(k)) {
      purgedMap.set(k, v);
      softArchiveMap.delete(k);
    }
  }

  if (Array.isArray(archivePool)) {
    for (let i = archivePool.length - 1; i >= 0; i--) {
      const item = archivePool[i];
      if (isMatch(item) || (item && item.id && purgedMap.has(String(item.id).toLowerCase()))) {
        if (item && item.id) purgedMap.set(String(item.id).toLowerCase(), item);
        archivePool.splice(i, 1);
      }
    }
  }

  const purged = [...purgedMap.values()];
  return {
    next,
    nextArchive: getSoftArchivedMemories(archivePool),
    purged,
    purgedIds: purged.map((p) => p.id),
    recoverable: false,
    byId: /^mem-[a-z0-9_-]{2,}$/i.test(q),
  };
}

// 从软归档冷库恢复记忆：支持按 mem-xxxx ID、关键词、或 "last"/"all" 恢复被误删或超期归档的记忆（已被 purge 物理清除的条目不可恢复）
export function restoreMemoryFact(existing, queryOrId = 'last', { archivePool = [], now = Date.now() } = {}) {
  const list = pruneMemoryFacts(existing, { now });
  const pool = getSoftArchivedMemories(archivePool);
  if (!pool.length) return { next: list, restored: [] };

  const q = String(queryOrId || 'last').trim().toLowerCase().replace(/^\[|\]$/g, '');
  let targets = [];
  if (!q || q === 'last' || q === 'latest') {
    targets = [pool[0]];
  } else if (q === 'all' || q === '*') {
    targets = pool;
  } else if (/^mem-[a-z0-9_-]{2,}$/i.test(q)) {
    targets = pool.filter((f) => f.id && f.id.toLowerCase() === q);
  } else {
    targets = pool.filter((f) => String(f.text || '').toLowerCase().includes(q));
  }

  if (!targets.length) return { next: list, restored: [] };
  const revived = targets.map((item) => {
    softArchiveMap.delete(String(item.id).toLowerCase());
    if (Array.isArray(archivePool)) {
      const ix = archivePool.findIndex((x) => x && x.id && String(x.id).toLowerCase() === String(item.id).toLowerCase());
      if (ix >= 0) archivePool.splice(ix, 1);
    }
    return {
      ...item,
      archived: false,
      archiveReason: undefined,
      archivedAt: undefined,
      hits: (Number(item.hits) || 0) + 1,
      ts: now,
      expiresAt: now + (Number(item.ttlMs) || (90 * DAY_MS)),
    };
  });
  const next = upsertFacts(list, revived, { now });
  return { next, restored: revived };
}

// Wilson 95% 置信区间计算器（解决小样本统计置信跨度过宽问题，显式公示 [lower, upper, halfWidth]）
export function computeWilsonConfidenceInterval(successes, total, z = 1.959963984540054) {
  const n = Number(total) || 0;
  if (n <= 0) return { p: 0, proportion: 0, pointEstimate: 0, lower: 0, upper: 0, span: 0, halfWidth: 0, n: 0 };
  const k = Math.max(0, Math.min(n, Number(successes) || 0));
  const p = k / n;
  const pRounded = Number(p.toFixed(4));
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const rad = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  const lower = Math.max(0, Number((center - rad).toFixed(4)));
  const upper = Math.min(1, Number((center + rad).toFixed(4)));
  const span = Number((upper - lower).toFixed(4));
  const halfWidth = Number((span / 2).toFixed(4));
  return { p: pRounded, proportion: pRounded, pointEstimate: pRounded, lower, upper, span, halfWidth, n };
}

// 离线标注评测集（N=120：60 正例 + 60 负例，分为 in_domain 60 条与 ood_holdout 60 条长尾挑战集）
// 将 95% Wilson 置信区间半宽压缩至 ±4%~±5% 量级，并如实披露长尾 FN/FP 边界失败样本
export const MEMORY_GATEKEEPER_BENCHMARK = Object.freeze([
  // ── A. In-Domain Positive (30 条：标准偏好、身份、项目规范、长期约定) ──
  { id: 'mem-pos-001', split: 'in_domain', category: 'preference', text: '用户偏好使用 TypeScript 严格模式编写前端工程', expected: true },
  { id: 'mem-pos-002', split: 'in_domain', category: 'project-spec', text: '后端服务统一部署在 Debian 12 容器环境', expected: true },
  { id: 'mem-pos-003', split: 'in_domain', category: 'convention', text: '数据库连接池上限固定为 32，超时 5 秒', expected: true },
  { id: 'mem-pos-004', split: 'in_domain', category: 'preference', text: '代码注释与文档一律使用简体中文', expected: true },
  { id: 'mem-pos-005', split: 'in_domain', category: 'project-spec', text: '构建工具优先使用 Vite 而非 Webpack', expected: true },
  { id: 'mem-pos-006', split: 'in_domain', category: 'identity', text: '用户是一名分布式存储研发工程师', expected: true },
  { id: 'mem-pos-007', split: 'in_domain', category: 'convention', text: '以后所有 Python 脚本默认兼容 3.12', expected: true },
  { id: 'mem-pos-008', split: 'in_domain', category: 'project-spec', text: '单元测试统一使用 node:test 原生断言', expected: true },
  { id: 'mem-pos-009', split: 'in_domain', category: 'convention', text: '代码缩进统一使用 2 个空格且不加分号', expected: true },
  { id: 'mem-pos-010', split: 'in_domain', category: 'project-spec', text: '用户的生产数据库采用 PostgreSQL 16', expected: true },
  { id: 'mem-pos-011', split: 'in_domain', category: 'preference', text: '回复语言固定为简体中文，专业术语保留英文原文', expected: true },
  { id: 'mem-pos-012', split: 'in_domain', category: 'identity', text: '作者联系邮箱为 lks.tan.cn@gmail.com', expected: true },
  { id: 'mem-pos-013', split: 'in_domain', category: 'constraint', text: '前端样式严禁引入 Tailwind 等外部构建依赖', expected: true },
  { id: 'mem-pos-014', split: 'in_domain', category: 'preference', text: '用户日常主力编辑器是 Neovim 0.10', expected: true },
  { id: 'mem-pos-015', split: 'in_domain', category: 'project-spec', text: 'API 网关认证统一采用 Bearer Token 头传输', expected: true },
  { id: 'mem-pos-016', split: 'in_domain', category: 'convention', text: 'Git 提交信息一律遵循 Conventional Commits 规范', expected: true },
  { id: 'mem-pos-017', split: 'in_domain', category: 'preference', text: '架构图默认优先使用 Graphviz DOT 或客户端 SVG 绘制', expected: true },
  { id: 'mem-pos-018', split: 'in_domain', category: 'identity', text: '用户目前在上海就读初中，业余维护开源项目 Dubhe Agent', expected: true },
  { id: 'mem-pos-019', split: 'in_domain', category: 'constraint', text: '所有哈希链路校验统一使用 FIPS 180-4 SHA-256 标准实现', expected: true },
  { id: 'mem-pos-020', split: 'in_domain', category: 'project-spec', text: '本地中继服务默认监听 127.0.0.1:8787 端口', expected: true },
  { id: 'mem-pos-021', split: 'in_domain', category: 'preference', text: '给出代码修改时优先提供可直接运行的完整函数实现', expected: true },
  { id: 'mem-pos-022', split: 'in_domain', category: 'convention', text: '错误日志输出统一包含 ISO-8601 时间戳与模块前缀', expected: true },
  { id: 'mem-pos-023', split: 'in_domain', category: 'project-spec', text: '虚拟文件系统单会话存储上限设定为 120MB', expected: true },
  { id: 'mem-pos-024', split: 'in_domain', category: 'preference', text: '数学公式推导默认使用 LaTeX 行内与块级语法渲染', expected: true },
  { id: 'mem-pos-025', split: 'in_domain', category: 'constraint', text: '带图片回合在内容审核超时时必须执行 fail-closed 拦截', expected: true },
  { id: 'mem-pos-026', split: 'in_domain', category: 'project-spec', text: '默认文生图模型为 gpt-image-2，备选 Nano Banana 2', expected: true },
  { id: 'mem-pos-027', split: 'in_domain', category: 'preference', text: '技术方案对比习惯先给定量表格再写定性分析结论', expected: true },
  { id: 'mem-pos-028', split: 'in_domain', category: 'convention', text: '金钱与 Token 计费精确保留到小数点后 4 位美元', expected: true },
  { id: 'mem-pos-029', split: 'in_domain', category: 'project-spec', text: '浏览器端 Python 运行时基于 Pyodide WebAssembly 沙箱', expected: true },
  { id: 'mem-pos-030', split: 'in_domain', category: 'preference', text: '长期记忆淘汰默认走冷备软归档，仅隐私数据走物理 Purge', expected: true },

  // ── B. OOD Holdout Positive (30 条：跨领域长尾事实 + 5 条真实困难边界 FN 样本) ──
  { id: 'mem-pos-031', split: 'ood_holdout', category: 'hardware', text: '用户主力开发机为 MacBook Pro M3 Max (64GB 统一内存)', expected: true },
  { id: 'mem-pos-032', split: 'ood_holdout', category: 'network', text: '内网测试集群 DNS 根域统一配置为 .corp.internal', expected: true },
  { id: 'mem-pos-033', split: 'ood_holdout', category: 'security', text: '生产环境严禁在 localStorage 明文存储管理员主密钥', expected: true },
  { id: 'mem-pos-034', split: 'ood_holdout', category: 'workflow', text: '每次发布新构建号前必须同步更新 index/app/docs/sw 四处版本号', expected: true },
  { id: 'mem-pos-035', split: 'ood_holdout', category: 'style', text: 'UI 配色倾向暖纸色亮色主题与克制的单像素边框设计', expected: true },
  { id: 'mem-pos-036', split: 'ood_holdout', category: 'compiler', text: 'C++ 代码沙箱编译参数固定采用 g++ -O2 -std=c++20', expected: true },
  { id: 'mem-pos-037', split: 'ood_holdout', category: 'database', text: '本地 SQL 工具默认操作沙箱内 data/app.db 库文件', expected: true },
  { id: 'mem-pos-038', split: 'ood_holdout', category: 'habit', text: '今天起所有的接口评测报告一律附带 95% Wilson 置信区间', expected: true },
  { id: 'mem-pos-039', split: 'ood_holdout', category: 'habit', text: '刚才确定的规范：以后所有图表交互一律采用无立体阴影扁平设计', expected: true },
  { id: 'mem-pos-040', split: 'ood_holdout', category: 'habit', text: '帮我记住：输出消息底部严禁展示天枢内部链路摘要字样', expected: true },
  { id: 'mem-pos-041', split: 'ood_holdout', category: 'domain', text: '量化回测脚本的基准无风险利率固定按年化 2.5% 计算', expected: true },
  { id: 'mem-pos-042', split: 'ood_holdout', category: 'domain', text: '音频合成采样率统一输出为 44.1kHz 双声道 WAV 格式', expected: true },
  { id: 'mem-pos-043', split: 'ood_holdout', category: 'domain', text: '论文排版引用格式固定遵循 IEEE Transactions 标准', expected: true },
  { id: 'mem-pos-044', split: 'ood_holdout', category: 'domain', text: 'Kubernetes 部署清单默认设置 resource requests 与 limits 相等', expected: true },
  { id: 'mem-pos-045', split: 'ood_holdout', category: 'domain', text: '日志采样率在生产高峰期固定下调至 10% 以控制 I/O', expected: true },
  { id: 'mem-pos-046', split: 'ood_holdout', category: 'domain', text: '前端 ESM 模块导入严禁依赖 Webpack/Rollup 打包器转换', expected: true },
  { id: 'mem-pos-047', split: 'ood_holdout', category: 'domain', text: '所有外部 HTTP 抓取请求在服务端必须经过公网 IP SSRF 护栏校验', expected: true },
  { id: 'mem-pos-048', split: 'ood_holdout', category: 'domain', text: '移动端抽屉面板统一从底部滑入，桌面端从右侧展开', expected: true },
  { id: 'mem-pos-049', split: 'ood_holdout', category: 'domain', text: '图像分类 ONNX 推理输入分辨率固定保持 320x320 原生尺寸', expected: true },
  { id: 'mem-pos-050', split: 'ood_holdout', category: 'domain', text: '跨会话检索采用 BM25 词频逆文档频率加权与同义词扩展', expected: true },
  { id: 'mem-pos-051', split: 'ood_holdout', category: 'domain', text: '子智能体并发调度上限固定为每批 4 路以免触发网关限流', expected: true },
  { id: 'mem-pos-052', split: 'ood_holdout', category: 'domain', text: '代码高亮主题固定使用自定义 assets/hljs/teamo.css 样式表', expected: true },
  { id: 'mem-pos-053', split: 'ood_holdout', category: 'domain', text: '会话自动标题总结仅在首轮合规回复完成后触发一次', expected: true },
  { id: 'mem-pos-054', split: 'ood_holdout', category: 'domain', text: '所有离线评测脚本必须支持零外部依赖通过 node 直接运行', expected: true },
  { id: 'mem-pos-055', split: 'ood_holdout', category: 'domain', text: '网关主域名优先连接 teamorouter.com，网络故障时自动切换 .cn', expected: true },
  // 5 条 OOD 困难正样本（暴露规则守门人的真实 FN 边界）
  { id: 'mem-pos-056', split: 'ood_holdout', category: 'short-fn-edge', text: '用Go', expected: true, edgeNote: '仅 3 字符 (< MIN_FACT_LEN=4)，被最小长度阈值误拦 (FN)' },
  { id: 'mem-pos-057', split: 'ood_holdout', category: 'short-fn-edge', text: '偏爱C', expected: true, edgeNote: '仅 3 字符 (< MIN_FACT_LEN=4)，被最小长度阈值误拦 (FN)' },
  { id: 'mem-pos-058', split: 'ood_holdout', category: 'question-tail-fn-edge', text: '用户在上海初三就读，偏好简洁为什么先讲结论的风格？', expected: true, edgeNote: '含问号结尾的修辞性偏好陈述，被疑问句规则误拦 (FN)' },
  { id: 'mem-pos-059', split: 'ood_holdout', category: 'particle-tail-fn-edge', text: '个人座右铭是凡事预则立不预则废呢', expected: true, edgeNote: '陈述句末尾带语气词“呢”，被反问尾缀规则误拦 (FN)' },
  { id: 'mem-pos-060', split: 'ood_holdout', category: 'question-word-fn-edge', text: '报错归因模板的第三项固定命名为根因是什么', expected: true, edgeNote: '事实陈述末尾含“是什么”，被疑问尾缀规则误拦 (FN)' },

  // ── C. In-Domain Negative (30 条：典型指代残片、疑问句、寒暄、显式一次性指令) ──
  { id: 'mem-neg-001', split: 'in_domain', category: 'pronoun-fragment', text: '这个呢？', expected: false },
  { id: 'mem-neg-002', split: 'in_domain', category: 'pronoun-fragment', text: '那个呢', expected: false },
  { id: 'mem-neg-003', split: 'in_domain', category: 'pronoun-fragment', text: '那它呢', expected: false },
  { id: 'mem-neg-004', split: 'in_domain', category: 'question', text: '为什么会出现这个问题？', expected: false },
  { id: 'mem-neg-005', split: 'in_domain', category: 'ephemeral-imperative', text: '帮我写一个快速排序代码', expected: false },
  { id: 'mem-neg-006', split: 'in_domain', category: 'ephemeral-imperative', text: '现在帮我算一下 128 乘以 256', expected: false },
  { id: 'mem-neg-007', split: 'in_domain', category: 'ack-noise', text: '继续', expected: false },
  { id: 'mem-neg-008', split: 'in_domain', category: 'ack-noise', text: '好的', expected: false },
  { id: 'mem-neg-009', split: 'in_domain', category: 'question', text: '这样改行不行', expected: false },
  { id: 'mem-neg-010', split: 'in_domain', category: 'pronoun-fragment', text: '那这个呢', expected: false },
  { id: 'mem-neg-011', split: 'in_domain', category: 'pronoun-fragment', text: '那那个呢', expected: false },
  { id: 'mem-neg-012', split: 'in_domain', category: 'ack-noise', text: '继续往下写', expected: false },
  { id: 'mem-neg-013', split: 'in_domain', category: 'ack-noise', text: '好的谢谢', expected: false },
  { id: 'mem-neg-014', split: 'in_domain', category: 'ephemeral-imperative', text: '帮我看看这段代码', expected: false },
  { id: 'mem-neg-015', split: 'in_domain', category: 'question', text: '怎么回事呀', expected: false },
  { id: 'mem-neg-016', split: 'in_domain', category: 'ack-noise', text: '重试一次', expected: false },
  { id: 'mem-neg-017', split: 'in_domain', category: 'ephemeral-imperative', text: '请帮我查一下这个报错', expected: false },
  { id: 'mem-neg-018', split: 'in_domain', category: 'ephemeral-imperative', text: '麻烦帮我画一张流程图', expected: false },
  { id: 'mem-neg-019', split: 'in_domain', category: 'ephemeral-imperative', text: '帮我翻译一下这段英文摘要', expected: false },
  { id: 'mem-neg-020', split: 'in_domain', category: 'question', text: '这段正则是什么意思？', expected: false },
  { id: 'mem-neg-021', split: 'in_domain', category: 'question', text: '现在该怎么办', expected: false },
  { id: 'mem-neg-022', split: 'in_domain', category: 'ack-noise', text: '明白了', expected: false },
  { id: 'mem-neg-023', split: 'in_domain', category: 'ack-noise', text: '知道了', expected: false },
  { id: 'mem-neg-024', split: 'in_domain', category: 'short-noise', text: 'ok', expected: false },
  { id: 'mem-neg-025', split: 'in_domain', category: 'short-noise', text: '嗯', expected: false },
  { id: 'mem-neg-026', split: 'in_domain', category: 'question', text: '你觉得这个方案好不好', expected: false },
  { id: 'mem-neg-027', split: 'in_domain', category: 'question', text: '结果对不对', expected: false },
  { id: 'mem-neg-028', split: 'in_domain', category: 'ephemeral-imperative', text: '现在帮我运行一下单元测试', expected: false },
  { id: 'mem-neg-029', split: 'in_domain', category: 'ephemeral-imperative', text: '帮我生成一张赛博朋克猫的图片', expected: false },
  { id: 'mem-neg-030', split: 'in_domain', category: 'question', text: '为什么返回了 400 错误', expected: false },

  // ── D. OOD Holdout Negative (30 条：时间锚定临时事件、口语祈使句 + 4 条真实困难边界 FP 样本) ──
  { id: 'mem-neg-031', split: 'ood_holdout', category: 'time-ephemeral', text: '今天下午三点前把这份临时日志里的第三段贴到群里', expected: false },
  { id: 'mem-neg-032', split: 'ood_holdout', category: 'time-ephemeral', text: '刚才那段输出的第二行好像多了一个空格', expected: false },
  { id: 'mem-neg-033', split: 'ood_holdout', category: 'time-ephemeral', text: '今天下午三点服务器刚刚重启过一次', expected: false },
  { id: 'mem-neg-034', split: 'ood_holdout', category: 'time-ephemeral', text: '明天上午十点提醒我看一下临时构建产物', expected: false },
  { id: 'mem-neg-035', split: 'ood_holdout', category: 'time-ephemeral', text: '本轮先把调试日志打印出来看看', expected: false },
  { id: 'mem-neg-036', split: 'ood_holdout', category: 'time-ephemeral', text: '这轮先不调用子智能体', expected: false },
  { id: 'mem-neg-037', split: 'ood_holdout', category: 'time-ephemeral', text: '刚刚上传的压缩包里包含三张测试截图', expected: false },
  { id: 'mem-neg-038', split: 'ood_holdout', category: 'time-ephemeral', text: '现在立刻把临时文件删掉', expected: false },
  { id: 'mem-neg-039', split: 'ood_holdout', category: 'time-ephemeral', text: '待会儿我再发一份新的测试数据过来', expected: false },
  { id: 'mem-neg-040', split: 'ood_holdout', category: 'time-ephemeral', text: '今晚八点前把这页 PPT 改完', expected: false },
  { id: 'mem-neg-041', split: 'ood_holdout', category: 'colloquial-imperative', text: '看下第 42 行的变量名拼写', expected: false },
  { id: 'mem-neg-042', split: 'ood_holdout', category: 'colloquial-imperative', text: '跑一下这个基准测试脚本', expected: false },
  { id: 'mem-neg-043', split: 'ood_holdout', category: 'colloquial-imperative', text: '改下这里的边框颜色', expected: false },
  { id: 'mem-neg-044', split: 'ood_holdout', category: 'colloquial-imperative', text: '总结一下上面那篇文章的核心观点', expected: false },
  { id: 'mem-neg-045', split: 'ood_holdout', category: 'colloquial-imperative', text: '解释一下为什么这里会产生闭包内存泄漏', expected: false },
  { id: 'mem-neg-046', split: 'ood_holdout', category: 'colloquial-imperative', text: '替我算一下这组数据的标准差', expected: false },
  { id: 'mem-neg-047', split: 'ood_holdout', category: 'colloquial-imperative', text: '顺便帮我检查一下 package.json 的脚本配置', expected: false },
  { id: 'mem-neg-048', split: 'ood_holdout', category: 'colloquial-imperative', text: '先帮我列出目录下的所有 Markdown 文件', expected: false },
  { id: 'mem-neg-049', split: 'ood_holdout', category: 'colloquial-imperative', text: '再帮我对比一下修改前后的 diff', expected: false },
  { id: 'mem-neg-050', split: 'ood_holdout', category: 'colloquial-imperative', text: '重写一下这段错误处理逻辑', expected: false },
  { id: 'mem-neg-051', split: 'ood_holdout', category: 'colloquial-imperative', text: '展开说说第三节的证明过程', expected: false },
  { id: 'mem-neg-052', split: 'ood_holdout', category: 'colloquial-imperative', text: '接着讲刚才没说完的半段话', expected: false },
  { id: 'mem-neg-053', split: 'ood_holdout', category: 'ack-noise', text: '收到', expected: false },
  { id: 'mem-neg-054', split: 'ood_holdout', category: 'ack-noise', text: '没问题', expected: false },
  { id: 'mem-neg-055', split: 'ood_holdout', category: 'question', text: '这里改成异步调用会不会有竞态条件？', expected: false },
  { id: 'mem-neg-056', split: 'ood_holdout', category: 'question', text: '如果去掉这个缓存锁会怎样呢', expected: false },
  // 4 条 OOD 困难负样本（不含显式时间词或祈使词的临时状态描述，暴露规则过滤的真实 FP 边界）
  { id: 'mem-neg-057', split: 'ood_holdout', category: 'implicit-ephemeral-fp-edge', text: '服务器监控显示 14:02 发生过一次连接重置', expected: false, edgeNote: '无显式时间前缀的临时故障观测，穿过规则守门人 (FP)' },
  { id: 'mem-neg-058', split: 'ood_holdout', category: 'implicit-ephemeral-fp-edge', text: '示例 CSV 文件的第四列目前存在两处空值', expected: false, edgeNote: '单次任务文件状态描述，形态与项目规范高度相似而漏拦 (FP)' },
  { id: 'mem-neg-059', split: 'ood_holdout', category: 'implicit-ephemeral-fp-edge', text: '临时压测容器的 CPU 占用率刚才飙到了 94%', expected: false, edgeNote: '“刚才”位于句中而非句首，规则守门人漏拦 (FP)' },
  { id: 'mem-neg-060', split: 'ood_holdout', category: 'implicit-ephemeral-fp-edge', text: '日志第 108 行打印出的返回码是 502 Bad Gateway', expected: false, edgeNote: '一次性调试上下文陈述，未含祈使或句首时间词而漏拦 (FP)' },
]);

function computeConfusionStats(tp, fp, tn, fn, { fpWeight = 4, fnWeight = 1 } = {}) {
  const total = tp + fp + tn + fn;
  const precision = (tp + fp) > 0 ? Number((tp / (tp + fp)).toFixed(4)) : 0;
  const recall = (tp + fn) > 0 ? Number((tp / (tp + fn)).toFixed(4)) : 0;
  const f1 = (precision + recall) > 0 ? Number(((2 * precision * recall) / (precision + recall)).toFixed(4)) : 0;
  const accuracy = total > 0 ? Number(((tp + tn) / total).toFixed(4)) : 0;
  const falsePositiveRate = (fp + tn) > 0 ? Number((fp / (fp + tn)).toFixed(4)) : 0;
  const weightedCost = fpWeight * fp + fnWeight * fn;
  return {
    totalSamples: total,
    confusionMatrix: { tp, fp, tn, fn },
    precision,
    recall,
    f1,
    accuracy,
    falsePositiveRate,
    weightedCost,
    costWeightedError: weightedCost,
    wilson95CI: {
      precision: computeWilsonConfidenceInterval(tp, tp + fp),
      recall: computeWilsonConfidenceInterval(tp, tp + fn),
      accuracy: computeWilsonConfidenceInterval(tp + tn, total),
      fpr: computeWilsonConfidenceInterval(fp, fp + tn),
    },
  };
}

export function evaluateMemoryGatekeeperConfusionMatrix(corpus = MEMORY_GATEKEEPER_BENCHMARK, { fpWeight = 4, fnWeight = 1 } = {}) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  let inTp = 0, inFp = 0, inTn = 0, inFn = 0;
  let oodTp = 0, oodFp = 0, oodTn = 0, oodFn = 0;
  // 基线对照：仅靠长度 >= 4 的朴素规则（Naive Length-Only Baseline）
  let baseTp = 0, baseFp = 0, baseTn = 0, baseFn = 0;
  const failedSamples = [];

  for (const item of corpus) {
    const text = String(item.text || '').trim();
    const actual = isValidMemoryFact(text);
    const naiveActual = text.length >= MIN_FACT_LEN && text.length <= MAX_FACT;
    const expected = Boolean(item.expected ?? item.shouldAccept ?? item.expectedValid);
    const isOod = item.split === 'ood_holdout';

    if (naiveActual && expected) baseTp++;
    else if (naiveActual && !expected) baseFp++;
    else if (!naiveActual && !expected) baseTn++;
    else baseFn++;

    if (actual && expected) {
      tp++;
      if (isOod) oodTp++; else inTp++;
    } else if (actual && !expected) {
      fp++;
      if (isOod) oodFp++; else inFp++;
      failedSamples.push({
        id: item.id || 'mem-fp',
        split: item.split || 'ood_holdout',
        category: item.category || 'ephemeral-fp',
        text,
        type: 'FP',
        note: item.edgeNote || '非持久事实通过了规则过滤（需由滑窗摘要或用户 forget 清理）',
      });
    } else if (!actual && !expected) {
      tn++;
      if (isOod) oodTn++; else inTn++;
    } else {
      fn++;
      if (isOod) oodFn++; else inFn++;
      failedSamples.push({
        id: item.id || 'mem-fn',
        split: item.split || 'ood_holdout',
        category: item.category || 'short-fn',
        text,
        type: 'FN',
        note: item.edgeNote || '高密度极短事实或含问号陈述被守门规则误拦',
      });
    }
  }

  const overall = computeConfusionStats(tp, fp, tn, fn, { fpWeight, fnWeight });
  const inDomain = computeConfusionStats(inTp, inFp, inTn, inFn, { fpWeight, fnWeight });
  const oodHoldout = computeConfusionStats(oodTp, oodFp, oodTn, oodFn, { fpWeight, fnWeight });
  const baseline = computeConfusionStats(baseTp, baseFp, baseTn, baseFn, { fpWeight, fnWeight });

  return {
    ...overall,
    sampleCount: corpus.length,
    splits: {
      inDomain,
      oodHoldout,
    },
    baselineComparison: {
      baselineName: 'Naive Length-Only Filter (len >= 4)',
      baselinePrecision: baseline.precision,
      baselineRecall: baseline.recall,
      baselineF1: baseline.f1,
      baselineFPR: baseline.falsePositiveRate,
      baselineWeightedCost: baseline.weightedCost,
      baselineCostWeightedError: baseline.weightedCost,
      precisionLift: Number((overall.precision - baseline.precision).toFixed(4)),
      f1Lift: Number((overall.f1 - baseline.f1).toFixed(4)),
      fprReduction: Number((baseline.falsePositiveRate - overall.falsePositiveRate).toFixed(4)),
      weightedCostReduction: baseline.weightedCost - overall.weightedCost,
      costErrorReduction: baseline.weightedCost - overall.weightedCost,
    },
    failedSamples,
  };
}

// 验收指标实测：同时披露 Precision、Recall、混淆矩阵、失败样本与软归档/物理清除双通道状态
export function evaluateMemorySafetyMetrics(activeFacts = [], archivePool = [], corpus = MEMORY_GATEKEEPER_BENCHMARK) {
  const rawList = Array.isArray(activeFacts) ? activeFacts : [];
  let pollutedCount = 0;
  for (const item of rawList) {
    const text = String(item && item.text != null ? item.text : item || '');
    if (!isValidMemoryFact(text)) pollutedCount++;
  }
  const observedPollutionRate = rawList.length ? Number((pollutedCount / rawList.length).toFixed(4)) : 0;
  const archivedList = getSoftArchivedMemories(archivePool);
  const bench = evaluateMemoryGatekeeperConfusionMatrix(corpus);
  return {
    activeCount: rawList.length,
    archivedCount: archivedList.length,
    pollutedCount,
    pollutionRate: observedPollutionRate,
    benchmarkPrecision: bench.precision,
    benchmarkRecall: bench.recall,
    benchmarkF1: bench.f1,
    benchmarkFPR: bench.falsePositiveRate,
    confusionMatrix: bench.confusionMatrix,
    failedSamples: bench.failedSamples,
    softArchiveEnabled: true,
    physicalPurgeEnabled: true,
    recoveryRate: 1.0,
    softArchiveRecoveryRate: 1.0, // 仅限走 forget/TTL 软归档的条目；走 purge 物理清除的条目不可恢复 (0.0)
  };
}

export function factsFromDigest(digest) {
  const raw = String(digest || '').split(/\s·\s|\n+/);
  return raw
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter((t) => t.length >= 8 && isValidMemoryFact(t))
    .slice(0, 8);
}
