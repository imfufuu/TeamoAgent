// 命令面板（⌘K）与 token 构成：纯函数，便于单测。
// 不从已有模块再导出新符号给别人 import（混版缓存）。

/** 模糊过滤命令项：按 group / label / hint 包含匹配，空查询返回前 limit 条 */
export function filterCmds(query, items, limit = 40) {
  const list = Array.isArray(items) ? items : [];
  const q = String(query || '').trim().toLowerCase();
  if (!q) return list.slice(0, limit);
  const parts = q.split(/\s+/).filter(Boolean);
  const scored = [];
  for (const it of list) {
    const hay = `${it.group || ''} ${it.label || ''} ${it.hint || ''} ${it.id || ''}`.toLowerCase();
    if (!parts.every((p) => hay.includes(p))) continue;
    const idx = hay.indexOf(q);
    scored.push({ it, s: idx < 0 ? 80 : idx });
  }
  scored.sort((a, b) => a.s - b.s || String(a.it.label).localeCompare(b.it.label));
  return scored.slice(0, limit).map((x) => x.it);
}

/**
 * 会话 token 构成（与 estimateTokens 同一套估算）。
 * system 由调用方传入已估算值（系统提示不在 messages 里）。
 */
export function tokenBreakdown(messages, estimateTokens, systemTok = 0) {
  const msgs = Array.isArray(messages) ? messages : [];
  let lastUser = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i] && msgs[i].role === 'user') { lastUser = i; break; }
  }
  let history = 0;
  let tools = 0;
  let current = 0;
  for (let i = 0; i < msgs.length; i++) {
    const n = typeof estimateTokens === 'function' ? estimateTokens([msgs[i]]) : 0;
    if (msgs[i] && msgs[i].role === 'tool') tools += n;
    else if (lastUser >= 0 && i >= lastUser) current += n;
    else history += n;
  }
  const system = Math.max(0, Math.round(Number(systemTok) || 0));
  return {
    system,
    history,
    tools,
    current,
    total: system + history + tools + current,
  };
}

export function formatTokBreak(b) {
  const n = (x) => (x >= 1000 ? `${(x / 1000).toFixed(1)}k` : String(x));
  const p = b || {};
  return `系统 ${n(p.system || 0)} · 历史 ${n(p.history || 0)} · 工具结果 ${n(p.tools || 0)} · 本轮 ${n(p.current || 0)} · 合计 ${n(p.total || 0)}`;
}

/** 移动端示例卡短句：保留 dataset 全文，展示截到标点或 22 字 */
export function shortSuggest(text) {
  const t = String(text || '').trim();
  if (t.length <= 22) return t;
  const slice = t.slice(0, 22);
  const cut = slice.replace(/[，。；：、,.!！？?\s]+$/u, '');
  return `${cut || slice}…`;
}
