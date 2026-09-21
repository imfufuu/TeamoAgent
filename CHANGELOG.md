# Changelog

本文件记录 TeamoAgent 的阶段性改进。评估依据与完整问题清单见 [ANALYSIS.md](./ANALYSIS.md)。

## 2026-09-21（全局审查）子智能体自主化 + 缺陷与冗余清理

对整个项目（`js/` 全部模块 + `server.py` + `index.html` + 三层测试）通读审查：修掉 6 个真实缺陷、
清掉 5 处冗余代码，并把「委派子智能体」从被沙箱开关与提示词措辞双重压制，改成模型可自主、可并行调用。

### 缺陷
1. **`js/worker-py.js` 调用了不存在的 `pyodide.toJS(...)`**（真实 API 是实例方法 `proxy.toJs({...})`）。
   它抛出的 TypeError 被 `catch` 静默吞掉，后果是 `execute_python` 的 `result` 全局变量与
   `FILES` 写入**从来没有回到过对话和虚拟文件系统**（只留下 print 输出）。改为
   `toJs({ dict_converter: Object.fromEntries })` —— 不指定 `dict_converter` 时 dict 会变成 Map，
   而 `JSON.stringify(new Map()) === '{}'`，那反而会清空整个 FS。
   用真实 Pyodide 0.26.4 验证：修复前 `files` 只含输入快照、`result` 为 `undefined`；
   修复后得到 `out/sum.txt=18` 与 `result={"sum":18,"n":4}`（`tests/pyodide-worker.test.mjs`）。
2. **常驻 Python Worker 的陈旧全局**：Worker 复用，上一轮的 `result` 不会自己消失，本轮模型没赋值
   就会把上一轮结果当成本轮输出。执行前 `globals.delete('result')`。
3. **生图落盘序号会覆盖旧图**：按「`outputs/` 现有文件数 +1」计数，用户在面板删过一个文件后
   序号就撞车。改为「已有最大序号 +1」。
4. **`write_file`/`read_file` 不校验 path**：模型漏传参数时沙箱里会凭空多出字面量 `undefined` 文件，
   工具还回报「已写入 undefined」；前导 `/`、`./` 则会把同一目录裂成两棵树。新增 `normalizeFsPath`，
   非法路径回可纠错提示。
5. **导入会话的判忙顺序**：旧代码先 `store.importSession()` 再判 `getBusy()`，回合进行中导入会把正在
   跑的数组换掉（半轮丢失 + 状态栏错乱）。判忙移到解析之前。
6. **`200 + 空 body` 直接 `res.body.getReader()`** 抛「reading undefined」；换成可定位的错误文案。
   顺带给 `formatExecResult` 补了 `out.error` 缺失时的兜底（此前会在 catch 里再抛一次）。

### 冗余与可疑代码
- 删除无调用方/无读取的：`zip.js` 的 `zipFileMap`、`filetree.js` 的 `node.direct`、`ui.js` 只写不读的
  `streamingId`、`runLoop({ regenerate })` 未使用的参数、`main.js` 里重复的
  `agent.fs.import(store.state.files)`（`createAgent` 已用同一份 `state.files` 建 fs，二次 import
  会把挂载期间被清空的文件复活）。
- `tests/smoke-tools.mjs`（手抄的一份工具定义）删除，`live-smoke` 直接取 `TOOL_DEFS` 里的真工具，
  避免测试副本与实现漂移；`live-smoke` 缺 `TEAMO_API_KEY` 时由 `exit(1)` 改为跳过（与 `live-check`
  一致），`npm run test:live` 现在把「协议层」与「图像/工具循环层」两层真实网关测试串起来。
- `rebuildMessages()` 每追加一条消息就全量 `querySelectorAll('.msg')`（n²）；改为循环结束后统一去动画。
- `server.py` 的 `/api/proxy` 响应去掉 `Access-Control-Allow-Origin: *`：调用方永远同源，这个头只是
  把一个无鉴权中继暴露给任意网页。
- 空状态示例里点名了网关并不存在的 qwen（点了只会演一遍失败）→ 改为「带 -free 的免费模型」。

### 子智能体：从「劝退委派」改为「自主 + 并行」
- 此前能力清单里根本没有 `dispatch_subagent`，整段名录只在沙箱开启时附加，且结尾写着
  「简单任务直接自己处理，不要为了委派而委派；一次委派一个明确的子任务」——模型据此几乎从不主动派。
  现在：`systemPrompt()` 列出该工具并说明「不要等用户点名」；`subagentGuide()` 改为**触发条件**
  （交付物含 ≥2 个专业维度、写完代码派 reviewer/debugger 自检、脏活外包保上下文、需要真实计算、
  用户点名）+ **并行规则**（互不依赖的子任务在同一轮里一次多发）。
- 沙箱开关不再没收委派能力：开关现在只摘掉 `execute_javascript/python/cpp` 三个代码执行工具，
  文件读写、生图、时间、子智能体委派始终可用（`toolsFor(sandboxEnabled)`）；子智能体自身的工具集
  按同一规则取交集，不再一关沙箱就全体退化成纯推理。`executeTool` 加了兜底：即便旧缓存把代码执行
  请求打回来，也直接拒绝并说明原因。
- **同一轮的多个 `dispatch_subagent` 并发执行**（上限 3），结果仍按调用顺序写回对话，其余工具保持串行
  （代码执行会改虚拟文件，交错跑不可复现）。
- 子智能体现在继承用户选定的生图模型；`apiKey/model/thinking` 改为在回合开始处锁定，
  中途换模型不再让后续迭代与委派错位。
- **混版安全**：上述 `toolsFor` 只在 `tools.js` 内部与测试中使用，`agent.js` 用本地副本过滤 `TOOL_DEFS`
  —— 静态站点无构建器，跨模块「新增具名导出」会让旧版模块在 ESM link 期报错、页面白屏（比钩子缺失
  更严重的一类故障）。两份代码执行工具清单的一致性由单测钉住。

### 测试
- 单测 101 → **115**：新增沙箱开关语义、`subagentTools` 交集、并发委派（用总耗时证明并发起）、
  路径归一、生图序号、空响应体、导入判忙顺序、死代码回归。
- `tests/app-boot.mjs` 19 → **26**：新增端到端段「关掉代码沙箱仍能自主委派子智能体」（核对请求里的
  tools 列表、提示词中的名录、委派芯片、报告被整合进回复）。
- 新增 `tests/pyodide-worker.test.mjs`（5 项，`npm i -D pyodide@0.26.4` 后可跑，未安装自动跳过）：
  在 Node 里用极薄垫片直接执行真实的 `js/worker-py.js`，锁死 ①② 两个静默失败点。

## 2026-09-21（严重修复）混版缓存会 brick 发送 —— 视图层故障隔离 + 入口资源版本化

线上反馈「发送提示词后界面没有任何变化」，且看不到新增的任务示例与下载图标。
仓库里已无 `⬇`/`⚡`、`js/suggestions.js` 也已上线，逐项核对线上字节后定位为**同一根因**：
GitHub Pages 对 JS/CSS 子资源有 ~10 分钟 `max-age`，浏览器于是组合出
「新 `main.js` + 旧 `ui.js`」——旧 `ui.js` 没有 `onUserMessage` 方法，
`ui.onUserMessage(msg)` 直接抛 `TypeError`，从 `store.pushMessage()` 冒泡出 `agent.send()`，
于是用户气泡、assistant 占位、流式请求全都没发生（= 界面毫无反应），
而旧的 `ui.js` 同时解释了「没有随机示例」「下载图标还是 ⬇」。

- **不变量**：Agent 的每个 UI 回调改经 `emit(name, …)` 分发 —— 钩子缺失只跳过、抛错只
  `console.warn`，视图层任何异常都不得中断对话循环（`js/agent.js`，18 处调用点全量改造）。
- **双向兼容**：`ui.onUserMessage()` 允许只收到文本（旧 `main.js` 的调用形态），自行回退到
  「最近一条还没上屏的 user 消息」，并按 `msgNodes` 去重；混版时任一侧都能工作。
- **穿透缓存**：`css/styles.css` 与 `js/main.js` 改为 `?v=APP_VERSION`；侧栏底部新增 `v<版本>`
  构建标识（hover 提示强制刷新）；新增单测强制 `?v=` 与 `APP_VERSION` 同步，避免发版漏改。
- 复现与验证：用**上一版 `ui.js` + 当前 `agent.js`** 实跑，修复前 `TypeError`，修复后
  `send()` 正常收尾（`user` + `assistant` 消息齐全，状态 `done`）；另有「钩子全抛错」单测。
- **新增 `tests/app-boot.mjs`（`npm run test:app`）**：从真实 `js/main.js` 起步，走「Key 弹窗 →
  模型菜单 → 输入框 → 发送 → 工具调用 → 文件面板」整条装配链（桩网关按端点分发 SSE/JSON）。
  本次故障正是"挂载层"问题，前两层测试都抓不到它。`package.json` 补 `test:dom` / `test:app` /
  `test:all` / `test:live` 脚本。
- 测试：单测 99 → 101，DOM 冒烟 90 → 95（连续 6 轮 0 失败；顺带修掉一条会误判的
  DOM 断言——示例文案本身包含其能力标签文字，改为比较 `data-prompt` 与 `textContent` 差异）。
## 2026-09-21（修复 + 体验）用户消息即时上屏 / 随机任务示例 / Logo 静止

- **修复：发完提示词看不到自己说的话**。`store.pushMessage(user)` 之后只刷新了会话列表与
  统计，从未把用户气泡 append 到对话区，于是要等模型输出结束、甚至切出会话再切回
  （触发 `rebuildMessages`）才看到。现在 `agent.send()` 把刚入列的用户消息交给 UI，
  `ui.onUserMessage(msg)` 立即 `appendMessage`（已渲染过则跳过，避免重复节点）。
  该用例被验证为「非自证」：还原旧接线后 DOM 冒烟立刻失败。
- **空状态任务示例**：新增 `js/suggestions.js`（18 条池子 + `pickSuggestions` / `shuffled`
  纯函数）。每次渲染随机抽 3 条、同轮标签互不重复；卡片带能力小标签；新增「换一批」；
  点击按 `data-prompt` 回填输入框（此前用 `textContent` 会把标签文字一起塞进去）。
- **侧栏左上角 Logo 停止自转**：移除 `.logo-mark` 的 `halfspin`（持续转动的标识与品牌位
  置不符，也属于无谓的动效噪声）；空状态大 Logo 保留极慢转动。
- `mountUI` 额外导出 `rebuildMessages`，供外部触发整段对话重绘。
- 测试：单测 95 → 99（示例池/随机性/边界），DOM 冒烟 76 → 90（即时上屏、随机示例、
  换一批、Logo 无动画）。
## 2026-09-21（UI）文件面板目录树 + 按钮图标统一

- **虚拟文件系统支持目录显示**：新增纯函数模块 `js/filetree.js`（`buildFileTree` /
  `flattenTree` / `collectPaths` / `treeStats`），把扁平路径还原成可折叠目录树：
  文件夹图标 + 缩进（`--d`）+ 每级汇总「N 个文件 · 体积」，点目录行折叠/展开
  （`role=button` + `aria-expanded` + Enter/Space），工具栏显示整体计数摘要。
  同级目录在前、自然数序排序；脏路径（多余 `/`、空段）不会造出空目录。
- **逐目录打包**：每个目录行一个「ZIP」按钮，只打包该目录（含子目录）且保留相对路径；
  工具栏 ZIP 仍是整包。触屏无 hover 时下载按钮常显。
- **列表大小真实化**：图片以 data URL 存放，按 base64 反推字节显示（此前按字符串长度虚高约 1/3）。
- **⚡ Fast → 「快速」**：改为与「思考」「沙箱」完全一致的 `pill + .pill-ico` 内联线性 SVG
  闪电图标 + 中文文案（选中态随 `currentColor` 自动反色），去掉系统 emoji。
- **下载图标化**：`#download-zip`、文件行下载、查看器「下载/关闭」统一换成 `js/icons.js`
  新增的 `ICON.download` / `ICON.x` / `ICON.folder(Open)` / `ICON.file` / `ICON.image` /
  `ICON.chevRight` / `ICON.bolt`（24 视图、1.9 描边、圆角端点）。
- 测试：单测 88 → 95（目录树纯函数全覆盖），DOM 冒烟新增 24 项检查（层级/折叠/逐目录
  ZIP/图标化按钮/三按钮风格一致），全部通过。
## 2026-09-20（修复）生图模型 400 与不可读的失败原因

线上反馈三类报错：`图像模型调用失败（gpt-image-2）：图像接口响应异常：缺少 data[0]`、
`（2.5 Sunburst）/（2.5 Flare）：HTTP 400: 模型 '…' 暂不可用`。带 key 实测网关后定位：

- **根因 1（2.5 系列全灭）**：`generate_image` 的 `model` 是自由字符串，对话模型把
  「显示名」当 ID 传了进来（`2.5 Sunburst`），网关无模糊匹配 → 秒级 400。
  修复：Schema 改 `enum` + 系统提示词列明 ID + `resolveImageModel()` 别名归一
  （`2.5 Sunburst`/`GPT Image 2.5 Flare`/`flare` → 真实 ID），无法识别时退回会话模型
  并把纠正说明回灌给模型。**不再把垃圾字符串发给网关**。
- **根因 2（`缺少 data[0]`）**：任何异常都被折叠成这一句。现在区分 200+`error`、
  200+空 `data`、非 JSON 响应体（含 HTTP 码/Content-Type/字节数/原文片段）、缺 `data` 字段，
  并对上游类瞬时错误自动重试一次。
- 附带：`n>1` 多张全部落盘；`sniffImage()` 按字节头纠正扩展名并给出真实宽高（网关有时
  无视 `output_format`，且不总返回 `width/height`）；`background`/`n` 进入工具参数；
  沙箱缺参考图时在发请求前报错；`<select>` 选项 title 展示真实 ID，非法存储值自动回落默认。
- 模型目录：补入网关已上线的 `kimi-k3`、`kimi-k3[1M]`（实测 200，`reasoning_content` 走思考面板）。
- 测试：单测 74 → 88；新增可选真实网关脚本 `tests/live-check.mjs`（需 `TEAMO_API_KEY`，
  10/10 通过，含一次真实 Agent 工具循环）。
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
