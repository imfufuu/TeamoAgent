# Changelog

本文件记录 TeamoAgent 的阶段性改进。评估依据与完整问题清单见 [ANALYSIS.md](./ANALYSIS.md)。

## 2026-09-21（移动端 / 重新生成 / API 实测联网 / 示例文案）

### 1. 带入真 key 实测 TeamoRouter 的联网能力 → 能力表按实测收敛
拿用户提供的 key 把六条路都打了一遍（回归固化在 `tests/live-web.mjs`，无 key 自动跳过）：
GPT 的 `/v1/responses + tools:[{type:"web_search"}]` 真检索（一次问题回 16~250 条 URL 与
`url_citation`）；Claude 的 `web_search_20250305` 真检索（`server_tool_use` → `web_search_tool_result`，
含 title/url/page_age，引用走 `citations_delta`）；**Kimi 的 `$web_search` 网关收下但不执行、
GLM 的 `tools:[{type:"web_search"}]` 上游 400、Grok 的 `search_parameters` 只把工具调用当文本吐回来**；
Gemini 的原生 `google_search` 实测可用但需要另开原生 Gemini 协议通道（本轮未接）。
于是 `js/websearch.js` 的能力表**只留 Claude 与 GPT**，其余模型一律「不联网」并在提示语里说明，
宁可少支持也不给用户看「假装查过了」的来源条。

实测顺带挖出三个真 bug，都已修 + 补回归：

1. 网关 Anthropic 路由会把网页工具**混着两种块**发出来：有时是 `server_tool_use`，有时是名叫
   `web_search`/`web_fetch` 的普通 `tool_use`。后者按客户端工具处理会让主循环去执行一个不存在的工具
   （`runLoop` 真会 `executeTool('web_fetch')`）→ 现在统一按服务端工具处理，不进客户端累积器。
2. 请求体里带 `"system": ""` 时上游整段不返回 thinking 块（同一个请求、同一个模型，去掉空 system 就有
   299 字符的推理流）→ 空 system 不再发送。
3. 同一个查询词会因「分片凑齐」与 `content_block_stop` 各上报一次 → 加去重；
   `web_search_tool_result_error{error_code:"unavailable"}` 现在如实显示「联网检索未成功」而不是
   「服务端检索到 0 条来源」。

### 1b. 部署后真机实测发现的「假装联网」问题 → 加诚实性护栏
把部署好的页面用真 key 在真 Chrome 里跑了一遍：请求体里确实带着 `web_search_20250305`（形状没问题），
但**模型自己选择不搜索**，却在正文里写「我已经请求了模型的原生网页搜索功能」，还给出了一个凭记忆编的
汇率数字（7.28，而真检索结果是 6.7487）。界面没有来源条是对的（没有检索事件就不编来源），但用户读正文会被骗。
两道处理：① 系统提示词加了硬性要求——只有真的调用搜索工具并拿到结果才可以说「已联网查询」，
否则必须直说「本轮没能取得检索结果」；② 新增 `websearch.js` 的 `claimsWebSearch()`（纯函数，含否定句豁免）
与界面提醒条：正文声称联网但这一轮**没有任何检索事件**时，回答下方显示「未见检索事件 —— 模型的『已联网』
说法无法证实，其中的具体数字请另行核实」。7 条正例 / 6 条反例进单测，app-boot 用桩文本复现同一场景。

### 1c. 真机复测第二弹：模型「以为自己不能联网」→ 提示词自相矛盾已修 + 新增可操作提示

把 1b 的补丁部署上线后再用真 key 真 Chrome 打了一遍，模型不再编造联网声明（护栏有效），
但它这一轮**还是没检索**，回答里写「我无法实时获取…」。随后直接对网关 `POST /v1/messages` 做对照实验，
（不经过本应用）才定位到两条互相独立的原因：

1. **提示词的锅（已修）**：能力清单里还留着上一版设计的一句「不要去找一个叫 web_search 的工具」——
   本意是解释「联网由服务端执行、不是客户端工具」，模型却读成了「你没有联网能力」，于是放着可用的
   服务器搜索工具不用，改去抓 `fetch_url`（而抓取需要本地中继，网页版必然失败）。现已改写成
   「联网由**模型服务端**执行，请求已带上原生搜索字段……不要因为工具表里没有名为 web_search 的
   客户端工具就说自己不能联网」，并加了漂移守卫单测（禁止那句话再回来）。
2. **上游的锅（改不了，只能如实提示）**：对照实验里同一段提示词、同一个模型、同一个问题，4 次里
   只有 2 次真的调用服务器搜索；`tool_choice:{type:'tool',name:'web_search'}` 与 `{type:'any'}`
   网关都当没看见（依旧不检索），说明「调不调用」是上游模型的随机行为。
   修好的那半之后，本机真 key 实测已经能出**真来源条**：问汇率 → 服务端检索到 10 条来源
   （新华网 / 国家外汇管理局），数字 6.7487 与真检索一致。

于是界面补第三种状态（原来只有「有来源条」和「声称联网但没有事件」两种）：
联网开关开着、模型却回「我上不了网」型拒答时，回答下方显示中性提示条
「联网开关是开着的，但本轮没有发生检索 —— 上游模型自己没调用服务端搜索（网关侧偶发）。
需要实时数据的话，可以在提问里写明『先联网检索再回答』，或换个模型重问一次」。
判定用新纯函数 `websearch.js#webRefusal()`：**主语必须是「我/本助手/本模型」**，
避免把「该函数不能访问网络」「我没有访问该目录的权限」这类正常技术回答误判成联网拒答
（12 条正例 / 10 条反例进单测），且与 `claimsWebSearch()` 互斥。

另外，工具表也按「本地中继在不在」动态收敛：`fetch_url` 与 `run_git` 只在中继（`server.py`）可用时
才进请求（`js/main.js` 启动时探一次 `/api/health` → `store.state.relayOk`，不在时提示词加一段说明），
免得网页版里模型反复去够一个必然失败的工具。中继回来的话（本地跑、或工具调用成功一次）会自动恢复。

测试：单测 156 → **159**（新增 webRefusal 正反例、提示词漂移守卫、无中继时工具表收敛）、
dom-smoke 156（不变）、app-boot 66 → **75**（新增「开关开着却回拒答」的提示条分组与对照组）、
server_checks 51（不变）。`APP_VERSION` / `?v=` / `<meta name="app-version">` 全部 → `2026.09.21.9`。

### 2. 移动端布局大幅优化（先修根因，再重排密度）
窄屏时侧栏（≤860px）与沙箱面板（≤760px）都变成 `position: fixed` 脱离网格，`.main` 作为唯一在流
子项被自动排进第一列、而该列宽度已收敛为 0 → **主区宽度 0**，内容全部横向溢出：这就是「元素全挤在
一起」的根因（实测 `.main` clientWidth = 0、scrollWidth = 352）。修法是给三块命名网格区
（`grid-template-areas: "side main panel"`）。随后新增移动端一层：顶栏胶囊一行横滑、消息区留白收窄、
操作条换行、长链接/代码块各自滚动、输入框 16px（防 iOS 缩放）、输入区贴安全区；触屏设备（含平板）
所有可点元素 ≥40px。同时修掉侧栏沙箱面板按钮被 `textContent='◧'` 整体替换的问题（丢掉图标+文字外观、
窄屏被压到 33px 宽）。
护栏：新增 `tests/mobile-layout.mjs`（真 Chromium，320/360/390/414/768 量溢出/重叠/触控尺寸/面板越界，
`npm run audit:mobile`）与 dom-smoke 第 ⑯ 组源码级断言。

### 3. 「重新生成」= 覆盖最近一条回答
以前只调 `agent.regenerate()`：store 里旧消息删了，但 DOM 里旧回答还挂着，新回答又追加在下面，看起来
像「没重新生成」或「生成了两条」。现在点击时先 `dropLastAssistantTurn()` + `rebuildMessages()`，
界面上的旧答案当场消失再重跑。按钮本身**只出现在最近一条 assistant 上**（更早的回答按钮保留但隐藏），
要重生成旧回答请先「回滚」再重新提问——提示语里写明了这一点。app-boot 新增分组用「同一句话问两次、
桩回两版不同文本」证明是覆盖而非并列。

### 4. 任务示例去掉「任务类型」标签
空状态示例卡不再在句首挂「沙箱 / 文生图 / 协议」这类小标签（`js/suggestions.js` 的 `tag` 字段、
`css/styles.css` 的 `.suggest-tag` 一并删除），卡片只显示任务原句；点卡片回填的仍是完整原句。

测试：单测 152→**156**、dom-smoke 144→**156**、app-boot 55→**66**、server_checks 51（不变）、
`tests/live-web.mjs` 新增 4 项真网关断言、`tests/mobile-layout.mjs` 新增（真 Chrome）。
`APP_VERSION` / `?v=` / `<meta name="app-version">` 全部 → `2026.09.21.8`。

## 2026-09-21（四项）联网改成模型 API 自带格式 · 余额下线 · 欢迎页居中 · 缓存可见性

### 1. 联网：改用模型 API 自带的网页搜索请求格式（删掉全部第三方搜索）
上一节的 `web_search` 工具是「我们自己去打搜索引擎」，按用户要求整个换掉：不再有 `web_search` 工具、
不再有 Brave / Tavily / Serper / DuckDuckGo 分支、不再有 `TEAMO_*_KEY` 与 `server.py` 的 `/api/search`，
也不用 `r.jina.ai` 抓正文。改为在**同一个对话请求体**里声明供应商的原生服务器工具，检索由模型服务端执行：
Claude → `/v1/messages` 的 `web_search_20250305`；GPT → `/v1/responses` 的 `tools:[{type:"web_search"}]`
（配 `include:["web_search_call.action.sources"]` 才有引用）；Kimi → `$web_search` builtin_function；
GLM → `{type:"web_search"}`；Grok → `search_parameters:{mode:"live"}`。**没有原生格式的模型（DeepSeek 等）
就是不联网**，不会偷偷改道别的服务。

- 顶栏新增「联网」胶囊（线性地球 SVG + 中文，与「沙箱」同一视觉语言），`settings.webEnabled` 默认开；
  提示语随当前模型说明它走哪种原生格式，模型没有原生格式时点击给警告。切换模型即刷新（`syncWeb()`）。
- 全部格式细节集中在**新文件** `js/websearch.js`（能力表 + `injectWeb` + `buildResponsesInput` +
  `createResponsesStream`）；新开文件是刻意的：Pages 会缓存子资源，给已有模块加具名导出会在
  「新 ui.js + 旧 api.js」这类混版组合下 ESM link 失败 → 白屏。
- 三种协议的流被归一到同一套事件词汇（`text/reasoning/tool_delta/usage/finish/web_search/error`），
  所以 UI 与 Agent 循环不关心底层是 Messages、Responses 还是 Chat Completions。
- GPT 改道 `/v1/responses` 若被网关拒（400/404/422），**自动退回** Chat Completions 并剥掉联网字段，
  toast 告知、把模型记入降级表（`webFallbackFor`），下一轮直接走能用的端点，不白试；模型拒收原生字段时同理。
- 引用可见且持久：回答下方渲染「联网 ·「查询词」· 服务端检索到 N 条来源」+ 来源链接（`rel="noopener"`），
  写进消息对象，切会话/重开页面仍在；关联网时提示词改口为「未联网，涉及时效性要明确说无法核实」。
- 顺带修掉两个 Responses 转换层的真实缺陷：`output_item.done` 带的是**全量** `arguments`，与已收到的增量
  叠加会拼成坏 JSON（`createToolCallAccumulator` 新增 `replace` 语义）；并行 `function_call` 若都塌到
  `index 0` 参数会互相污染（改为按 `output_index`／`call_id` 稳定编号）。两者都源于装配冒烟真实跑通了
  GPT 联网回合，而不是只看请求形状。

### 2. 删除账户余额显示
移除 `#balance-badge` 与其 CSS、`fetchBalance()`（`GET /api/user/self`）及回合结束后的刷新调用：
界面上不再出现余额，也不再有余额类请求（app-boot 用「全程出网 URL 白名单」断言这点）。
侧栏底部只剩 传输状态 · 版本 · 会话统计 · 主题切换。

### 3. 欢迎页（空状态）元素 y 轴回到居中
撤掉上一轮「整体向上微调」的 `margin: 9vh auto 0`，`.empty-state` 改回
`min-height:100% + flex + align-items:center + justify-content:safe center`：垂直居中，内容超高时向上滚而不裁顶，
有对话后布局不受影响（`dom-smoke ⑭` 直接对 CSS 源码断言这四条）。

### 4. 部署可见性：缓存漂移自检
`index.html` 增加 `<meta name="app-version">`，与 `APP_VERSION` 比对：入口被刷新但子资源还是旧缓存时，
界面直接 toast「资源缓存不一致 —— 请硬刷新」，不用人肉对比版本号（Pages 静态资源是 `max-age=600`，
这正是上一轮「强刷还是旧版本」的原因）。入口 `css/styles.css?v=` 与 `js/main.js?v=` 一起 bump。

### 中继与测试
`server.py` 去掉 `/api/search`、`search_providers_configured()`、`run_search()` 与 `mode=markdown`（第三方抽取），
`/api/health` 不再报 `search/providers`，git 参数黑名单补 `--upload-pack=` / `--config=` / `init --exec=` /
`--output=` 四条（`clone --upload-pack` 是任意执行入口，原来漏了）。`fetch_url` 保留且只走中继，
工具描述里写清「浏览器直连受 CSP 限制」。
单测 144 → **152**、`tests/server_checks.py` 44 → **51**、app-boot 36 → **55**（含 GPT 的 `/v1/responses`
回合、Claude 的服务器工具回合、来源条渲染、关联网后不带原生字段、只打网关 host）；
dom-smoke 122 → **144**（联网胶囊、来源条、余额删除、居中、版本漂移）。`APP_VERSION` → `2026.09.21.6`。

## 2026-09-21（六项体验与能力）会话记录自动整理 + 联网检索 + 本地 git

按用户提出的 6 点逐条落地：4 项是会话记录与操作条的体验，1 项是能力（搜索 / 抓取 / git），1 项是面板排版。

### 1. 一键清除所有会话记录
`store.clearAllSessions()` 删掉全部会话（消息 / 检查点 / 各自的虚拟文件系统），只留一个可用草稿，
返回被删条数；侧栏「会话记录」标题行新增 清空 按钮（SVG 垃圾桶 + 中文），破坏性操作走 `confirm` 并在
回合进行中拒绝执行。

### 2. 新对话发出第一条消息后才入列
侧栏改用 `store.listableSessions()`（只列 `messages.length > 0` 的会话），空列表时给一句引导语而不是空白；
「＋ 新建」换成 `store.ensureDraft()` —— 当前已经是空会话时直接复用，不再往 localStorage 堆一串
看不见却会累积的空草稿。

### 3. 标题由 Agent 自动总结，也可手动改
- 每轮结束（`onTurnEnd`）触发一次**独立的小调用**做标题总结：不带对话历史、不带工具、结果不写回消息数组，
  所以不污染上下文也不占用工具循环预算；总结完成前显示「首条消息截断」的兜底名。
- 每会话只尝试一次（`titled` 标记）；无 Key 时不消耗、等下一轮再试；调用失败也标记为已尝试，避免每轮重复花钱。
- 用户改名（侧栏 ✎ 就地编辑，Enter 提交 / Esc 取消，或双击标题）写入 `titleSource='user'`，
  自动总结此后**永不覆盖**；自动写入的标题标 `titleSource='auto'`。
- 之所以是新的 `js/titler.js` 而不是给 `api.js` 加一个具名导出再被 `ui.js` import：Pages 对子资源有缓存，
  「新 ui.js + 旧 api.js」的混版组合会让新增具名导入在 ESM link 期直接报错 → 整页白屏；
  新文件没有旧缓存可比对，它只 import `api.js` 里早已存在的 `streamChat`。

### 4. 复制 / 回滚 / 重新生成：输出结束才显示，复制补图标
`refreshActionVisibility()` 重写为「按轮判定」：本轮只要有任一 assistant 消息 `done !== true`，
或整体仍处于 busy（流式、工具执行、子智能体在跑），该轮的 user 与 assistant 操作条统一加
`.actions-pending` 隐藏；回合完成（`setStatus('done')` / `onAssistantDone`）时立刻刷新。
「重新生成」只给整个会话最后一条 assistant。三个按钮统一 SVG + 中文（复制 / 回滚 / 重新生成），
`copy` 不再是没有图标的纯文字；剪贴板被拒时给可读提示而不是静默失败。

### 5. 联网检索、抓取网页与 git
> 本节已被上面「2026-09-21（四项）」第 1 条取代：`web_search` 工具与第三方搜索分支已删除，
> 联网改成模型 API 自带的请求格式；`fetch_url` 现在只走本地中继。

新增 3 个工具（`js/net.js` 负责传输，`server.py` 负责中继）：

| 工具 | 中继在跑 | 只有 Pages |
| ---- | -------- | ---------- |
| `web_search` | Brave / Tavily / Serper（有哪个用哪个），都没有则 DDG HTML 兜底 | DDG Instant Answer（明确标注覆盖有限） |
| `fetch_url` | 抓任意 URL，`mode=markdown` 走 r.jina.ai 正文抽取 | 浏览器直连（站点需允许 CORS） |
| `run_git` | 在 `./workspace/` 内执行真 git | 不假装可用：返回「请先跑 `python3 server.py`」 |

端点：`GET /api/health`、`GET /api/search`、`GET /api/fetch`、`POST /api/git`（`do_OPTIONS` 一律 405，
不给这个能力开 CORS 预检面）。安全护栏：子命令白名单 + 参数黑名单 + `GIT_CEILING_DIRECTORIES`
钉死工作区 + `GIT_TERMINAL_PROMPT=0` + `config` 只允许白名单内的本仓库键；URL 侧 `guard_public_http_url`
拒绝 loopback / 私网 / 链路本地 / 保留地址（防 SSRF 跳板）。系统提示词同步说明三个工具的用法与
「先查再答、查不到就明说」的自主性规则。抓取全文超 2000 字符自动落盘 `web/<host>/<slug>.md`
（或模型指定的 `save_path`，路径同样过 `normalizeFsPath`），对话里只回 6000 字符预览 + 路径。

### 6. 虚拟文件系统面板排版
「X 个文件 · X 个目录 · X K」+ ZIP + 清空 收进第二行（`.files-bar`，左右分布），标题独占第一行，
统计不再被按钮挤掉；清空按钮补 `title` 说明它清的是文件而不是会话。

### 测试与文档
单测 116 → **144**（会话入列 / `ensureDraft` / `clearAllSessions` / 改名与 `setAutoTitle` 覆盖规则 /
`needsTitle` 触发条件 / `htmlToText`·`pageTitle`·`slugFromUrl` / 搜索与抓取的分层兜底与失败文案 /
`run_git` 中继请求体与退出码判定 / 三个新工具在关沙箱时仍可用 / 提示词漂移守卫），
DOM 冒烟 95 → **122**，app-boot 26 → **36**（含真实 `main.js` 链路：起标题是独立请求、自动标题落盘、
一键清空后回到空状态示例），并新增**第五层** `tests/server_checks.py`（**44** 项，纯 stdlib，已进 CI）
覆盖 git 参数与 SSRF 护栏。README 补「网络能力」「会话记录」两节，`npm run test:all` 变四连。
入口资源与 `APP_VERSION` 同步升到 `2026.09.21.5`。

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
- 单测 101 → **116**：新增沙箱开关语义、`subagentTools` 交集、并发委派（用总耗时证明并发起）、
  路径归一、生图序号、空响应体、导入判忙顺序、死代码回归。
- `tests/app-boot.mjs` 19 → **26**：新增端到端段「关掉代码沙箱仍能自主委派子智能体」（核对请求里的
  tools 列表、提示词中的名录、委派芯片、报告被整合进回复）。
- `agent.js` 不 import 本轮新增的具名导出（ESM link 期混版会白屏），四处清单一致性由
  单测钉住；`APP_VERSION` 2026.09.21.2 → **.4**。
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
