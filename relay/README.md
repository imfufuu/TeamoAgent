# Dubhe Agent Cloudflare Relay

Cloudflare Worker 中继（module syntax），为静态站点提供单页抓取、有限网页搜索与同源小站点爬取。当前版本 **1.8.0**。

## 部署

### Wrangler（推荐）

```bash
cd relay
npx wrangler deploy
```

`wrangler.toml` 已指向 `worker.js`。部署前先在 `wrangler dev` 下做本地 smoke test；发布后记下 `https://<worker>.<account>.workers.dev`。

### Cloudflare Dashboard

在 Workers & Pages 创建 Worker，使用模块编辑器粘贴仓库中的 `worker.js` 全文并部署。`worker-dashboard.js` 是旧式 service-worker 语法的 **1.5 兼容版**，没有 Search/Crawl 路由；不要用它部署新功能。

## 在 Dubhe Agent 里启用

**方式 A：同源绑定（推荐）**：把 Pages/Worker 的 `/api/*` 路由绑定到这个 Worker。前端探测 `/api/health`，只有 health 声明 `capabilities: ["fetch", "search", "crawl"]` 才会提供对应工具。

**方式 B：配置 Worker URL**：在 Dubhe Agent 浏览器控制台执行：

```js
localStorage.setItem('dubhe-relay', 'https://<worker>.<account>.workers.dev');
location.reload();
```

如果本地 `server.py` 已运行，它仍优先处理单页抓取与 Git；新 Worker 的搜索/爬虫路由会按 health 能力单独探测，不会误打到旧服务的 404。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 版本与 `fetch/search/crawl` capabilities |
| GET | `/api/fetch?url=...&mode=text\|raw&max=...` | SSRF 护栏后的单页抓取；最大 4 MB |
| GET | `/api/search?q=...&limit=...` | SearXNG（配置时）优先；不可用则 DuckDuckGo HTML 回退；最多 10 条、搜索响应最多 600 KB |
| GET | `/api/crawl?url=...&max_pages=...&max_depth=...&max_bytes=...&max_chars=...` | 同源 BFS 爬取；默认 3 页/深度 1，硬上限 5 页/深度 2；每页最多 800 KB 输入、16,000 字正文 |
| GET | `/api/screenshot?url=...&viewport=desktop\|tablet\|mobile&full_page=1&wait_ms=...&selector=...` | 网页截图（Cloudflare Browser Run）→ PNG，≤ 8 MB；视口 1280×800 / 820×1180 / 390×844；仅在配置了 `CF_ACCOUNT_ID` + `CF_API_TOKEN` 时存在，否则 404 |

Search 响应包含 provider、fallback/warning、标题、URL、摘要和来源。Crawl 响应按页返回标题、描述、正文、深度、截断状态及失败项。Crawler 只跟随同源 HTTP(S) 文本链接，跳过常见二进制扩展；**不执行 JavaScript、不渲染浏览器、不遵循 robots.txt、不处理登录态，也不是通用全网爬虫**。

## 网页截图（可选，Browser Run）

截图由 Cloudflare Browser Run 的 REST 接口完成（`POST /accounts/{id}/browser-rendering/screenshot`），Worker 本身不带浏览器。

1. 在 Cloudflare Dashboard 创建 API Token，权限选 **Browser Rendering（Write / Edit）**，并记下账号 ID。
2. 配置 Worker：账号 ID 可写在 Settings → Variables 的 `CF_ACCOUNT_ID`；Token 用 Secret 保存（`npx wrangler secret put CF_API_TOKEN`）。
3. 重新部署（`cd relay && npx wrangler deploy`）。`GET /api/health` 的 `capabilities` 出现 `screenshot` 后，前端才会提供 `screenshot_web` 工具。

**费用与边界**：Browser Run 按量计费，前端只在用户明确要求看页面外观时调用。URL 与普通抓取使用同一套 SSRF 护栏（拒绝内网 / 环回 / 保留地址与用户信息）；截图在 Cloudflare 的浏览器里执行，**不能访问你内网的页面**。返回的是 PNG 原字节，不经 JSON 包装。

## 可选 SearXNG

无需部署自带搜索索引。若已有启用 JSON 格式的 SearXNG 实例，在 Cloudflare Worker 的 Settings → Variables 中设置 `SEARXNG_URL`（HTTPS 基址，例如 `https://search.example.org`）。Worker 会请求 `/search?q=…&format=json&language=all`；实例必须允许 JSON 输出。未配置、超时、格式错误或无有效结果时回退 DuckDuckGo HTML，并把降级原因写进响应。搜索词会发送给所选上游搜索服务；不要提交密码、密钥或个人敏感信息作为查询。

## 安全与公开部署

- URL 仅允许 HTTP(S)，拒绝用户信息、字面私网/环回/链路本地/保留 IP 和常见内部主机名；重定向逐跳校验。Cloudflare Worker 没有通用 DNS 解析 API，**不能宣称防住所有 DNS 重绑定/私有 DNS 解析**。
- Crawl 额外要求每次重定向保持与起始页相同 origin；每页、页数、深度、响应字节数、返回字符数和上游超时均有限制。
- CORS 为 `*`，Worker 本身没有鉴权。对公开部署，建议在 Cloudflare WAF/Rate Limiting 中为 `/api/search`、`/api/crawl`、`/api/fetch` 设请求限额；不要把它当成私密网络代理。
- 搜索结果和网页正文是不可信外部输入，模型提示词会要求将其视为资料而非指令；仍应在回答中核对原始 URL。

## 测试

```bash
cd ..
npm run test:worker
```

测试使用 mock fetch，不会实际请求外网。