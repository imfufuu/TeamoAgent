// ─── UI · ⌘K 命令面板 + 全局快捷键（P4 拆分：从 mountUI 抽出）──────────────────
// 拥有：#cmd-palette 的打开/关闭/绘制/键盘导航、命令项收集（模型 / 文件 / 操作 / 诊断）、
//       document 级快捷键：⌘K 面板、⌘B 沙箱面板、⌃1–9 快速切换模型。
// 不拥有：模型切换本身（selectModel）、文件查看器、系统命令执行——均经 deps 注入；本文件绝不 import ui.js。
import { $, esc } from './ui-markdown.js?v=2026.10.5.28';
import { filterCmds } from './commands.js';

export function installCommandPalette({ store, agent, toast, chatModels, selectModel, openFileViewer, setPanelCollapsed, handleSystemCommand }) {
  // ⌘K 命令面板
  const pal = $('#cmd-palette');
    const palInput = $('#cmd-input');
  const palList = $('#cmd-list');
  let palItems = [];
  let palIdx = 0;
  function collectCmds() {
    const items = [];
    chatModels().forEach((m, i) => items.push({
      group: '模型', id: 'm:' + m.id, label: m.id, hint: m.provider || '',
      kbd: i < 9 ? '⌃' + (i + 1) : '',
      run: () => selectModel(m.id),
    }));
    try {
      for (const f of agent.fs.list()) {
        items.push({ group: '文件', id: 'f:' + f.path, label: f.path, run: () => {
          setPanelCollapsed(false);
          openFileViewer(f.path);
        } });
      }
    } catch { /* fs 未就绪 */ }
    items.push({ group: '操作', id: 'p:panel', label: '打开 / 收起沙箱面板', kbd: '⌘B', run: () => setPanelCollapsed(!$('#sandbox-panel').classList.contains('collapsed')) });
    items.push({ group: '操作', id: 'p:new', label: '新建会话', run: () => $('#new-session').click() });
    // P2 诊断入口（等价于输入 /p2）：命令通道是本地执行的，不受当前模型影响
    items.push({ group: '诊断', id: 'd:p2', label: 'P2 报告（策略 / 指标 / 审计三层 / 故障 / 实验 / 上下文）', run: () => { if (store.state.model !== '__system__') selectModel('__system__'); handleSystemCommand('/p2'); } });
    items.push({ group: '诊断', id: 'd:p2f', label: 'P2 故障注入（红队自测：列出可注入故障）', run: () => { if (store.state.model !== '__system__') selectModel('__system__'); handleSystemCommand('/p2 fault'); } });
    if (globalThis.__dubheDebugToggle) items.push({ group: '操作', id: 'p:debug', label: globalThis.__dubheDebugActive && globalThis.__dubheDebugActive() ? '关闭调试浮窗（系统日志）' : '打开调试浮窗（系统日志）', kbd: '⌃⌥D', run: () => globalThis.__dubheDebugToggle() });
    return items;
  }
  function paintPal() {
    if (!palList) return;
    const vis = filterCmds(palInput ? palInput.value : '', palItems);
    palList.innerHTML = vis.map((it, i) => `<button type="button" class="cmd-item${i === palIdx ? ' active' : ''}" data-i="${i}" role="option"><span class="cmd-g">${esc(it.group)}</span><span class="cmd-l">${esc(it.label)}</span>${it.kbd ? `<span class="cmd-k">${esc(it.kbd)}</span>` : ''}</button>`).join('')
      || '<div class="empty-hint">无匹配</div>';
    palList._vis = vis;
  }
  function openPal() {
    if (!pal) return;
    palItems = collectCmds();
    palIdx = 0;
    pal.hidden = false;
    if (palInput) { palInput.value = ''; palInput.focus(); }
    paintPal();
  }
  function closePal() {
    if (pal) pal.hidden = true;
  }
  function runPal(it) {
    closePal();
    if (it && typeof it.run === 'function') it.run();
  }
  if (palInput) palInput.addEventListener('input', () => { palIdx = 0; paintPal(); });
  if (palList) palList.addEventListener('click', (e) => {
    const row = e.target.closest('.cmd-item');
    if (!row) return;
    const vis = palList._vis || [];
    runPal(vis[+row.dataset.i]);
  });
  if (pal) pal.addEventListener('click', (e) => { if (e.target === pal) closePal(); });

  document.addEventListener('keydown', (e) => {
    const meta = e.metaKey || e.ctrlKey;
    const inPal = pal && !pal.hidden;
    if (inPal) {
      const vis = palList && palList._vis || [];
      if (e.key === 'Escape') { e.preventDefault(); closePal(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); palIdx = Math.min(vis.length - 1, palIdx + 1); paintPal(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); palIdx = Math.max(0, palIdx - 1); paintPal(); return; }
      if (e.key === 'Enter') { e.preventDefault(); runPal(vis[palIdx]); return; }
    }
    if (e.key === 'Escape' && pal && !pal.hidden) { e.preventDefault(); closePal(); return; }
    if (meta && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); inPal ? closePal() : openPal(); return; }
    if (meta && (e.key === 'b' || e.key === 'B')) {
      e.preventDefault();
      setPanelCollapsed(!$('#sandbox-panel').classList.contains('collapsed'));
      return;
    }
    if ((e.ctrlKey || e.altKey) && /^[1-9]$/.test(e.key)) {
      const mods = chatModels();
      const pick = mods[+e.key - 1];
      if (pick) { e.preventDefault(); selectModel(pick.id); toast(`模型 ${pick.id}`, 'ok', 1800); }
    }
  });
  return { openPal, closePal };
}
