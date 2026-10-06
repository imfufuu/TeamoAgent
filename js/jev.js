// ─── Jev（TypeSafe System One）：决策模型，不是聊天模型 ────────────────
// 文档：https://teamorouter.com/docs/jev-api
//   POST {gateway}/v1/systemone
//   Authorization: Bearer <TeamoRouter API key>
//   body: { model: "jev", state, questions }  —— 不要发 messages / stream / temperature / max_tokens
//   题型：choice（分类）/ score（2–10 档量表）/ noul（是/否概率 0–1）
// TeamoRouter 上的模型 ID 是 `jev`（SDK 默认的 jev-latest 在这边要改掉）。
//
// 本模块给「每一个」对话模型当 System-1：回合开始先做一次校准过的路由/难度判断，
// 再把结论写进主模型的系统提示。Jev 失败必须 fail-open，不能挡对话。

import { gatewayBase, setGatewayBase, otherGatewayBase, isNetworkError } from './endpoint.js';

export const JEV_MODEL = 'jev';
export const JEV_PATH = '/v1/systemone';
export const JEV_TIMEOUT_MS = 8000;

/** 决策模型不可当作聊天模型选中（网关 /v1/models 目前也不列出它，防以后漏进来） */
export function isJevModel(modelId) {
  const m = String(modelId || '').toLowerCase();
  if (!m) return false;
  if (m === 'jev' || m === 'jev-latest') return true;
  return /(^|[/.\\-])jev([/.\\-]|$)/.test(m) || m.includes('typesafe') && m.includes('jev');
}

export function noul(instructions, yes, no) {
  return { type: 'noul', instructions, criteria: { true: yes, false: no } };
}
export function choice(instructions, criteria) {
  return { type: 'choice', instructions, criteria };
}
export function score(instructions, levels) {
  return { type: 'score', instructions, criteria: levels };
}

export function buildSystemOneBody({ state, questions, model = JEV_MODEL }) {
  // 文档硬约束：不要夹带聊天协议字段，否则 400
  return { model, state: String(state || ''), questions: questions || {} };
}

export function noulOf(answers, key) {
  const a = answers && answers[key];
  if (a == null) return null;
  if (typeof a === 'number') return a;
  if (typeof a.noul === 'number') return a.noul;
  return null;
}
export function choiceOf(answers, key) {
  const a = answers && answers[key];
  if (a == null) return null;
  if (typeof a === 'string') return a;
  return a.choice || a.value || null;
}
export function scoreOf(answers, key) {
  const a = answers && answers[key];
  if (a == null) return null;
  if (typeof a === 'number') return a;
  if (typeof a.score === 'number') return a.score;
  return null;
}
export function confidenceOf(answers, key) {
  const a = answers && answers[key];
  return a && typeof a.confidence === 'number' ? a.confidence : null;
}

async function requestSystemOne(apiKey, body, signal) {
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const payload = JSON.stringify(body);
  const tryFetch = (url) => fetch(url, { method: 'POST', headers, body: payload, signal });
  const base = gatewayBase();
  try {
    return await tryFetch(base + JEV_PATH);
  } catch (err) {
    if (signal && signal.aborted) throw err;
    if (!isNetworkError(err)) throw err;
    const alt = otherGatewayBase();
    try {
      const res = await tryFetch(alt + JEV_PATH);
      setGatewayBase(alt, 'failover');
      return res;
    } catch (err2) {
      if (signal && signal.aborted) throw err2;
      throw err2;
    }
  }
}

/**
 * 调一次 System One。成功返回 { ok, answers, usage, model }；
 * 网络/协议失败返回 { ok:false, reason }。用户主动 abort 会把 AbortError 抛出去。
 */
export async function askJev({ apiKey, state, questions, signal, timeoutMs = JEV_TIMEOUT_MS } = {}) {
  if (!apiKey) return { ok: false, reason: 'no-key' };
  const q = questions && typeof questions === 'object' ? questions : null;
  if (!q || !Object.keys(q).length) return { ok: false, reason: 'no-questions' };
  const body = buildSystemOneBody({ state, questions: q });
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => ctrl && ctrl.abort(), Math.max(500, Number(timeoutMs) || JEV_TIMEOUT_MS));
  const onAbort = () => ctrl && ctrl.abort();
  if (signal) {
    if (signal.aborted) { clearTimeout(timer); const e = new DOMException('Aborted', 'AbortError'); throw e; }
    signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const res = await requestSystemOne(apiKey, body, ctrl ? ctrl.signal : signal);
    const ct = String(res.headers && res.headers.get && res.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('json')) {
      try { if (res.body && typeof res.body.cancel === 'function') res.body.cancel(); } catch { /* 忽略 */ }
      return { ok: false, reason: 'not-json', status: res.status };
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = json && json.error && (json.error.message || json.error);
      return { ok: false, reason: 'http', status: res.status, error: String(msg || res.statusText || '').slice(0, 240) };
    }
    const answers = json && (json.answers || (json.need_search || json.route ? json : null));
    if (!answers || typeof answers !== 'object') return { ok: false, reason: 'shape' };
    return { ok: true, model: (json && json.model) || JEV_MODEL, answers, usage: json.usage || null };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      if (signal && signal.aborted) throw err;
      return { ok: false, reason: 'timeout' };
    }
    return { ok: false, reason: 'network', error: String(err && err.message || err).slice(0, 240) };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// 每轮固定题组（英文：文档写明 English works best）。题目彼此独立，对着同一段 state。
export const TURN_QUESTIONS = {
  need_search: noul(
    'Does this user request need live web search for current facts (prices, news, versions, today, weather, changing docs)?',
    'Needs realtime lookup that model weights cannot reliably provide',
    'Answerable from general knowledge, code, or text the user already provided',
  ),
  need_code: noul(
    'Should the agent execute code in a sandbox (JavaScript, Python, or C++) to compute, transform data, or verify?',
    'Needs actual execution, not a verbal estimate',
    'No code execution required',
  ),
  need_image: noul(
    'Is the user asking to generate or edit a raster/photographic/illustrative image, excluding charts, flowcharts, mind maps, architecture diagrams, SVG/Mermaid/DOT, and data visualizations?',
    'Wants a picture, illustration, poster, icon, or existing photo/image changed',
    'Not an image task; structured diagrams/charts should be SVG/Mermaid/DOT/client-rendered, not image generation',
  ),
  need_dispatch: noul(
    'Should the main agent dispatch a specialist subagent (review, research, writing, data analysis) rather than answering alone?',
    'A specialist with a focused prompt would do a better job',
    'The main agent can handle it directly',
  ),
  route: choice('Primary way the agent should handle this turn.', {
    chat: 'Direct answer with little or no tools',
    tools: 'Use sandbox, files, git, or fetch tools',
    search: 'Must search the live web first',
    image: 'Generate or edit a raster/illustrative image (not charts/diagrams)',
  }),
  difficulty: score('How hard is this request for a coding agent?', [
    'trivial greeting or single fact',
    'single-step task',
    'multi-step but linear',
    'needs planning and tools',
    'hard: research, parallel work, or high factual risk',
  ]),
};

export function buildTurnState({ text, model, settings, attachments } = {}) {
  const web = settings && settings.webEnabled !== false;
  const sandbox = settings && settings.sandboxEnabled !== false;
  const names = (attachments || []).map((a) => a && a.name).filter(Boolean).slice(0, 8);
  const body = String(text || '').trim().slice(0, 4000);
  const lines = [
    `Chat model: ${model || 'unknown'}. Web search toggle: ${web ? 'on' : 'off'}. Code sandbox: ${sandbox ? 'on' : 'off'}.`,
    body ? `User request:\n${body}` : 'User request: (empty, attachments only)',
  ];
  if (names.length) lines.push(`Attachments: ${names.join(', ')}`);
  return lines.join('\n').slice(0, 6000);
}

export function summarizePlan(answers) {
  if (!answers) return '';
  const route = choiceOf(answers, 'route') || 'chat';
  const search = noulOf(answers, 'need_search');
  const code = noulOf(answers, 'need_code');
  const image = noulOf(answers, 'need_image');
  const dispatch = noulOf(answers, 'need_dispatch');
  const diff = scoreOf(answers, 'difficulty');
  const bits = [route];
  if (search != null && search >= 0.55) bits.push('检索');
  if (code != null && code >= 0.55) bits.push('沙箱');
  if (image != null && image >= 0.55) bits.push('生图');
  if (dispatch != null && dispatch >= 0.55) bits.push('委派');
  if (diff != null) bits.push(`难度 ${Number(diff).toFixed(1).replace(/\.0$/, '')}`);
  return bits.join(' · ');
}

export function formatPlanNote(answers, { webEnabled, sandboxEnabled, thinking, reasoningLevel } = {}) {
  if (!answers) return '';
  const route = choiceOf(answers, 'route') || 'chat';
  const conf = confidenceOf(answers, 'route');
  const search = noulOf(answers, 'need_search');
  const code = noulOf(answers, 'need_code');
  const image = noulOf(answers, 'need_image');
  const dispatch = noulOf(answers, 'need_dispatch');
  const diff = scoreOf(answers, 'difficulty');
  const pct = (v) => v == null ? '?' : `${Math.round(v * 100)}%`;
  const lines = [
    '【Jev 决策】下面是 TypeSafe Jev（System One）对本轮对话类型与工具路径的参考建议（对话类型仅为 Agent 提供策略建议，不限制输出 token 长度；思考等级仅决定思考深度；与用户开关冲突时，开关优先）：',
    `- 建议路径：${route}${conf != null ? `（置信 ${pct(conf)}）` : ''}；检索 ${pct(search)} · 代码 ${pct(code)} · 生图 ${pct(image)} · 委派 ${pct(dispatch)}${diff != null ? ` · 难度 ${Number(diff).toFixed(1)}/5` : ''}`,
  ];
  if (route === 'search' || (search != null && search >= 0.65)) {
    if (webEnabled !== false) {
      lines.push('- 本题需要实时事实：工具表提供 search_web 时先检索；需要核对来源时用 fetch_url，长文档可用 crawl_site 限量抓取。无相应工具或没抓到就不要说「已联网」。');
    } else {
      lines.push('- 本题需要实时事实，但用户关了联网：明确说无法核实，不要用记忆里的数字冒充刚查到的。');
    }
  } else if (search != null && search < 0.25 && webEnabled !== false) {
    lines.push('- 本题大概率不需要实时检索。不要为了检索而检索；没有新事实要核实时直接答。');
  }
  if (route === 'image' || (image != null && image >= 0.6)) {
    lines.push('- 只有用户要照片/插画/海报/图标等栅格画面时才调用 generate_image；统计图、物理关系图、流程图、思维导图、架构图必须用 SVG / Mermaid / DOT / :::chart / :::flow / :::mind，禁止走生图模型。');
  }
  if (code != null && code >= 0.6) {
    lines.push(sandboxEnabled === false
      ? '- 本题适合跑代码，但沙箱关着：不要假装执行，说明需要打开沙箱，或改用不可执行的推理。'
      : '- 涉及计算/验证：建议写进沙箱执行，不要口算。');
  } else if (route === 'chat' && (code == null || code < 0.25) && (dispatch == null || dispatch < 0.3)) {
    lines.push('- 本题可以直接回答。建议不用为了用工具而用工具，也不要无故委派。');
  }
  const lv = String(reasoningLevel || 'medium').toLowerCase();
  const canDispatch = thinking !== false && (lv === 'max' || lv === 'ultra');
  if (dispatch != null && dispatch >= 0.7) {
    lines.push(canDispatch
      ? (lv === 'ultra'
        ? '- 本题适合委派：Ultra 下建议并行派出相关专家，收齐后交叉核对再交，不要只派一个就停。'
        : '- 本题适合委派子智能体：建议主动 dispatch_subagent，task 必须自包含。')
      : '- 本题适合专业视角，但当前思考级别未到 Max/Ultra，不能委派；请你自己直接做。');
  }
  if (diff != null && diff >= 4) {
    lines.push('- 高难度：先在内部想清步骤；互不依赖的工具建议在同一轮并行发出。');
  }
  return lines.join('\n');
}

export async function planTurn({ apiKey, text, model, settings, attachments, signal, timeoutMs } = {}) {
  const state = buildTurnState({ text, model, settings, attachments });
  const r = await askJev({ apiKey, state, questions: TURN_QUESTIONS, signal, timeoutMs });
  if (!r.ok) return r;
  const answers = r.answers;
  return {
    ok: true,
    model: r.model,
    answers,
    usage: r.usage,
    route: choiceOf(answers, 'route') || 'chat',
    routeConfidence: confidenceOf(answers, 'route'),
    needSearch: noulOf(answers, 'need_search'),
    needCode: noulOf(answers, 'need_code'),
    needImage: noulOf(answers, 'need_image'),
    needDispatch: noulOf(answers, 'need_dispatch'),
    difficulty: scoreOf(answers, 'difficulty'),
    summary: summarizePlan(answers),
    note: formatPlanNote(answers, {
      webEnabled: !(settings && settings.webEnabled === false),
      sandboxEnabled: !(settings && settings.sandboxEnabled === false),
      thinking: !(settings && settings.thinking === false),
      reasoningLevel: settings && settings.reasoningLevel,
    }),
  };
}

// ─── Jev 文本内容安全审核（替代传统本地词表/Toxicity 审核）────────────────
export const MODERATION_QUESTIONS = {
  unsafe: noul(
    'Does this user message violate safety policy (CSAM/minors sexual content, suicide or self-harm encouragement/instruction, mass violence/terrorism/bomb/weapon-making instructions, severe cybercrime/malware/ransomware creation, or extreme hate/threats) as opposed to benign chat, coding, education, creative writing, or defensive security?',
    'Severe policy violation that must be blocked immediately',
    'Safe or benign request (normal conversation, coding, academic, creative fiction, or defensive security)',
  ),
  category: choice('Primary safety category of the user message.', {
    safe: 'Benign request: normal chat, programming, math, translation, creative writing, or general knowledge',
    sexual_minors: 'Child sexual exploitation or abuse (CSAM)',
    self_harm: 'Encouraging or instructing suicide or self-harm',
    violence_terror: 'Terrorism, mass violence, or instructions to build bombs/weapons/poisons',
    cyber_crime: 'Malware, ransomware, exploit payloads, or illegal hacking instructions',
    hate_harassment: 'Severe hate speech, doxxing, or violent threats against people',
  }),
  severity: score('How harmful or policy-violating is this user message?', [
    'completely benign everyday or technical request',
    'sensitive topic discussed safely or academically',
    'borderline or mildly inappropriate language',
    'clear policy violation requesting harmful instructions',
    'extreme/imminent harm (CSAM, suicide instruction, bomb/terror attack, ransomware)',
  ]),
};

export function buildModerationState(text) {
  const body = String(text || '').trim().slice(0, 12000);
  return `Task: Content safety moderation for user input.\nUser input:\n${body || '(empty)'}`;
}

export async function moderateTextWithJev({ apiKey, text, signal, timeoutMs = JEV_TIMEOUT_MS } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: true, blocked: false, source: 'jev', category: 'safe', unsafe: 0, severity: 0, labels: [] };
  const r = await askJev({
    apiKey,
    state: buildModerationState(raw),
    questions: MODERATION_QUESTIONS,
    signal,
    timeoutMs,
  });
  if (!r.ok) return r;
  const unsafe = noulOf(r.answers, 'unsafe');
  const category = choiceOf(r.answers, 'category') || 'safe';
  const confidence = confidenceOf(r.answers, 'category');
  const severity = scoreOf(r.answers, 'severity');
  const blocked = (unsafe != null && unsafe >= 0.7)
    || (category !== 'safe' && (unsafe == null || unsafe >= 0.5) && (severity == null || severity >= 2.5));
  return {
    ok: true,
    blocked,
    source: 'jev',
    model: r.model || JEV_MODEL,
    unsafe,
    category,
    confidence,
    severity,
    labels: blocked ? [{ label: category !== 'safe' ? category : 'policy_violation', score: unsafe ?? 1 }] : [],
    answers: r.answers,
    usage: r.usage,
  };
}

