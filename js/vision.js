// 识图工具专用通道：对话模型全部按纯文本发送，图片只走 deepseek-v4-flash-vision-exp。
// 独立文件，避免给 api.js 新增具名导出（Pages 混版缓存会白屏）。
import { authHeaders } from './api.js';
import { gatewayBase, otherGatewayBase, setGatewayBase, isNetworkError } from './endpoint.js';

export const VISION_TOOL_MODEL = 'deepseek-v4-flash-vision-exp';

// 网关对 OpenAI 兼容接口未传 max_tokens 时经常默认 1k/4k，OCR 会被 finish_reason=length 砍半截。
const VISION_MAX_TOKENS = 16384;
const VISION_CONTINUES = 4;
const DEFAULT_VISION_PROMPT = '请完整分析这张图片：按阅读顺序转录全部可见文字（OCR，一个字都不要省略、不要总结成摘要），表格按行列写出，并说明关键物体、布局、数字与图表。文字多就全部写完。';

async function postChat(body, apiKey, signal) {
  const headers = { 'Content-Type': 'application/json', ...authHeaders('openai', apiKey) };
  const tryFetch = (base) => fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal });
  const base = gatewayBase();
  try {
    return await tryFetch(base);
  } catch (err) {
    if (signal && signal.aborted) throw err;
    if (!isNetworkError(err)) throw err;
    const alt = otherGatewayBase();
    const res = await tryFetch(alt);
    setGatewayBase(alt, 'failover');
    return res;
  }
}

function extractChoiceText(json) {
  const choice = json && json.choices && json.choices[0];
  const msg = (choice && choice.message) || {};
  let c = msg.content;
  if (Array.isArray(c)) {
    c = c.map((p) => {
      if (typeof p === 'string') return p;
      if (p && typeof p.text === 'string') return p.text;
      if (p && typeof p.content === 'string') return p.content;
      return '';
    }).join('');
  }
  c = c == null ? '' : String(c);
  if (!c.trim()) {
    const alt = msg.reasoning_content || msg.reasoning || (choice && choice.text);
    if (alt) c = String(alt);
  }
  const finishReason = String((choice && (choice.finish_reason || choice.finishReason)) || '');
  return { text: c, finishReason };
}

function isLengthStop(reason) {
  return /^(length|max_tokens|max_output_tokens)$/i.test(String(reason || ''));
}

async function oneShot(body, apiKey, signal) {
  const res = await postChat(body, apiKey, signal);
  const raw = await res.text();
  if (!res.ok) {
    let msg = raw.slice(0, 400);
    try { const j = JSON.parse(raw); msg = (j.error && j.error.message) || msg; } catch { /* 原文 */ }
    const err = new Error(`识图接口 ${res.status}：${msg}`);
    err.status = res.status;
    err.body = raw;
    throw err;
  }
  let json;
  try { json = JSON.parse(raw); } catch { throw new Error('识图接口返回了非 JSON'); }
  const { text, finishReason } = extractChoiceText(json);
  if (!text) throw new Error('识图接口没有返回内容');
  return { text, finishReason };
}

/** 用识图模型看一张图（data URL 或 http URL），返回模型文字。长度上限会自动续写。 */
export async function analyzeImage({ apiKey, prompt, dataUrl, signal }) {
  if (!apiKey) throw new Error('未配置 API Key');
  if (!dataUrl) throw new Error('没有可分析的图片');
  const text = String(prompt || DEFAULT_VISION_PROMPT).trim() || DEFAULT_VISION_PROMPT;
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image_url', image_url: { url: dataUrl } },
    ],
  }];
  let disableReasoning = true;
  const parts = [];
  for (let i = 0; i < VISION_CONTINUES; i++) {
    const body = {
      model: VISION_TOOL_MODEL,
      stream: false,
      max_tokens: VISION_MAX_TOKENS,
      messages,
    };
    if (disableReasoning) body.reasoning = false;
    let shot;
    try {
      shot = await oneShot(body, apiKey, signal);
    } catch (err) {
      if (disableReasoning && err && err.status === 400 && /reasoning|thinking/i.test(String(err.body || err.message || ''))) {
        disableReasoning = false;
        i -= 1;
        continue;
      }
      throw err;
    }
    parts.push(shot.text);
    if (!isLengthStop(shot.finishReason)) break;
    messages.push({ role: 'assistant', content: shot.text });
    messages.push({ role: 'user', content: '上次输出因长度上限被截断。请从中断处紧接着继续写完，不要重复已输出的内容，不要道歉或加前言。' });
  }
  return parts.join('');
}
