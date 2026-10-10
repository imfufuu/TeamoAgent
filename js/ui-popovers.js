// ─── UI · Token / 路由弹层（P4 拆分：从 mountUI 抽出）───────────────────────────
// 拥有：#tok-pop 的隐藏/定位（placeTokPop 自动上下翻转，data-place）、智能路由决策弹层（showRouterPop）、
//       token 构成与本轮费用弹层（showTokBreak）。
// 不拥有：会话统计文字（updateStats 留在 ui.js）、能力条弹层（ui-capability.js 复用这里的 hide/place）。
// 只读 store，不改状态；本文件绝不 import ui.js。
import { $, esc } from './ui-markdown.js?v=2026.10.10.1';
import { providerOf, systemPrompt } from './config.js?v=2026.10.10.1';
import { providerIcon } from './icons.js';
import { estimateTokens } from './context.js';
import { tokenBreakdown, formatTokBreak } from './commands.js';
import { priceBadgeFor, formatUsd } from './pricing.js';
import { modelDisplayName } from './smartrouter.js?v=2026.10.10.1';

export function installPopovers({ store }) {
  function hideTokPop() {
    const pop = $('#tok-pop');
    if (pop) { pop.hidden = true; delete pop.dataset.sheet; }
    syncTokScrim(false);
  }
  // 2026.10.9.1（第 3 条）：窄屏（≤720px）的能力表 = 底部抽屉（data-sheet + 遮罩）；其它弹层保持锚定气泡。
  // 抽屉不跟锚点定位：placeTokPop 直接返回；窗口从宽变窄时，下一次 follow() 会自动切进抽屉。
  const TOK_SHEET_MQ = '(max-width: 720px)';
  function syncTokScrim(on) {
    const scrim = $('#tok-sheet-scrim');
    if (scrim) scrim.hidden = !on;
  }
  function syncTokSheet(pop) {
    const sheet = !!pop && !pop.hidden && pop.dataset.kind === 'cap' && typeof matchMedia === 'function' && matchMedia(TOK_SHEET_MQ).matches;
    if (sheet) pop.dataset.sheet = '1'; else delete pop.dataset.sheet;
    syncTokScrim(sheet);
    return sheet;
  }
  // .36：锚点解析。能力条 / 会话统计栏重绘会换掉 DOM 节点，锚一旦脱离文档或没有盒，
  // getBoundingClientRect() 全是 0 → 弹层被摆到屏幕左上角 (8,8)。此时按语义退回：
  // 能力弹层退到整条能力行，其它退到会话统计栏；两者都不可用就保持原锚（不改变位置）。
  function isPlacedNode(n) {
    if (!n || typeof n.getBoundingClientRect !== 'function') return false;
    if (n.isConnected === false) return false;
    const r = n.getBoundingClientRect();
    return !(r.width === 0 && r.height === 0 && r.left === 0 && r.top === 0);
  }
  function resolveAnchor(anchor, kind) {
    if (isPlacedNode(anchor)) return anchor;
    const fb = kind === 'cap' ? $('#cap-line') : ($('#conv-stats') || $('#cap-line'));
    if (isPlacedNode(fb)) return fb;
    return (anchor && typeof anchor.getBoundingClientRect === 'function') ? anchor : fb;
  }
  function placeTokPop(anchor) {
    const pop = $('#tok-pop');
    if (!pop || pop.hidden) return;
    if (syncTokSheet(pop)) { pop.style.left = ''; pop.style.top = ''; pop.style.removeProperty('--pop-arrow-x'); return; }
    const target = resolveAnchor(anchor, pop.dataset.kind);
    const fellBack = target !== anchor; // 锚已失效 → 退到整条能力行 / 统计栏
    if (fellBack) pop._anchor = target;
    const r = (target && target.getBoundingClientRect) ? target.getBoundingClientRect() : ($('#conv-stats') || {}).getBoundingClientRect?.();
    if (!r) return;
    const pw = pop.offsetWidth || 240;
    const ph = pop.offsetHeight || 160;
    // 锚是整条能力行（含「已禁用 N」胶囊消失后退回的情况）时，按该行的左内边距对齐：
    // #cap-line 左右各有 24px 内边距，贴着行边框摆会明显偏左
    let inset = 0;
    if (target && target.id === 'cap-line') {
      try { inset = parseFloat(getComputedStyle(target).paddingLeft) || 0; } catch { inset = 0; }
    }
    let left = Math.min(Math.max(8, r.left + inset), window.innerWidth - pw - 8);
    // 能力行的胶囊在页面顶部：弹层固定放在胶囊正下方（.34）；其它锚点仍优先放上方，放不下再翻到下方
    const preferBelow = !!(anchor && anchor.classList && anchor.classList.contains('cap-pill'));
    const below = preferBelow || pop.dataset.kind === 'cap'; // 能力弹层永远朝下（锚退回能力行时也一样）
    let top = preferBelow ? r.bottom + 8 : r.top - ph - 10;
    if (below && !preferBelow) top = r.bottom + 8;
    if (!below && top < 8) top = Math.min(window.innerHeight - ph - 8, r.bottom + 8);
    if (below && top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 10);
    pop.dataset.place = top >= r.bottom ? 'below' : 'above'; // 气泡弹入的 transform-origin 跟着锚点方向走
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    // 小箭头指回锚点中心（clamp 进弹层左右 12px 内，含圆角与描边）
    const cx = (r.left + r.right) / 2;
    pop.style.setProperty('--pop-arrow-x', `${Math.min(Math.max(12, cx - left), Math.max(12, pw - 12))}px`);
  }
  // 智能路由详情弹层：与 token 弹层共用 #tok-pop（同一时间只开一个）
  function showRouterPop(anchor, ri, realModel) {
    const pop = $('#tok-pop');
    const body = $('#tok-pop-body');
    const head = pop && $('.tok-pop-h', pop);
    if (!pop) return;
    if (!pop.hidden && pop.dataset.kind === 'router' && pop._anchor === anchor) { hideTokPop(); return; }
    pop.dataset.kind = 'router';
    pop._anchor = anchor;
    if (head) head.textContent = '智能路由';
    const provider = (ri && ri.chosenProvider) || providerOf(realModel) || '—';
    const rows = [
      ['任务类型', ri ? ri.categoryLabel : '—'],
      ['难度', ri ? ri.difficultyLabel : '—'],
      ['服务商', provider],
    ];
    let html = rows.map(([k, v]) => `<div class="tok-row"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('');
    html += `<div class="tok-row total router-model-row"><span>具体模型</span><span class="router-model">${providerIcon(providerOf(realModel))}<span class="mono">${esc(realModel || '未知')}</span></span></div>`;
    html += '<div class="tok-hint">路由由本地启发式即时决定；换一句话问，可能会选到不同模型。</div>';
    if (body) body.innerHTML = html;
    pop.hidden = false;
    placeTokPop(anchor);
  }
  function showTokBreak(anchor, turnInfo = null) {
    const pop = $('#tok-pop');
    const body = $('#tok-pop-body');
    const stats = $('#conv-stats');
    if (!pop) return;
    if (!pop.hidden && pop.dataset.kind !== 'router') { hideTokPop(); return; }
    pop.dataset.kind = 'tokens';
    const headEl = $('.tok-pop-h', pop);
    if (headEl) headEl.textContent = 'Token 构成';
    const sysTok = estimateTokens([{ role: 'system', text: systemPrompt(new Date(), { webEnabled: false }) }]);
    const b = tokenBreakdown(store.state.messages, estimateTokens, sysTok);
    const n = (x) => (x >= 1000 ? `${(x / 1000).toFixed(1)}k` : String(x || 0));
    const rows = [
      ['系统', b.system], ['历史', b.history], ['工具结果', b.tools], ['本轮', b.current], ['合计', b.total],
    ];
    let html = rows.map(([k, v], i) => `<div class="tok-row${i === rows.length - 1 ? ' total' : ''}"><span>${k}</span><span>${n(v)}</span></div>`).join('');
    if (turnInfo && turnInfo.summary) {
      const s = turnInfo.summary;
      const headModel = (turnInfo.headMsg && turnInfo.headMsg.model) || store.state.model;
      const rateBadge = priceBadgeFor(headModel, { fastMode: !!(turnInfo.headMsg && turnInfo.headMsg.fastMode) });
      html += `<div class="tok-row total"><span>对话模型 (${esc(rateBadge || modelDisplayName(headModel))})</span><span>${esc(formatUsd(s.chatUsd))}</span></div>`;
      if (s.visionUsd > 0) html += `<div class="tok-row"><span>识图模型</span><span>${esc(formatUsd(s.visionUsd))}</span></div>`;
      if (s.imageUsd > 0) html += `<div class="tok-row"><span>生图模型</span><span>${esc(formatUsd(s.imageUsd))}</span></div>`;
      if (s.subagentUsd > 0) html += `<div class="tok-row"><span>子智能体</span><span>${esc(formatUsd(s.subagentUsd))}</span></div>`;
      html += `<div class="tok-row total"><span>本轮预估总价</span><span>${esc(s.formatted)}</span></div>`;
    }
    if (body) body.innerHTML = html;
    const line = formatTokBreak(b);
    if (stats) stats.title = line + '（再点一次收起）';
    pop.hidden = false;
    placeTokPop(anchor && anchor.nodeType ? anchor : stats);
  }
  // 打开期间：Esc 收起（对话框语义，模态优先）；窗口尺寸 / 滚动变了就重新贴回锚点
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const pop = $('#tok-pop');
    if (!pop || pop.hidden) return;
    if ($('.modal.open') || $('.cmd-palette:not([hidden])')) return;
    hideTokPop();
  });
  let followRaf = 0;
  const follow = () => {
    if (followRaf) return;
    followRaf = requestAnimationFrame(() => {
      followRaf = 0;
      const pop = $('#tok-pop');
      if (pop && !pop.hidden) placeTokPop(pop._anchor);
    });
  };
  window.addEventListener('scroll', follow, { passive: true, capture: true });
  window.addEventListener('resize', follow, { passive: true });
  return { hideTokPop, placeTokPop, showRouterPop, showTokBreak };
}
