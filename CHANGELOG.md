# Changelog

仅保留稳定版和主要阶段性升级；同一发布周期的补丁构建合并记录，避免逐轮重复。

## Dubhe Agent V1.7 Stable · 2026-10-06 · 构建 2026.10.5.25

- **P5 修正：缺少外部验证闭环（构建 2026.10.5.25）**。根因：CI 存在但不可见也不完整——README 没有 workflow 徽章；`ci.yml` 漏掉 worker / dom-smoke / p3-dom-smoke / app-boot 等文件；`npm test` 只跑主单测，第三方复现要照抄 README 里的长命令；「N 项通过」写在文档里而不是由 CI 产出，属于自证。改法：① 新增 `tools/run-tests.mjs` 统一入口（`npm test`）：按文件逐个执行 `tests/*.mjs` + 两条 python 护栏，从各文件收尾行解析通过项数（node:test 的 `# pass N`、「N 项…通过」、「N 通过 / M 失败」、「N/N 通过」、「N=240」，认不出就数 ✓），「⏭ 跳过」与失败分开记，失败不互相阻断；② `ci.yml` 重写为「tests/ 下每个 .mjs 有且只有一个 step」（21 个，`if: !cancelled()`），`npm ci` 装 jsdom（DOM 冒烟不需要浏览器，不装 playwright），语法检查扩到 `relay/*.js sw.js tools/*.mjs`，最后一步 `--summary` 把计数写成 `::notice::` + job summary 表格；③ `package.json`：`test` → 全部、`test:unit` → 主单测、`test:list`；`.gitignore` 不再忽略 `package.json / package-lock.json`；`tests/touch-density.mjs` 由硬 `import puppeteer` 改为无依赖时跳过；④ README 顶部加 CI / Pages 徽章与 `npm ci && npm test`，测试章节改为单入口说明并声明「测试数字以 Actions 汇总为准，文档不手填」。验收（已写成测试）：`ci.yml` 的 step 集合 == `ls tests/*.mjs`（多一个少一个都红）；`scripts.test === 'node tools/run-tests.mjs'`；README 头部徽章链接指向 workflow；run-tests 的解析规则逐条有单测。
- **P4 修正：巨型单文件（构建 2026.10.5.24）**。根因：`ui.js` 的 `mountUI` 是一个约 2,500 行的闭包，所有子功能靠闭包变量共享 `store` / `$` / `toast`；`agent.js` 的 `runLoop` 约 1,200 行，`turn` / `exec` / `nexusState` 交叉引用；`nexus.js` 122 KB 同时装着提示词编排、轨迹分析、技能与分层上下文，边界没有写下来。改法：① `agent.js` 抽出 `js/toolrunner.js`（`createToolRunner({ store, emit, getFs, runSubagent })` → `runToolCalls`：契约预检 → 风险/确认 → 预算扣减 → 幂等回放 → 执行 → 结果核验 → 重试 → 检查点 → 审计；同波调度 `batchToolCalls / planToolWaves / runWithCategoryLimits` 一并迁入，agent.js 以 `export { … } from './toolrunner.js'` 转发，旧 import 路径不变）和 `js/turnfinalizer.js`（`finalizeTurn(ctx)`：runLoop `finally` 尾段的 P0/P1/P2 收尾记账与 `syncFS → notify → onTurnTiming`，同步、不 await，抛错语义不变）；`runLoop` 从约 1,200 行降到约 840 行，只负责调度。② `ui.js` 继续按 `install*(deps)` 模式拆出 `ui-markdown.js`（`$ / $$ / el / esc / renderMarkdown / renderAttachments / videoBlobUrl` 等模块级纯函数，ui.js 重新导出 `renderMarkdown / videoBlobUrl` 兼容旧路径）、`ui-model-picker.js`（`installModelPicker` → `inSystem / isSystemIsolated / selectModel / chatModels / updateModelBtn / renderModelMenu`）、`ui-popovers.js`（`installPopovers` → `hideTokPop / placeTokPop / showRouterPop / showTokBreak`）、`ui-command-palette.js`（`installCommandPalette`：⌘K 面板 + ⌘B / ⌃1–9 快捷键）、`ui-system-commands.js`（`installSystemCommands` → `handleSystemCommand`）；`mountUI` 从约 2,500 行降到约 2,100 行。③ `nexus.js` 不拆，在文件头写死「拥有 / 不拥有 / 新能力落点规则」。验收：`wc -c` ui.js 149 KB（< 160 KB）、agent.js 96 KB（< 110 KB），ui.js 2,816 行（契约上限 4,200 → 3,000）；新模块零 `from './ui.js'` / `from './agent.js'` 反向依赖（契约测试新增字节上限与反向依赖断言）；`renderMarkdown` 引擎缓存随 `ui-markdown.js` 迁移，测试改为重载该模块；全套 395 + 38 + DOM/启动冒烟通过，行为零变化。
- **P3 修正：能力门控不透明（构建 2026.10.5.23）**。根因：`dispatch_subagent` 等工具的可用性由 `resolveEffectiveReasoningState()` 推导、再由 `executionContext.js` 的 `deriveToolWhitelist()` 以 `capability-dispatch-off` / `relay-crawl-unavailable` / `remote-cpp-off` 等原因从工具表剔除，但这些 `dropped[].reason` 只进审计记录，UI 没有任何消费者——顶栏那行「智能 · 思考 Medium · 沙箱 · 联网 · 直连」只是 displayTier 字符串，用户和模型都不知道哪些工具被门控、为什么。改法：① `executionContext.js` 导出 `DROP_REASON_LABEL`（每种 reason 一句固定中文，如 `思考档位需 Max/Ultra`、`中继未声明 crawl`、`远程 C++ 已关`）、`DROP_REASON_FIX`（直达动作：切到 Max / 打开联网 / 打开沙箱 / 重新探测中继 / 打开设置）、`formatDroppedTools()`（「已禁用 N 个：工具（原因）…」）与 `deriveToolWhitelistFromBits()`（按当前开关态直接派生工具表，内部仍调用同一个 `deriveToolWhitelist`，有单测钉住四种开关组合逐项一致）；② agent 新增 `previewToolTable()`，并把 `whitelist.dropped` 挂到 `turn.dropped` / `nexusState.turnDropped`；系统提示的 `formatWebCapabilityNote` 改为从 dropped 生成「未列出的 crawl_site（中继未声明 crawl） / download_file（中继未声明 file） 本轮不可用」，runtime 层新增 `【工具表】本轮已禁用 N 个：…` 一句——模型看到的和用户看到的是同一份 diff（端到端测试断言 `previewToolTable().allowed` = 请求体 `tools`，`summary` 与系统提示逐字相同）；③ 新拆 `js/ui-capability.js`：能力条每个胶囊变成可点按钮，有裁剪时末尾多一个「已禁用 N」胶囊；点开复用 `#tok-pop` 弹出「能力 · 工具表」：可用 N / 总数、思考档位（可/不可委派）、逐条列出被禁用工具 + 原因 + 直达开关按钮，点完原地重算、条目消失。`syncCapLine` 随之迁出 ui.js（仍 < 4200 行）。测试：`tests/dom-smoke.mjs` 新增 ⑲ 组 15 项（思考 Off 点能力条 → DOM 出现 `dispatch_subagent` 与 `思考档位需 Max/Ultra`，点「切到 Max」后该条消失、能力条显示「思考 Max」）；`tests/agent.test.mjs` 新增 5 项。
- **P2 修正：沙箱文件不保证跨轮持久（构建 2026.10.5.22）**。根因：每轮工具都在 `createTempFS` 的临时层上写，回合结束 `commitAnswer()` 只提交「最终回答文本里出现过路径 / 文件名」的文件，其余静默丢弃——`fetch_url` 落盘的 `internal/web/*.md`、`analyze_*` 的 `internal/ocr/*.md`、`download_file` 的 `uploads/*` 全靠回答碰巧提到才活得过本轮，用户下一轮 `read_file` 直接「文件不存在」。改法：① `sandbox.js` 新增 `TEMP_PERSIST_PREFIXES = ['internal/', 'uploads/']`，`commitAnswer()` 对这两个前缀无条件提交，`discard()`（取消 / 出错）也保留它们——它们是整文件写入的工具副产物，不是半截产物；`outputs/` 等模型自由创建的路径仍按引用判定，行为不变；② 工具结果写明持久契约：`persistenceNote(fs, path)` 只在临时 FS 上生效——`write_file` 写 `outputs/` 追加「（本轮结束后若最终回答未提及此文件将被丢弃）」，写 `internal/` 与 `fetch_url` / `download_file` 的落盘说明追加「（已持久）」；系统提示新增一条「沙箱持久规则」；③ 提交结果挂到回合最终助手消息（`tempCommit = { committed, discarded }`）并经 `onTempCommit` 钩子重画整个回合：Edited File(s) 折叠把被丢弃的文件划线并标「已丢弃 · 回答未引用」（title 说明怎么保留），脚本生成后被丢弃的产物也列进去，整轮没 `write_file` 时用「Discarded File(s)」标题；折叠底部一行说明 internal/ 与 uploads/ 总是保留。纯函数 `findTurnTempCommit / discardedForFold / discardedFoldLabel / turnRange` 放在 `editpreview.js`，ui.js 行数仍在 4200 以内。测试：`tests/agent.test.mjs` 新增 5 项（临时层单元 / 工具文案契约 / fetch_url 端到端两轮累加 / write_file 丢弃与提交两条路径 / UI 纯函数与样式），`tests/p3-dom-smoke.mjs` 新增 ③ 组 9 项 jsdom 断言。
- **P1 修正：预算拦截无预警（构建 2026.10.5.21）**。根因：七路预算的账本 `formatBudgetLedger()` 只在拦截发生之后作为错误文本回传，模型事前看不到余额，只能撞墙。改法：① `execution.js` 新增 `formatBudgetForecast()`，每轮迭代把账本并入 ephemeral（没花过钱不打扰），任一可计数通道剩余 ≤ 2 明说「还剩几次、怎么省」（有 `crawl_site` 时建议同源多页一次计 1 替代多次 `fetch_url`），耗尽的通道点名哪些调用不会再被放行；② 三处拦截文本追加 `formatBudgetRecovery()`：用户能调的通道（外部副作用 / 工具调用）指向「设置 → 执行预算」并带当前上限，不能调的只给「新开一轮」；③ 设置页新增「执行预算」区（外部副作用上限 1–60、工具调用上限 4–128、恢复默认），写 `settings.executionBudget`，等于默认值不落盘，默认值从 `DEFAULT_TURN_BUDGET` 读取；④ 回合脚注显示 `工具 N/M · 外部 N/M`，耗尽标红并在 title 给恢复路径（随助手消息 `budget` 字段持久化）。验收：端到端用例连抓 5 页后第 6 轮请求 system 含 `外部副作用 5/6` 与 `剩余 1` 预警，第 7 次被拦的结果文本匹配 `设置 → 执行预算`；`p2-eval` 预算即将耗尽类 12/12 无退化。
- **Ran Command(s) 图标改为终端提示符 `>_`（构建 2026.10.5.20）**：折叠头不再是扳手；运行中不旋转，改为下划线光标闪烁（`steps(1)`，跑完即停）；展开时不再旋转 90°，只把 `>` 右推 1.5px。`ICON.terminal` 新增，下划线单独成 path。
- **`list_files` / 沙箱文件体积改为真实字节数（构建 2026.10.5.20）**：以前取字符串长度——图片 / 视频 / PDF 的 data URL 虚高 1/3、中文文本偏小。现在 `fs.list()` 统一经 `contentByteSize()`：base64 按 `⌊n·3/4⌋ − 填充` 反推、文本按 UTF-8 编码长度，按（路径 → 内容引用）缓存避免大文件重复编码；`list_files` 工具、系统提示里的「当前沙箱文件」、文件面板与配额统计全部同一口径。
- **全局「气泡弹入」动效（构建 2026.10.5.20）**：新增 `--pop-dur .34s / --pop-ease cubic-bezier(.22,1.18,.32,1) / --pop-out-dur .14s` 令牌与 `bubbleIn` 关键帧（只动 `transform + opacity`，`translate3d` 上合成层；轻微过冲后落定；收起快于弹入），模型 / 思考档位下拉、附件菜单、Token / 路由弹层（按锚点上下方向翻转 `transform-origin`）、命令面板、图表悬浮提示、所有折叠面板（Ran Commands / 思考 / Explored / Edited / md-fold：高度走 grid-rows 同曲线，内容再轻弹入）全部接入；菜单项以 25–40 ms 错落跟进；`prefers-reduced-motion` 整体退化为无动画。
- **沙箱视频可播放 + 首帧缩略图 + 抽帧审核（构建 2026.10.5.19）**：此前 `uploads/*.mp4` 在文件面板被当成二进制只给十六进制预览、气泡里也只有一个文件芯片。现在：① 附件进入前用 `<video>` + canvas 在本地抽帧——0.3 秒处一张海报图（附件芯片 / 消息气泡的首帧缩略图）+ 按 `(i+0.5)/5 · 时长` 均匀抽 5 帧；流式 WebM（录屏 / MediaRecorder 产物）时长为 Infinity 的先 seek 到极大值逼出真实时长再抽；解不出画面的（HEVC `.mov` 等）直接拒收。② 5 帧与图片走同一条 NudeNet + NSFWJS 本地审核流水线，任一帧命中即整条视频拦截，抽不到帧视为失败关闭；帧数据只用于审核，`agent.send` 入消息前摘掉，不进上下文也不落 IndexedDB。③ 气泡显示海报 + `▶ 时长` 角标，点击原地换成 `<video controls>`（blob URL，与全屏预览的点击互不干扰）；文件面板视频有专属图标，点开即 `<video>` 播放，关闭时 MutationObserver 回收 blob。CSP 新增 `media-src 'self' blob: data:`。
- **跨域文件拉取 `download_file`（构建 2026.10.5.19）**：新工具（工具总数 39）经 Worker `/api/file`（v1.7.0，`capabilities` 含 `file`）拉取任意 http(s) 资源原始字节写入沙箱 `uploads/`（≤ 16 MB，Worker 侧 `Content-Length` 预判 + 流式计数双重 413，禁止私网 / 本机地址，跟随 ≤ 5 次跳转并回传 `x-dubhe-final-url` / `x-dubhe-file-name`）；文件名取 `Content-Disposition` → URL 末段 → MIME 推断扩展名，重名自动加序号；结果头 `[下载完成] <url>\n保存：<path> · <mime> · <MB> MB · <kind>`，图片 / PDF / 视频提示后续可接 `analyze_*`。中继不支持 `file` 能力时该工具从工具表剔除（`executionContext` 与能力位双向对齐测试覆盖）。网络类并行限流名单纳入该工具。
- **前端粘贴 / 输入链接即附件（构建 2026.10.5.19）**：输入框粘贴裸 http(s) 链接或回形针菜单「从链接添加」→ 经中继拉取 → 与本地文件完全相同的分类（图片缩放 / 视频抽帧 / PDF / 文本 / ZIP）与审核流程，大小上限 16 MB，失败只弹 toast 不入附件。
- **`analyze_video` 视频识别（构建 2026.10.5.18）**：视频附件（mp4 / webm / mov / m4v，≤ 16 MB）原样写入 `uploads/`，工具逻辑照搬 `analyze_image`：读 data URL → 走 OpenAI 兼容接口的 `file` 部件交给 Gemini → 全文写入 `internal/ocr/{文件名}.video.md` 并回传计费 usage。`video_url` 部件会被网关静默丢弃、非 Gemini 模型会剥掉视频部件，因此视频档位只收录实测能真正收到视频的 Gemini 3.5 Flash Lite / 3.8 Flash / 3.1 Pro。工具总数 38。
- **设置页「多模态模型」**：识图模型（`analyze_image` / `analyze_pdf` 页图）与视频识别模型可选，只给几个有特点的档位（默认·最便宜 / 便宜·极快 / 均衡 / 效果最好 / 文档·代码截图），全局生效、写入 `settings.visionModel / videoModel`，透传到主回合与子智能体的工具 ctx；费用估算按所选模型取价。
- **下架 DeepSeek 免费档**：`deepseek-v4-flash-free`、`deepseek-flash-free` 从模型表、价目表、智能路由候选中删除，UI 兜底隐藏（网关 `/v1/models` 再返回也不显示）；固定对话模型 40 → 38。
- **加载屏网络明细**：进度文字下方新增一行「↓ 当前文件 · 下载速度 · 已下载体积 / 文件数」，按 Resource Timing `transferSize` 统计、120 ms 合并刷新；全部缓存命中时显示「资源来自本地缓存」，慢网提示带上正在拉取的文件名，就绪时给出总量与用时。
- **新工具 ×5**：`csv_tool`、`date_calc`、`text_tool`、`convert_units`、`qr_code`（本地二维码 SVG，Version 1–20，与 python-qrcode 逐位一致）。工具总数 36；子智能体按角色获得相应权限；并行白名单纳入 `date_calc` / `convert_units`。
- **沙箱安全加固**：JS Worker 执行前拆除 fetch / XHR / WebSocket / EventSource / importScripts / Worker / BroadcastChannel / IndexedDB / Cache 并私有化 postMessage；Python Worker 的 fetch 仅放行 Pyodide CDN 与 PyPI；日志 / 返回值 / 文件设硬上限；主线程 `sanitizeWorkerFiles` 逐键校验路径、保护 `internal/` 与 `.git/`、超容量整体回滚；`createFS` 改为无原型对象。
- **照片工作台重写**：对齐站点设计令牌，裁剪 / 旋转 / 翻转、六项调节、六档滤镜与自动增强，Canvas 实时预览。
- **介绍片**：修复静音；onset 分析提取 71 个底鼓时间点（`js/home-beats.js`），脉冲 / 切镜 / 字幕按真实鼓点触发。
- **导航与动效**：文档页顶栏参照首页重做；全站补齐进入 / 反馈 / 状态动效，尊重 `prefers-reduced-motion`；首页新增「新特性」区块与新工具芯片。
- **命名清理**：清除旧内部代号残留，默认中继改为 `relay.dubhe-agent.workers.dev`，旧 localStorage 键自动迁移；TeamoRouter（第三方网关）保持不变。
- **默认中继**：`relay.dubhe-agent.workers.dev`（wrangler 实际部署地址；health / fetch / search 线上验证通过）。
- **架构完善（构建 2026.10.5.10）**：
  - `planToolWaves`：按路径级读写集做依赖图调度，无冲突的读写同波并行，目录前缀 / move 源 / 自动命名输出均纳入冲突判断；沙箱执行、生图、zip、git、记忆与参数损坏的调用仍为全局屏障；委派只与委派同波。
  - `estimateTokens` 按消息对象 WeakMap 缓存（text / content / toolCalls / attachments 变化自动失效）。
  - Python 沙箱 FILES 增量同步：常驻 Worker 持有镜像，主线程只发 `diff(镜像, files)`，Worker 只回传 `filesDelta`；失败 / 重建时自动退回全量。
  - `quickviz.js`：图表与示意图 SVG 渲染从 ui.js 拆出为纯函数模块。
  - 「远程 C++」独立开关（设置页）：关闭后两条工具表派生路径都不含 `execute_cpp`，`executeTool` 直接拒绝；工具描述、运行芯片与能力描述串明示代码会发送到 godbolt.org。
- **修复：每次打开都「加载超时」（构建 2026.10.5.12）**：`app.html` 头部的 Google Fonts / jsDelivr 字体样式表由解析器插入，会阻塞其后所有脚本（含 `main.js` 模块图）执行；字体域名挂起时应用卡在加载屏直到 60 秒超时。现由启动脚本 `createElement('link')` 动态插入（不阻塞脚本），并新增资产测试禁止任何页面再出现解析器插入的跨域样式表。实测字体域名完全挂起：修复前 20 秒仍停在「正在初始化」，修复后 1.0 秒挂载。
- **加载屏重做**：真实阶段进度（`__dubheBootGuard.stage('modules'|'kernel'|'ui')` 由 main.js 上报）、提前套用已保存主题、慢网等待秒数提示、20 秒「重新加载」/ 60 秒「清缓存后重载」（注销 Service Worker + 清 CacheStorage）、reduced-motion 静止；内联脚本 CSP 哈希同步更新。
- **快捷统计图扩展为 14 类（构建 2026.10.5.17）**：`:::chart` 支持 bar / barh / line / area / pie / donut / stacked / stacked-area / histogram / boxplot / scatter / bubble / funnel / sankey / map（中英文别名可直接写在 `:::` 后）；表头行驱动多系列（分组柱 / 多折线 / 堆叠）并自动生成图例；直方图 `bins=N`、箱线图 1.5 IQR 离群点、桑基分层布局、地图内置世界 / 中国边界（`assets/geo/`，按需拉取、SW 缓存、自动识别省份 / 国家、常见别名）。移除专用 s-t 语法。同构建：工具芯片每条命令只显示 `✓ / ✗` 图标 + 耗时（无中文字样、失败态耗时不加粗、折叠头耗时居中对齐）；smart-router 图标按产品 LOGO 重绘为粗体版。
- **Ran Commands 定稿（构建 2026.10.5.16）**：折叠头只是菜单，只显示总耗时；展开后每条命令显示 `✓ 成功 / ✗ 失败 · 耗时`（.17 起去掉文字只留图标），成败与耗时取执行内核写回 call 的结论（所有工具都有，本地小工具记 1ms），刷新 / 合并重建后保持。
- **管理员密钥换发与加固（构建 2026.10.5.15）**：口令 `admin-{8 位数字/字母}`；口令派生改为 scrypt（N=2^16 · r=8 · p=1，64 MiB 内存困难，桌面校验约 0.3–0.8 秒）；管理员密钥与 14 天有效期一起加密存放并带 HMAC-SHA256 校验（先校验后解密，篡改密文 / 有效期即拒绝）；过期后口令正确也无法解封，已解封会话到期即停止替换；`tools/seal-admin.mjs --gen` 生成随机口令并密封，纯 JS scrypt 与 Node 原生实现逐字节比对测试。
- **PDF 工具与体验细节（构建 2026.10.5.13 / .14）**：
  - 新工具 `analyze_pdf`：PDF 原样入沙箱 `uploads/`，工具提取全部文本层后把页图整批一次上传识图模型（≤ 8 页一批，`first_page / pages` 分段），返回合并全文并写入 `internal/ocr/`；附件不再在发送前逐页转图；归入 Explored File(s)；文件面板可预览 PDF 页图。
  - Ran Commands 显示 `✓ 成功 / ✗ 失败 · 耗时`（含调用前被拦截），状态随消息持久化；同轮连续命令折叠合并为一块。
  - 智能路由芯片点击可查看任务类型 / 难度 / 服务商 / 实际模型。
  - 加载屏：模块下载期间按 Resource Timing 实时推进进度条，阶段最少停留 110ms；.14 修正「加载模块…」计数文字高频刷新导致的闪烁（只动进度条、文字不变）。
  - 图片编辑器：旋转 / 画笔 rAF 合流重绘、旋转图标方向、裁剪默认全图选区。
  - 矢量图按自身比例显示；空对话再点「新建」仅提示；沙箱空状态文案 + 插画；任务示例 39 条；成功 / 失败徽标、折叠清单、文件树、弹层、下拉动效。
- **架构完善 II（构建 2026.10.5.11）**：
  - `runWithCategoryLimits`：同波并行调用按类别信号量限流（网络 ≤ 4 / 本地 ≤ 8），`plannedConcurrency` 计入预算；波次与结果下标不变。
  - `mountUI` 继续拆分：`ui-files-panel.js`（文件树 / ZIP / 单文件 / 预览窗）、`ui-lightbox.js`（全屏预览）、`ui-attachments.js`（按钮 / 相机 / 拖拽 / 粘贴 → `addFiles`，发送时 `takePending()`），均为 `install*(deps)` 注入、无反向依赖；ui.js 5066 → 3945 行。
  - 新增静态契约测试：子模块用到的任何 ui.js 导入名 / 模块级助手必须自己 import、声明或经 deps 注入（拆分时真漏过 `ICON` / `safeImgSrc`，现在编译期就报）。
- **修复**：Python 沙箱「不可用」判定改为只看加载阶段（旧正则会匹配用户代码回溯里的 `_pyodide/` 路径，任何一次异常都会禁用整个会话的 Python）。
- **验收**：主测试 353 项；P2 40/40、P3 10/10、分层评测、资产完整性 37、服务端护栏 65 通过；DOM / P3 DOM / 应用装配冒烟（jsdom）通过；沙箱对抗用例与增量同步在 Chromium 实测通过。

## Dubhe Agent V1.6 Stable · 2026-10-05 · 构建 2026.10.5.8

V1.6 将 V1.5 系列的连续验收构建合并为稳定版，重点更新如下：

- **品牌与架构**：产品展示名更新为 Dubhe Agent，底层框架统一命名为 Dubhe Helix 2.5（天枢2.5），仓库与 Pages 地址更新为 `dubhe-agent`。
- **编辑与交互**：照片编辑工作台收敛为黑白灰界面并统一使用 SVG 图标；图表数据点扩大命中范围并支持键盘操作；改进 SVG 查看器的滚轮缩放和拖动衔接。
- **Markdown 与内容保真**：完善转义、高亮、上下标和化学式下标；行内代码、围栏代码与 LaTeX 公式受保护。回归覆盖中文、全角标点、emoji、反斜杠和代码围栏。
- **联网与输出恢复**：统一 Worker 健康状态和能力提示；补上首次探测及联网任务复探；修复慢 SSE、长度截断续写和空答复恢复。
- **会话与文件安全**：长历史按完整回合分页；彻底移除任务后的自动文件清理逻辑及相关状态、命令和标记。文件仅在用户或 Agent 明确操作时变更，并继续隔离 `internal/` 与工作区路径。
- **验收**：主测试 337 项通过；`npm run test:all` 通过，包含 P2 内核 40/40、P3 10/10、评测 120/120、资产完整性 37 项和服务端护栏 65 项。当前环境未安装 jsdom，DOM、P3 DOM 与 app-boot 冒烟按脚本约定跳过。

## Dubhe Agent V1.4 Stable · Dubhe Helix 2.5（天枢2.5） · 历史迭代 v2.2–v2.5.1 · 2026-09-30—10-02

- **稳定版核心**：路由、正交能力掩码与工具表一致性；软归档/Purge 双通道；SHA-256 审计链及 N=240 离线评测。
- **Dubhe Helix 2.5 P0–P3 后续升级**：显式执行状态机、风险与预算治理、工具契约、检查点与恢复、幂等账本、记忆生命周期、策略/红队评测、指标面板及编辑直播预览。系列最新构建为 `2026.10.2.15`。
- **体验与运行时**：本地内容审核、离线资源缓存、隔离的 `/system` 通道、文档分页和图表交互改进。

## 早期稳定版摘要

- **V1.3（2026-09-27）**：本地文本与图片审核、结构化图表和移动端体验完善。
- **V1.2（2026-09-26）**：沙箱图像、深度思考与委派、长期记忆和 Markdown 体验。
- **V1.1（2026-09-26）**：产品介绍页、任务示例、本地工作台及基础安全加固。
- **V1.0（2026-09-22）**：模型选择、多会话、代码沙箱、文件工作区、生图/图像编辑、公式和联网能力。
- **V1.0 之前（2026-09-19~21）**：确立基础对话流、静态资源版本化、会话持久化、文件树、联网中继与触屏布局。
