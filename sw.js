/* TeamoAgent 审核资源离线缓存 Service Worker（构建 2026.9.27.19）
 * 策略：stale-while-revalidate —— 命中缓存立即返回（零网络），后台静默更新。
 * 覆盖：assets/vendor、assets/moderation、assets/katex、assets/pdfjs、assets/hljs、assets/icons、fonts。
 * 效果：模型/运行时/厂商图标只在首次使用时下载一次，之后所有会话（含隔天重开）直接读本地缓存，
 *       连 304 协商都不发生。版本号变更时改 CACHE 名即可整体失效。
 */
const CACHE = 'teamo-assets-v1';
const SCOPE_RE = /\/assets\/(vendor|moderation|katex|pdfjs|hljs|fonts|icons)\//;

// 厂商图标安装即预热（.19）：模型菜单/消息头第一次画就有缓存，不发起可见网络加载
const PRECACHE_ICONS = [
  'anthropic.svg', 'openai.svg', 'gemini.svg', 'deepseek.svg',
  'zhipu.svg', 'kimi.svg', 'grok.svg', 'github.svg',
].map((f) => new Request(`/assets/icons/${f}`, { cache: 'reload' }));

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE);
      // 单个失败不影响整体（新图标上线途中旧 SW 也能装上）
      await Promise.all(PRECACHE_ICONS.map((r) => cache.add(r).catch(() => {})));
    } catch { /* 无缓存环境忽略 */ }
  })());
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (!SCOPE_RE.test(new URL(req.url).pathname)) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    const net = fetch(req).then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    const fresh = await net;
    return fresh || new Response('', { status: 504 });
  })());
});
