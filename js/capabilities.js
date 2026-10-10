// ─── 能力登记处（Capability Registry）· Dubhe Helix 3.0「DC · Dubhe Cambrian（天枢·寒武）」────────────────
//
// 这是 Helix 3.0 的第一块基石：**每个工具只在这里登记一次**，其余模块全部从这里派生——
//   · toolrunner.js   并发表 PARALLEL_TOOLS / 网络限流表 NETWORK_TOOLS
//   · trajectory.js   只读 / 重型 / 代码 / 网页 / 图像分组（轨迹级评测指标用）
//   · executionContext.js  核心必带表 CORE_TOOLS / 按需挂载规则 TOOL_MOUNT_RULES
//   · nexus.js        能力位门控分组 CAPABILITY_GATED_TOOL_GROUPS（4 位正交能力向量）
//   · tools.js        CODE_TOOL_NAMES / LEGACY_TOOL_ALIASES（旧名字 → 伞工具）
//   · tests           登记表 ↔ TOOL_DEFS ↔ execution.js 契约三方一致性（见 agent.test「能力登记处」组）
//
// Helix 2.5 之前新增一个工具要改 7 处（tools.js 定义、execution.js 契约、toolrunner 并发 / 访问集、
// trajectory 分组、nexus 门控、executionContext 挂载规则、config.js 提示词），漏一处就是一类静默缺陷
// （.29 修的「沙箱回写清空临时层」就是这种分散维护的产物）。「寒武纪」要的是能力可以大量、低风险地长出来，
// 前提就是登记一处、处处生效，并由测试强制：TOOL_DEFS 里有而这里没有 → 红；这里的 kind 与契约 sideEffect 对不上 → 红。
//
// 字段：
//   group    能力位门控分组：invariantCore（永远在） / webFetch / workerSearch / siteCrawler / fileDownload / codeSandbox / subagentSwarm
//   kind     语义类别（与 execution.js 契约 sideEffect 必须一致，测试强制）：
//            local（纯本地计算，无副作用）/ fs-read / fs-write / exec（沙箱执行）/ network / remote（经网关的识图等）
//            / cost（计费型：生图 / 委派）/ memory / render（本地渲染并落盘）
//   parallel 同一波内可并发（只读 / 无共享可变状态）
//   readOnly 轨迹级评测视为「只读调用」（Over-routing 指标口径；与 kind 不完全等价：data_tool 的 qr 会落盘，但评测仍按只读统计）
//   heavy    轨迹级评测视为「重型调用」（简单任务用了重型工具 → Over-routing）
//   core     两层下发里每轮必带（数字 = 在核心表里的顺序；0 / false = 按需挂载）
//   mount    非核心工具的按需挂载规则：{ text: RegExp, attachments?: string[], exclude?: RegExp }
//   tags     轨迹评测用：code / web / image
//
// 新增工具 checklist（.32 起）：① tools.js 加定义 + 执行分支；② execution.js 加契约；③ **这里登记一行**；
// ④ 需要提示词说明的，config.js 加一句。其余（并发 / 门控 / 挂载 / 评测分组）自动派生。

import { TOOL_MOUNT_RULES_SOURCE } from './capabilities-mount.js';

const R = (group, kind, extra = {}) => Object.freeze({ group, kind, parallel: false, readOnly: false, heavy: false, core: false, tags: [], ...extra });

export const CAPABILITY_REGISTRY = Object.freeze({
  // ── 代码沙箱（codeSandbox 门控：沙箱开关）──
  execute_javascript: R('codeSandbox', 'exec', { core: 1, heavy: true, tags: ['code'] }),
  execute_python: R('codeSandbox', 'exec', { core: 2, heavy: true, tags: ['code'] }),
  execute_cpp: R('codeSandbox', 'remote', { core: 3, heavy: true, tags: ['code'] }),
  // ── 文件系统（永远在）──
  write_file: R('invariantCore', 'fs-write', { core: 4, heavy: true }),
  read_file: R('invariantCore', 'fs-read', { core: 5, parallel: true, readOnly: true }),
  list_files: R('invariantCore', 'fs-read', { core: 6, parallel: true, readOnly: true }),
  delete_file: R('invariantCore', 'fs-write', { core: 7, heavy: true }),
  copy_file: R('invariantCore', 'fs-write', { core: 8, heavy: true }),
  search_files: R('invariantCore', 'fs-read', { parallel: true, readOnly: true }),
  zip_files: R('invariantCore', 'fs-write', { heavy: true }),
  unzip_file: R('invariantCore', 'fs-write', { heavy: true }),
  // ── 本地工作台（永远在，纯本地）──
  diff_text: R('invariantCore', 'local', { parallel: true, readOnly: true }),
  json_tool: R('invariantCore', 'local', { parallel: true, readOnly: true }),
  evaluate_expression: R('invariantCore', 'local', { parallel: true, readOnly: true }),
  text_tool: R('invariantCore', 'local', { parallel: true, readOnly: true }),
  data_tool: R('invariantCore', 'fs-write', { readOnly: true }), // kind=qr 会把 SVG 写进 outputs/，所以不并发；评测口径仍按只读
  execute_sql: R('invariantCore', 'fs-write', { heavy: true }),
  render_mermaid: R('invariantCore', 'render', { heavy: true }),
  render_dot: R('invariantCore', 'render', { heavy: true }),
  get_current_time: R('invariantCore', 'local', { parallel: true, readOnly: true }),
  get_browser_environment: R('invariantCore', 'local', { parallel: true }),
  // ── 多模态（永远在；识图走网关属 remote，生图计费属 cost）──
  generate_image: R('invariantCore', 'cost', { heavy: true, tags: ['image'] }),
  analyze_image: R('invariantCore', 'remote', { core: 11, parallel: true, heavy: true, tags: ['image'] }),
  analyze_pdf: R('invariantCore', 'remote', { tags: ['image'] }),
  analyze_video: R('invariantCore', 'remote', { tags: ['image'] }),
  // ── 记忆 ──
  remember: R('invariantCore', 'memory'),
  // ── 网页（中继 + 联网开关；search / crawl / file 再按 Worker health 能力位）──
  fetch_url: R('webFetch', 'network', { core: 9, parallel: true, heavy: true, tags: ['web'] }),
  search_web: R('workerSearch', 'network', { core: 10, parallel: true }),
  crawl_site: R('siteCrawler', 'network'),
  download_file: R('fileDownload', 'network'),
  // ── git（本地 server.py 时走真实 git，否则内置引擎）──
  run_git: R('invariantCore', 'fs-write', { heavy: true }),
  // ── 子智能体（思考档位 Max / Ultra 才有）──
  dispatch_subagent: R('subagentSwarm', 'cost', { core: 12, heavy: true }),
});

// 旧名字 → 伞工具（P6 合并）。仍可执行（旧会话回放 / 幂等账本），不下发给模型。
// parallel / readOnly 按原工具的性质保留，派生表与 2.5 时代逐项一致。
export const LEGACY_TOOL_ALIASES = Object.freeze({
  regex: { tool: 'text_tool', action: 'regex', parallel: true, readOnly: true },
  hash: { tool: 'text_tool', action: 'hash', parallel: true, readOnly: true },
  codec: { tool: 'text_tool', action: 'codec', parallel: true, readOnly: true },
  unicode: { tool: 'text_tool', action: 'unicode', parallel: true, readOnly: true },
  csv_tool: { tool: 'data_tool', kind: 'csv', parallel: false, readOnly: true },
  date_calc: { tool: 'data_tool', kind: 'date', parallel: true, readOnly: true },
  convert_units: { tool: 'data_tool', kind: 'units', parallel: true, readOnly: true },
  qr_code: { tool: 'data_tool', kind: 'qr', parallel: false, readOnly: false },
});

export const CAPABILITY_GROUPS = Object.freeze(['invariantCore', 'webFetch', 'workerSearch', 'siteCrawler', 'fileDownload', 'codeSandbox', 'subagentSwarm']);
export const CAPABILITY_KINDS = Object.freeze(['local', 'fs-read', 'fs-write', 'exec', 'network', 'remote', 'cost', 'memory', 'render']);

/** kind → execution.js 契约里允许的 sideEffect（测试据此做三方一致性校验） */
export const KIND_SIDE_EFFECTS = Object.freeze({
  local: ['none'], 'fs-read': ['none'], 'fs-write': ['filesystem'], exec: ['sandbox'], network: ['network'],
  remote: ['remote'], cost: ['cost'], memory: ['memory'], render: ['filesystem'],
});

export const REGISTERED_TOOL_NAMES = Object.freeze(Object.keys(CAPABILITY_REGISTRY));
export function capabilityOf(name) { return CAPABILITY_REGISTRY[name] || null; }
export function toolsWhere(pred) { return REGISTERED_TOOL_NAMES.filter((n) => pred(CAPABILITY_REGISTRY[n], n)); }
const aliasesWhere = (pred) => Object.keys(LEGACY_TOOL_ALIASES).filter((n) => pred(LEGACY_TOOL_ALIASES[n], n));

// ── 派生表（顺序 = 登记顺序；旧名字按别名表追加，保证与 2.5 时代的集合逐项一致）──
export const PARALLEL_TOOL_NAMES = Object.freeze([...toolsWhere((c) => c.parallel), ...aliasesWhere((a) => a.parallel)]);
export const NETWORK_TOOL_NAMES = Object.freeze(toolsWhere((c) => c.kind === 'network'));
export const READ_ONLY_TOOL_NAMES = Object.freeze([...toolsWhere((c) => c.readOnly), ...aliasesWhere((a) => a.readOnly)]);
export const HEAVY_TOOL_NAMES = Object.freeze(toolsWhere((c) => c.heavy));
export const CODE_TOOL_NAMES = Object.freeze(toolsWhere((c) => c.tags.includes('code')));
export const WEB_TOOL_NAMES = Object.freeze(toolsWhere((c) => c.tags.includes('web')));
export const IMAGE_TOOL_NAMES = Object.freeze(toolsWhere((c) => c.tags.includes('image')));
export const CORE_TOOL_NAMES = Object.freeze(toolsWhere((c) => c.core).sort((a, b) => CAPABILITY_REGISTRY[a].core - CAPABILITY_REGISTRY[b].core));
export const CAPABILITY_GATED_TOOL_GROUPS = Object.freeze(Object.fromEntries(
  CAPABILITY_GROUPS.map((g) => [g, Object.freeze(toolsWhere((c) => c.group === g))]),
));
// 按需挂载规则：只给非核心工具；规则正文在 capabilities-mount.js（正则多、单独放，避免这个文件被淹没）
export const TOOL_MOUNT_RULES = Object.freeze(Object.fromEntries(
  Object.entries(TOOL_MOUNT_RULES_SOURCE).filter(([name]) => CAPABILITY_REGISTRY[name] && !CAPABILITY_REGISTRY[name].core),
));

/** 登记处自检（启动 / 测试调用）：返回不一致项列表，空数组 = 一致 */
export function auditCapabilityRegistry({ toolDefs = [], getContract = () => null } = {}) {
  const problems = [];
  const defNames = new Set(toolDefs.map((t) => t && t.name).filter(Boolean));
  for (const n of defNames) if (!CAPABILITY_REGISTRY[n]) problems.push({ tool: n, kind: 'unregistered', detail: 'TOOL_DEFS 里有、能力登记处没有' });
  for (const n of REGISTERED_TOOL_NAMES) {
    const c = CAPABILITY_REGISTRY[n];
    if (defNames.size && !defNames.has(n)) problems.push({ tool: n, kind: 'orphan', detail: '登记了但 TOOL_DEFS 里没有' });
    if (!CAPABILITY_GROUPS.includes(c.group)) problems.push({ tool: n, kind: 'bad-group', detail: c.group });
    if (!CAPABILITY_KINDS.includes(c.kind)) problems.push({ tool: n, kind: 'bad-kind', detail: c.kind });
    const contract = getContract(n);
    if (contract && !KIND_SIDE_EFFECTS[c.kind].includes(contract.sideEffect)) problems.push({ tool: n, kind: 'kind-vs-contract', detail: `${c.kind} 对应 ${KIND_SIDE_EFFECTS[c.kind].join('/')}，契约却是 ${contract.sideEffect}` });
    if (c.parallel && c.kind !== 'local' && c.kind !== 'fs-read' && c.kind !== 'network' && c.kind !== 'remote') problems.push({ tool: n, kind: 'parallel-with-side-effect', detail: `${c.kind} 工具不该并发` });
    if (!c.core && !TOOL_MOUNT_RULES_SOURCE[n]) problems.push({ tool: n, kind: 'no-mount-rule', detail: '非核心工具必须有按需挂载规则，否则永远挂不上' });
  }
  for (const [alias, a] of Object.entries(LEGACY_TOOL_ALIASES)) {
    if (!CAPABILITY_REGISTRY[a.tool]) problems.push({ tool: alias, kind: 'alias-target-missing', detail: a.tool });
    if (defNames.has(alias)) problems.push({ tool: alias, kind: 'alias-still-defined', detail: '旧名字不应再出现在 TOOL_DEFS' });
  }
  return problems;
}
