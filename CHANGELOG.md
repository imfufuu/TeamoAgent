# Changelog

仅保留稳定版和主要阶段性升级；同一发布周期的补丁构建合并记录，避免逐轮重复。

## Dubhe Agent V1.7 Stable · 2026-10-05 · 构建 2026.10.5.11

- **新工具 ×5**：`csv_tool`、`date_calc`、`text_tool`、`convert_units`、`qr_code`（本地二维码 SVG，Version 1–20，与 python-qrcode 逐位一致）。工具总数 36；子智能体按角色获得相应权限；并行白名单纳入 `date_calc` / `convert_units`。
- **沙箱安全加固**：JS Worker 执行前拆除 fetch / XHR / WebSocket / EventSource / importScripts / Worker / BroadcastChannel / IndexedDB / Cache 并私有化 postMessage；Python Worker 的 fetch 仅放行 Pyodide CDN 与 PyPI；日志 / 返回值 / 文件设硬上限；主线程 `sanitizeWorkerFiles` 逐键校验路径、保护 `internal/` 与 `.git/`、超容量整体回滚；`createFS` 改为无原型对象。
- **照片工作台重写**：对齐站点设计令牌，裁剪 / 旋转 / 翻转、六项调节、六档滤镜与自动增强，Canvas 实时预览。
- **介绍片**：修复静音；onset 分析提取 71 个底鼓时间点（`js/home-beats.js`），脉冲 / 切镜 / 字幕按真实鼓点触发。
- **导航与动效**：文档页顶栏参照首页重做；全站补齐进入 / 反馈 / 状态动效，尊重 `prefers-reduced-motion`；首页新增「新特性」区块与新工具芯片。
- **命名清理**：清除旧内部代号残留，默认中继改为 `relay.dubhe-agent.workers.dev`，旧 localStorage 键自动迁移；TeamoRouter（第三方网关）保持不变。
- **默认中继**：`relay.dubhe-agent.workers.dev`（wrangler 实际部署地址；health / fetch / search 线上验证通过）。
- **架构完善（构建 2026.10.5.11）**：
  - `planToolWaves`：按路径级读写集做依赖图调度，无冲突的读写同波并行，目录前缀 / move 源 / 自动命名输出均纳入冲突判断；沙箱执行、生图、zip、git、记忆与参数损坏的调用仍为全局屏障；委派只与委派同波。
  - `estimateTokens` 按消息对象 WeakMap 缓存（text / content / toolCalls / attachments 变化自动失效）。
  - Python 沙箱 FILES 增量同步：常驻 Worker 持有镜像，主线程只发 `diff(镜像, files)`，Worker 只回传 `filesDelta`；失败 / 重建时自动退回全量。
  - `quickviz.js`：图表与示意图 SVG 渲染从 ui.js 拆出为纯函数模块。
  - 「远程 C++」独立开关（设置页）：关闭后两条工具表派生路径都不含 `execute_cpp`，`executeTool` 直接拒绝；工具描述、运行芯片与能力描述串明示代码会发送到 godbolt.org。
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
