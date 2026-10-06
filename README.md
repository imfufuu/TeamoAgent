# ◐ Dubhe Agent — 基于 TeamoRouter 的网页端智能体

> **Dubhe Agent V1.7** · 构建 `2026.10.5.17` · [线上介绍](https://imfufuu.github.io/dubhe-agent/) · 对话 [app.html](./app.html) · [CHANGELOG](./CHANGELOG.md)

## TL;DR

浏览器里的智能体：填入 TeamoRouter Key，选一个模型，就可以写文件、跑 JS/Python/C++、生图识图、委派子智能体。

- 最快路径：打开线上介绍页进入对话，或本仓库 `python3 server.py` 后打开本地页
- Key 只存在本机 localStorage，请求直发网关
- 网页检索走显式工具：本地 `server.py` 提供单页 `fetch_url`，新版 Cloudflare Worker 另提供 `search_web` 与同源 `crawl_site`；不向模型请求注入原生网页搜索字段，Worker 能力由 `/api/health` 探测
- 下面先「快速开始」。协议表和架构图是排错用的，日常对话不必先读完

## 快速开始

```bash
cd dubhe-agent
python3 server.py                  # 默认 http://localhost:8787（仅绑定 127.0.0.1）
python3 server.py --host 0.0.0.0   # 需要局域网访问时才显式放开（代理通道无鉴权）
```

打开页面 → 填入 TeamoRouter API Key（`sk-teamo-` 开头，[控制台创建](https://teamorouter.com/dashboard?tab=api-keys)）→ 选择模型 → 开始对话。
Key 仅存于浏览器 localStorage，随请求头直发网关。

**管理员口令（`admin-{8 位数字/字母}`）**：在 API Key 框里填管理员口令，请求会改用管理员密钥发出。源码里既没有明文密钥也没有明文口令：口令经 scrypt（N=2^16 · r=8 · p=1，64 MiB 内存困难）派生出加密密钥与校验密钥，管理员密钥与**有效期（14 天）**一起加密存放并带 HMAC 校验——口令错、密文或有效期被改、或已过期，都无法解封；到期那一刻起即使口令正确也不再替换。校验在桌面约 0.3–0.8 秒。换发 / 续期：`node tools/seal-admin.mjs --gen <密钥> [天数]`。到期后请同时在网关侧作废旧密钥。

## P3：编辑直播预览（Dubhe Helix 2.5（天枢2.5））

P3 补上「看得见 Agent 正在写什么」：写文件时折叠行显示 **Editing File(s)**，预览窗显示最近约 10 行（行号、写入模式、总行数与字符数）；流式期间节流刷新，换文件或收尾立即刷新。半截 JSON 也能逐字符安全解析，完成后优先读取已落盘内容；回合结束折叠回 Edited File(s) N，展开仍可回看。

> 验收：`npm run test:p3`（半截 JSON 扫描、预览字段与 UI 冒烟）。

## P2：策略演进与红队评测（Dubhe Helix 2.5（天枢2.5））

P0 让执行过程可解释，P1 让过程质量可度量、中断能接着干。资源预算在 P2 补齐第**七路 Token**（输入 + 输出合计，默认 20 万，实时记账；耗尽后新的工具调用会被调用前校验拦下并转带限制作答）。P2 解决的是「**这套系统自己怎么变好，以及怎么在出事前先出丑**」。

- **统一执行上下文**（`js/executionContext.js`）：能力（可用性）、约束（沙箱禁网 / 允许路径 / 并发上限 / 原件可否覆盖）、预算、风险上限、确认策略、策略版本、实验臂、审计绑定字段收进一个冻结对象，**工具表由它派生**。于是「上下文说可以联网、工具表里却没有 `fetch_url`」这种状态分裂在构造上不可能出现；开工前还会主动自检四类经典分裂并写进审计，而不是等模型去撞墙。
- **策略版本化**（`js/policy.js`）：13 项策略（路由 / 工具契约 / 风险 / 预算 / 提示词契约 / 审计结构 / 确认 / 恢复 / 幂等 / 记忆 / 轨迹 / 实验 / 内核总策略）各自独立版本号，每次执行落一份策略快照进审计与执行记录。效果退化时能回答「当时生效的是哪套策略」，`/p2 policy` 可做漂移自检——任何模块升版而注册表没跟上就当场红灯。
- **策略实验与在线反馈闭环**（`js/experiments.js`）：稳定分桶（同一会话不会每轮重摇）、默认**不灰度**、对照组语义干净（只有真正进入变体才允许实验参数改写行为）。护栏（确认放弃率 / 延迟 / 提示词增长）被触碰或明显退化 → 直接判**回退**；样本不足维持现状；只有 95% 区间不重叠且超过提升门槛才建议提升。
- **故障注入与红队平台**（`js/faults.js`）：九类故障可注入（超时 / 空值 / 错误结构 / 产物被外部改 / 重复调用 / 审计缺事件 / 掩码与工具表不一致 / 记忆与指令冲突 / 中途撤销授权），每类按**可检测 · 可解释 · 可停止 · 可恢复 · 可审计**五性质验收，拿不出证据一律判未满足；`/p2 fault` 可一键装备，注入一次性、用后自动清残留。
- **审计三层目标**（`js/audit.js`）：**完整性**（链式哈希：记录有没有被改）、**完备性**（执行记录 / 幂等账本 / 检查点 ↔ 审计事件双向对账：有没有漏事件）、**真实性**（是否真由指定环境产生——链式哈希*不能*覆盖，需硬件远程证明，**本架构如实不声明**）。界面与文档统一使用这套口径，不把「已上链」说成安全证明。
- **统一指标面板**（`js/metrics.js`）：12 项指标 × 7 个维度切分（任务类型 / 推理档位 / 工具类型 / In-Domain·OOD / 是否涉及记忆 / 是否发生恢复 / 是否产生外部副作用）+ 相对基线的门禁。只看总分会掩盖某一类退化。

> 验收：`npm run test:p2`（内核验收 38 项 + 分层评测集 N=120，10 类分别给出 P/R/F1 与 95% Wilson 区间）；面板见 `/p2`，报告见 `/stats` 与 `/nexus`。

## 能做什么

打开对话后这些是立刻能用的，不必先啃协议：

- 沙箱跑 JS / Python / C++，改动写回工作区，可单个下载或整包 ZIP
- 读改文件、哈希 / 正则 / ZIP、生图与识图（识图走专用工具，不塞进对话多模态）
- 本地静态模型内容审核：文本 Toxicity + USE 语义/策略层、图片 NudeNet + NSFWJS 均从 `assets/moderation/` 加载，不调用网关；成人色情、NSFW 图片与高风险/公序良俗类内容会在主模型前拦截
- 多会话、回滚、只覆盖「最近一条」的重新生成；思考从 Off 到 Ultra
- 网页抓取与搜索/爬虫走中继（本地 relay 或 Cloudflare Worker）；Git 远端操作需本地中继，沙箱内基础 Git 始终可用。Worker 不可达时相应工具不出现在工具表里
- 执行过程可解释、可恢复：每次工具调用都能回答「为什么调用、调用前后状态如何」，高风险操作在 `strict` 档会停下来等你确认
- 中断 / 刷新后能接着干：已完成且产物未变的步骤会被复用，产物被外部改动则先核验再继续（`/resume` 随时可查）
- 长期记忆有生命周期：来源分级（只有「用户明确要求」与「用户长期稳定行为」适合进长期库）、敏感信息默认只进候选区、冲突记忆本轮不注入

侧栏与沙箱面板宽屏进网格、窄屏变抽屉；顶栏是「思考 / 沙箱 / 联网 / 快速 / 面板」。更细的移动端规则见文末。

## TeamoRouter API 调研结论（2026-09，实测验证）

日常填 Key 对话用不上这张表。对接协议、排 400 / 鉴权时再看。

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
- **图片**（png/jpg/gif/webp ≤5MB）：对话通道纯文本。识图必须走 `analyze_image`（`deepseek-v4-flash-vision-exp`），结果可落盘；气泡内缩略图可点开。不要把图片塞进对话模型的多模态块。
- **文本/代码文件**（≤512KB，30+ 扩展名）：正文随消息注入，同时**自动写入沙箱 `uploads/` 目录**，Agent 可用 read_file 或沙箱代码处理全文
- **全部附件（图片 + 文本）都会自动复制到沙箱 `uploads/`**：图片以 data URL 存放，Agent 可把它作为 `generate_image` 的 `reference_paths` 直接改图；文件面板可逐个下载或整包导出 ZIP
- 同名再传：内容相同复用原路径，内容不同自动追加 `-2`/`-3` 序号，不覆盖上一轮
- 单条最多 6 个附件；localStorage 超 4MB 自动剥离图片数据并标记「已省略」（后续请求发送省略说明，不破坏协议）

## Agent 架构

```
用户输入
  │
  ▼
agent.js  ── ReAct 式工具调用循环（TOOL_LOOP_MAX=0，不限轮）
  │    ⓪ 上下文管理（context.js）：按模型预算压缩历史（整轮丢弃防孤儿 tool 消息）
  │       + 工具结果截断 + 参数 JSON 解析失败自动反馈纠错 + 流层早期失败重试
  │    ① 构建协议请求体（api.js: buildAnthropicPayload / buildOpenAIMessages）
  │    ② 协议路由：claude-* → /v1/messages（x-api-key）
  │                 其余    → /v1/chat/completions（Bearer, 可带 service_tier=fast）
  │    ③ 流式解析：createSSEParser → createAnthropicStream / createOpenAIStream
  │       归一化事件 {text | reasoning | tool_delta | usage | finish}
  │    ④ 工具分片累积（OpenAI index 对齐 / Anthropic input_json_delta 拼接）
  │    ⑤ 有 tool_calls → tools.js 执行 → 结果以 tool 消息回填 → 回到 ①
  │       无 tool_calls → 回合结束
  ▼
state.js  检查点快照（每轮 user 消息前）→ 支持回滚 / 一步撤销 / 重新生成
sandbox.js Web Worker 沙箱（JS 8s / Pyodide Python 120s 超时强杀）+ 虚拟文件系统
context.js    上下文预算与分级压缩（历史工具结果先收紧，本轮内容永远完整）
ui.js     渲染 / 动画 / 回滚交互 / 沙箱面板
```

**工具集**：`execute_javascript`（Worker 隔离 + console 捕获 + files 快照）、`execute_python`（Pyodide WASM 常驻 Worker，运行时只加载一次；经典 Worker 中必须显式传 `indexURL`）、`execute_cpp`（Compiler Explorer 公共 API 远程编译执行，g++ -O2 -std=c++20，请求需 `compilerOptions.executorRequest: true`，编译器按 `semver` 字段选择——ID 数字大小≠版本）、`write_file` / `read_file` / `list_files`（虚拟 FS，随会话持久化）、`get_current_time`、`remember`（跨会话长效记忆）、`dispatch_subagent`（子智能体委派）、
`fetch_url`（本地中继或 Worker + 联网开关）、`search_web` / `crawl_site`（新版 Worker + 联网开关）、`run_git`（本地中继 `workspace/` 内 git）。
另有本地工作台：`regex` / `hash` / `codec` / `unicode` / `search_files` / `diff_text` / `json_tool` / `zip_files` / `unzip_file` / `generate_image` / `analyze_image`，以及 V1.7 新增的 `csv_tool`（CSV 预览 / 过滤 / 排序 / 聚合 / 转 JSON）/ `date_calc`（日期差、加减、工作日、时区）/ `text_tool`（统计 / 去重 / 排序 / 大小写 / 包裹 / 对齐）/ `convert_units`（长度、质量、温度、速度、面积、体积、数据、时间）/ `qr_code`（本地二维码 SVG，Version 1–20，写入 `outputs/`），全部在 `js/utiltools.js`，纯本地、零依赖。
没有 `web_search` 工具，也不再注入模型原生网页搜索字段。

## V1.7 架构评审（Dubhe Helix 2.5）

**构建 2026.10.5.17：14 类快捷统计图 / 工具芯片纯图标 / 路由器 LOGO**

16. **`:::chart` 扩展为 14 类统计图**（`js/quickviz.js`，仍是纯函数、零依赖、Node 可单测）：柱状 `bar` / 条形 `barh` / 折线 `line` / 面积 `area` / 饼 `pie` / 环形 `donut` / 堆叠柱状 `stacked` / 堆叠面积 `stacked-area` / 直方 `histogram`（自动「好看」组距或 `bins=N`）/ 箱线 `boxplot`（四分位 + 1.5 IQR 离群点）/ 散点 `scatter` / 气泡 `bubble`（面积映射大小）/ 漏斗 `funnel`（整体占比 + 相邻步转化率）/ 桑基 `sankey`（最长路径分层 + 重心排序，带环保护）/ 地图 `map`。中英文别名均可直接写在 `:::` 后（如 `:::桑基图 能源流向`）。多系列用表头行「维度, 系列A, 系列B」驱动，自动分组 / 多线 / 堆叠并生成图例；所有图元都带 `data-chart-*` 供统一悬浮提示与键盘聚焦。专用的物理 s-t 语法（`st` / 位移时间图）移除，改用 `line` / `scatter` 表达。
17. **地图**：内置 `assets/geo/world.json`（217 国 / 地区，82 KB）与 `assets/geo/china.json`（34 省级，70 KB；由 ECharts 压缩坐标解码后 Douglas-Peucker 简化），渲染函数同步输出占位，ui.js 用 MutationObserver 发现后按需拉取（Service Worker 缓存），等距圆柱 / 中纬压缩投影 → 单色渐变分级着色 + 图例 + 未匹配地区计数；省份名自动选中国地图，国家名选世界地图，标题里写 `china` / `world` 可强制；别名表覆盖「江苏省 / 美国 / UK / 台湾」等常见写法。
18. **工具芯片**：每条命令只显示 `✓` / `✗` 图标 + 耗时（`role="img"` 带无障碍名称），失败态只有图标加粗、耗时常规字重；`.chip-state` 改 inline-flex 居中，折叠头「2.8s」不再相对标题行下沉。
19. **smart-router 图标**按 TeamoRouter 产品 LOGO 原稿重绘为粗体版（外环 2.1 全实色、轨道弧 2.6、卫星点 r=2.1、核心 r=3.1），不再沿用顶栏淡色 APP_LOGO 的透明度。
20. **自主优化**：条形图右侧直接标数值、堆叠柱顶标合计、直方图角标 `n / 组数 / 组距`、环形图环心显示合计、漏斗显示相邻步转化率、气泡只给最大 8 个标注避免拥挤、刻度改为 1/2/2.5/5×10ⁿ 的「好看」刻度（不再出现 12.5 / 37.5 这类半值）、每类图空数据时给出该类型自己的示例格式、新图元动效全部纳入 `prefers-reduced-motion` 静止、系统提示词改为完整的类型 / 数据格式速查。

对 `agent.js → execution.js → tools.js → sandbox.js` 主链做了一次只读评审，结论分「本版已改」与「建议下版」两栏，不夸大：

**本版已改**

- **信任边界前移到主线程**：过去 `runJavaScript / runPython` 直接 `fs.clear(); fs.import(worker.files)`，等于让 Worker 代码拥有工作区的全部写权限。现在 `sanitizeWorkerFiles(before, after)` 是唯一回写入口：路径白名单、字符串值、`internal/` 与 `.git/` 不可增删改、超容量整体回滚，并把拒绝原因以 warn 日志回灌给模型（模型能看见「为什么没写进去」而不是静默丢失）。
- **Worker 侧最小权限**：JS Worker 零网络、零派生、零持久化；Python Worker 仅保留装包所需的两个来源。`postMessage` 私有化后，用户代码无法抢先发送伪造的 `{ok:true}` 帧。
- **本地工具扩容而非沙箱扩容**：CSV / 日期 / 文本 / 单位 / 二维码这类高频小任务不再触发 Pyodide 冷启动（首次 3–8 s），直接在主线程毫秒级完成；`date_calc` / `convert_units` 为纯函数，纳入 `PARALLEL_TOOLS` 并行批。
- **子智能体权限表随工具表演进**：`subagents.js` 的 `data-analyst` / `mathematician` / `translator` / `copywriter` 等角色按需获得新工具，避免「主 Agent 会、子 Agent 不会」的能力断层。

**构建 2026.10.5.10 已落地（原「建议下版」五项）**

1. **依赖图调度** `planToolWaves(calls)`（`js/agent.js`）：为每次调用推导路径级读写集（`toolAccessSet`），只有写-读 / 读-写 / 写-写冲突（含目录前缀、move 源、自动命名输出）才排后一波；`[read a, write b, read c]` 从 3 批串行变 1 波并行。沙箱执行 / 生图 / zip / git / 记忆 / 参数损坏仍为全局屏障，委派只与委派同波。结果按原始下标回填，`batchToolCalls` 保留作兼容。
2. **token 估算缓存**：`estimateTokens` 以 WeakMap 按消息对象缓存，text / content / toolCalls / attachments 任一变化即失效；300 条长消息热路径从 ~173 ms 降到 <0.1 ms。
3. **ui.js 拆分（第一刀）**：图表 / 示意图 SVG 渲染拆为 `js/quickviz.js`（纯函数、Node 可直接单测；.17 扩至 14 类统计图），ui.js 降到 4568 行。后续按「消息渲染 / 侧栏 / 沙箱面板 / 设置」继续拆。
4. **Python FILES 增量同步**：常驻 Worker 持有工作区镜像，主线程只发 `diffFiles(镜像, files)`，Worker 只回传 `filesDelta {set, del}`；Worker 重建或上次失败自动退回全量；引用相同的大文件比较是 O(1)。顺带修了一个老 bug：Pyodide「不可用」判定曾用正则匹配错误文本，而用户代码回溯里天然带 `_pyodide/` 路径——任何一次异常都会禁用整个会话的 Python 沙箱，现改为只看加载阶段。
5. **远程 C++ 开关**：设置页新增「远程 C++（Compiler Explorer）」；关闭后能力约束 `sandbox.remoteCpp=false` → `deriveToolWhitelist` 与旧路径 `toolsFor` 同步剔除 `execute_cpp`，`executeTool` 兜底拒绝；工具描述、运行芯片与 `describeCapabilityConstraints` 都明示代码会发送到 godbolt.org。

**构建 2026.10.5.11 继续落地**

6. **同波按类别限流** `runWithCategoryLimits`：网络类（`fetch_url` / `search_web` / `crawl_site`）≤ 4 并发、本地工具 ≤ 8，每类一个信号量，按原序启动；`plannedConcurrency` 把实际峰值记入 `parallelTasks` 预算。
7. **mountUI 第二刀**：`ui-files-panel.js`（239 行）、`ui-lightbox.js`（202 行）、`ui-attachments.js`（232 行）以 `install*(deps)` 注入，返回最小 API（`renderFiles / openFileViewer`、`openLightbox / closeLightbox`、`hasPending / takePending / addFiles`），无反向依赖 ui.js；ui.js 5066 → 3945 行，`mountUI` 闭包约 2570 行。配套静态契约测试防止「拆出去的代码隐式依赖原模块作用域」。

**构建 2026.10.5.12：启动可靠性**

8. **「每次打开都加载超时」根因修复**：头部跨域字体样式表改为启动脚本动态插入，不再阻塞模块脚本执行；字体域名挂起时从「60 秒后才可用」变为 1 秒内挂载。资产测试禁止回退。
9. **加载屏重做**：真实四阶段进度、提前套用主题、慢网秒数提示、20 秒重载入口、60 秒「清缓存后重载」。

**构建 2026.10.5.13 / .14：PDF 工具与体验细节**

10. **`analyze_pdf` 新工具**（工具总数 37）：PDF 不再在发送前逐页转图，而是原样写入 `uploads/*.pdf`；工具先用 pdf.js 文本层提取全部内嵌文字，再把页面渲染成图**整批一次上传**给识图模型（≤ 8 页一批，`first_page / pages` 分段读长文档），返回「视觉识别 + 文本层」合并全文并落盘 `internal/ocr/`；界面上与 `analyze_image` 一样归入 Explored File(s)；沙箱文件面板可直接预览 PDF 页图。
11. **Ran Commands 状态**（.16 定稿，.17 去文字）：折叠头只是菜单，只显示总耗时（失败数放 title）；展开后每条命令只显示 `✓ / ✗ 图标 + 耗时`（不出现中文「成功 / 失败」字样，失败原因在悬浮提示里，耗时不加粗、与标题行居中对齐）——成败与耗时以执行内核写回的结论为准，所有工具都有（不再依赖工具自己上报），含调用前被内核拦截的调用，并随消息持久化；同一轮内连续产生的命令折叠合并为一块，绝不出现两个相邻的 Ran Commands。
12. **智能路由芯片**：点击「路由到的服务商」弹出任务类型 / 难度 / 服务商 / 实际模型的小面板。
13. **加载屏**：模块下载期间用 Resource Timing 实时推进进度条（文字保持「加载模块…」不闪，.14 修正），各阶段至少停留 110ms，不再从「载入资源」直接跳到「准备就绪」。
14. **图片编辑器**：旋转 / 画笔改为 rAF 合流重绘不再卡顿，旋转图标方向修正，进入裁剪时默认全图选区。
15. **其它**：矢量图按自身比例显示（竖图不再被拉宽）；空对话再点「新建」只提示「已在新对话中」；沙箱为空时的说明文案与插画；任务示例扩至 39 条并覆盖更多领域；成功 / 失败徽标、折叠清单、文件树、弹层、下拉等补齐进入与反馈动效。

**构建 2026.10.5.15：管理员密钥换发与加固**

16. 管理员密钥换发并引入有效期（14 天，写在密文里、受 HMAC 保护，过期后口令正确也拒绝，已解封会话到期即失效）；口令派生从 50,000 轮 SHA-256 升级为 **scrypt**（N=2^16 · r=8 · p=1，每次猜测需 64 MiB 内存，GPU / ASIC / 超算的并行优势被内存成本抵消），加密改为「密钥流 + HMAC-SHA256 先校验后解密」；纯 JS scrypt 与 Node 原生实现逐字节比对测试；`tools/seal-admin.mjs --gen` 一键生成随机口令并密封。

**仍建议下版**：`mountUI` 剩余大块是 `/system` 命令通道（~455 行，闭包依赖 20 个，需先把「会话状态操作」抽成一个 facade 再拆）与消息渲染（~800 行）。

## P0 执行内核（Dubhe Helix 2.5（天枢2.5），`js/execution.js`）

方向不是继续加层级，而是把 Dubhe Helix 2.5 做成「执行过程本身可解释、可计量、可核验」的操作内核。三个 P0 能力全部落在同一条执行轨迹上：

**1. 统一执行状态机**（14 态 / 38 条合法边，`transition-table-2.3.0`）

```
RECEIVED → CLASSIFIED → PLANNED → TOOL_PENDING → TOOL_RUNNING → TOOL_SUCCEEDED ┐
                    ▲                                                          │
                    └──────────────── 多步循环 ◄───────────────────────────────┘
TOOL_FAILED → RETRY_PENDING（可退避，需幂等）｜RECOVERY_PENDING（副作用不确定，先核验）
            → ANSWERING_WITH_LIMITATION（不可重试，带限制作答并披露）
TOOL_RUNNING → INTERRUPTED（用户中止 / 刷新 / 网络中断）
ANSWERING → VERIFIED → COMMITTED（COMMITTED 只能从 VERIFIED 进入）
```

- 每次转移都记 `{ turnId, sessionId, from, to, reason, timestamp, policyVersion }`，写进版本化审计日志并可逐条重放；
- 任意一次工具调用都能回答：为什么调用、调用前是什么状态、调用后发生了什么（`beginToolRun` / `endToolRun` 记录 preState / postState / 风险 / 幂等键 / 副作用摘要）；
- **工具失败不可能「隐式收尾」**：`TOOL_FAILED → COMMITTED` 是非法转移，必须走带限制作答并核验；
- 刷新或中断后 `resumeExecutionState` 直接给出阶段、未完成步骤与续跑入口（工具执行中被中断 → 先核验再续跑，并自动在下一轮注入断点续跑提示）。

**2. 工具调用前后的契约校验**（`tool-contract-2.4.1`，31 个工具 100% 覆盖）

- 每个工具声明输入 Schema、副作用、幂等性、重试策略、超时、回滚与风险等级；新增工具若没补契约，单测直接红灯；
- 调用前：参数 Schema（类型 / 必填 / 枚举）、工具是否在本轮工具表、能力与约束、预算、幂等键是否指向「副作用不确定」的旧调用；
- 调用后：结果形态、超时、**副作用是否真的发生**（声称成功却无变化、回报失败却已改动都会被标出）；
- 失败分六类处理——参数错误（改参数重试一次）/ 环境错误（解释 + 恢复路径）/ 暂时性错误（有限退避）/ 权限错误（不重试）/ 数据错误（标记异常）/ 副作用不确定（**禁止盲目重试，先核验**）；
- 幂等键 `idem-… = hash(turnId + toolName + 规范化参数)`，用于识别「同一次调用」并阻断重复写入 / 重复提交 / 重复扣费。

**3. 预算与风险治理**（`budget-policy-2.3.0` / `risk-policy-2.3.0`）

- 六路资源预算实时扣减并留痕：工具调用 32 / 重试 2 / 墙钟 600s / 并发 3 / 记忆写 4 / 外部副作用 6（可在 `store.state.settings.executionBudget` 覆盖）；耗尽即调用前拦截，转入带限制作答而不是静默失败；
- 工具风险分四级：L0 纯计算只读、L1 读文件与临时输出（自动执行）、L2 改文件 / 持久化记忆 / 批量处理（记录并可配置确认）、L3 删除 / 覆盖用户原件 / 推送 / 物理抹除记忆（默认生成「操作 / 原因 / 影响 / 可逆性 / 参数摘要」确认请求）；
- 默认 `observe` 模式只记录与披露；设 `settings.executionGuard = 'strict'` 后，L3 操作会在执行前停下来等用户确认（交互确认 UI 属 P1）；
- **静默失败检测**：回答里没有披露工具失败时，内核会补一条 `⚠️ 执行内核披露` 并如实记录，界面与后续上下文都能看到。

边界如实声明：状态机与链式哈希提供的是「可解释性 + 完整性」，完备性靠在 Store 侧对账，真实性（谁真的执行了它）需要硬件远程证明，本架构不做该声明。`/nexus` 面板会显示当轮真实的状态轨迹、预算账本与内核自检结果，不预填静态数字。

## 子智能体（18 个专家，`dispatch_subagent` 委派）

主 Agent 按需把专业任务委派给子智能体——**同模型、专属系统提示词、工具子集、独立上下文**（看不到会话历史，task 必须自包含；不可再委派，防递归；`SUBAGENT_LOOP_MAX=0` 不限轮）。名录在 `js/subagents.js`，**不在侧栏面板展示**；仅思考档 Max / Ultra 时工具表里才有 `dispatch_subagent`。

- **自主触发**：系统提示词给了明确的触发条件（交付物含 ≥2 个专业维度、写完代码请 reviewer/debugger 复核、翻译与长文改写等脏活外包、需要真实计算时派分析师），用户不点名也会自己派。
- **并行委派**：互不依赖的子任务在同一轮里一次发多个 `dispatch_subagent`，运行时最多 3 个并发，结果按调用顺序回填对话。
- **与代码沙箱解耦**：顶栏「沙箱」只控制三个代码执行工具；关掉后文件读写、生图、子智能体委派照常用（子智能体能用的工具也按同一规则取交集）。

| 分类 | 子智能体 |
|---|---|
| 代码 | code-reviewer 审查 · debugger 调试 · refactor-expert 重构 · test-engineer 测试 · perf-optimizer 性能 · security-auditor 安全审计 |
| 设计 | software-architect 架构 · api-designer API 设计 · prompt-engineer 提示词 |
| 数据 | data-analyst 数据分析 · mathematician 数学 · sql-expert SQL · regex-expert 正则 |
| 内容 | doc-writer 文档 · translator 翻译 · copywriter 文案 · explainer 讲解 · brainstormer 头脑风暴 |

## 网页搜索与抓取：Cloudflare Worker

顶栏「联网」需要探测到一个可用 relay（本地 `server.py` 或 Cloudflare Worker）。模型原生网页搜索字段保持关闭；Worker health 未声明的工具不会进入工具表。

- `fetch_url`：读取一个 URL 的正文。可由本地 `server.py` 或 Worker `/api/fetch` 提供。
- `search_web`：仅在 Worker `/api/health` 声明 `search` 时出现。优先使用可选配置的 SearXNG，否则用 DuckDuckGo HTML 适配器；回退原因会显示。
- `crawl_site`：仅在 health 声明 `crawl` 时出现。Worker 只跟进起始页同源文本链接，默认 3 页/深度 1，最多 5 页/深度 2；不渲染 JavaScript、不下载二进制。

Worker 文档与部署说明见 [`relay/README.md`](relay/README.md)。可在 Cloudflare Worker Variables 设置 `SEARXNG_URL`（HTTPS、启用 JSON）；否则无需搜索 API Key。搜索词会发送给配置的 SearXNG 或 DuckDuckGo。搜索结果与网页正文是不可信资料，不能当作指令；回答中的关键事实应核对原始 URL。

本地中继仍用于真实 Git 与单页抓取：

```bash
python3 server.py 8787                 # 默认开启 git（只在 ./workspace 里跑）
python3 server.py --no-git             # 只留抓取
python3 server.py --workspace ~/code   # 换工作区（git 的根，越界一律拒绝）
```

本地 `server.py` 提供 `GET /api/health`、`GET /api/fetch`、`POST /api/git`；新 Worker 另提供 `GET /api/search` 与 `GET /api/crawl`。前端按 health capabilities 探测具体能力，不会把 Worker 新路由误打到旧版本地 relay 的 404。

安全边界：

- Worker / 本地 relay 均校验外部 URL 与重定向；Worker 对字面私网/环回/链路本地/保留 IP 做显式阻断，但 Cloudflare Worker 不提供通用 DNS 解析 API，**不宣称能防住所有 DNS 重绑定或私有 DNS 解析**。
- Crawl 逐跳要求保持初始 origin；请求超时、页数、深度、每页字节数和字符数都有硬上限。
- Worker CORS 为 `*` 且没有鉴权。公开部署时建议给 `/api/search`、`/api/crawl`、`/api/fetch` 配 Cloudflare Rate Limiting；不要把它当成私密网络代理。
- 抓取上限 4 MB（`max` 可再调小），返回文本按 `max_bytes` 截断，`fetch_url` 超过 2000 字符时把全文写进 `web/<host>/<slug>.md`（或模型指定的 `save_path`），对话里只给 6000 字符预览 + 落盘路径。

测试：`npm run test:worker`（Mock fetch，不请求外网）及 `python3 tests/server_checks.py`。

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

- **图生文（识图）**：对话模型看不见图。必须调用 `analyze_image`（内部 `deepseek-v4-flash-vision-exp`）；返回全文，不要自行截成摘要。
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
js/net.js         抓取 / git 中继与 health-gated Worker 搜索/爬取调用、HTML→文本纯函数
js/websearch.js   网页搜索兼容层：原生字段关闭，保留历史服务端事件解析与回归守卫
js/titler.js      会话标题自动总结（独立小调用，不写进对话历史；新模块避免混版缓存的 link 期白屏）
js/zip.js         零依赖 ZIP 打包（STORE + CRC32），供沙箱整包 / 单目录下载
js/filetree.js    路径 → 目录树的纯函数（层级还原、大小汇总、折叠展开）
js/config.js      常量与模型目录（含 APP_VERSION：入口资源 ?v= 的单一真源）
js/suggestions.js 空状态任务示例池 + 随机抽取（纯函数，可单测）
js/icons.js       供应商品牌 Logo + 界面线性图标（currentColor，随主题反色）
js/editpreview.js 编辑直播预览（半截 JSON 扫描 → 最近 N 行预览窗，纯函数）
js/agent.js       工具调用循环状态机
js/state.js       多会话记录 / 消息 / 检查点回滚 / localStorage 持久化（v1 数据自动迁移）
js/ui.js          渲染与交互
server.py         静态服务 + 流式 API 代理（兜底通道）+ /api/{health,fetch,git} 本地中继
                  （默认仅绑定 127.0.0.1；git 只在 ./workspace 内执行）
tests/            agent.test.mjs（双协议解析 / 上下文压缩 / Agent 工具循环 / Worker 路由 / 搜索与爬取能力矩阵等）
                  worker.test.mjs（SSRF 与重定向护栏 / SearXNG 与 DuckDuckGo / 同源爬取限制 / 取消信号）
                  dom-smoke.mjs（会话列表 / 操作条显隐 / 设置页字号与思考档位 / 移动端布局）
                  app-boot.mjs（真实入口整轮对话 / 重新生成 / 工具表与历史事件兼容）
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
`report.json` 输出到 `/tmp/dubhe-live`（可用 `DUBHE_LIVE_OUT` 覆盖）。

五层离线测试（DOM / app-boot / pyodide 三层需相应 devDependency，未安装时自动跳过，CI 不依赖）：

```bash
npm test              # tests/agent.test.mjs：解析/状态机/纯函数（无 DOM）
npm run test:dom      # tests/dom-smoke.mjs ：挂载 UI 驱动交互路径
npm run test:app      # tests/app-boot.mjs  ：跑真实 js/main.js —— 弹窗填 Key → 选模型
                      #                       → 发送 → 工具调用 → 文件面板目录树 → 关沙箱后委派
npm run test:pyodide  # tests/pyodide-worker.test.mjs：Node 里用薄垫片直接跑真实 js/worker-py.js
                      # （npm i -D pyodide@0.26.4）：FILES 回写 / result 捕获 / 陈旧全局
npm run test:server   # tests/server_checks.py：中继护栏（git 白名单 / SSRF / HTML 抽取），纯 stdlib 无需 node
npm run test:live     # 真实网关：live-smoke + live-check + live-web（DUBHE_API_KEY=… 才跑，否则跳过）
npm run test:integrity # tests/assets-integrity.mjs：审核资产完整性——ORT 版本三件套 / tf 无 CSP 炸点 /
                      # 模型 format 配对 / 权重分片 4 字节对齐 / NudeNet 320 / 语义层 CJK 跳过（纯 Node）
npm run test:browser  # tests/moderation-browser.mjs：真实 Chromium 端到端审核——NSFW 拦截 / 良性放行 /
                      # 中文不误杀 / 无 CSP pageerror（需 puppeteer，没装自动跳过）
npm run audit:mobile  # 真 Chrome 量移动端布局（需 puppeteer）：无横向溢出 / 无重叠 / 触控目标 ≥36px
npm run test:all      # 前四连 + 资产完整性（含 server_checks）
```

`test:app` 是唯一覆盖「入口装配 + hook 接线」的一层：混版缓存、hook 缺失这类故障在纯函数
单测与挂载冒烟里都不会露馅，只有从 `main.js` 开始跑才能抓到。

```bash
node tests/dom-smoke.mjs
```

## 部署

### 在线版（GitHub Pages）

**https://imfufuu.github.io/dubhe-agent/** —— 纯静态部署，浏览器直连 `api.teamorouter.com`（网关已放行 CORS）。
Python 沙箱首次使用需从 CDN 加载 Pyodide 运行时；本地代理（server.py）在 Pages 上不存在，但不影响直连模式。

### 发布到 GitHub Pages 的步骤

本项目是零构建静态站点。仓库已内置 `.github/workflows/pages.yml`（Actions 部署）：
**推送到 `main` 即自动发布**，`workflow_dispatch` 可手动重发，concurrency 防重叠。

> 前提：仓库 **Settings → Pages → Source = GitHub Actions**（本仓库 2026-09-28 起即此配置，
> legacy「Deploy from a branch」已弃用；若旧仓库还是 legacy，先到 Settings 切换一次）。

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
对话），`npm run audit:mobile` 一条命令跑完；也可以加 `DUBHE_AUDIT_URL=https://imfufuu.github.io/dubhe-agent/`
直接量线上站点。

## 说明

- 浏览器直连时 Key 出现在前端，仅适合个人本地使用；生产环境请改为服务端持有 Key。
- 顶栏「沙箱」开关只决定三个代码执行工具是否下发（文件读写/生图/委派不受影响）；无鉴权中继 `server.py` 因此同源使用，不要暴露到共享网络。
- JS/Python 沙箱为浏览器内隔离（Worker 无 DOM；Pyodide 为 WASM），非容器级安全边界。V1.7 加固：JS Worker 执行前拆除 `fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource` / `importScripts` / `Worker` / `BroadcastChannel` / `indexedDB` / `caches` 并私有化 `postMessage`（用户代码无法联网、无法伪造结果帧）；Python Worker 的 `fetch` 只放行 Pyodide CDN 与 PyPI；日志 500 条 / 1 MB、返回值 200 KB、文件 128 MB / 5000 个硬上限；主线程 `sanitizeWorkerFiles` 逐键校验回写路径（拒绝绝对路径、`..`、反斜杠、控制字符、原型键），`internal/` 与 `.git/` 不可被沙箱代码增删改，超容量整体回滚；C++ 通过 Compiler Explorer 公共服务**远程**执行（代码会发送至 godbolt.org）。
- 页面启用了 CSP（`index.html` meta）：脚本仅放行同源与 Pyodide CDN，连接仅放行网关 / godbolt / CDN / 本站代理；渲染层本身也经注入探针验证。
- 本地服务器默认仅监听 `127.0.0.1`（代理通道无鉴权，`--host 0.0.0.0` 显式开放需自担风险）。

## 许可

MIT（见 [LICENSE](./LICENSE)）；打包与运行时第三方组件的许可见 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)。
