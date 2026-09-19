# ◐ TeamoAgent — 基于 TeamoRouter 的网页端智能体

黑白极简 UI · 模型自选 · 代码沙箱 · 对话回滚 · 成熟 Agent 架构（工具调用循环）。

## 快速开始

```bash
cd teamo-agent
python3 server.py            # 默认 http://localhost:8787
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
| Fast mode | 请求体加 `"service_tier": "fast"`，仅 GPT 系列，2x 计费（旧值 `priority` 仍兼容） |
| 流式事件 | Anthropic：`message_start → content_block_start → content_block_delta → content_block_stop → message_delta → message_stop` |
| CORS | **实测返回 `Access-Control-Allow-Origin: *`** → 浏览器可直连；本项目仍内置服务端代理兜底 |
| 超时 | 服务器最长支持 600s 响应；大模型首 token 可能需数十秒，务必 `stream: true` |
| 错误格式 | `{"error":{"message","type","code"},"trace_id"}`，401 区分 `missing_auth_credential` / `invalid_api_key` |

## 附件支持

- **入口**：输入框 📎 按钮 / 拖拽到聊天区 / 直接粘贴（截图可用）
- **图片**（png/jpg/gif/webp ≤5MB）：多模态直传 —— OpenAI 协议走 `image_url`(data URL)，Anthropic 协议走 `image.source.base64` 原生块；需所选模型支持视觉（Claude/GPT/Gemini/deepseek-vision 等），气泡内缩略图可点开
- **文本/代码文件**（≤512KB，30+ 扩展名）：正文随消息注入，同时**自动写入沙箱 `uploads/` 目录**，Agent 可用 read_file 或沙箱代码处理全文
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
ui.js     渲染 / 动画 / 回滚交互 / 沙箱面板
```

**工具集**：`execute_javascript`（Worker 隔离 + console 捕获 + files 快照）、`execute_python`（Pyodide WASM，CDN 失败自动降级）、`write_file` / `read_file` / `list_files`（虚拟 FS，随会话持久化）、`get_current_time`。

**容错**：429/5xx 指数退避重试一次；HTTP 错误映射中文提示（401 查 Key / 402 充值 / 404 模型名）；直连失败自动切换 `/api/proxy` 中继并回放请求；中断按钮随时终止流。

## 目录

```
index.html        页面骨架
css/styles.css    黑白设计系统（明暗双主题，CSS 变量 + 平滑过渡）
js/config.js      端点 / 协议路由 / 兜底模型表 / 系统提示词
js/api.js         TeamoRouter 客户端（SSE 解析、双协议、重试、代理兜底）
js/sandbox.js     Worker 沙箱 + Pyodide + 虚拟文件系统
js/tools.js       工具定义与执行调度
js/agent.js       工具调用循环状态机
js/state.js       消息 / 检查点 / 回滚 / localStorage 持久化
js/ui.js          渲染与交互
server.py         静态服务 + 流式 API 代理（兜底通道）
tests/            node tests/agent.test.mjs（19 项，覆盖双协议解析与回滚）
```

## 说明

- 浏览器直连时 Key 出现在前端，仅适合个人本地使用；生产环境请改为服务端持有 Key。
- 沙箱为浏览器内隔离（Worker 无 DOM；Pyodide 为 WASM），非容器级安全边界。
