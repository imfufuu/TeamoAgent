// Stable DOM fragments in persisted SSE order; UI business rules stay in ui.js.
import { displayParts } from './toolflow.js?v=2026.10.9.5';
export function paintOrderedAssistant(wrap, m, { paintPart, paintMeta, paintFoot, syncShell, syncFolds, refreshActions }) {
  const parts = displayParts(m);
    if (!m._displayFragment && (parts.length > 1 || wrap._flowMode || m._sequentialPresentation)) {
      wrap._flowMode = true;
      wrap.classList.toggle('cancelled', !!m.cancelled);
      let flow = wrap.querySelector(':scope > .assistant-flow');
      if (!flow) {
        flow = document.createElement('div'); flow.className = 'assistant-flow';
        for (const child of [...wrap.children]) if (child.matches('.md-body,.tool-chips,.reasoning,.explored-files,.edited-files,.message-tail')) child.remove();
        const anchor = wrap.querySelector(':scope > .msg-foot') || wrap.querySelector(':scope > .msg-actions');
        wrap.insertBefore(flow, anchor || null);
      }
      const rows = parts.length ? parts : [{ kind: 'text', text: '', toolCalls: [] }];
      const seen = new Set();
      rows.forEach((part, index) => {
        const key = String(index); seen.add(key);
        let row = [...flow.children].find((n) => n.dataset.part === key);
        if (!row) {
          row = document.createElement('div'); row.className = 'assistant-fragment'; row.dataset.part = key;
          row.innerHTML = '<div class="md-body"></div><div class="tool-chips"></div>';
          flow.appendChild(row);
        }
        row.dataset.ownerId = m.id;
        row.dataset.family = part.kind;
        const last = index === rows.length - 1;
        paintPart(row, { ...m, ...part, _displayFragment: true,
          done: last ? m.done : true, cancelled: last && m.cancelled, error: last ? m.error : null,
          reasoning: index === 0 ? m.reasoning : '', thoughtHidden: index === 0 && m.thoughtHidden,
          thinkingBlocks: index === 0 ? m.thinkingBlocks : [], usage: index === 0 ? m.usage : null,
          webSearch: last ? m.webSearch : null, tempCommit: last ? m.tempCommit : null,
        });
      });
      for (const row of [...flow.children]) if (!seen.has(row.dataset.part)) row.remove();
      paintMeta(wrap, m); paintFoot(wrap, m); syncShell(wrap);
      syncFolds();
      refreshActions();
      return true;
    }
  return false;
}

import { toolWindowsOf, renderToolWindowsHtml } from './toolwindows.js?v=2026.10.9.5';
export function renderToolChipDetail(chip) {
    if (!chip || !chip._detail) return;
    const w = toolWindowsOf(chip);
    chip._win = w;
    const sig = JSON.stringify([w.command, w.stdout, w.stderr, w.missing]);
    if (chip._detailSig !== sig) {
      chip._detailSig = sig;
      const expected = w.stderr ? ['command', 'stdout', 'stderr'] : ['command', 'stdout'];
      const existing = [...chip._detail.querySelectorAll('[data-win]')].map((n) => n.dataset.win);
      if (expected.join() !== existing.join()) chip._detail.innerHTML = renderToolWindowsHtml(w);
      else for (const kind of expected) {
        const pre = chip._detail.querySelector(`[data-win="${kind}"] pre`);
        const text = w[kind] || (kind === 'stdout' ? (w.stderr ? '（无标准输出）' : '（空输出）') : '');
        if (pre && pre.textContent !== text) pre.textContent = text;
      }
    }
  }


import { $, $$, el, esc } from './ui-markdown.js?v=2026.10.9.5';
import { ICON } from './icons.js';

// Append newly-revealed calls without replacing earlier widgets or their windows.
export function paintCommandRows(chips, { groups, sig, scope, ownerId, commandToggle, callToggle, liveToolCallIds }) {
    if (chips.dataset.sig !== sig) {
      chips.dataset.sig = sig;
      if (!groups.length) chips.replaceChildren();
      else {
        const groupId = scope + ':' + String(groups[0]?.items[0]?.id || ownerId);
        let groupFold = $('.ran-commands', chips);
        if (!groupFold || groupFold.dataset.groupId !== groupId) {
          chips.replaceChildren(); groupFold = el('div', 'ran-commands');
          groupFold.dataset.ownerId = ownerId; groupFold.dataset.groupId = groupId;
          groupFold._userToggle = commandToggle.get(groupId) ?? null;
          groupFold.innerHTML = `<span class="chip-ico chip-ico-term">${ICON.terminal || ICON.tool || ''}</span><span class="mono chip-name"></span><span class="chip-state">…</span><div class="chip-detail"><div class="fold-inner"><div class="ran-command-items"></div></div></div>`;
          groupFold.addEventListener('click', (e) => {
            if (e.target.closest('.tool-call-chip, a, button, .chip-copy')) return;
            groupFold.classList.toggle('expanded'); groupFold._userToggle = groupFold.classList.contains('expanded');
            commandToggle.set(groupFold.dataset.groupId, groupFold._userToggle);
          });
          chips.appendChild(groupFold);
        }
        groupFold.dataset.sig = sig;
        const itemsBox = $('.ran-command-items', groupFold);
        const existing = new Map($$('.tool-call-chip', itemsBox).map((node) => [node.dataset.callId, node]));
        const wanted = new Set();
        groups.forEach((g, index) => {
          const ids = g.items.map((t) => t.id).filter(Boolean), id = String(ids[0] || ''); wanted.add(id);
          let child = existing.get(id);
          if (!child) {
            child = el('div', 'chip tool-call-chip'); child.dataset.callIds = ids.join(','); child.dataset.callId = id;
            child._toggleKey = scope + ':' + id; child._userToggle = callToggle.get(child._toggleKey) ?? null;
            child.innerHTML = `<span class="chip-ico">${ICON.tool || ''}</span><span class="mono chip-name">${esc(g.name)}</span><span class="chip-state">…</span>`;
            child.addEventListener('click', (e) => {
              if (e.target.closest('.chip-copy, button, a, .chip-win-b')) return;
              child.classList.toggle('expanded'); child._userToggle = child.classList.contains('expanded');
              callToggle.set(child._toggleKey, child._userToggle);
            });
            child._detail = el('div', 'chip-detail mono'); child.appendChild(child._detail);
            child._outs = {}; child._toolStates = {};
          }
          if (itemsBox.children[index] !== child) itemsBox.insertBefore(child, itemsBox.children[index] || null);
          child._items = g.items; child._args = g.items[0]?.args;
          for (const t of g.items) {
            if (t.id == null) continue;
            const key = String(t.id);
            if (t.status || Number.isFinite(Number(t.durationMs))) child._toolStates[key] = {
              status: t.status, settled: t.settled, note: t.errorNote || t.progressNote || '', durationMs: t.durationMs,
            };
            else if (liveToolCallIds.has(key) && !child._toolStates[key]) child._toolStates[key] = { status: 'running', settled: t.settled };
          }
        });
        for (const [id, child] of existing) if (!wanted.has(id)) child.remove();
      }
    }
}

// Scope repeated provider call IDs to their owning message/turn, not the first DOM match.
const toolOwners = new WeakMap();
export function ownerOfTool(messages, call, resultMessage) {
  if (resultMessage?.id) {
    const at = messages.findIndex((m) => m.id === resultMessage.id);
    if (at >= 0) {
      for (let i = at - 1; i >= 0 && !(messages[i].role === 'user' && !messages[i].silent); i--)
        if (messages[i].role === 'assistant' && messages[i].toolCalls?.some((c) => String(c.id) === String(call.id))) return messages[i];
      return null;
    }
  }
  // Remember the real owner before the kernel shallow-clones toolCalls. Deleted
  // turns/regeneration must not redirect a late event to a reused provider ID.
  if (toolOwners.has(call)) {
    const owner = toolOwners.get(call);
    return messages.includes(owner) ? owner : null;
  }
  const owner = messages.find((m) => m.role === 'assistant' && m.toolCalls?.includes(call))
    || messages.findLast((m) => m.role === 'assistant' && m.toolCalls?.some((c) => String(c.id) === String(call.id)
      && (!Object.hasOwn(call, 'args') || c.args === call.args)));
  if (owner && call && typeof call === 'object') toolOwners.set(call, owner);
  return owner;
}

export function paintVisibleTurn(messages, msgNodes, paint, skipId) {
  const start = messages.findLastIndex((m) => m.role === 'user' && !m.silent);
  for (const m of messages.slice(start + 1)) {
    const wrap = m.role === 'assistant' && m.id !== skipId && msgNodes.get(m.id);
    if (wrap) paint(wrap, m);
  }
}

export function activeToolOwner(messages, call, stopped) {
  if (stopped) return null;
  const owner = ownerOfTool(messages, call);
  return owner && !owner.cancelled && messages.indexOf(owner) > messages.findLastIndex((m) => m.role === 'user' && !m.silent) ? owner : null;
}
