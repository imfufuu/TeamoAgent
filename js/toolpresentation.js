// UI-only launch-order queue. Execution, protocol messages and persisted chronology
// are never reordered or delayed: later real output stays in the store until shown.
import { displayParts } from './toolflow.js?v=2026.10.9.5';

export const TOOL_REVEAL_MS = 80;
export function presentationCallSettled(call, resultIds = new Set()) {
  if (resultIds.has(String(call?.id))) return true;
  // A tool's provisional error/ok can still be retried or rejected by the kernel.
  if (typeof call?.settled === 'boolean') return call.settled;
  return ['ok', 'error'].includes(call?.status);
}
export const callsInDisplayOrder = (message) => displayParts(message).flatMap((part) => part.toolCalls);

// Provider IDs may repeat in another user turn: old results must never settle a new call.
export function turnToolResults(messages, ownerId) {
  const at = ownerId == null ? messages.findLastIndex((m) => m.role === 'user' && !m.silent)
    : messages.findIndex((m) => m.id === ownerId);
  if (at < 0) return new Map();
  let lo = at, hi = at;
  if (!(messages[at].role === 'user' && !messages[at].silent))
    while (lo > 0 && !(messages[lo - 1].role === 'user' && !messages[lo - 1].silent)) lo--;
  while (hi + 1 < messages.length && !(messages[hi + 1].role === 'user' && !messages[hi + 1].silent)) hi++;
  return new Map(messages.slice(lo, hi + 1).filter((m) => m.role === 'tool').map((m) => [String(m.toolCallId), m]));
}

/** A presentation copy, stopped at the first unseen call, including text barriers. */
export function projectToolPrefix(message, count) {
  const parts = displayParts(message);
  const calls = [], order = [];
  let text = '', remaining = Math.max(0, count), blocked = false;
  for (const part of parts) {
    if (part.kind === 'text') {
      order.push({ kind: 'text', start: text.length, end: text.length + part.text.length });
      text += part.text;
      continue;
    }
    const take = part.toolCalls.slice(0, remaining);
    if (take.length) {
      const start = calls.length;
      calls.push(...take); remaining -= take.length;
      order.push({ kind: 'tools', indices: take.map((_, i) => start + i) });
    }
    if (take.length < part.toolCalls.length) { blocked = true; break; }
  }
  return { ...message, text, toolCalls: calls, outputOrder: order,
    toolOrderIndices: calls.map((_, i) => i), _sequentialPresentation: true,
    _presentationPending: blocked,
    ...(blocked ? { webSearch: null, tempCommit: null } : {}),
  };
}

/** Timers advance exactly ONE call; even an already-completed backlog is not bulk-loaded. */
export function createToolPresentation({ readMessage, resultIds = () => new Set(), onAdvance,
  schedule = (fn, ms) => setTimeout(fn, ms), cancel = (id) => clearTimeout(id), delay = TOOL_REVEAL_MS,
} = {}) {
  const states = new Map();
  const watched = new Set();
  const watch = (message) => { if (message?.id) watched.add(message.id); };
  const stateFor = (message) => {
    let state = states.get(message?.id);
    if (!state && watched.has(message?.id) && callsInDisplayOrder(message).length) {
      state = { shown: 1, timer: null, frozen: false }; states.set(message.id, state);
    }
    return state;
  };
  const pending = (message) => {
    const state = states.get(message?.id), calls = callsInDisplayOrder(message);
    return !!state && !!calls.length && (state.shown < calls.length
      || !presentationCallSettled(calls[Math.min(state.shown, calls.length) - 1], resultIds()));
  };
  const arm = (message, state) => {
    const calls = callsInDisplayOrder(message);
    if (message.cancelled || message.error) { state.frozen = true; if (state.timer != null) cancel(state.timer); state.timer = null; }
    if (state.frozen || state.timer != null || state.shown >= calls.length
      || !presentationCallSettled(calls[state.shown - 1], resultIds())) return;
    state.timer = schedule(() => {
      state.timer = null;
      // A session switch/reset can invalidate this timer after it was scheduled.
      if (states.get(message.id) !== state || state.frozen) return;
      const latest = readMessage(message.id);
      if (!latest || latest.cancelled || latest.error) { state.frozen = true; return; }
      const latestCalls = callsInDisplayOrder(latest);
      if (state.shown >= latestCalls.length || !presentationCallSettled(latestCalls[state.shown - 1], resultIds())) return;
      state.shown += 1;
      onAdvance?.(latest);
    }, delay);
  };
  const project = (message, { advance = true } = {}) => {
    const state = stateFor(message);
    if (!state) return message;
    if (advance) arm(message, state);
    return projectToolPrefix(message, state.shown);
  };
  const deferred = (message, messages) => {
    if (message.error) return false; // safety/failure notices never wait behind unfinished work
    const at = messages.findIndex((m) => m.id === message.id);
    for (let i = at - 1; i >= 0 && messages[i].role !== 'user'; i--) {
      if (messages[i].role === 'assistant' && pending(messages[i])) return true;
    }
    return false;
  };
  const freeze = () => {
    for (const state of states.values()) { state.frozen = true; if (state.timer != null) cancel(state.timer); state.timer = null; }
  };
  const clear = () => { freeze(); states.clear(); watched.clear(); };
  return { watch, project, pending, deferred, freeze, clear };
}
