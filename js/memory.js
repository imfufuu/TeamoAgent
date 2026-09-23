// ─── 跨会话记忆（Hermes MEMORY.md 的浏览器等价物）────────────────────
// 事实级、短、适用于每一轮；任务流程属于 skills，不写进这里。
// 压缩丢轮之前先把被丢掉的用户问题蒸馏成事实，避免上下文丢失后无法续聊。

const MAX_FACTS = 20;
const MAX_FACT = 160;

export function formatMemory(facts) {
  const list = (facts || []).filter((f) => f && (f.text || typeof f === 'string'));
  if (!list.length) return '';
  const lines = ['## Persistent Memory', '跨会话事实（不是本轮任务步骤）。与当前问题无关的条目请忽略。'];
  for (const f of list.slice(0, MAX_FACTS)) {
    const text = String(f.text || f).replace(/\s+/g, ' ').trim().slice(0, MAX_FACT);
    if (text) lines.push(`- ${text}`);
  }
  return lines.join('\n');
}

export function upsertFacts(existing, additions) {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const text = String(raw == null ? '' : (raw.text || raw)).replace(/\s+/g, ' ').trim().slice(0, MAX_FACT);
    if (!text || text.length < 8) return;
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
