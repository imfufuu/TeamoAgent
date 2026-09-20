# ◐ TeamoAgent — 基于 TeamoRouter 的网页端智能体

黑白极简 UI · 模型自选 · 代码沙箱（JS/Python/C++）· 多会话记录（导出/导入 JSON）· 对话回滚 · 附件 · LaTeX 公式渲染（KaTeX）· 账户余额与输出用时 · 18 个子智能体 · 全模型思考模式 · 成熟 Agent 架构（工具调用循环）。

布局：侧栏与沙箱面板均可收起——宽屏并入网格（永不遮挡内容），窄屏抽屉/浮层 + 遮罩；「↓ 最新输出」按钮在向上滚动时浮现。侧栏为会话记录列表（切换/删除/新建），复制与回滚按钮每轮只在回合末尾出现一次。余额读取 `GET /api/user/self`（兼容 new-api 系 quota 单位，500000 quota = $1）。

## 快速开始

```bash
cd TeamoAgent
python3 server.py                  # 默认 http://localhost:8787（仅绑定 127.0.0.1）
python3 server.py --host 0.0.0.0   # 需要局域网访问时才显式放开（代理通道无鉴权）
```

打开页面 → 填入 TeamoRouter API Key（`sk-teamo-` 开头，[控制台创建](https://teamorouter.com/dashboard?tab=api-keys)）→ 选择模型 → 开始对话。
Key 仅存于浏览器 localStorage，随请求头直发网关。

## TeamoRouter API 调研结论（2026-09，实测验证）

来源：`https://teamorouter.com/docs/api-integration` + 对 `api.teamorouter.com` 的实测。

| 项目 | 结论 |
|---|---|
| Base URL | `https://api.teamorouter.com` |
| 认证 | API Key `sk-teamo-*`；**Anthropic 协议用 `x-api-key` + `anthropic-version: 2023-06-01`；OpenAI/Gemini 协议用 `Authorization: Bearer`** |
| Anthropic 原生 | `POST /v1/messages`（Claude 模型必须走此协议，否则丢失 prompt cache / thinking，成本更高） |
| OpenAI 兼容 | `POST /v1/chat/completions`，全模型可用；标准 SSE，`data: [DONE]` 结尾 |
| Responses API | `POST /v1/responses`，仅 GPT 系列（Claude/Gemini 返回 400） |
| Gemini 原生 | `POST /v1beta/models/{model}:generateContent`（流式加 `:streamGenerateContent?alt=sse`） |
| 模型列表 | `GET /v1/models`（需鉴权，401 时本项目回退内置列表） |
| 文生图 | `POST /v1/images/generations`（`Authorization: Bearer`）；body `{model, prompt, size, quality, output_format, background, n…}`；结果在 `data[i].b64_json`（`n>1` 时数组多于一项）；官方建议超时 300s（实测 30–90s） |
| 图片编辑 | `POST /v1/images/edits`（`multipart/form-data`：`model` + `image`（多张用 `image[]`）+ `prompt`，可选 `mask`/`size`/`quality`/`input_fidelity`） |
| Fast mode | 请求体加 `"service_tier": "fast"`，仅 GPT 系列，2x 计费（旧值 `priority` 仍兼容） |
| 流式事件 | Anthropic：`message_start → content_block_start → content_block_delta → content_block_stop → message_delta → message_stop` |
| CORS | **实测返回 `Access-Control-Allow-Origin: *`** → 浏览器可直连；本项目仍内置服务端代理兜底 |
| 超时 | 服务器最长支持 600s 响应；大模型首 token 可能需数十秒，务必 `stream: true` |
| 错误格式 | `{"error":{"message","type","code"},"trace_id"}`，401 区分 `missing_auth_credential` / `invalid_api_key` |

## 附件支持

- **入口**：输入框 📎 按钮 / 拖拽到聊天区 / 直接粘贴（截图可用）
- **图片**（png/jpg/gif/webp ≤5MB）：多模态直传 —— OpenAI 协议走 `image_url`(data URL)，Anthropic 协议走 `image.source.base64` 原生块；需所选模型支持视觉（Claude/GPT/Gemini/deepseek-vision 等），气泡内缩略图可点开
- **文本/代码文件**（≤512KB，30+ 扩展名）：正文随消息注入，同时**自动写入沙箱 `uploads/` 目录**，Agent 可用 read_file 或沙箱代码处理全文
- **全部附件（图片 + 文本）都会自动复制到沙箱 `uploads/`**：图片以 data URL 存放，Agent 可把它作为 `generate_image` 的 `reference_paths` 直接改图；文件面板可逐个下载或整包导出 ZIP
- 同名再传：内容相同复用原路径，内容不同自动追加 `-2`/`-3` 序号，不覆盖上一轮
- 单条最多 6 个附件；localStorage 超 4MB 自动剥离图片数据并标记「已省略」（后续请求发送省略说明，不破坏协议）

## Agent 架构

```
用户输入
  │
  ▼
agent.js  ── ReAct 式工具调用循环（上限 8 轮）
  │    ⓪ 上下文管理（context.js）：按模型预算压缩历史（整轮丢弃防孤儿 tool 消息）
  │       + 工具结果截断（8k）+ 参数 JSON 解析失败自动反馈纠错 + 流层早期失败重试
  │    ① 构建协议请求体（api.js: buildAnthropicPayload / buildOpenAIMessages，含多模态附件块）
  │    ② 协议路由：claude-* → /v1/messages（x-api-key）
  │                 其余    → /v1/chat/completions（Bearer, 可带 service_tier=fast）
  │    ③ 流式解析：createSSEParser → createAnthropicStream / createOpenAIStream
  │       归一化事件 {text | reasoning | tool_delta | usage | finish}
  │    ④ 工具分片累积（OpenAI index 对齐 / Anthropic input_json_delta 拼接）
  │    ⑤ 有 tool_calls → tools.js 执行 → 结果以 tool 消息回填 → 回到 ①
  │       无 tool_calls → 回合结束
  ▼
state.js  检查点快照（每轮 user 消息前）→ 支持回滚 / 一步撤销 / 重新生成
sandbox.js Web Worker 沙箱（JS 8s / Pyodide Python 60s 超时强杀）+ 虚拟文件系统
ui.js     渲染 / 动画 / 回滚交互 / 沙箱面板
```

**工具集**：`execute_javascript`（Worker 隔离 + console 捕获 + files 快照）、`execute_python`（Pyodide WASM 常驻 Worker，运行时只加载一次；经典 Worker 中必须显式传 `indexURL`）、`execute_cpp`（Compiler Explorer 公共 API 远程编译执行，g++ -O2 -std=c++20，请求需 `compilerOptions.executorRequest: true`，编译器按 `semver` 字段选择——ID 数字大小≠版本）、`write_file` / `read_file` / `list_files`（虚拟 FS，随会话持久化）、`get_current_time`、`dispatch_subagent`（子智能体委派）。

## 子智能体（18 个专家，`dispatch_subagent` 委派）

主 Agent 按需把专业任务委派给子智能体——**同模型、专属系统提示词、工具子集、独立上下文**（看不到会话历史，task 必须自包含；不可再委派，防递归；内部循环上限 4 轮）。面板「子智能体」页可查看名录。

| 分类 | 子智能体 |
|---|---|
| 代码 | code-reviewer 审查 · debugger 调试 · refactor-expert 重构 · test-engineer 测试 · perf-optimizer 性能 · security-auditor 安全审计 |
| 设计 | software-architect 架构 · api-designer API 设计 · prompt-engineer 提示词 |
| 数据 | data-analyst 数据分析 · mathematician 数学 · sql-expert SQL · regex-expert 正则 |
| 内容 | doc-writer 文档 · translator 翻译 · copywriter 文案 · explainer 讲解 · brainstormer 头脑风暴 |

## 思考模式（默认开启）

顶栏 🧠 开关；按模型家族自动映射到各自协议的思考参数，模型不支持（400）时**自动降级重试并记住**：

| 模型家族 | 思考参数 |
|---|---|
| Claude | `thinking: {type:"enabled", budget_tokens:4096}`（max_tokens 自动升至 16384） |
| GPT / Gemini / Grok | `reasoning_effort: "medium"` |
| DeepSeek | `reasoning: true` |
| GLM | `thinking: {type:"enabled"}` |

思考流（Anthropic `thinking_delta` / OpenAI 兼容 `reasoning_content`）渲染为可折叠「思考过程」。

**思考 × 工具调用共存**：Anthropic 协议要求开启思考时，含 `tool_use` 的 assistant 回合在后续请求中必须回传 `thinking`/`redacted_thinking` 块（连同 `signature`）。本项目在流内捕获这些块（`signature_delta`），随消息持久化，并在下一轮 payload 中原序重放——思考模式与工具循环可同时开启；若某模型确实不支持思考参数（400），去掉参数重试一次并 toast 提示（不再静默关闭）。

## 图像能力（文生图 / 图片编辑 / 图生文）

- **图生文（识图）**：所选模型支持视觉时，附件图片按各协议原生多模态块发送（OpenAI `image_url`、Anthropic `image.source.base64`）；模型菜单里带「眼睛」徽标的即支持。
- **文生图 / 图片编辑不作为对话模型直接调用**：`gpt-image-2`、`gpt-image-2.5-sunburst`、`gpt-image-2.5-flare` 不出现在模型下拉里（直接选中会绕过工具循环、破坏 Agent 特性）。改由主智能体通过 **`generate_image` 工具**发起：
  - 无参考图 → `POST /v1/images/generations`；带 `reference_paths`（如 `uploads/cat.png`）→ `POST /v1/images/edits`（multipart）。
  - 出图写回沙箱 `outputs/image-00N.png`，对话中的工具芯片直接显示图片并可下载；`size`/`quality`/`output_format` 与「本次用哪个生图模型」都由工具参数控制。
  - 生图默认模型在模型菜单底部的「生图模型 · Agent 调用」行选择，**按会话记忆**。
- **模型 ID 归一（线上 400 的修复）**：对话模型常把显示名当 ID 传参（如 `model="2.5 Sunburst"`），网关会直接 `400 模型 '2.5 Sunburst' 暂不可用`。现在工具 Schema 用 `enum` 限定为真实 ID，`resolveImageModel()` 兼容 `2.5 Sunburst` / `GPT Image 2.5 Flare` / `flare` 等别名并自动纠正，纠正结果回灌给模型避免重复犯错；完全无法识别的名字退回会话选定的模型，绝不把垃圾字符串发给网关。
- **失败可读**：不再把任何异常都写成「缺少 data[0]」。区分「HTTP 200 + `error`/`message`」「200 但 `data` 为空数组」「非 JSON 响应体（带 HTTP 码、Content-Type、字节数与原文片段）」「`data` 字段缺失」；上游类错误自动补一次重试（3s），4xx 参数/模型类错误不重放。
- **输出真实化**：`sniffImage()` 直接解析 PNG/JPEG/GIF/WebP 头部拿到真实宽高与格式——网关偶尔无视 `output_format` 返回 PNG，此时扩展名会自动纠正；`n>1` 的多张候选全部写入沙箱，不再只取第一张。
- **连接反馈**：请求发出到首字返回之间为「连接模型中」状态——状态点脉冲+光环、三点跳动、实时秒数、顶栏不确定进度条，气泡内显示「正在连接 <模型>，等待首个响应…」，收到首个 token 自动切到「生成中」。
- **沙箱导出**：文件面板「⬇ ZIP」打包整个虚拟文件系统（图片按原始二进制还原 + 自动补扩展名，单文件行内 ⬇ 可单独下载）；ZIP 由 `js/zip.js` 手写 STORE 容器生成，零依赖。
- **会话级模型**：模型与生图模型都属于会话属性，切换会话自动恢复各自的选择；每条 assistant 消息记录当轮实际使用的模型，回看时头部按消息显示，不会被当前选择覆盖。

## 图标来源与版权

供应商 Logo 为各公司商标，SVG 下载自 Wikimedia（仅用于识别对应服务）：`Anthropic`=Claude AI symbol.svg · `OpenAI`=OpenAI logo 2025 (symbol).svg · `Google`=Google Gemini icon 2025.svg · `DeepSeek`=DeepSeek-icon.svg · `GLM`=Z.ai (company logo).svg · `Kimi`=kimi.svg（由用户提供的官方 Logo 精简：保留黑底 + 白色 K 字形 + 品牌蓝 `#1783FF` 折角，剔除 2691 条在黑色底上不可见的矢量描摹噪声路径，1.0MB → 1.7KB） · `Grok`=Grok-icon.svg（白色图标，亮色主题自动反色）。纯黑 Logo 在暗色主题下 CSS 反色；加载失败自动降级为首字母徽章。

**容错**：429/5xx 指数退避重试一次；HTTP 错误映射中文提示（401 查 Key / 402 充值 / 404 模型名）；直连失败自动切换 `/api/proxy` 中继并回放请求；中断按钮随时终止流。

## 目录

```
index.html        页面骨架
css/styles.css    黑白设计系统（明暗双主题，CSS 变量 + 平滑过渡）
js/config.js      端点 / 协议路由 / 兜底模型表 / 系统提示词
js/api.js         TeamoRouter 客户端（SSE 解析、双协议、重试、代理兜底）
js/sandbox.js     Worker 沙箱 + Pyodide + 虚拟文件系统
js/tools.js       工具定义与执行调度（含 generate_image：文生图 / 图片编辑）
js/zip.js         零依赖 ZIP 打包（STORE + CRC32），供沙箱整包下载
js/agent.js       工具调用循环状态机
js/state.js       多会话记录 / 消息 / 检查点回滚 / localStorage 持久化（v1 数据自动迁移）
js/ui.js          渲染与交互
server.py         静态服务 + 流式 API 代理（兜底通道；默认仅绑定 127.0.0.1）
tests/            node tests/agent.test.mjs（74 项：双协议解析 / 上下文压缩不变量 / 回滚持久化 /
                  Markdown·KaTeX 渲染 / Agent 工具循环 mock SSE 端到端（含思考块回传回归）/
                  生图与改图两条链路 / 附件落 uploads/ / 会话级模型 / ZIP 结构自洽）
```

真实网关系统测试（会实际调用 `/v1/images/*` 并产生费用，默认跳过）：

```bash
TEAMO_API_KEY=sk-teamo-xxx node tests/live-check.mjs
```

覆盖：三个生图模型逐个出图、显示名 `2.5 Sunburst` 纠正后成功、非法名退回会话模型、
`reference_paths` 图片编辑、`n=2` 多张落盘、webp/透明底魔数校验、错误文案含上游原文、
以及一次完整的 Agent 工具循环（`claude-sonnet-5` 自己按 enum 传真实 ID）。产物与
`report.json` 输出到 `/tmp/teamo-live`（可用 `TEAMO_LIVE_OUT` 覆盖）。

可选的 DOM 冒烟测试（真实挂载 UI，需 `npm i -D jsdom`；未安装时自动跳过，CI 不依赖）：

```bash
node tests/dom-smoke.mjs
```

## 部署

### 在线版（GitHub Pages）

**https://imfufuu.github.io/TeamoAgent/** —— 纯静态部署，浏览器直连 `api.teamorouter.com`（网关已放行 CORS）。
Python 沙箱首次使用需从 CDN 加载 Pyodide 运行时；本地代理（server.py）在 Pages 上不存在，但不影响直连模式。

### 发布到 GitHub Pages 的步骤

本项目是零构建静态站点。仓库已内置 `.github/workflows/pages.yml`（Actions 部署），
推送到 `main` 或工作分支即自动发布，无需手动配置，也不必等合并。
若想改用「Deploy from a branch」：

1. 推送代码到仓库（`index.html` 位于仓库根目录）
2. 打开仓库 **Settings → Pages**
3. **Source** 选 `Deploy from a branch`；**Branch** 选 `main`，目录选 `/ (root)`，保存
4. 1~2 分钟后站点上线于 `https://<用户名>.github.io/<仓库名>/`

也可用 API 一步开启：

```bash
curl -X POST -H "Authorization: Bearer <你的token>" \
  https://api.github.com/repos/<用户名>/<仓库名>/pages \
  -d '{"source":{"branch":"main","path":"/"},"build_type":"legacy"}'
```

注意：应用内全部使用相对路径（css/js/worker），因此部署在子路径（`/<仓库名>/`）下无需任何改动。

### 本地运行

```bash
python3 server.py    # http://localhost:8787，含 API 代理兜底通道
```

## 说明

- 浏览器直连时 Key 出现在前端，仅适合个人本地使用；生产环境请改为服务端持有 Key。
- JS/Python 沙箱为浏览器内隔离（Worker 无 DOM；Pyodide 为 WASM），非容器级安全边界；C++ 通过 Compiler Explorer 公共服务**远程**执行（代码会发送至 godbolt.org）。
- 页面启用了 CSP（`index.html` meta）：脚本仅放行同源与 Pyodide CDN，连接仅放行网关 / godbolt / CDN / 本站代理；渲染层本身也经注入探针验证（详见 `ANALYSIS.md`）。
- 本地服务器默认仅监听 `127.0.0.1`（代理通道无鉴权，`--host 0.0.0.0` 显式开放需自担风险）。

## 许可

MIT（见 [LICENSE](./LICENSE)）；打包与运行时第三方组件的许可见 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)。
