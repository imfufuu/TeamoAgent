// ─── 网关接入点：双域名自动择路（中国大陆网络兼容）──────────────────────
// 背景：TeamoRouter 是国内的转接平台，但它对外有两个域名：
//   https://api.teamorouter.com   —— 文档与默认配置用的
//   https://api.teamorouter.cn    —— 同源服务，中国大陆网络通常更稳
// 依据用户中国大陆实网反馈：api.teamorouter.com 经常连不上、api.teamorouter.cn 正常
// （本项目的开发沙箱在境外，两侧都通，所以大陆连通性只能由用户实网验收）。
// 浏览器里只能靠 JS 自己选路，所以这里做三件事：
//   ① 启动时短暂探测两个域名（并行 + 超时），把能用的那个记到 localStorage，之后一律用它；
//   ② 请求遇到「网络层失败」（TypeError / Failed to fetch，而不是 HTTP 4xx/5xx）时自动换域名重放一次；
//   ③ 提供一个手动切换入口（顶栏传输徽章点击），用户自己知道哪个域名快时可固定。
// 注意：CSP 的 connect-src 必须同时放行两个域名，否则探测和请求都会被浏览器拦掉（见 index.html）。

export const GATEWAY_HOSTS = ['https://api.teamorouter.com', 'https://api.teamorouter.cn'];

const LS_KEY = 'teamo-gateway-endpoint';
const PROBE_TIMEOUT_MS = 4500;

let active = null;          // 当前选中的域名（未探测时为 null → 用第一个）
let chosenBy = 'default';   // 'default' | 'probe' | 'stored' | 'failover' | 'manual'

const hasLS = () => { try { return typeof localStorage !== 'undefined' && !!localStorage; } catch { return false; } };

function loadStored() {
  if (!hasLS()) return null;
  try {
    const v = localStorage.getItem(LS_KEY);
    return GATEWAY_HOSTS.includes(v) ? v : null;
  } catch { return null; }
}

/** 当前生效的接入点 */
export function gatewayBase() {
  if (active) return active;
  const stored = loadStored();
  if (stored) { active = stored; chosenBy = 'stored'; return active; }
  active = GATEWAY_HOSTS[0];
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
 * 启动探测：并行问两个域名，谁先给出响应就用谁。
 * 已有本地记录且它仍然可达时直接沿用（省一次探测、也尊重用户的手动选择）。
 */
export async function probeGatewayHosts({ timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const stored = loadStored();
  if (stored) {
    if (await hostReachable(stored, { timeoutMs })) { active = stored; chosenBy = 'stored'; return { host: stored, by: 'stored', switched: false }; }
  }
  const results = await Promise.all(GATEWAY_HOSTS.map(async (h) => ({ h, ok: await hostReachable(h, { timeoutMs }) })));
  const reachable = results.filter((r) => r.ok).map((r) => r.h);
  if (!reachable.length) return { host: gatewayBase(), by: 'none', switched: false }; // 都不通：保持原样，交给请求期报错
  const before = gatewayBase();
  const pick = GATEWAY_HOSTS.find((h) => reachable.includes(h)); // 固定顺序，结果可预测
  active = pick; chosenBy = 'probe';
  if (hasLS()) { try { localStorage.setItem(LS_KEY, pick); } catch { /* 忽略 */ } }
  return { host: pick, by: 'probe', switched: pick !== before, reachable };
}

/** 网络层错误判定：只有这类错误才值得换域名重试（HTTP 4xx/5xx 不是域名问题） */
export function isNetworkError(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return false;                    // 用户主动停止
  if (err.name === 'TypeError') return true;                     // fetch 网络失败（含 CORS/DNS/连接被拒）
  return /Failed to fetch|NetworkError|ERR_|net::|Load failed/i.test(String(err.message || err));
}
