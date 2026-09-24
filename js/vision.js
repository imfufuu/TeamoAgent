// 识图工具专用通道：对话模型全部按纯文本发送，图片只走 deepseek-v4-flash-vision-exp。
// 独立文件，避免给 api.js 新增具名导出（Pages 混版缓存会白屏）。
import { authHeaders } from './api.js';
import { gatewayBase, otherGatewayBase, setGatewayBase, isNetworkError } from './endpoint.js';

export const VISION_TOOL_MODEL = 'deepseek-v4-flash-vision-exp';

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

/** 用识图模型看一张图（data URL 或 http URL），返回模型文字。 */
export async function analyzeImage({ apiKey, prompt, dataUrl, signal }) {
  if (!apiKey) throw new Error('未配置 API Key');
  if (!dataUrl) throw new Error('没有可分析的图片');
  const text = String(prompt || '请描述这张图片的内容，并指出关键文字、物体与布局。').trim();
  const body = {
    model: VISION_TOOL_MODEL,
    stream: false,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    }],
  };
  const res = await postChat(body, apiKey, signal);
  const raw = await res.text();
  if (!res.ok) {
    let msg = raw.slice(0, 400);
    try { const j = JSON.parse(raw); msg = (j.error && j.error.message) || msg; } catch { /* 原文 */ }
    throw new Error(`识图接口 ${res.status}：${msg}`);
  }
  let json;
  try { json = JSON.parse(raw); } catch { throw new Error('识图接口返回了非 JSON'); }
  const out = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (!out) throw new Error('识图接口没有返回内容');
  return String(out);
}
