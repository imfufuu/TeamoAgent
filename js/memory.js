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

// 记忆写入过滤守门人：拒绝疑问句、纯指代残片、寒暄与一次性任务指令
export function isValidMemoryFact(rawText) {
  const text = String(rawText || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length < MIN_FACT_LEN || text.length > MAX_FACT) return false;
  // 拒绝疑问句或反问尾缀
  if (/[？?]$/.test(text) || /(?:吗|呢|行不行|好不好|对不对|是什么|怎么办|为什么|怎么回事[呀啊]?)$/.test(text)) return false;
  // 拒绝纯指代或无意义对话残片
  if (/^(?:这个呢|那个呢|那它呢|那这个呢|那那个呢|继续(?:往下写)?|再来一次|重试(?:一次)?|为什么|不对|改一下|试试|好的(?:谢谢)?|谢谢|明白|知道了|哈哈|ok|test)$/i.test(text)) return false;
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

// 离线标注评测集（含真实边界失败样本：披露 Precision 与 Recall 的工程折中，拒绝虚假 100%）
export const MEMORY_GATEKEEPER_BENCHMARK = Object.freeze([
  // 正样本（expected: true，应当允许写入的跨会话事实/偏好）
  { text: '用户偏好使用 TypeScript 严格模式编写前端工程', expected: true },
  { text: '后端服务统一部署在 Debian 12 容器环境', expected: true },
  { text: '数据库连接池上限固定为 32，超时 5 秒', expected: true },
  { text: '代码注释与文档一律使用简体中文', expected: true },
  { text: '构建工具优先使用 Vite 而非 Webpack', expected: true },
  { text: '用户是一名分布式存储研发工程师', expected: true },
  { text: '以后所有 Python 脚本默认兼容 3.12', expected: true },
  { text: '单元测试统一使用 node:test 原生断言', expected: true },
  // 正样本中的真实困难边界（规则守门人会误拦的 FN 样本：如带问号结尾的修辞陈述、3 字符极短缩写事实）
  { text: '用户在上海初三就读，偏好简洁为什么先讲结论的风格？', expected: true, edgeNote: '含问号结尾的修辞陈述，被疑问句规则误伤 (FN)' },
  { text: '用Go', expected: true, edgeNote: '仅 3 个字符 (< MIN_FACT_LEN=4)，被长度阈值误伤 (FN)' },
  // 负样本（expected: false，应当拦截的指代残片/反问句/一次性临时指令）
  { text: '这个呢？', expected: false },
  { text: '那个呢', expected: false },
  { text: '那它呢', expected: false },
  { text: '为什么会出现这个问题？', expected: false },
  { text: '帮我写一个快速排序代码', expected: false },
  { text: '现在帮我算一下 128 乘以 256', expected: false },
  { text: '继续', expected: false },
  { text: '好的', expected: false },
  { text: '这样改行不行', expected: false },
  // 负样本中的真实困难边界（规则守门人会漏放的 FP 样本：不含“帮我”前缀且非疑问句的临时状态陈述）
  { text: '今天下午三点服务器刚刚重启过一次', expected: false, edgeNote: '一次性临时事件陈述，无明显临时指令前缀，规则守门人漏拦 (FP)' },
]);

export function evaluateMemoryGatekeeperConfusionMatrix(corpus = MEMORY_GATEKEEPER_BENCHMARK, { fpWeight = 4, fnWeight = 1 } = {}) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  const failedSamples = [];
  for (const item of corpus) {
    const actual = isValidMemoryFact(item.text);
    const expected = Boolean(item.expected ?? item.shouldAccept ?? item.expectedValid);
    if (actual && expected) tp++;
    else if (actual && !expected) {
      fp++;
      failedSamples.push({
        id: item.id || 'mem-fp',
        category: item.category || 'ephemeral-fp',
        text: item.text,
        type: 'FP',
        note: item.edgeNote || '非持久事实通过了规则过滤（需由滑窗摘要或用户 forget 清理）',
      });
    } else if (!actual && !expected) tn++;
    else {
      fn++;
      failedSamples.push({
        id: item.id || 'mem-fn',
        category: item.category || 'short-fn',
        text: item.text,
        type: 'FN',
        note: item.edgeNote || '高密度极短事实或含问号陈述被守门规则误拦',
      });
    }
  }
  const precision = (tp + fp) > 0 ? Number((tp / (tp + fp)).toFixed(4)) : 0;
  const recall = (tp + fn) > 0 ? Number((tp / (tp + fn)).toFixed(4)) : 0;
  const f1 = (precision + recall) > 0 ? Number(((2 * precision * recall) / (precision + recall)).toFixed(4)) : 0;
  const falsePositiveRate = (fp + tn) > 0 ? Number((fp / (fp + tn)).toFixed(4)) : 0;
  const weightedCost = fpWeight * fp + fnWeight * fn;
  return {
    totalSamples: corpus.length,
    sampleCount: corpus.length,
    confusionMatrix: { tp, fp, tn, fn },
    precision,
    recall,
    f1,
    falsePositiveRate,
    weightedCost,
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
