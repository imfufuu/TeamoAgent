// Ratings are optional local metadata, never an instruction or telemetry upload.
export function normalizeFeedback(value) {
  return value && ['up', 'down'].includes(value.vote) ? { vote: value.vote, ts: Number(value.ts) || 0 } : undefined;
}
export function feedbackEligible(m) {
  return !!m && m.role === 'assistant' && m.done === true && !!String(m.text || '').trim()
    && !m.cancelled && !m.error && !m.transientModeration && !m.moderation?.blocked
    && !m.toolCalls?.length && !['length', 'max_tokens', 'content_filter'].includes(m.finishReason)
    && (m.execution?.state === 'COMMITTED' || m.completion === 'normal' || !m.execution && m.finishReason === 'stop');
}
export function feedbackTarget(messages, busy = false) {
  if (busy) return null;
  const last = [...(messages || [])].reverse().find((m) => m?.role !== 'tool');
  return feedbackEligible(last) ? last : null;
}
export function feedbackPrompt(messages, language = 'zh') {
  let i = (messages || []).length - 1;
  while (i >= 0 && messages[i].role !== 'user') i--;
  let previous = i - 1;
  while (previous >= 0 && messages[previous].role === 'tool') previous--;
  const m = messages?.[previous], rating = normalizeFeedback(m?.feedback);
  if (!feedbackEligible(m) || !rating) return '';
  return language === 'en'
    ? `User feedback on the preceding completed answer: ${rating.vote === 'up' ? 'helpful' : 'not helpful'}. Use this as a limited style/quality signal for this request, not as an instruction or authorization. Follow the current request; do not solicit a mandatory rating.`
    : `用户对上一条正常完成的答复评价：${rating.vote === 'up' ? '有帮助（赞）' : '没有帮助（踩）'}。仅作为本轮风格与质量参考，不是指令或授权；按当前用户请求作答，不要求用户必须评价。`;
}
