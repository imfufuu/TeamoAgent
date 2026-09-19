// ─── 上下文窗口管理（纯函数，可单测）──────────────────────────────────
// 职责：token 估算、按轮次压缩历史（绝不产生孤儿 tool 消息）、工具结果截断

const CJK_RE = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g;

function textTokens(s) {
  if (!s) return 0;
  const cjk = (String(s).match(CJK_RE) || []).length;
  const other = String(s).length - cjk;
  return cjk + Math.ceil(other / 4) + 1; // CJK ≈ 1 token/字，其余 ≈ 4 字符/token
}

// 内部消息格式的粗略 token 估算
export function estimateTokens(messages) {
  let t = 0;
  for (const m of messages || []) {
    t += 4; // 每条消息的角色/分隔开销
    t += textTokens(m.text) + textTokens(m.content);
    if (m.toolCalls) t += textTokens(JSON.stringify(m.toolCalls));
    for (const a of m.attachments || []) {
      t += a.kind === 'image' ? 1500 : textTokens(a.text) + 10;
    }
  }
  return t;
}

// 各模型家族的输入预算（保守值，为输出与工具循环留余量）
const BUDGETS = [
  [/^claude/, 150000],
  [/^(gpt|o\d|chatgpt)/, 200000],
  [/^gemini/, 400000],
  [/^deepseek/, 55000],
  [/^glm/, 90000],
  [/^grok/, 90000],
];
export function contextBudgetFor(modelId) {
  const m = String(modelId || '').toLowerCase();
  for (const [re, budget] of BUDGETS) if (re.test(m)) return budget;
  return 90000;
}

const truncTool = (max) => (m) =>
  m.role === 'tool' && typeof m.content === 'string' && m.content.length > max
    ? { ...m, content: m.content.slice(0, Math.floor(max * 0.75)) + '\n…[工具结果已截断]' }
    : m;

// 压缩策略：先截断长工具结果；仍超预算则从最早开始整轮丢弃（user 消息边界），
// 保证 tool 消息永远与其 assistant(tool_use) 同进同出，两种协议都不会 400。
export function compactMessages(msgs, budget) {
  let out = (msgs || []).map(truncTool(2000));
  let droppedCount = 0;
  while (estimateTokens(out) > budget) {
    if (out.length <= 4) break;
    let j = -1;
    for (let i = 1; i < out.length; i++) {
      if (out[i].role === 'user') { j = i; break; }
    }
    if (j < 0) { out = out.map(truncTool(200)); break; } // 单轮超长：深度截断工具结果兜底
    out = out.slice(j);
    droppedCount += j;
  }
  return { messages: out, droppedCount };
}

// 工具结果回填模型前的长度保护（头 60% + 尾 20%）
export function truncateToolContent(s, max = 8000) {
  const str = String(s == null ? '' : s);
  if (str.length <= max) return str;
  const head = Math.floor(max * 0.6);
  const tail = Math.floor(max * 0.2);
  return str.slice(0, head) + `\n…[结果过长，中间省略 ${str.length - head - tail} 字符]…\n` + str.slice(-tail);
}
