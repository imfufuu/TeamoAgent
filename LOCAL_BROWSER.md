# 本地沙箱网页与真实 Chromium

构建 `2026.10.10.1`。只运行 Agent 在会话沙箱中创建的项目，不接受公网 URL，不使用 Cloudflare 或第三方网页截图服务。

## 安装与启动

推荐 Node.js 22+、Python 3；Node.js 20.20 亦已本地验证。Playwright SDK 是锁定的可选依赖；setup:browser 会先 npm ci，再安装浏览器二进制。

```bash
npm ci
npm run setup:browser
python3 server.py
```

打开 **http://127.0.0.1:8787/app.html**，开启「沙箱」，再让 Agent 创建网页并运行/截图。不要在 GitHub Pages 页面里等待此能力出现：Pages 是静态托管，不能启动本机 Chromium，也不会跨源连接 localhost。

Linux 如果健康探测报告缺少系统库：

```bash
npx playwright install --with-deps chromium
```

OS 沙箱默认开启；健康探测会实际启动 Chromium，不能启动就报告不可用，**不会静默改用无沙箱模式或公网截图**。`DUBHE_BROWSER_NO_SANDBOX=1` 只供你明确可信的隔离测试环境使用，不建议用于日常服务。

## 运行什么

- 静态或已经构建完成的 HTML/CSS/JavaScript、ES Modules、项目内图片和字体。
- 默认项目根目录是 HTML 入口所在目录；建议单独使用 `site/`，避免把无关上传件混进项目。
- 资源使用相对路径，例如 `./style.css`、`./app.js`。构建工具需要配置相对资源基址；不会自动下载公网 CDN 资源。
- 这是 VFS 快照的静态服务，**不是 npm、Vite 开发服务器、Node 后端或完整容器**。没有任意 shell 命令、宿主文件挂载或外部 URL 导航参数。
- 每个项目最多 **512 个文件、解码后 8MB**，最多 **3 个会话**；闲置 30 分钟的会话在下一次操作时释放。`stop` 立即移除对应项目资源和 Chromium context；关闭服务释放全部 context。

## Agent 工具

`browser_sandbox` 只在本地服务健康探测成功、且「沙箱」打开时下发；它与「联网」开关及 Cloudflare Worker 无关。

1. 用 `write_file` 创建 `site/index.html` 及其 CSS/JS/图片。
2. `{"action":"start","entry":"site/index.html"}` 返回 `preview_id`、页面文本、交互元素、控制台与错误。
3. 持续使用同一个 `preview_id`：
   - `inspect`：页面概要、控制台、错误。
   - `click`：CSS `selector`。
   - `fill`：CSS `selector` 和 `text`。
   - `evaluate`：浏览器上下文 JavaScript **表达式**；多条语句请写 IIFE。返回值序列化 JSON 最多 65536 个字符。
   - `screenshot`：当前页面真实 PNG，保存到 `outputs/*.png`；可传 `width`/`height`、`full_page` 或元素 `selector`。
   - `reload`：传原 `entry` 同步当前 VFS 文件快照并重新加载；不传 `entry` 只刷新已上传快照。
   - `stop`：释放该会话。
4. 截图可以 `analyze_image` 识读，回答用 `![网页](sandbox://outputs/xxx.png)` 展示。
5. 最终回答至少引用 HTML 入口及要交付的 PNG。入口的静态依赖，以及曾上传运行的项目快照文件，会一起提交到真实会话 FS；其他未引用的临时产物仍按原规则丢弃。

单张 PNG 最多 8MB；整页/元素截图有像素和尺寸上限。`selector` 最多 2000 字符、`expression` 最多 8000、`text` 最多 20000。长时间操作由服务端超时清理，客户端停止后不再接收或回填迟到输出。

## 文件面板

HTML 文件查看器的「运行网页」按钮打开隔离的交互 iframe，保留源码查看/下载。**此预览与 Agent 的无头 Chromium 调试页是两个独立 DOM 状态**：用户在 iframe 内点按钮不会自动改变 Agent 会话，Agent 应用 `click`/`fill` 操作自己的会话后再截图。关闭/切换查看器或收起面板会卸载 iframe 并释放对应会话。

## 安全边界

- 本地 API 默认只监听 loopback，并验证 Origin、Host、JSON Content-Type 和请求容量；拒绝 `url`/`host`/`port`/`base`/`command` 等输入。
- 项目文件来自内存 VFS，不读取宿主路径；拒绝路径穿越、隐藏/内部目录、原型键和无效二进制。
- Chromium context 相互独立，所有 HTTP 请求限于自己的项目路径；WebSocket 拦截、WebRTC/STUN 接口禁用，service worker/下载/popup 受限。源码/CSS/模块通过 opaque-origin CSP 和资产 CORS 运行，不能读取父应用 storage 或 API。
- 用户浏览器 iframe 通过 sandbox/CSP 隔离父应用并限制 HTTP 资源；不把它说成容器级网络隔离。真实截图来自上面的受控 Chromium，而不是 DOM 近似导出。
- **不是完整容器或恶意代码安全证明**。请不要暴露无鉴权 companion 到公网。`--host 0.0.0.0` 默认关闭原生浏览器能力；只有明确可信环境才可用 `--allow-browser`，`--no-browser` 则完全关闭。

## 流式界面契约

新消息保存正文/工具块的输出顺序；只合并相邻同类工具，不跨越正文或读改文件。「已停止」位于本轮最后输出之后，停止后丢弃待绘制旧帧及迟到工具事件。

参数在模型生成时逐块展示；半截文件内容是**编辑预览**，不是提前写进 FS。完整合法参数才执行；读取结果分块传送、JS/Python 控制台输出实时回传。预览每约 50ms 合并刷新，日志有独立容量上限。

已完成工具：本轮有任意 assistant 正文（包括前置正文）才自动折叠；完全纯工具轮保持展开。手动展开/折叠优先，并可在重绘后恢复。思考块及 tool 结果不算 assistant 正文。

旧消息缺少块内时序元数据时按旧字段顺序回放，不能凭空恢复当时未保存的 SSE 顺序。

## 验收

```bash
npm test                              # 全套；真实网关/Pyodide/Puppeteer 的依赖缺失会明确跳过
node tests/streaming-tools.mjs         # 时序/折叠/停止/参数/读取/Worker 输出
python3 tests/sandbox_server_checks.py # 项目、生命周期、HTTP/Origin/Host 护栏
node tests/sandbox-browser.mjs         # 真 Chromium：启动、交互、PNG、重载、隔离、面板关闭
```

CI 在独立步骤安装 Chromium 并执行最后一项。原有 Puppeteer 用例不被新功能代替；可选依赖未安装或二进制缺失会明示跳过，不冒充真实运行成功。
