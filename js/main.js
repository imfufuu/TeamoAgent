// ─── 启动引导 ──────────────────────────────────────────────────────────
import { createStore } from './state.js?v=2026.10.5.36';
import { createAgent } from './agent.js?v=2026.10.5.36';
import { mountUI, toast } from './ui.js?v=2026.10.5.36';
import { relayAvailable } from './net.js';
import { probeGatewayHosts } from './endpoint.js';
import { isAdminAlias, unlockAdminKey } from './adminkey.js';
import { mountDebugWindow, toggleDebug, debugActive, setDebug } from './debugwindow.js?v=2026.10.5.36';
import { mountSettings, applyFontSize, applyMotion, browserFeatureReport } from './settings.js?v=2026.10.5.36';
import { APP_RELEASE } from './config.js?v=2026.10.5.36';

// 启动屏真实进度：模块图已下载并执行到这里 → 「加载模块」完成
const bootStage = (name) => { try { const g = window.__dubheBootGuard; g && typeof g.stage === 'function' && g.stage(name); } catch { /* 启动屏已移除 */ } };
bootStage('modules');

const store = createStore();
// relayOk 是运行时探测结果，不复用上次持久化值；null 表示探测进行中。
store.state.relayOk = null;
// 正式应用强制开启本地内容审核：旧 localStorage 里即使残留 contentModeration=false 也不能绕过图片审核。
store.state.settings.contentModeration = true;

// UI 先挂载（agent hooks 需要引用 ui 方法），再创建 agent 注入 hooks
let ui = null;
const hooks = {
  onStatus: (s) => { ui && ui.setStatus(s); globalThis.__dubheDebugLog && globalThis.__dubheDebugLog('agent.status', String(s)); },
  onUserMessage: (text, msg) => { ui && ui.onUserMessage(msg); ui && ui.renderSessions(); ui && ui.renderFiles(); ui && ui.updateStats(); ui && ui.scrollToBottom(); },
  onJevPlan: (msg) => { ui && ui.onJevPlan && ui.onJevPlan(msg); },
  onFsChange: (paths) => ui && ui.onFsChange && ui.onFsChange(paths),
  onTempCommit: (m) => ui && ui.onTempCommit && ui.onTempCommit(m),
  onModerationFailOpen: (reason) => {
    globalThis.__dubheDebugLog && globalThis.__dubheDebugLog('moderation.fail-open', reason || '超时');
    toast(`⚠ 图片/文本审核${reason || '超时'}，本轮已放行——控制台输入 __dubheModDump() 可复制完整审核日志（β）`, 'warn', 9000);
  },
  onModerationFailClosed: (reason) => {
    globalThis.__dubheDebugLog && globalThis.__dubheDebugLog('moderation.fail-closed', reason || '超时');
    toast('图片审核超时，本轮已阻止（图片未进沙箱）。模型在后台继续预热，稍后重发即可', 'warn', 9000);
  },
  onAssistantStart: (m) => ui && ui.onAssistantStart(m),
  onRetry: (_m, info) => {
    const n = info && info.attempt || 1;
    const total = 3;
    const why = info && info.reason === 'first-token-timeout'
      ? `${Math.round(15)} 秒未收到模型输出`
      : '连接瞬断';
    toast(`连接异常（${why}），正在第 ${n}/${total} 次重试…`, 'warn', 3000);
  },
  onDelta: (m, text) => ui && ui.onDelta(m, text),
  onReasoning: (m, text) => ui && ui.onReasoning(m, text),
  onAssistantDone: (m) => ui && ui.onAssistantDone(m),
  onToolStart: (call) => ui && ui.onToolStart(call),
  onToolResult: (call, result) => ui && ui.onToolResult(call, result),
  onToolEvent: (call, patch) => ui && ui.onToolEvent(call, patch),
  // P1 执行内核：高风险操作的交互确认（UI 渲染确认卡 → agent.resolveConfirmation 回传决定）
  onConfirmationRequest: (call, requestText, key) => ui && ui.onConfirmationRequest && ui.onConfirmationRequest(call, requestText, key),
  onConfirmationResolved: (call, rec) => ui && ui.onConfirmationResolved && ui.onConfirmationResolved(call, rec),
  onTurnEnd: () => {
    ui && ui.renderFiles(); ui && ui.renderSessions(); ui && ui.updateStats();
    // 回合结束后让 Agent 给这次会话起个标题（用户手改过的不会被覆盖；失败静默退回兜底标题）
    ui && ui.autoTitle && ui.autoTitle();
  },
  onThinkingFallback: (model) => toast(`${model} 不支持思考参数，本次会话已为其自动关闭思考模式`, 'warn', 5200),
  // 兼容旧网关回传的服务端搜索进度/来源事件；当前网页查询走 health 声明的 Worker 工具。
  onWebSearch: (m, web) => ui && ui.onWebSearch && ui.onWebSearch(m, web),
  onRelayStatus: () => { if (ui && ui.syncWeb) ui.syncWeb(); },
  onWebFallback: (model, why) => {
    toast(`联网已自动关闭：${String(why || '').slice(0, 140)}`, 'warn', 7000);
    ui && ui.onWebFallback && ui.onWebFallback(model, why);
  },
  onTurnTiming: (ms) => ui && ui.onTurnTiming(ms),
  onCancelled: () => { ui && ui.onCancelled && ui.onCancelled(); toast('已停止生成', 'warn'); ui && ui.updateStats(); },
  onModerationCleared: () => { ui && ui.rebuildMessages && ui.rebuildMessages(); ui && ui.renderSessions(); ui && ui.updateStats(); },
  onModerationBlocked: (_m, result) => {
    const timedOut = !!(result && result.image && result.image.timeout);
    toast(timedOut ? '图片审核超时，本轮已阻止（未进沙箱），请稍后重发' : '该内容已被审核', 'warn', 7000);
    ui && ui.renderSessions(); ui && ui.updateStats();
  },
  onError: (err) => {
    console.error(err);
    const last = [...store.state.messages].reverse().find((m) => m.role === 'assistant' && !m.done);
    if (last) store.updateMessage(last.id, { error: err.message, done: true });
    else store.pushMessage({ role: 'assistant', text: '', error: err.message, done: true });
    toast(err.message.slice(0, 120), 'err', 5000);
    ui && ui.onAssistantDone(last || store.state.messages[store.state.messages.length - 1]);
    ui && ui.updateStats();
  },
  onNeedKey: () => { window.openKeyModal && window.openKeyModal(); toast('请先配置 API Key', 'warn'); },
};

bootStage('kernel');
const agent = createAgent(store, hooks);
applyFontSize();
applyMotion();
bootStage('ui');
ui = mountUI(store, agent);
// 旧浏览器提示（.32）：缺 color-mix / :has 时样式会「有骨架、丢细节」，用户容易以为是加载失败；说清原因与版本建议，每个会话只提一次
try {
  const feat = browserFeatureReport();
  if (!feat.ok && !sessionStorage.getItem('dubhe-oldbrowser-noted')) {
    sessionStorage.setItem('dubhe-oldbrowser-noted', '1');
    setTimeout(() => toast(`⚠ ${feat.advice}`, 'warn', 9000), 1500);
  }
} catch { /* 提示失败不影响使用 */ }
mountSettings(store, {
  onRelayChanged: () => { relayAvailable().then((ok) => { store.state.relayOk = ok; if (ui && ui.syncWeb) ui.syncWeb(); }).catch(() => {}); },
  onKeySaved: () => { if (ui && ui.updateStats) ui.updateStats(); },
  // 设置页任何开关 / 档位 / 主题变化 → 顶栏 pill（沙箱 / 联网 / 快速 / 思考）、能力行、主题按钮同步
  onSettingChanged: () => { if (ui && ui.syncToolbar) ui.syncToolbar(); },
});
// β 调试浮窗：?debug=1 / Ctrl+Alt+D / ⌘K「打开调试浮窗」三种入口，挂载失败不影响主应用
try {
  const dbgParams = new URLSearchParams(location.search);
  if ((dbgParams.has('debug') || location.hash === '#debug') && dbgParams.get('debug') !== '0' && !debugActive()) setDebug(true);
  mountDebugWindow();
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.altKey && String(e.key || '').toLowerCase() === 'd') {
      e.preventDefault();
      toggleDebug();
    }
  });
} catch { /* 调试浮窗异常不阻塞主应用 */ }
// 启动即后台预热图片审核模型（不等用户加附件）——慢网络给 26MB 资源留足下载窗口
setTimeout(() => { try { globalThis.__dubhePrewarmImageModeration && globalThis.__dubhePrewarmImageModeration('startup'); } catch { /* 忽略 */ } }, 2000);
// 这里不再 fs.import(state.files)：createAgent 已经用同一份 state.files 建好了 fs，
// 再 import 一次不仅多余，还会把「挂载期间被清空的文件」重新灌回去（clearFiles 走的是
// 同一批同步路径），表现为清空后文件又出现。

// 关闭/隐藏页面时同步落盘（防抖版 save 的定时器在卸载时不会触发，会丢最后一轮对话）
window.addEventListener('beforeunload', () => store.save(true));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') store.save(true);
});
// 网页中继探测（一次）：本地 server.py 提供单页抓取/Git；Worker health 另行声明 search/crawl 特性。
// 未声明的路由不会进入工具表，避免模型调用旧版本地 relay 的 404；内置沙箱 Git 仍可离线用。
relayAvailable().then((ok) => { store.state.relayOk = ok; if (ui && ui.syncWeb) ui.syncWeb(); }).catch(() => {});

// 刷新后如果存的还是管理员别名，重新解封一次（口令就是别名本身，不需要再问用户）
if (isAdminAlias(store.state.apiKey)) {
  unlockAdminKey(store.state.apiKey).then((r) => {
    if (!r.ok) toast(r.reason === 'expired' ? '管理员密钥已过期：口令正确也无法再使用，请联系管理员换发' : '管理员密钥未解封：请在 API Key 里重新输入口令', 'warn', 6000);
    else if (ui && ui.refreshKeyBtn) ui.refreshKeyBtn();
  }).catch(() => {});
}

// 网关接入点择路（一次性）：国内网络下 api.teamorouter.com 常常打不开，
// 而 api.teamorouter.cn 正常。并行探测两个域名，把能用的记下来，之后请求都用它。
probeGatewayHosts().then((r) => {
  if (r.switched && r.by === 'probe') toast(`网关接入点已自动选择：${r.host}`, 'ok', 4000);
  if (ui && ui.updateTransportBadge) ui.updateTransportBadge();
}).catch(() => {});

// 刷新页面后把外置的重数据取回来（附件图片 / 沙箱里的图 / 生成图）：
// 这些原本存在 localStorage 里，图一多就爆 5MB 配额、被静默丢掉；现在放在 IndexedDB，
// 启动后台取回，取到了再重绘（不阻塞首屏，失败就按「已省略」显示）。
if (store.hydrateBlobs) {
  store.hydrateBlobs().then((n) => { if (n) ui.afterHydrate(); }).catch(() => {});
}

console.log(`%c◐ Dubhe Agent ${APP_RELEASE}`, 'font-weight:800;font-size:16px', '· TeamoRouter Gateway');

// 审核资源离线缓存：首次下载后持久化（stale-while-revalidate），之后会话零网络直读
try {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
  }
} catch { /* SW 不可用不影响应用 */ }
