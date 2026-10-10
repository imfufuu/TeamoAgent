// Stable editing DOM: filenames, headers, existing lines and scroll position survive
// parameter deltas. Only new/changed lines are patched; no per-delta innerHTML reset.
import { editPreviewMeta, editPreviewFoot } from './ui-markdown.js?v=2026.10.10.1';

const make = (tag, cls, text) => {
  const node = document.createElement(tag); node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};
const text = (node, value) => { const next = String(value || ''); if (node.textContent !== next) node.textContent = next; };

export function paintEditFoldContent(node, { icon = '', label, paths, discarded, preview, live, state = '' }) {
  let dom = node._editDom;
  if (!dom) {
    const ico = make('span', 'chip-ico think-ico'); ico.innerHTML = icon;
    const name = make('span', 'mono chip-name');
    const status = make('span', 'chip-state ep-state');
    const detail = make('div', 'chip-detail'), inner = make('div', 'fold-inner');
    const list = make('ul', 'edit-paths'), note = make('div', 'fold-note');
    const window = make('div', 'edit-preview'), head = make('div', 'ep-head mono');
    const path = make('span', 'ep-path'), meta = make('span', 'ep-meta');
    const body = make('div', 'ep-body'), empty = make('div', 'ep-line');
    empty.appendChild(make('span', 'ep-tx ep-empty', '（还没有内容）'));
    const foot = make('div', 'ep-foot mono');
    head.append(path, meta); body.appendChild(empty); window.append(head, body, foot);
    inner.append(list, note, window); detail.appendChild(inner); node.append(ico, name, status, detail);
    dom = node._editDom = { name, status, list, note, window, path, meta, body, empty, foot,
      pathRows: [], lines: [], caret: null, previewPath: null };
  }
  text(dom.name, label); text(dom.status, state); dom.status.hidden = !state;
  paths.forEach((path, index) => {
    let row = dom.pathRows[index];
    if (!row) {
      const item = make('li', 'mono'), name = make('span', 'edit-path'), tag = make('span', 'fold-tag');
      item.append(name, tag); dom.list.appendChild(item);
      row = { item, name, tag }; dom.pathRows.push(row);
    }
    const dropped = discarded.has(path);
    text(row.name, path); row.item.dataset.path = path;
    row.item.classList.toggle('fold-discarded', dropped);
    row.item.title = dropped ? '回合结束时最终回答没有提到这个文件，临时沙箱已把它丢弃；在回答里写出路径或文件名即可保留' : '';
    text(row.tag, dropped ? '已丢弃 · 回答未引用' : ''); row.tag.hidden = !dropped;
  });
  while (dom.pathRows.length > paths.length) dom.pathRows.pop().item.remove();
  text(dom.note, discarded.size ? `本轮丢弃 ${discarded.size} 个未在回答中引用的临时文件；internal/ 与 uploads/ 下的文件总是保留。` : '');
  dom.note.hidden = !discarded.size;
  node.classList.toggle('has-discarded', discarded.size > 0);
  dom.window.hidden = !preview;
  if (!preview) return;
  dom.window.dataset.policy = preview.policyVersion || '';
  dom.window.dataset.status = preview.status || '';
  text(dom.path, preview.path || '(路径未定)'); text(dom.meta, editPreviewMeta(preview));
  text(dom.foot, editPreviewFoot(preview)); dom.foot.hidden = !dom.foot.textContent;
  const pathChanged = dom.previewPath !== preview.path;
  const follow = pathChanged || (live && dom.body.scrollHeight - dom.body.scrollTop - dom.body.clientHeight < 32);
  const scrollTop = dom.body.scrollTop, scrollLeft = dom.body.scrollLeft;
  const incoming = preview.lines || [], added = document.createDocumentFragment();
  incoming.forEach((line, index) => {
    let row = dom.lines[index];
    if (!row) {
      const item = make('div', 'ep-line'), number = make('span', 'ep-no'), value = make('span', 'ep-tx');
      item.append(number, value); added.appendChild(item);
      row = { item, number, value, numberText: null, content: null }; dom.lines.push(row);
    }
    if (row.numberText !== line.no) { row.number.textContent = String(line.no); row.numberText = line.no; }
    if (row.content !== line.text) { row.value.textContent = String(line.text); row.content = line.text; }
  });
  // The caret lives after the code, not between old and newly-appended lines.
  dom.body.insertBefore(added, dom.caret);
  while (dom.lines.length > incoming.length) dom.lines.pop().item.remove();
  if (incoming.length) dom.empty.remove();
  else if (!dom.empty.isConnected) dom.body.prepend(dom.empty);
  const cursor = live && !preview.complete;
  if (cursor && !dom.caret) { dom.caret = make('span', 'ep-caret'); dom.caret.setAttribute('aria-hidden', 'true'); dom.body.appendChild(dom.caret); }
  else if (!cursor && dom.caret) { dom.caret.remove(); dom.caret = null; }
  dom.body.scrollTop = follow ? dom.body.scrollHeight : (pathChanged ? 0 : scrollTop);
  dom.body.scrollLeft = pathChanged ? 0 : scrollLeft;
  dom.previewPath = preview.path;
}

import { presentationCallSettled } from './toolpresentation.js?v=2026.10.10.1';
import { turnHasAssistantText } from './toolflow.js?v=2026.10.10.1';
export function syncEditingFold(node, { messages, visibleMessages, resultIds, busy }) {
  if (!node) return;
  const owner = messages.find((m) => m.id === node.dataset.ownerId);
  const lastUser = messages.findLastIndex((m) => m.role === 'user' && !m.silent);
  const current = owner && messages.indexOf(owner) > lastUser;
  node._active = !!(current && busy && !owner.cancelled
    && node._activeCalls?.some((call) => !presentationCallSettled(call, resultIds)));
  const autoOpen = node._active || !turnHasAssistantText(visibleMessages, node.dataset.ownerId);
  node.classList.toggle('expanded', node._userToggle == null ? autoOpen : node._userToggle);
}
