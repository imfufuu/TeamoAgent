# 第三方组件与许可声明

TeamoAgent 本体以 MIT 许可发布（见 [LICENSE](./LICENSE)）。
本项目打包或运行时依赖以下第三方组件：

## 本地打包（随仓库分发，位于 `assets/`）

| 组件 | 版本 | 许可 | 用途 |
|---|---|---|---|
| [markdown-it](https://github.com/markdown-it/markdown-it) | 14.3.2 | MIT | Markdown 渲染（`assets/md/markdown-it.min.js`） |
| [KaTeX](https://katex.org/) | 0.16.21 | MIT | LaTeX 公式渲染（`assets/katex/`，含其 OFL/MIT 双许可字体） |

上述组件的完整许可文本可在其上游仓库取得；其版权归各自作者所有。

## 运行时经 CDN / 远程服务加载（不随仓库分发）

| 组件 | 版本 | 许可 / 条款 | 用途 |
|---|---|---|---|
| [Pyodide](https://pyodide.org/) | 0.26.4 | MPL-2.0 | Python 沙箱运行时（`cdn.jsdelivr.net`，Worker 内加载，无 SRI，见下） |
| [Compiler Explorer (godbolt.org)](https://godbolt.org) | — | AGPL-3.0（服务端） | C++ 远程编译执行公共 API；代码会发送至该服务 |

**供应链说明**：Pyodide 通过 `importScripts` 从 jsDelivr 加载，该机制无法附加
Subresource Integrity 校验。项目通过固定到精确版本（`v0.26.4`）缓解版本漂移风险；
且该脚本运行在无 DOM、不接触 API Key 的独立 Worker 中。

## 商标与图标

`assets/icons/` 下的供应商图标为各公司商标（Anthropic / OpenAI / Google / DeepSeek /
智谱 Z.ai / xAI Grok），SVG 来源为 Wikimedia Commons，仅用于识别对应服务，
不构成背书。相关商标归各自权利人所有。
