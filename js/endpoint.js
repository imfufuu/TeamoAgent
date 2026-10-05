// ─── 网关接入点：双域名自动择路（按地区匹配 + 探测确认）────────────────
// 两个等价域名：
//   https://api.teamorouter.com   —— 国际站点（中国大陆以外用户默认为 .com）
//   https://api.teamorouter.cn    —— 中国大陆节点（大陆访问更稳；VPN/代理走 .com 时探测自然会选到 .com）
// 择路策略：
//   ① 启动时用浏览器环境线索（时区 / 语言）粗判地区：中国大陆 → 默认 .cn 优先；其他 → .com 优先。
//      若用户开了 VPN/代理，浏览器网络环境本身已被改写，随后的并行探测会选到真正可达的那个。
//   ② 短暂并行探测两个域名（超时内返回任意 HTTP 响应即判可达），优先顺序按地区偏好：
//      若偏好的域名可达 → 用它；否则回退另一个。
//   ③ localStorage 里保存上次选的，若它仍可达就沿用（尊重用户手动切换）。
//   ④ 请求遇到「网络层失败」（TypeError / Failed to fetch）时自动换域名重放一次。
//   ⑤ 手动切换入口（顶栏传输徽章）。

export const GATEWAY_HOSTS = ['https://api.teamorouter.com', 'https://api.teamorouter.cn'];
export const GATEWAY_CN = 'https://api.teamorouter.cn';
export const GATEWAY_GLOBAL = 'https://api.teamorouter.com';

/**
 * 判断当前浏览器环境是否大概率在中国大陆（非 100% 准确，仅用于择路默认顺序）。
 * 线索：时区 Asia/Shanghai（不被 HTTP 代理改写） + 系统语言/navigator.languages 含 zh-CN。
 * 用户开了 VPN 时浏览器时区不会变，但代理走国际链路 → .com 会比 .cn 先返回，探测阶段自然覆盖偏好。
 */
export function guessRegion() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    const langs = (navigator.languages && navigator.languages.length) ? [...navigator.languages] : [navigator.language || ''];
    const langStr = langs.join(',').toLowerCase();
    // 强信号：时区是上海/重庆/乌鲁木齐/香港（港澳也更接近 .cn 体验）
    const cnTz = /^Asia\/(Shanghai|Chongqing|Urumqi|Harbin|Kashgar|Hong_Kong|Macau)$/.test(tz);
    const cnLang = /zh-cn|zh-hans/i.test(langStr);
    // 时区在大陆 → 视为中国大陆；仅语言不够（海外华人也可能用中文界面）
    if (cnTz) return 'CN';
    if (cnLang && /^Asia\//.test(tz)) return 'CN'; // 亚洲时区 + 简体中文 → 也倾向大陆
    return 'GLOBAL';
  } catch { return 'GLOBAL'; }
}
/** 按地区返回偏好顺序（第一个优先） */
export function orderedHostsByRegion() {
  const region = guessRegion();
  return region === 'CN'
    ? [GATEWAY_CN, GATEWAY_GLOBAL]
    : [GATEWAY_GLOBAL, GATEWAY_CN];
}

const LS_KEY = 'dubhe-gateway-endpoint';
const PROBE_TIMEOUT_MS = 4500;

let active = null;          // 当前选中的域名（未探测时为 null → 用第一个）
let chosenBy = 'default';   // 'default' | 'probe' | 'stored' | 'failover' | 'manual'

import { readLocal } from './legacy-keys.js';
const hasLS = () => { try { return typeof localStorage !== 'undefined' && !!localStorage; } catch { return false; } };

function loadStored() {
  if (!hasLS()) return null;
  try {
    const v = readLocal(LS_KEY);
    return GATEWAY_HOSTS.includes(v) ? v : null;
  } catch { return null; }
}

/** 当前生效的接入点 */
export function gatewayBase() {
  if (active) return active;
  const stored = loadStored();
  if (stored) { active = stored; chosenBy = 'stored'; return active; }
  // 未探测/无存储时：按地区偏好默认（中国大陆 → .cn；其他 → .com）
  active = orderedHostsByRegion()[0];
  return active;
}

/** 当前接入点的来源（用于界面提示与测试） */
export function gatewayChosenBy() { return chosenBy; }

/** 手动/自动切换接入点；传 null 表示切到「另一个」 */
export function setGatewayBase(host, reason = 'manual') {
  const next = host && GATEWAY_HOSTS.includes(host)
    ? host
    : GATEWAY_HOSTS[(GATEWAY_HOSTS.indexOf(gatewayBase()) + 1) % GATEWAY_HOSTS.length];
  active = next; chosenBy = reason;
  if (hasLS()) { try { localStorage.setItem(LS_KEY, next); } catch { /* 隐私模式忽略 */ } }
  return next;
}

/** 另一个域名（切换用） */
export function otherGatewayBase() {
  const cur = gatewayBase();
  return GATEWAY_HOSTS.find((h) => h !== cur) || cur;
}

/** 某个域名是否可达：只要能拿回任意 HTTP 响应就算可达（401/404 都说明域名通） */
export async function hostReachable(host, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => ctrl && ctrl.abort(), timeoutMs);
  try {
    await fetch(`${host}/v1/models`, { method: 'GET', mode: 'cors', signal: ctrl ? ctrl.signal : undefined });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 启动探测：按地区偏好顺序并行问两个域名，偏好域可达就优先用它。
 * 已有本地记录且它仍然可达时直接沿用（尊重用户手动选择）。
 * 若用户走 VPN/代理：两个域名的网络路径都会走代理通道，.com 通常比 .cn 更快，
 * 大陆用户代理开着时也会自然选到 .com（.cn 探测可能超时或慢）。
 */
export async function probeGatewayHosts({ timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const stored = loadStored();
  if (stored) {
    if (await hostReachable(stored, { timeoutMs })) { active = stored; chosenBy = 'stored'; return { host: stored, by: 'stored', switched: false }; }
  }
  const order = orderedHostsByRegion();
  const results = await Promise.all(GATEWAY_HOSTS.map(async (h) => ({ h, ok: await hostReachable(h, { timeoutMs }) })));
  const reachable = new Set(results.filter((r) => r.ok).map((r) => r.h));
  if (!reachable.size) return { host: gatewayBase(), by: 'none', switched: false, region: guessRegion() };
  const before = gatewayBase();
  // 按地区偏好顺序挑第一个可达的
  let pick = order.find((h) => reachable.has(h));
  if (!pick) pick = [...reachable][0];
  active = pick; chosenBy = 'probe';
  if (hasLS()) { try { localStorage.setItem(LS_KEY, pick); } catch { /* 忽略 */ } }
  return { host: pick, by: 'probe', switched: pick !== before, reachable: [...reachable], region: guessRegion(), preferredOrder: order };
}

/** 网络层错误判定：只有这类错误才值得换域名重试（HTTP 4xx/5xx 不是域名问题） */
export function isNetworkError(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return false;                    // 用户主动停止
  if (err.name === 'TypeError') return true;                     // fetch 网络失败（含 CORS/DNS/连接被拒）
  return /Failed to fetch|NetworkError|ERR_|net::|Load failed/i.test(String(err.message || err));
}
