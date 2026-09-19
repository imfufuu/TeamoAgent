# Changelog

本文件记录 TeamoAgent 的阶段性改进。评估依据与完整问题清单见 [ANALYSIS.md](./ANALYSIS.md)。

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
