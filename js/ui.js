// ─── UI 层：渲染 / 交互 / 动画 ─────────────────────────────────────────
import { FALLBACK_MODELS, PROVIDER_ORDER, providerOf, protocolOf, isFreeModel, supportsFastMode, supportsVision, isImageModel, IMAGE_MODELS, imageModelLabel, DEFAULT_IMAGE_MODEL, APP_VERSION, APP_RELEASE } from './config.js';
import { createZip, fileBytesFromValue, withExtension } from './zip.js';
import { buildFileTree, collectPaths, treeStats, flattenTree } from './filetree.js';
import { fetchModels, getTransport } from './api.js';
import { gatewayBase, gatewayChosenBy, setGatewayBase } from './endpoint.js';
import { webCapFor, webCapNote } from './websearch.js';
import { estimateTokens, contextBudgetFor } from './context.js';
import { providerIcon, APP_LOGO, ICON } from './icons.js';
import { SUBAGENTS } from './subagents.js';
import { autoTitle } from './titler.js';
import { SUGGESTIONS, pickSuggestions } from './suggestions.js';
import { claimsWebSearch, webRefusal } from './websearch.js';
import { effectiveApiKey, unlockAdminKey, adminUnlocked, isAdminAlias } from './adminkey.js';

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
  // 对话模型列表：过滤掉生图模型（只能由主智能体通过 generate_image 工具调用，
  // 直接选中会绕过工具循环、破坏 Agent 特性；网关 /v1/models 里带它们时也照样隐藏）
  function mergedModels() {
    const map = new Map();
    for (const m of FALLBACK_MODELS) if (!isImageModel(m.id)) map.set(m.id, { ...m });
    for (const id of store.state.models || []) {
      if (!map.has(id) && !isImageModel(id)) map.set(id, { id, provider: providerOf(id) });
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
            ${protocolOf(m.id) === 'anthropic' ? '<span class="badge ghost">原生</span>' : ''}
          </span>`;
        item.addEventListener('click', () => {
          store.state.model = m.id; store.notify();
          if (typeof syncWeb === 'function') syncWeb(); // 换了模型要重说「联网按哪个原生格式走」
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
    const foot = $('.dd-foot', ddMenu);
    if (foot) ddMenu.appendChild(foot); // 生图模型行始终排在分组之后（sticky bottom 生效）
  }
  function updateModelBtn() {
    $('#model-btn-icon').innerHTML = providerIcon(providerOf(store.state.model));
    $('#model-btn-name').textContent = store.state.model;
    $('#model-btn-provider').textContent = providerOf(store.state.model);
    syncImageModelSelect();
  }
  // 生图模型（由 Agent 调用，不作为对话模型）：与会话绑定，切会话时同步显示
  function syncImageModelSelect() {
    const sel = $('#image-model');
    if (!sel) return;
    if (!sel.options.length) {
      for (const m of IMAGE_MODELS) {
        const o = document.createElement('option');
        o.value = m.id;
        o.textContent = `${m.label}（${m.note}）`;
        o.title = `模型 ID：${m.id}`;
        sel.appendChild(o);
      }
    }
    // 会话里存的值可能来自旧版本/导入：不在目录内就退回默认，避免 select 显示空值
    let want = store.state.imageModel;
    if (!IMAGE_MODELS.some((m) => m.id === want)) {
      want = DEFAULT_IMAGE_MODEL;
      store.state.imageModel = want;
    }
    if (sel.value !== want) sel.value = want;
  }
  $('#image-model')?.addEventListener('change', (e) => {
    store.state.imageModel = e.target.value;
    store.notify();
    toast(`生图模型已切换为 ${imageModelLabel(e.target.value)}（由 Agent 的 generate_image 工具调用）`, 'ok');
  });
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
      const list = await fetchModels(effectiveApiKey(store.state.apiKey));
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
    toast(store.state.settings.sandboxEnabled
      ? '沙箱已开启：Agent 可执行 JS/Python/C++ 代码'
      : '代码沙箱已关闭：不再执行代码，文件读写、生图与子智能体委派仍可用');
  });
  syncSandbox();

  // 联网：打开后由 api.js 往请求体里注入「当前模型 API 自带」的网页搜索格式
  //（Claude → /v1/messages 的 web_search_20250305；GPT → /v1/responses 的 web_search；
  //  Kimi/GLM/Grok → Chat Completions 的对应原生字段）。本项目不调用任何第三方搜索 API。
  const GLOBE_SVG = '<svg class="pill-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3.2 9.5h17.6"/><path d="M3.2 14.5h17.6"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18"/></svg>';
  const webToggle = $('#web-toggle');
  const syncWeb = () => {
    if (!webToggle) return;
    const on = store.state.settings.webEnabled !== false;
    webToggle.classList.toggle('on', on);
    const cap = webCapFor(store.state.model);
    webToggle.innerHTML = GLOBE_SVG + '联网';
    // 文案只在 websearch.js 里维护一份（这里原本内联复写过一遍，webCapNote 成了死导入）
    webToggle.title = on ? webCapNote(cap) : '联网已关闭：模型不再具备实时检索能力';
  };
  if (webToggle) {
    webToggle.addEventListener('click', () => {
      store.state.settings.webEnabled = !(store.state.settings.webEnabled !== false);
      store.notify(); syncWeb();
      const on = store.state.settings.webEnabled !== false;
      const cap = webCapFor(store.state.model);
      if (on && !cap) toast('联网已开启，但当前模型没有原生联网格式 —— 本轮仍不会联网（可换 Claude / GPT / Kimi / GLM / Grok）', 'warn', 6000);
      else if (on) toast(`联网已开启：${cap.label}`, 'ok', 4000);
      else toast('联网已关闭：不再联网，时效性问题会明确说明无法核实');
    });
    syncWeb();
  }

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
    toast(store.state.settings.fastMode ? '快速模式开启（service_tier=fast，2x 计费，仅 GPT 系列）' : '快速模式关闭');
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
  $('#key-save').addEventListener('click', async () => {
    const typed = keyInput.value.trim();
    // 管理员别名：先用口令解封（解不开就拒绝保存，避免存进去一把用不了的 key）
    if (isAdminAlias(typed)) {
      const r = await unlockAdminKey(typed);
      if (!r.ok) {
        return toast(r.reason === 'bad-password' ? '管理员口令不正确（admin- 开头的密钥会被当作管理员口令）' : '管理员密钥不可用',
          'err', 5200);
      }
      store.state.apiKey = typed; store.notify();
      closeKeyModal();
      toast('管理员密钥已启用：请求会用管理员密钥发出（明文密钥不落盘、不上屏）', 'ok', 4200);
      updateKeyBtn(); updateTransportBadge();
      return;
    }
    store.state.apiKey = typed; store.notify();
    closeKeyModal();
    toast(store.state.apiKey ? 'API Key 已保存（仅存于浏览器 localStorage）' : 'API Key 已清除', 'ok');
    updateKeyBtn(); updateTransportBadge();
  });
  // 底部「API Key」按钮的文案：管理员模式下明确标出来（但不显示密钥任何片段）
  function updateKeyBtn() {
    const b = $('#key-btn');
    if (!b) return;
    const admin = isAdminAlias(store.state.apiKey);
    b.textContent = admin ? '管理员' : 'API Key';
    b.classList.toggle('admin-mode', admin);
    b.title = admin
      ? (adminUnlocked() ? '管理员密钥已启用（请求使用管理员密钥，明文不落盘）' : '管理员密钥未解封：点开重新输入口令')
      : '填入 TeamoRouter API Key（或管理员口令）';
  }
  updateKeyBtn();
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
  // 侧栏只列「有内容的」会话：空的「新对话」草稿在用户发出第一条消息之前不进列表
  //（store.listableSessions 负责过滤，「＋ 新建」也会复用空草稿，不堆 invisible 记录）
  function renderSessions() {
    const box = $('#session-list'); box.innerHTML = '';
    const list = store.listableSessions ? store.listableSessions() : store.sortedSessions();
    if (!list.length) {
      box.appendChild(el('div', 'sess-empty-hint', '还没有会话记录'));
      return;
    }
    for (const s of list) {
      const node = el('div', 'sess-item' + (s.id === store.state.activeSessionId ? ' active' : ''));
      node.innerHTML = `<span class="sess-main"><span class="sess-title">${esc(s.title || '新对话')}</span><span class="sess-meta">${sessionMeta(s)}</span></span>`
        + `<button class="sess-rename" type="button" title="重命名会话">${ICON.pencil || ''}</button>`
        + `<button class="sess-del" type="button" title="删除会话" aria-label="删除会话「${esc(s.title || '新对话')}」">${ICON.x}</button>`;
      node.addEventListener('click', () => switchToSession(s.id));
      const del = $('.sess-del', node);
      if (del) del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (getBusy()) return toast('请等待当前回合结束', 'warn');
        if (!confirm(`删除会话「${s.title || '新对话'}」？不可恢复。`)) return;
        const wasActive = s.id === store.state.activeSessionId;
        store.deleteSession(s.id);
        if (wasActive) agent.loadFiles(store.state.files);
        rebuildMessages(); renderSessions(); renderFiles(); updateStats(); updateModelBtn();
        toast('会话已删除');
      });
      const rename = $('.sess-rename', node);
      if (rename) {
        rename.addEventListener('click', (e) => { e.stopPropagation(); startRename(node, s); });
        // 双击标题也进改名（桌面用户的直觉路径）
        $('.sess-title', node).addEventListener('dblclick', (e) => { e.stopPropagation(); startRename(node, s); });
      }
      box.appendChild(node);
    }
  }

  // 就地改名：Enter 提交、Esc 取消、失焦提交；改名后 titleSource='user'，
  // Agent 的自动总结不再覆盖它
  function startRename(node, s) {
    const span = $('.sess-title', node);
    if (!span || $('.sess-rename-input', node)) return;
    const input = el('input', 'sess-rename-input');
    input.type = 'text';
    input.value = s.title || '';
    input.maxLength = 48;
    input.setAttribute('aria-label', '重命名会话');
    span.replaceWith(input);
    input.focus(); input.select();
    let closed = false;
    const done = (commit) => {
      if (closed) return;
      closed = true;
      const v = input.value.trim();
      input.replaceWith(span);
      if (commit && v && v !== (s.title || '') && typeof store.renameSession === 'function') {
        store.renameSession(s.id, v);
        toast('会话已重命名', 'ok', 1400);
      }
      renderSessions();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); done(true); }
      else if (e.key === 'Escape') { e.preventDefault(); done(false); }
    });
    input.addEventListener('blur', () => done(true));
    input.addEventListener('click', (e) => e.stopPropagation());
  }
  function switchToSession(id) {
    if (id === store.state.activeSessionId) return;
    if (getBusy()) return toast('请等待当前回合结束再切换会话', 'warn');
    store.switchSession(id);
    agent.loadFiles(store.state.files);
    // 模型随会话恢复：切回来后模型按钮显示该会话自己的模型，而不是上一次的全局选择
    rebuildMessages(); renderSessions(); renderFiles(); updateStats(); renderTimeStats(); updateModelBtn();
  }
  $('#new-session').addEventListener('click', () => {
    if (getBusy()) return toast('请等待当前回合结束', 'warn');
    (store.ensureDraft ? store.ensureDraft() : store.createSession());
    agent.loadFiles({});
    rebuildMessages(); renderSessions(); renderFiles(); updateStats(); renderTimeStats(); updateModelBtn();
    composer.focus();
  });
  // 一键清除所有会话记录（含各自的沙箱文件与检查点）：不可恢复，所以必须确认
  $('#clear-sessions').addEventListener('click', () => {
    if (getBusy()) return toast('请等待当前回合结束', 'warn');
    const n = (store.listableSessions ? store.listableSessions() : store.sortedSessions()).length;
    if (!n) { toast('当前没有任何会话记录'); return; }
    if (!confirm(`清除全部 ${n} 条会话记录？所有消息、检查点与沙箱文件都会被删除，且不可恢复。`)) return;
    if (typeof store.clearAllSessions !== 'function') {
      return toast('浏览器缓存了旧版本代码，请硬刷新（Ctrl/Cmd + Shift + R）后再用「清空」', 'warn', 5000);
    }
    const removed = store.clearAllSessions();
    agent.loadFiles({});
    rebuildMessages(); renderSessions(); renderFiles(); updateStats(); renderTimeStats(); updateModelBtn();
    toast(`已清除 ${removed || n} 条会话记录`, 'ok');
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
    // 以前这里把按钮内容整体替换成两个方块符号字符：既丢掉了 pill 的「SVG 图标 + 中文文字」统一外观，
    // 又在窄屏下把按钮压到 30 多像素宽（点不中）。改成切状态类 + 提示语，外观与其它 pill 一致。
    const btn = $('#panel-toggle');
    btn.classList.toggle('on', !v);
    btn.setAttribute('aria-pressed', v ? 'false' : 'true');
    btn.title = v ? '沙箱面板已收起（文件树 / 下载 / 清空）：点开' : '沙箱面板已展开：点此收起';
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
  // ── 沙箱下载：整包 ZIP / 单个文件（图片按原始二进制还原，可直接打开）──
  const stampName = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  function saveBlob(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  const zipName = (path, mime) => withExtension(path.split('/').pop() || 'file', mime && mime.startsWith('image/') ? mime : '');
  function downloadFile(path) {
    let raw;
    try { raw = agent.fs.read(path); } catch { return toast('文件已不存在', 'err'); }
    const { bytes, mime } = fileBytesFromValue(raw);
    const name = zipName(path, mime);
    saveBlob(name, new Blob([bytes], { type: mime }));
    toast(`已下载 ${name}（${fmtSize(bytes.length)}）`, 'ok');
  }
  // 打包：整包（保留目录结构）或单个目录；entries.name 即沙箱内路径
  const zipEntriesOf = (paths) => paths.map((p) => {
    let raw = '';
    try { raw = agent.fs.read(p); } catch { /**/ }
    const { bytes, mime } = fileBytesFromValue(raw);
    return { name: withExtension(p, mime && mime.startsWith('image/') ? mime : ''), bytes };
  });
  function saveZip(entries, base) {
    if (!entries.length) return toast('没有可打包的文件', 'warn');
    const blob = createZip(entries);
    saveBlob(`${base}-${stampName()}.zip`, blob);
    toast(`已打包 ${entries.length} 个文件（${fmtSize(blob.size)}）`, 'ok');
  }
  $('#download-zip').addEventListener('click', () => saveZip(zipEntriesOf(Object.keys(agent.fs.export())), 'teamo-sandbox'));
  $('#clear-files').addEventListener('click', () => { agent.fs.clear(); store.clearFiles(); renderFiles(); toast('虚拟文件系统已清空'); });

  // 目录折叠状态：本次页面会话内记住（沙箱是路径即结构，没有真实目录节点）
  const collapsedDirs = new Set();
  // 图片以 data URL 存放，字符串长度会虚高 ~1/3；按 base64 反推真实字节
  const approxBytes = (raw) => {
    const str = String(raw || '');
    if (str.startsWith('data:')) {
      const comma = str.indexOf(',');
      if (comma > 0 && /;base64/i.test(str.slice(0, comma))) return Math.max(0, Math.round((str.length - comma - 1) * 0.75));
    }
    return new TextEncoder().encode(str).length;
  };

  function renderFiles() {
    const box = $('#file-list'); box.innerHTML = '';
    const files = agent.fs.list().map((f) => {
      let raw = '';
      try { raw = agent.fs.read(f.path); } catch { /**/ }
      return { path: f.path, size: approxBytes(raw), isImage: /^data:image\//.test(raw) };
    });
    const tree = buildFileTree(files);
    const stat = treeStats(tree);
    const countEl = $('#files-count');
    if (countEl) {
      countEl.textContent = stat.files
        ? `${stat.files} 个文件${stat.dirs ? ` · ${stat.dirs} 个目录` : ''} · ${fmtSize(stat.size)}`
        : '';
    }
    if (!tree.length) { box.appendChild(el('div', 'empty-hint', '暂无文件。Agent 可通过 write_file 或沙箱代码创建；用户上传的附件会自动复制到 uploads/。')); return; }
    const imageSet = new Set(files.filter((f) => f.isImage).map((f) => f.path));
    const rows = flattenTree(tree, { isCollapsed: (p) => collapsedDirs.has(p) });
    for (const r of rows) {
      const closed = r.type === 'dir' && collapsedDirs.has(r.path);
      const row = el('div', `ft-row ft-${r.type}${r.type === 'dir' ? (closed ? ' closed' : ' open') : ' file-item'}`);
      row.style.setProperty('--d', r.depth);
      row.dataset.path = r.path;
      row.title = r.type === 'dir' ? `${r.path}/（点击${collapsedDirs.has(r.path) ? '展开' : '折叠'}，共 ${r.count} 个文件）` : r.path;
      if (r.type === 'dir') {
        row.setAttribute('role', 'button');
        row.tabIndex = 0;
        row.setAttribute('aria-expanded', String(!closed));
        row.innerHTML = `<span class="ft-chev">${ICON.chevRight}</span>`
          + `<span class="ft-ico">${closed ? ICON.folder : ICON.folderOpen}</span>`
          + `<span class="ft-name mono">${esc(r.name)}</span>`
          + `<span class="ft-meta mono">${r.count} 个文件 · ${fmtSize(r.size)}</span>`
          + `<span class="ft-actions"><button class="mini-btn ft-zip" type="button" title="把 ${esc(r.path)}/ 下的文件按原目录结构打包下载（.zip）">${ICON.download}<span>ZIP</span></button></span>`;
        const toggle = () => {
          if (collapsedDirs.has(r.path)) collapsedDirs.delete(r.path); else collapsedDirs.add(r.path);
          renderFiles();
        };
        row.addEventListener('click', toggle);
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
        $('.ft-zip', row).addEventListener('click', (e) => {
          e.stopPropagation();
          saveZip(zipEntriesOf(collectPaths(r)), `teamo-${r.name || 'folder'}`);
        });
      } else {
        row.innerHTML = `<span class="ft-sp"></span>`
          + `<span class="ft-ico">${imageSet.has(r.path) ? ICON.image : ICON.file}</span>`
          + `<span class="ft-name mono file-path">${esc(r.name)}</span>`
          + `<span class="ft-meta mono file-size">${fmtSize(r.size)}</span>`
          + `<span class="ft-actions"><button class="mini-btn file-dl" type="button" title="下载此文件">${ICON.download}</button></span>`;
        $('.file-dl', row).addEventListener('click', (e) => { e.stopPropagation(); downloadFile(r.path); });
        row.addEventListener('click', () => openFileViewer(r.path));
      }
      box.appendChild(row);
    }
  }

  function openFileViewer(path) {
    const viewer = $('#file-viewer');
    let raw = '';
    try { raw = agent.fs.read(path); } catch { return toast('文件已不存在', 'err'); }
    const isImg = /^data:image\//.test(raw);
    viewer.innerHTML = `<div class="file-viewer-head mono">${esc(path)}<span class="fv-actions">`
      + `<button id="fv-dl" type="button" title="下载此文件">${ICON.download}<span>下载</span></button>`
      + `<button id="fv-close" type="button" title="关闭">${ICON.x}</button></span></div>`
      + (isImg ? `<div class="fv-img"><img src="${raw}" alt="${esc(path)}"></div>` : `<pre>${esc(raw)}</pre>`);
    viewer.classList.add('open');
    $('#fv-close').addEventListener('click', () => viewer.classList.remove('open'));
    $('#fv-dl').addEventListener('click', () => downloadFile(path));
  }
  renderFiles();

  // ── 消息渲染 ──────────────────────────────────────────────────────────
  function renderEmpty() {
    if (store.state.messages.length) return;
    const picks = pickSuggestions(SUGGESTIONS, 3);
    msgList.appendChild(el('div', 'empty-state', `
      <div class="empty-logo">${APP_LOGO}</div>
      <h2>TeamoAgent</h2>
      <p>基于 <span class="mono">TeamoRouter</span> 网关的网页端智能体<br>模型自选 · 代码沙箱 · 对话回滚 · 工具调用循环</p>
      <div class="empty-cards">
        ${picks.map((x) => `<button class="suggest" type="button" data-prompt="${esc(x.text)}">${esc(x.text)}</button>`).join('')}
      </div>
      <button class="suggest-shuffle" type="button" title="换一批任务示例">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/></svg>换一批</button>`));
    $$('.suggest', msgList).forEach((b) => b.addEventListener('click', () => {
      composer.value = b.dataset.prompt || b.textContent;
      composer.focus(); autoGrow();
    }));
    const shuffle = $('.suggest-shuffle', msgList);
    if (shuffle) shuffle.addEventListener('click', () => { clearEmpty(); renderEmpty(); });
  }
  function clearEmpty() { const e = $('.empty-state', msgList); if (e) e.remove(); }

  function messageNode(m) {
    const wrap = el('div', `msg msg-${m.role} enter`);
    wrap.dataset.id = m.id;
    if (m.role === 'user') {
      wrap.innerHTML = `<div class="bubble">${renderMarkdown(m.text)}${renderAttachments(m.attachments)}</div>
        <div class="msg-actions msg-actions-user"><button class="act" data-act="rollback" title="回滚到本轮之前">${ICON.rollback || ''}<span>回滚</span></button></div>`;
      $('.act', wrap).addEventListener('click', () => doRollback(m));
    } else {
      // 模型名/头像每轮（一次 user 提问开始的回合）只显示一次：
      // 仅当上一条消息是 user 时渲染 msg-head，工具循环产生的后续 assistant 消息不再重复
      const idx = store.state.messages.findIndex((x) => x.id === m.id);
      const prev = idx > 0 ? store.state.messages[idx - 1] : null;
      const showHead = !prev || prev.role === 'user';
      // 用这条消息生成时实际使用的模型（而不是当前选择），切换会话/换模型后回看不再张冠李戴
      const headModel = m.model || store.state.model;
      wrap.innerHTML = `
        ${showHead ? `<div class="msg-head"><span class="avatar">${providerIcon(providerOf(headModel))}</span><span class="msg-model mono">${esc(headModel)}</span><span class="msg-meta"></span></div>` : ''}
        <div class="md-body"></div>
        <div class="tool-chips"></div>
        <div class="msg-actions">
          <button class="act" data-act="copy" title="复制本轮回复">${ICON.copy || ''}<span>复制</span></button>
          <button class="act" data-act="rollback" title="回滚到本轮之前">${ICON.rollback || ''}<span>回滚</span></button>
          <button class="act act-regen" data-act="regen" title="重新生成并覆盖最近这一条回答（更早的回答请先「回滚」再重新提问）">${ICON.regen || ''}<span>重新生成</span></button>
        </div>`;
      $$('.act', wrap).forEach((b) => b.addEventListener('click', () => {
        const act = b.dataset.act;
        if (act === 'copy') {
        navigator.clipboard.writeText(m.text || '').then(() => toast('已复制', 'ok', 1200), () => toast('复制失败：浏览器拒绝了剪贴板权限', 'err'));
      }
        if (act === 'rollback') doRollback(m);
        if (act === 'regen') {
          if (getBusy()) return;
          // 「重新生成」= 覆盖这一次的回答：先把旧回答从会话与视图里一起抹掉，再重跑同一轮。
          // 之前只调 agent.regenerate()：store 里旧消息删了，但 DOM 节点还挂在消息区，
          // 新回答又追加在下面 → 看起来像「没重新生成」或「生成了两条」。
          const removed = store.dropLastAssistantTurn();
          if (removed) { rebuildMessages(); toast('已覆盖上一次回答，正在重新生成…', 'ok', 1600); }
          agent.regenerate();
        }
      }));
    }
    return wrap;
  }

  // ── 「重试并联网检索」：上游模型偶发不调用服务端搜索（直接回「我上不了网」）时的补救 ──
  // 真机对照实验里，提问里写明「先联网检索再回答」能明显提高命中率，所以这里一键改写重问；
  // 不放在通用 .act 处理器里 —— 提示条是在动作条之后才挂上去的，那时监听器已经绑定完了。
  function doWebRetry(m) {
    if (getBusy()) return;
    const i = store.state.messages.findIndex((x) => x.id === m.id);
    const um = i > 0 ? store.state.messages[i - 1] : null;
    if (!um || um.role !== 'user') { toast('找不到对应的提问，请手动重新提问', 'err', 2200); return; }
    if (i !== store.state.messages.length - 1) { toast('这条不是最近一轮，请先「回滚」再重问', 'err', 2400); return; }
    if (/先联网(检索|查|搜索)/.test(um.text || '')) { toast('这一轮已经要求过「先联网检索」了 —— 建议换个模型（Claude / GPT 系列）再试', 'err', 2800); return; }
    store.dropLastAssistantTurn();   // 覆盖式重试：别把没检索到的旧回答留在上面
    store.updateMessage(um.id, { text: '先联网检索再回答：' + (um.text || '') });
    rebuildMessages();
    toast('已改写提问（先联网检索再回答），正在重试…', 'ok', 1800);
    agent.regenerate();
  }

  // ── 工具芯片里的图片输出（generate_image 的结果）─────────────────────
  // 会话内按 callId 缓存：重绘/切换会话回来时仍能直接看到图（刷新页面后与
  // 附件同策略不落盘，避免数 MB data URL 顶穿 localStorage）
  const chipImages = new Map();
  function paintChipImage(chip, shot) {
    if (!chip || !shot || !shot.dataUrl) return;
    const detail = $('.chip-detail', chip);
    let fig = $('.chip-img', chip);
    if (!fig) {
      fig = el('figure', 'chip-img');
      chip.insertBefore(fig, detail || null);
    }
    const name = String(shot.path || 'image.png').split('/').pop();
    // data URL 体积按 base64 反推真实字节（×3/4），标签展示更准确
    const comma = shot.dataUrl.indexOf(',');
    const bytes = comma > 0 ? Math.max(0, Math.round((shot.dataUrl.length - comma - 1) * 0.75)) : shot.dataUrl.length;
    fig.innerHTML = `<img src="${shot.dataUrl}" alt="${esc(name)}">`
      + `<figcaption class="chip-img-cap mono">${esc(shot.path || name)} · ${fmtSize(bytes)}${shot.width && shot.height ? ` · ${shot.width}x${shot.height}` : ''}`
      + `<a href="${shot.dataUrl}" download="${esc(name)}">下载</a></figcaption>`;
    fig.addEventListener('click', (e) => e.stopPropagation()); // 点图片不要触发芯片折叠
    chip.classList.add('has-image');
  }

  function paintAssistant(wrap, m) {
    const body = $('.md-body', wrap);
    let html = '';
    const noOutputYet = !m.text && !m.reasoning && !(m.toolCalls && m.toolCalls.length);
    // 思考过程（深度思考模型）：完成后折叠展示，流式期间给出行提示
    if (m.done && m.reasoning) {
      html += `<details class="reasoning"><summary>思考过程</summary><div>${renderMarkdown(m.reasoning)}</div></details>`;
    } else if (!m.done && m.reasoning && !m.text) {
      html += '<div class="thinking-line">深度思考中<span class="dots">…</span></div>';
    } else if (!m.done && noOutputYet) {
      // 连接动画：请求已发出但首字未到（网关排队 / TTFB 慢），明确提示当前状态
      html += `<div class="connect-line"><span class="connect-ring" aria-hidden="true"></span><span>正在连接 <b class="mono">${esc(m.model || store.state.model)}</b>，等待首个响应…</span></div>`;
    }
    html += renderMarkdown(m.text || '');
    if (!m.done && !noOutputYet) html += '<span class="cursor"></span>';
    if (m.cancelled) html += '<span class="cancelled-tag">已停止</span>';
    body.innerHTML = html;
    if (m.webSearch) body.appendChild(webNote(m.webSearch));
    // 诚实性护栏：正文说「已联网搜索」但本轮没有任何服务端检索事件 → 如实提醒，不替模型背书
    else if (m.done && m.role === 'assistant' && claimsWebSearch(m.text)) {
      const warn = el('div', 'web-note warn');
      warn.innerHTML = '<span class="web-fail">未见检索事件</span>'
        + '<span>本轮没有收到任何网页搜索事件（模型的「已联网」说法无法证实），其中的具体数字请另行核实</span>';
      body.appendChild(warn);
    }
    // 开关开着、模型却回「我上不了网」：上游没去调用服务器搜索（网关侧实测会发生），给一句可操作提示
    else if (m.done && m.role === 'assistant' && store.state.settings.webEnabled !== false && webRefusal(m.text)) {
      const hint = el('div', 'web-note hint');
      hint.innerHTML = '<span class="web-hint">联网开关是开着的，但本轮没有发生检索</span>'
        + '<span>上游模型自己没调用服务端搜索（网关侧偶发）。需要实时数据的话，点右边的按钮用同一句提问重试（会自动写明「先联网检索再回答」），或换个模型重问一次</span>'
        + `<button class="act web-act" data-act="web-retry" title="同一句提问重试，并在提问前面写明「先联网检索再回答」">${ICON.globe || ''}<span>重试并联网检索</span></button>`;
      body.appendChild(hint);
      const wb = $('.web-act', hint);
      if (wb) wb.addEventListener('click', (e) => { e.preventDefault(); doWebRetry(m); });
    }
    if (m.error) body.innerHTML += `<div class="err-box">⚠ ${esc(m.error)}</div>`;
    // 工具芯片
    const chips = $('.tool-chips', wrap);
    if (m.toolCalls && m.toolCalls.length) {
      if (chips.children.length !== m.toolCalls.length) {
        chips.innerHTML = '';
        for (const t of m.toolCalls) {
          const chip = el('div', 'chip');
          chip.dataset.callId = t.id;
          // 图标用 SVG（线性扳手），未完成时缓慢转动、完成后停下（.done 由 attachToolResult 打上）
          chip.innerHTML = `<span class="chip-ico">${ICON.tool || ''}</span><span class="mono chip-name">${esc(t.name)}</span><span class="chip-state">…</span>`;
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
        const tc = m.toolCalls[i];
        let shot = tc && chipImages.get(tc.id);
        // 刷新页面后 chipImages 是空的：用持久化在工具调用记录里的图补上（水合后再取回 dataUrl）
        if (!shot && tc && tc.image) {
          shot = { dataUrl: tc.image, path: tc.imagePath, width: tc.width, height: tc.height };
          chipImages.set(tc.id, shot);
        }
        if (shot) paintChipImage(chip, shot);
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
    // 复制/回滚/重新生成的显隐统一交给 refreshActionVisibility（回合结束才显示）
    refreshActionVisibility();
  }

  // 操作条显隐规则：
  //   ① 复制 / 重新生成 只出现在「本轮末尾」的 assistant 消息上（每轮一次）
  //   ② 整轮输出没结束（流式、工具执行、子智能体跑着）时，本轮所有按钮一律不显示
  //      —— 用户要的是「输出完了再动手」，半截输出上点复制/回滚都不是想要的结果
  // 联网来源条：搜索由模型服务端完成，这里只把「查了什么、来自哪儿」亮出来（含引用链接）
  function webNote(w) {
    const box = el('div', 'web-note');
    const sources = (w.sources || []).filter((x) => x && x.url).slice(0, 6);
    if (w.status === 'searching') box.innerHTML = '<span class="web-dot"></span><span>联网检索中（模型原生 web_search）…</span>';
    else if (w.status === 'error') {
      // 上游检索服务不可用（如 Anthropic 的 error_code:"unavailable"）：如实说清，不显示「0 条来源」
      box.innerHTML = `<span class="web-fail">联网检索未成功</span><span class="mono">${esc(String(w.message || '上游未返回结果').slice(0, 90))}</span>`
        + (sources.length ? '' : '<span class="web-hint">可稍后重试，或换用其它支持原生联网的模型</span>');
    }
    else {
      // 各家原生格式给的计数字段不一致（有的只给 sources），取两者较大值，别显示「0 条来源」
      const n = Math.max(Number(w.results) || 0, sources.length);
      const q = (w.queries || []).slice(0, 2).map((x) => `「${String(x).slice(0, 40)}」`).join(' ');
      box.innerHTML = `<span class="web-tag">联网</span><span>${q ? esc(q) + ' · ' : ''}服务端检索到 ${n} 条来源</span>`;
      if (sources.length) {
        const ul = el('div', 'web-srcs');
        for (const x of sources) {
          const a = el('a', 'web-src'); a.href = x.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
          a.textContent = String(x.title || x.url).slice(0, 90);
          ul.appendChild(a);
        }
        box.appendChild(ul);
      }
    }
    return box;
  }

  function refreshActionVisibility() {
    const msgs = store.state.messages;
    const busy = getBusy();
    const turnStartOf = (i) => {
      while (i > 0 && msgs[i].role !== 'user') i--;
      return msgs[i] && msgs[i].role === 'user' ? i : -1;
    };
    const readyByStart = new Map();
    const turnReady = (start) => {
      if (start < 0) return false;
      if (readyByStart.has(start)) return readyByStart.get(start);
      let anyAssistant = false, allDone = true;
      for (let k = start + 1; k < msgs.length && msgs[k].role !== 'user'; k++) {
        if (msgs[k].role === 'assistant') { anyAssistant = true; if (!msgs[k].done) allDone = false; }
      }
      const v = !busy && anyAssistant && allDone;
      readyByStart.set(start, v);
      return v;
    };
    // 每轮末尾的 assistant（按轮起点记住）+ 整个会话最后一条 assistant（「重新生成」才给）
    const lastAssistantOfTurn = new Map();
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].role !== 'assistant') continue;
      const st = turnStartOf(i);
      if (st >= 0) lastAssistantOfTurn.set(st, msgs[i].id);
    }
    const lastOverall = [...msgs].reverse().find((x) => x.role === 'assistant');
    for (const wrap of $$('.msg-user, .msg-assistant', msgList)) {
      const idx = msgs.findIndex((x) => x.id === wrap.dataset.id);
      if (idx < 0) continue;
      const m = msgs[idx];
      const start = m.role === 'user' ? idx : turnStartOf(idx);
      const ready = turnReady(start);
      const show = m.role === 'user' ? ready : ready && lastAssistantOfTurn.get(start) === m.id;
      wrap.classList.toggle('actions-pending', !show);
      const regen = $('.act-regen', wrap);
      if (regen) regen.style.display = show && lastOverall && lastOverall.id === m.id ? '' : 'none';
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
    // 入场动画只给最后一条：旧写法每追加一条就重扫整个列表（n 条消息 → n 次全量
    // querySelectorAll，长会话首屏明显卡顿），而且语义也只是「别给历史消息加动画」
    for (const m of store.state.messages) {
      if (m.role === 'tool') continue;
      appendMessage(m);
    }
    for (const n of $$('.msg', msgList)) n.classList.remove('enter');
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
    chip.classList.add('done');        // 图标停止转动（含刷新页面后重建的芯片）
    chip.classList.remove('running');
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

  // ── 状态栏（连接/生成过程可见化：脉冲状态点 + 跳动点 + 实时耗时）──────
  const STATUS = {
    idle: ['', 'ok'],
    connecting: ['连接模型中', 'busy'],
    thinking: ['思考中', 'busy'], streaming: ['生成中', 'busy'],
    executing: ['沙箱执行中', 'busy'], done: ['完成', 'ok'], error: ['出错', 'err'], cancelled: ['已停止', 'warn'],
  };
  const DOTS = '<span class="sdots" aria-hidden="true"><i></i><i></i><i></i></span>';
  let busySince = 0;
  let busyTimer = null;
  const stopBusyTicker = () => { if (busyTimer) { clearInterval(busyTimer); busyTimer = null; } };
  function paintStatus(s) {
    const [label] = STATUS[s] || STATUS.idle;
    const secs = (performance.now() - busySince) / 1000;
    statusText.innerHTML = `${esc(label)}${DOTS}<span class="selapsed mono">${secs >= 0.8 ? `${secs.toFixed(1)}s` : ''}</span>`;
  }
  function setStatus(s) {
    const [label, cls] = STATUS[s] || STATUS.idle;
    const busy = ['connecting', 'thinking', 'streaming', 'executing'].includes(s);
    if (busy) {
      if (!busySince) busySince = performance.now();
      statusDot.className = `dot busy${s === 'connecting' ? ' connecting' : ''}`;
      if (!busyTimer) busyTimer = setInterval(() => paintStatus(s), 200);
      paintStatus(s);
    } else {
      busySince = 0; stopBusyTicker();
      statusDot.className = 'dot ' + cls;
      // 完成态短暂回显后清空，避免状态栏留白显得突兀
      if (s === 'done') {
        statusText.textContent = label;
        setTimeout(() => { if (agent.getStatus() === 'done') statusText.textContent = ''; }, 1600);
      } else {
        statusText.textContent = label;
      }
    }
    if (typeof refreshActionVisibility === 'function') refreshActionVisibility();
    sendBtn.classList.toggle('stop-mode', busy);
    $('#send-ico').textContent = busy ? '■' : '↑';
    sendBtn.title = busy ? '停止' : '发送 (Enter)';
    // 顶栏不确定进度条：连接阶段更快，让用户一眼看出「正在等模型响应」
    const bar = $('#turn-bar');
    if (bar) bar.classList.toggle('on', busy);
    if (bar) bar.classList.toggle('connecting', s === 'connecting');
  }
  function getBusy() { return ['connecting', 'thinking', 'streaming', 'executing'].includes(agent.getStatus()); }

  function updateTransportBadge() {
    const b = $('#transport-badge');
    const proxy = getTransport() === 'proxy';
    const host = gatewayBase().replace(/^https?:\/\//, '');
    b.textContent = proxy ? '中继模式' : '直连模式';
    const by = gatewayChosenBy();
    const why = by === 'probe' ? '启动探测自动选择' : by === 'failover' ? '直连失败后自动切换' : by === 'manual' ? '手动选择' : by === 'stored' ? '沿用上次选择' : '默认';
    b.title = proxy
      ? `浏览器直连失败，已通过本地服务器代理转发（目标 ${host}）`
      : `浏览器直连 ${host}（${why}）· 点这里可切换到另一个域名（国内网络建议用 api.teamorouter.cn）`;
  }
  // 点传输徽章 = 手动切换接入点（国内网络下用户可能知道哪个更快）
  $('#transport-badge').addEventListener('click', () => {
    const from = gatewayBase();
    const to = setGatewayBase(null, 'manual');
    updateTransportBadge();
    toast(`网关接入点已切换：${to.replace(/^https?:\/\//, '')}（原 ${from.replace(/^https?:\/\//, '')}）`, 'ok', 3200);
  });
  // 请求期发生自动切换（直连失败→换域名）时提示一次
  window.addEventListener('teamo:endpoint-switched', (e) => {
    updateTransportBadge();
    const to = e && e.detail && e.detail.to ? e.detail.to.replace(/^https?:\/\//, '') : '';
    toast(`直连域名不可达，已自动切换到 ${to}`, 'warn', 5000);
  });

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
      app: 'TeamoAgent', exportedAt: new Date().toISOString(), model: store.state.model,
      imageModel: store.state.imageModel, title: active.title || '',
      checkpoints: store.state.checkpoints,
      messages: store.state.messages.map((m) => ({
        role: m.role, text: m.text, content: m.content, toolCalls: m.toolCalls,
        toolCallId: m.toolCallId, name: m.name, usage: m.usage, ts: m.ts, model: m.model,
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
      // 忙判定必须在改 store 之前：旧写法先 importSession 再判忙，
      // 回合进行中导入会把正在跑的对话数组换掉（半轮丢失 + 状态栏错乱）
      if (getBusy()) return toast('请等待当前回合结束再导入', 'warn');
      const data = JSON.parse(await file.text());
      const s = store.importSession(data);
      if (!s) return toast('导入失败：文件里没有有效的 messages 数组', 'err');
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
        + `<span class="attach-chip-name mono">${esc(a.name)}</span><span class="attach-chip-size">${fmtSize(a.size)}</span><button class="attach-chip-x" type="button" aria-label="移除附件">${ICON.x}</button>`;
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
  // 构建标识：静态站点无法靠响应头保证刷新即最新，先把版本号亮出来便于自检
  const stampEl = $('#build-stamp');
  if (stampEl) {
    // 入口 index.html 自带 app-version meta；子资源 URL 没有版本参数（Pages 对所有静态文件统一回
    // cache-control: max-age=600），所以「入口已新、某个 js 还是旧的」是真实存在的窗口期
    //（这正是硬刷新后仍看到旧版本号的机制）。这里直接比对并把原因说出来。
    const entryVer = (document.querySelector('meta[name="app-version"]') || {}).content || '';
    const drifted = !!entryVer && entryVer !== APP_VERSION;
    const rel = `Teamo ${APP_RELEASE} 正式版`;
    stampEl.textContent = drifted ? `${rel} · v${APP_VERSION} / 入口 ${entryVer}` : `${rel} · v${APP_VERSION}`;
    stampEl.title = `${rel}（构建 ${APP_VERSION}）${drifted ? `；入口 index.html 是 ${entryVer}（两者应一致）` : ''} · 若看到的不是最新改动，请按 Ctrl/Cmd + Shift + R 强制刷新`;
    if (drifted) setTimeout(() => toast(`资源缓存不一致（入口 ${entryVer}，模块 ${APP_VERSION}）：请硬刷新或用无痕窗口打开`, 'warn', 9000), 700);
  }

  if (!store.state.apiKey) setTimeout(openKeyModal, 600);

  // ── 暴露给 agent hooks ───────────────────────────────────────────────
  return {
    setStatus,
    refreshKeyBtn: updateKeyBtn,   // main.js 解封成功后刷新按钮文案
    // 刷新页面后：外置在 IndexedDB 的重数据取回来了 → 重绘消息（附件图片、芯片里的生成图）
    // 与文件面板（沙箱里的图），并把沙箱重新灌进 agent（createAgent 建 fs 时它们还没回来）
    afterHydrate() {
      try { agent.loadFiles(store.state.files); } catch { /* 忽略 */ }
      rebuildMessages(); renderFiles(); renderSessions(); updateStats(); updateTransportBadge();
    },
    updateTransportBadge,
    updateStats,
    renderSessions,
    renderFiles,
    rebuildMessages, // 外部触发整段对话重绘（会话切换、示例卡刷新等）
    // 用户消息入列后立刻上屏：否则要等本轮输出完（甚至切出再切回会话）才看得到自己说了什么
    onUserMessage(m) {
      // 兼容只传文本的旧调用方（缓存错配时会出现）：退化为「最近一条还没上屏的 user 消息」
      const msg = (m && m.id) ? m : [...store.state.messages].reverse().find((x) => x.role === 'user' && !msgNodes.has(x.id));
      if (!msg || !msg.id || msgNodes.has(msg.id)) return;
      appendMessage(msg);
      refreshActionVisibility();
    },
    onAssistantStart(m) { appendMessage(m); },
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
    // 回合结束后给会话起个标题（Agent 总结；用户手改过的不会被覆盖）
    // 联网：进度与来源（模型服务端返回的 web_search 事件）
    onWebSearch: (m) => {
      const wrap = msgNodes.get(m && m.id);
      if (!wrap) return;
      paintAssistant(wrap, store.state.messages.find((x) => x.id === m.id) || m);
    },
    onWebFallback: (model, why) => {
      toast(`联网已自动关闭（${String(why || '').slice(0, 120)}）`, 'warn', 7000);
      syncWeb();
    },
    // 起标题失败绝不能冒泡到回合流程（catch 掉，标题自然退回「首条消息截断」）
    autoTitle: () => autoTitle(store).then((r) => { if (r && r.ok) renderSessions(); return r; }, () => ({ ok: false, reason: 'view-error' })),
    onToolStart() { scrollToBottom(); },
    onToolResult(call, result) {
      renderFiles();
      updateStats();
      // 同步回填对话流中的工具芯片（状态 ✓/✕ + 展开详情）
      attachToolResult({ toolCallId: call.id, content: result });
    },
    // 用户点了「停止」：Agent 已把那条消息标成 cancelled+done，但视图不会自己重画 ——
    // 停止前若首字还没到，屏上会一直留着「正在连接 xxx，等待首个响应…」和转圈。
    // 这里显式重绘这一条（并收起未完成的工具芯片），保证停下就是停下。
    onCancelled() {
      const last = [...store.state.messages].reverse().find((m) => m.role === 'assistant' && m.cancelled)
        || [...store.state.messages].reverse().find((m) => m.role === 'assistant' && !m.done);
      if (last) {
        const wrap = msgNodes.get(last.id);
        if (wrap) paintAssistant(wrap, last);
        for (const chip of $$('.chip', wrap || msgList)) {
          if (!chip.classList.contains('done')) {
            chip.classList.add('done');
            const st = $('.chip-state', chip);
            if (st && st.textContent === '…') { st.textContent = '已停止'; }
          }
        }
      }
      refreshActionVisibility();
      scrollToBottom();
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
        if (patch.image) { state.textContent = patch.note || '✓'; state.classList.remove('bad'); }
      }
      if (patch.image) {
        chipImages.set(call.id, { dataUrl: patch.image, path: patch.imagePath, width: patch.width, height: patch.height });
        // 把图记在工具调用记录上：刷新页面后能重新画出来，持久化时也才认得这是「重数据」
        // （state.js 会把它挪到 IndexedDB，而不是塞进 5MB 的 localStorage）
        call.image = patch.image;
        if (patch.imagePath) call.imagePath = patch.imagePath;
        if (patch.width) call.width = patch.width;
        if (patch.height) call.height = patch.height;
        store.save();
        paintChipImage(chip, chipImages.get(call.id));
      }
      if (patch.status === 'running' || patch.image) scrollToBottom();
    },
    attachToolResult,
    // 用户附件已自动复制到沙箱 uploads/ → 刷新文件面板并提示（可在面板内单个下载或整包 ZIP）
    onFsChange(paths) {
      renderFiles();
      if (paths && paths.length) toast(`附件已复制到沙箱：${paths.join('、')}`, 'ok', 4200);
    },
    scrollToBottom: () => scrollToBottom(true),
  };
}
