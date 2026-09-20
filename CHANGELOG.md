# Changelog

本文件记录 TeamoAgent 的阶段性改进。评估依据与完整问题清单见 [ANALYSIS.md](./ANALYSIS.md)。

## [Unreleased] — 图像能力 + 体验修复（2026-09-20）

### 新增

- **GPT Image 2.5 系列**：`gpt-image-2.5-sunburst` / `gpt-image-2.5-flare` / `gpt-image-2` 收录进生图模型目录（`IMAGE_MODELS`），
  参数按官方文档实现：`size`（像素，16 倍数 / 最大边 ≤3840 / 长宽比 ≤3:1）、`quality`、`output_format`（png/jpeg/webp）。
- **`generate_image` Agent 工具**：无参考图走 `POST /v1/images/generations`；带 `reference_paths` 自动切到
  `POST /v1/images/edits`（multipart：`model` + `image`/`image[]` + `prompt`，字节从沙箱内 data URL 还原）。
  出图写回 `outputs/image-00N.png`，工具芯片内直接展示并给下载链接；超时 300s、可中断。
- **沙箱图片编辑闭环**：用户附件（含图片）统一复制到 `uploads/`，Agent 读得出、改得回、打包得走。
- **下载沙箱**：文件面板「⬇ ZIP」用零依赖的 `js/zip.js`（手写 STORE 容器 + CRC32，UTF-8 文件名）打包整个虚拟文件系统；
  单个文件也可下载，图片解码为原始二进制并自动补扩展名。
- **连接动画**：新增 `connecting` 状态（请求已发出、首字未到）——状态点脉冲+光环、三点跳动、实时秒数、
  顶栏不确定进度条、气泡内「正在连接 <模型>，等待首个响应…」；首字节到达即切「生成中」。
- **Kimi 品牌图标**：`assets/icons/kimi.svg`（用户提供 Logo 精简版），`kimi-*`/`moonshot-*` 模型自动归入 Kimi 分组。
- 模型目录对齐文档：补 `deepseek-v4-flash-vision-exp`（多模态），移除已下线的 `gemini-3.1-flash-lite-preview`。

### 修复

- **切换会话后模型名被当前选择覆盖**：`model` / `imageModel` 改为**会话级属性**（`newSession` 记录、`hydrate/commit` 双向同步），
  新会话继承当前选择、来回切换互不污染；每条 assistant 消息额外记录当轮实际使用的模型，
  消息头部按消息本身显示（历史回看不再张冠李戴）；导出/导入 JSON 一并携带模型。
- **生图模型不能作为对话模型使用的问题**：上一轮直接在下拉里放 `gpt-image-2` 会走 `/v1/chat/completions` 而报错；
  现从对话列表中隐藏（含网关 `/v1/models` 返回的图像模型），统一由工具循环调用。
- **localStorage 体积**：沙箱内 >64KB 的 data URL 文件在超限时随附件一起剥离持久化（内存与下载通道不受影响）。
- **测试时序**：持久化用例先排空上一用例遗留的 300ms 防抖定时器，消除「桩被串写」导致的偶发误判。
- 模型菜单层级：搜索框 `z-index` 显式高于分组标题，滚动时系列图标不再压到搜索框之上；生图模型行吸附菜单底部。

### 测试

- `tests/agent.test.mjs` 由 58 项增至 **74 项**：生图目录/工具注册、生成与编辑两条链路（含 multipart 字节还原校验）、
  data URL 与字节往返、附件落 `uploads/`（同名冲突与路径穿越防护）、会话级模型、ZIP 结构与 CRC 标准向量、持久化瘦身。
- ZIP 产物用 Python `zipfile` 交叉验证：`testzip()` 全通过，PNG 魔数与中文/空格文件名均正确。

## [Unreleased] — 第二轮改进（2026-09-19）

### 修复

- **P0-2 · Claude「思考 + 工具调用」共存**（原报告唯一遗留 P0）
  - Anthropic 流解析新增 `thinking` / `redacted_thinking` 块与 `signature_delta` 事件归一化。
  - 新增 `createThinkingTracker`：按流内顺序累积思考块（含签名），随 assistant 消息持久化。
  - `buildAnthropicPayload` 支持把思考块原序重放在 assistant content 最前面（先于 `tool_use`），
    修复「开思考 + 第一次工具调用后第二次请求必然 400」的问题。
  - 思考参数 400 降级改为「去掉参数重试 + 记录模型 + 向上层发 `onThinkingFallback` 回调」，
    前端 toast 提示，不再静默关闭思考模式；降级请求同时剥离历史思考块（API 语义要求）。
  - 顺带修复：流层早期失败重放时未重置已累积的 `reasoning` 与思考块（会产生重复内容）。
  - 顺带修复：`reader.cancel()` 的 rejected promise 未捕获，中断时产生未处理拒绝。
- **P1-3 · 持久化体积**：落盘前先做字符级体积预估，超限直接走瘦身序列化，
  不再「全量 stringify 带 base64 图片的巨型 state 后再扔掉」；
  修复 `slimState` 根级 `messages` 镜像引用未瘦身、4MB 限制形同虚设的漏洞。
- **P1-5 · 本地服务器默认绑定**：`server.py` 默认只监听 `127.0.0.1`；
  支持 `--host` / `--port`，向后兼容位置参数端口。代理通道无鉴权，暴露到局域网需显式 `--host 0.0.0.0`。

### 新增

- **P1-4 · CSP**：`index.html` 添加 `Content-Security-Policy` meta（script/style/img/font/connect/worker-src
  最小放行；含 `wasm-unsafe-eval` 供 Pyodide 使用；`object-src 'none'`、`base-uri`、`form-action` 收紧）。
- **P1-6 · 许可**：新增 `LICENSE`（MIT）与 `THIRD-PARTY-NOTICES.md`
  （markdown-it MIT / KaTeX MIT / Pyodide MPL-2.0 / 商标声明 / 供应链说明）。
- **P2-4 · Agent 工具循环端到端测试**（mock SSE，共 6 项）：
  工具调用回填、迭代上限停止、坏 JSON 参数反馈纠错、思考块回传（P0-2 回归）、
  思考参数 400 降级与通知、流式中断。测试总数 46 → 58。
- **P2-3 · 可访问性**：
  - API Key 弹窗：`role="dialog"` / `aria-modal` / `aria-labelledby`、Esc 关闭、点击遮罩关闭、
    Tab 焦点圈定、关闭后归还焦点。
  - 全部纯图标按钮补 `aria-label`（含动态会话删除按钮）。
  - CSS：`:focus-visible` 键盘焦点样式；`prefers-reduced-motion` 下停用全部无限循环动画。
  - 首次运行跟随系统 `prefers-color-scheme` 选择初始主题（之后以用户切换为准）。

### 移除

- **P2-2 · 死代码**：删除 `api.js` 的 `resetTransport` 与 `icons.js` 的 `APP_FAVICON` 死导出。

## 第一轮改进（2026-09-19，PR #1）

- **P0-1**：`compactMessages` 重写为预算驱动的分级压缩（快路径零截断 → 历史工具结果逐级收紧 →
  历史正文收紧 → 整轮丢弃 → 二分收缩兜底），修复工具结果被无条件截断到 ~1.5k 的问题。
- **P0-3**：`save(true)` 同步落盘路径；`beforeunload` / `visibilitychange` 使用同步版，
  修复关页面丢最后一轮对话。
- **P1-1**：单条巨型消息（粘贴大文件）不再绕过压缩（`fitBudget` 硬保证不超预算）。
- **P1-2**：沙箱执行进度（Pyodide 加载、C++ 远程编译、子智能体委派）回写工具芯片状态；删除 ~60 行死 CSS。
- 工程化：新增 CI（单测 + py/JS 语法检查）；README 修正测试数与目录名。
- 测试规模 40 → 46 项。
