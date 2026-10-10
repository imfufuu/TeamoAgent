// Presentation order is persisted independently of protocol text/toolCalls.
// No tool/result message may move across visible assistant text or another tool family.
export function recordOutputText(message, start, end) {
  if (end <= start) return;
  const order = message.outputOrder || (message.outputOrder = []);
  const last = order[order.length - 1];
  if (last?.kind === 'text' && last.end === start) last.end = end;
  else order.push({ kind: 'text', start, end });
}
export function recordOutputTool(message, index) {
  const order = message.outputOrder || (message.outputOrder = []);
  if (order.some((p) => p.kind === 'tools' && p.indices.includes(index))) return;
  const last = order[order.length - 1];
  if (last?.kind === 'tools') last.indices.push(index);
  else order.push({ kind: 'tools', indices: [index] });
}
export function toolFamily(call) {
  if (call?.name === 'write_file') return 'edited';
  if (['read_file', 'analyze_image', 'analyze_pdf', 'analyze_video'].includes(call?.name)) return 'explored';
  return 'commands';
}
export function displayParts(message) {
  const text = String(message?.text || '');
  const calls = Array.isArray(message?.toolCalls) ? message.toolCalls : [];
  const indexOrder = message?.toolOrderIndices || calls.map((_, i) => i);
  const byIndex = new Map(indexOrder.map((index, i) => [index, calls[i]]));
  const validOrder = Array.isArray(message?.outputOrder) && message.outputOrder.every((p) => p && (p.kind === 'text' && Number.isFinite(p.start) && Number.isFinite(p.end) || p.kind === 'tools' && Array.isArray(p.indices)));
  const order = validOrder && message.outputOrder.length ? message.outputOrder : [
    ...(text ? [{ kind: 'text', start: 0, end: text.length }] : []),
    ...(calls.length ? [{ kind: 'tools', indices: indexOrder }] : []),
  ];
  const result = [];
  const used = new Set();
  const addCall = (call) => {
    if (!call || used.has(call)) return;
    used.add(call);
    const family = toolFamily(call);
    const last = result[result.length - 1];
    if (last?.kind === family) last.toolCalls.push(call);
    else result.push({ kind: family, text: '', toolCalls: [call] });
  };
  for (const part of order) {
    if (part.kind === 'text') {
      const value = text.slice(part.start, part.end);
      if (value) result.push({ kind: 'text', text: value, toolCalls: [] });
    } else if (part.kind === 'tools') part.indices.forEach((index) => addCall(byIndex.get(index)));
  }
  calls.forEach(addCall); // imported/legacy messages without complete order metadata
  return result;
}
export function turnHasAssistantText(messages, id) {
  const at = messages.findIndex((m) => m.id === id);
  if (at < 0) return false;
  let lo = at, hi = at;
  while (lo > 0 && messages[lo - 1].role !== 'user') lo--;
  while (hi + 1 < messages.length && messages[hi + 1].role !== 'user') hi++;
  return messages.slice(lo, hi + 1).some((m) => m.role === 'assistant' && String(m.text || '').trim());
}
// Only adjacent, text-free tool-only assistant messages are eligible for merging.
export function adjacentToolMessages(messages, id, predicate) {
  const at = messages.findIndex((m) => m.id === id);
  if (at < 0) return [];
  const eligible = (m) => m?.role === 'assistant' && !String(m.text || '').trim()
    && m.toolCalls?.length && m.toolCalls.every(predicate);
  if (!eligible(messages[at])) return [messages[at]];
  const cluster = [messages[at]];
  for (const step of [-1, 1]) {
    for (let i = at + step; i >= 0 && i < messages.length; i += step) {
      const m = messages[i];
      if (m.role === 'tool') continue;
      if (!eligible(m)) break;
      if (step < 0) cluster.unshift(m); else cluster.push(m);
    }
  }
  return cluster;
}
export const TOOL_STREAM_MAX_CHARS = 65536;
export function appendToolStream(call, { stream, delta, reset } = {}) {
  if (!call || !['stdout', 'stderr'].includes(stream)) return;
  const output = call.liveOutput || (call.liveOutput = { stdout: '', stderr: '' });
  output[stream] = ((reset ? '' : output[stream] || '') + String(delta || '')).slice(-TOOL_STREAM_MAX_CHARS);
}
