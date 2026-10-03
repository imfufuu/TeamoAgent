# TeamoAgent Cloudflare Relay

免费跨域中继（fetch_url），基于 Cloudflare Workers，每天 10 万次免费请求。

## 一键部署（30 秒）

1. 注册 https://dash.cloudflare.com/ → Workers & Pages → **Create Worker**
2. 起名（例如 `teamo-relay`）→ 把 `worker.js` 内容整段粘贴进去 → **Deploy**
3. 得到地址 `https://teamo-relay.<你的子域>.workers.dev`

## 在 TeamoAgent 里启用

部署完后两种方式选其一：

**方式 A：Pages + Worker 路由绑定（推荐）**

如果前端也部署在 Cloudflare Pages 上，在 Pages 的 **Custom domains** / **Functions** 或用 Workers Routes 把 `/api/*` 指向这个 Worker——前端探测 `/api/health` 自动发现，无需改任何代码。

**方式 B：直接在前端设置公共 relay 地址**

打开 TeamoAgent，在 DevTools 控制台执行：
```js
localStorage.setItem('teamo-relay', 'https://teamo-relay-xxx.workers.dev'); location.reload();
```
前端启动时会优先用同源 `/api/*`，不通则按 `teamo-relay` localStorage → 内置默认顺序探测。

## 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | `{ok:true,relay:"teamo-cf-worker",version:"1.5"}` |
| GET | `/api/fetch?url=...&mode=text|raw&max=2000000` | 抓取公网 URL 正文（SSRF 护栏、4MB 上限、自动抽正文） |

返回字段与本地 `server.py` 的 `/api/fetch` 完全一致（`url/status/content_type/title/text/truncated/limit/chars`）。

## 本地调试

```bash
npx wrangler dev
```
