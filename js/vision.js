// 识图工具专用通道：对话模型全部按纯文本发送，图片只走 deepseek-v4-flash-vision-exp。
// 独立文件，避免给 api.js 新增具名导出（Pages 混版缓存会白屏）。
import { authHeaders } from './api.js?v=2026.10.5.1';
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
  const u = json && json.usage ? {
    input: Number(json.usage.prompt_tokens ?? json.usage.input_tokens ?? 0) || 0,
    output: Number(json.usage.completion_tokens ?? json.usage.output_tokens ?? 0) || 0,
  } : null;
  return { text, finishReason, usage: u };
}

// 视觉接口兼容 MIME 白名单（DeepSeek/OpenAI/Claude/Gemini 共通支持的格式）：
//   image/jpeg, image/png, image/gif, image/webp
// 其它格式（bmp/ico/tiff/avif/heic/apng/svg）在此函数里先转成 image/png，避免 400。
const VISION_COMPAT_MIME = /^image\/(jpe?g|png|gif|webp)$/i;
async function normalizeForVision(u) {
  if (!/^data:image\//i.test(String(u || ''))) return u; // http(s) URL 原样传
  const mm = /^data:([^;]+);base64,/.exec(u);
  const mime = mm ? mm[1].toLowerCase() : '';
  if (VISION_COMPAT_MIME.test(mime)) return u;
  // 不在白名单里 → 画到 <img> 再导出成 PNG；SVG 也走这一条（SVG 里可以含外链，直接给模型风险）
  try {
    const dataURL = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          // 限制最大边 2048，省 token 又避免 OOM
          const maxSide = 2048;
          let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
          if (w > maxSide || h > maxSide) {
            const r = Math.min(maxSide / w, maxSide / h);
            w = Math.round(w * r); h = Math.round(h * r);
          }
          canvas.width = Math.max(1, w); canvas.height = Math.max(1, h);
          const ctx = canvas.getContext('2d');
          if (mime === 'image/svg+xml') ctx.fillStyle = '#fff'; // SVG 透明底填白，避免黑底
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/png'));
        } catch (e) { reject(e); }
      };
      img.onerror = () => reject(new Error('图片无法解码为 PNG（可能是不支持的容器）'));
      img.src = u;
    });
    return dataURL;
  } catch (err) {
    // 兜底：解码失败就原样传（可能 400，但至少不拦流程）
    console.warn('[vision] normalize image failed, fall through:', err);
    return u;
  }
}

/** 用识图模型看一张或多张图（data URL 或 http URL），返回模型文字。长度上限会自动续写。 */
export async function analyzeImage({ apiKey, prompt, dataUrl, dataUrls, signal, onUsage }) {
  if (!apiKey) throw new Error('未配置 API Key');
  const rawUrls = [];
  for (const u of (Array.isArray(dataUrls) ? dataUrls : [])) {
    if (u) rawUrls.push(u);
  }
  if (dataUrl && !rawUrls.includes(dataUrl)) rawUrls.unshift(dataUrl);
  if (!rawUrls.length) throw new Error('没有可分析的图片');
  // 把不被模型支持的格式先转成 PNG（SVG/BMP/ICO/TIFF/AVIF/HEIC/APNG 等）
  const urls = await Promise.all(rawUrls.map(normalizeForVision));
  const text = String(prompt || DEFAULT_VISION_PROMPT).trim() || DEFAULT_VISION_PROMPT;
  const content = [{
    type: 'text',
    text: urls.length > 1 ? `${text}\n（共 ${urls.length} 张，按顺序分别分析每一张，用 Markdown 二级标题标出第几张。）` : text,
  }];
  for (const u of urls) content.push({ type: 'image_url', image_url: { url: u } });
  const messages = [{ role: 'user', content }];
  let disableReasoning = true;
  const parts = [];
  let totalInput = 0;
  let totalOutput = 0;
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
    if (shot.usage) {
      totalInput += shot.usage.input;
      totalOutput += shot.usage.output;
    }
    parts.push(shot.text);
    if (!isLengthStop(shot.finishReason)) break;
    messages.push({ role: 'assistant', content: shot.text });
    messages.push({ role: 'user', content: '上次输出因长度上限被截断。请从中断处紧接着继续写完，不要重复已输出的内容，不要道歉或加前言。' });
  }
  const fullText = parts.join('');
  if (typeof onUsage === 'function') {
    const estIn = totalInput || (urls.length * 1600 + Math.ceil(text.length / 2));
    const estOut = totalOutput || Math.ceil(fullText.length / 2);
    try { onUsage({ model: VISION_TOOL_MODEL, input: estIn, output: estOut, imageCount: urls.length }); } catch { /* noop */ }
  }
  return fullText;
}
