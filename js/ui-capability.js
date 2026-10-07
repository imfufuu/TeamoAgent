// Dubhe Agent · 顶栏能力条 + 工具表 diff 弹层（P3 修正：能力门控不透明；从 ui.js 的 mountUI 拆出）
// 以前那行「智能 · 思考 Medium · 沙箱 · 联网 · 直连」只是 displayTier 字符串，dispatch_subagent /
// crawl_site / execute_cpp 为什么没在工具表里，UI 一个字都不说。现在：
//   ① 每个胶囊可点，弹出 agent.previewToolTable() 的结果——「已禁用 N 个：工具（原因）」，原因文案与
//      系统提示共用 executionContext.js 的 DROP_REASON_LABEL；
//   ② 每条带直达开关（切到 Max / 打开联网 / 打开沙箱 / 重新探测中继 / 打开设置），点完原地重算，条目消失；
//   ③ 有裁剪时能力条末尾多一个「已禁用 N」胶囊，不点开也看得见。
// 弹层复用 #tok-pop（与 token / 智能路由弹层同一时间只开一个）。
import { isSmartRouter, SMART_ROUTER_LABEL } from './smartrouter.js';
import { reasoningLevelLabel } from './reasoning.js';
import { getTransport } from './api.js?v=2026.10.5.28';
import { DROP_REASON_FIX } from './executionContext.js?v=2026.10.5.28';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 纯函数：把预演结果渲染成弹层 HTML（dom-smoke 与单测都直接断言这段输出）。 */
export function renderCapabilityPopHtml(preview) {
  const p = preview || { allowed: [], dropped: [], total: 0, tier: null };
  const dropped = Array.isArray(p.dropped) ? p.dropped : [];
  const tier = p.tier || {};
  const rows = [
    `<div class="tok-row"><span>可用工具</span><span class="mono">${p.allowed.length} / ${p.total || p.allowed.length + dropped.length}</span></div>`,
    `<div class="tok-row"><span>思考档位</span><span>${esc(tier.displayTier || '—')}${tier.canDispatch ? '（可委派）' : '（不可委派）'}</span></div>`,
  ];
  let list = '';
  if (dropped.length) {
    list = `<div class="cap-drop-h">已禁用 ${dropped.length} 个</div>` + dropped.map((d) => {
      const fix = DROP_REASON_FIX[d.reason];
      const btn = fix ? `<button type="button" class="tok-btn cap-fix" data-fix="${esc(fix.kind)}" data-tool="${esc(d.name)}">${esc(fix.label)}</button>` : '';
      return `<div class="cap-drop" data-tool="${esc(d.name)}" data-reason="${esc(d.reason)}"><span class="mono cap-tool">${esc(d.name)}</span><span class="cap-why">${esc(d.label || d.reason)}</span>${btn}</div>`;
    }).join('');
  } else {
    list = '<div class="tok-hint">全部工具可用，没有被门控裁剪的项。</div>';
  }
  return `${rows.join('')}${list}<div class="tok-hint">按当前开关态预演；发请求时的工具表与此逐项一致。</div>`;
}

export function installCapabilityPop({
  store, agent,
  hideTokPop, placeTokPop, toast,
  setReasoning, toggleWeb, toggleSandbox, reprobeRelay, openSettings,
} = {}) {
  const preview = () => {
    try { return agent && typeof agent.previewToolTable === 'function' ? agent.previewToolTable() : null; } catch { return null; }
  };

  function syncCapLine() {
    const eln = $('#cap-line');
    if (!eln) return;
    const st = store.state.settings;
    const bits = [['model', store.state.model === '__system__' ? 'system-commands' : (isSmartRouter(store.state.model) ? SMART_ROUTER_LABEL : store.state.model)]]; // 通道态与模型钮同一叫法（.18）
    if (st.thinking !== false) bits.push(['think', `思考 ${reasoningLevelLabel(st.reasoningLevel)}`]);
    if (st.sandboxEnabled) bits.push(['sandbox', '沙箱']);
    if (store.state.relayOk === true && st.webEnabled !== false) bits.push(['web', '联网']);
    bits.push(['transport', getTransport() === 'proxy' ? '中继' : '直连']);
    const panelOpen = $('#sandbox-panel') && !$('#sandbox-panel').classList.contains('collapsed');
    if (panelOpen) bits.push(['panel', '面板']);
    const pv = store.state.model === '__system__' ? null : preview();
    const dropN = pv ? pv.dropped.length : 0;
    if (dropN) bits.push(['drop', `已禁用 ${dropN}`]);
    eln.innerHTML = bits.map(([k, t]) => `<button type="button" class="cap-pill${k === 'drop' ? ' cap-pill-drop' : ''}" data-cap="${k}" title="点击查看本轮工具表：哪些可用、哪些被门控禁用及原因">${esc(t)}</button>`).join('<span class="cap-sep">  ·  </span>');
    eln.classList.toggle('has-drop', dropN > 0);
    eln.dataset.dropped = String(dropN);
    // 弹层开着时跟着刷新（切档位 / 开关联网后条目要原地消失）
    const pop = $('#tok-pop');
    if (pop && !pop.hidden && pop.dataset.kind === 'cap') paintPop(pop);
  }

  function paintPop(pop) {
    const body = $('#tok-pop-body');
    const head = $('.tok-pop-h', pop);
    if (head) head.textContent = '能力 · 工具表';
    if (body) body.innerHTML = renderCapabilityPopHtml(preview());
  }

  function showCapPop(anchor) {
    const pop = $('#tok-pop');
    if (!pop) return;
    if (!pop.hidden && pop.dataset.kind === 'cap') { hideTokPop(); return; }
    pop.dataset.kind = 'cap';
    pop._anchor = anchor;
    paintPop(pop);
    pop.hidden = false;
    placeTokPop(anchor);
  }

  const runFix = async (kind, tool) => {
    try {
      if (kind === 'reasoning-max') setReasoning && setReasoning('max');
      else if (kind === 'web-on') toggleWeb && (await toggleWeb());
      else if (kind === 'sandbox-on') toggleSandbox && toggleSandbox();
      else if (kind === 'relay-reprobe') reprobeRelay && (await reprobeRelay());
      else if (kind === 'settings') { hideTokPop(); openSettings && openSettings(); return; }
    } catch (err) {
      toast && toast(`操作失败：${String((err && err.message) || err).slice(0, 120)}`, 'warn');
    }
    syncCapLine();
    const pop = $('#tok-pop');
    if (pop && !pop.hidden && pop.dataset.kind === 'cap') {
      paintPop(pop);
      placeTokPop(pop._anchor);
      const still = preview();
      if (still && !still.dropped.some((d) => d.name === tool)) toast && toast(`${tool} 已加入工具表`, 'ok');
    }
  };

  const line = $('#cap-line');
  if (line) {
    line.addEventListener('click', (e) => {
      const pill = e.target.closest('.cap-pill');
      if (!pill) return;
      e.stopPropagation(); // 不让 document 级「点外面关闭」把刚打开的弹层又关掉
      showCapPop(line);
    });
    line.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('.cap-pill')) { e.preventDefault(); showCapPop(line); }
    });
  }
  const popEl = $('#tok-pop');
  if (popEl) {
    popEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.cap-fix');
      if (!btn || popEl.dataset.kind !== 'cap') return;
      e.preventDefault(); e.stopPropagation();
      runFix(btn.dataset.fix, btn.dataset.tool);
    });
  }

  return { syncCapLine, showCapPop, previewToolTable: preview };
}
