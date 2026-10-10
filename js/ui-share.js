import { buildShareDocument } from './share-document.js?v=2026.10.10.1';
import { captureShare } from './share-capture.js';
import { createZip } from './zip.js';
import { text, onLanguageChange } from './locale.js';
export function shareableMessages(messages) { return (messages || []).filter((m) => ['user', 'assistant'].includes(m?.role) && !m.transientModeration); }
export function installSharing({ store, agent, getBusy, root, toast }) {
  const $ = (id) => document.getElementById(id), modal = $('share-modal'), list = $('share-messages');
  if (!modal || !list) return { refresh() {} };
  let selected = new Set(), openedSession = '', exporting = false, abort, opener;
  const update = () => {
    const count = text(`已选 ${selected.size} 条`, `${selected.size} selected`); if ($('share-count').textContent !== count) $('share-count').textContent = count;
    for (const id of ['share-png', 'share-html']) $(id).disabled = exporting || !selected.size;
    $('share-open').disabled = getBusy() || !shareableMessages(store.state.messages).length;
  };
  const refresh = () => {
    update();
    if (modal.classList.contains('open') && openedSession !== store.state.activeSessionId) close();
    for (const node of root.querySelectorAll('.msg[data-id]')) {
      const host = node.querySelector('.msg-actions');
      const existing = host?.querySelector('[data-share-message-button]');
      if (existing) { const label = text('分享', 'Share'), span = existing.querySelector('span'); if (span && span.textContent !== label) span.textContent = label; }
      if (host && !existing) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'act'; b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg><span></span>'; b.querySelector('span').textContent = text('分享', 'Share'); b.dataset.shareMessageButton = node.dataset.id; b.title = text('分享对话', 'Share conversation'); host.append(b);
      }
    }
  };
  const renderPicker = () => {
    list.replaceChildren();
    for (const m of shareableMessages(store.state.messages)) {
      const label = document.createElement('label'); label.className = 'share-row';
      const input = document.createElement('input'); input.type = 'checkbox'; input.value = m.id; input.checked = selected.has(m.id);
      const content = document.createElement('span'); content.className = 'share-row-content';
      const role = document.createElement('span'); role.className = 'share-row-role'; role.textContent = m.role === 'user' ? text('用户', 'You') : 'Dubhe Agent';
      const summary = document.createElement('span'); summary.className = 'share-row-text'; summary.dataset.i18nIgnore = '1'; summary.textContent = String(m.text || m.error || (m.toolCalls?.length ? text(`工具记录（${m.toolCalls.length}）`, `Tool calls (${m.toolCalls.length})`) : text('空消息', 'Empty message'))).slice(0, 220);
      content.append(role, summary); label.append(input, content); list.append(label);
    }
    update();
  };
  const open = (id) => {
    if (getBusy()) return toast(text('请等待当前任务结束后分享', 'Wait for the current task to finish before sharing'), 'warn');
    opener = document.activeElement; openedSession = store.state.activeSessionId;
    selected = new Set(id ? [id] : shareableMessages(store.state.messages).slice(-2).map((m) => m.id));
    renderPicker(); modal.classList.add('open'); modal.setAttribute('aria-hidden', 'false'); $('share-close').focus();
  };
  function close() { abort?.abort(); modal.classList.remove('open'); modal.setAttribute('aria-hidden', 'true'); opener?.focus?.(); }
  $('share-open').addEventListener('click', () => open()); $('share-close').addEventListener('click', close);
  root.addEventListener('click', (e) => { const b = e.target.closest('[data-share-message-button]'); if (b) { e.preventDefault(); open(b.dataset.shareMessageButton); } });
  list.addEventListener('change', (e) => { if (e.target.matches('input[type=checkbox]')) { e.target.checked ? selected.add(e.target.value) : selected.delete(e.target.value); update(); } });
  $('share-all').addEventListener('click', () => { selected = new Set(shareableMessages(store.state.messages).map((m) => m.id)); renderPicker(); });
  $('share-none').addEventListener('click', () => { selected.clear(); renderPicker(); });
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => {
    if (!modal.classList.contains('open')) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Tab') {
      const controls = [...modal.querySelectorAll('button:not(:disabled),input:not(:disabled)')].filter((n) => n.offsetParent !== null), first = controls[0], last = controls.at(-1);
      if (!first) return;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  const download = (blob, filename) => { const href = URL.createObjectURL(blob), a = document.createElement('a'); a.href = href; a.download = filename; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(href), 60000); };
  const runExport = async (format) => {
    if (exporting || !selected.size) return;
    if (getBusy()) return toast(text('请等待当前任务结束后分享', 'Wait for the current task to finish before sharing'), 'warn');
    const messages = [...store.state.messages], chosen = shareableMessages(messages).filter((m) => selected.has(m.id));
    if (!chosen.length) return;
    const files = agent.fs.export(), fs = { read: (p) => Object.hasOwn(files, p) ? files[p] : null };
    const session = store.state.sessions?.find((s) => s.id === store.state.activeSessionId);
    const title = session?.title || 'Dubhe Agent';
    const name = String(title).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 70) || 'Dubhe-Agent';
    const options = { messages, selected: chosen, fs, title, tools: $('share-tools').checked, reasoning: $('share-reasoning').checked, interactive: format === 'html' };
    abort = new AbortController(); const mine = abort; exporting = true; update();
    const notice = toast(text('正在导出…', 'Exporting…'), 'info', 120000);
    try {
      const html = await buildShareDocument(options);
      if (mine.signal.aborted) return;
      if (format === 'html') download(new Blob([html], { type: 'text/html;charset=utf-8' }), name + '.html');
      else {
        const parts = await captureShare(html, { signal: mine.signal }); if (mine.signal.aborted) return;
        if (parts.length === 1) download(parts[0], name + '.png');
        else {
          const entries = await Promise.all(parts.map(async (b, i) => ({ name: `${name}-${String(i + 1).padStart(2, '0')}.png`, bytes: new Uint8Array(await b.arrayBuffer()) })));
          download(new Blob([createZip(entries)], { type: 'application/zip' }), name + '-images.zip');
          toast(text(`内容过长，完整拆成 ${parts.length} 张长图（ZIP），没有截断`, `Split into ${parts.length} complete long images (ZIP); nothing was truncated`), 'ok', 6500);
        }
      }
      toast(text('分享文件已导出', 'Share file exported'), 'ok');
    } catch (err) { if (err.name !== 'AbortError') toast(text('导出失败：', 'Export failed: ') + err.message, 'err', 7000); }
    finally { notice?.dismiss?.(); exporting = false; update(); }
  };
  $('share-html').addEventListener('click', () => runExport('html')); $('share-png').addEventListener('click', () => runExport('png'));
  store.subscribe(refresh);
  const observer = new root.ownerDocument.defaultView.MutationObserver(() => refresh()); observer.observe(root, { childList: true, subtree: true });
  // Adding buttons produces one further mutation, but existing controls are never rebuilt.
  onLanguageChange(() => { if (modal.classList.contains('open')) renderPicker(); refresh(); }); refresh();
  return { refresh, open, export: runExport, disconnect: () => observer.disconnect() };
}
