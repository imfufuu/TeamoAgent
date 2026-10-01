// ─── 跨会话记忆（Hermes MEMORY.md 的浏览器等价物 · 带质量闸门与 TTL 衰减 GC）────
// 事实级、短、适用于每一轮；任务流程属于 skills，不写进这里。
// 写入守门人（Memory Gatekeeper）：拦截反问句、指代残片与一次性指令；
// 每条记忆携带结构化元数据：{ id, text, ts, source, confidence, ttlMs, expiresAt, hits }。

const MAX_FACTS = 24;
const MAX_FACT = 160;
const MIN_FACT_LEN = 4;

const DAY_MS = 24 * 3600 * 1000;
export const MEMORY_SOURCE_SPEC = Object.freeze({
  'user-explicit':     { confidence: 0.98, ttlMs: 180 * DAY_MS, label: '用户显式指令' },
  'agent-tool':        { confidence: 0.88, ttlMs: 90 * DAY_MS,  label: 'Agent 记忆工具' },
  'compression-flush': { confidence: 0.72, ttlMs: 30 * DAY_MS,  label: '滑窗压缩刷盘' },
});

export function memoryIdFor(text) {
  const norm = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  let h = 2166136261;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 'mem-' + ((h >>> 0) & 0xffff).toString(16).padStart(4, '0');
}

// 记忆质量守门人：拒绝疑问句、纯指代残片、寒暄与一次性任务指令
export function isValidMemoryFact(rawText) {
  const text = String(rawText || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length < MIN_FACT_LEN || text.length > MAX_FACT) return false;
  // 拒绝疑问句或反问尾缀
  if (/[？?]$/.test(text) || /(?:吗|呢|行不行|好不好|对不对|是什么|怎么办|为什么)$/.test(text)) return false;
  // 拒绝纯指代或无意义对话残片
  if (/^(?:这个呢|那个呢|继续|再来一次|为什么|不对|改一下|试试|好的|谢谢|明白|知道了|哈哈|ok|test)$/i.test(text)) return false;
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

// 自动 GC：清理过期、低置信度或历史遗留的噪声记忆，按置信度与新鲜度排序
export function pruneMemoryFacts(facts, { now = Date.now() } = {}) {
  if (!Array.isArray(facts) || !facts.length) return [];
  const out = [];
  const seen = new Set();
  for (const item of facts) {
    const entry = normalizeMemoryEntry(item, (item && item.source) || 'agent-tool', now);
    if (!entry) continue;
    if (entry.expiresAt && now > entry.expiresAt && entry.hits <= 0) continue;
    if (entry.confidence < 0.38) continue;
    const key = entry.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  out.sort((a, b) => (b.confidence - a.confidence) || (b.ts - a.ts));
  return out.slice(0, MAX_FACTS);
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
    lines.push(`- [${f.id}] ${f.text} （来源: ${f.source}, 置信度: ${f.confidence}, 剩余有效期: ~${ttlDays}d）`);
  }
  return lines.join('\n');
}

export function formatActiveMemoryReminder(facts) {
  const list = pruneMemoryFacts(facts);
  if (!list.length) return '';
  return `【长期记忆已自动生效（共 ${list.length} 条）】\n`
    + list.map((f, idx) => `${idx + 1}. [${f.id}] ${f.text} (置信度 ${f.confidence})`).join('\n')
    + '\n请直接结合上述长期记忆回应本轮请求；如需删除某条过期或有误记忆，请优先使用其精确 ID 调用 remember(action="forget", fact="mem-xxxx")，避免关键词误删其它条目。';
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
    const key = entry.text.toLowerCase();
    if (map.has(key)) {
      const prev = map.get(key);
      // 新写入或更高置信度来源可提升既有条目的置信度并续期 TTL
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

// 精准遗忘：支持按 [mem-xxxx] ID 精确删除（零误删风险）或按关键词删除
export function forgetMemoryFact(existing, query) {
  const list = pruneMemoryFacts(existing);
  const q = String(query || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (q.length < 2) {
    return { next: list, removed: [], error: 'forget 需要至少 2 个字符的关键词或精确记忆 ID（如 mem-xxxx）。' };
  }
  // 1. 优先精确匹配记忆 ID（如 mem-7f3a）
  if (/^mem-[0-9a-f]{4}$/i.test(q)) {
    const removed = list.filter((f) => f.id.toLowerCase() === q);
    const next = list.filter((f) => f.id.toLowerCase() !== q);
    return { next, removed, byId: true };
  }
  // 2. 精确全文相等匹配
  const exactHits = list.filter((f) => f.text.toLowerCase() === q);
  if (exactHits.length === 1) {
    const next = list.filter((f) => f.id !== exactHits[0].id);
    return { next, removed: exactHits, byExact: true };
  }
  // 3. 关键词包含匹配
  const subHits = list.filter((f) => f.text.toLowerCase().includes(q));
  const next = list.filter((f) => !f.text.toLowerCase().includes(q));
  return { next, removed: subHits, byKeyword: true };
}

export function factsFromDigest(digest) {
  const raw = String(digest || '').split(/\s·\s|\n+/);
  return raw
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter((t) => t.length >= 8 && isValidMemoryFact(t))
    .slice(0, 8);
}
