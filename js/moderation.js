// ─── 本地轻量内容审核：文本 Toxicity + 图片 NSFWJS（不调用网关模型）────────────
// 两个模型都随项目放在 assets/moderation/，用户发送后在浏览器本地运行。
// 高阈值、低误杀；成年合意色情不作为拦截项。

export const TEXT_MODERATION_MODEL = 'local:tfjs-toxicity-1.2.2+policy-v1';
export const IMAGE_MODERATION_MODEL = 'local:nsfwjs-mobilenet-v2-mid-4.4.0';
export const TEXT_MODERATION_THRESHOLD = 0.9;
export const IMAGE_MODERATION_THRESHOLD = 0.98;

const TFJS_URL = '../assets/vendor/tf.min.js';
const TOXICITY_URL = '../assets/vendor/toxicity.local.min.js';
const NSFWJS_URL = '../assets/vendor/nsfwjs.min.js';
const NSFW_MODEL_URL = '../assets/moderation/nsfw-mobilenet-v2-mid/model.json';

let tfReady;
let toxicityReady;
let nsfwReady;

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

async function imageModel() {
  await ensureTf();
  if (globalThis.nsfwjs && nsfwReady && nsfwReady.model) return nsfwReady.model;
  nsfwReady ||= loadScript(NSFWJS_URL).then(async () => {
    if (!globalThis.nsfwjs || typeof globalThis.nsfwjs.load !== 'function') throw new Error('NSFWJS 模型运行时未初始化');
    const model = await globalThis.nsfwjs.load(assetUrl(NSFW_MODEL_URL), { size: 224 });
    return { model };
  });
  return (await nsfwReady).model;
}

const zhSex = '(色情|性爱|性交|做爱|裸照|裸体|淫秽|强奸|性侵|性行为|成人视频|黄片|约炮)';
const enSex = '(sex|sexual|porn|nude|naked|rape|nsfw|explicit|erotic)';
const minor = '(未成年|儿童|孩子|小孩|幼女|幼童|小学生|初中生|萝莉|正太|loli|shota|child|kid|minor|underage|teen(?:ager)?)';
const make = '(制作|制造|合成|提炼|种植|配方|教程|步骤|购买|贩卖|走私|邮寄|藏匿|自制|改装|绕过|教程|how to|make|buy|sell|traffic|smuggle|manufacture)';
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

const BLOCKING_TEXT = new Set(['minor_sexual', 'drug_crime', 'gun_crime', 'mass_harm', 'credible_threat']);
const ADULT_ONLY = new Set(['adult_sexual', 'sexual_explicit', 'adult_nsfw', 'porn', 'hentai', 'sexy']);

function compactText(s, max = 12000) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
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
  const hits = [];
  let score = 0;
  for (const rule of TEXT_RULES) {
    if (rule.rx.test(body)) { hits.push(rule.cat); score = Math.max(score, rule.score); }
  }
  return {
    blocked: hits.some((c) => BLOCKING_TEXT.has(c)) && score >= TEXT_MODERATION_THRESHOLD,
    score,
    categories: hits,
    reason: hits.join(', '),
    source: 'policy',
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
  if (sexual >= 0.9 && toxicity < 0.7 && threat < 0.7) categories.push('adult_sexual');
  if (obscene >= 0.95 && toxicity < 0.8 && threat < 0.8) categories.push('adult_sexual');
  const score = Math.max(threat, severe, toxicity, obscene, sexual);
  const onlyAdult = categories.length > 0 && categories.every((c) => ADULT_ONLY.has(c));
  return {
    blocked: !onlyAdult && categories.some((c) => BLOCKING_TEXT.has(c)) && score >= TEXT_MODERATION_THRESHOLD,
    score,
    categories,
    reason: categories.join(', '),
    source: 'toxicity',
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
  const nsfw = porn + hentai + sexy;
  const contextRisk = nsfwContextRisk(context);
  const categories = [];
  if (porn >= 0.65) categories.push('porn');
  if (hentai >= 0.65) categories.push('hentai');
  if (sexy >= 0.75) categories.push('sexy');
  if (contextRisk && nsfw >= 0.75) categories.push('exploitative_nsfw');
  // 成年色情不拦：只有 NSFW 置信很高且上下文指向未成年/非自愿/剥削时才取消任务。
  const blocked = contextRisk && nsfw >= IMAGE_MODERATION_THRESHOLD;
  return { blocked, score: Math.min(1, nsfw), categories, reason: categories.join(', '), source: IMAGE_MODERATION_MODEL };
}

async function imageFromDataUrl(dataUrl) {
  if (typeof Image === 'undefined') throw new Error('当前环境不能解码图片');
  const img = new Image();
  img.decoding = 'async';
  img.src = dataUrl;
  if (img.decode) await img.decode();
  else await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; });
  return img;
}

export async function moderateText({ text, attachments = [] } = {}) {
  const payload = textPayload(text, attachments);
  if (!payload) return { blocked: false, score: 0, categories: [], skipped: 'empty' };
  const policy = policyTextHeuristic(payload);
  let modelDecision = { blocked: false, score: 0, categories: [], skipped: 'not-run' };
  try {
    const model = await textModel();
    const predictions = await model.classify([payload]);
    modelDecision = modelTextDecision(predictions);
  } catch (err) {
    console.warn('[TeamoAgent] 本地文本审核模型加载/推理失败，保留规则层结果', err);
    modelDecision = { blocked: false, score: 0, categories: [], error: String(err && err.message || err) };
  }
  return mergeDecisions(policy, modelDecision);
}

export async function moderateImages({ attachments = [], text = '' } = {}) {
  const imgs = (attachments || [])
    .filter((a) => a && a.kind === 'image' && /^data:image\//.test(String(a.dataUrl || '')))
    .slice(0, 6);
  if (!imgs.length) return { blocked: false, score: 0, categories: [], skipped: 'no-images' };
  let model;
  try { model = await imageModel(); } catch (err) {
    console.warn('[TeamoAgent] 本地图片审核模型加载失败，图片审核 fail-open', err);
    return { blocked: false, score: 0, categories: [], error: String(err && err.message || err) };
  }
  const decisions = [];
  for (const a of imgs) {
    try {
      const img = await imageFromDataUrl(a.dataUrl);
      const preds = await model.classify(img, 5);
      decisions.push(policyImageDecision(preds, `${text || ''} ${a.name || ''}`));
    } catch (err) {
      decisions.push({ blocked: false, score: 0, categories: [], error: String(err && err.message || err) });
    }
  }
  return mergeDecisions(...decisions);
}

export async function moderateUserTurn({ text, attachments = [] } = {}) {
  const [textResult, imageResult] = await Promise.all([
    moderateText({ text, attachments }),
    moderateImages({ text, attachments }),
  ]);
  return { blocked: !!(textResult.blocked || imageResult.blocked), text: textResult, image: imageResult };
}
