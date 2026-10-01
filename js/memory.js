// ─── 跨会话记忆（Hermes MEMORY.md 的浏览器等价物）────────────────────
// 事实级、短、适用于每一轮；任务流程属于 skills，不写进这里。
// 压缩丢轮之前先把被丢掉的用户问题蒸馏成事实，避免上下文丢失后无法续聊。

const MAX_FACTS = 24;
const MAX_FACT = 160;
const MIN_FACT_LEN = 4;

export function formatMemory(facts) {
  const list = (facts || []).filter((f) => f && (f.text || typeof f === 'string'));
  if (!list.length) return '';
  const lines = [
    '## Persistent Memory · 跨会话长期记忆（系统已自动注入并生效）',
    '以下长期记忆点已由系统自动传递给 Agent，无需再次调用 remember(list) 查询。请在回答与工具决策中主动遵循并应用这些已知事实、身份背景、技术栈与偏好约定：',
  ];
  for (const f of list.slice(0, MAX_FACTS)) {
    const text = String(f.text || f).replace(/\s+/g, ' ').trim().slice(0, MAX_FACT);
    if (text) lines.push(`- ${text}`);
  }
  return lines.join('\n');
}

export function formatActiveMemoryReminder(facts) {
  const list = (facts || [])
    .map((f) => String((f && f.text) || f || '').replace(/\s+/g, ' ').trim().slice(0, MAX_FACT))
    .filter(Boolean);
  if (!list.length) return '';
  return `【长期记忆已自动生效（共 ${list.length} 条）】\n`
    + list.slice(0, MAX_FACTS).map((t, idx) => `${idx + 1}. ${t}`).join('\n')
    + '\n请直接结合上述长期记忆回应本轮请求（如语言/格式偏好、用户身份、技术栈与项目约定），并在用户提出新的长期偏好或事实指令时调用 remember(action="add", fact="...") 持久化。';
}

export function extractAutoMemoryFacts(userText) {
  const src = String(userText || '').trim();
  if (!src || src.length > 600) return [];
  const results = [];
  const clauses = src.split(/[。！？!?\n；;]+/).map((s) => s.trim()).filter(Boolean);
  for (const clause of clauses) {
    // 1. 显式“请记住 / 记住：/ 记一下”指令
    const explicit = clause.match(/^(?:请|麻烦|帮我)?(?:记住|记下|记一下|牢记)[：:\s，,]*(.+)$/);
    if (explicit && explicit[1]) {
      const cleaned = explicit[1].replace(/^[：:\s，,]+/, '').trim();
      if (cleaned.length >= MIN_FACT_LEN && cleaned.length <= MAX_FACT) {
        results.push(cleaned);
        continue;
      }
    }
    // 2. 显式长期偏好/身份声明（“以后都用...”、“我的偏好是...”、“我是一名...”）
    const pref = clause.match(/^(?:以后(?:请)?(?:都|一律|默认)|默认请|我的(?:长期)?偏好是|我习惯用|我目前是|我是一名|我的职业是)[：:\s]*(.+)$/);
    if (pref && clause.length >= MIN_FACT_LEN && clause.length <= MAX_FACT) {
      results.push(clause);
    }
  }
  return results;
}

export function upsertFacts(existing, additions) {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const text = String(raw == null ? '' : (raw.text || raw)).replace(/\s+/g, ' ').trim().slice(0, MAX_FACT);
    if (!text || text.length < MIN_FACT_LEN) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ text, ts: (raw && raw.ts) || Date.now() });
  };
  for (const a of additions || []) push(a);
  for (const e of existing || []) push(e);
  return out.slice(0, MAX_FACTS);
}

export function factsFromDigest(digest) {
  const raw = String(digest || '').split(/\s·\s|\n+/);
  return raw.map((t) => t.replace(/\s+/g, ' ').trim()).filter((t) => t.length >= 8).slice(0, 8);
}
