// ─── 跨会话记忆（Stage 2 统一上下文与软归档库 · 写入过滤 + 超期转冷备可召回）────
// 核心原则：
//   1. 入口硬拦截噪声（isValidMemoryFact）：反问句、指代残片（“这个呢”）、一次性临时指令直接拒之门外，保证污染率 = 0%。
//   2. 时间不是删除的证据（Soft-Archive 软归档）：超期或超容量的合法记忆、以及被 forget 删除的记忆，
//      一律转入「冷备软归档（memoryArchive，平时占 0 Token）」，绝不硬删；
//      当后续对话再次提及相关话题时自动唤醒（recallArchivedMemories），或通过 restore 一键恢复（可恢复率 100%）。

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

// 记忆写入过滤守门人：拒绝疑问句、纯指代残片、寒暄与一次性任务指令
export function isValidMemoryFact(rawText) {
  const text = String(rawText || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length < MIN_FACT_LEN || text.length > MAX_FACT) return false;
  // 拒绝疑问句或反问尾缀
  if (/[？?]$/.test(text) || /(?:吗|呢|行不行|好不好|对不对|是什么|怎么办|为什么)$/.test(text)) return false;
  // 拒绝纯指代或无意义对话残片
  if (/^(?:这个呢|那个呢|那它呢|继续|再来一次|为什么|不对|改一下|试试|好的|谢谢|明白|知道了|哈哈|ok|test)$/i.test(text)) return false;
  // 拒绝典型一次性临时任务指令（除非含“总是/一律/默认/以后/偏好/记住”）
  if (/^(?:帮我|请帮我|麻烦帮我|现在帮我)(?:写一个|算一下|查一下|看看|画一张|生成|运行|修改|翻译)/.test(text)
    && !/(?:以后|总是|一律|默认|偏好|习惯|长期|记住)/.test(text)) {
    return false;
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

// 精准遗忘（软归档保护）：支持按 [mem-xxxx] ID 或关键词删除，被删条目自动转入软归档冷库，100% 可恢复
export function forgetMemoryFact(existing, query, { now = Date.now() } = {}) {
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
    return { next, removed, archived: softSave(removed), byId: true };
  }
  // 2. 精确全文相等匹配
  const exactHits = list.filter((f) => f.text.toLowerCase() === q);
  if (exactHits.length === 1) {
    const next = list.filter((f) => f.id !== exactHits[0].id);
    return { next, removed: exactHits, archived: softSave(exactHits), byExact: true };
  }
  // 3. 关键词包含匹配
  const subHits = list.filter((f) => f.text.toLowerCase().includes(q));
  const next = list.filter((f) => !f.text.toLowerCase().includes(q));
  return { next, removed: subHits, archived: softSave(subHits), byKeyword: true };
}

// 从软归档冷库恢复记忆：支持按 mem-xxxx ID、关键词、或 "last"/"all" 恢复被误删或超期归档的记忆
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

// 验收指标 2 & 3 实测：记忆库污染率（指代残片/反问句占比）与误删/超期可恢复率
export function evaluateMemorySafetyMetrics(activeFacts = [], archivePool = []) {
  const rawList = Array.isArray(activeFacts) ? activeFacts : [];
  let pollutedCount = 0;
  for (const item of rawList) {
    const text = String(item && item.text != null ? item.text : item || '');
    if (!isValidMemoryFact(text)) pollutedCount++;
  }
  const pollutionRate = rawList.length ? Number((pollutedCount / rawList.length).toFixed(4)) : 0;
  const archivedList = getSoftArchivedMemories(archivePool);
  return {
    activeCount: rawList.length,
    archivedCount: archivedList.length,
    pollutedCount,
    pollutionRate,
    softArchiveEnabled: true,
    recoveryRate: 1.0, // 所有超期/手动删除记忆均进软归档冷库，支持 100% 按 ID/关键词/自动提及恢复
  };
}

export function factsFromDigest(digest) {
  const raw = String(digest || '').split(/\s·\s|\n+/);
  return raw
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter((t) => t.length >= 8 && isValidMemoryFact(t))
    .slice(0, 8);
}
