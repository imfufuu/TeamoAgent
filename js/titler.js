// ─── 会话标题自动生成 ──────────────────────────────────────────────────
// 每轮回答结束后，用一次「不进对话历史」的小调用给会话起标题（侧栏「会话记录」用）。
// 用户手改过的标题优先（store.state 里 titleSource==='user' 时这里不覆盖）。
//
// 为什么是独立模块而不是往 api.js 里加一个具名导出再被 ui.js import：
// 静态站点没有构建器，Pages 对子资源有 ~10 分钟缓存，「新 ui.js + 旧 api.js」这种混版组合
// 会让新增的具名导入在 ESM link 期直接报错 → 整页白屏。新文件（本模块）没有旧缓存可比对，
// 而它只 import api.js 里早已存在的 streamChat，安全。
import { streamChat } from './api.js';

const inflight = new Set(); // 正在起标题的会话 id，避免同一会话并发重复调用

/** 让模型给一轮问答起标题；失败/无 key 时返回 ''（调用方保留兜底标题） */
export async function summarizeTitle({ apiKey, model, question, answer, signal, maxChars = 16 }) {
  const prompt = [
    '给下面这轮对话起一个标题，用于侧栏会话列表。',
    `要求：不超过 ${maxChars} 个字；名词短语优先；不要引号、书名号、句号、前缀或解释；`,
    '不要用「关于」「探讨」这类空词；用户用中文就写中文。只输出标题本身。',
    '',
    `用户：${String(question || '').slice(0, 600)}`,
    `助手：${String(answer || '').slice(0, 600)}`,
  ].join('\n');
  let text = '';
  await streamChat({
    model, apiKey, thinking: false, tools: null, signal,
    messages: [{ role: 'user', text: prompt }],
    onEvent: (ev) => { if (ev.type === 'text') text += ev.text; },
  });
  return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
}

/**
 * 若该会话还没起过标题，就起一个并写回 store。
 * @returns {Promise<{ok:boolean, title?:string, reason?:string}>} 永不抛错（标题是锦上添花，
 *   失败也不能影响对话回合本身）
 */
export async function autoTitle(store, { summarize = summarizeTitle } = {}) {
  const need = typeof store.needsTitle === 'function' ? store.needsTitle() : null;
  if (!need) return { ok: false, reason: 'not-needed' };
  if (inflight.has(need.sessionId)) return { ok: false, reason: 'inflight' };
  const { apiKey, model } = store.state;
  if (!apiKey) return { ok: false, reason: 'no-key' }; // 不标记 titled：配好 key 后下一轮还会试
  inflight.add(need.sessionId);
  try {
    const title = await summarize({ apiKey, model, question: need.question, answer: need.answer });
    if (typeof store.setAutoTitle !== 'function') return { ok: false, reason: 'stale-store' }; // 混版：旧 state.js 没这方法
    const applied = store.setAutoTitle(need.sessionId, title); // 内部同时把 titled 置位
    return applied ? { ok: true, title } : { ok: false, reason: title ? 'user-owned' : 'empty' };
  } catch (err) {
    // 标记为已尝试，避免每轮重复消耗（同样要防旧 state.js 里没这个方法）
    try { if (typeof store.setAutoTitle === 'function') store.setAutoTitle(need.sessionId, ''); } catch { /**/ }
    return { ok: false, reason: `failed: ${err.message}` };
  } finally {
    inflight.delete(need.sessionId);
  }
}
