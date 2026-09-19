# TeamoAgent 综合分析与评价报告

> 评估对象：`imfufuu/TeamoAgent` @ `5bce4ed`（2026-09-19，单提交）
> 评估日期：2026-09-19
> 方法：静态代码走查 + 全部单测执行 + 自建探针脚本（XSS 注入、上下文压缩不变量、Markdown/公式边界）+ 本地服务与代理端点实测

---

## 一、摘要（TL;DR）

TeamoAgent 是一个**零构建、零运行时依赖**的浏览器端 LLM 智能体：约 4,100 行代码（JS 2,400 + CSS 588 + Python 116），
把「多协议网关接入 + ReAct 工具循环 + 三语言代码沙箱 + 18 个子智能体 + 会话回滚」压缩进一个可直接 `python3 server.py` 跑起来的静态站点。

**整体判断：这是一个完成度明显超出「个人练手项目」水准的作品，架构分层干净、协议细节考究、降级路径设计周到，已经具备产品雏形。**
但它目前有 **3 个会直接损害核心体验的实现缺陷**（都不是设计问题，而是几行代码的逻辑疏漏），修掉之后质量会有阶跃式提升。

### 评分卡

| 维度 | 评分 | 说明 |
|---|---|---|
| 架构设计 | 8.5 / 10 | 分层清晰、依赖无环、扇出浅；`ui.js` 一个巨型闭包是唯一热点 |
| 协议正确性 | 8.0 / 10 | 双协议细节（tool_result 合并、index 对齐、思考参数映射）考究；Claude 思考+工具调用有缺口 |
| 前端实现 | 8.0 / 10 | 黑白设计系统统一、响应式策略正确、流式渲染节流合理 |
| 可靠性 / 容错 | 8.0 / 10 | 直连→代理、引擎→回退渲染、超限→降级，层层兜底；持久化有丢数据窗口 |
| 安全 | 6.5 / 10 | 渲染层经 17 项注入探针验证干净；但无 CSP、无 SRI、Key 明文落盘 |
| 测试与工程化 | 6.0 / 10 | 40 项单测全绿且不变量设计得好；但无 CI、无 lint、无 UI/集成测试 |
| 文档 | 8.5 / 10 | README 含实测 API 调研表与部署指南；存在少量描述漂移 |
| 可维护性 | 7.0 / 10 | 命名与注释质量高；死代码/死 CSS 未清理，单文件 872 行 |
| **综合** | **7.6 / 10** | **良好（B+）：设计水准高于实现精度，修 P0 后可到 8.5+** |

### 必须优先修的三件事

| # | 问题 | 影响 |
|---|---|---|
| **P0-1** | 工具结果被**无条件**截断到 ~1.5k 字符（`context.js:50`） | 沙箱输出、子智能体报告只有 25% 送进模型，直接废掉核心卖点 |
| **P0-2** | Claude 开启思考 + 使用工具 → 400 → **静默永久关闭该模型思考**（`api.js:269`） | 默认配置下，第一次工具调用后就失去了思考能力，且用户无感知 |
| **P0-3** | `beforeunload` 触发的是**防抖版**保存（`state.js:59` / `main.js:40`） | 关页面前 300ms 内的对话可能丢失 |

---

## 二、项目画像

```
规模：52 个文件（其中 26 个是 assets 静态资源），代码 ~4,100 行
技术栈：原生 ES Modules + CSS 变量设计系统 + Python 3 标准库 http.server
运行时依赖：0（markdown-it 14.3.2 / KaTeX 0.16.21 本地打包；Pyodide 0.26.4 走 CDN）
开发依赖：0（package.json 仅 2 个 script）
```

### 依赖图（无环、扇出浅——这是好设计的标志）

```
main.js ─┬─ state.js
         ├─ agent.js ─┬─ api.js ──── config.js
         │            ├─ tools.js ─┬─ sandbox.js ── config.js
         │            │            └─ subagents.js
         │            ├─ context.js ── config.js
         │            └─ subagents.js
         └─ ui.js ────┬─ config.js / api.js / context.js / icons.js / subagents.js
```

`config.js` 被依赖 5 次、`subagents.js` 3 次，其余均为一次性依赖。
没有循环引用，没有「utils 大杂烩」，每个模块职责边界清楚。

---

## 三、做得好的地方（附验证证据）

### 1. 双协议抽象是真懂，不是硬套

`api.js` 把 Anthropic 原生与 OpenAI 兼容两套协议归一化到同一套事件 `{text | reasoning | tool_delta | usage | finish}`，
并且处理了两个协议各自的真实坑：

- **Anthropic 要求连续的 `tool_result` 合并进同一条 user 消息**（`buildAnthropicPayload` 里用 `last.content.every(b => b.type === 'tool_result')` 判断合并点）——这是官方文档明确要求、很多实现会漏的点。
- **OpenAI 的 `tool_calls` 用 `index` 对齐分片**，Anthropic 用 `input_json_delta` 拼接，两者共用同一个累加器且都做了「坏 JSON 降级为 `__raw` → 反馈模型自我纠错」。
- `max_tokens` 对 Anthropic 是必填、对 OpenAI 不必填，构建时分开处理。

### 2. 上下文压缩的「不变量思维」

`compactMessages` 采用**整轮丢弃（在 user 消息边界切）**而非逐条丢弃，从根上避免了「孤儿 tool 消息」导致两种协议 400。
而且这个不变量被写成了断言式单测。我另外用 4 组极端场景复验：

| 场景 | 结果 |
|---|---|
| 30 轮工具对话压到 20k | 丢弃 36 条，首条 role=**user**，孤儿 tool 消息 **0** ✅ |
| 单轮 50 万字符工具结果 | 正确深度截断，孤儿 **0** ✅ |
| 单条 40 万字符 user 消息 | ⚠️ **未压缩**（见 P1-1） |
| 极小预算（100 tokens） | 触底保护生效，孤儿 **0** ✅ |

### 3. 降级链设计得很周到

一共 6 条独立降级路径，且都能自愈：

| 链路 | 降级策略 |
|---|---|
| 浏览器直连失败 | → 本地 `/api/proxy` 中继，重放同一请求 |
| 429 / 5xx | 指数退避重试 1 次 |
| 模型不支持思考参数（400） | 记录到 `thinkingUnsupported`，去掉参数重试 |
| markdown-it 未加载 | → 内置精简渲染器（先转义再解析） |
| Pyodide CDN 失败 | 标记 `pythonAvailable()=false`，引导改用 JS 沙箱 |
| Worker 被 CSP 拦截 | 同源文件 Worker → blob Worker 回退 → 明确诊断文案 |
| 品牌 SVG 加载失败 | `error` 捕获阶段监听 → 替换为首字母徽章 |

特别是 `sandbox.js` 里关于 blob Worker 被 CSP 拦截的注释（"部分宿主页面如预览 iframe 的 CSP 不允许 blob: Worker"）
表明这是**踩过坑之后写下的代码**，不是照抄模板。

### 4. 子智能体的递归防护被测试锁住

18 个子智能体 = 专属提示词 + 工具子集，与主 Agent 同模型、独立上下文。
`dispatch_subagent` 在子智能体工具集里被显式过滤（防递归），且这条约束有单测覆盖
（`tools.js` 中 `SUBAGENTS` 引用的工具必须存在于 `TOOL_DEFS` 且不得为 `dispatch_subagent`）。
这种「把架构约束写成测试」的做法值得肯定。

### 5. 渲染安全经实测验证

我对 `renderMarkdown` 跑了 **17 组注入探针**，并检查输出中是否真的产生可执行元素：

```
真实可执行标签 (<script>/<img>/<svg>/<iframe>)  : 无 ✅
真实事件属性 (onerror/onload/onclick/...)        : 无 ✅
javascript: URL                                  : 无 ✅
```

覆盖：原始 HTML、markdown 链接/图片的 `javascript:` 协议（含大小写变体、前导空格）、
`data:` URL、KaTeX `\href`（KaTeX 默认 `trust:false` 已阻断，渲染为红色错误文本）、
`</code></pre>` 闭合逃逸、注释包裹等。

另外验证了**货币符号不会被误判为公式**：`价格是 $5 和 $10 美元` → 不触发 KaTeX；`$a$ 与 $b$` → 正确渲染。
行内公式正则 `\$([^\s$](?:[^$\n]*?[^\s$])?)\$` 的边界条件写得不错。

### 6. 服务端实测

```
GET  /                         200  text/html           Cache-Control: no-store
GET  /js/main.js               200  text/javascript     （MIME 正确，ESM 可加载）
GET  /../../etc/passwd         404  （SimpleHTTPRequestHandler 已规范化路径）
GET  /%2e%2e%2f...             404
GET  /api/proxy?path=../evil   400  {"error":"invalid path"}   ✅ 路径校验生效
GET  /api/proxy?path=evil      400  ✅
POST /index.html               405  ✅
上游不可达                      502  {"error":"upstream unreachable: ..."}  ✅
```

116 行 Python 用 `ThreadingMixIn` + `read1(65536)` 逐块 flush 透传 SSE，超时设 620s（对齐网关 600s 上限）——细节到位。

### 7. README 的 API 调研表

README 里那张「TeamoRouter API 调研结论」表（Base URL / 认证头差异 / 各协议端点 / CORS / 超时 / 错误码）
标注了「实测验证」，且代码里的实现与之一一对应。这种「先调研再写代码并留下结论」的习惯，比大多数同类项目强。

---

## 四、问题清单

### P0-1　工具结果被无条件截断到 ~1.5k 字符 —— 核心能力被悄悄砍掉 70% ⚠️ 最严重

**位置**：`js/context.js:49-50`

```js
export function compactMessages(msgs, budget) {
  let out = (msgs || []).map(truncTool(2000));   // ← 无条件执行，不看 budget
  let droppedCount = 0;
  while (estimateTokens(out) > budget) { ... }
```

`truncTool(2000)` 在判断是否超预算**之前**就对所有 tool 消息执行了，且截断规则是「保留前 75%」= 1500 字符。

**实测**（预算 150k，实际用量仅 4.9k tokens）：

```
原始工具结果长度 : 6000 字符
送入模型的长度   : 1511 字符   →  模型只看到 25%
尾部: "...结果行\n结果行\n\n…[工具结果已截断]"

子智能体报告 4000 字符 → 1511 字符
```

**影响**：
- `execute_python` / `execute_javascript` 的输出一旦超过 2000 字符（代码执行结果极易超过），模型只能看到开头一小段 → Agent 会基于残缺结果继续推理，表现为「沙箱跑了但好像没看见结果」。
- `dispatch_subagent` 的报告在 `agent.js:47` 已被截到 4000，`agent.js:203` 主工具结果被截到 8000，但**最终送进模型时统一变成 1511**——子智能体机制的价值（长报告）被严重削弱。
- UI 上显示的是 8000 字符版本，**用户看到的和模型看到的不一致**，这种不一致最难排查。

**修复建议**（同时修掉 P1-1）：把截断改为**预算驱动 + 分级收紧**：

```js
export function compactMessages(msgs, budget) {
  const src = msgs || [];
  if (estimateTokens(src) <= budget) return { messages: src, droppedCount: 0 };  // 快路径：原样返回
  // 逐级收紧工具结果
  for (const cap of [8000, 3000, 1000, 300]) {
    const out = src.map(truncTool(cap));
    if (estimateTokens(out) <= budget) return { messages: out, droppedCount: 0 };
  }
  // 仍超预算再整轮丢弃（保留你原有的正确逻辑）
  ...
}
```

---

### P0-2　Claude「思考模式 + 工具调用」必然 400，且会静默永久关闭思考

**位置**：`js/api.js:269-272` + `js/agent.js`（`buildAnthropicPayload` 丢弃 thinking 块）

Anthropic 协议要求：**开启 extended thinking 时，位于 `tool_result` 之前的 assistant 消息必须以 `thinking`/`redacted_thinking` 块开头（且需携带 `signature`）**。
本项目的 `buildAnthropicPayload` 只序列化 `text` 与 `tool_use`，把 `reasoning` 完全丢弃（`api.js` 里 `signature_delta` 事件也未处理）。

于是默认配置（模型 `claude-sonnet-5` + 思考开 + 沙箱开）下的时序是：

```
① 用户提问 → 模型返回 thinking + tool_use          ✅
② 工具执行完，第二次请求带 assistant(tool_use)      ❌ 400
   "Expected `thinking` or `redacted_thinking`, but found `tool_use`"
③ api.js:269 命中 /thinking|reasoning|extended/i
   → thinkingUnsupported.add(model) → 去掉思考参数重试  ✅ 请求成功
④ 副作用：该模型在整个会话内再也不会开启思考，用户毫无感知
```

这个错误在社区中被大量复现（gptel#743、LiteLLM#15601、crewAI#7577 等，均为同一报错）。
需要说明的是：我无法在本沙箱联网直连网关验证 TeamoRouter 是否严格透传该校验，但**在 Anthropic 原生语义下这条路径是确定会命中的**。

**修复建议**（三选一，按推荐度排序）：
1. **正确做法**：`createAnthropicStream` 处理 `signature_delta`，把 `{thinking, signature}` 存进 assistant 消息；`buildAnthropicPayload` 在 assistant content **最前面**插入 thinking 块。这样思考能力与工具循环可以共存。
2. **折中**：思考降级改为「仅本次请求生效」而非写入永久集合，并 toast 提示用户「该模型思考模式与工具调用冲突，已临时关闭」。
3. **保守**：沙箱开启时默认关闭思考（并在 UI 上说明原因）。

---

### P0-3　`beforeunload` 调用的是防抖版保存，关闭页面可能丢数据

**位置**：`js/state.js:59-61` + `js/main.js:40`

```js
const save = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { ...localStorage.setItem... }, 300);  // 又是异步
};
// main.js
window.addEventListener('beforeunload', () => store.save());  // 立刻返回，定时器不会触发
```

流式输出期间防抖定时器被反复重置，最后一次 `notify()` 之后若 300ms 内关闭标签页，本轮对话不落盘。

**修复**：给 `save` 加同步路径：

```js
const save = (immediate = false) => {
  clearTimeout(saveTimer);
  if (immediate) { flushSave(); return; }
  saveTimer = setTimeout(flushSave, 300);
};
window.addEventListener('beforeunload', () => store.save(true));
window.addEventListener('visibilitychange', () => { if (document.hidden) store.save(true); });
```

---

### P1-1　超大的单条 user 消息绕过压缩，直接把请求打爆

**位置**：`js/context.js:53`　`if (out.length <= 4) break;`

实测：单条 40 万字符 user 消息 → 压缩后仍为 **100,005 tokens / 预算 20,000**，未做任何处理。
而文本附件上限是 512KB（≈131k tokens），粘贴或拖入一个大文件就会越过 DeepSeek（55k）、GLM/Grok（90k）的预算。
结果是网关返回 400，用户只看到一句 HTTP 错误。

**修复**：压缩前先对超长 user/assistant 文本做头尾截断（可用已有的 `truncateToolContent` 思路），
并在 UI 上传时就按当前模型的 `contextBudgetFor(model)` 提示「该附件约 X tokens，超出模型窗口」。

---

### P1-2　沙箱执行进度全部被吞掉，遗留 60 行死 CSS

**位置**：`js/ui.js:868`

```js
onToolEvent() { /* 控制台已移除；执行进度在消息内工具芯片展示 */ },
```

但工具芯片**并没有**展示进度——`tools.js` 中 `emit({status:'running', note:'…'})` 的所有 note（含
Pyodide「正在加载 Python 运行时…」、C++「远程编译执行中…」、子智能体「X 思考中…」）全部被这个空函数丢弃。
首次调用 Python 要等 10–30 秒，界面上只有状态点「沙箱执行中」，用户不知道是在下载运行时还是卡死了。
注释里说的「在消息内工具芯片展示」与实际实现不符（芯片状态只有 `…` / `✓` / `✕`）。

同时 `.exec-list / .exec-card / .exec-head / .exec-ico / .exec-time / .exec-code / .exec-out`
共约 60 行 CSS 在 JS/HTML 中**零引用**，是被移除的控制台面板残留。

**修复**：把 note 渲染到对应 chip 的 `.chip-state`，或恢复一个轻量的执行日志区；同时删掉死 CSS。

---

### P1-3　持久化每次都全量序列化（含 base64 图片）再判断体积

**位置**：`js/state.js:64-65`

```js
let json = JSON.stringify(state);                              // 先全量（图片在内）
if (json.length > 4000000) json = JSON.stringify(slimState()); // 超了才瘦身
```

流式期间防抖虽避免了每 token 序列化，但每次落盘仍要完整 stringify 一次带 base64 图片的 state
（单张图片 5MB → dataURL 约 6.7MB 字符串）。应该反过来：**默认写 slimState，只在体积富余时才带图片**。

---

### P1-4　无 CSP、无 SRI，API Key 明文落盘

- `index.html` 无 `<meta http-equiv="Content-Security-Policy">`。渲染层当前是干净的（17 项探针验证），
  但 Key 存在 `localStorage` 明文，一旦将来任何一处 `innerHTML` 拼接出纰漏就是直接失窃。
- `worker-py.js` 用 `importScripts` 从 `cdn.jsdelivr.net` 拉 Pyodide，**无 Subresource Integrity**。
  CDN 被投毒即可在 Worker 内执行任意代码（虽拿不到主线程 DOM/Key，但能拿到注入沙箱的会话文件）。

**建议**：至少加 `default-src 'self'; img-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; connect-src 'self' https://api.teamorouter.com https://godbolt.org https://cdn.jsdelivr.net; worker-src 'self' blob:;`；
给 KaTeX/markdown-it 的本地 script 标签加 `integrity`（它们是本地文件，风险低，主要是防 CDN 的 Pyodide）。

---

### P1-5　本地服务默认绑定 `0.0.0.0`，是局域网内的开放中继

`server.py` 默认 `Server(("0.0.0.0", port), ...)`，任何能访问该端口的人都能用**自己的 Key** 通过它转发请求到
`api.teamorouter.com`（无鉴权、无限流）。个人本机使用没问题，但在共享网络/公司内网下等于免费代理。
建议默认 `127.0.0.1`，加 `--host 0.0.0.0` 显式开启。

---

### P1-6　仓库无 LICENSE

GitHub 上公开但 `licenseInfo: null`，法律上默认「保留所有权利」——他人无法合法使用/贡献。
同时项目内打包了 MIT 的 markdown-it 14.3.2 与 KaTeX 0.16.21，缺少第三方许可证声明文件。
建议加 `LICENSE`（MIT 或 Apache-2.0）+ `THIRD-PARTY-NOTICES.md`。

---

### P2-1　`ui.js` 的 `mountUI` 是 732 行、53 个闭包的巨型函数

占全文件 84%，是全项目唯一的可维护性热点，也是唯一无法被单测覆盖的部分。
建议按职责拆成 `renderers/`（消息、模型菜单、会话、文件面板）+ `bindings/`（事件绑定）+ `createUI()` 组装。

---

### P2-2　死代码与文档漂移

- 死导出：`resetTransport`（api.js）、`APP_FAVICON`（icons.js，favicon 已在 index.html 内联重复实现）。
- README「目录」写 `tests/ …（19 项…）`，实际 **40 项**。
- README 快速开始写 `cd teamo-agent`，仓库名实为 `TeamoAgent`。
- 无 `CHANGELOG`、无 CI workflow、无 issue/PR 模板、无 lint/format 配置。

---

### P2-3　可访问性（a11y）

| 问题 | 位置 |
|---|---|
| 弹窗无 `role="dialog"` / `aria-modal` / 焦点陷阱 / Esc 关闭 | `#key-modal` |
| 未响应 `prefers-reduced-motion`（logo 无限旋转、光标闪烁、多处 pulse/nudge 动画） | `css/styles.css` |
| 未响应 `prefers-color-scheme`（始终从亮色起步） | `state.js` 默认 `theme:'light'` |
| hover 才出现的控件在触屏/键盘下不可达：`.copy-code`、`.sess-del`、`.msg-actions` | CSS |
| 部分纯图标按钮只有 `title`，无 `aria-label` | `#attach-btn` 等 |

---

### P2-4　测试覆盖的结构性缺口

40 项单测**全部**打在纯函数上（SSE 解析、协议构建、token 估算、回滚、FS、子智能体注册表），质量不错。
但缺三块：

1. **Agent 工具循环**：`createAgent` 的 8 轮循环、参数 JSON 纠错、中断、迭代上限、错误落盘——完全无覆盖。
   建议用 mock `fetch`（`ReadableStream` 造 SSE）跑完整循环，这是本项目最值得测的部分。
2. **UI/DOM**：`renderMarkdown` 已测，但消息渲染、回滚交互、附件流程未测。
3. **`tests/live-smoke.mjs`** 依赖真实 Key，无法进 CI。应改为「无 Key 时 skip」并保留 mock 路径。

另建议加 GitHub Actions：`node tests/agent.test.mjs` + `python3 -m py_compile server.py`。

---

## 五、分维度详评

### 安全

| 面 | 状态 | 说明 |
|---|---|---|
| Markdown/HTML 渲染 XSS | ✅ 良好 | markdown-it `html:false`，17 项探针全部转义，KaTeX 默认 `trust:false` 阻断 `\href` |
| 公式注入 | ✅ 良好 | KaTeX 输出经 `throwOnError:false` 降级，实测 `\text{...}` 内注入 `<img>` 不产生真实标签 |
| 代码沙箱 | ⚠️ 需正确认知 | Worker 无 DOM、超时强杀、不接触 Key——**隔离有效**；但 Worker 内仍有 `fetch`，模型生成的代码可外传注入沙箱的会话文件。**不是安全边界**，README 已如实说明，值得肯定 |
| C++ 远程执行 | ⚠️ 已知取舍 | 代码发往 godbolt.org 公共执行，README 已明示 |
| 服务端代理 | ✅ 基本安全 | 上游 host 硬编码（无 SSRF），`..` 与绝对路径校验到位；仅剩 P1-5 的绑定范围问题 |
| 供应链 | ⚠️ | Pyodide 走 CDN 无 SRI（P1-4） |
| 密钥 | ⚠️ | localStorage 明文，README 已提示「仅适合个人本地使用」 |

### 性能

- 流式渲染用 `requestAnimationFrame` + `rafPending` 节流（`ui.js`），且 `paintAssistant` 读的是可变消息对象，不会丢帧丢字——正确做法。
- 工具芯片参数刷新按 300ms 节流——合理。
- `context.js` 的 token 估算用正则匹配 CJK，在 30 轮 × 4 条的压缩循环里会重复调用 `estimateTokens(out)`（每次 O(n)），
  **压缩循环是 O(n²) 最坏情况**。当前 n 很小（受 8 轮循环上限约束）无感，但若未来放开轮数需改为增量计算。
- `state.js` 每次 `updateMessage` 都走 `notify()` → `commit()` + 重置防抖定时器，每 token 一次——开销可接受，但配合 P1-3 的全量序列化会放大。

### 可靠性

| 机制 | 评价 |
|---|---|
| 中断 | ✅ `AbortController` 贯穿请求/工具循环/子智能体，AbortError 正确识别不重试 |
| 重试 | ✅ HTTP 层（429/5xx 退避 1 次）+ 流层（早期失败且未收到任何内容才重放，语义正确） |
| 错误呈现 | ✅ 401/402/404/429 映射中文提示，错误落进消息气泡 + toast |
| 数据持久化 | ⚠️ 有 300ms 丢失窗口（P0-3）；超 4MB 自动剥离图片（已实测逻辑正确） |
| 会话隔离 | ✅ 多会话 + v1→v2 自动迁移，切换时 `agent.loadFiles` 重载虚拟 FS |

---

## 六、改进路线图

### 第一批（1–2 小时，收益最大）

1. **`context.js` 重写 `compactMessages`**：快路径超预算才处理 + 分级截断 → 一次修掉 P0-1 与 P1-1。
2. **`state.js` 加 `save(immediate)`** + `beforeunload`/`visibilitychange` 调同步版 → 修 P0-3。
3. **`ui.js` 的 `onToolEvent` 接上 chip 状态** → 修 P1-2（顺带删 60 行死 CSS）。

### 第二批（半天）

4. **Anthropic thinking 块回传**：`signature_delta` → 存 `{thinking, signature}` → payload 前置 → 修 P0-2。
5. **加 CSP meta + Pyodide 完整性说明**；`server.py` 默认改 `127.0.0.1`（P1-4、P1-5）。
6. **加 LICENSE + THIRD-PARTY-NOTICES**，修 README 里的 19 项 / `cd teamo-agent` 漂移（P1-6、P2-2）。

### 第三批（1–2 天，工程化）

7. **拆分 `ui.js`**（P2-1）。
8. **补 Agent 循环的 mock-SSE 集成测试**：覆盖 8 轮上限、参数纠错、中断、错误落盘（P2-4）。
9. **加 GitHub Actions**：`npm test` + `py_compile` + 可选 live-smoke（有 secret 才跑）。
10. **a11y 一轮**：弹窗焦点陷阱与 Esc、`:focus-visible` 替代 hover-only、`prefers-reduced-motion`、自动主题（P2-3）。

---

## 七、结论

TeamoAgent 的**设计水位明显高于它的实现精度**：

- 作者清楚地知道 Anthropic 与 OpenAI 两套协议在工具调用、流式事件、思考参数上的差异，
  知道上下文压缩必须整轮丢弃以避免孤儿消息，知道浏览器 Worker 在 CSP 下的加载陷阱并写了双通道回退——
  这些都是只有在真实踩坑后才能写出来的代码，不是从模板拼出来的。
- 但几处关键逻辑的**条件判断写反了位置**（P0-1 的截断发生在预算判断之前）、
  或**沿用了不完整的协议实现**（P0-2 丢弃 thinking 块）、或**异步与同步边界搞混**（P0-3 的防抖保存），
  导致「架构上想得很对、实际跑起来打折」。

**第一个问题尤其关键**：它让沙箱和子智能体这两个最核心的差异化能力，在最常见的使用场景下只剩 25% 的效果，
而且因为 UI 显示的是完整版本，这个问题在自测时几乎不可能被发现。

按上面的「第一批」改完（约 1–2 小时），项目质量会有肉眼可见的跃升，综合分可从 7.6 提到 8.5 以上。

---

*附：本次评估执行的验证 —— `npm test`（40/40 通过，Node 22.22.3）、16 个 JS 文件语法检查、
`server.py` 编译检查、17 项 XSS/注入探针、4 组上下文压缩不变量场景、Markdown/公式边界 6 例、
服务端 8 项端点实测（含路径穿越与代理校验）。*
