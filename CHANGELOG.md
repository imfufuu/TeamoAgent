# Changelog

本文件记录 TeamoAgent 的阶段性改进。评估依据与完整问题清单见 [ANALYSIS.md](./ANALYSIS.md)。

## [Unreleased] — 第三轮改进（2026-09-19）

### 修复

- **切换模型后历史消息显示为当前模型**：每条 assistant 消息在创建时记录当时实际使用的模型（`m.model`，
  含工具循环续消息、工具调用上限提示、回合级错误消息）。UI 消息头（模型名 + 供应商图标）改读该字段，
  切换模型后历史消息保持显示原模型；旧会话 / 导入数据无此字段时回退到当前模型（向后兼容）。
  会话导出 JSON 与导入链路（`importSession`）保留该字段。
  - 回归测试：新增「切换模型后每条 assistant 消息保留当时使用的模型」（连续两轮对话中途切模型，
    断言消息记录与实际请求体中的模型一致）；既有工具循环 / 迭代上限测试补充 per-message 模型断言。
- **移动端布局塌缩（「挤成一团」的根本原因）**：侧栏抽屉化（≤860px）/ 面板浮层化（≤760px）后二者不再是
  grid item，`.main` 被网格自动排布到第 1 列（0px 轨道），整个主区塌缩成一条缝、内容全部挤死。
  修复：窄屏下显式指定列位 `.main { grid-column: 2 }`、`#sandbox-panel { grid-column: 3 }`。

### 新增 — 移动端 UI 优化

- **顶栏**：为常驻抽屉把手（FAB）让位（`padding-left: 56px`）；放不下时自动换行成两行，
  绝不把功能胶囊（思考 / 沙箱 / Fast / 面板）挤在一起或溢出视口；手机（≤760px）隐藏次要的用时统计。
- **模型下拉**：窄屏（≤760px）改为屏幕顶部全宽浮层（左右各留 10px、最大高度 `100dvh - 20px`），
  解决 fixed 定位菜单在窄屏溢出视口的问题；宽屏保持原「按按钮定位」行为。
- **沙箱面板浮层**：新增移动端专属关闭栏（标题 + ✕）——触屏够不到被遮罩挡住的顶栏 ◧ 开关；
  面板展开时隐藏 FAB（其 z-index 高于面板，防止误触切换侧栏）。
- **触屏可操作性（`hover: none`）**：原本悬停才显示的控件——消息「复制 / 回滚 / 重新生成」、
  会话删除按钮、代码块「复制」——在触屏设备上常显；按钮命中区统一加大（32–38px）。
- **iOS 细节**：输入框（composer / 模型搜索 / API Key）字号提到 16px，防止聚焦时页面自动缩放；
  全局 `touch-action: manipulation` 消除双击缩放延迟；移除系统点击高亮。
- **安全区**：底部输入区、「↓ 最新输出」/「⤺ 撤销回滚」浮钮、Toast 均避让 `env(safe-area-inset-bottom)`。
- **其他**：超窄屏（≤560px）隐藏底部协议说明行；矮横屏（≤460px 高）压缩纵向留白；
  抽屉宽度 `min(268px, 86vw)`；手机消息区左右 padding 28px→14px、用户气泡 82%→88%。

## 第二轮改进（2026-09-19，已合并 PR #2）

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
