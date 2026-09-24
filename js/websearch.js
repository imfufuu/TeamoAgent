// ─── 联网：只用模型 API 自带的「网页请求格式」───────────────────────────────
// 用户要求：联网不再接任何第三方搜索 API（Brave / Tavily / Serper / DDG 全部删除），
// 而是把「要联网」这件事写成各家协议自己的请求字段，由模型服务端去搜、去取页、去给引用。
//
//   Claude   POST /v1/messages        tools: [{ type: "web_search_20250305", name: "web_search", max_uses }]
//   GPT      POST /v1/responses       tools: [{ type: "web_search", search_context_size }]（网关文档 4.4：Responses 仅 GPT 系列）
//   其余（Kimi / GLM / Grok / Gemini / DeepSeek …）：不联网（不假装能联网）
//
// ⚠ 以上是**实打实拿 key 打过网关**的结论（2026-09-21，见 tests/live-web.mjs）：
//   · GPT  → 真联网：web_search_call + action.sources（250+ URL）+ output_text 的 url_citation 标注
//   · Claude → 真联网：server_tool_use → web_search_tool_result（含 title/url/page_age）+ citations_delta；
//              上游偶发 web_search_tool_result_error{error_code:"unavailable"}，此时如实报「检索失败」
//   · Kimi 的 $web_search builtin_function：网关收下但**不会执行**，模型自述「我没有联网能力」
//   · GLM  的 tools:[{type:"web_search"}]：上游直接 400 upstream_error
//   · Grok 的 search_parameters.mode=live：网关把工具调用当普通文本吐回来（XML 片段），不是真搜索
//   · Gemini 的原生 google_search（POST /v1beta/models/{model}:generateContent）实测**可用**
//     （groundingMetadata.groundingChunks），但需要另开一条原生 Gemini 协议通道，本轮未接；
//     chat/completions 里塞 tools:[{type:"google_search"}] 会被网关 503 挡掉。
// 宁可少支持、也不给用户看「假装查过了」的来源条 —— 这是本文件存在的理由。
//
// 之所以是独立模块：本文件被 api.js 引用，而「给既有模块新增具名导出再被别的既有模块 import」
// 在 Pages 子资源缓存下会出现「新调用方 + 旧被调用方」的混版 → ESM link 期直接白屏。
// 新文件没有旧缓存可比对，安全；api.js 只在内部用它，不对外新增导出。

/** 各家协议的原生联网规格 */
export const WEB_CAPS = [
  {
    id: 'anthropic-web-search',
    label: 'Anthropic 服务器工具 web_search_20250305',
    match: (m) => /^claude-/i.test(m),
    endpoint: 'messages',
    // 服务器工具由 Anthropic 侧执行：结果以 server_tool_use / web_search_tool_result 块回流。
    // 这些块**不要**在下个回合重放（实测网关侧 encrypted_content 为空串，重放只会惹 400）。
    searchTool: () => [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
    serverBlockTypes: ['server_tool_use', 'web_search_tool_result', 'web_search_result'],
  },
  {
    id: 'openai-responses-web-search',
    label: 'OpenAI Responses API tools:[{type:"web_search"}]',
    match: (m) => /^gpt-/i.test(m),
    endpoint: 'responses',
    searchTool: () => [{ type: 'web_search', search_context_size: 'medium' }],
    // 让响应里带上来源（web_search_call.action.sources），前端才能显示引用与出处
    include: () => ['web_search_call.action.sources'],
  },
];

/** 当前模型有没有原生联网格式（没有就返回 null，让上层明确告知用户） */
export function webCapFor(_model) {
  return null; // 原生网页搜索已下线（各模型不稳定）
}

/** 把原生联网字段注入请求体（就地修改并返回 body；cap 为 null 时原样返回） */
export function injectWeb(body, cap) {
  if (!cap) return body;
  const extra = cap.searchTool ? cap.searchTool() : [];
  if (extra.length) body.tools = [...(body.tools || []), ...extra];
  if (cap.include) body.include = [...new Set([...(body.include || []), ...cap.include()])];
  if (cap.patch) cap.patch(body);
  return body;
}

// ── OpenAI Responses API：请求体 input 构造 ───────────────────────────────
// 我们的会话消息（{role,text,attachments,toolCalls,toolCallId,content}）→ Responses 的 input items。
// 说明：不依赖 previous_response_id / store，每轮把 input 完整重放，行为与 Chat Completions 一致，
// 也避免把会话数据存在网关侧。
export function buildResponsesInput(messages) {
  const instructions = messages.filter((m) => m.role === 'system').map((m) => m.text).join('\n\n');
  const input = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.toolCallId, output: String(m.content ?? '') });
      continue;
    }
    if (m.role === 'assistant') {
      const text = m.text || '';
      if (text) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
      for (const t of m.toolCalls || []) {
        input.push({ type: 'function_call', call_id: t.id, name: t.name, arguments: JSON.stringify(t.args || {}) });
      }
      continue;
    }
    const parts = [];
    if (m.text) parts.push({ type: 'input_text', text: m.text });
    for (const a of m.attachments || []) {
      if (a.kind === 'image' && a.dataUrl) parts.push({ type: 'input_image', image_url: a.dataUrl });
      else if (a.kind === 'text' && a.text != null) parts.push({ type: 'input_text', text: `【附件：${a.name}】\n${a.text}` });
      else parts.push({ type: 'input_text', text: `【附件：${a.name || a.kind}，本模型未内联读取】` });
    }
    if (!parts.length) parts.push({ type: 'input_text', text: '' });
    input.push({ type: 'message', role: 'user', content: parts });
  }
  return { instructions, input };
}

// ── OpenAI Responses API：流式事件归一化 ──────────────────────────────────
// 归一到与 createOpenAIStream / createAnthropicStream 相同的事件词汇表，
// 上层（agent.js 的工具循环与 UI）不需要知道下面换了协议。
export function createResponsesStream(onEv) {
  let sawText = false;
  // 同一个工具调用在流里必须始终落在同一个 index 上：多个并行 function_call 若都塌成 0，
  // 参数会被拼成一坨坏 JSON。优先用协议的 output_index，缺失时按 call_id 自行编号。
  const itemIdx = new Map();
  let idxSeq = 0;
  const toolIndex = (json, item) => {
    if (typeof json.output_index === 'number') return json.output_index;
    const key = String((item && (item.call_id || item.id)) || json.item_id || json.call_id || '');
    if (!key) return idxSeq;
    if (!itemIdx.has(key)) itemIdx.set(key, idxSeq++);
    return itemIdx.get(key);
  };
  return function handle(json) {
    const t = json.type || '';
    const err = json.error || (json.response && json.response.error);
    if (err) { onEv({ type: 'error', message: err.message || JSON.stringify(err) }); return; }
    switch (t) {
      case 'response.output_text.delta':
        if (json.delta) { sawText = true; onEv({ type: 'text', text: json.delta }); }
        break;
      case 'response.reasoning_summary_text.delta':
      case 'response.output_reasoning.delta':
        if (json.delta) onEv({ type: 'reasoning', text: json.delta });
        break;
      // 联网：模型侧发起的搜索（原生格式的核心可见性：查询词 + 来源数）
      // 搜索进度（实测事件名）：in_progress → searching → completed
      case 'response.web_search_call.in_progress':
      case 'response.web_search_call.searching':
        onEv({ type: 'web_search', status: 'searching' });
        break;
      case 'response.web_search_call.completed':
        onEv({ type: 'web_search', status: 'searching', phase: 'completed' });
        break;
      // 正文里的引用标注：只有它带 title，用它把来源列表的标题补全（按 url 去重在上层做）
      case 'response.output_text.annotation.added': {
        const a = json.annotation || {};
        if (a.type === 'url_citation' && a.url) onEv({ type: 'web_search', status: 'sources', sources: [{ url: a.url, title: a.title || '' }] });
        break;
      }
      case 'response.output_item.added': {
        const item = json.item || {};
        if (item.type === 'web_search_call') onEv({ type: 'web_search', status: 'searching' });
        else if (item.type === 'function_call') {
          onEv({ type: 'tool_delta', index: toolIndex(json, item), id: item.call_id || item.id || '', name: item.name || '', argsText: item.arguments || '' });
        } else if (item.type === 'file_search_call' || item.type === 'url_call') {
          onEv({ type: 'web_search', status: 'searching', kind: item.type });
        }
        break;
      }
      case 'response.output_item.done': {
        const item = json.item || {};
        if (item.type === 'web_search_call') {
          const sources = (item.action && item.action.sources) || item.sources || [];
          const act = item.action || {};
          const qs = [...new Set([...(act.queries || []), ...(act.query ? [act.query] : [])].filter(Boolean))];
          onEv({ type: 'web_search', status: 'done', results: sources.length, queries: qs, sources });
        } else if (item.type === 'function_call') {
          // done 事件带完整 arguments，兜住 delta 丢失的情况
          onEv({ type: 'tool_delta', index: toolIndex(json, item), id: item.call_id || item.id || '', name: item.name || '', argsText: item.arguments || '', replace: true });
        }
        break;
      }
      case 'response.function_call_arguments.delta':
        onEv({ type: 'tool_delta', index: toolIndex(json, json.item || {}), argsText: json.delta || '' });
        break;
      case 'response.function_call_arguments.done':
        // 同样给全量快照，兜住 output_item.done 因网络截断没到达的情况
        onEv({ type: 'tool_delta', index: toolIndex(json, json.item || {}), argsText: json.arguments || '', replace: true });
        break;
      case 'response.completed': {
        const r = json.response || {};
        const u = r.usage || {};
        if (u.input_tokens != null || u.output_tokens != null) {
          onEv({ type: 'usage', usage: { input: u.input_tokens, output: u.output_tokens } });
        }
        if (!sawText) for (const item of r.output || []) {
          if (item.type === 'message') for (const b of item.content || []) if (b.type === 'output_text' && b.text) onEv({ type: 'text', text: b.text });
        }
        // 联网来源汇总（有些实现只在 response.output 的 web_search_call 项里给 sources）
        for (const item of r.output || []) {
          if (item.type === 'web_search_call') {
            const sources = (item.action && item.action.sources) || item.sources || [];
            if (sources.length) onEv({ type: 'web_search', status: 'sources', sources });
          }
        }
        onEv({ type: 'finish', reason: r.status === 'completed' ? 'stop' : (r.incomplete_details?.reason || 'stop') });
        break;
      }
      case 'response.failed':
      case 'response.incomplete':
        onEv({ type: 'finish', reason: 'error' });
        break;
      default:
        break; // response.created / in_progress / content_part.added 等直接忽略
    }
  };
}

// ── 诚实性护栏 ─────────────────────────────────────────────────────────
// 实测踩过：模型明明没调用服务器搜索工具，却在正文里写「我已经请求了模型的原生网页搜索功能」，
// 并给了一个凭记忆编出来的汇率数字（7.28，真检索结果是 6.7487）。界面上没有来源条是对的，
// 但用户读正文会被骗。所以正文一旦声称「已联网/搜索过」而本轮没有任何检索事件，就要明确戳穿。
const WEB_CLAIM = [
  /已(经)?联网(查|搜索|检索|核实|查询|获取)/,
  /联网(查|搜索|检索)(到|了|出)/,
  /我(已经)?(上网|联网)?(搜索|检索|查询|查)了/,
  /已(经)?(调用|请求|使用)了?.{0,14}(网页搜索|网络搜索|搜索工具|web[_ -]?search)/i,
  /(根据|依据)(联网|网络|网页)?搜索(结果|到的)/,
  /(我)?(刚刚|刚才|已经)?(上网|联网)(找到|查到|核实)/,
  /(刚刚|刚才|已(经)?)(调用|使用了?)(了)?(网页|网络)?搜索(工具)?/, // 「刚才调用搜索工具确认过」这种省略「联网」的说法

  /web[_\s-]?search(ed)?\b/i,
];

/** 正文是否声称「这一轮联网查过了」（用于在没有检索事件时如实提醒，而不是替模型背书） */
/** 上游「我没有联网能力」式拒答：联网开关明明开着、模型却说自己上不了网。
 *  实测真踩过：网关侧的 Haiku 有时不调用服务器搜索工具，直接回「我无法实时获取…」。
 *  规则一律要求「我 / 本助手 / 本模型」当主语 —— 避免把「该函数不能访问网络」这种正常技术回答误判成拒答。 */
const WEB_REFUSAL = [
  /(我|本助手|本模型|本智能体)[^。！？\n]{0,10}(无法|不能|没法|没办法|不具备|没有能力)[^。！？\n]{0,14}(互联网|网络|网页|实时|最新|当前|数据|信息|资讯|汇率|新闻|网站|联网|上网)/,
  /(我|本助手|本模型)[^。！？\n]{0,10}(没有|缺乏)[^。！？\n]{0,14}(联网|上网|访问|浏览)[^。！？\n]{0,14}(互联网|网络|网页|实时|最新|当前|数据|信息|资讯)/,
  /(我|本助手|本模型)[^。！？\n]{0,6}(没有|无法|不能|没法)(联网|上网)(?=[。！？，,、；;]|$|查询|检索|搜索|核实|查看|获取|访问|能力)/,
  /(我|本助手|本模型|本智能体)[^。！？\n]{0,10}(没有|无)(可用|启用)?的?(联网|搜索|检索)(能力|工具|功能)/,
  /(知识|训练数据)(库)?[^。！？\n]{0,6}(截止日期|的截止日期)/,
  /(超出|超过)(我的)?(知识|训练数据)/,
  /(no\s+(real[- ]?time|internet)\s+access)|(i\s*(cannot|can'?t|do not|don'?t)\s*(access|browse))/i,
];

/** 判断一条回答是不是「我上不了网」型拒答（用于在开关开着时给出可操作提示） */
export function webRefusal(text) {
  const t = String(text || '');
  if (!t) return false;
  if (claimsWebSearch(t)) return false; // 声称查过的不算拒答，走另一条提醒
  return WEB_REFUSAL.some((re) => re.test(t));
}

export function claimsWebSearch(text) {
  const t = String(text || '');
  if (!t) return false;
  // 否定句不算声称：「未联网/没有联网/无法联网/未实际检索」
  if (/(未|没有|无法|不能|未能|不是)(联网|上网|检索|搜索)/.test(t) && !/已(经)?联网/.test(t)) return false;
  return WEB_CLAIM.some((re) => re.test(t));
}

/** UI 文案：这一轮的联网是以什么格式发生的 */
export function webCapNote(cap) {
  if (!cap) return '当前模型（网关实测）没有可用的原生联网格式，本轮不联网；要联网请换 Claude 或 GPT 系列';
  return `联网：${cap.label}`;
}
