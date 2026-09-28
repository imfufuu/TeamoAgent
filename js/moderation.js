// ─── 本地内容审核：Toxicity + USE 语义 + NSFWJS（不调用网关模型）────────────
// 模型随项目放在 assets/moderation/，用户发送后在浏览器本地运行。
// 当前策略：成人色情也审核；文本保持较宽松阈值，图片 NSFW 达阈值即拦。

export const TEXT_MODERATION_MODEL = 'local:tfjs-toxicity-1.2.2+use-semantic-policy-v2';
export const IMAGE_MODERATION_MODEL = 'local:nudenet-320n+nsfwjs-mobilenet-v2-mid';
export const TEXT_MODERATION_THRESHOLD = 0.9;
export const TEXT_ADULT_SEX_THRESHOLD = 0.92;
export const IMAGE_MODERATION_THRESHOLD = 0.70;
export const MODERATION_TIMEOUT_MS = 45000;      // 纯文本回合总预算
export const IMAGE_TURN_BUDGET_MS = 90000;       // 带图回合总预算（模型资源大，慢网络放宽）

const TIMEOUTS = Object.freeze({
  textModel: 30000,
  textClassify: 12000,
  semantic: 16000,
  imageModel: 60000,
  imageDecode: 8000,
  imageFetch: 10000,
  imageClassify: 12000,
  nudityModel: 45000,
  nudityDetect: 12000,
});

const TFJS_URL = '../assets/vendor/tf.min.js';
const TOXICITY_URL = '../assets/vendor/toxicity.local.min.js';
const USE_URL = '../assets/vendor/use.min.js';
const USE_MODEL_URL = '../assets/moderation/text-use/model.json';
const USE_VOCAB_URL = '../assets/moderation/text-use/vocab.json';
const NSFWJS_URL = '../assets/vendor/nsfwjs.min.js';
const NSFW_MODEL_URL = '../assets/moderation/nsfw-mobilenet-v2-mid/model.json';
// onnxruntime-web 1.30：入口 bundle + 动态 import 的 .mjs 胶水 + wasm 二进制（三者必须同版本）。
// 1.17 系在新版 Chromium 上 session 创建会静默 abort（裸数字 reject），不得回退。
const ORT_URL = '../assets/vendor/ort.min.js';
const ORT_WASM_THREAD_URL = '../assets/vendor/ort-wasm-simd-threaded.wasm';
const NUDENET_MODEL_URL = '../assets/moderation/nudenet-320n/model.onnx';
// NudeNet 320n 官方推理分辨率即 320；曾降到 224 导致召回大幅下降（明显裸露漏检），禁止再降。
const NUDENET_INPUT_SIZE = 320;
const MAX_REMOTE_IMAGE_BYTES = 6 * 1024 * 1024;
const IMAGE_URL_EXT_RE = /\.(?:png|jpe?g|webp|gif)(?:[?#]|$)/i;


let tfReady;
let toxicityReady;
let semanticReady;
let semanticVectorsReady;
let nsfwReady;
let nudityReady;

// tfjs 多拷贝注册（nsfwjs/toxicity 内置各自的 tf）会刷几百条
// "The kernel 'X' ... is already registered" / "Platform ... already been set" 噪音警告，
// 且内容 100% 无操作价值。加载窗口内临时静音 console.warn，结束即恢复。
async function withMutedWarn(fn) {
  const orig = console.warn;
  console.warn = () => {};
  try { return await fn(); }
  finally { console.warn = orig; }
}

const testHooks = () => (globalThis && globalThis.__TEamoModerationTestHooks) || {};

// ── β 诊断日志（构建 2026.9.27.12）────────────────────────────────────────
// 背景：图片审核超时会按设计 fail-open 放行，但全链路无可见日志——「审核很久最后图进了沙箱」
// 完全无法归因。β 版在每个阶段打点：控制台 [Teamo·审核] 前缀 + 环形缓冲 + 全局导出。
// 用法：控制台执行 __teamoModDump() 复制完整时间线；__teamoModLog 为原始数组。
const MOD_LOG_MAX = 400;
const modLog = [];
// β 浮窗订阅：debugwindow.js 注册监听器，mlog 每条同时推给浮窗实时上屏
const modLogListeners = new Set();
function mlog(stage, data = {}) {
  const entry = { t: new Date().toISOString().slice(11, 23), stage, ...data };
  modLog.push(entry);
  if (modLog.length > MOD_LOG_MAX) modLog.splice(0, modLog.length - MOD_LOG_MAX);
  for (const fn of [...modLogListeners]) { try { fn(entry); } catch { /* 订阅者异常不影响审核 */ } }
  try { console.log('%c[Teamo·审核]%c ' + stage + ' ' + JSON.stringify(data), 'color:#c00;font-weight:700', 'color:inherit'); }
  catch { try { console.log('[Teamo·审核] ' + stage, data); } catch { /* 忽略序列化失败 */ } }
  return entry;
}
if (typeof globalThis !== 'undefined') {
  globalThis.__teamoModLog = modLog;
  globalThis.__teamoModPush = (entry) => mlog(String(entry && entry.stage || 'external'), entry || {});
  globalThis.__teamoModSubscribe = (fn) => { if (typeof fn === 'function') { modLogListeners.add(fn); return () => modLogListeners.delete(fn); } return () => {}; };
  globalThis.__teamoModDump = () => {
    for (const e of modLog) console.log(e.t, e.stage, JSON.stringify({ ...e, t: undefined, stage: undefined }));
    console.log('共 ' + modLog.length + ' 条 · 复制上面全部内容即可反馈');
    return JSON.stringify(modLog, null, 1);
  };
}
const ms = (from) => Math.round(performance.now() - from);


function abortError() {
  if (typeof DOMException === 'function') return new DOMException('Aborted', 'AbortError');
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

function isAbortError(err) {
  return err && err.name === 'AbortError';
}

function timeoutError(label) {
  const err = new Error(`${label || 'moderation'} timeout`);
  err.name = 'ModerationTimeoutError';
  return err;
}

function isTimeoutError(err) {
  return err && err.name === 'ModerationTimeoutError';
}

function timeoutFor(label, fallback) {
  const hooks = testHooks();
  const v = hooks.timeouts && hooks.timeouts[label];
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError();
}

function withAbort(promise, signal, label = 'moderation', timeoutMs = 0) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let done = false;
    let timer = null;
    const finish = (fn, val) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(val);
    };
    const onAbort = () => finish(reject, abortError());
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs > 0) timer = setTimeout(() => finish(reject, timeoutError(label)), timeoutMs);
    Promise.resolve(promise).then((v) => finish(resolve, v), (err) => finish(reject, err));
  });
}

function assetUrl(path) {
  return new URL(path, import.meta.url).href;
}

function loadScript(src) {
  if (typeof document === 'undefined') return Promise.reject(new Error('本地审核模型只能在浏览器中加载'));
  const url = assetUrl(src);
  const existing = [...document.scripts].find((s) => s.src === url);
  if (existing && existing.dataset.loaded === '1') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = existing || document.createElement('script');
    s.src = url;
    s.async = true;
    s.onload = () => { s.dataset.loaded = '1'; resolve(); };
    s.onerror = () => reject(new Error(`审核模型运行时加载失败：${url}`));
    if (!existing) document.head.appendChild(s);
  });
}

async function ensureTf() {
  if (globalThis.tf) return globalThis.tf;
  tfReady ||= loadScript(TFJS_URL).then(() => {
    if (!globalThis.tf) throw new Error('TensorFlow.js 未初始化');
    return globalThis.tf;
  });
  return tfReady;
}

async function textModel() {
  const hooks = testHooks();
  if (hooks.textModel) return hooks.textModel;
  await ensureTf();
  if (globalThis.toxicity && toxicityReady && toxicityReady.model) return toxicityReady.model;
  toxicityReady ||= withMutedWarn(() => loadScript(TOXICITY_URL)).then(async () => {
    if (!globalThis.toxicity || typeof globalThis.toxicity.load !== 'function') throw new Error('Toxicity 模型运行时未初始化');
    const labels = ['toxicity', 'severe_toxicity', 'threat', 'obscene', 'sexual_explicit'];
    const model = await globalThis.toxicity.load(TEXT_MODERATION_THRESHOLD, labels);
    return { model };
  });
  return (await toxicityReady).model;
}

async function semanticModel() {
  const hooks = testHooks();
  if (hooks.semanticModel) return hooks.semanticModel;
  await ensureTf();
  if (globalThis.use && semanticReady && semanticReady.model) return semanticReady.model;
  semanticReady ||= withMutedWarn(() => loadScript(USE_URL)).then(async () => {
    if (!globalThis.use || typeof globalThis.use.load !== 'function') throw new Error('USE 语义模型运行时未初始化');
    const model = await globalThis.use.load({ modelUrl: assetUrl(USE_MODEL_URL), vocabUrl: assetUrl(USE_VOCAB_URL) });
    return { model };
  });
  return (await semanticReady).model;
}

async function imageModel() {
  const hooks = testHooks();
  if (hooks.imageModel) return hooks.imageModel;
  await ensureTf();
  if (globalThis.nsfwjs && nsfwReady && nsfwReady.model) return nsfwReady.model;
  nsfwReady ||= withMutedWarn(async () => {
    await loadScript(NSFWJS_URL);
    if (!globalThis.nsfwjs || typeof globalThis.nsfwjs.load !== 'function') throw new Error('NSFWJS 模型运行时未初始化');
    // 官方 mobilenet_v2_mid 是 SavedModel 转出的 graph-model（非 Keras layers），
    // 必须 type:'graph' 走 loadGraphModel；缺省的 loadLayersModel 会报 Improper config format。
    const tLoad = performance.now();
    mlog('nsfwjs:model-load-start', { note: '开始加载 NSFWJS 模型（graph 格式）' });
    const model = await globalThis.nsfwjs.load(assetUrl(NSFW_MODEL_URL), { size: 224, type: 'graph' });
    mlog('nsfwjs:model-load-ready', { ms: ms(tLoad) });
    return { model };
  }).catch((err) => { mlog('nsfwjs:model-load-fail', { error: String(err && err.message || err).slice(0, 200) }); throw err; });
  return (await nsfwReady).model;
}



function isBlockedHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = m.slice(1).map((x) => Number(x));
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function normalizeImageUrl(raw) {
  const s = String(raw || '').trim().replace(/^<|>$/g, '').replace(/[，。；、]+$/g, '');
  if (!s) return '';
  if (/^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(s)) return s;
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol)) return '';
    if (isBlockedHost(u.hostname)) return '';
    return u.href;
  } catch { return ''; }
}

function textImageCandidates(text = '') {
  const body = String(text || '').slice(0, 24000);
  const out = [];
  const add = (raw, strong = false) => {
    const url = normalizeImageUrl(raw);
    if (!url) return;
    if (!strong && !/^data:image\//i.test(url) && !IMAGE_URL_EXT_RE.test(url)) return;
    if (!out.some((x) => x.url === url)) out.push({ url, strong });
  };
  body.replace(/!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^)]*["'])?\s*\)/gi, (_, a, b) => { add(a || b, true); return _; });
  body.replace(/https?:\/\/[^\s<>"'`\])]+/gi, (m) => { add(m, false); return m; });
  body.replace(/data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\s]+/gi, (m) => { add(m, true); return m; });
  return out.slice(0, 4);
}

function imageNameFromUrl(url, idx = 0) {
  try {
    const u = new URL(url);
    const last = decodeURIComponent((u.pathname.split('/').filter(Boolean).pop() || '').slice(0, 80));
    return last || `remote-image-${idx + 1}.png`;
  } catch { return `remote-image-${idx + 1}.png`; }
}

async function blobToDataUrl(blob) {
  if (typeof FileReader !== 'undefined') {
    return await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ''));
      r.onerror = () => reject(new Error('远程图片读取失败'));
      r.readAsDataURL(blob);
    });
  }
  if (blob && typeof blob.arrayBuffer === 'function' && typeof Buffer !== 'undefined') {
    const buf = Buffer.from(await blob.arrayBuffer());
    return `data:${blob.type || 'image/png'};base64,${buf.toString('base64')}`;
  }
  throw new Error('当前环境不能读取远程图片');
}

async function remoteImageToAttachment(url, signal, idx = 0) {
  if (/^data:image\//i.test(url)) return { kind: 'image', name: `inline-image-${idx + 1}.png`, dataUrl: url, source: 'text-image-url', size: Math.round(url.length * 0.75) };
  const hooks = testHooks();
  if (typeof hooks.remoteImageDataUrl === 'function') {
    const dataUrl = await hooks.remoteImageDataUrl(url);
    return { kind: 'image', name: imageNameFromUrl(url, idx), dataUrl, source: 'text-image-url', originalUrl: url, size: Math.round(String(dataUrl || '').length * 0.75) };
  }
  if (typeof fetch !== 'function') throw new Error('当前环境不能下载远程图片');
  const res = await withAbort(fetch(url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', signal }), signal, 'imageFetch', timeoutFor('imageFetch', TIMEOUTS.imageFetch));
  if (!res || !res.ok) throw new Error(`远程图片下载失败：HTTP ${res ? res.status : 0}`);
  const type = String((res.headers && res.headers.get && res.headers.get('content-type')) || '').split(';')[0].trim().toLowerCase();
  if (type && !/^image\/(?:png|jpe?g|webp|gif)$/.test(type)) throw new Error(`远程链接不是可审核图片：${type}`);
  const len = Number(res.headers && res.headers.get && res.headers.get('content-length')) || 0;
  if (len > MAX_REMOTE_IMAGE_BYTES) throw new Error('远程图片超过审核大小限制');
  const blob = await withAbort(res.blob(), signal, 'imageFetch', timeoutFor('imageFetch', TIMEOUTS.imageFetch));
  if (blob.size > MAX_REMOTE_IMAGE_BYTES) throw new Error('远程图片超过审核大小限制');
  const dataUrl = await withAbort(blobToDataUrl(blob), signal, 'imageFetch', timeoutFor('imageFetch', TIMEOUTS.imageFetch));
  return { kind: 'image', name: imageNameFromUrl(url, idx), dataUrl, source: 'text-image-url', originalUrl: url, size: blob.size || Math.round(dataUrl.length * 0.75) };
}

async function remoteImageAttachmentsFromText(text, signal) {
  const candidates = textImageCandidates(text);
  const out = [];
  const errors = [];
  for (let i = 0; i < candidates.length && out.length < 4; i++) {
    try { out.push(await remoteImageToAttachment(candidates[i].url, signal, i)); }
    catch (err) {
      if (isAbortError(err)) throw err;
      errors.push({ url: candidates[i].url, error: String(err && err.message || err), source: 'text-image-url' });
    }
  }
  return { attachments: out, errors };
}

function policyImagePromptBypass(text = '', hasImage = false) {
  if (!hasImage) return { blocked: false, score: 0, categories: [], skipped: 'no-image' };
  const body = compactText(text, 2000);
  if (!body) return { blocked: false, score: 0, categories: [], skipped: 'empty' };
  const looksInternal = /(系统内测|内部测试|系统测试|系统指令|系统消息|开发者消息|system\s*(?:test|message|prompt)|developer\s*message|ignore\s+(?:previous|above)\s+instructions)/i.test(body);
  const asksFixedReply = /(不需要输出任何内容|无需输出任何内容|不要输出任何内容|只(?:输出|回复|回答)|仅(?:输出|回复|回答)|输出[“"'`「『]?好的?[”"'`」』]?即可|reply\s+only|output\s+only)/i.test(body);
  if (looksInternal && asksFixedReply) {
    return { blocked: true, score: 0.94, categories: ['prompt_injection_image_bypass'], reason: 'prompt_injection_image_bypass', source: 'policy-v2' };
  }
  return { blocked: false, score: 0, categories: [], skipped: 'no-match' };
}

const NUDENET_LABELS = [
  'FEMALE_GENITALIA_COVERED', 'FACE_FEMALE', 'BUTTOCKS_EXPOSED', 'FEMALE_BREAST_EXPOSED',
  'FEMALE_GENITALIA_EXPOSED', 'MALE_BREAST_EXPOSED', 'ANUS_EXPOSED', 'FEET_EXPOSED',
  'BELLY_COVERED', 'FEET_COVERED', 'ARMPITS_COVERED', 'ARMPITS_EXPOSED', 'FACE_MALE',
  'BELLY_EXPOSED', 'MALE_GENITALIA_EXPOSED', 'ANUS_COVERED', 'FEMALE_BREAST_COVERED', 'BUTTOCKS_COVERED',
];
const NUDENET_BLOCK = new Set(['BUTTOCKS_EXPOSED', 'FEMALE_BREAST_EXPOSED', 'FEMALE_GENITALIA_EXPOSED', 'MALE_GENITALIA_EXPOSED', 'ANUS_EXPOSED']);

async function nudityDetector() {
  const hooks = testHooks();
  if (hooks.nudityDetector) return hooks.nudityDetector;
  if (globalThis.ort && nudityReady && nudityReady.session) return nudityReady;
  nudityReady ||= loadScript(ORT_URL).then(async () => {
    if (!globalThis.ort || !globalThis.ort.InferenceSession) throw new Error('ONNX Runtime Web 未初始化');
    // GitHub Pages 没有 COOP/COEP，禁用多线程，避免 ORT 等待 SharedArrayBuffer/worker 造成卡住。
    // wasmPaths 必须是「目录前缀」字符串：ORT 1.30 会自行拼接 ort-wasm-simd-threaded.mjs/.wasm。
    globalThis.ort.env.wasm.numThreads = 1;
    globalThis.ort.env.wasm.wasmPaths = assetUrl('../assets/vendor/');
    const tLoad = performance.now();
    mlog('nudity:ort-session-create', { note: '开始创建 ORT 会话（含 wasm+onnx 加载）' });
    const session = await globalThis.ort.InferenceSession.create(assetUrl(NUDENET_MODEL_URL), {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    mlog('nudity:ort-session-ready', { ms: ms(tLoad) });
    return { session, inputName: session.inputNames && session.inputNames[0] };
  }).catch((err) => { mlog('nudity:ort-session-fail', { error: String(err && err.message || err).slice(0, 200) }); throw err; });
  return nudityReady;
}

function imageSize(img) {
  return { width: img.naturalWidth || img.videoWidth || img.width || 0, height: img.naturalHeight || img.videoHeight || img.height || 0 };
}

// 审核用最大边长：NudeNet 输入 320 / NSFWJS 输入 224，1280 已远超模型需要；
// 高分辨率截图/照片先等比缩小，省掉 NSFWJS 全尺寸 fromPixels 与二次插值的耗时
const MOD_IMAGE_MAX_DIM = 1280;
function downscaleForModeration(img) {
  const { width, height } = imageSize(img);
  const mx = Math.max(width, height);
  if (!mx || mx <= MOD_IMAGE_MAX_DIM || typeof document === 'undefined') return img;
  try {
    const scale = MOD_IMAGE_MAX_DIM / mx;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(width * scale));
    c.height = Math.max(1, Math.round(height * scale));
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  } catch { return img; }
}

function makeNudeNetInput(img) {
  if (typeof document === 'undefined') throw new Error('当前环境不能进行 NudeNet 图片预处理');
  const { width, height } = imageSize(img);
  if (!(width > 0 && height > 0)) throw new Error('图片尺寸无效');
  const maxSize = Math.max(width, height);
  const square = document.createElement('canvas');
  square.width = maxSize; square.height = maxSize;
  const sctx = square.getContext('2d', { willReadFrequently: true });
  sctx.fillStyle = '#000'; sctx.fillRect(0, 0, maxSize, maxSize);
  sctx.drawImage(img, 0, 0, width, height);
  const canvas = document.createElement('canvas');
  canvas.width = NUDENET_INPUT_SIZE; canvas.height = NUDENET_INPUT_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(square, 0, 0, NUDENET_INPUT_SIZE, NUDENET_INPUT_SIZE);
  const rgba = ctx.getImageData(0, 0, NUDENET_INPUT_SIZE, NUDENET_INPUT_SIZE).data;
  const input = new Float32Array(1 * 3 * NUDENET_INPUT_SIZE * NUDENET_INPUT_SIZE);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    input[p] = rgba[i] / 255;
    input[NUDENET_INPUT_SIZE * NUDENET_INPUT_SIZE + p] = rgba[i + 1] / 255;
    input[2 * NUDENET_INPUT_SIZE * NUDENET_INPUT_SIZE + p] = rgba[i + 2] / 255;
  }
  return { input, width, height, xPad: maxSize - width, yPad: maxSize - height };
}

function iou(a, b) {
  const ax2 = a[0] + a[2], ay2 = a[1] + a[3], bx2 = b[0] + b[2], by2 = b[1] + b[3];
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]), x2 = Math.min(ax2, bx2), y2 = Math.min(ay2, by2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}

function nms(rows, threshold = 0.45) {
  const keep = [];
  const sorted = [...rows].sort((a, b) => b.score - a.score);
  for (const row of sorted) {
    if (!keep.some((k) => iou(k.box, row.box) > threshold)) keep.push(row);
  }
  return keep;
}

function postprocessNudeNet(output, meta) {
  const tensor = Object.values(output || {})[0];
  if (!tensor || !tensor.data || !tensor.dims) return [];
  const dims = tensor.dims;
  const data = tensor.data;
  let rows = 0, channels = 0, get;
  if (dims.length === 3 && dims[1] <= 64) {
    channels = dims[1]; rows = dims[2]; get = (r, c) => data[c * rows + r];
  } else if (dims.length === 3) {
    rows = dims[1]; channels = dims[2]; get = (r, c) => data[r * channels + c];
  } else return [];
  const raw = [];
  for (let r = 0; r < rows; r++) {
    let classId = -1, score = 0;
    for (let c = 4; c < channels; c++) {
      const s = Number(get(r, c)) || 0;
      if (s > score) { score = s; classId = c - 4; }
    }
    if (score < 0.20 || classId < 0) continue;
    let x = Number(get(r, 0)) || 0, y = Number(get(r, 1)) || 0, w = Number(get(r, 2)) || 0, h = Number(get(r, 3)) || 0;
    x -= w / 2; y -= h / 2;
    x = x * (meta.width + meta.xPad) / NUDENET_INPUT_SIZE;
    y = y * (meta.height + meta.yPad) / NUDENET_INPUT_SIZE;
    w = w * (meta.width + meta.xPad) / NUDENET_INPUT_SIZE;
    h = h * (meta.height + meta.yPad) / NUDENET_INPUT_SIZE;
    x = Math.max(0, Math.min(x, meta.width));
    y = Math.max(0, Math.min(y, meta.height));
    w = Math.max(0, Math.min(w, meta.width - x));
    h = Math.max(0, Math.min(h, meta.height - y));
    raw.push({ class: NUDENET_LABELS[classId] || `CLASS_${classId}`, score, box: [x, y, w, h] });
  }
  return nms(raw.filter((x) => x.score >= 0.25)).map((x) => ({ ...x, box: x.box.map((v) => Math.round(v)) }));
}

export function policyNudityDecision(detections = []) {
  const hits = (detections || []).filter((d) => NUDENET_BLOCK.has(d.class) && Number(d.score) >= 0.32);
  const categories = hits.length ? ['explicit_nudity', ...new Set(hits.map((d) => d.class.toLowerCase()))] : [];
  const score = Math.max(0, ...hits.map((d) => Number(d.score) || 0));
  return { blocked: hits.length > 0, score, categories, reason: categories.join(', '), source: 'local:nudenet-320n', detections: hits.slice(0, 8) };
}

async function moderateNudityImage(img, signal) {
  const hooks = testHooks();
  if (typeof hooks.nudityDecision === 'function') return hooks.nudityDecision(img);
  const t0 = performance.now();
  const det = await withAbort(nudityDetector(), signal, 'nudityModel', timeoutFor('nudityModel', TIMEOUTS.nudityModel));
  const meta = makeNudeNetInput(img);
  const ort = globalThis.ort;
  const tensor = new ort.Tensor('float32', meta.input, [1, 3, NUDENET_INPUT_SIZE, NUDENET_INPUT_SIZE]);
  const tInfer = performance.now();
  const output = await withAbort(det.session.run({ [det.inputName || det.session.inputNames[0]]: tensor }), signal, 'nudityDetect', timeoutFor('nudityDetect', TIMEOUTS.nudityDetect));
  const decision = policyNudityDecision(postprocessNudeNet(output, meta));
  mlog('nudity:result', {
    ms: ms(t0), inferMs: ms(tInfer),
    blocked: decision.blocked, score: Math.round((decision.score || 0) * 1000) / 1000,
    detections: (decision.detections || []).map((d) => `${d.class}@${d.score}${d.box ? ` [${d.box.join(',')}]` : ''}`) || undefined,
  });
  return decision;
}


function prefetchImageModerationAssets() {
  if (typeof document === 'undefined') return;
  // β：TFJS + NSFWJS 资源也纳入预热——发送时冷加载 ~8.4MB 是超时 fail-open 的主因之一。
  for (const href of [ORT_URL, ORT_WASM_THREAD_URL, NUDENET_MODEL_URL, NSFWJS_URL, NSFW_MODEL_URL]) {
    const url = assetUrl(href);
    if ([...document.querySelectorAll('link[rel="prefetch"],link[rel="preload"]')].some((x) => x.href === url)) continue;
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.href = url;
    if (/\.wasm(?:\?|$)/.test(url)) link.as = 'fetch';
    document.head.appendChild(link);
  }
}

// 显式预取（带 HTTP 缓存）：ORT/tf 内部自己 fetch 时不报进度，这里先拉一遍，
// 浮窗能看到每个文件的字节数与耗时；随后运行时内部请求直接命中缓存。慢网络下这就是「审核要等多久」的可见答案。
async function fetchWarm(href, label) {
  const t0 = performance.now();
  try {
    const res = await fetch(assetUrl(href), { cache: 'force-cache' });
    const buf = await res.arrayBuffer();
    mlog('prewarm:fetch', { file: label, KB: Math.round(buf.byteLength / 1024), ms: ms(t0) });
  } catch (err) {
    mlog('prewarm:fetch-fail', { file: label, error: String(err && err.message || err).slice(0, 140) });
  }
}

const NSFW_SHARD_URLS = [
  '../assets/moderation/nsfw-mobilenet-v2-mid/group1-shard1of2',
  '../assets/moderation/nsfw-mobilenet-v2-mid/group1-shard2of2',
];
const TOXIC_SHARD_URLS = [1, 2, 3, 4, 5, 6, 7].map((i) => `../assets/moderation/text-toxic/group1-shard${i}of7`);

function prewarmImageModeration() {
  if (typeof document === 'undefined') return Promise.resolve(false);
  const t0 = performance.now();
  mlog('prewarm:start', { note: '先显式下载全部资源（可见进度），再创建两个模型会话' });
  prefetchImageModerationAssets();
  const warmup = (async () => {
    await Promise.all([
      fetchWarm(ORT_WASM_THREAD_URL, 'ort-wasm'),
      fetchWarm(NUDENET_MODEL_URL, 'nudenet.onnx'),
      fetchWarm(TFJS_URL, 'tf.js'),
      fetchWarm(NSFWJS_URL, 'nsfwjs.js'),
      fetchWarm(NSFW_MODEL_URL, 'nsfw-model.json'),
      fetchWarm('../assets/moderation/text-toxic/model.json', 'toxic-model.json'),
      ...NSFW_SHARD_URLS.map((u) => fetchWarm(u, 'nsfw-shard')),
      ...TOXIC_SHARD_URLS.map((u) => fetchWarm(u, 'toxic-shard')),
    ]);
    const nudity = nudityDetector().then(() => true).catch(() => false);
    const nsfw = imageModel().then(() => true).catch((err) => { mlog('prewarm:nsfwjs-fail', { error: String(err && err.message || err).slice(0, 160) }); return false; });
    // 文本 Toxicity（28MB）也预热：英文消息首审不再冷启动；USE 仍按需（仅英文触发）
    const toxic = textModel().then(() => true).catch((err) => { mlog('prewarm:toxicity-fail', { error: String(err && err.message || err).slice(0, 160) }); return false; });
    return Promise.all([nudity, nsfw, toxic]).then(([n, s, t]) => [n, s, t]);
  })();
  return warmup.then(([n, s, t]) => {
    mlog('prewarm:done', { ms: ms(t0), nudenet: n, nsfwjs: s, toxicity: t });
    return n || s || t;
  });
}

if (typeof globalThis !== 'undefined') {
  globalThis.__teamoPrewarmImageModeration = prewarmImageModeration;
  const idle = globalThis.requestIdleCallback || ((fn) => setTimeout(fn, 2500));
  if (typeof document !== 'undefined') idle(() => prefetchImageModerationAssets());
}

const zhSex = '(色情|情色|性爱|性交|做爱|裸照|裸体|露骨|淫秽|性行为|成人视频|黄片|约炮|裸聊|成人视频|成人小说)';
const enSex = '(sex|sexual|porn|porno|nude|naked|nsfw|explicit|erotic|smut|xxx|intercourse)';
const minor = '(未成年|儿童|孩子|小孩|幼女|幼童|小学生|初中生|萝莉|正太|loli|shota|child|kid|minor|underage|teen(?:ager)?)';
const make = '(制作|制造|合成|提炼|种植|配方|教程|步骤|购买|贩卖|走私|邮寄|藏匿|自制|改装|绕过|how to|make|buy|sell|traffic|smuggle|manufacture)';
const hardDrug = '(冰毒|甲基苯丙胺|海洛因|可卡因|芬太尼|摇头丸|k粉|ketamine|meth|heroin|cocaine|fentanyl|mdma|ecstasy|lsd)';
const gun = '(枪|手枪|步枪|子弹|弹药|消音器|炸弹|爆炸物|土枪|火器|gun|firearm|pistol|rifle|ammo|ammunition|silencer|bomb|explosive)';
const massHarm = '(屠杀|灭绝|恐袭|炸学校|炸地铁|枪击|报复社会|献忠|无差别|大规模杀伤|mass shooting|terror attack|kill everyone|school shooting|genocide)';

const re = (s, flags = 'i') => new RegExp(s, flags);
const TEXT_RULES = [
  { cat: 'minor_sexual', rx: re(`${minor}.{0,40}${zhSex}|${zhSex}.{0,40}${minor}|${minor}.{0,40}${enSex}|${enSex}.{0,40}${minor}`), score: 0.99 },
  { cat: 'drug_crime', rx: re(`${hardDrug}.{0,48}${make}|${make}.{0,48}${hardDrug}`), score: 0.95 },
  { cat: 'gun_crime', rx: re(`${gun}.{0,48}${make}|${make}.{0,48}${gun}`), score: 0.94 },
  { cat: 'mass_harm', rx: re(`${massHarm}|(我要|计划|准备|想去|打算).{0,32}(杀人|炸|枪击|投毒|报复社会)`), score: 0.96 },
];

const BLOCKING_TEXT = new Set(['minor_sexual', 'adult_sexual', 'drug_crime', 'gun_crime', 'mass_harm', 'credible_threat', 'public_morals', 'exploitative_sexual']);
const EDUCATIONAL_CONTEXT = /(性教育|科普|医学|健康|心理|法律|新闻|历史|论文|课堂|课程|预防|识别|举报|受害|保护|避孕|安全套|疾病|艾滋|梅毒|伦理讨论|社会学|犯罪学)/i;
const CREATIVE_EXPLICIT = /(写|生成|创作|描写|描述|续写|扮演|角色扮演|小说|故事|台词|片段|细节|露骨|刺激|成人|色情|情色|黄片|smut|erotic|porn)/i;
const SEX_ACTION_TERMS = ['性交', '做爱', '性爱', '性行为', '口交', '肛交', '裸聊', '裸照', '露骨', '黄片', '成人小说', '色情', '情色', '约炮'];
const FAMILY_TERMS = ['父女', '母子', '母女', '父子', '兄妹', '姐弟', '兄弟', '姐妹', '亲兄妹', '亲姐弟', '亲生父', '亲生母', '爸爸', '妈妈', '父亲', '母亲', '女儿', '儿子', '哥哥', '姐姐', '妹妹', '弟弟', '继父', '继母', '叔侄', '舅甥', '姑侄'];
const TABOO_TERMS = ['乱伦', '近亲相奸', '近亲性交', '禁忌关系', '家庭禁忌', '家庭乱伦', 'incest', 'fatherdaughter', 'motherson', 'siblingsex', 'familyporn'];
const DISTURBING_TERMS = ['兽交', '人兽', '恋尸', '奸尸', '尸体性行为', '尸体性交', '粪便性行为', '排泄物性癖', 'bestiality', 'zoophilia', 'necrophilia', 'coprophilia'];
const EXPLOIT_TERMS = ['偷拍', '非自愿', '强迫', '胁迫', '性侵', '强奸', '猥亵', '迷奸', '下药', 'revengeporn', 'nonconsensual', 'forcedsex', 'rape'];

// USE 词表只有 8000 个拉丁 token（0 个 CJK）：中文/日文输入会得到恒定嵌入向量
// （任意两句中文余弦 = 1.0，所有类别必然误命中）。因此语义层只放英文原型短语，
// 且 CJK 占比高的文本直接跳过语义层 —— 中文防护由 policyTextHeuristic 规则层覆盖。
const SEMANTIC_GROUPS = [
  { cat: 'adult_sexual', threshold: 0.78, phrases: ['explicit pornographic sexual content', 'graphic erotic sex scene description'] },
  { cat: 'public_morals', threshold: 0.80, phrases: ['incest sexual relationship between family members', 'bestiality necrophilia disturbing sexual behavior'] },
  { cat: 'exploitative_sexual', threshold: 0.80, phrases: ['non consensual sexual exploitation or voyeurism'] },
  { cat: 'drug_crime', threshold: 0.83, phrases: ['instructions to manufacture or traffic hard drugs'] },
  { cat: 'gun_crime', threshold: 0.83, phrases: ['instructions to make illegal firearms or explosives'] },
];

function compactText(s, max = 12000) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeModerationText(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/[0０]/g, 'o')
    .replace(/[1１!！|]/g, 'i')
    .replace(/[3３]/g, 'e')
    .replace(/[4４@]/g, 'a')
    .replace(/[5５$]/g, 's')
    .replace(/[^\p{L}\p{N}\u4e00-\u9fff]+/gu, '');
}

function hasAny(norm, terms) {
  return terms.some((t) => norm.includes(normalizeModerationText(t)));
}

function nearAny(norm, leftTerms, rightTerms, window = 24) {
  for (const left of leftTerms.map(normalizeModerationText).filter(Boolean)) {
    let i = norm.indexOf(left);
    while (i >= 0) {
      const span = norm.slice(Math.max(0, i - window), Math.min(norm.length, i + left.length + window));
      if (rightTerms.some((r) => span.includes(normalizeModerationText(r)))) return true;
      i = norm.indexOf(left, i + 1);
    }
  }
  return false;
}

function textPayload(text, attachments = []) {
  const parts = [];
  const t = compactText(text);
  if (t) parts.push(t);
  for (const a of attachments || []) if (a && a.kind === 'text' && a.text) parts.push(compactText(a.text, 3000));
  return parts.join('\n\n').slice(0, 14000);
}

export function policyTextHeuristic(text) {
  const body = compactText(text, 16000);
  const norm = normalizeModerationText(body);
  const hits = [];
  let score = 0;
  const add = (cat, s) => { if (!hits.includes(cat)) hits.push(cat); score = Math.max(score, s); };
  for (const rule of TEXT_RULES) {
    if (rule.rx.test(body)) add(rule.cat, rule.score);
  }

  const educational = EDUCATIONAL_CONTEXT.test(body);
  const adultExplicit = hasAny(norm, SEX_ACTION_TERMS) || re(`${zhSex}|${enSex}`).test(body);
  const explicitCreation = CREATIVE_EXPLICIT.test(body);
  if (adultExplicit && (!educational || explicitCreation || hasAny(norm, ['色情', '情色', '成人视频', '黄片', '成人小说', 'porn', 'smut']))) add('adult_sexual', 0.93);

  if (hasAny(norm, TABOO_TERMS) || nearAny(norm, FAMILY_TERMS, SEX_ACTION_TERMS, 28)) add('public_morals', 0.95);
  if (hasAny(norm, DISTURBING_TERMS)) add('public_morals', 0.96);
  if (hasAny(norm, EXPLOIT_TERMS) && (adultExplicit || hasAny(norm, ['裸照', '裸体', '色情', '性']))) add('exploitative_sexual', 0.96);

  return {
    blocked: hits.some((c) => BLOCKING_TEXT.has(c)) && score >= TEXT_MODERATION_THRESHOLD,
    score,
    categories: hits,
    reason: hits.join(', '),
    source: 'policy-v2',
  };
}

function predictionMap(predictions) {
  const out = Object.create(null);
  for (const p of predictions || []) {
    if (!p) continue;
    if (Array.isArray(p.results) && p.results[0]) {
      const probs = p.results[0].probabilities || [];
      out[String(p.label || '').toLowerCase()] = Math.max(Number(probs[1]) || 0, p.results[0].match === true ? 1 : 0);
    } else {
      out[String(p.className || p.label || '').toLowerCase()] = Number(p.probability || p.score || 0) || 0;
    }
  }
  return out;
}

function modelTextDecision(predictions) {
  const m = predictionMap(predictions);
  const threat = m.threat || 0;
  const severe = m.severe_toxicity || 0;
  const toxicity = m.toxicity || 0;
  const obscene = m.obscene || 0;
  const sexual = m.sexual_explicit || 0;
  const categories = [];
  if (threat >= 0.93) categories.push('credible_threat');
  if (severe >= 0.96 && toxicity >= 0.96) categories.push('mass_harm');
  if (sexual >= TEXT_ADULT_SEX_THRESHOLD) categories.push('adult_sexual');
  if (obscene >= 0.96 && (sexual >= 0.72 || toxicity >= 0.72)) categories.push('adult_sexual');
  const score = Math.max(threat, severe, toxicity, obscene, sexual);
  return {
    blocked: categories.some((c) => BLOCKING_TEXT.has(c)) && score >= TEXT_MODERATION_THRESHOLD,
    score,
    categories,
    reason: categories.join(', '),
    source: 'toxicity',
  };
}

async function tensorArray(tensor) {
  const arr = await tensor.array();
  if (tensor && typeof tensor.dispose === 'function') tensor.dispose();
  return arr;
}

function cosine(a, b) {
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

async function semanticPrototypeVectors(model) {
  if (semanticVectorsReady) return semanticVectorsReady;
  semanticVectorsReady = (async () => {
    const phrases = SEMANTIC_GROUPS.flatMap((g) => g.phrases);
    const rows = await tensorArray(await model.embed(phrases));
    let k = 0;
    return SEMANTIC_GROUPS.map((g) => ({ ...g, vectors: g.phrases.map(() => rows[k++]) }));
  })();
  return semanticVectorsReady;
}

async function semanticTextDecision(payload) {
  const hooks = testHooks();
  if (typeof hooks.semanticDecision === 'function') return hooks.semanticDecision(payload);
  const probe = compactText(payload, 1200);
  // USE 词表无 CJK 词条：CJK 占比高的文本嵌入恒定（cos=1，全类别误命中），直接跳过语义层。
  const letters = probe.replace(/\s+/g, '') || ' ';
  const cjk = (letters.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/g) || []).length;
  if (letters.length && cjk / letters.length >= 0.3) {
    return { blocked: false, score: 0, categories: [], skipped: 'cjk-unsupported' };
  }
  const model = await semanticModel();
  const groups = await semanticPrototypeVectors(model);
  const [vec] = await tensorArray(await model.embed([probe]));
  const categories = [];
  let score = 0;
  for (const g of groups) {
    const best = Math.max(...g.vectors.map((v) => cosine(vec, v)));
    if (best >= g.threshold) categories.push(g.cat);
    score = Math.max(score, best);
  }
  return {
    blocked: categories.some((c) => BLOCKING_TEXT.has(c)) && score >= 0.78,
    score,
    categories,
    reason: categories.join(', '),
    source: 'use-semantic',
  };
}

function mergeDecisions(...rows) {
  const categories = [...new Set(rows.flatMap((r) => r && r.categories || []))];
  const score = Math.max(0, ...rows.map((r) => Number(r && r.score) || 0));
  const blocked = rows.some((r) => r && r.blocked);
  return { blocked, score, categories, reason: categories.join(', '), parts: rows };
}

function nsfwContextRisk(context = '') {
  const txt = compactText(context, 1000);
  return re(`${minor}|偷拍|非自愿|强迫|性侵|rape|non[- ]?consensual|forced|revenge`).test(txt);
}

export function policyImageDecision(predictions, context = '') {
  const m = predictionMap(predictions);
  const porn = m.porn || 0;
  const hentai = m.hentai || 0;
  const sexy = m.sexy || 0;
  const nsfw = Math.min(1, porn + hentai + sexy);
  const contextRisk = nsfwContextRisk(context);
  const categories = [];
  if (porn >= 0.35) categories.push('porn');
  if (hentai >= 0.35) categories.push('hentai');
  if (sexy >= 0.35) categories.push('sexy');
  if (nsfw >= IMAGE_MODERATION_THRESHOLD) categories.push('adult_nsfw');
  if (contextRisk && nsfw >= IMAGE_MODERATION_THRESHOLD) categories.push('exploitative_nsfw');
  // 图片侧从严：Porn/Hentai/Sexy 任意组合达到 NSFW 阈值即取消任务，不再要求上下文风险。
  const blocked = nsfw >= IMAGE_MODERATION_THRESHOLD;
  return { blocked, score: nsfw, categories, reason: categories.join(', '), source: IMAGE_MODERATION_MODEL };
}

async function imageFromDataUrl(dataUrl, signal) {
  const hooks = testHooks();
  if (hooks.decodeImage) return withAbort(hooks.decodeImage(dataUrl), signal, 'imageDecode', timeoutFor('imageDecode', TIMEOUTS.imageDecode));
  if (typeof Image === 'undefined') throw new Error('当前环境不能解码图片');
  const task = new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = dataUrl;
    if (img.decode) img.decode().then(() => resolve(img), reject);
  });
  return withAbort(task, signal, 'imageDecode', timeoutFor('imageDecode', TIMEOUTS.imageDecode));
}

export async function moderateText({ text, attachments = [], signal } = {}) {
  throwIfAborted(signal);
  const t0 = performance.now();
  const payload = textPayload(text, attachments);
  if (!payload) return { blocked: false, score: 0, categories: [], skipped: 'empty' };
  const policy = policyTextHeuristic(payload);
  mlog('text:policy', { blocked: policy.blocked, cats: policy.categories.length ? policy.categories : undefined, ms: ms(t0) });
  // CJK 快速通道：Toxicity/USE 的词表都没有中文词条，对中文无判别力（中文防护由规则层覆盖）。
  // 跳过后「你好」这类消息不再触发 28MB 文本模型冷加载（此前首次中文消息要等 30s+）。
  const probe0 = compactText(payload, 400);
  const letters0 = probe0.replace(/\s+/g, '') || ' ';
  const cjk0 = (letters0.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/g) || []).length;
  if (letters0.length && cjk0 / letters0.length >= 0.3) {
    mlog('text:cjk-fastpath', { ms: ms(t0), note: '中文为主，仅规则层判定' });
    return mergeDecisions(policy,
      { blocked: false, score: 0, categories: [], skipped: 'cjk-unsupported' },
      { blocked: false, score: 0, categories: [], skipped: 'cjk-unsupported' });
  }
  let modelDecision = { blocked: false, score: 0, categories: [], skipped: 'not-run' };
  let semanticDecision = { blocked: false, score: 0, categories: [], skipped: 'not-run' };
  try {
    const model = await withAbort(textModel(), signal, 'textModel', timeoutFor('textModel', TIMEOUTS.textModel));
    throwIfAborted(signal);
    const predictions = await withAbort(model.classify([payload]), signal, 'textClassify', timeoutFor('textClassify', TIMEOUTS.textClassify));
    modelDecision = modelTextDecision(predictions);
    mlog('text:toxicity', { blocked: modelDecision.blocked, score: Math.round((modelDecision.score || 0) * 1000) / 1000, cats: modelDecision.categories.length ? modelDecision.categories : undefined });
  } catch (err) {
    if (isAbortError(err)) throw err;
    console.warn('[TeamoAgent] 本地文本 Toxicity 模型加载/推理失败，保留规则层结果', err);
    modelDecision = { blocked: false, score: 0, categories: [], error: String(err && err.message || err) };
  }
  try {
    throwIfAborted(signal);
    semanticDecision = await withAbort(semanticTextDecision(payload), signal, 'semantic', timeoutFor('semantic', TIMEOUTS.semantic));
    mlog('text:semantic', { blocked: semanticDecision.blocked, score: Math.round((semanticDecision.score || 0) * 1000) / 1000, cats: semanticDecision.categories.length ? semanticDecision.categories : undefined, skipped: semanticDecision.skipped });
  } catch (err) {
    if (isAbortError(err)) throw err;
    console.warn('[TeamoAgent] 本地文本 USE 语义模型加载/推理失败，保留规则层结果', err);
    semanticDecision = { blocked: false, score: 0, categories: [], error: String(err && err.message || err) };
  }
  return mergeDecisions(policy, modelDecision, semanticDecision);
}

export async function moderateImages({ attachments = [], text = '', signal } = {}) {
  throwIfAborted(signal);
  const tAll = performance.now();
  const localImgs = (attachments || [])
    .filter((a) => a && a.kind === 'image' && /^data:image\//.test(String(a.dataUrl || '')));
  mlog('images:start', { 本地图片: localImgs.length, 文本远程图URL: textImageCandidates(text).length });
  let remote = { attachments: [], errors: [] };
  if (textImageCandidates(text).length) {
    try { remote = await remoteImageAttachmentsFromText(text, signal); }
    catch (err) { if (isAbortError(err)) throw err; remote = { attachments: [], errors: [{ error: String(err && err.message || err), source: 'text-image-url' }] }; }
  }
  const imgs = [...localImgs, ...remote.attachments].slice(0, 6);
  if (!imgs.length) return { blocked: false, score: 0, categories: [], skipped: 'no-images', parts: remote.errors };
  let nsfwModel = null;
  let imgFail = false; // 任一图片路径失败/超时 → degraded：fail-closed，宁可拦截不可放行
  const decisions = [...(remote.errors || [])];
  for (let i = 0; i < imgs.length; i++) {
    const a = imgs[i];
    const tImg = performance.now();
    try {
      throwIfAborted(signal);
      const tDec = performance.now();
      const img0 = await imageFromDataUrl(a.dataUrl, signal);
      const img = downscaleForModeration(img0);
      if (img !== img0) {
        const o = imageSize(img0), n = imageSize(img);
        mlog(`image#${i + 1}:downscaled`, { 原始: `${o.width}x${o.height}`, 缩放: `${n.width}x${n.height}` });
      }
      mlog(`image#${i + 1}:decoded`, { name: a.name, bytes: Math.round((a.dataUrl || '').length * 0.75), ms: ms(tDec) });
      throwIfAborted(signal);
      let nudity = { blocked: false, score: 0, categories: [], skipped: 'not-run' };
      try {
        nudity = await moderateNudityImage(img, signal);
      } catch (err) {
        if (isAbortError(err)) throw err;
        imgFail = true;
        mlog(`image#${i + 1}:nudity-skip`, { reason: isTimeoutError(err) ? '超时' : '出错', error: String(err && err.message || err).slice(0, 160) });
        if (!isTimeoutError(err)) console.warn('[TeamoAgent] 本地 NudeNet 图片审核失败，继续用 NSFWJS', err);
        nudity = { blocked: false, score: 0, categories: [], error: String(err && err.message || err), source: 'local:nudenet-320n' };
      }
      if (nudity.blocked) { mlog(`image#${i + 1}:nudity-blocked`, { 总耗时: ms(tImg) }); decisions.push(nudity); continue; }
      let nsfw = { blocked: false, score: 0, categories: [], skipped: 'not-run' };
      try {
        if (!nsfwModel) {
          const tM = performance.now();
          mlog(`image#${i + 1}:nsfwjs-load-start`, { note: '首次需要 NSFWJS，若未预热此处包含下载' });
          nsfwModel = await withAbort(imageModel(), signal, 'imageModel', timeoutFor('imageModel', TIMEOUTS.imageModel));
          mlog(`image#${i + 1}:nsfwjs-load-ready`, { ms: ms(tM) });
        }
        throwIfAborted(signal);
        const tCls = performance.now();
        const preds = await withAbort(nsfwModel.classify(img, 5), signal, 'imageClassify', timeoutFor('imageClassify', TIMEOUTS.imageClassify));
        const raw = predictionMap(preds);
        mlog(`image#${i + 1}:nsfwjs-raw`, { ms: ms(tCls), drawings: Math.round((raw.drawings || 0) * 1000) / 1000, hentai: Math.round((raw.hentai || 0) * 1000) / 1000, neutral: Math.round((raw.neutral || 0) * 1000) / 1000, porn: Math.round((raw.porn || 0) * 1000) / 1000, sexy: Math.round((raw.sexy || 0) * 1000) / 1000 });
        nsfw = policyImageDecision(preds, `${text || ''} ${a.name || ''}`);
        mlog(`image#${i + 1}:nsfwjs-verdict`, { blocked: nsfw.blocked, score: Math.round((nsfw.score || 0) * 1000) / 1000, cats: nsfw.categories });
      } catch (err) {
        if (isAbortError(err)) throw err;
        imgFail = true;
        mlog(`image#${i + 1}:nsfwjs-skip`, { reason: isTimeoutError(err) ? '超时' : '出错', error: String(err && err.message || err).slice(0, 160) });
        if (!isTimeoutError(err)) console.warn('[TeamoAgent] 本地 NSFWJS 图片审核失败，保留 NudeNet 结果', err);
        nsfw = { blocked: false, score: 0, categories: [], error: String(err && err.message || err), source: IMAGE_MODERATION_MODEL };
      }
      const merged = mergeDecisions(nudity, nsfw);
      mlog(`image#${i + 1}:final`, { blocked: merged.blocked, score: Math.round((merged.score || 0) * 1000) / 1000, cats: merged.categories, 总耗时: ms(tImg) });
      decisions.push(merged);
    } catch (err) {
      if (isAbortError(err)) throw err;
      imgFail = true;
      mlog(`image#${i + 1}:pipeline-error`, { error: String(err && err.message || err).slice(0, 200) });
      decisions.push({ blocked: false, score: 0, categories: [], error: String(err && err.message || err) });
    }
  }
  const out = mergeDecisions(...decisions);
  if (!out.blocked && imgFail) out.degraded = true; // 图未明确放行而是「没审到」→ 标记降级
  mlog('images:done', { 图片数: imgs.length, blocked: out.blocked, degraded: out.degraded || undefined, score: Math.round((out.score || 0) * 1000) / 1000, cats: out.categories, 总耗时: ms(tAll) });
  return out;
}

export async function moderateUserTurn({ text, attachments = [], signal } = {}) {
  throwIfAborted(signal);
  const t0 = performance.now();
  const imgCount = (attachments || []).filter((a) => a && a.kind === 'image').length;
  const hasImage = imgCount > 0 || textImageCandidates(text).length > 0;
  const bypass = policyImagePromptBypass(text, hasImage);
  if (bypass.blocked) { mlog('turn:blocked-by-prompt-bypass', {}); return { blocked: true, text: bypass, image: { blocked: false, score: 0, categories: [], skipped: 'policy-preblocked' } }; }
  // 带图回合预算放宽到 90s（模型资源最大 26MB，慢网络友好）；纯文本仍 45s（规则层即时可用）
  const budget = imgCount > 0 ? IMAGE_TURN_BUDGET_MS : MODERATION_TIMEOUT_MS;
  mlog('turn:start', { 文本长度: (text || '').length, 图片数: imgCount, 总预算: `${budget}ms（带图超时将 fail-closed 拦截，纯文本 fail-open 放行）` });
  const task = Promise.all([
    moderateText({ text, attachments, signal }),
    moderateImages({ text, attachments, signal }),
  ]);
  const [textResult, imageResult] = await withAbort(task, signal, 'moderation', timeoutFor('moderation', budget));
  if (textResult.blocked) {
    // 文本策略已拦截：整轮结果就是拦截，图像层状态随附（不再叠加 fail-closed 文案）
    mlog('turn:done', { blocked: true, 文本: textResult.categories, 图片: imageResult.skipped || (imageResult.blocked ? imageResult.categories : 'pass'), 总耗时: ms(t0) });
    return { blocked: true, text: textResult, image: imageResult };
  }
  if (!imageResult.blocked && imageResult.degraded) {
    // 图片审核没能真正执行（模型未就绪/超时/出错）→ fail-closed：拦截本轮，图片绝不进沙箱
    mlog('turn:blocked-degraded', { reason: '图像模型未就绪，fail-closed 拦截（后台继续预热，可重试）' });
    return { blocked: true, timeout: true, text: textResult, image: { ...imageResult, blocked: true, timeout: true } };
  }
  mlog('turn:done', { blocked: !!(textResult.blocked || imageResult.blocked), 文本: textResult.blocked ? textResult.categories : 'pass', 图片: imageResult.blocked ? imageResult.categories : (imageResult.skipped || 'pass'), 总耗时: ms(t0) });
  return { blocked: !!(textResult.blocked || imageResult.blocked), text: textResult, image: imageResult };
}
