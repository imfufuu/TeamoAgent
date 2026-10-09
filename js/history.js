// 历史消息分段：只在完整用户轮次边界裁切，同时约束可见消息数与文本字数。
// 2026.10.9.1：阈值拉高（60 条 / 24000 字 → 120 条 / 120000 字）。旧阈值太低：几轮带工具输出的对话
// 就会顶满字数预算，于是「更早的消息」接缝在几条短消息上就出现。工具结果仍计入字数（既定策略）。
export const HISTORY_WINDOW_MAX_MESSAGES = 120;
export const HISTORY_WINDOW_MAX_CHARS = 120000;

const isBoundary = (m) => !!m && m.role === 'user' && !m.silent;
const isVisible = (m) => !!m && (m.role === 'user' || m.role === 'assistant') && !m.silent;
const codepoints = (s) => Array.from(String(s || '')).length;

function measureMessage(message) {
  const m = message || {};
  let chars = 0;
  for (const key of ['text', 'content', 'reasoning', 'error', 'note']) {
    if (typeof m[key] === 'string') chars += codepoints(m[key]);
  }
  if (Array.isArray(m.attachments)) {
    for (const a of m.attachments) {
      if (!a || typeof a !== 'object') continue;
      chars += codepoints(a.name || '') + codepoints(a.text || '') + codepoints(a.originalName || '');
    }
  }
  if (Array.isArray(m.toolCalls)) {
    for (const t of m.toolCalls) {
      if (!t || typeof t !== 'object') continue;
      chars += codepoints(t.name || '');
      try { chars += codepoints(JSON.stringify(t.args || {})); } catch { /* 忽略不可序列化参数 */ }
    }
  }
  return chars;
}

export function splitHistoryTurns(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const turns = [];
  let turn = null;
  for (let i = 0; i < list.length; i++) {
    const message = list[i];
    if (isBoundary(message)) {
      if (turn) turns.push(turn);
      turn = { start: i, end: i, visibleMessages: 0, chars: 0 };
    }
    if (!turn) turn = { start: i, end: i, visibleMessages: 0, chars: 0 };
    turn.end = i + 1;
    if (isVisible(message)) turn.visibleMessages += 1;
    turn.chars += measureMessage(message);
  }
  if (turn) turns.push(turn);
  return turns;
}

/** 返回当前窗口的起始数组下标；最新单轮即使超限也完整保留。 */
export function historyWindowStart(messages, maxMessages = HISTORY_WINDOW_MAX_MESSAGES, maxChars = HISTORY_WINDOW_MAX_CHARS) {
  const list = Array.isArray(messages) ? messages : [];
  if (!list.length) return 0;
  const turns = splitHistoryTurns(list);
  const msgLimit = Math.max(1, Number(maxMessages) || HISTORY_WINDOW_MAX_MESSAGES);
  const charLimit = Math.max(1, Number(maxChars) || HISTORY_WINDOW_MAX_CHARS);
  let count = 0;
  let chars = 0;
  let start = list.length;
  let included = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    const exceeds = count + turn.visibleMessages > msgLimit || chars + turn.chars > charLimit;
    if (included && exceeds) break;
    start = turn.start;
    count += turn.visibleMessages;
    chars += turn.chars;
    included += 1;
    // Latest oversized turn is allowed, but must not drag older turns into this segment.
    if (exceeds) break;
  }
  return start;
}

/** 返回上一段（紧邻当前窗口之前）的起点；输入窗口必须从完整轮次边界开始。 */
export function previousHistoryWindowStart(messages, currentStart, maxMessages = HISTORY_WINDOW_MAX_MESSAGES, maxChars = HISTORY_WINDOW_MAX_CHARS) {
  const start = Math.max(0, Math.min((Array.isArray(messages) ? messages.length : 0), Number(currentStart) || 0));
  if (!start) return 0;
  return historyWindowStart(messages.slice(0, start), maxMessages, maxChars);
}
