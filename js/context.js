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

// 超长正文保护：粘贴大文件、超长的历史回答同样会撑爆预算（头 60% + 尾 20%）
const truncBody = (max) => (m) => {
  if (m.role === 'tool' || typeof m.text !== 'string' || m.text.length <= max) return m;
  return { ...m, text: truncateToolContent(m.text, max) };
};

// 当前这一轮的起点（最后一条 user 消息的下标）。本轮内容（用户这一问 + 其后的
// 工具调用与结果）永远优先保真，否则 Agent 会基于被截断的输出继续推理。
function turnStart(msgs) {
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') return i;
  return 0;
}

// 只变换 at 之前的消息（历史轮次），at 及其之后原样保留
const mapBefore = (msgs, at, fn) => msgs.map((m, i) => (i < at ? fn(m) : m));

// 硬保证：单条巨型消息没有轮次边界可切时，二分收缩它本身，直到估算落入预算。
// 保证 compactMessages 的返回值在任何输入下都不超过预算（上游不再被动 400）。
function fitBudget(msgs, budget) {
  if (!msgs.length || estimateTokens(msgs) <= budget) return msgs;
  const last = msgs.length - 1;
  const target = msgs[last];
  const shrink = (cap) => msgs.map((m, i) => (i === last ? truncBody(cap)(m) : m));
  let lo = 0;
  let hi = String(target.text || '').length;
  let best = shrink(0);
  if (estimateTokens(best) > budget) return best; // 其余消息本身就超预算，已尽力
  while (hi - lo > 256) {
    const mid = Math.floor((lo + hi) / 2);
    if (estimateTokens(shrink(mid)) <= budget) lo = mid; else hi = mid;
  }
  return shrink(lo);
}

// 压缩策略（分级、预算驱动）：
//   ① 预算充足 → 原样返回，绝不无谓截断
//   ② 只收紧「历史轮次」的工具结果（本轮结果保持完整）
//   ③ 再收紧历史正文（超大粘贴 / 超长历史回答）
//   ④ 仍超预算 → 从最早开始整轮丢弃（user 消息边界），
//      保证 tool 消息永远与其 assistant(tool_use) 同进同出，两种协议都不会 400
//   ⑤ 兜底 → 收缩最后一条消息本身，硬保证不超预算
export function compactMessages(msgs, budget, opts) {
  let src = (msgs || []).slice();
  const preflight = !!(opts && opts.preflight);

  // Hermes 预检：超过窗口 50% 时先收紧历史工具结果（本轮完整），还不丢轮次。
  if (preflight && budget > 0 && estimateTokens(src) > budget * 0.5) {
    src = mapBefore(src, turnStart(src), truncTool(8000));
  }

  // ① 快路径：此前此处无条件截断到 1500 字符，导致沙箱输出与子智能体报告在预算
  //    富余时也被砍掉约 75%，且 UI 展示的是完整版本 —— 模型看到的与用户看到的不一致。
  if (estimateTokens(src) <= budget) return { messages: src, droppedCount: 0, droppedDigest: '' };

  const at = turnStart(src);

  // ② 历史工具结果逐级收紧（保留尽可能多的轮次，只牺牲历史细节）
  for (const cap of [8000, 3000, 1000, 300]) {
    const out = mapBefore(src, at, truncTool(cap));
    if (estimateTokens(out) <= budget) return { messages: out, droppedCount: 0, droppedDigest: '' };
  }
  // ③ 历史正文逐级收紧
  for (const cap of [8000, 2000, 500]) {
    const out = mapBefore(mapBefore(src, at, truncTool(300)), at, truncBody(cap));
    if (estimateTokens(out) <= budget) return { messages: out, droppedCount: 0, droppedDigest: '' };
  }

  // ④ 整轮丢弃：在 user 消息边界切分，绝不产生孤儿 tool 消息
  let out = src.map(truncTool(200));
  let droppedCount = 0;
  const droppedUsers = [];
  while (estimateTokens(out) > budget) {
    if (out.length <= 2) break;
    let j = -1;
    for (let i = 1; i < out.length; i++) {
      if (out[i].role === 'user') { j = i; break; }
    }
    if (j < 0) break; // 没有可切的轮次边界（如单条巨型消息）→ 交给 ⑤
    for (const m of out.slice(0, j)) {
      if (m.role === 'user' && m.text) droppedUsers.push(String(m.text).replace(/\s+/g, ' ').trim().slice(0, 160));
    }
    out = out.slice(j);
    droppedCount += j;
  }

  // ⑤ 兜底：保证返回值一定不超预算
  return {
    messages: fitBudget(out, budget),
    droppedCount,
    droppedDigest: droppedUsers.filter(Boolean).slice(0, 12).join(' · '),
  };
}

// 工具结果回填模型前的长度保护（头 60% + 尾 20%）
// 注意：str.slice(-0) 等价于 str.slice(0)，会返回整串 —— 必须显式挡掉 tail === 0，
// 否则 max 很小时该函数会「越截越长」。
export function truncateToolContent(s, max = 8000) {
  const str = String(s == null ? '' : s);
  if (str.length <= max) return str;
  const head = Math.floor(max * 0.6);
  const tail = Math.floor(max * 0.2);
  const body = head > 0 ? str.slice(0, head) : '';
  const end = tail > 0 ? str.slice(-tail) : '';
  const omitted = Math.max(0, str.length - head - tail);
  return body + `\n…[内容过长，中间省略 ${omitted} 字符]…\n` + end;
}
