// Stable DOM fragments in persisted SSE order; UI business rules stay in ui.js.
import { displayParts } from './toolflow.js?v=2026.10.9.4';
export function paintOrderedAssistant(wrap, m, { paintPart, paintMeta, paintFoot, syncShell, syncFolds, refreshActions }) {
  const parts = displayParts(m);
    if (!m._displayFragment && (parts.length > 1 || wrap._flowMode)) {
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

import { toolWindowsOf, renderToolWindowsHtml } from './toolwindows.js?v=2026.10.9.4';
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

