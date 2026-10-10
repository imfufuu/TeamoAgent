import { text, onLanguageChange } from './locale.js';
export const NOTIFICATION_THRESHOLD_MS = 60000; // fixed, no editable threshold
export const NOTIFICATIONS_KEY = 'dubhe-task-notifications';
const BUSY = new Set(['moderating', 'connecting', 'thinking', 'streaming', 'executing']);
export function createTaskNotifier({ now = () => Date.now(), enabled, background, permission, show }) {
  let active = null, sequence = 0;
  return {
    onStatus(status) {
      if (BUSY.has(status)) { if (!active || active.finished) active = { started: now(), id: ++sequence, finished: false }; }
      else if (status === 'cancelled' || status === 'idle') active = null;
    },
    async finish({ status, durationMs = 0, sessionId = '', turnId = '' } = {}) {
      if (!active || active.finished || !['done', 'error'].includes(status)) { if (status === 'cancelled') active = null; return false; }
      const task = active; task.finished = true;
      const elapsed = Math.max(Number(durationMs) || 0, now() - task.started);
      if (elapsed <= NOTIFICATION_THRESHOLD_MS || !enabled() || permission() !== 'granted' || !background()) return false;
      await show({ status, tag: `dubhe-task-${turnId || task.id}`, sessionId }); return true;
    },
  };
}
export function installTaskNotifications({ toast, win = window, doc = document }) {
  let enabled = false; try { enabled = localStorage.getItem(NOTIFICATIONS_KEY) === 'on'; } catch { /* local only */ }
  const supported = !!win.Notification && win.isSecureContext !== false;
  const button = doc.getElementById('set-notifications'), note = doc.getElementById('notifications-note');
  const sync = () => {
    if (!button) return;
    button.disabled = !supported; button.setAttribute('aria-pressed', String(enabled && win.Notification?.permission === 'granted'));
    button.textContent = enabled ? text('关闭通知', 'Disable notifications') : text('开启通知', 'Enable notifications');
    if (note) note.textContent = !supported ? text('当前环境不支持系统通知；iOS需添加到主屏幕后使用', 'System notifications are unavailable here. On iOS, add this app to the Home Screen first.')
      : win.Notification.permission === 'denied' ? text('通知权限已拒绝，请在浏览器站点设置中重新允许', 'Permission denied. Enable notifications in your browser site settings.')
      : text('固定：超过60秒且在后台；手动停止不通知', 'Fixed: over 60s and in the background; manual stops are excluded.');
  };
  button?.addEventListener('click', async () => {
    if (enabled) enabled = false;
    else {
      try { enabled = await win.Notification.requestPermission() === 'granted'; }
      catch { enabled = false; }
      if (!enabled) toast(text('未获得通知权限', 'Notification permission was not granted'), 'warn');
    }
    try { localStorage.setItem(NOTIFICATIONS_KEY, enabled ? 'on' : 'off'); } catch { /* current page */ } sync();
  });
  const notifier = createTaskNotifier({ enabled: () => enabled, permission: () => win.Notification?.permission,
    background: () => doc.hidden || typeof doc.hasFocus === 'function' && !doc.hasFocus(),
    show: async ({ status, tag, sessionId }) => {
      // Do not put prompts, code, model replies, credentials or workspace paths on a lock screen.
      const title = status === 'done' ? text('Dubhe · 任务已完成', 'Dubhe · Task completed') : text('Dubhe · 任务出错', 'Dubhe · Task failed');
      const options = { body: text('点击返回查看结果', 'Click to return to the result'), tag, data: { sessionId }, silent: false };
      let reg; try { reg = await win.navigator.serviceWorker?.getRegistration(); } catch { /* fallback */ }
      if (reg?.showNotification) await reg.showNotification(title, options);
      else { const n = new win.Notification(title, options); n.onclick = () => { win.focus(); n.close(); }; }
    },
  });
  onLanguageChange(sync); sync(); return { ...notifier, sync };
}
