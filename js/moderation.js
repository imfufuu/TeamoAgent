// ─── 本地内容审核：Toxicity + USE 语义 + NSFWJS（不调用网关模型）────────────
// 模型随项目放在 assets/moderation/，用户发送后在浏览器本地运行。
// 当前策略：成人色情也审核；文本保持较宽松阈值，图片 NSFW 达阈值即拦。

export const TEXT_MODERATION_MODEL = 'local:tfjs-toxicity-1.2.2+use-semantic-policy-v2';
export const IMAGE_MODERATION_MODEL = 'local:nudenet-320n+nsfwjs-mobilenet-v2-mid';
export const TEXT_MODERATION_THRESHOLD = 0.9;
export const TEXT_ADULT_SEX_THRESHOLD = 0.92;
export const IMAGE_MODERATION_THRESHOLD = 0.70;
export const MODERATION_TIMEOUT_MS = 45000;

const TIMEOUTS = Object.freeze({
  textModel: 30000,
  textClassify: 12000,
  semantic: 16000,
  imageModel: 30000,
  imageDecode: 8000,
  imageClassify: 12000,
  nudityModel: 30000,
  nudityDetect: 12000,
});

const TFJS_URL = '../assets/vendor/tf.min.js';
const TOXICITY_URL = '../assets/vendor/toxicity.local.min.js';
const USE_URL = '../assets/vendor/use.min.js';
const USE_MODEL_URL = '../assets/moderation/text-use/model.json';
const USE_VOCAB_URL = '../assets/moderation/text-use/vocab.json';
const NSFWJS_URL = '../assets/vendor/nsfwjs.min.js';
const NSFW_MODEL_URL = '../assets/moderation/nsfw-mobilenet-v2-mid/model.json';
const ORT_URL = '../assets/vendor/ort.wasm.min.js';
const ORT_WASM_SIMD_URL = '../assets/vendor/ort-wasm-simd.wasm';
const ORT_WASM_URL = '../assets/vendor/ort-wasm.wasm';
const NUDENET_MODEL_URL = '../assets/moderation/nudenet-320n/model.onnx';
const NUDENET_INPUT_SIZE = 224;

let tfReady;
let toxicityReady;
let semanticReady;
let semanticVectorsReady;
let nsfwReady;
let nudityReady;

const testHooks = () => (globalThis && globalThis.__TEamoModerationTestHooks) || {};


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
  toxicityReady ||= loadScript(TOXICITY_URL).then(async () => {
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
  semanticReady ||= loadScript(USE_URL).then(async () => {
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
  nsfwReady ||= loadScript(NSFWJS_URL).then(async () => {
    if (!globalThis.nsfwjs || typeof globalThis.nsfwjs.load !== 'function') throw new Error('NSFWJS 模型运行时未初始化');
    const model = await globalThis.nsfwjs.load(assetUrl(NSFW_MODEL_URL), { size: 224 });
    return { model };
  });
  return (await nsfwReady).model;
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
    globalThis.ort.env.wasm.numThreads = 1;
    globalThis.ort.env.wasm.proxy = false;
    globalThis.ort.env.wasm.wasmPaths = {
      'ort-wasm-simd.wasm': assetUrl(ORT_WASM_SIMD_URL),
      'ort-wasm.wasm': assetUrl(ORT_WASM_URL),
    };
    const session = await globalThis.ort.InferenceSession.create(assetUrl(NUDENET_MODEL_URL), {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    return { session, inputName: session.inputNames && session.inputNames[0] };
  });
  return nudityReady;
}

function imageSize(img) {
  return { width: img.naturalWidth || img.videoWidth || img.width || 0, height: img.naturalHeight || img.videoHeight || img.height || 0 };
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
  const det = await withAbort(nudityDetector(), signal, 'nudityModel', timeoutFor('nudityModel', TIMEOUTS.nudityModel));
  const meta = makeNudeNetInput(img);
  const ort = globalThis.ort;
  const tensor = new ort.Tensor('float32', meta.input, [1, 3, NUDENET_INPUT_SIZE, NUDENET_INPUT_SIZE]);
  const output = await withAbort(det.session.run({ [det.inputName || det.session.inputNames[0]]: tensor }), signal, 'nudityDetect', timeoutFor('nudityDetect', TIMEOUTS.nudityDetect));
  return policyNudityDecision(postprocessNudeNet(output, meta));
}


function prefetchImageModerationAssets() {
  if (typeof document === 'undefined') return;
  for (const href of [ORT_URL, ORT_WASM_SIMD_URL, NUDENET_MODEL_URL]) {
    const url = assetUrl(href);
    if ([...document.querySelectorAll('link[rel="prefetch"],link[rel="preload"]')].some((x) => x.href === url)) continue;
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.href = url;
    if (/\.wasm(?:\?|$)/.test(url)) link.as = 'fetch';
    document.head.appendChild(link);
  }
}

function prewarmImageModeration() {
  if (typeof document === 'undefined') return Promise.resolve(false);
  prefetchImageModerationAssets();
  // 只预热 NudeNet：它是精确裸露拦截路径；NSFWJS 仍按需加载，避免所有用户额外下载 TFJS 图像模型。
  return nudityDetector().then(() => true).catch(() => false);
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

const SEMANTIC_GROUPS = [
  { cat: 'adult_sexual', threshold: 0.78, phrases: ['explicit pornographic sexual content', 'graphic erotic sex scene', '露骨色情性行为描写', '成人色情小说和做爱细节'] },
  { cat: 'public_morals', threshold: 0.80, phrases: ['incest sexual relationship between family members', '家庭成员之间的乱伦色情关系', 'bestiality necrophilia disturbing sexual behavior', '兽交恋尸等令人不适的不当性行为'] },
  { cat: 'exploitative_sexual', threshold: 0.80, phrases: ['non consensual sexual exploitation or voyeurism', '偷拍强迫性侵等非自愿性内容'] },
  { cat: 'drug_crime', threshold: 0.83, phrases: ['instructions to manufacture or traffic hard drugs', '制造贩卖冰毒海洛因芬太尼等毒品教程'] },
  { cat: 'gun_crime', threshold: 0.83, phrases: ['instructions to make illegal firearms or explosives', '自制枪支弹药爆炸物的犯罪教程'] },
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
  const model = await semanticModel();
  const groups = await semanticPrototypeVectors(model);
  const probe = compactText(payload, 1200);
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
  const payload = textPayload(text, attachments);
  if (!payload) return { blocked: false, score: 0, categories: [], skipped: 'empty' };
  const policy = policyTextHeuristic(payload);
  let modelDecision = { blocked: false, score: 0, categories: [], skipped: 'not-run' };
  let semanticDecision = { blocked: false, score: 0, categories: [], skipped: 'not-run' };
  try {
    const model = await withAbort(textModel(), signal, 'textModel', timeoutFor('textModel', TIMEOUTS.textModel));
    throwIfAborted(signal);
    const predictions = await withAbort(model.classify([payload]), signal, 'textClassify', timeoutFor('textClassify', TIMEOUTS.textClassify));
    modelDecision = modelTextDecision(predictions);
  } catch (err) {
    if (isAbortError(err)) throw err;
    console.warn('[TeamoAgent] 本地文本 Toxicity 模型加载/推理失败，保留规则层结果', err);
    modelDecision = { blocked: false, score: 0, categories: [], error: String(err && err.message || err) };
  }
  try {
    throwIfAborted(signal);
    semanticDecision = await withAbort(semanticTextDecision(payload), signal, 'semantic', timeoutFor('semantic', TIMEOUTS.semantic));
  } catch (err) {
    if (isAbortError(err)) throw err;
    console.warn('[TeamoAgent] 本地文本 USE 语义模型加载/推理失败，保留规则层结果', err);
    semanticDecision = { blocked: false, score: 0, categories: [], error: String(err && err.message || err) };
  }
  return mergeDecisions(policy, modelDecision, semanticDecision);
}

export async function moderateImages({ attachments = [], text = '', signal } = {}) {
  throwIfAborted(signal);
  const imgs = (attachments || [])
    .filter((a) => a && a.kind === 'image' && /^data:image\//.test(String(a.dataUrl || '')))
    .slice(0, 6);
  if (!imgs.length) return { blocked: false, score: 0, categories: [], skipped: 'no-images' };
  let nsfwModel = null;
  const decisions = [];
  for (const a of imgs) {
    try {
      throwIfAborted(signal);
      const img = await imageFromDataUrl(a.dataUrl, signal);
      throwIfAborted(signal);
      let nudity = { blocked: false, score: 0, categories: [], skipped: 'not-run' };
      try {
        nudity = await moderateNudityImage(img, signal);
      } catch (err) {
        if (isAbortError(err)) throw err;
        if (!isTimeoutError(err)) console.warn('[TeamoAgent] 本地 NudeNet 图片审核失败，继续用 NSFWJS', err);
        nudity = { blocked: false, score: 0, categories: [], error: String(err && err.message || err), source: 'local:nudenet-320n' };
      }
      if (nudity.blocked) { decisions.push(nudity); continue; }
      let nsfw = { blocked: false, score: 0, categories: [], skipped: 'not-run' };
      try {
        nsfwModel ||= await withAbort(imageModel(), signal, 'imageModel', timeoutFor('imageModel', TIMEOUTS.imageModel));
        throwIfAborted(signal);
        const preds = await withAbort(nsfwModel.classify(img, 5), signal, 'imageClassify', timeoutFor('imageClassify', TIMEOUTS.imageClassify));
        nsfw = policyImageDecision(preds, `${text || ''} ${a.name || ''}`);
      } catch (err) {
        if (isAbortError(err)) throw err;
        if (!isTimeoutError(err)) console.warn('[TeamoAgent] 本地 NSFWJS 图片审核失败，保留 NudeNet 结果', err);
        nsfw = { blocked: false, score: 0, categories: [], error: String(err && err.message || err), source: IMAGE_MODERATION_MODEL };
      }
      decisions.push(mergeDecisions(nudity, nsfw));
    } catch (err) {
      if (isAbortError(err)) throw err;
      decisions.push({ blocked: false, score: 0, categories: [], error: String(err && err.message || err) });
    }
  }
  return mergeDecisions(...decisions);
}

export async function moderateUserTurn({ text, attachments = [], signal } = {}) {
  throwIfAborted(signal);
  const task = Promise.all([
    moderateText({ text, attachments, signal }),
    moderateImages({ text, attachments, signal }),
  ]);
  const [textResult, imageResult] = await withAbort(task, signal, 'moderation', timeoutFor('moderation', MODERATION_TIMEOUT_MS));
  return { blocked: !!(textResult.blocked || imageResult.blocked), text: textResult, image: imageResult };
}
