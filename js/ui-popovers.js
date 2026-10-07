// ─── UI · Token / 路由弹层（P4 拆分：从 mountUI 抽出）───────────────────────────
// 拥有：#tok-pop 的隐藏/定位（placeTokPop 自动上下翻转，data-place）、智能路由决策弹层（showRouterPop）、
//       token 构成与本轮费用弹层（showTokBreak）。
// 不拥有：会话统计文字（updateStats 留在 ui.js）、能力条弹层（ui-capability.js 复用这里的 hide/place）。
// 只读 store，不改状态；本文件绝不 import ui.js。
import { $, esc } from './ui-markdown.js?v=2026.10.5.25';
import { providerOf, systemPrompt } from './config.js?v=2026.10.5.25';
import { providerIcon } from './icons.js';
import { estimateTokens } from './context.js';
import { tokenBreakdown, formatTokBreak } from './commands.js';
import { priceBadgeFor, formatUsd } from './pricing.js';

export function installPopovers({ store }) {
  function hideTokPop() {
    const pop = $('#tok-pop');
    if (pop) pop.hidden = true;
  }
  function placeTokPop(anchor) {
    const pop = $('#tok-pop');
    if (!pop || pop.hidden) return;
    const r = (anchor && anchor.getBoundingClientRect) ? anchor.getBoundingClientRect() : ($('#conv-stats') || {}).getBoundingClientRect?.();
    if (!r) return;
    const pw = pop.offsetWidth || 240;
    const ph = pop.offsetHeight || 160;
    let left = Math.min(Math.max(8, r.left), window.innerWidth - pw - 8);
    let top = r.top - ph - 10;
    if (top < 8) top = Math.min(window.innerHeight - ph - 8, r.bottom + 8);
    pop.dataset.place = top >= r.bottom ? 'below' : 'above'; // 气泡弹入的 transform-origin 跟着锚点方向走
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
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
      html += `<div class="tok-row total"><span>对话模型 (${esc(rateBadge || headModel)})</span><span>${esc(formatUsd(s.chatUsd))}</span></div>`;
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
  return { hideTokPop, placeTokPop, showRouterPop, showTokBreak };
}
