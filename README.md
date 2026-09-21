# ◐ TeamoAgent — 基于 TeamoRouter 的网页端智能体

黑白极简 UI · 模型自选 · 代码沙箱（JS/Python/C++）· 多会话记录（导出/导入 JSON）· 对话回滚 · 附件 · LaTeX 公式渲染（KaTeX）· 模型原生联网检索 · 输出用时与 token 统计 · 18 个子智能体 · 全模型思考模式 · 成熟 Agent 架构（工具调用循环）。

布局：侧栏与沙箱面板均可收起——宽屏并入网格（永不遮挡内容），窄屏抽屉/浮层 + 遮罩；「↓ 最新输出」按钮在向上滚动时浮现。侧栏为会话记录列表（切换/删除/新建），复制与回滚按钮每轮只在回合末尾出现一次，**「重新生成」只给最近一条回答**（覆盖式重生成，更早的先回滚再问）。顶栏只有「联网」「沙箱」两枚状态胶囊（不再显示账户余额）。移动端另有一层排布（胶囊横滑、触控 ≥40px、输入框 16px），见「移动端布局」一节。

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
| Fast mode | 请求体加 `"service_tier": "fast"`，仅 GPT 系列，2x 计费（旧值 `priority` 仍兼容）；顶栏「快速」按钮（线性闪电图标，与思考/沙箱同一 pill 风格）切换 |
| 流式事件 | Anthropic：`message_start → content_block_start → content_block_delta → content_block_stop → message_delta → message_stop` |
| CORS | **实测返回 `Access-Control-Allow-Origin: *`** → 浏览器可直连；本项目仍内置服务端代理兜底 |
| 超时 | 服务器最长支持 600s 响应；大模型首 token 可能需数十秒，务必 `stream: true` |
| 错误格式 | `{"error":{"message","type","code"},"trace_id"}`，401 区分 `missing_auth_credential` / `invalid_api_key` |

## 附件支持

- **入口**：输入框附件按钮 / 拖拽到聊天区 / 直接粘贴（截图可用）
- **发送即上屏**：按下 Enter 后自己的消息立刻渲染（含附件缩略图与「回滚」按钮），不需要等模型输出完或切换会话回来才看到
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
context.js    上下文预算与分级压缩（历史工具结果先收紧，本轮内容永远完整）
ui.js     渲染 / 动画 / 回滚交互 / 沙箱面板
```

**工具集**：`execute_javascript`（Worker 隔离 + console 捕获 + files 快照）、`execute_python`（Pyodide WASM 常驻 Worker，运行时只加载一次；经典 Worker 中必须显式传 `indexURL`）、`execute_cpp`（Compiler Explorer 公共 API 远程编译执行，g++ -O2 -std=c++20，请求需 `compilerOptions.executorRequest: true`，编译器按 `semver` 字段选择——ID 数字大小≠版本）、`write_file` / `read_file` / `list_files`（虚拟 FS，随会话持久化）、`get_current_time`、`dispatch_subagent`（子智能体委派）、
`fetch_url`（抓取网页正文，可自动落进虚拟文件系统）、`run_git`（在本地中继的 `workspace/` 内执行 git）。
联网检索**不是工具**：由模型 API 自带的网页搜索格式在模型服务端执行（见下一节）。

## 子智能体（18 个专家，`dispatch_subagent` 委派）

主 Agent 按需把专业任务委派给子智能体——**同模型、专属系统提示词、工具子集、独立上下文**（看不到会话历史，task 必须自包含；不可再委派，防递归；内部循环上限 4 轮）。面板「子智能体」页可查看名录。

- **自主触发**：系统提示词给了明确的触发条件（交付物含 ≥2 个专业维度、写完代码请 reviewer/debugger 复核、翻译与长文改写等脏活外包、需要真实计算时派分析师），用户不点名也会自己派。
- **并行委派**：互不依赖的子任务在同一轮里一次发多个 `dispatch_subagent`，运行时最多 3 个并发，结果按调用顺序回填对话。
- **与代码沙箱解耦**：顶栏「沙箱」只控制三个代码执行工具；关掉后文件读写、生图、子智能体委派照常用（子智能体能用的工具也按同一规则取交集）。

| 分类 | 子智能体 |
|---|---|
| 代码 | code-reviewer 审查 · debugger 调试 · refactor-expert 重构 · test-engineer 测试 · perf-optimizer 性能 · security-auditor 安全审计 |
| 设计 | software-architect 架构 · api-designer API 设计 · prompt-engineer 提示词 |
| 数据 | data-analyst 数据分析 · mathematician 数学 · sql-expert SQL · regex-expert 正则 |
| 内容 | doc-writer 文档 · translator 翻译 · copywriter 文案 · explainer 讲解 · brainstormer 头脑风暴 |

## 联网与抓取：模型原生检索 + 本地中继

**联网搜索只用模型 API 自带的请求格式，不接任何第三方搜索服务。** 顶栏「联网」胶囊（默认开启）打开后，
前端在**同一个**对话请求体里声明供应商的原生服务器工具，检索由模型服务端执行、结果与引用随流返回；
关掉开关或模型没有可用原生格式时，就完全不联网，并让模型明确说「当前未联网」而不是编一个「刚查到」。

下表是**拿真 key 打过网关**的结论（2026-09-21，回归测试在 `tests/live-web.mjs`），不是照文档抄的：

| 模型家族 | 原生格式（写在请求体里） | 走的端点 | 实测结果 |
| -------- | -------------------------- | -------- | -------- |
| Claude | `tools: [{type:"web_search_20250305", name:"web_search", max_uses:5}]` | `POST /v1/messages` | ✅ 真检索：`server_tool_use` → `web_search_tool_result`（含 title/url/page_age），引用走 `citations_delta` |
| GPT | `tools: [{type:"web_search", search_context_size:"medium"}]` + `include:["web_search_call.action.sources"]` | `POST /v1/responses`（网关仅 GPT 支持此端点） | ✅ 真检索：`web_search_call` + `action.sources`（一次问题可回十几到上百条 URL），引用走 `url_citation` 标注 |
| Kimi | `tools: [{type:"builtin_function", function:{name:"$web_search"}}]` | `POST /v1/chat/completions` | ❌ 网关收下但不执行，模型自述「我没有联网能力」 |
| GLM | `tools: [{type:"web_search"}]` | `POST /v1/chat/completions` | ❌ 上游直接 400 `upstream_error` |
| Grok | `search_parameters: {mode:"live"}` | `POST /v1/chat/completions` | ❌ 把工具调用当普通文本吐回来（XML 片段），不是检索 |
| Gemini | `tools: [{google_search:{}}]` | `POST /v1beta/models/{model}:generateContent` | ⚠️ 原生端点实测可用（`groundingMetadata.groundingChunks`），但需要另开一条原生 Gemini 协议通道，**本轮未接**；chat 协议里塞 `google_search` 会被网关 503 |
| 其余（DeepSeek 等） | 无原生格式 → **不联网** | 原端点，不塞任何联网字段 | — |

所以现在只有 Claude 与 GPT 会真的联网：**宁可少支持，也不给用户看「假装查过了」的来源条。**

- 能力表与请求/流转换都在 `js/websearch.js`；GPT 改道 `/v1/responses` 后被拒（400/404/422）会**自动退回**
  Chat Completions 并剥掉联网字段，同时 toast 告知并把该模型记入降级表（本会话不再白试一次）——
  见 `api.webFallbackFor(model)`。
- 实测坑位两条，已修并各有回归：① 网关 Anthropic 路由会把网页工具**混着两种块**发出来
  （`server_tool_use` 与名叫 `web_search`/`web_fetch` 的普通 `tool_use`）——后者若按客户端工具处理，
  主循环会去执行一个不存在的工具，所以统一按服务端工具处理、不进客户端累积器；
  ② 请求体里带 `"system": ""` 会让上游整段不返回 thinking 块，空 system 现在不发。
- **诚实性护栏**：真机实测发现模型有时**不搜索却在正文里声称「已联网查询」**，并给出凭记忆编的实时数字。
  两道防线：系统提示词要求「只有真的拿到检索结果才可以说联网，否则直说本论没能取得检索结果」；
  界面上若正文声称联网而这一轮没有任何检索事件，回答下方会显示「未见检索事件 —— 该说法无法证实，
  具体数字请另行核实」（`websearch.js` 的 `claimsWebSearch()`，含否定句豁免与正反例单测）。
- **模型「以为自己不能联网」**：能力表与提示词一度自相矛盾（旧句子「不要去找一个叫 web_search 的工具」
  被读成「你没有联网能力」），已改写并加守卫单测。真机复测还发现**上游模型只是随机不调用**服务器搜索
  （同提示词同问题的 4 次对照里只有 2 次真检索，`tool_choice` 强制也被网关忽略）——这种情况下界面会显示
  中性提示条「联网开关是开着的，但本轮没有发生检索 …… 可以在提问里写明『先联网检索再回答』，或换个模型重问一次」
  （`websearch.js#webRefusal()`，主语约束防误判），既不为模型背书、也不让用户以为功能坏了。
- **一键重试（提示条上的按钮）**：真机对照里同一句提问加「先联网检索再回答」前缀后明显更容易触发检索，
  所以提示条带一枚按钮，点一下就把原提问改写成带前缀的版本并**覆盖式重试**（抹掉没检索到的回答再重发），
  免得用户自己重打。
- **工具表随中继状态收敛**：`fetch_url` / `run_git` 只在中继可用时进请求；`js/main.js` 启动探一次
  `/api/health` 写 `store.state.relayOk`，不可用时提示词补一段说明，避免模型反复够一个必然失败的工具。
- 上游检索偶发不可用（Anthropic 会明确回 `web_search_tool_result_error{error_code:"unavailable"}`），
  此时如实显示「联网检索未成功」并给出建议，而不是显示「服务端检索到 0 条来源」。
- 模型返回的查询词与来源渲染成回答下方的「联网 · 服务端检索到 N 条来源」条（链接 `rel="noopener"`），
  随消息一起持久化，切会话/重开页面仍在。
- **不做**的事：不在浏览器里打 DuckDuckGo/Brave/Tavily/Serper，不用 `r.jina.ai` 之类的第三方抽取器，
  也不为搜索单独配 key（历史上的 `TEAMO_*_KEY` 已随之删除）。

`fetch_url`（抓取指定 URL）与 `run_git` 则需要本地中继 `server.py`：浏览器受同源与 CSP 限制抓不了任意站点，
所以这两个工具是「中继优先」——中继不在就返回可读原因 + 修复步骤，绝不返回编造内容。

```bash
python3 server.py 8787                 # 默认开启 git（只在 ./workspace 里跑）
python3 server.py --no-git             # 只留抓取
python3 server.py --workspace ~/code   # 换工作区（git 的根，越界一律拒绝）
```

中继端点：`GET /api/health`（前端据此决定是否可用）、`GET /api/fetch?url=&mode=text|raw&max=`、
`POST /api/git {command,repo,timeout}`。**没有 `/api/search`**：联网属于模型服务端。

安全边界（`tests/server_checks.py` 51 项护栏自检覆盖）：

- 子命令白名单 + 参数黑名单（`-c/--git-dir/--work-tree/--upload-pack/--ext::/…`），
  `GIT_CEILING_DIRECTORIES` 把仓库定位钉死在 `workspace/` 内，`GIT_TERMINAL_PROMPT=0` 不弹账号密码；
  `config` 只允许白名单里的本仓库键，`--global/--file/alias.*` 一律拒绝；
- `/api/fetch` 与 `/api/git` 的 URL 都过 `guard_public_http_url`：只允许公网 http(s)，
  loopback / 私网 / 链路本地（含 `169.254.169.254`）直接拒，防中继当 SSRF 跳板；
- 抓取上限 4 MB（`max` 可再调小），返回文本按 `max_bytes` 截断，`fetch_url` 超过 2000 字符时把全文
  写进 `web/<host>/<slug>.md`（或模型指定的 `save_path`），对话里只给 6000 字符预览 + 落盘路径。

`workspace/` 已进 `.gitignore`：Agent 在里面 clone / 改文件不会污染本项目仓库。

## 会话记录（自动标题 / 手动改名 / 一键清空）

- **第一条消息发出后才入列**：`store.listableSessions()` 只列有消息的会话；反复点「＋ 新建」会复用
  当前空草稿（`ensureDraft()`），不会在 localStorage 里堆一串看不见的空会话。
- **标题由 Agent 总结**：回合结束后 `js/titler.js` 发一次独立的小调用（不带对话历史与工具）起标题，
  总结期间先用「首条消息截断」兜底。每会话只尝试一次（`titled` 标记），失败也标记，避免每轮重复消耗 token。
- **用户手改优先**：侧栏 ✎（或双击标题）就地改名 → `titleSource='user'`，自动总结此后不再覆盖。
- **一键清空**：侧栏「清空」按钮删除全部会话（消息 / 检查点 / 各自的文件系统），带确认框，返回被删条数。
- **操作条只在输出结束后出现**：复制 / 回滚 / 重新生成在流式与工具执行期间整体隐藏
  （`.msg.actions-pending`），本轮末尾的 assistant 与对应 user 消息各显示一次；三个按钮统一 SVG + 中文。

## 思考模式（默认开启）

顶栏「思考」开关（线性 SVG 图标）；按模型家族自动映射到各自协议的思考参数，模型不支持（400）时**自动降级重试并记住**：

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
- **文件面板 = 目录树**：沙箱是「路径即结构」的扁平字典，UI 用 `js/filetree.js`（纯函数）把它还原成可折叠的目录树 —— 目录行显示文件夹图标、缩进（`--d` 驱动）、汇总的文件数与体积，点一下折叠/展开（键盘 Enter/Space 可用），工具栏右侧给出「N 个文件 · M 个目录 · 体积」摘要；同级目录在前、名称按自然数序（`image-2` 排在 `image-10` 前）。
- **沙箱导出**：工具栏「ZIP」打包整个虚拟文件系统（保留 `uploads/`、`outputs/` 目录结构），每个目录行还有独立的「ZIP」按钮只打包该目录（含子目录），文件行内下载按钮取单文件；图片按原始二进制还原 + 自动补扩展名。ZIP 由 `js/zip.js` 手写 STORE 容器生成，零依赖。
- **图片体积按真实字节算**：data URL 字符串比二进制长 ~1/3，列表与芯片都按 base64 反推字节显示，避免 `1.4 MB` 被标成 `1.9 MB`。
- **空状态示例**：`js/suggestions.js` 维护 18 条任务示例（沙箱 / 生图改图 / 目录与打包 / 子智能体 / 多模型对比 / 回滚与上下文），每次渲染随机抽 3 条且标签互不相同，另有「换一批」；点卡片按 `data-prompt` 回填输入框，不受标签文字污染。
- **会话级模型**：模型与生图模型都属于会话属性，切换会话自动恢复各自的选择；每条 assistant 消息记录当轮实际使用的模型，回看时头部按消息显示，不会被当前选择覆盖。

## 图标来源与版权

供应商 Logo 为各公司商标，SVG 下载自 Wikimedia（仅用于识别对应服务）：`Anthropic`=Claude AI symbol.svg · `OpenAI`=OpenAI logo 2025 (symbol).svg · `Google`=Google Gemini icon 2025.svg · `DeepSeek`=DeepSeek-icon.svg · `GLM`=Z.ai (company logo).svg · `Kimi`=kimi.svg（由用户提供的官方 Logo 精简：保留黑底 + 白色 K 字形 + 品牌蓝 `#1783FF` 折角，剔除 2691 条在黑色底上不可见的矢量描摹噪声路径，1.0MB → 1.7KB） · `Grok`=Grok-icon.svg（白色图标，亮色主题自动反色）。纯黑 Logo 在暗色主题下 CSS 反色；加载失败自动降级为首字母徽章。

**容错**：429/5xx 指数退避重试一次；HTTP 错误映射中文提示（401 查 Key / 402 充值 / 404 模型名）；直连失败自动切换 `/api/proxy` 中继并回放请求；中断按钮随时终止流。

**视图层故障隔离**：Agent 的所有 UI 回调都经 `emit()` 分发（钩子缺失或抛错只 `console.warn`），
因为 GitHub Pages 对静态资源有 ~10 分钟缓存，浏览器完全可能拿到「新 main.js + 旧 ui.js」的混版组合；
这类组合最多让界面退回旧交互，**不允许**把整轮对话 brick 掉（曾有真实故障：旧 `ui.js` 没有 `onUserMessage`，
直调抛 `TypeError` 冒泡到 `send()`，表现为「发了提示词界面毫无反应」）。
入口资源（`css/styles.css`、`js/main.js`）统一带 `?v=APP_VERSION`，侧栏底部显示 `v<版本>` 便于自检；
`APP_VERSION` 与 index.html 的 `?v=` 由单测强制同步。

同一条纪律也约束模块边界：**不往已有模块加「被别的模块 import 的新具名导出」**。ESM 的具名导入在
link 期解析，混版时旧模块没有那个导出 → 整张模块图报错、页面白屏，比钩子缺失更严重。所以
`agent.js` 要按沙箱开关过滤工具时，是在本地用新旧两版都存在的 `TOOL_DEFS` 过滤，而不是
`import { toolsFor } from './tools.js'`；两处清单的一致性由单测钉住。

## 目录

```
index.html        页面骨架
css/styles.css    黑白设计系统（明暗双主题，CSS 变量 + 平滑过渡）
js/config.js      端点 / 协议路由 / 兜底模型表 / 系统提示词
js/api.js         TeamoRouter 客户端（SSE 解析、双协议、重试、代理兜底）
js/sandbox.js     Worker 沙箱 + Pyodide + 虚拟文件系统
js/tools.js       工具定义与执行调度（含 generate_image：文生图 / 图片编辑）
js/net.js         抓取 / git 的中继调用与 HTML→文本纯函数（webSearch 只剩一枚说明性兼容桩）
js/websearch.js   联网：各模型家族的原生网页搜索请求格式、Responses 请求体/流转换、能力表
js/titler.js      会话标题自动总结（独立小调用，不写进对话历史；新模块避免混版缓存的 link 期白屏）
js/zip.js         零依赖 ZIP 打包（STORE + CRC32），供沙箱整包 / 单目录下载
js/filetree.js    路径 → 目录树的纯函数（层级还原、大小汇总、折叠展开）
js/config.js      常量与模型目录（含 APP_VERSION：入口资源 ?v= 的单一真源）
js/suggestions.js 空状态任务示例池 + 随机抽取（纯函数，可单测）
js/icons.js       供应商品牌 Logo + 界面线性图标（currentColor，随主题反色）
js/agent.js       工具调用循环状态机
js/state.js       多会话记录 / 消息 / 检查点回滚 / localStorage 持久化（v1 数据自动迁移）
js/ui.js          渲染与交互
server.py         静态服务 + 流式 API 代理（兜底通道）+ /api/{health,search,fetch,git} 本地中继
                  （默认仅绑定 127.0.0.1；git 只在 ./workspace 内执行）
tests/            agent.test.mjs（156 项：双协议解析 / 上下文压缩不变量 / 回滚持久化 / 会话标题与清空 /
                  Markdown·KaTeX 渲染 / Agent 工具循环 mock SSE 端到端（含思考块回传、并发委派）/
                  生图与改图两条链路 / 附件落 uploads/ / 会话级模型 / ZIP 结构自洽 / 沙箱开关语义 /
                  服务端联网块不进客户端累积器 / 联网失败如实报错）
                  dom-smoke.mjs（156 项：入列时机 / 就地改名 / 一键清空 / 操作条显隐 / 面板两行布局 /
                  移动端布局源码护栏）
                  app-boot.mjs（66 项：真实入口整轮对话 + 重新生成覆盖 + 联网形状）
                  live-smoke.mjs / live-web.mjs（拿 key 打真网关：双协议 + 联网能力实测，无 key 自动跳过）
                  mobile-layout.mjs（真 Chrome 量移动端：320/360/390/414/768 无溢出、无重叠、触控 ≥36px；
                  npm run audit:mobile，需先 npm i puppeteer）
                  pyodide-worker.test.mjs（5 项）
                  server_checks.py（51 项：git 参数白名单 / SSRF / HTML 抽取护栏，纯 stdlib）
```

真实网关系统测试（会实际调用 `/v1/images/*` 并产生费用，默认跳过）：

```bash
npm run test:live     # = live-smoke（协议层）+ live-check（图像与工具循环），缺 key 自动跳过
```

覆盖：三个生图模型逐个出图、显示名 `2.5 Sunburst` 纠正后成功、非法名退回会话模型、
`reference_paths` 图片编辑、`n=2` 多张落盘、webp/透明底魔数校验、错误文案含上游原文、
以及一次完整的 Agent 工具循环（`claude-sonnet-5` 自己按 enum 传真实 ID）。产物与
`report.json` 输出到 `/tmp/teamo-live`（可用 `TEAMO_LIVE_OUT` 覆盖）。

五层离线测试（DOM / app-boot / pyodide 三层需相应 devDependency，未安装时自动跳过，CI 不依赖）：

```bash
npm test              # tests/agent.test.mjs：解析/状态机/纯函数（无 DOM）
npm run test:dom      # tests/dom-smoke.mjs ：挂载 UI 驱动交互路径
npm run test:app      # tests/app-boot.mjs  ：跑真实 js/main.js —— 弹窗填 Key → 选模型
                      #                       → 发送 → 工具调用 → 文件面板目录树 → 关沙箱后委派
npm run test:pyodide  # tests/pyodide-worker.test.mjs：Node 里用薄垫片直接跑真实 js/worker-py.js
                      # （npm i -D pyodide@0.26.4）：FILES 回写 / result 捕获 / 陈旧全局
npm run test:server   # tests/server_checks.py：中继护栏（git 白名单 / SSRF / HTML 抽取），纯 stdlib 无需 node
npm run test:live     # 真实网关：live-smoke + live-check + live-web（TEAMO_API_KEY=… 才跑，否则跳过）
npm run audit:mobile  # 真 Chrome 量移动端布局（需 puppeteer）：无横向溢出 / 无重叠 / 触控目标 ≥36px
npm run test:all      # 前四连（含 server_checks）
```

`test:app` 是唯一覆盖「入口装配 + hook 接线」的一层：混版缓存、hook 缺失这类故障在纯函数
单测与挂载冒烟里都不会露馅，只有从 `main.js` 开始跑才能抓到。

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

## 移动端布局（≤720px 单独一层，不是把桌面等比缩小）

窄屏曾有一个**布局根因 bug**：`@media (max-width: 860px)` 把侧栏、`760px` 把沙箱面板都改成
`position: fixed`，两者脱离网格后，`.main` 成为唯一在流的网格子项，被自动排进第一列
（`--sbw` 此时已收敛为 `0px`）→ **主区宽度 0**，所有内容横向溢出、挤成一团。现在三块用
`grid-template-areas: "side main panel"` 钉死在各自轨道上，无论谁变成浮层都不会串位。

在此之上是专门的一层排布（`css/styles.css` 的 `@media (max-width: 720px)` 与
`@media (hover: none), (max-width: 720px)`）：

- 顶栏胶囊**一行横滑**（`overflow-x: auto` + `flex-wrap: nowrap`），状态文字可省略号截断，
  小屏再让一步：≤380px 只留中文文字、隐藏图标；
- 消息区左右留白收到 14px，模型名/用量分行，操作条换行；
- 所有可点元素 ≥40px（`.act` / `.pill` / `.mini-btn` / `.icon-btn` → 触屏设备一律生效，平板也算）；
- 输入框字号 **16px**（低于它 iOS 会在聚焦时放大整页）、输入区贴 `env(safe-area-inset-bottom)`、
  「定位到最新输出」上移避开输入区；
- 长链接、代码块、表格各自横向滚动，正文不撑宽页面。

这些不是「凭感觉调的」：`tests/mobile-layout.mjs` 用真实 Chromium 在 320/360/390/414/768 宽度下
量 **横向溢出 / 区域重叠 / 触控目标尺寸 / 面板是否越界**（桩网关先灌一整段带工具芯片与联网来源条的
对话），`npm run audit:mobile` 一条命令跑完；也可以加 `TEAMO_AUDIT_URL=https://imfufuu.github.io/TeamoAgent/`
直接量线上站点。

## 说明

- 浏览器直连时 Key 出现在前端，仅适合个人本地使用；生产环境请改为服务端持有 Key。
- 顶栏「沙箱」开关只决定三个代码执行工具是否下发（文件读写/生图/委派不受影响）；无鉴权中继 `server.py` 因此同源使用，不要暴露到共享网络。
- JS/Python 沙箱为浏览器内隔离（Worker 无 DOM；Pyodide 为 WASM），非容器级安全边界；C++ 通过 Compiler Explorer 公共服务**远程**执行（代码会发送至 godbolt.org）。
- 页面启用了 CSP（`index.html` meta）：脚本仅放行同源与 Pyodide CDN，连接仅放行网关 / godbolt / CDN / 本站代理；渲染层本身也经注入探针验证（详见 `ANALYSIS.md`）。
- 本地服务器默认仅监听 `127.0.0.1`（代理通道无鉴权，`--host 0.0.0.0` 显式开放需自担风险）。

## 许可

MIT（见 [LICENSE](./LICENSE)）；打包与运行时第三方组件的许可见 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)。
