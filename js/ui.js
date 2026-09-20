// ─── UI 层：渲染 / 交互 / 动画 ─────────────────────────────────────────
import { FALLBACK_MODELS, PROVIDER_ORDER, providerOf, protocolOf, isFreeModel, supportsFastMode, supportsVision, isImageModel, BASE_URL } from './config.js';
import { fetchModels, getTransport, fetchBalance } from './api.js';
import { estimateTokens, contextBudgetFor } from './context.js';
import { providerIcon, APP_LOGO } from './icons.js';
import { SUBAGENTS } from './subagents.js';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtSize = (n) => (n == null ? '' : n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(1)}K` : `${(n / 1048576).toFixed(1)}M`);

const contextBudgetLabel = (model) => {
  const b = contextBudgetFor(model);
  return b >= 1000 ? `${Math.round(b / 1000)}k` : String(b);
};

// 附件展示（用户气泡内）
function renderAttachments(atts) {
  if (!atts || !atts.length) return '';
  const items = atts.map((a) => {
    if (a.kind === 'image') {
      return a.dataUrl
        ? `<a class="att-img" href="${a.dataUrl}" target="_blank" rel="noopener" title="${esc(a.name)}"><img src="${a.dataUrl}" alt="${esc(a.name)}"></a>`
        : `<span class="att-file mono" title="内容未持久化">🖼 ${esc(a.name)}（已省略）</span>`;
    }
    return `<span class="att-file mono" title="${esc(a.name)}">📄 ${esc(a.name)}${a.stripped ? '（已省略）' : ` · ${fmtSize(a.size)}`}</span>`;
  }).join('');
  return `<div class="att-row">${items}</div>`;
}

// ── Markdown 渲染：markdown-it（本地打包 assets/md/，完整 CommonMark + GFM 表格）
//    + KaTeX 公式；两者任一未加载时回退到内置精简渲染器（先转义再解析，无 XSS 面）──
let mdEngine; // undefined=未初始化 null=不可用
function getMd() {
  if (mdEngine === undefined) {
    if (typeof markdownit === 'undefined') { mdEngine = null; }
    else {
      const md = markdownit({ html: false, linkify: true, breaks: false, typographer: false });
      md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
        tokens[idx].attrSet('target', '_blank');
        tokens[idx].attrSet('rel', 'noopener noreferrer');
        return self.renderToken(tokens, idx, options);
      };
      md.renderer.rules.fence = (tokens, idx) => {
        const tk = tokens[idx];
        const lang = (tk.info || '').trim().split(/\s+/)[0] || 'text';
        return `<pre data-lang="${md.utils.escapeHtml(lang)}"><button class="copy-code" type="button">复制</button><code>${md.utils.escapeHtml(tk.content.replace(/\n$/, ''))}</code></pre>\n`;
      };
      // GFM 任务列表（markdown-it 核心不含）：[ ] / [x] 开头的列表项 → checkbox
      md.core.ruler.after('inline', 'task-lists', (state) => {
        let inList = 0;
        for (const tok of state.tokens) {
          if (tok.type === 'bullet_list_open' || tok.type === 'ordered_list_open') inList++;
          else if (tok.type === 'bullet_list_close' || tok.type === 'ordered_list_close') inList--;
          if (tok.type !== 'inline' || !inList || !tok.children || !tok.children.length) continue;
          const first = tok.children[0];
          if (first.type !== 'text') continue;
          const m = /^\[([ xX])\]\s+/.exec(first.content);
          if (!m) continue;
          first.content = first.content.slice(m[0].length);
          const cb = new state.Token('html_inline', '', 0);
          cb.content = m[1] === ' ' ? '<input type="checkbox" disabled> ' : '<input type="checkbox" checked disabled> ';
          tok.children.unshift(cb);
        }
      });
      mdEngine = md;
    }
  }
  return mdEngine;
}

export function renderMarkdown(src) {
  const codeBlocks = [];
  let t = String(src || '').replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push({ lang, code });
    return `\uE000CB${codeBlocks.length - 1}\uE000`;
  });
  // LaTeX：$$..$$ / \[..\] 块级，$..$ / \(..\) 行内；在渲染前提取，占位保护
  const maths = [];
  const hasKatex = typeof katex !== 'undefined';
  const pushMath = (tex, display) => {
    if (hasKatex) {
      try {
        maths.push(katex.renderToString(tex, { displayMode: display, throwOnError: false }));
        return `\uE000M${maths.length - 1}\uE000`;
      } catch { /* 渲染失败按原文处理 */ }
    }
    return display ? `\n\`\`\`tex\n${tex}\n\`\`\`\n` : `\`${tex}\``; // 降级：代码形式展示
  };
  t = t
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, x) => pushMath(x, true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, x) => pushMath(x, true))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, x) => pushMath(x, false))
    .replace(/\$([^\s$](?:[^$\n]*?[^\s$])?)\$/g, (_, x) => pushMath(x, false));

  const restoreCb = (html) => html.replace(/\uE000CB(\d+)\uE000/g, (_, i) => {
    const { lang, code } = codeBlocks[+i];
    return `<pre data-lang="${esc(lang || 'text')}"><button class="copy-code" type="button">复制</button><code>${esc(code.replace(/\n$/, ''))}</code></pre>`;
  });
  const restoreMath = (html) => html.replace(/\uE000M(\d+)\uE000/g, (_, i) => maths[+i]); // KaTeX 输出已是安全 HTML

  const md = getMd();
  if (md) {
    let html = md.render(t);
    html = restoreCb(html);
    html = restoreMath(html);
    // 独占一段的代码块去掉外层 <p>，避免 <p><pre> 嵌套
    return html.replace(/<p>(<pre[\s\S]*?<\/pre>)<\/p>/g, '$1');
  }

  // ── 内置精简回退（markdown-it 未加载时）──
  t = esc(t);
  t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  t = t.replace(/^###### (.*)$/gm, '<h6>$1</h6>').replace(/^##### (.*)$/gm, '<h5>$1</h5>')
    .replace(/^#### (.*)$/gm, '<h4>$1</h4>').replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>').replace(/^# (.*)$/gm, '<h1>$1</h1>');
  t = t.replace(/^&gt; (.*)$/gm, '<blockquote>$1</blockquote>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // 列表（连续行聚合）
  t = t.replace(/(?:^|\n)((?:[-*] .+(?:\n|$))+)/g, (m) => '\n<ul>' + m.trim().split('\n').map((l) => `<li>${l.replace(/^[-*] /, '')}</li>`).join('') + '</ul>');
  t = t.replace(/(?:^|\n)((?:\d+\. .+(?:\n|$))+)/g, (m) => '\n<ol>' + m.trim().split('\n').map((l) => `<li>${l.replace(/^\d+\. /, '')}</li>`).join('') + '</ol>');
  t = t.replace(/\n{2,}/g, '</p><p>').replace(/^(?!<[a-z])/, '<p>').replace(/(?!>)$/, '</p>');
  t = t.replace(/<p>\s*(<(?:h\d|ul|ol|blockquote|pre))/g, '$1').replace(/(<\/(?:h\d|ul|ol|blockquote|pre)>)\s*<\/p>/g, '$1');
  return restoreMath(restoreCb(t));
}

// ── Toast ───────────────────────────────────────────────────────────────
export function toast(msg, type = 'info', ms = 2600) {
  const wrap = $('#toasts');
  const t = el('div', `toast ${type}`, `<span>${esc(msg)}</span>`);
  wrap.appendChild(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 400); }, ms);
}

// ── 主 UI ───────────────────────────────────────────────────────────────
export function mountUI(store, agent) {
  const msgList = $('#messages');
  const composer = $('#composer-input');
  const sendBtn = $('#send-btn');
  const statusDot = $('#status-dot');
  const statusText = $('#status-text');
  const msgNodes = new Map();

  let streamingId = null;
  let rafPending = false;

  // ── 主题 ──
  const applyTheme = () => document.documentElement.dataset.theme = store.state.settings.theme;
  applyTheme();
  $('#theme-toggle').addEventListener('click', () => {
    store.state.settings.theme = store.state.settings.theme === 'light' ? 'dark' : 'light';
    applyTheme(); store.notify();
  });

  // ── 模型下拉 ──
  const ddBtn = $('#model-btn');
  const ddMenu = $('#model-menu');
  const ddSearch = $('#model-search');
  function mergedModels() {
    const map = new Map();
    for (const m of FALLBACK_MODELS) map.set(m.id, { ...m });
    for (const id of store.state.models || []) {
      if (!map.has(id)) map.set(id, { id, provider: providerOf(id) });
    }
    return [...map.values()];
  }
  function renderModelMenu() {
    const q = ddSearch.value.trim().toLowerCase();
    const list = mergedModels().filter((m) => !q || m.id.toLowerCase().includes(q));
    const groups = new Map();
    for (const m of list) {
      if (!groups.has(m.provider)) groups.set(m.provider, []);
      groups.get(m.provider).push(m);
    }
    const order = [...PROVIDER_ORDER.filter((p) => groups.has(p)), ...[...groups.keys()].filter((p) => !PROVIDER_ORDER.includes(p))];
    ddMenu.querySelectorAll('.dd-group, .dd-empty').forEach((n) => n.remove());
    for (const p of order) {
      const g = el('div', 'dd-group');
      g.appendChild(el('div', 'dd-group-title', `${providerIcon(p)}<span>${esc(p)}</span>`));
      for (const m of groups.get(p)) {
        const item = el('button', 'dd-item' + (m.id === store.state.model ? ' active' : ''));
        item.type = 'button';
        item.innerHTML = `<span class="dd-item-id mono">${esc(m.id)}</span>
          <span class="dd-item-badges">
            ${isFreeModel(m.id) ? '<span class="badge">FREE</span>' : ''}
            ${supportsVision(m.id) ? '<span class="badge vision" title="支持图片输入（多模态）"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg></span>' : ''}
            ${isImageModel(m.id) ? '<span class="badge img" title="文生图：文本生成图片（POST /v1/images/generations）"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5 5-4-4"/></svg></span>' : ''}
            ${protocolOf(m.id) === 'anthropic' ? '<span class="badge ghost">原生</span>' : ''}
          </span>`;
        item.addEventListener('click', () => {
          store.state.model = m.id; store.notify();
          updateModelBtn(); closeMenu();
          $('#fast-toggle').disabled = !supportsFastMode(m.id);
          if (store.state.settings.fastMode && !supportsFastMode(m.id)) {
            store.state.settings.fastMode = false; $('#fast-toggle').classList.remove('on');
          }
        });
        g.appendChild(item);
      }
      ddMenu.appendChild(g);
    }
    if (!order.length) ddMenu.appendChild(el('div', 'dd-empty', '无匹配模型'));
  }
  function updateModelBtn() {
    $('#model-btn-icon').innerHTML = providerIcon(providerOf(store.state.model));
    $('#model-btn-name').textContent = store.state.model;
    $('#model-btn-provider').textContent = providerOf(store.state.model);
  }
  const openMenu = () => {
    renderModelMenu();
    // fixed 定位（脱离侧栏 overflow:hidden 裁剪），按按钮实际位置摆放
    const r = ddBtn.getBoundingClientRect();
    ddMenu.style.left = `${r.left}px`;
    ddMenu.style.top = `${r.bottom + 6}px`;
    ddMenu.style.width = `${Math.max(r.width + 60, 260)}px`;
    ddMenu.classList.add('open');
    setTimeout(() => ddSearch.focus(), 50);
  };
  const closeMenu = () => ddMenu.classList.remove('open');
  ddBtn.addEventListener('click', () => ddMenu.classList.contains('open') ? closeMenu() : openMenu());
  ddSearch.addEventListener('input', renderModelMenu);
  document.addEventListener('click', (e) => { if (!$('#model-picker').contains(e.target)) closeMenu(); });
  window.addEventListener('resize', closeMenu);
  updateModelBtn();

  $('#refresh-models').addEventListener('click', async () => {
    if (!store.state.apiKey) return openKeyModal();
    $('#refresh-models').classList.add('spin');
    try {
      const list = await fetchModels(store.state.apiKey);
      store.state.models = list; store.notify();
      renderModelMenu();
      toast(`已获取 ${list.length} 个模型（GET /v1/models）`, 'ok');
    } catch (err) { toast('模型列表获取失败：' + err.message, 'err'); }
    finally { $('#refresh-models').classList.remove('spin'); }
  });

  // ── 开关 ──
  const sandboxToggle = $('#sandbox-toggle');
  const syncSandbox = () => sandboxToggle.classList.toggle('on', store.state.settings.sandboxEnabled);
  sandboxToggle.addEventListener('click', () => {
    store.state.settings.sandboxEnabled = !store.state.settings.sandboxEnabled;
    syncSandbox(); store.notify();
    toast(store.state.settings.sandboxEnabled ? '沙箱已开启：Agent 可执行代码与读写文件' : '沙箱已关闭：纯对话模式');
  });
  syncSandbox();

  // 思考模式（默认开启；按模型家族自动映射协议参数，不支持的模型 400 自动降级）
  const thinkingToggle = $('#thinking-toggle');
  const syncThinking = () => thinkingToggle.classList.toggle('on', store.state.settings.thinking !== false);
  thinkingToggle.addEventListener('click', () => {
    store.state.settings.thinking = !(store.state.settings.thinking !== false);
    syncThinking(); store.notify();
    toast(store.state.settings.thinking
      ? '思考模式开启：Claude→thinking · GPT/Gemini/Grok→reasoning_effort · DeepSeek→reasoning · GLM→thinking（不支持自动降级）'
      : '思考模式关闭');
  });
  syncThinking();

  const fastToggle = $('#fast-toggle');
  const syncFast = () => {
    fastToggle.classList.toggle('on', store.state.settings.fastMode);
    fastToggle.disabled = !supportsFastMode(store.state.model);
  };
  fastToggle.addEventListener('click', () => {
    store.state.settings.fastMode = !store.state.settings.fastMode;
    syncFast(); store.notify();
    toast(store.state.settings.fastMode ? 'Fast mode 开启（service_tier=fast，2x 计费，仅 GPT 系列）' : 'Fast mode 关闭');
  });
  syncFast();

  // ── API Key 弹窗（role=dialog + Esc 关闭 + 焦点圈定，a11y P2-3）──
  const keyModal = $('#key-modal');
  const keyInput = $('#key-input');
  let modalReturnFocus = null;
  window.openKeyModal = openKeyModal;
  function openKeyModal() {
    modalReturnFocus = document.activeElement;
    keyInput.value = store.state.apiKey;
    keyModal.classList.add('open');
    setTimeout(() => keyInput.focus(), 100);
  }
  function closeKeyModal() {
    if (!keyModal.classList.contains('open')) return;
    keyModal.classList.remove('open');
    // 归还焦点，键盘用户不迷失
    if (modalReturnFocus && modalReturnFocus.focus) modalReturnFocus.focus();
    modalReturnFocus = null;
  }
  $('#key-btn').addEventListener('click', openKeyModal);
  $('#key-close').addEventListener('click', closeKeyModal);
  // 点击遮罩区域关闭
  keyModal.addEventListener('click', (e) => { if (e.target === keyModal) closeKeyModal(); });
  document.addEventListener('keydown', (e) => {
    if (!keyModal.classList.contains('open')) return;
    if (e.key === 'Escape') { closeKeyModal(); return; }
    // 焦点圈定：Tab 只在弹窗内循环
    if (e.key === 'Tab') {
      const focusables = [$('#key-close'), keyInput, $('#key-save')];
      const idx = focusables.indexOf(document.activeElement);
      if (idx < 0) return;
      if (e.shiftKey && idx === 0) { e.preventDefault(); focusables[focusables.length - 1].focus(); }
      else if (!e.shiftKey && idx === focusables.length - 1) { e.preventDefault(); focusables[0].focus(); }
    }
  });
  $('#key-save').addEventListener('click', () => {
    store.state.apiKey = keyInput.value.trim(); store.notify();
    closeKeyModal();
    toast(store.state.apiKey ? 'API Key 已保存（仅存于浏览器 localStorage）' : 'API Key 已清除', 'ok');
    updateTransportBadge();
    refreshBalance();
  });
  keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#key-save').click(); });

  // ── 会话记录（侧栏只做记录与切换；回滚全部在对话区）─────────────────
  function sessionMeta(s) {
    const n = s.messages.filter((m) => m.role === 'user').length;
    const t = new Date(s.updatedAt || s.createdAt);
    const time = t.toDateString() === new Date().toDateString()
      ? t.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      : `${t.getMonth() + 1}/${t.getDate()}`;
    return `${n} 轮 · ${time}`;
  }
  function renderSessions() {
    const box = $('#session-list'); box.innerHTML = '';
    for (const s of store.sortedSessions()) {
      const node = el('div', 'sess-item' + (s.id === store.state.activeSessionId ? ' active' : ''));
      node.innerHTML = `<span class="sess-main"><span class="sess-title">${esc(s.title || '新对话')}</span><span class="sess-meta">${sessionMeta(s)}</span></span><button class="sess-del" type="button" title="删除会话" aria-label="删除会话「${esc(s.title || '新对话')}」">✕</button>`;
      node.addEventListener('click', () => switchToSession(s.id));
      $('.sess-del', node).addEventListener('click', (e) => {
        e.stopPropagation();
        if (getBusy()) return toast('请等待当前回合结束', 'warn');
        if (!confirm(`删除会话「${s.title || '新对话'}」？不可恢复。`)) return;
        const wasActive = s.id === store.state.activeSessionId;
        store.deleteSession(s.id);
        if (wasActive) agent.loadFiles(store.state.files);
        rebuildMessages(); renderSessions(); renderFiles(); updateStats();
        toast('会话已删除');
      });
      box.appendChild(node);
    }
  }
  function switchToSession(id) {
    if (id === store.state.activeSessionId) return;
    if (getBusy()) return toast('请等待当前回合结束再切换会话', 'warn');
    store.switchSession(id);
    agent.loadFiles(store.state.files);
    rebuildMessages(); renderSessions(); renderFiles(); updateStats(); renderTimeStats();
  }
  $('#new-session').addEventListener('click', () => {
    if (getBusy()) return toast('请等待当前回合结束', 'warn');
    store.createSession();
    agent.loadFiles({});
    rebuildMessages(); renderSessions(); renderFiles(); updateStats(); renderTimeStats();
    composer.focus();
  });
  renderSessions();

  // ── 回滚撤销浮条（对话区内，回滚后出现 8 秒）────────────────────────
  const undoPill = $('#undo-pill');
  let undoTimer = null;
  function showUndoPill() {
    undoPill.classList.add('show');
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => undoPill.classList.remove('show'), 8000);
  }
  undoPill.addEventListener('click', () => {
    undoPill.classList.remove('show');
    if (store.undoRollback()) { rebuildMessages(); renderSessions(); updateStats(); toast('已撤销回滚'); }
  });
  function doRollback(m) {
    if (getBusy()) return toast('请等待当前回合结束');
    if (!confirm('回滚到本轮对话之前？该轮及其后的消息将被移除（可撤销）。')) return;
    store.rollbackBeforeMessage(m.id);
    rebuildMessages(); renderSessions(); updateStats(); showUndoPill();
    toast('已回滚，可点击「撤销回滚」恢复', 'ok');
  }

  // ── 侧栏 & 沙箱面板收起体系 ───────────────────────────────────────────
  // 宽屏：两者都并入网格（收起=列宽归零，展开=挤压布局，绝不遮挡内容）
  // 窄屏：侧栏抽屉化（≤860px）、面板浮层化（≤760px），配遮罩点击关闭
  const sidebar = $('.sidebar');
  const panel = $('#sandbox-panel');
  const backdrop = $('#overlay-backdrop');
  const fab = $('#sidebar-fab');
  const mqSidebar = window.matchMedia('(max-width: 860px)');
  const mqPanel = window.matchMedia('(max-width: 760px)');

  function updateBackdrop() {
    const show = (mqSidebar.matches && sidebar.classList.contains('sidebar-open'))
      || (mqPanel.matches && !panel.classList.contains('collapsed'));
    backdrop.classList.toggle('show', show);
  }
  function setPanelCollapsed(v) {
    panel.classList.toggle('collapsed', v);
    $('#panel-toggle').textContent = v ? '◧' : '◨';
    updateBackdrop();
  }
  function setSidebarOpen(open) {
    sidebar.classList.toggle('sidebar-open', open);
    updateBackdrop();
  }
  $('#panel-toggle').addEventListener('click', () => setPanelCollapsed(!panel.classList.contains('collapsed')));
  $('#sidebar-toggle').addEventListener('click', () => {
    if (mqSidebar.matches) setSidebarOpen(false);
    else sidebar.classList.add('collapsed');
  });
  fab.addEventListener('click', () => {
    if (mqSidebar.matches) setSidebarOpen(!sidebar.classList.contains('sidebar-open'));
    else sidebar.classList.remove('collapsed');
  });
  backdrop.addEventListener('click', () => {
    setSidebarOpen(false);
    if (mqPanel.matches) setPanelCollapsed(true);
    updateBackdrop();
  });
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!mqSidebar.matches) sidebar.classList.remove('sidebar-open');
      updateBackdrop();
    }, 120);
  });
  // 初始：面板默认收起；侧栏宽屏展开、窄屏隐藏（由 fab 打开）
  setPanelCollapsed(true);
  updateBackdrop();
  $$('#panel-tabs button').forEach((b) => b.addEventListener('click', () => {
    $$('#panel-tabs button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    for (const tab of ['files', 'agents']) {
      $(`#tab-${tab}`).style.display = b.dataset.tab === tab ? '' : 'none';
    }
  }));

  // 子智能体名录（只读展示；实际调用由主 Agent 委派）
  const agentList = $('#agent-list');
  for (const a of SUBAGENTS) {
    const card = el('div', 'agent-card');
    card.innerHTML = `<div class="agent-card-head"><span class="agent-name">${esc(a.name)}</span><span class="agent-tag mono">${esc(a.id)}</span></div>
      <div class="agent-desc">${esc(a.description)}</div>
      <div class="agent-tools mono">${a.tools.length ? a.tools.map(esc).join(' · ') : '纯推理（无工具）'}</div>`;
    agentList.appendChild(card);
  }

  // 品牌图标加载失败兜底（捕获阶段监听资源错误）：替换为首字母徽章
  document.addEventListener('error', (e) => {
    const t = e.target;
    if (t && t.classList && t.classList.contains('p-icon')) {
      const span = document.createElement('span');
      span.className = 'p-icon-fallback';
      span.textContent = (t.alt || '?').slice(0, 1);
      t.replaceWith(span);
    }
  }, true);
  $('#clear-files').addEventListener('click', () => { agent.fs.clear(); store.clearFiles(); renderFiles(); toast('虚拟文件系统已清空'); });

  function renderFiles() {
    const box = $('#file-list'); box.innerHTML = '';
    const list = agent.fs.list();
    if (!list.length) { box.appendChild(el('div', 'empty-hint', '暂无文件。Agent 可通过 write_file 或沙箱代码创建。')); return; }
    for (const f of list) {
      const item = el('div', 'file-item');
      item.innerHTML = `<span class="mono file-path">${esc(f.path)}</span><span class="file-size">${f.size} B</span>`;
      item.addEventListener('click', () => {
        const viewer = $('#file-viewer');
        viewer.innerHTML = `<div class="file-viewer-head mono">${esc(f.path)}<button id="fv-close">✕</button></div><pre>${esc(agent.fs.read(f.path))}</pre>`;
        viewer.classList.add('open');
        $('#fv-close').addEventListener('click', () => viewer.classList.remove('open'));
      });
      box.appendChild(item);
    }
  }
  renderFiles();

  // ── 消息渲染 ──────────────────────────────────────────────────────────
  function renderEmpty() {
    if (store.state.messages.length) return;
    msgList.appendChild(el('div', 'empty-state', `
      <div class="empty-logo">${APP_LOGO}</div>
      <h2>TeamoAgent</h2>
      <p>基于 <span class="mono">api.teamorouter.com</span> 的网页端智能体<br>模型自选 · 代码沙箱 · 对话回滚 · 工具调用循环</p>
      <div class="empty-cards">
        <button class="suggest" type="button">用沙箱计算：前 100 个斐波那契数中有多少个质数？</button>
        <button class="suggest" type="button">写一段 JS 在沙箱里模拟蒙特卡洛估算 π，并验证结果</button>
        <button class="suggest" type="button">把《静夜思》写入 files/poem.txt，然后读出来翻译成英文</button>
      </div>`));
    $$('.suggest', msgList).forEach((b) => b.addEventListener('click', () => { composer.value = b.textContent; composer.focus(); autoGrow(); }));
  }
  function clearEmpty() { const e = $('.empty-state', msgList); if (e) e.remove(); }

  function messageNode(m) {
    const wrap = el('div', `msg msg-${m.role} enter`);
    wrap.dataset.id = m.id;
    if (m.role === 'user') {
      wrap.innerHTML = `<div class="bubble">${renderMarkdown(m.text)}${renderAttachments(m.attachments)}</div>
        <div class="msg-actions msg-actions-user"><button class="act" data-act="rollback" title="回滚到本轮之前">⤺ 回滚</button></div>`;
      $('.act', wrap).addEventListener('click', () => doRollback(m));
    } else {
      // 模型名/头像每轮（一次 user 提问开始的回合）只显示一次：
      // 仅当上一条消息是 user 时渲染 msg-head，工具循环产生的后续 assistant 消息不再重复
      const idx = store.state.messages.findIndex((x) => x.id === m.id);
      const prev = idx > 0 ? store.state.messages[idx - 1] : null;
      const showHead = !prev || prev.role === 'user';
      wrap.innerHTML = `
        ${showHead ? `<div class="msg-head"><span class="avatar">${providerIcon(providerOf(store.state.model))}</span><span class="msg-model mono">${esc(store.state.model)}</span><span class="msg-meta"></span></div>` : ''}
        <div class="md-body"></div>
        <div class="tool-chips"></div>
        <div class="msg-actions">
          <button class="act" data-act="copy" title="复制">复制</button>
          <button class="act" data-act="rollback" title="回滚到本轮之前">⤺ 回滚</button>
          <button class="act act-regen" data-act="regen" title="重新生成" style="display:none">↻ 重新生成</button>
        </div>`;
      $$('.act', wrap).forEach((b) => b.addEventListener('click', () => {
        const act = b.dataset.act;
        if (act === 'copy') { navigator.clipboard.writeText(m.text || '').then(() => toast('已复制', 'ok', 1200)); }
        if (act === 'rollback') doRollback(m);
        if (act === 'regen') {
          if (getBusy()) return;
          agent.regenerate();
        }
      }));
    }
    return wrap;
  }

  function paintAssistant(wrap, m) {
    const body = $('.md-body', wrap);
    let html = '';
    // 图片生成中（文生图模型）：等待 b64 返回前给出提示
    if (m.image === null && !m.done) {
      html += '<div class="thinking-line">🎨 正在生成图片<span class="dots">…</span></div>';
    }
    // 思考过程（深度思考模型）：完成后折叠展示，流式期间给出行提示
    if (m.done && m.reasoning) {
      html += `<details class="reasoning"><summary>思考过程</summary><div>${renderMarkdown(m.reasoning)}</div></details>`;
    } else if (!m.done && m.reasoning && !m.text && m.image == null) {
      html += '<div class="thinking-line">深度思考中<span class="dots">…</span></div>';
    }
    // 文生图结果：直接在气泡内渲染生成的图片
    if (m.image) {
      html += `<figure class="gen-image"><img src="${m.image}" alt="${(esc(m.text) || 'AI 生成图片').slice(0, 60)}"><figcaption class="gen-image-cap">${esc(m.text || 'AI 生成图片')}</figcaption></figure>`;
    }
    html += renderMarkdown(m.text || '');
    if (!m.done) html += '<span class="cursor"></span>';
    if (m.cancelled) html += '<span class="cancelled-tag">已停止</span>';
    body.innerHTML = html;
    if (m.error) body.innerHTML += `<div class="err-box">⚠ ${esc(m.error)}</div>`;
    // 工具芯片
    const chips = $('.tool-chips', wrap);
    if (m.toolCalls && m.toolCalls.length) {
      if (chips.children.length !== m.toolCalls.length) {
        chips.innerHTML = '';
        for (const t of m.toolCalls) {
          const chip = el('div', 'chip');
          chip.dataset.callId = t.id;
          chip.innerHTML = `<span class="chip-ico">⚙</span><span class="mono chip-name">${esc(t.name)}</span><span class="chip-state">…</span>`;
          chip.addEventListener('click', () => chip.classList.toggle('expanded'));
          const detail = el('div', 'chip-detail mono');
          chip.appendChild(detail);
          chip._detail = detail;
          chip._args = t.args;
          chips.appendChild(chip);
        }
      }
      for (const [i, chip] of $$('.chip', chips).entries()) {
        if (m.toolCalls[i]) chip._args = m.toolCalls[i].args;
        // 流式期间参数仍在增长，持续刷新；完成后定格
        if (!chip._renderedArgs || !m.done) {
          chip._detail.innerHTML = `<div class="chip-args">参数 ${esc(JSON.stringify(chip._args))}</div>`;
          chip._renderedArgs = !!m.done;
        }
      }
    }
    // meta（无 msg-head 的续消息没有该节点）
    const meta = $('.msg-meta', wrap);
    if (meta) {
      const parts = [];
      if (m.usage) parts.push(`↑${m.usage.input ?? '?'} ↓${m.usage.output ?? '?'} tok`);
      if (m.transport) parts.push(m.transport === 'proxy' ? '中继' : '直连');
      meta.textContent = parts.join(' · ');
    }
    // 仅最后一条 assistant 显示重新生成（文生图消息不显示，避免误触发对话循环）
    const lastAssistant = [...store.state.messages].reverse().find((x) => x.role === 'assistant');
    const regen = $('.act-regen', wrap);
    if (regen) regen.style.display = (lastAssistant && lastAssistant.id === m.id && m.done && !m.image) ? '' : 'none';
  }

  // 复制/回滚/重新生成按钮每轮只出现一次：仅回合末尾的 assistant 消息显示
  function refreshActionVisibility() {
    for (const wrap of $$('.msg-assistant', msgList)) {
      const idx = store.state.messages.findIndex((x) => x.id === wrap.dataset.id);
      if (idx < 0) continue;
      const next = store.state.messages[idx + 1];
      const isTurnEnd = !next || next.role === 'user';
      const acts = $('.msg-actions', wrap);
      if (acts) acts.style.display = isTurnEnd ? '' : 'none';
    }
  }

  function appendMessage(m) {
    clearEmpty();
    const wrap = messageNode(m);
    msgNodes.set(m.id, wrap);
    if (m.role === 'assistant') paintAssistant(wrap, m);
    msgList.appendChild(wrap);
    if (m.role === 'assistant') refreshActionVisibility();
    scrollToBottom();
  }

  function rebuildMessages() {
    msgNodes.clear(); msgList.innerHTML = '';
    renderEmpty();
    for (const m of store.state.messages) {
      if (m.role === 'tool') continue;
      appendMessage(m);
      $$('.msg', msgList).forEach((n) => n.classList.remove('enter'));
    }
    // 把 tool 结果回填到芯片
    for (const m of store.state.messages) if (m.role === 'tool') attachToolResult(m);
    refreshActionVisibility();
  }

  function attachToolResult(toolMsg) {
    const chip = $(`.chip[data-call-id="${CSS.escape(toolMsg.toolCallId)}"]`, msgList);
    if (!chip) return;
    const ok = !toolMsg.content.startsWith('工具执行失败') && !/── 错误 ──|不是合法 JSON/.test(toolMsg.content);
    $('.chip-state', chip).textContent = ok ? '✓' : '✕';
    $('.chip-state', chip).classList.toggle('bad', !ok);
    chip._detail.innerHTML = `<div class="chip-args">参数 ${esc(JSON.stringify(chip._args))}</div><pre class="chip-result">${esc(String(toolMsg.content).slice(0, 3000))}</pre>`;
    chip._renderedArgs = true;
  }

  function scrollToBottom(force) {
    const near = msgList.scrollHeight - msgList.scrollTop - msgList.clientHeight < 160;
    if (near || force) msgList.scrollTo({ top: msgList.scrollHeight, behavior: 'smooth' });
  }

  // ── 定位到最新输出（向上滚动超过阈值时浮现）─────────────────────────
  const jumpBtn = $('#jump-bottom');
  msgList.addEventListener('scroll', () => {
    const dist = msgList.scrollHeight - msgList.scrollTop - msgList.clientHeight;
    jumpBtn.classList.toggle('show', dist > 240);
  }, { passive: true });
  jumpBtn.addEventListener('click', () => {
    jumpBtn.classList.remove('show');
    scrollToBottom(true);
  });

  // ── 状态栏 ────────────────────────────────────────────────────────────
  const STATUS = {
    idle: ['', 'ok'], thinking: ['思考中', 'busy'], streaming: ['生成中', 'busy'],
    executing: ['沙箱执行中', 'busy'], done: ['', 'ok'], error: ['出错', 'err'], cancelled: ['已停止', 'warn'],
  };
  function setStatus(s) {
    const [label, cls] = STATUS[s] || STATUS.idle;
    statusText.textContent = label;
    statusDot.className = 'dot ' + cls;
    const busy = ['thinking', 'streaming', 'executing'].includes(s);
    sendBtn.classList.toggle('stop-mode', busy);
    $('#send-ico').textContent = busy ? '■' : '↑';
    sendBtn.title = busy ? '停止' : '发送 (Enter)';
  }
  function getBusy() { return ['thinking', 'streaming', 'executing'].includes(agent.getStatus()); }

  function updateTransportBadge() {
    const b = $('#transport-badge');
    b.textContent = getTransport() === 'proxy' ? '中继模式' : '直连模式';
    b.title = getTransport() === 'proxy' ? '浏览器直连失败，已通过本地服务器代理转发' : '浏览器直连 api.teamorouter.com（CORS 已放行）';
  }

  // ── 账户余额（GET /api/user/self，兼容 new-api 系 quota 单位）────────
  async function refreshBalance() {
    const badge = $('#balance-badge');
    if (!store.state.apiKey) { badge.textContent = ''; return; }
    try {
      const b = await fetchBalance(store.state.apiKey);
      if (!b) { badge.textContent = '余额 —'; badge.title = '接口未返回余额字段'; return; }
      badge.textContent = `余额 $${b.usd.toFixed(2)}${b.used != null ? ` · 已用 $${b.used.toFixed(2)}` : ''}`;
      badge.title = `GET /api/user/self${b.username ? ' · ' + b.username : ''}`;
    } catch (err) {
      badge.textContent = '余额 —';
      badge.title = err.message;
    }
  }

  // ── 输出用时（本轮 / 会话累计，随会话持久化）────────────────────────
  const fmtDur = (ms) => {
    if (!(ms > 0)) return '—';
    if (ms < 1000) return `${ms}ms`;
    const s = ms / 1000;
    return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  };
  function renderTimeStats() {
    const st = store.state.stats || {};
    $('#time-stats').textContent = st.totalMs ? `本轮 ${fmtDur(st.lastMs)} · 累计 ${fmtDur(st.totalMs)}` : '';
  }

  // ── 会话统计 & 导出 ───────────────────────────────────────────────────
  function updateStats() {
    const msgs = store.state.messages;
    const n = msgs.filter((m) => m.role !== 'tool').length;
    const stats = $('#conv-stats');
    if (!n) { stats.textContent = ''; return; }
    const tk = estimateTokens(msgs);
    const budget = contextBudgetLabel(store.state.model);
    stats.textContent = `${n} 条 · ~${tk >= 1000 ? (tk / 1000).toFixed(1) + 'k' : tk} tok / ${budget}`;
    stats.title = '估算上下文占用（含系统提示词外的消息体）';
  }
  $('#export-btn').addEventListener('click', () => {
    if (!store.state.messages.length) return toast('暂无可导出的对话');
    const active = store.state.sessions.find((s) => s.id === store.state.activeSessionId) || {};
    const data = {
      app: 'TeamoAgent', exportedAt: new Date().toISOString(), model: store.state.model, title: active.title || '',
      checkpoints: store.state.checkpoints,
      messages: store.state.messages.map((m) => ({
        role: m.role, text: m.text, content: m.content, toolCalls: m.toolCalls,
        toolCallId: m.toolCallId, name: m.name, usage: m.usage, ts: m.ts,
        attachments: (m.attachments || []).map((a) => ({ kind: a.kind, name: a.name, size: a.size, stripped: !!a.stripped })),
      })),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `teamo-agent-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('已导出会话 JSON', 'ok');
  });

  // ── 导入会话（兼容本应用导出的 JSON）────────────────────────────────
  $('#import-btn').addEventListener('click', () => $('#import-input').click());
  $('#import-input').addEventListener('change', async () => {
    const input = $('#import-input');
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const s = store.importSession(data);
      if (!s) return toast('导入失败：文件里没有有效的 messages 数组', 'err');
      if (getBusy()) return toast('请等待当前回合结束', 'warn');
      agent.loadFiles(store.state.files);
      rebuildMessages(); renderSessions(); renderFiles(); updateStats(); renderTimeStats();
      toast(`已导入会话「${s.title}」（${s.messages.length} 条消息）`, 'ok');
    } catch (err) {
      toast('导入失败：' + err.message, 'err');
    }
  });

  // ── 附件（按钮 / 拖拽 / 粘贴）────────────────────────────────────────
  const IMG_RE = /^image\/(png|jpeg|jpg|gif|webp)$/;
  const TEXT_RE = /\.(txt|md|markdown|js|mjs|cjs|ts|py|json|jsonl|csv|tsv|log|html?|css|scss|xml|ya?ml|sh|bash|zsh|sql|ini|toml|env|conf|cfg|c|h|cpp|hpp|java|go|rs|rb|php|swift|kt|vue|svelte)$/i;
  const MAX_IMG = 5 * 1024 * 1024, MAX_TEXT = 512 * 1024, MAX_FILES = 6;
  let pending = [];
  const attachChips = $('#attach-chips');
  const fileInput = $('#attach-input');

  const readAs = (mode, file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error(`读取 ${file.name} 失败`));
    mode === 'text' ? r.readAsText(file) : r.readAsDataURL(file);
  });

  async function addFiles(fileList) {
    const files = [...(fileList || [])];
    if (!files.length) return;
    for (const f of files) {
      if (pending.length >= MAX_FILES) { toast(`单次最多 ${MAX_FILES} 个附件`, 'warn'); break; }
      try {
        if (IMG_RE.test(f.type)) {
          if (f.size > MAX_IMG) { toast(`${f.name}：图片超过 5MB`, 'err'); continue; }
          pending.push({ id: Math.random().toString(36).slice(2), kind: 'image', name: f.name, mime: f.type, size: f.size, dataUrl: await readAs('dataURL', f) });
        } else if (TEXT_RE.test(f.name) || f.type.startsWith('text/') || f.type === 'application/json') {
          if (f.size > MAX_TEXT) { toast(`${f.name}：文本超过 512KB`, 'err'); continue; }
          pending.push({ id: Math.random().toString(36).slice(2), kind: 'text', name: f.name, mime: f.type || 'text/plain', size: f.size, text: await readAs('text', f) });
        } else {
          toast(`不支持的文件类型：${f.name}（支持图片与文本/代码文件）`, 'err');
        }
      } catch (err) { toast(err.message, 'err'); }
    }
    renderAttachChips();
  }

  function renderAttachChips() {
    attachChips.innerHTML = '';
    attachChips.style.display = pending.length ? '' : 'none';
    for (const a of pending) {
      const chip = el('div', 'attach-chip enter');
      chip.innerHTML = (a.kind === 'image'
        ? `<img src="${a.dataUrl}" alt="">`
        : `<span class="attach-chip-ico">📄</span>`)
        + `<span class="attach-chip-name mono">${esc(a.name)}</span><span class="attach-chip-size">${fmtSize(a.size)}</span><button class="attach-chip-x" type="button">✕</button>`;
      $('.attach-chip-x', chip).addEventListener('click', () => {
        pending = pending.filter((x) => x.id !== a.id);
        renderAttachChips();
      });
      attachChips.appendChild(chip);
    }
  }

  $('#attach-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });

  const mainEl = $('.main');
  ['dragenter', 'dragover'].forEach((ev) => mainEl.addEventListener(ev, (e) => { e.preventDefault(); mainEl.classList.add('drag-over'); }));
  ['dragleave', 'drop'].forEach((ev) => mainEl.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'dragleave' && e.relatedTarget && mainEl.contains(e.relatedTarget)) return;
    mainEl.classList.remove('drag-over');
  }));
  mainEl.addEventListener('drop', (e) => addFiles(e.dataTransfer && e.dataTransfer.files));
  composer.addEventListener('paste', (e) => {
    const files = [...((e.clipboardData && e.clipboardData.files) || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });

  // ── 输入区 ────────────────────────────────────────────────────────────
  function autoGrow() {
    composer.style.height = 'auto';
    composer.style.height = Math.min(composer.scrollHeight, 200) + 'px';
  }
  composer.addEventListener('input', autoGrow);
  composer.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); doSend(); }
  });
  sendBtn.addEventListener('click', () => {
    if (getBusy()) { agent.abort(); return; }
    doSend();
  });
  function doSend() {
    const text = composer.value.trim();
    if (!text && !pending.length) return;
    if (!store.state.apiKey) { openKeyModal(); toast('请先配置 TeamoRouter API Key', 'warn'); return; }
    if (getBusy()) return;
    composer.value = ''; autoGrow();
    const atts = pending; pending = []; renderAttachChips();
    agent.send(text, atts);
  }

  // 复制代码块按钮（事件委托）
  msgList.addEventListener('click', (e) => {
    const btn = e.target.closest('.copy-code');
    if (!btn) return;
    const code = btn.parentElement.querySelector('code');
    navigator.clipboard.writeText(code.textContent).then(() => { btn.textContent = '已复制'; setTimeout(() => (btn.textContent = '复制'), 1500); });
  });

  // ── 初次渲染 ──
  rebuildMessages();
  setStatus('idle');
  updateTransportBadge();
  updateStats();
  renderTimeStats();
  refreshBalance();
  if (!store.state.apiKey) setTimeout(openKeyModal, 600);

  // ── 暴露给 agent hooks ───────────────────────────────────────────────
  return {
    setStatus,
    updateTransportBadge,
    updateStats,
    renderSessions,
    renderFiles,
    onAssistantStart(m) { appendMessage(m); streamingId = m.id; },
    onDelta(m, text) {
      const wrap = msgNodes.get(m.id);
      if (!wrap) return;
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => { rafPending = false; paintAssistant(wrap, m); scrollToBottom(); });
    },
    onAssistantDone(m) {
      const wrap = msgNodes.get(m.id);
      if (wrap) paintAssistant(wrap, m);
      streamingId = null;
      scrollToBottom();
      renderSessions(); // 刷新会话记录的轮数/时间
      refreshActionVisibility();
      updateTransportBadge();
    },
    onTurnTiming(ms) {
      if (!(ms > 0)) return;
      const st = store.state.stats || (store.state.stats = { lastMs: 0, totalMs: 0 });
      st.lastMs = ms;
      st.totalMs += ms;
      store.notify();
      renderTimeStats();
    },
    refreshBalance,
    onToolStart() { scrollToBottom(); },
    onToolResult(call, result) {
      renderFiles();
      updateStats();
      // 同步回填对话流中的工具芯片（状态 ✓/✕ + 展开详情）
      attachToolResult({ toolCallId: call.id, content: result });
    },
    // 沙箱执行进度 → 回写到对应工具芯片的状态位（Pyodide 首次加载 10~30s、
    // C++ 远程编译、子智能体委派都需要可见的进度，否则界面看起来像卡死）
    onToolEvent(call, patch) {
      const chip = $(`.chip[data-call-id="${CSS.escape(call.id)}"]`, msgList);
      if (!chip) return;
      const state = $('.chip-state', chip);
      if (!state) return;
      if (patch.status === 'running') {
        chip.classList.add('running');
        state.textContent = patch.note || '执行中…';
        state.title = patch.note || '';
        state.classList.remove('bad');
      } else if (patch.status === 'error') {
        chip.classList.remove('running');
        state.textContent = patch.note || '✕';
        state.classList.add('bad');
      } else if (patch.status === 'ok') {
        chip.classList.remove('running');
      }
      if (patch.status === 'running') scrollToBottom();
    },
    attachToolResult,
    scrollToBottom: () => scrollToBottom(true),
  };
}
