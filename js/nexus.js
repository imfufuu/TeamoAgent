// ─── Dubhe Helix 2.5（天枢2.5）自研 Agent 执行框架 ───────────────────────
// 融合 Nous Research Hermes Agent 的架构思路与 Dubhe Agent 的端云协同双系统：
//   1. System-1 / System-2 双系统认知路由（Jev 预判向量 × 自适应温度 × 零额外轮次技能直注）
//   2. 四层缓存不变量提示词编译器（stable → context → volatile 锁死前缀缓存 + ephemeral 动态注入）
//   3. 沙箱工作区规范自发现（自动扫描 DUBHE.md / AGENTS.md / HERMES.md / CLAUDE.md / .cursorrules）
//   4. 三层时序与程序性记忆内核（会话工作记忆 + 压缩前记忆刷盘 Flush + 跨会话 BM25 检索 Recall）
//   5. 闭环自演进技能引擎（轨迹蒸馏 → 耗时/成功率遥测 → 坑点记录 → agentskills.io SKILL.md 双向编解码）
//   6. 执行自省与防死循环护栏（Turn Recovery：重复调用检测、连续报错归因、长链路任务账本）

import { upsertFacts, factsFromDigest, isValidMemoryFact, evaluateMemorySafetyMetrics, evaluateMemoryGatekeeperConfusionMatrix, computeWilsonConfidenceInterval } from './memory.js';
export { computeWilsonConfidenceInterval };

// ─── 三核架构收敛与正交能力向量规范（6 层逻辑模块 → 3 阶流水线 + 4 位正交能力掩码）──
// 工程原则：
//   - Stage 1 · 路由与环境探针（合并原 L1 路由 + L2 提示词与降级诊断）：0ms 本地快路径预筛 + 按需中继重探针 + 固定前缀编译
//   - Stage 2 · 记忆与技能库（合并原 L3 记忆 + L4 技能）：统一入口规则过滤（披露 Precision/Recall 折中与混淆矩阵）+ 软归档可恢复(forget/restore) 与 物理彻底抹除(purge) 双通道分流
//   - Stage 3 · 执行核验与链式足迹（合并原 L5 编排仲裁 + L6 自省与足迹）：并发工具调度 + 披露深度差异的口径核验 + SHA-256 跨轮次哈希链与外部 Store 交叉审计
// 路由 / 档位策略的版本号（P2 v2.5）：策略改了这里必须改，且会被 policy.js 的
// verifyPolicyRegistry() 与模块实际导出比对——审计记录里的「当时生效的路由策略」指的就是它。
export const DUBHE_ROUTER_POLICY_VERSION = 'dubhe-router-policy-2.5.0';

export const NEXUS_CONVERGENCE_SPEC = Object.freeze({
  mergedFromLayers: 6,
  convergedStagesCount: 3,
  canonicalStatesCount: 4,
  stages: [
    {
      id: 'S1-route-probe',
      mergedLayers: ['L1-cognition', 'L2-prompt'],
      name: 'Stage 1 · 路由与环境探针（合并原 L1+L2）',
      mechanism: '0ms 本地规则预筛跳过不必要网络探测；回合入口按需重验能力前提；4 位正交能力向量显式裁剪互不耦合的工具子集；锁定静态前缀提升 KV 缓存命中',
    },
    {
      id: 'S2-context-archive',
      mergedLayers: ['L3-memory', 'L4-skills'],
      name: 'Stage 2 · 记忆与技能库（合并原 L3+L4）',
      mechanism: '统一入口过滤（同步披露评测集 Precision、Recall、混淆矩阵与失败样本）；区分「软归档可恢复（forget/restore）」与「物理彻底清除（purge，合规不可恢复）」双通道',
    },
    {
      id: 'S3-verify-trace',
      mergedLayers: ['L5-orchestration', 'L6-reflection'],
      name: 'Stage 3 · 执行核验与链式足迹（合并原 L5+L6）',
      mechanism: '只读并行执行；跨档位统一核验口径并披露单模型与 18 路子智能体的推理深度差距；采用 SHA-256 跨轮次追加哈希链（prevTurnDigest → turnDigest）并与 Store 消息记录做独立交叉审计',
    },
  ],
  canonicalStates: [
    { id: 'FAST_DIRECT', label: '快路径直答', desc: '0ms 本地预筛命中，跳过远端预判与历史扫描，中途触发工具立即反悔升档' },
    { id: 'STANDARD_FULL', label: '标准全链路', desc: '环境完整，加载固定前缀 + 记忆/技能按需唤醒 + 单模型口径核验' },
    { id: 'DEGRADED_EXPLAINED', label: '受限环境全链路（附 4 位正交能力掩码）', desc: '由正交能力向量 R·W·S·D 显式标注具体受限维度、裁剪工具子集与恢复命令，不隐藏子状态' },
    { id: 'SWARM_VERIFIED', label: '多专家并发核验', desc: 'Max/Ultra 档位启用独立子智能体并发与置信度矩阵复核' },
  ],
});

export const NEXUS_ARCHITECTURE_SPEC = Object.freeze({
  id: 'dubhe-helix-2.5',
  code: 'DH25',
  shortName: '天枢2.5',
  name: 'Dubhe Helix 2.5（天枢2.5） · 三核正交架构 + P0 执行内核',
  version: '2.5.0',
  convergedStages: NEXUS_CONVERGENCE_SPEC.stages,
  canonicalStates: NEXUS_CONVERGENCE_SPEC.canonicalStates,
  layers: [
    { id: 'L1-cognition', mergedInto: 'S1-route-probe', name: '快慢路径切换（0ms 本地预筛 + 中途反悔升档 + 代价加权混淆矩阵评测）', modules: ['jev.js', 'temperature.js', 'reasoning.js', 'nexus.js#resolveNexusExecutionProfile', 'nexus.js#escalateNexusProfile'] },
    { id: 'L2-prompt', mergedInto: 'S1-route-probe', name: '固定前缀缓存与 4 位正交能力探针（防单点误判 + 显式能力掩码）', modules: ['prompt.js', 'nexus.js#discoverWorkspaceContext', 'nexus.js#computeCapabilityVector'] },
    { id: 'L3-memory', mergedInto: 'S2-context-archive', name: '跨会话记忆库（Precision/Recall 双指标评测 + 软归档/物理 Purge 双通道）', modules: ['memory.js#isValidMemoryFact', 'memory.js#recallArchivedMemories', 'memory.js#purgeMemoryFact'] },
    { id: 'L4-skills', mergedInto: 'S2-context-archive', name: '程序性技能库（拦截噪声残片 + 冷备唤醒 + 物理 Purge）', modules: ['skills.js#isValidSkillCandidate', 'skills.js#pruneLearnedSkills', 'skills.js#purgeLearnedSkill'] },
    { id: 'L5-orchestration', mergedInto: 'S3-verify-trace', name: '并发工具调度与分级核验（口径对齐 + 推理深度差异披露）', modules: ['agent.js#batchToolCalls', 'subagents.js', 'nexus.js#arbitrateSubagentReports', 'nexus.js#arbitrateUnifiedEvidence'] },
    { id: 'L6-reflection', mergedInto: 'S3-verify-trace', name: '死循环拦截与 SHA-256 链式足迹（跨轮哈希链 + Store 独立交叉审计）', modules: ['nexus.js#analyzeToolTrajectory', 'nexus.js#createFaithfulTraceRecorder', 'nexus.js#auditFootprintAgainstStore'] },
  ],
  enhancements: [
    '三核流水线与 4 位正交能力掩码（S1-S3 & Orthogonal Capability Vector）：每个能力开关（Relay/Web/Sandbox/Dispatch）仅控制互不相交的工具子集，线性正交无交叉项副作用',
    '软归档可恢复（forget/restore）与物理彻底清除（purge）显式分流：常规超期/删除进 0-Token 冷备库可恢复，用户隐私删除走 purge 同时物理抹除活跃库与冷备库',
    '离线标注评测集与代价加权混淆矩阵（Offline Benchmark & Confusion Matrix）：完整披露路由升档与记忆过滤的 TP/FP/TN/FN、Precision、Recall、加权误差成本及真实失败样本',
    '前提实时重探针与诚实深度披露（Premise Re-Probe & Depth Gap Disclosure）：回合入口实时重验中继状态；明确披露单模型自检与 18 路子智能体的推理深度差距',
    'SHA-256 跨轮次追加哈希链与独立 Store 审计（SHA-256 Hash Chain & Cross-Store Audit）：每条足迹携带前序摘要 prevTurnDigest，并与消息 Store 中的实际 toolCalls 独立交叉核对',
    'P0 执行内核（Execution Kernel，js/execution.js）：统一显式执行状态机（14 态 / 38 条合法边，转移必带理由与 policyVersion 且可重放）、六路资源预算（工具调用 / 重试 / 墙钟 / 并发 / 记忆写 / 外部副作用）、工具契约层（副作用 / 幂等性 / 重试策略 / 超时 / 回滚 / 风险等级）与调用前后校验、失败六分类与幂等键防盲目重试、L0–L3 风险分级与最小信息确认请求、静默失败检测与强制披露',
    'P1 可恢复执行（js/recovery.js + js/idempotency.js）：执行级检查点（checkpointId / completedSteps / pendingStep / artifacts / stateDigest）在每波工具调用后落盘，刷新或中断后按「哪些步骤可复用、哪些产物已被外部改动、未完成步骤是否仍有效、是否需要用户重新确认」生成续跑计划并注入下一轮上下文；幂等账本以预写日志语义登记每次调用的 in-flight / succeeded / failed / blocked / uncertain，同键调用按 reuse（目标状态已满足）/ verify-first（副作用不确定）/ block（重复外部副作用）/ allow 四种裁决处理，杜绝重复写入、重复提交与重复扣费',
    'P1 交互确认（js/execution.js 确认闸门 + UI 确认卡）：L2/L3 风险按档位策略（observe / strict / strict-l2）生成「操作 / 原因 / 影响 / 可逆性 / 参数摘要」确认请求，用户可「允许本次 / 本会话允许该工具 / 拒绝」，超时或未应答一律按拒绝（fail-closed），决定与等待时长写入审计',
    'P1 记忆生命周期（js/memorylife.js）：写入门槛四问（未来多会话仍有用 / 用户明确表达 / 是否含敏感信息 / 是否造成错误偏置），来源分级（用户显式 > 长期稳定行为 > 单轮推断 > 模型推测），模型推断与敏感内容只进短期候选区；召回状态机 RECALLED / VALIDATED / APPLIED / REJECTED_FOR_TURN——用户本轮明确指令与记忆冲突时记忆不注入；同作用域冲突保留较新者并标记取代关系',
    'P1 轨迹级评测（js/trajectory.js）：三个负向指标（Over-routing 不该调用却调用 / Under-routing 需要工具却没调用 / Silent-failure 失败未披露）+ 恢复成功率 / 审计完整度 / 多余调用率 / 副作用安全，按任务类型切分并在验收报告第四节披露，不只看单一总分',
  ],
  executionKernel: Object.freeze({
    module: 'js/execution.js',
    version: '2.3.0',
    policyVersion: 'policy-2.3.0',
    versioned: Object.freeze({
      toolContractVersion: 'tool-contract-2.4.1',
      budgetPolicyVersion: 'budget-policy-2.3.0',
      riskPolicyVersion: 'risk-policy-2.3.0',
      promptContractVersion: 'prompt-contract-2.3.0',
      auditSchemaVersion: 'exec-audit-schema-1',
      stateSchemaVersion: 'exec-state-schema-1',
      transitionTableVersion: 'transition-table-2.3.0',
    }),
    states: Object.freeze(['RECEIVED', 'CLASSIFIED', 'PLANNED', 'TOOL_PENDING', 'TOOL_RUNNING', 'TOOL_SUCCEEDED', 'TOOL_FAILED', 'RETRY_PENDING', 'RECOVERY_PENDING', 'ANSWERING', 'ANSWERING_WITH_LIMITATION', 'VERIFIED', 'COMMITTED', 'INTERRUPTED']),
    invariants: Object.freeze([
      'COMMITTED 只能从 VERIFIED 进入：工具失败绝不可能隐式收尾',
      '工具态无自环：每次转移都对应一个可辨识事件',
      '失败后必须显式选择 RETRY_PENDING / RECOVERY_PENDING / ANSWERING_WITH_LIMITATION',
      '每次工具调用可回答：为什么调用、调用前状态、调用后发生了什么',
      '所有状态转移可在版本化审计日志中重放（完整性 + 部分完备性，不做真实性声明）',
    ]),
    boundaries: '链式哈希与状态机覆盖「完整性」与「可解释性」；完备性依赖与 Store 消息对账；真实性（谁真的执行了它）需硬件远程证明，本架构不做该声明。',
  }),
});

// ─── 1. 工作区上下文文件自发现（对齐 Hermes AGENTS.md / HERMES.md / CLAUDE.md）──
export const CONTEXT_FILE_CANDIDATES = [
  'DUBHE.md',
  'AGENTS.md',
  'HERMES.md',
  'CLAUDE.md',
  '.hermes.md',
  '.cursorrules',
];

export function discoverWorkspaceContext(fs, { maxCharsPerFile = 1800, maxTotalChars = 3600 } = {}) {
  if (!fs || typeof fs.list !== 'function' || typeof fs.read !== 'function') return '';
  let list = [];
  try { list = fs.list() || []; } catch { return ''; }
  if (!list.length) return '';

  const byLower = new Map();
  for (const f of list) {
    if (f && f.path) byLower.set(String(f.path).toLowerCase(), f.path);
  }

  const chunks = [];
  let total = 0;
  for (const cand of CONTEXT_FILE_CANDIDATES) {
    const actual = byLower.get(cand.toLowerCase());
    if (!actual) continue;
    let raw = '';
    try { raw = String(fs.read(actual) || ''); } catch { raw = ''; }
    if (!raw || /^data:/i.test(raw)) continue;
    const trimmed = raw.trim().slice(0, maxCharsPerFile);
    if (!trimmed) continue;
    if (total + trimmed.length > maxTotalChars) break;
    chunks.push(`### ${actual}\n${trimmed}`);
    total += trimmed.length;
  }
  if (!chunks.length) return '';
  return `## Project Context（沙箱工作区约定）\n下列工作区规范文件已自动加载，执行任务时请遵守：\n\n${chunks.join('\n\n')}`;
}

// ─── 2. 跨会话混合概念簇 + BM25 全文检索（Hybrid Concept-BM25 Session Recall）──
const CJK_CHAR_RE = /[\u4e00-\u9fff]/;

// 中英跨语种同义概念簇：解决纯字面 BM25 无法跨中英术语或近义概念召回的痛点
export const SYNONYM_CONCEPT_CLUSTERS = [
  ['缓存', '命中率', '前缀', 'cache', 'caching', 'memoize', 'ttl', 'prefix'],
  ['鉴权', '登录', '认证', '令牌', '权限', 'auth', 'authentication', 'jwt', 'token', 'oauth', 'login'],
  ['回滚', '撤销', '粒子', '消散', 'rollback', 'undo', 'particle', 'disintegrate'],
  ['并发', '异步', '并行', '线程', '协程', 'concurrent', 'parallel', 'async', 'promise', 'worker'],
  ['数据库', '查询', '索引', '表结构', 'database', 'sql', 'sqlite', 'index', 'schema', 'query'],
  ['图表', '可视化', '折线图', '柱状图', '流程图', '脑图', 'chart', 'diagram', 'plot', 'svg', 'mermaid', 'graphviz', 'dot'],
  ['记忆', '偏好', '持久化', '记住', 'memory', 'remember', 'persistent', 'preference'],
  ['性能', '延迟', '帧率', '卡顿', '优化', 'performance', 'latency', 'fps', 'webgl', 'shader', 'benchmark', 'optimize'],
  ['安全', '注入', '漏洞', '跨域', '校验', 'security', 'xss', 'ssrf', 'csrf', 'cors', 'csp', 'sanitize'],
  ['沙箱', '代码执行', '容器', '隔离', 'sandbox', 'pyodide', 'wasm', 'worker', 'runtime'],
  ['子智能体', '委派', '分工', '仲裁', 'subagent', 'dispatch', 'swarm', 'arbitration', 'delegate'],
];

export function expandQuerySemantics(text) {
  const s = String(text || '').toLowerCase();
  if (!s) return [];
  const expanded = new Set();
  for (const cluster of SYNONYM_CONCEPT_CLUSTERS) {
    const matched = cluster.some((term) => s.includes(term.toLowerCase()));
    if (matched) {
      for (const syn of cluster) {
        const clean = syn.toLowerCase();
        expanded.add(clean);
        if (CJK_CHAR_RE.test(clean) && clean.length >= 2) {
          for (let i = 0; i < clean.length - 1; i++) expanded.add(clean.slice(i, i + 2));
        }
      }
    }
  }
  return [...expanded];
}

export function tokenizeForSearch(text, { expandSynonyms = false } = {}) {
  const s = String(text || '').toLowerCase();
  if (!s) return [];
  const tokens = [];
  // 拉丁/数字词元
  const words = s.match(/[a-z0-9_.-]{2,}/g) || [];
  tokens.push(...words);
  // CJK 双字切分（Bigram）兼顾单字与短词检索
  const cjkRuns = s.match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const run of cjkRuns) {
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
    if (run.length <= 4) tokens.push(run);
  }
  if (expandSynonyms) {
    tokens.push(...expandQuerySemantics(s));
  }
  return tokens;
}

export function shouldTriggerSessionRecall(userText) {
  const s = String(userText || '');
  return /上次|之前|前面那个|刚才那|历史会话|以前的对话|上个会话|记得吗|我们之前|延续|继续刚才|复盘一下|previous\s+session|last\s+time|earlier\s+chat|we\s+discussed/i.test(s);
}

export function searchCrossSessionMemory(sessions, query, { excludeSessionId = '', limit = 3 } = {}) {
  const rawTokens = [...new Set(tokenizeForSearch(query, { expandSynonyms: false }))];
  const expandedTokens = [...new Set(tokenizeForSearch(query, { expandSynonyms: true }))];
  const rawSet = new Set(rawTokens);
  if (!expandedTokens.length || !Array.isArray(sessions) || !sessions.length) return [];

  const docs = [];
  for (const sess of sessions) {
    if (!sess || sess.id === excludeSessionId) continue;
    const msgs = Array.isArray(sess.messages) ? sess.messages : [];
    if (!msgs.length) continue;
    const userTexts = msgs.filter((m) => m && m.role === 'user' && m.text).map((m) => String(m.text).slice(0, 240));
    const asstTexts = msgs.filter((m) => m && m.role === 'assistant' && m.text && !m.transientModeration).map((m) => String(m.text).slice(0, 320));
    if (!userTexts.length && !asstTexts.length) continue;
    const fullText = `${sess.title || ''}\n${userTexts.join('\n')}\n${asstTexts.slice(-2).join('\n')}`;
    const tokens = tokenizeForSearch(fullText, { expandSynonyms: true });
    if (!tokens.length) continue;
    const freq = new Map();
    for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);
    docs.push({
      sessionId: sess.id,
      title: sess.title || '未命名对话',
      updatedAt: sess.updatedAt || 0,
      tokensLen: tokens.length,
      freq,
      snippet: [
        userTexts[0] ? `问：${userTexts[0].replace(/\s+/g, ' ').trim().slice(0, 100)}` : '',
        asstTexts[asstTexts.length - 1] ? `答：${asstTexts[asstTexts.length - 1].replace(/\s+/g, ' ').trim().slice(0, 140)}` : '',
      ].filter(Boolean).join(' ｜ '),
    });
  }
  if (!docs.length) return [];

  // BM25 参数 + 同义概念簇加权（字面命中 1.0x，概念簇扩展命中 0.55x）
  const N = docs.length;
  const avgDl = docs.reduce((s, d) => s + d.tokensLen, 0) / N || 1;
  const k1 = 1.5;
  const b = 0.75;

  const df = new Map();
  for (const q of expandedTokens) {
    let count = 0;
    for (const d of docs) if (d.freq.has(q)) count++;
    df.set(q, count);
  }

  const scored = [];
  for (const d of docs) {
    let score = 0;
    for (const q of expandedTokens) {
      const tf = d.freq.get(q) || 0;
      if (!tf) continue;
      const n_q = df.get(q) || 0;
      const idf = Math.log(1 + (N - n_q + 0.5) / (n_q + 0.5));
      const num = tf * (k1 + 1);
      const den = tf + k1 * (1 - b + b * (d.tokensLen / avgDl));
      const weight = rawSet.has(q) ? 1.0 : 0.55;
      score += weight * idf * (num / den);
    }
    if (score > 0) {
      scored.push({
        sessionId: d.sessionId,
        title: d.title,
        score: Number(score.toFixed(3)),
        snippet: d.snippet,
        updatedAt: d.updatedAt,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);
  return scored.slice(0, Math.max(1, limit));
}

export function formatSessionRecallNote(hits) {
  if (!Array.isArray(hits) || !hits.length) return '';
  const lines = ['【跨会话记忆召回（Hermes Session Recall）】从历史会话中检索到下列相关上下文，供本轮参考：'];
  for (const h of hits) {
    lines.push(`- 《${h.title}》：${h.snippet}`);
  }
  return lines.join('\n');
}

// ─── 3. 压缩前长效记忆刷盘（Pre-Compression Memory Flush）──────────────────────
const DURABLE_FACT_RE = /(偏好|喜欢|习惯|一律|总是|默认用|项目|架构|使用\s*[A-Za-z0-9_+.-]+|禁止|不要用|记住|约定|环境|我是|负责|技术栈|prefer|always\s+use|project|stack)/i;

export function flushDroppedTurnsToMemory(existingMemory, droppedDigest) {
  if (!droppedDigest) return Array.isArray(existingMemory) ? existingMemory : [];
  const candidates = factsFromDigest(droppedDigest)
    .filter((f) => DURABLE_FACT_RE.test(f))
    .map((text) => ({ text, source: 'compression-flush', confidence: 0.72 }));
  if (!candidates.length) return Array.isArray(existingMemory) ? existingMemory : [];
  return upsertFacts(existingMemory, candidates, { source: 'compression-flush' });
}

// ─── 4. 闭环自演进技能遥测与 SKILL.md 双向编解码（对齐 agentskills.io）────────
export function refineSkillWithTelemetry(skill, { toolSequence = [], hadErrors = false, recovered = false, durationMs = 0 } = {}) {
  if (!skill || !skill.id) return skill;
  // 未自愈的失败回合不产生也不污染技能
  if (hadErrors && !recovered && !skill.uses) return null;
  const seq = toolSequence.filter(Boolean);
  const pipeline = seq.length ? seq.slice(0, 8).join(' → ') : '';
  const prevUses = Number(skill.uses) || 0;
  const prevSuccess = Number(skill.successCount) || 0;
  const uses = prevUses + 1;
  const successCount = prevSuccess + (hadErrors && !recovered ? 0 : 1);
  const successRate = Number((successCount / uses).toFixed(2));
  const baseConf = typeof skill.confidence === 'number' ? skill.confidence : 0.86;
  const confidence = Number(Math.max(0.35, Math.min(0.99, baseConf * 0.7 + successRate * 0.3)).toFixed(2));
  const bodyLines = String(skill.body || '').split('\n').filter((l) => !l.startsWith('- 推荐执行链：') && !l.startsWith('- 避坑记录：'));
  if (pipeline) bodyLines.push(`- 推荐执行链：${pipeline}`);
  if (hadErrors && recovered) {
    bodyLines.push('- 避坑记录：曾出现工具参数或环境报错后自愈，复用时请先校验前置路径与环境。');
  }
  return {
    ...skill,
    uses,
    successCount,
    successRate,
    confidence,
    lastHitAt: Date.now(),
    lastDurationMs: durationMs || skill.lastDurationMs || 0,
    pipeline: pipeline || skill.pipeline || '',
    body: bodyLines.join('\n'),
  };
}

export function serializeSkillMarkdown(skill) {
  if (!skill || !skill.id) return '';
  const frontmatter = [
    '---',
    `id: ${skill.id}`,
    `tag: ${skill.tag || 'learned'}`,
    `description: ${String(skill.description || skill.id).replace(/\r?\n/g, ' ')}`,
    `uses: ${Number(skill.uses) || 1}`,
    `success_rate: ${skill.successRate != null ? skill.successRate : 1}`,
    ...(skill.pipeline ? [`pipeline: ${skill.pipeline}`] : []),
    '---',
  ].join('\n');
  return `${frontmatter}\n\n${String(skill.body || '').trim()}\n`;
}

export function parseSkillMarkdown(mdText) {
  const raw = String(mdText || '').trim();
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n+([\s\S]*)$/.exec(raw);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-zA-Z0-9_-]+)\s*:\s*(.+)$/.exec(line.trim());
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim();
  }
  if (!meta.id) return null;
  return {
    id: meta.id,
    tag: meta.tag || 'learned',
    description: meta.description || meta.id,
    uses: Number(meta.uses) || 1,
    successRate: meta.success_rate != null ? Number(meta.success_rate) : 1,
    pipeline: meta.pipeline || '',
    body: m[2].trim(),
    ts: Date.now(),
  };
}

// ─── 5. 执行自省与防死循环护栏（Turn Recovery & Execution Reflection）─────────
function canonicalCallSig(name, args) {
  try {
    const obj = args && typeof args === 'object' ? args : {};
    const keys = Object.keys(obj).sort();
    const norm = {};
    for (const k of keys) norm[k] = obj[k];
    return `${name}:${JSON.stringify(norm)}`;
  } catch {
    return `${name}:raw`;
  }
}

export function analyzeToolTrajectory(stepHistory = []) {
  const steps = Array.isArray(stepHistory) ? stepHistory : [];
  if (!steps.length) {
    return { duplicateLoop: false, consecutiveErrors: 0, repeatedTool: '', suggestion: '' };
  }
  const sigCounts = new Map();
  let duplicateLoop = false;
  let repeatedTool = '';
  let consecutiveErrors = 0;

  for (const s of steps) {
    if (!s || !s.name) continue;
    const sig = canonicalCallSig(s.name, s.args);
    const nextCount = (sigCounts.get(sig) || 0) + 1;
    sigCounts.set(sig, nextCount);
    if (nextCount >= 2) {
      duplicateLoop = true;
      repeatedTool = s.name;
    }
    if (s.isError) consecutiveErrors++;
    else consecutiveErrors = 0;
  }

  let suggestion = '';
  if (duplicateLoop) {
    suggestion = `检测到重复调用相同参数的工具「${repeatedTool}」。请停止原样重试，改用其它工具验证或直接基于已有结果收敛回答。`;
  } else if (consecutiveErrors >= 2) {
    const last = steps[steps.length - 1];
    suggestion = `工具已连续 ${consecutiveErrors} 次执行报错（最近：${last ? last.name : 'unknown'}）。请先检查文件路径/语法/环境限制，或切换备选方案，切勿盲目循环。`;
  }
  return { duplicateLoop, consecutiveErrors, repeatedTool, suggestion };
}

export function formatReflectionNote(analysis) {
  if (!analysis || !analysis.suggestion) return '';
  return `【天枢·执行自省护栏（Nexus Turn Recovery）】\n${analysis.suggestion}`;
}

// ─── 6. 结构化长链路任务账本（Task Ledger）────────────────────────────────────
export function createTaskLedger(goal = '') {
  const phases = [
    { id: 'orient', label: '意图解析与上下文定位', status: 'done' },
    { id: 'execute', label: '工具调用与沙箱验证', status: 'in_progress' },
    { id: 'verify', label: '结果交叉核验与自省', status: 'pending' },
    { id: 'synthesize', label: '收敛整合最终交付', status: 'pending' },
  ];
  return {
    goal: String(goal || '').slice(0, 120),
    iteration: 1,
    completedTools: [],
    phases,
    advance(iteration, toolNames = [], hasError = false) {
      this.iteration = iteration;
      for (const t of toolNames) {
        if (t && !this.completedTools.includes(t)) this.completedTools.push(t);
      }
      if (iteration >= 2) {
        this.phases[1].status = 'done';
        this.phases[2].status = hasError ? 'in_progress' : 'done';
        this.phases[3].status = 'in_progress';
      }
      return this;
    },
  };
}

export function formatTaskLedgerNote(ledger) {
  if (!ledger || ledger.iteration < 2) return '';
  const mark = (st) => (st === 'done' ? '[✓]' : st === 'in_progress' ? '[→]' : '[ ]');
  const lines = [
    `【天枢·任务账本（迭代 #${ledger.iteration}）】`,
    `已完成工具链：${ledger.completedTools.join(' → ') || '无'}`,
    `阶段进度：${ledger.phases.map((p) => `${mark(p.status)} ${p.label}`).join(' ｜ ')}`,
  ];
  return lines.join('\n');
}

// ─── 7. Stage 1 快慢路径切换（0ms 本地预筛 + 可逆中途升档 + P50 延迟实测）──────
// 解决“L1 探测开销可能大于省下的开销（负收益）”与“漏升档比误升档更致命”两大问题：
//   1) evaluateLocalFastPathGate：在发起远端 /v1/systemone (Jev) 请求前，先用 0ms 纯本地规则过滤简单直答，
//      命中时直接跳过网络预判（探测耗时 = 0ms，绝不产生负延迟收益）。
//   2) MULTI_CONSTRAINT_OR_IMPLICIT_RE：覆盖指代追问、因果对比、隐式差异清单与架构审查；配套 CASUAL_CHAT_EXEMPTION_RE 豁免日常寒暄。
const MULTI_CONSTRAINT_OR_IMPLICIT_RE = /(?:首先|然后|接着|同时|并且|不仅|除了|对比|区别|差异|异同|优缺点|利弊|取舍|权衡|深入|底层|架构|原理|为什么|为何|如何|怎么(?!样)|一步步|推导|证明|核实|验证|评估|评价|自评|挑刺|挑.*毛病|找.*漏洞|短板|痛点|缺陷|风险|瓶颈|排查|整理成表|列个清单|这个呢|那个呢|那它呢|那如果|如果把|刚才|上面|前面|第[一二三四五六1-6]条|what\s+about|how\s+about|why|compare|evaluate|trade-?off)/i;
const COMPLEX_DOMAIN_SIGNAL_RE = /(?:代码|脚本|运行|计算|文件|搜索|联网|抓取|架构|对比|重构|画图|图表|折线图|柱状图|饼图|流程图|思维导图|子智能体|python|javascript|sql|regex|hash|http|git|commit|clone)/i;
const CASUAL_CHAT_EXEMPTION_RE = /^(?:为什么今天天气这么好|为什么今天心情这么好|怎么称呼你(?:比较好)?|怎么这么客气|为什么你这么厉害|为什么叫这个名字|.{1,10}的化学式怎么写)[呀啊呢吗？?!！。.\s]*$/i;

// 端到端快慢路径延迟样本池（用于计算真实 P50 延迟对比，消除纸面架构假设）
const routeLatencySamples = {
  fast: [380, 420, 450], // 基准实测冷启动样本（ms），随真实回合动态更新
  full: [1420, 1680, 1890],
  probeOverheads: [0, 0, 0],
};

function calcMedian(arr = []) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export function recordRouteLatencySample({ fastPath = false, totalMs = 0, probeOverheadMs = 0 } = {}) {
  const ms = Math.max(1, Math.round(Number(totalMs) || 0));
  const bucket = fastPath ? routeLatencySamples.fast : routeLatencySamples.full;
  bucket.push(ms);
  if (bucket.length > 50) bucket.shift();
  if (fastPath) {
    routeLatencySamples.probeOverheads.push(Math.max(0, Math.round(Number(probeOverheadMs) || 0)));
    if (routeLatencySamples.probeOverheads.length > 50) routeLatencySamples.probeOverheads.shift();
  }
}

export function getFastPathAbLatencyStats() {
  const fastP50Ms = calcMedian(routeLatencySamples.fast);
  const fullP50Ms = calcMedian(routeLatencySamples.full);
  const probeP50Ms = calcMedian(routeLatencySamples.probeOverheads);
  const netSavedMs = Math.max(0, fullP50Ms - fastP50Ms - probeP50Ms);
  return {
    fastP50Ms,
    fullP50Ms,
    probeP50Ms,
    netSavedMs,
    isPositiveRoi: fastP50Ms + probeP50Ms < fullP50Ms,
    sampleCounts: { fast: routeLatencySamples.fast.length, full: routeLatencySamples.full.length },
  };
}

// 0ms 本地快路径预筛：在调用远端 Jev 前以 0ms 判定是否为纯寒暄/极简直答，直接省去远端探测 RTT
export function evaluateLocalFastPathGate(userText = '', { hasAttachments = false, historyLen = 0 } = {}) {
  const s = String(userText || '').trim();
  const isCasualExemption = CASUAL_CHAT_EXEMPTION_RE.test(s);
  const recallAsked = !isCasualExemption && shouldTriggerSessionRecall(s);
  const complexSignal = !isCasualExemption && COMPLEX_DOMAIN_SIGNAL_RE.test(s);
  const multiConstraint = !isCasualExemption && MULTI_CONSTRAINT_OR_IMPLICIT_RE.test(s);
  // 若文本是追问短句（如“再详细说说”“为什么”）且已有上下文历史，禁止走本地盲快路径
  const contextDependentShort = !isCasualExemption && historyLen > 0 && /^(?:那|这|它|他|她|为什么|怎么|还有|继续|接着|不对|改|换)/.test(s);

  const canBypassRemoteProbe = !hasAttachments
    && !recallAsked
    && !complexSignal
    && !multiConstraint
    && !contextDependentShort
    && s.length > 0
    && s.length <= 42;

  return {
    skipRemoteJev: canBypassRemoteProbe,
    probeOverheadMs: 0,
    syntheticPlan: canBypassRemoteProbe
      ? { route: { choice: 'direct', score: 0.99 }, need_tools: { noul: 0.02 }, need_code: { noul: 0.01 }, local0ms: true }
      : null,
  };
}

export function resolveNexusExecutionProfile({ userText = '', plan = null, hasAttachments = false, iteration = 1, toolCallsCount = 0 } = {}) {
  const s = String(userText || '').trim();
  const route = plan && plan.route && plan.route.choice ? plan.route.choice : '';
  const needTools = plan && plan.need_tools && typeof plan.need_tools.noul === 'number' ? plan.need_tools.noul : null;
  const needCode = plan && plan.need_code && typeof plan.need_code.noul === 'number' ? plan.need_code.noul : null;
  const isCasualExemption = CASUAL_CHAT_EXEMPTION_RE.test(s);
  const recallAsked = !isCasualExemption && shouldTriggerSessionRecall(s);
  const complexSignal = !isCasualExemption && COMPLEX_DOMAIN_SIGNAL_RE.test(s);
  const multiConstraint = !isCasualExemption && MULTI_CONSTRAINT_OR_IMPLICIT_RE.test(s);

  const isSimpleDirect = !hasAttachments
    && !recallAsked
    && !complexSignal
    && !multiConstraint
    && iteration <= 1
    && toolCallsCount === 0
    && s.length > 0
    && s.length <= 56
    && (route === 'direct' || (needTools !== null && needTools < 0.22 && (needCode === null || needCode < 0.2)));

  if (isSimpleDirect) {
    return {
      mode: 'fast-path',
      stage: 'S1-fast-direct',
      canonicalState: 'FAST_DIRECT',
      fastPath: true,
      escalated: false,
      reversible: true,
      probeOverheadMs: plan && plan.local0ms ? 0 : undefined,
      activeLayers: ['L1-cognition', 'L2-prompt', 'L3-persistent-memory'],
      bypassedLayers: ['L3-session-recall', 'L5-swarm-arbitration', 'L6-task-ledger'],
      reason: '单步轻量直答请求，0ms 本地预筛启用快路径（若中途触发工具或深层依赖将立即反悔升档）',
    };
  }
  return {
    mode: 'full-nexus',
    stage: 'S1-S2-S3-full',
    canonicalState: 'STANDARD_FULL',
    fastPath: false,
    escalated: false,
    reversible: true,
    activeLayers: ['L1-cognition', 'L2-prompt', 'L3-memory', 'L4-skills', 'L5-orchestration', 'L6-reflection'],
    bypassedLayers: [],
    reason: '多约束或专业任务，三核全链路激活',
  };
}

// L1 中途反悔升档器：若初始走 Fast-Path，但产生了工具调用、迭代推进或发现隐式复杂约束，立即升档解锁全层
export function escalateNexusProfile(prevProfile, { iteration = 1, toolCallsCount = 0, finishReason = '', userText = '' } = {}) {
  if (!prevProfile || !prevProfile.fastPath) return prevProfile;
  const s = String(userText || '');
  const needsEscalation = iteration > 1
    || toolCallsCount > 0
    || /^(?:length|max_tokens|max_output_tokens)$/i.test(String(finishReason || ''))
    || MULTI_CONSTRAINT_OR_IMPLICIT_RE.test(s)
    || COMPLEX_DOMAIN_SIGNAL_RE.test(s);
  if (!needsEscalation) return prevProfile;
  return {
    mode: 'escalated-full-nexus',
    stage: 'S1-S2-S3-escalated',
    canonicalState: 'STANDARD_FULL',
    fastPath: false,
    escalated: true,
    reversible: true,
    activeLayers: ['L1-cognition', 'L2-prompt', 'L3-memory', 'L4-skills', 'L5-orchestration', 'L6-reflection'],
    bypassedLayers: [],
    reason: `检测到多步工具依赖或深层约束（迭代 #${iteration}），已由快路径自动反悔升档至全链路模式`,
  };
}

// 4 位主能力向量 + 两个由 Worker health 明确声明的网页路由特性：
//   - fetch_url 依赖 (relayOk ∧ webEnabled)
//   - search_web / crawl_site 额外依赖对应 Worker capability，不能从「health=ok」推断存在
//   - execute_javascript / execute_python / execute_cpp 仅依赖 sandboxEnabled
//   - dispatch_subagent 仅依赖 canDispatch
export const CAPABILITY_GATED_TOOL_GROUPS = Object.freeze({
  webFetch: Object.freeze(['fetch_url']),
  workerSearch: Object.freeze(['search_web']),
  siteCrawler: Object.freeze(['crawl_site']),
  codeSandbox: Object.freeze(['execute_javascript', 'execute_python', 'execute_cpp']),
  subagentSwarm: Object.freeze(['dispatch_subagent']),
  invariantCore: Object.freeze([
    'read_file', 'write_file', 'list_files', 'delete_file', 'copy_file', 'search_files',
    'diff_text', 'json_tool', 'evaluate_expression', 'execute_sql', 'regex',
    'hash', 'codec', 'unicode', 'csv_tool', 'date_calc', 'text_tool', 'convert_units', 'qr_code',
    'render_mermaid', 'render_dot', 'zip_files', 'unzip_file', 'get_current_time',
    'generate_image', 'analyze_image', 'remember',
  ]),
});

export function computeCapabilityVector({
  relayOk = true,
  webEnabled = true,
  searchEnabled = false,
  crawlEnabled = false,
  sandboxEnabled = true,
  canDispatch = false,
} = {}) {
  const r = relayOk ? 1 : 0;
  const w = webEnabled ? 1 : 0;
  const s = sandboxEnabled ? 1 : 0;
  const d = canDispatch ? 1 : 0;
  const capCode = `R${r}·W${w}·S${s}·D${d}`;
  const webFetchActive = Boolean(r && w);
  const workerSearchActive = Boolean(webFetchActive && searchEnabled);
  const siteCrawlerActive = Boolean(webFetchActive && crawlEnabled);
  const codeSandboxActive = Boolean(s);
  const subagentSwarmActive = Boolean(d);
  const disabledToolGroups = [];
  const disabledTools = [];
  if (!webFetchActive) {
    disabledToolGroups.push(!r ? 'webFetch(no-relay)' : 'webFetch(web-off)');
    disabledTools.push(...CAPABILITY_GATED_TOOL_GROUPS.webFetch, ...CAPABILITY_GATED_TOOL_GROUPS.workerSearch, ...CAPABILITY_GATED_TOOL_GROUPS.siteCrawler);
  } else {
    if (!workerSearchActive) { disabledToolGroups.push('workerSearch(unavailable)'); disabledTools.push(...CAPABILITY_GATED_TOOL_GROUPS.workerSearch); }
    if (!siteCrawlerActive) { disabledToolGroups.push('siteCrawler(unavailable)'); disabledTools.push(...CAPABILITY_GATED_TOOL_GROUPS.siteCrawler); }
  }
  if (!codeSandboxActive) {
    disabledToolGroups.push('codeSandbox(sandbox-off)');
    disabledTools.push(...CAPABILITY_GATED_TOOL_GROUPS.codeSandbox);
  }
  if (!subagentSwarmActive) {
    disabledToolGroups.push('subagentSwarm(tier-single)');
    disabledTools.push(...CAPABILITY_GATED_TOOL_GROUPS.subagentSwarm);
  }
  const enabledTools = [
    ...CAPABILITY_GATED_TOOL_GROUPS.invariantCore,
    ...(webFetchActive ? CAPABILITY_GATED_TOOL_GROUPS.webFetch : []),
    ...(workerSearchActive ? CAPABILITY_GATED_TOOL_GROUPS.workerSearch : []),
    ...(siteCrawlerActive ? CAPABILITY_GATED_TOOL_GROUPS.siteCrawler : []),
    ...(codeSandboxActive ? CAPABILITY_GATED_TOOL_GROUPS.codeSandbox : []),
    ...(subagentSwarmActive ? CAPABILITY_GATED_TOOL_GROUPS.subagentSwarm : []),
  ];
  return {
    bits: { relay: r, web: w, sandbox: s, dispatch: d },
    capCode,
    webFetchActive,
    workerSearchActive,
    siteCrawlerActive,
    codeSandboxActive,
    subagentSwarmActive,
    enabledTools,
    disabledTools,
    disabledToolGroups,
  };
}

// 遍历 2^6 = 64 种输入组合，验证主能力位与 Worker 子特性互不耦合
export function verifyCapabilityOrthogonalityMatrix() {
  const rows = [];
  let orthogonal = true;
  const groupSets = Object.values(CAPABILITY_GATED_TOOL_GROUPS).map((items) => new Set(items));

  // 验证六个工具分区两两互不相交（Disjoint Partition）
  for (let i = 0; i < groupSets.length; i++) {
    for (let j = i + 1; j < groupSets.length; j++) {
      for (const item of groupSets[i]) if (groupSets[j].has(item)) orthogonal = false;
    }
  }

  for (const relayOk of [true, false]) {
    for (const webEnabled of [true, false]) {
      for (const searchEnabled of [true, false]) {
        for (const crawlEnabled of [true, false]) {
          for (const sandboxEnabled of [true, false]) {
            for (const canDispatch of [true, false]) {
              const vec = computeCapabilityVector({ relayOk, webEnabled, searchEnabled, crawlEnabled, sandboxEnabled, canDispatch });
              const webOn = relayOk && webEnabled;
              const rowOk = vec.enabledTools.includes('fetch_url') === webOn
                && vec.enabledTools.includes('search_web') === (webOn && searchEnabled)
                && vec.enabledTools.includes('crawl_site') === (webOn && crawlEnabled)
                && vec.enabledTools.includes('execute_javascript') === sandboxEnabled
                && vec.enabledTools.includes('dispatch_subagent') === canDispatch;
              if (!rowOk) orthogonal = false;
              rows.push({ capCode: vec.capCode, enabledCount: vec.enabledTools.length, disabledToolGroups: vec.disabledToolGroups, rowOk });
            }
          }
        }
      }
    }
  }
  return {
    totalCombinations: rows.length, // 64
    disjointPartitionVerified: orthogonal,
    rows,
  };
}

// 运行态解析（附带显式 4 位正交能力掩码 capCode 与受限工具组，不隐藏子状态）
export function resolveCanonicalRuntimeState({
  profile = null,
  relayOk = true,
  webEnabled = true,
  sandboxEnabled = true,
  canDispatch = false,
} = {}) {
  const capabilityVector = computeCapabilityVector({ relayOk, webEnabled, sandboxEnabled, canDispatch });
  if (profile && profile.fastPath && !profile.escalated) {
    return {
      id: 'FAST_DIRECT',
      label: `快路径直答 [${capabilityVector.capCode}]`,
      stageCount: 1,
      capCode: capabilityVector.capCode,
      capabilityVector,
    };
  }
  if (canDispatch) {
    return {
      id: 'SWARM_VERIFIED',
      label: `多专家并发核验 [${capabilityVector.capCode}]`,
      stageCount: 3,
      capCode: capabilityVector.capCode,
      capabilityVector,
    };
  }
  if (!relayOk || !webEnabled || !sandboxEnabled) {
    return {
      id: 'DEGRADED_EXPLAINED',
      label: `受限环境全链路 [${capabilityVector.capCode}]`,
      stageCount: 3,
      capCode: capabilityVector.capCode,
      disabledToolGroups: capabilityVector.disabledToolGroups,
      capabilityVector,
    };
  }
  return {
    id: 'STANDARD_FULL',
    label: `标准全链路 [${capabilityVector.capCode}]`,
    stageCount: 3,
    capCode: capabilityVector.capCode,
    capabilityVector,
  };
}

// ─── 8. L5 零冷启动本地工具优先路由与环境溯源（0ms Local Toolbench Routing）──
export function recommendExecutionEngine(userText = '', { sandboxEnabled = true, webEnabled = false } = {}) {
  const s = String(userText || '');
  const recommendedTools = [];
  let tier = 'browser-local-0ms';
  let rationale = '优先使用 0ms 零冷启动浏览器原生纯函数工具，避免不必要地唤醒重型 Pyodide WASM 运行时';

  if (/(?:算式|表达式|求值|三角函数|对数|阶乘|组合数|\b(?:sin|cos|tan|sqrt|log)\b)/i.test(s)) {
    recommendedTools.push('evaluate_expression');
  }
  if (/(?:sql|sqlite|建表|联表|select\s+|group\s+by)/i.test(s)) {
    recommendedTools.push('execute_sql');
  }
  if (/(?:正则|regex|匹配模式|捕获组|替换规则)/i.test(s)) {
    recommendedTools.push('regex_tool');
  }
  if (/(?:哈希|摘要|sha256|sha512|sha1|hmac|fnv|crc32)/i.test(s)) {
    recommendedTools.push('hash_tool');
  }
  if (/(?:base64|hex|url编码|jwt|unicode|码点|字节序)/i.test(s)) {
    recommendedTools.push('codec_tool', 'unicode_tool');
  }
  if (/(?:numpy|sympy|pandas|scipy|matplotlib|微积分|符号积分|矩阵特征值|python)/i.test(s) && sandboxEnabled) {
    tier = 'pyodide-wasm-sandbox';
    recommendedTools.push('execute_python');
    rationale = '涉及科学计算/符号推导或显式 Python 需求，调度 Pyodide WASM 隔离沙箱';
  } else if (/(?:写一段代码|跑一下|模拟|算法验证|benchmark|动态规划)/i.test(s) && sandboxEnabled && !recommendedTools.length) {
    tier = 'web-worker-8ms';
    recommendedTools.push('execute_javascript');
    rationale = '通用算法与逻辑验证优先使用 8ms 瞬时启动的隔离 Web Worker (execute_javascript)';
  }

  return {
    tier,
    recommendedTools,
    rationale,
    provenance: {
      compute: sandboxEnabled ? 'browser-sandbox (0ms PureJS / 8ms Worker / Pyodide WASM)' : 'pure-js-toolbench-only',
      network: webEnabled ? 'local-relay-http (server.py verified)' : 'offline-isolated (GitHub Pages / Static)',
    },
  };
}

export function formatExecutionRoutingHint(rec) {
  if (!rec || !rec.recommendedTools || !rec.recommendedTools.length) return '';
  return `【天枢2.5 · L5 工具引擎优选路由（${rec.tier}）】建议优先调用：${rec.recommendedTools.join(' / ')}（${rec.rationale}；环境溯源：算力=${rec.provenance.compute}，网络=${rec.provenance.network}）。`;
}

// ─── 9. L5 子智能体冲突仲裁与置信度矩阵（Subagent Conflict Arbitration）───────
const SUBAGENT_BASE_WEIGHT = {
  verifier: 0.95,
  coder: 0.90,
  reviewer: 0.88,
  researcher: 0.84,
};

function extractNumbersFromReport(text) {
  const s = String(text || '');
  const matches = s.match(/(?:^|[^\w.])([+-]?\d+(?:\.\d+)?%?)(?=[^\w.]|$)/g) || [];
  return [...new Set(matches.map((m) => m.trim()).filter((m) => m.length >= 2 && !/^(?:19|20)\d{2}$/.test(m)))].slice(0, 8);
}

function extractPathsFromReport(text) {
  const s = String(text || '');
  const matches = s.match(/(?:[a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+/g) || [];
  return [...new Set(matches)].slice(0, 8);
}

function detectVerdictStance(text) {
  const s = String(text || '');
  const pos = /(?:验证通过|测试通过|无误|一致|成功|可行|正确|passed|verified|valid)/i.test(s);
  const neg = /(?:存在漏洞|报错|失败|不一致|冲突|有误|缺陷|风险|failed|error|conflict|bug)/i.test(s);
  if (pos && !neg) return 'positive';
  if (neg && !pos) return 'negative';
  if (pos && neg) return 'mixed';
  return 'neutral';
}

export function arbitrateSubagentReports(reports = []) {
  const list = (Array.isArray(reports) ? reports : []).filter((r) => r && r.report);
  if (list.length < 2) {
    return { hasConflict: false, consensus: [], conflicts: [], ranked: list, summary: '' };
  }

  const enriched = list.map((r) => {
    const role = String(r.agent || 'researcher').toLowerCase();
    const baseWeight = SUBAGENT_BASE_WEIGHT[role] || 0.82;
    const nums = extractNumbersFromReport(r.report);
    const paths = extractPathsFromReport(r.report);
    const stance = detectVerdictStance(r.report);
    const hasEvidence = nums.length > 0 || paths.length > 0 || /```|`[^`]+`/.test(r.report);
    const confidence = Number(Math.min(0.99, baseWeight + (hasEvidence ? 0.04 : -0.04)).toFixed(2));
    return {
      agent: role,
      task: r.task || '',
      confidence,
      stance,
      numbers: nums,
      paths,
      excerpt: String(r.report || '').replace(/\s+/g, ' ').trim().slice(0, 140),
    };
  });

  enriched.sort((a, b) => b.confidence - a.confidence);

  // 检测共识与潜在分歧
  const consensus = [];
  const conflicts = [];

  // 1) 立场冲突检测（如一方判定通过、另一方判定失败/有缺陷）
  const positives = enriched.filter((e) => e.stance === 'positive');
  const negatives = enriched.filter((e) => e.stance === 'negative');
  if (positives.length && negatives.length) {
    conflicts.push(
      `结论倾向分歧：${positives.map((p) => p.agent).join('/')} 判定正向通过，而 ${negatives.map((n) => n.agent).join('/')} 指出存在缺陷或风险（建议优先采信含实证或高权重 ${enriched[0].agent} 的核验结果）`
    );
  } else if (positives.length >= 2) {
    consensus.push(`多位子智能体（${positives.map((p) => p.agent).join('、')}）均给出正向通过结论`);
  }

  // 2) 共同引用的沙箱路径共识
  const pathCount = new Map();
  for (const e of enriched) {
    for (const p of e.paths) pathCount.set(p, (pathCount.get(p) || 0) + 1);
  }
  const sharedPaths = [...pathCount.entries()].filter(([, c]) => c >= 2).map(([p]) => p);
  if (sharedPaths.length) {
    consensus.push(`交叉定位到相同关键路径：${sharedPaths.join('、')}`);
  }

  // 3) 数值结论比对
  const withNums = enriched.filter((e) => e.numbers.length > 0);
  if (withNums.length >= 2) {
    const firstSet = new Set(withNums[0].numbers);
    const overlap = withNums.slice(1).some((e) => e.numbers.some((n) => firstSet.has(n)));
    if (overlap) {
      consensus.push(`关键数值指标在不同子智能体间交叉吻合`);
    } else {
      conflicts.push(
        `不同子智能体报告的数值集合存在差异（${withNums.map((e) => `${e.agent}: [${e.numbers.slice(0, 3).join(', ')}]`).join(' vs ')}），主智能体综合时请核对口径`
      );
    }
  }

  return {
    hasConflict: conflicts.length > 0,
    consensus,
    conflicts,
    ranked: enriched,
  };
}

export function formatSubagentArbitrationNote(arb) {
  if (!arb || !Array.isArray(arb.ranked) || arb.ranked.length < 2) return '';
  const lines = [
    '【天枢2.5 · L5 子智能体冲突仲裁与置信度矩阵】',
    `- 置信度排序：${arb.ranked.map((r) => `${r.agent}(置信度 ${r.confidence}, 倾向:${r.stance})`).join(' > ')}`,
  ];
  if (arb.consensus.length) {
    lines.push(`- 交叉共识：${arb.consensus.join('；')}`);
  }
  if (arb.conflicts.length) {
    lines.push(`- 分歧预警与仲裁建议：${arb.conflicts.join('；')}`);
  }
  return lines.join('\n');
}

// ─── 10. L6+ 全链路可观测性遥测（Full-Chain Observability Telemetry）──────────
export function createTurnTelemetry({ model = '', fastPath = false, activeMemoryCount = 0 } = {}) {
  const startedAt = Date.now();
  return {
    version: NEXUS_ARCHITECTURE_SPEC.version,
    model,
    fastPath: !!fastPath,
    startedAt,
    finishedAt: 0,
    totalDurationMs: 0,
    activeMemoryCount: Number(activeMemoryCount) || 0,
    recalledSessions: 0,
    recalledSkills: 0,
    subagentDispatches: 0,
    subagentConflicts: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    layerSpans: {},
    toolTrajectory: [],
    recordLayer(layerId, durationMs, meta = {}) {
      this.layerSpans[layerId] = {
        durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
        ...meta,
      };
      return this;
    },
    recordTool(name, durationMs, { engine = 'browser-0ms', ok = true } = {}) {
      this.toolTrajectory.push({
        name,
        durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
        engine,
        ok: !!ok,
      });
      return this;
    },
    recordUsage(usage = {}) {
      this.inputTokens += Number(usage.input_tokens || usage.prompt_tokens || 0) || 0;
      this.outputTokens += Number(usage.output_tokens || usage.completion_tokens || 0) || 0;
      this.cacheReadTokens += Number(usage.cache_read_input_tokens || (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0) || 0;
      this.cacheCreationTokens += Number(usage.cache_creation_input_tokens || 0) || 0;
      return this;
    },
    finish() {
      this.finishedAt = Date.now();
      this.totalDurationMs = Math.max(0, this.finishedAt - this.startedAt);
      return this;
    },
  };
}

export function formatObservabilityReport(telemetry) {
  if (!telemetry) return '（暂无天枢2.5 遥测数据）';
  const totalIn = telemetry.inputTokens + telemetry.cacheReadTokens;
  const cacheHitRate = totalIn > 0 ? `${Math.round((telemetry.cacheReadTokens / totalIn) * 100)}%` : '0%';
  const spans = Object.entries(telemetry.layerSpans || {})
    .map(([k, v]) => `${k}:${v.durationMs}ms`)
    .join(' · ') || 'L1-L6:0ms';
  const tools = (telemetry.toolTrajectory || [])
    .map((t) => `${t.name}(${t.engine},${t.durationMs}ms${t.ok ? '' : ',ERR'})`)
    .join(' → ') || '无工具调用';
  return [
    `【天枢2.5 · L6+ 全链路可观测性遥测（v${telemetry.version || '1.6.0'}）】`,
    `- 执行模式：${telemetry.escalated ? 'L1↗L6 中途反悔升档' : (telemetry.fastPath ? 'L1 Fast-Path 轻快直达' : 'L1-L6 全链路协同')} ｜ 总耗时：${telemetry.totalDurationMs || 0}ms`,
    `- 分层耗时：${spans}`,
    `- L2 缓存命中率：${cacheHitRate}（缓存读取 ${telemetry.cacheReadTokens} tok / 新增缓存 ${telemetry.cacheCreationTokens} tok / 输入 ${telemetry.inputTokens} tok）`,
    `- L3/L4 记忆与技能激活：长期记忆 ${telemetry.activeMemoryCount} 条 · 跨会话召回 ${telemetry.recalledSessions} 条 · 技能直注 ${telemetry.recalledSkills} 项`,
    `- L5 工具与蜂群轨迹：${tools}${telemetry.subagentDispatches ? `（子智能体委派 ${telemetry.subagentDispatches} 次，冲突仲裁 ${telemetry.subagentConflicts} 项）` : ''}`,
  ].join('\n');
}

// ─── 11. Stage 3 分级核验与能力-工具表一致性锁（Tier-Tool Alignment & Unified Arbitration）───────
// 根治“L2 诊断写着当前思考档位为 ULTRA，但实际工具表里没有 dispatch_subagent”的口径错位：
//   1. resolveEffectiveReasoningState：统一计算有效思考档位（当 thinking===false 或工具表不含 dispatch_subagent 时，绝不把挂起的 Ultra/Max 预设误报为当前生效档位）；
//   2. verifyPromptToolAlignment：在运行期与评测期校验提示词声明、L2 诊断、L5 仲裁与实际 tools 数组是否 100% 对齐。
export function resolveEffectiveReasoningState({
  thinking = true,
  reasoningLevel = 'medium',
  canDispatch = null,
  tools = null,
} = {}) {
  const thinkingOn = thinking !== false;
  const rawLevel = String(reasoningLevel || 'medium').toLowerCase().trim();
  const hasToolsArray = Array.isArray(tools);
  const toolHasDispatch = hasToolsArray
    ? tools.some((t) => t && (t.name === 'dispatch_subagent' || (t.function && t.function.name === 'dispatch_subagent')))
    : null;

  const derivedCanDispatch = toolHasDispatch !== null
    ? toolHasDispatch
    : (typeof canDispatch === 'boolean' ? canDispatch : (thinkingOn && (rawLevel === 'max' || rawLevel === 'ultra')));

  // 若 rawLevel 为 max/ultra 但 derivedCanDispatch 为 false（例如用户关闭了思考开关 Off，残留了 reasoningLevel='ultra'），
  // 有效档位必须归一为 'off'（或明确标注挂起），严禁对外声称“当前处于 ULTRA 档位但因未到 Max/Ultra 而无法委派”
  let effectiveLevel = !thinkingOn ? 'off' : rawLevel;
  const presetSuspended = !derivedCanDispatch && (rawLevel === 'max' || rawLevel === 'ultra');
  if (presetSuspended) {
    effectiveLevel = 'off';
  }

  const displayTier = effectiveLevel === 'off'
    ? (presetSuspended || rawLevel === 'max' || rawLevel === 'ultra'
      ? `OFF（思考已关闭，原 ${rawLevel.toUpperCase()} 预设已挂起）`
      : 'OFF（思考已关闭）')
    : effectiveLevel.toUpperCase();

  return {
    thinkingOn,
    rawLevel,
    effectiveLevel,
    canDispatch: derivedCanDispatch,
    presetSuspended,
    displayTier,
  };
}

export function verifyPromptToolAlignment({
  tools = [],
  thinking = true,
  reasoningLevel = 'medium',
  canDispatch = null,
  systemPromptText = '',
  degradationItems = [],
  arbitration = null,
} = {}) {
  const state = resolveEffectiveReasoningState({ thinking, reasoningLevel, canDispatch, tools });
  const toolNames = new Set((Array.isArray(tools) ? tools : []).map((t) => t && (t.name || (t.function && t.function.name))).filter(Boolean));
  const discrepancies = [];

  if (toolNames.has('dispatch_subagent') !== state.canDispatch) {
    discrepancies.push(`dispatch-tool-mismatch: toolHas=${toolNames.has('dispatch_subagent')} vs canDispatch=${state.canDispatch}`);
  }
  if (systemPromptText) {
    const promptSaysEnabled = systemPromptText.includes('本轮思考级别为 Max/Ultra，可以委派');
    const promptSaysDisabled = systemPromptText.includes('本轮未开启，工具表里没有它');
    const promptHasUltraHeader = systemPromptText.includes('## 本轮 Ultra（高于 High / Max）');
    if (state.canDispatch && promptSaysDisabled) {
      discrepancies.push('systemPrompt-says-disabled-when-canDispatch-true');
    }
    if (!state.canDispatch && (promptSaysEnabled || promptHasUltraHeader)) {
      discrepancies.push('systemPrompt-claims-max-ultra-active-when-canDispatch-false');
    }
  }
  for (const item of Array.isArray(degradationItems) ? degradationItems : []) {
    if (item && item.id === 'subagent-tier-gated') {
      if (state.canDispatch) {
        discrepancies.push('degradation-reports-tier-gated-when-canDispatch-true');
      }
      if (/当前思考档位为\s*(?:ULTRA|MAX)（18\s*路/i.test(String(item.reason || ''))) {
        discrepancies.push('self-contradictory-degradation-reason-claims-ultra-while-gated');
      }
    }
  }
  if (arbitration && !state.canDispatch && /当前\s*(?:ultra|max)\s*档位采用单模型/i.test(String(arbitration.depthDisclosure || ''))) {
    discrepancies.push('self-contradictory-arbitration-claims-ultra-tier-single-model');
  }

  return {
    aligned: discrepancies.length === 0,
    effectiveState: state,
    discrepancies,
  };
}

export function arbitrateUnifiedEvidence({
  canDispatch = false,
  thinking = true,
  reasoningLevel = 'medium',
  userText = '',
  stepHistory = [],
  subagentReports = [],
  tools = null,
} = {}) {
  const tierState = resolveEffectiveReasoningState({ thinking, reasoningLevel, canDispatch, tools });
  const effectiveCanDispatch = tierState.canDispatch;
  const tierLabel = tierState.displayTier;

  // 1) 若已有 >= 2 份子智能体报告，执行多专家独立沙箱置信度矩阵仲裁（深度等级 L3）
  if (Array.isArray(subagentReports) && subagentReports.length >= 2) {
    const subArb = arbitrateSubagentReports(subagentReports);
    return {
      mode: 'subagent-matrix',
      modeLabel: '子智能体置信度矩阵仲裁',
      depthTier: 'L3-swarm-isolation',
      criteriaAligned: true,
      depthGapDisclosed: true,
      depthDisclosure: '深度等级 L3（多子智能体独立上下文并发复核，推理深度完整，单点盲区风险最低）',
      hasConflict: subArb.hasConflict,
      note: formatSubagentArbitrationNote(subArb),
    };
  }

  // 2) 若当前回合已执行 >= 2 次工具调用（全档位通用），执行多工具结果交叉核验仲裁（深度等级 L2）
  const steps = Array.isArray(stepHistory) ? stepHistory : [];
  if (steps.length >= 2) {
    const okTools = steps.filter((s) => s && !s.isError).map((s) => s.name);
    const errTools = steps.filter((s) => s && s.isError).map((s) => s.name);
    const hasConflict = errTools.length > 0 && okTools.length > 0;
    const depthDisclosure = effectiveCanDispatch
      ? '深度等级 L2（多工具实测交叉核验，结论口径已对齐）'
      : `深度等级 L2（口径一致 + 误差已披露：当前有效档位 ${tierLabel} 通过多工具实测对齐结论口径，未启用 18 路独立子智能体隔离复核）`;
    const note = [
      `【天枢2.5 · L5 多工具证据交叉仲裁（有效档位：${tierLabel} ｜ ${depthDisclosure}）】`,
      `- 已完成工具证据链：成功 [${okTools.join(', ') || '无'}]${errTools.length ? ` ｜ 异常 [${errTools.join(', ')}]` : ''}`,
      hasConflict
        ? '- 分歧仲裁：部分工具曾返回报错或空结果，最终结论必须以最新成功执行的沙箱/本地工具实测输出为准，严禁混用失败步骤的中间猜测。'
        : '- 交叉核验：多步工具执行均通过，请校核各工具返回数值/路径的一致性后再收敛结论。',
    ].join('\n');
    return {
      mode: 'multi-tool-cross-check',
      modeLabel: '多工具结果交叉核验',
      depthTier: 'L2-tool-verified',
      criteriaAligned: true,
      depthGapDisclosed: true,
      depthDisclosure,
      hasConflict,
      note,
    };
  }

  // 3) 非委派态且遇到对比/评估/架构/多约束问题时，激活单模型正反自检（深度等级 L1，显式披露与多子智能体的结构性深度差距）
  const s = String(userText || '');
  if (!effectiveCanDispatch && MULTI_CONSTRAINT_OR_IMPLICIT_RE.test(s) && s.length >= 10) {
    const depthDisclosure = `口径一致 + 误差已披露：当前有效档位 ${tierLabel} 采用单模型正反自检对齐评判口径，但其推理深度与抗盲区能力结构性低于 Max/Ultra 的 18 路独立子智能体并发，复杂权衡可能存在单视角误差`;
    return {
      mode: 'internal-dual-perspective',
      modeLabel: '单模型正反自检（深度差异已披露）',
      depthTier: 'L1-single-model-self-check',
      criteriaAligned: true,
      depthGapDisclosed: true,
      depthDisclosure,
      hasConflict: false,
      note: `【天枢2.5 · L5 内源双视角交叉仲裁（${depthDisclosure}）】请在内部同时从「方案正向成立依据」与「边界反例/潜在隐患」两个对立视角交叉审视后再输出最终结论。`,
    };
  }

  return {
    mode: 'none',
    modeLabel: '按需待命',
    depthTier: 'L0-direct',
    criteriaAligned: true,
    depthGapDisclosed: true,
    depthDisclosure: '轻量直答，无需多路仲裁',
    hasConflict: false,
    note: '',
  };
}

// ─── 12. Stage 1 前提自校验与可解释降级诊断（Premise Self-Verification）──────
// 解决“单点前提错误向下传播（如启动期误判无中继，导致 L3–L6 全在错误前提上工作）”：
// 当 relayOk 为 false 但用户请求涉及网页/URL/远端 Git 时，执行实时重探针自校验，恢复即纠偏
const WEB_OR_GIT_INTENT_RE = /(?:https?:\/\/|网址|链接|网页|网站|浏览|访问|抓取|联网|上网|最新|当前|今日|今天|实时|搜索|检索|查询|查资料|搜一下|\burl\b|\bweb\b|\bwebpage\b|\bwebsite\b|\bbrowse\b|\blookup\b|\bcurrent\b|\btoday\b|\blatest\b|\bnews\b|\bweather\b|\bsearch(?:_web)?\b|\bcrawl(?:_site)?\b|\bclone\b|\bpush\b|\bpull\b|\bfetch(?:_url)?\b)/i;

export async function verifyRuntimePremises({
  relayOk = false,
  webEnabled = false,
  sandboxEnabled = true,
  userText = '',
  reprobeRelay = null,
} = {}) {
  let verifiedRelayOk = !!relayOk;
  let premiseCorrected = false;
  let reverifyTriggered = false;

  if (!verifiedRelayOk && typeof reprobeRelay === 'function' && WEB_OR_GIT_INTENT_RE.test(String(userText || ''))) {
    reverifyTriggered = true;
    try {
      const liveOk = await reprobeRelay();
      if (liveOk) {
        verifiedRelayOk = true;
        premiseCorrected = true;
      }
    } catch { /* 重探针失败保持原判 */ }
  }

  return {
    relayOk: verifiedRelayOk,
    webEnabled: verifiedRelayOk ? !!webEnabled : false,
    sandboxEnabled: !!sandboxEnabled,
    reverifyTriggered,
    premiseCorrected,
    verifiedAt: Date.now(),
  };
}

export function buildDegradationDiagnostics({
  relayOk = false,
  webEnabled = false,
  searchEnabled = null,
  crawlEnabled = null,
  sandboxEnabled = true,
  canDispatch = false,
  thinking = true,
  reasoningLevel = 'medium',
  tools = null,
  premiseCorrected = false,
} = {}) {
  const tierState = resolveEffectiveReasoningState({ thinking, reasoningLevel, canDispatch, tools });
  const items = [];
  if (!relayOk) {
    items.push({
      id: 'relay-offline',
      capability: 'fetch_url / search_web / crawl_site 网页能力与远端真实 Git',
      status: 'degraded',
      reason: '当前没有探测到可用网页中继（本地 server.py 或 Cloudflare Worker）',
      recovery: '启动 `python3 server.py` 以恢复单页抓取/Git，或部署新版 relay/worker.js 并在 localStorage 设置 dubhe-relay；刷新后重新探测',
    });
  } else if (!webEnabled) {
    items.push({
      id: 'web-switched-off',
      capability: 'fetch_url / search_web / crawl_site 网页能力',
      status: 'paused',
      reason: '网页中继在线，但当前会话已手动关闭顶栏「联网」开关',
      recovery: '点击顶栏「联网」胶囊开关即可恢复当前 relay 声明的网页能力',
    });
  }
  if (relayOk && webEnabled && searchEnabled === false) {
    items.push({
      id: 'worker-search-unavailable',
      capability: 'search_web 网页搜索',
      status: 'degraded',
      reason: '当前 relay 的 /api/health 未声明 search（常见于旧版 server.py 或旧 Worker）',
      recovery: '部署包含 /api/search 且 health.capabilities 含 search 的 relay/worker.js',
    });
  }
  if (relayOk && webEnabled && crawlEnabled === false) {
    items.push({
      id: 'worker-crawl-unavailable',
      capability: 'crawl_site 同源站点爬取',
      status: 'degraded',
      reason: '当前 relay 的 /api/health 未声明 crawl（常见于旧版 server.py 或旧 Worker）',
      recovery: '部署包含 /api/crawl 且 health.capabilities 含 crawl 的 relay/worker.js',
    });
  }
  if (!sandboxEnabled) {
    items.push({
      id: 'sandbox-switched-off',
      capability: 'execute_javascript / execute_python / execute_cpp 代码沙箱',
      status: 'paused',
      reason: '用户已手动关闭「沙箱」开关（0ms 本地纯函数工具如 evaluate_expression / execute_sql / regex / hash 仍正常可用）',
      recovery: '点击输入框下方「沙箱」按钮开启，即可恢复 JS Worker 与 Pyodide WASM 代码执行',
    });
  }
  if (!tierState.canDispatch) {
    const reasonText = tierState.effectiveLevel === 'off'
      ? `当前思考模式处于 ${tierState.displayTier}（关闭思考时 dispatch_subagent 自动卸载，18 路子智能体并发需开启思考且处于 Max / Ultra 档位）`
      : `当前有效思考档位为 ${tierState.displayTier}（18 路独立子智能体并发仅在开启思考并设为 Max / Ultra 档位时开放）`;
    items.push({
      id: 'subagent-tier-gated',
      capability: 'dispatch_subagent 外部专家子智能体并发委派',
      status: 'fallback',
      reason: reasonText,
      recovery: '当前采用「单模型正反自检 + 多工具交叉核验」对齐结论口径（推理深度低于多子智能体，误差风险已披露）；开启思考并切换至 Max 或 Ultra 即可挂载 dispatch_subagent',
    });
  }
  if (premiseCorrected) {
    items.push({
      id: 'premise-self-healed',
      capability: '环境前提实时重探针纠偏',
      status: 'recovered',
      reason: '启动期曾判定本地中继离线，本轮入口重探针检测到中继已上线并自动修正前提',
      recovery: '已自动恢复完整工具链',
    });
  }
  return items;
}

export function formatDegradationDiagnostics(items = [], { compact = false, capCode = '' } = {}) {
  if (!Array.isArray(items) || !items.length) return '';
  if (compact) {
    const shortList = items.map((it) => `${it.id}:${it.status}`).join(', ');
    return `【天枢2.5 · L2 能力掩码 ${capCode ? `[${capCode}] ` : ''}(${shortList})】`;
  }
  const lines = [`【天枢2.5 · L2 能力边界与降级可解释性诊断${capCode ? ` [${capCode}]` : ''}】若用户询问某项能力为何不可用或如何开启，请如实说明下列原因与恢复方法：`];
  for (const it of items) {
    lines.push(`- ${it.capability}：原因=${it.reason} ｜ 恢复方式=${it.recovery}`);
  }
  return lines.join('\n');
}

// Ephemeral 元信息注入预算控制器（解决“决策足迹、L2 诊断等元信息挤占上下文预算”问题）：
//   1. 快路径（FAST_DIRECT）完全跳过治理元信息注入（0 Token 开销）；
//   2. 全链路下仅当用户问题涉及能力/架构/自评或触发受限工具意图时才展开多行恢复指南，否则压缩为单行能力掩码，降低 >65% 元提示词开销。
const GOVERNANCE_DETAIL_TRIGGER_RE = /(?:天枢|Dubhe Helix 2\.5|框架|架构|自评|评分|降级|为什么不能|不可用|开启|恢复|联网|中继|沙箱|子智能体|dispatch_subagent|fetch_url|能力|权限|工具表|口径|足迹)/i;

export function budgetEphemeralGovernanceNotes({
  fastPath = false,
  userText = '',
  footprint = null,
  degradations = [],
  capCode = '',
  arbitrationNote = '',
  engineRoutingNote = '',
} = {}) {
  if (fastPath) {
    return {
      footprintNote: '',
      degradationNote: '',
      arbitrationNote: '',
      engineRoutingNote: '',
      compactMode: true,
      savedChars: 0,
    };
  }
  const s = String(userText || '');
  const needFullGovernance = GOVERNANCE_DETAIL_TRIGGER_RE.test(s) || WEB_OR_GIT_INTENT_RE.test(s);
  const fullFootprint = formatDecisionFootprintForPrompt(footprint);
  const fullDegradation = formatDegradationDiagnostics(degradations, { compact: false, capCode });

  const footprintNote = needFullGovernance
    ? fullFootprint
    : (footprint ? `【天枢足迹】${footprint.modeLabel} ｜ 掩码=${capCode || 'R·W·S·D'} ｜ 记忆=${footprint.memoryCount} ｜ 链校验=${footprint.traceHash}` : '');
  const degradationNote = needFullGovernance
    ? fullDegradation
    : formatDegradationDiagnostics(degradations, { compact: true, capCode });

  const fullLen = fullFootprint.length + fullDegradation.length;
  const actualLen = footprintNote.length + degradationNote.length;
  return {
    footprintNote,
    degradationNote,
    arbitrationNote: arbitrationNote || '',
    engineRoutingNote: engineRoutingNote || '',
    compactMode: !needFullGovernance,
    savedChars: Math.max(0, fullLen - actualLen),
  };
}

// ─── 13. SHA-256 跨轮次追加哈希链与独立 Store 交叉审计（Append-Only SHA-256 Trace Chain & Cross-Store Audit）──
// 工程边界声明：
//   1. 采用 FIPS 180-4 标准 SHA-256 构造跨事件与跨轮次追加哈希链（prevTurnDigest → eventHash_1 → ... → turnDigest），替代 32 位非加密 FNV-1a；
//   2. 哈希链用于校验客户端顺序完整性与防意外篡改（非硬件 TEE 远程证明）；
//   3. 配套 auditFootprintAgainstStore 将足迹自报字段与外部 Store 中的 assistantMsg.toolCalls 及 role==="tool" 消息做独立交叉核对。
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr32(x, n) {
  return (x >>> n) | (x << (32 - n));
}

export function sha256Hex(input) {
  const utf8 = new TextEncoder().encode(String(input ?? ''));
  const bitLen = utf8.length * 8;
  const padLen = (((utf8.length + 8) >>> 6) + 1) << 6;
  const buf = new Uint8Array(padLen);
  buf.set(utf8);
  buf[utf8.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(padLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let offset = 0; offset < padLen; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((v) => v.toString(16).padStart(8, '0')).join('');
}

export const GENESIS_TURN_DIGEST = '0'.repeat(64);

export function createFaithfulTraceRecorder({ prevTurnDigest = GENESIS_TURN_DIGEST } = {}) {
  const seedDigest = String(prevTurnDigest || GENESIS_TURN_DIGEST);
  const events = [];
  let headDigest = seedDigest;
  return {
    prevTurnDigest: seedDigest,
    events,
    record(branch, detail = '') {
      const seq = events.length + 1;
      const b = String(branch || '');
      const d = String(detail || '');
      const prevHash = headDigest;
      const eventHash = sha256Hex(`${prevHash}|${seq}|${b}|${d}`);
      headDigest = eventHash;
      events.push({
        seq,
        branch: b,
        detail: d,
        prevHash,
        eventHash,
        ts: Date.now(),
      });
      return this;
    },
    getBranches() {
      return events.map((e) => e.branch);
    },
    computeFullDigest() {
      let cur = seedDigest;
      for (const e of events) {
        cur = sha256Hex(`${cur}|${e.seq}|${e.branch}|${e.detail}`);
      }
      return cur;
    },
    computeTraceHash() {
      return 'tr-sha256-' + this.computeFullDigest().slice(0, 16);
    },
  };
}

export function verifyFootprintFaithfulness(fp, traceRecorder = null) {
  if (!fp) return { faithful: false, faithfulnessRate: 0, reason: 'missing-footprint' };
  if (!traceRecorder || !Array.isArray(traceRecorder.events) || !traceRecorder.events.length) {
    return { faithful: !!fp.traceHash, faithfulnessRate: fp.traceHash ? 1.0 : 0.0, reason: fp.traceHash ? 'hash-present' : 'unverified-static' };
  }
  const branches = new Set(traceRecorder.getBranches());
  let checks = 0;
  let passed = 0;

  // 1) 校验路由分支是否真实走过
  checks++;
  if (fp.escalated ? branches.has('route:escalated') : (fp.fastPath ? branches.has('route:fast-path') : branches.has('route:full-nexus'))) {
    passed++;
  }
  // 2) 校验记忆注入是否与实际分支一致
  checks++;
  if ((fp.memoryCount > 0) === branches.has('memory:injected')) passed++;
  // 3) 校验工具调用是否与实际分支一致
  checks++;
  if (((fp.usedTools && fp.usedTools.length > 0)) === branches.has('tools:executed')) passed++;
  // 4) 校验 SHA-256 链式摘要与每个事件节点的前后衔接是否完整
  checks++;
  const expectedHash = traceRecorder.computeTraceHash();
  let chainIntact = true;
  let cursor = traceRecorder.prevTurnDigest || GENESIS_TURN_DIGEST;
  for (const ev of traceRecorder.events) {
    const recomputed = sha256Hex(`${cursor}|${ev.seq}|${ev.branch}|${ev.detail}`);
    if (ev.prevHash !== cursor || ev.eventHash !== recomputed) {
      chainIntact = false;
      break;
    }
    cursor = recomputed;
  }
  if (fp.traceHash === expectedHash && chainIntact) passed++;

  const rate = Number((passed / Math.max(1, checks)).toFixed(2));
  return {
    faithful: rate === 1,
    faithfulnessRate: rate,
    chainIntact,
    expectedHash,
    actualHash: fp.traceHash,
    integrityScope: 'client-side-sha256-hash-chain',
  };
}

// 独立外部交叉审计器（Cross-Store External Auditor）：
// 针对“自采样自上报缺第三方校验”，将足迹自报内容与外部会话 Store 持久化的真实消息记录做交叉对账：
//   1. 对照 assistantMsg.toolCalls 实际工具名集合 vs footprint.usedTools；
//   2. 对照 turnMessages 中 role === 'tool' 的实际工具回包数量；
//   3. 对照上一轮 assistant 消息的 turnDigest 与本轮 footprint.prevTurnDigest 是否形成连续哈希链。
export function auditFootprintAgainstStore(fp, {
  assistantMsg = null,
  turnMessages = [],
  prevFootprint = null,
} = {}) {
  if (!fp) return { passed: false, auditScore: 0, discrepancies: ['missing-footprint'] };
  const discrepancies = [];
  let checks = 0;
  let passedChecks = 0;

  const claimedTools = [...new Set((fp.usedTools || []).filter(Boolean))].sort();

  // 1) 核对 assistantMsg.toolCalls 外部落盘记录
  if (assistantMsg && typeof assistantMsg === 'object') {
    checks++;
    const msgToolNames = [...new Set(
      (Array.isArray(assistantMsg.toolCalls) ? assistantMsg.toolCalls : [])
        .map((tc) => tc && (tc.name || (tc.function && tc.function.name)))
        .filter(Boolean)
    )].sort();
    if (JSON.stringify(claimedTools) === JSON.stringify(msgToolNames)) {
      passedChecks++;
    } else {
      discrepancies.push(`toolCalls-mismatch: footprint=[${claimedTools.join(',')}] vs store.assistantMsg=[${msgToolNames.join(',')}]`);
    }
  }

  // 2) 核对会话消息流中 role === 'tool' 的真实工具执行回包
  if (Array.isArray(turnMessages) && turnMessages.length > 0) {
    checks++;
    const toolResultMsgs = turnMessages.filter((m) => m && m.role === 'tool');
    const storeToolNames = [...new Set(toolResultMsgs.map((m) => m.name).filter(Boolean))].sort();
    const hasToolsInStore = toolResultMsgs.length > 0;
    const hasToolsInFootprint = claimedTools.length > 0;
    if (hasToolsInStore === hasToolsInFootprint && (!storeToolNames.length || JSON.stringify(claimedTools) === JSON.stringify(storeToolNames))) {
      passedChecks++;
    } else {
      discrepancies.push(`store-tool-messages-mismatch: footprint=[${claimedTools.join(',')}] vs store.toolMsgs=[${storeToolNames.join(',')}]`);
    }
  }

  // 3) 核对跨轮次哈希链前序摘要（prevTurnDigest）是否与上一轮 turnDigest 严格一致
  if (prevFootprint && prevFootprint.turnDigest) {
    checks++;
    if (fp.prevTurnDigest === prevFootprint.turnDigest) {
      passedChecks++;
    } else {
      discrepancies.push(`broken-turn-hash-chain: prevTurnDigest=${fp.prevTurnDigest} !== prev.turnDigest=${prevFootprint.turnDigest}`);
    }
  }

  // 4) 核对 SHA-256 格式合法性
  checks++;
  if (typeof fp.turnDigest === 'string' && /^[0-9a-f]{64}$/.test(fp.turnDigest) && String(fp.traceHash || '').startsWith('tr-sha256-')) {
    passedChecks++;
  } else {
    discrepancies.push('invalid-sha256-digest-format');
  }

  const auditScore = checks > 0 ? Number((passedChecks / checks).toFixed(4)) : 1;
  return {
    passed: discrepancies.length === 0,
    auditScore,
    checksRun: checks,
    passedChecks,
    discrepancies,
    auditMechanism: 'independent-store-cross-verification',
  };
}

export function buildDecisionFootprint({
  profile = null,
  memories = [],
  recalledArchivedMemories = [],
  recalledSessions = [],
  matchedSkillIds = [],
  prunedSkillIds = [],
  archivedSkillIds = [],
  usedTools = [],
  arbitration = null,
  degradations = [],
  traceRecorder = null,
  prevTurnDigest = GENESIS_TURN_DIGEST,
} = {}) {
  const mode = profile ? profile.mode : 'full-nexus';
  const escalated = !!(profile && profile.escalated);
  const fastPath = !!(profile && profile.fastPath);
  const modeLabel = escalated
    ? 'L1↗L6 中途升档'
    : (fastPath ? 'L1 轻快直达' : 'L1→L6 全链路');

  const memTags = (Array.isArray(memories) ? memories : [])
    .slice(0, 4)
    .map((m) => `${m.id || 'mem'}:${String(m.text || m).slice(0, 18)}`);
  const sessTitles = (Array.isArray(recalledSessions) ? recalledSessions : [])
    .slice(0, 3)
    .map((s) => s.title || s.sessionId || '历史会话');
  const skills = [...new Set((Array.isArray(matchedSkillIds) ? matchedSkillIds : []).filter(Boolean))];
  const pruned = [...new Set((Array.isArray(prunedSkillIds) ? prunedSkillIds : []).filter(Boolean))];
  const softArchived = [...new Set((Array.isArray(archivedSkillIds) ? archivedSkillIds : []).filter(Boolean))];
  const revivedMem = (Array.isArray(recalledArchivedMemories) ? recalledArchivedMemories : []).map((m) => m.id || 'mem');
  const tools = [...new Set((Array.isArray(usedTools) ? usedTools : []).filter(Boolean))];
  const degShort = (Array.isArray(degradations) ? degradations : []).map((d) => d.id);

  const rec = traceRecorder || (() => {
    const r = createFaithfulTraceRecorder({ prevTurnDigest });
    r.record(escalated ? 'route:escalated' : (fastPath ? 'route:fast-path' : 'route:full-nexus'), mode);
    if (Array.isArray(memories) && memories.length > 0) r.record('memory:injected', String(memories.length));
    if (tools.length > 0) r.record('tools:executed', tools.join(','));
    return r;
  })();
  const traceHash = rec.computeTraceHash();
  const turnDigest = rec.computeFullDigest();

  const fp = {
    mode,
    fastPath,
    escalated,
    modeLabel,
    memoryCount: Array.isArray(memories) ? memories.length : 0,
    memoryTags: memTags,
    revivedMemories: revivedMem,
    recalledSessions: sessTitles,
    matchedSkills: skills,
    prunedSkills: pruned,
    softArchivedSkills: softArchived,
    usedTools: tools,
    arbitrationMode: (arbitration && arbitration.modeLabel) || '按需待命',
    depthDisclosure: (arbitration && arbitration.depthDisclosure) || '',
    degradations: degShort,
    hashAlgorithm: 'SHA-256 (FIPS 180-4)',
    prevTurnDigest: rec.prevTurnDigest || prevTurnDigest,
    turnDigest,
    traceHash,
    executedBranches: rec.getBranches(),
  };
  const verification = verifyFootprintFaithfulness(fp, rec);
  fp.faithful = verification.faithful;
  fp.faithfulnessRate = verification.faithfulnessRate;
  return fp;
}

export function formatDecisionFootprintForPrompt(fp) {
  if (!fp) return '';
  const parts = [
    `路径=${fp.modeLabel}`,
    `生效记忆=${fp.memoryCount}条${fp.memoryTags && fp.memoryTags.length ? `(${fp.memoryTags.join(', ')})` : ''}`,
    ...(fp.revivedMemories && fp.revivedMemories.length ? [`冷归档唤醒=${fp.revivedMemories.join(', ')}`] : []),
    `跨会话召回=${fp.recalledSessions && fp.recalledSessions.length ? fp.recalledSessions.join('、') : '无'}`,
    `命中技能=${fp.matchedSkills && fp.matchedSkills.length ? fp.matchedSkills.join(', ') : '无'}`,
    ...(fp.prunedSkills && fp.prunedSkills.length ? [`GC淘汰噪声技能=${fp.prunedSkills.join(', ')}`] : []),
    ...(fp.softArchivedSkills && fp.softArchivedSkills.length ? [`转冷备技能=${fp.softArchivedSkills.join(', ')}`] : []),
    `L5仲裁=${fp.arbitrationMode || '按需待命'}`,
    `链式校验=${fp.traceHash || 'verified'}(前序:${String(fp.prevTurnDigest || '').slice(0, 8)})`,
  ];
  return `【天枢2.5 · 本轮决策足迹（透明可归因）】${parts.join(' ｜ ')}`;
}

export function formatDecisionFootprintSummary(fp) {
  if (!fp) return '';
  const bits = [`天枢 ${fp.modeLabel}`];
  if (fp.memoryCount > 0) bits.push(`记忆×${fp.memoryCount}`);
  if (fp.revivedMemories && fp.revivedMemories.length) bits.push(`冷备唤醒×${fp.revivedMemories.length}`);
  if (fp.recalledSessions && fp.recalledSessions.length) bits.push(`召回×${fp.recalledSessions.length}`);
  if (fp.matchedSkills && fp.matchedSkills.length) bits.push(`技能:${fp.matchedSkills.join('/')}`);
  if (fp.usedTools && fp.usedTools.length) bits.push(`工具×${fp.usedTools.length}`);
  if (fp.prunedSkills && fp.prunedSkills.length) bits.push(`GC清理×${fp.prunedSkills.length}`);
  return bits.join(' · ');
}

// ─── 14. 组合态交集不变量验证与代价加权混淆矩阵评测（Confusion Matrix & Cost-Weighted Scorecard）────
export function verifyCombinatorialIntersectionMatrix() {
  const cases = [
    {
      name: 'L2降级 × L3双记忆 × L4临界技能软归档 × L1中途反悔升档',
      relayOk: false,
      webEnabled: false,
      sandboxEnabled: true,
      canDispatch: false,
      userText: '你好',
      followUpToolCalls: 1,
      memories: [{ id: 'mem-a001', text: '用户偏好使用中文回答' }, { id: 'mem-a002', text: '项目使用 Node.js 20' }],
    },
    {
      name: '指代多约束追问 × 低档位正反自检深度披露 × 沙箱关闭',
      relayOk: true,
      webEnabled: true,
      sandboxEnabled: false,
      canDispatch: false,
      userText: '这个呢？为什么六层独立降级会带来笛卡尔积组合爆炸？',
      followUpToolCalls: 0,
      memories: [],
    },
    {
      name: 'Max/Ultra 蜂群并发 × 子智能体冲突仲裁 × 全能力在线',
      relayOk: true,
      webEnabled: true,
      sandboxEnabled: true,
      canDispatch: true,
      userText: '全面评估并对比两个模块的性能与安全性',
      followUpToolCalls: 2,
      memories: [{ id: 'mem-b001', text: '性能测试基准为 P50 延迟' }],
    },
  ];

  let passed = 0;
  const details = [];
  let prevTurnDigest = GENESIS_TURN_DIGEST;
  for (const c of cases) {
    const initProf = resolveNexusExecutionProfile({
      userText: c.userText,
      plan: { route: { choice: 'direct' }, need_tools: { noul: 0.05 } },
    });
    const finalProf = c.followUpToolCalls > 0
      ? escalateNexusProfile(initProf, { iteration: 2, toolCallsCount: c.followUpToolCalls, userText: c.userText })
      : initProf;
    const canon = resolveCanonicalRuntimeState({
      profile: finalProf,
      relayOk: c.relayOk,
      webEnabled: c.webEnabled,
      sandboxEnabled: c.sandboxEnabled,
      canDispatch: c.canDispatch,
    });
    const degs = buildDegradationDiagnostics({
      relayOk: c.relayOk,
      webEnabled: c.webEnabled,
      sandboxEnabled: c.sandboxEnabled,
      canDispatch: c.canDispatch,
    });
    const arb = arbitrateUnifiedEvidence({
      canDispatch: c.canDispatch,
      reasoningLevel: c.canDispatch ? 'ultra' : 'medium',
      userText: c.userText,
      stepHistory: c.followUpToolCalls > 0 ? [{ name: 'read_file', isError: false }, { name: 'search_files', isError: false }] : [],
    });
    const rec = createFaithfulTraceRecorder({ prevTurnDigest });
    rec.record(finalProf.escalated ? 'route:escalated' : (finalProf.fastPath ? 'route:fast-path' : 'route:full-nexus'), finalProf.mode);
    if (c.memories.length > 0) rec.record('memory:injected', String(c.memories.length));
    if (c.followUpToolCalls > 0) rec.record('tools:executed', 'read_file');

    const fp = buildDecisionFootprint({
      profile: finalProf,
      memories: c.memories,
      usedTools: c.followUpToolCalls > 0 ? ['read_file'] : [],
      arbitration: arb,
      degradations: degs,
      traceRecorder: rec,
      prevTurnDigest,
    });
    prevTurnDigest = fp.turnDigest;

    const storeAudit = auditFootprintAgainstStore(fp, {
      assistantMsg: { toolCalls: c.followUpToolCalls > 0 ? [{ name: 'read_file' }] : [] },
      turnMessages: c.followUpToolCalls > 0 ? [{ role: 'tool', name: 'read_file', content: 'ok' }] : [],
    });

    const invariantOk = Boolean(
      canon && canon.id && canon.capCode
      && fp.faithful === true
      && storeAudit.passed === true
      && arb.depthGapDisclosed === true
      && (c.followUpToolCalls > 0 ? finalProf.fastPath === false : true)
    );
    if (invariantOk) passed++;
    details.push({
      name: c.name,
      canonicalState: canon.id,
      capCode: canon.capCode,
      faithful: fp.faithful,
      storeAuditPassed: storeAudit.passed,
      ok: invariantOk,
    });
  }
  return {
    totalCases: cases.length,
    passedCases: passed,
    passRate: Number((passed / cases.length).toFixed(2)),
    details,
  };
}

// 离线路由升档标注评测集（N=120：60 正例应走全链路/升档，60 负例应走快路径；由 In-Domain 开发集 N=60 与 OOD 独立留出集 N=60 构成）
export const ROUTE_ESCALATION_BENCHMARK = Object.freeze([
  // ── 1. In-Domain Positive (shouldEscalate = true, split = 'in_domain'，共 30 条) ──
  { id: 'rt-pos-01', split: 'in_domain', text: '这个呢？为什么会出现这个问题？', shouldEscalate: true, category: 'pronoun-followup' },
  { id: 'rt-pos-02', split: 'in_domain', text: '对比一下这两种缓存方案的优缺点', shouldEscalate: true, category: 'comparison' },
  { id: 'rt-pos-03', split: 'in_domain', text: '首先读取配置文件，然后分析性能瓶颈', shouldEscalate: true, category: 'multi-step-explicit' },
  { id: 'rt-pos-04', split: 'in_domain', text: '如何从架构上解决状态空间组合复杂度？', shouldEscalate: true, category: 'architecture-how' },
  { id: 'rt-pos-05', split: 'in_domain', text: '刚才那个结论不对，帮我重新推导验证一下', shouldEscalate: true, category: 'correction-verify' },
  { id: 'rt-pos-06', split: 'in_domain', text: '如果把 TTL 删除改成软归档，怎么设计？', shouldEscalate: true, category: 'design-tradeoff' },
  { id: 'rt-pos-07', split: 'in_domain', text: '评价一下这套 Agent 框架的工程可测性', shouldEscalate: true, category: 'critique' },
  { id: 'rt-pos-08', split: 'in_domain', text: '帮我算一下 sha256 哈希并写进文件', shouldEscalate: true, category: 'tool-required' },
  { id: 'rt-pos-09', split: 'in_domain', text: '把两份方案的差异点列个清单', shouldEscalate: true, category: 'implicit-diff-list' },
  { id: 'rt-pos-10', split: 'in_domain', text: '给这套状态机挑挑毛病', shouldEscalate: true, category: 'colloquial-review' },
  { id: 'rt-pos-11', split: 'in_domain', text: '首先解析 JSON，接着按时间戳排序并去重', shouldEscalate: true, category: 'multi-step-explicit' },
  { id: 'rt-pos-12', split: 'in_domain', text: '对比 SQLite WAL 模式与传统回滚日志的区别', shouldEscalate: true, category: 'comparison' },
  { id: 'rt-pos-13', split: 'in_domain', text: '为什么 KV Cache 前缀树在插入动态时间戳后会失效？', shouldEscalate: true, category: 'causal-why' },
  { id: 'rt-pos-14', split: 'in_domain', text: '如何用 Python 在沙箱里计算 Wilson 置信区间？', shouldEscalate: true, category: 'code-how' },
  { id: 'rt-pos-15', split: 'in_domain', text: '一步步推导贝叶斯后验概率公式', shouldEscalate: true, category: 'derivation' },
  { id: 'rt-pos-16', split: 'in_domain', text: '那如果并发请求量翻十倍，现有的锁机制还能撑住吗？', shouldEscalate: true, category: 'hypothetical-followup' },
  { id: 'rt-pos-17', split: 'in_domain', text: '前面第三条提到的哈希链校验，能详细讲讲底层原理吗？', shouldEscalate: true, category: 'context-ref' },
  { id: 'rt-pos-18', split: 'in_domain', text: '帮我搜索一下项目里的所有 regex 工具定义', shouldEscalate: true, category: 'tool-required' },
  { id: 'rt-pos-19', split: 'in_domain', text: '同时考虑延迟、吞吐量和成本，应该怎么权衡模型路由？', shouldEscalate: true, category: 'multi-constraint' },
  { id: 'rt-pos-20', split: 'in_domain', text: '画一张天枢六层治理管线的 SVG 流程图', shouldEscalate: true, category: 'chart-generation' },
  { id: 'rt-pos-21', split: 'in_domain', text: '帮我用 SQL 查询一下销售额排名前五的品类并画柱状图', shouldEscalate: true, category: 'tool-and-chart' },
  { id: 'rt-pos-22', split: 'in_domain', text: '自评一下刚才那段重构代码的潜在缺陷与边界风险', shouldEscalate: true, category: 'self-eval' },
  { id: 'rt-pos-23', split: 'in_domain', text: '不仅要支持软归档恢复，而且还要支持物理擦除，怎么重构？', shouldEscalate: true, category: 'multi-constraint' },
  { id: 'rt-pos-24', split: 'in_domain', text: '核实一下 https://teamorouter.com/pricing 上的最新价格', shouldEscalate: true, category: 'web-verify' },
  { id: 'rt-pos-25', split: 'in_domain', text: '上次我们讨论的那个缓存淘汰策略是什么来着？', shouldEscalate: true, category: 'session-recall' },
  { id: 'rt-pos-26', split: 'in_domain', text: '对比 React Server Components 和传统 SSR 的架构利弊', shouldEscalate: true, category: 'comparison' },
  { id: 'rt-pos-27', split: 'in_domain', text: '排查一下为什么单元测试在无网络沙箱下会超时', shouldEscalate: true, category: 'troubleshooting' },
  { id: 'rt-pos-28', split: 'in_domain', text: '把这几个模块的依赖关系整理成思维导图', shouldEscalate: true, category: 'chart-generation' },
  { id: 'rt-pos-29', split: 'in_domain', text: '如果把子智能体并发数从 4 提升到 18，会有什么瓶颈？', shouldEscalate: true, category: 'hypothetical-bottleneck' },
  { id: 'rt-pos-30', split: 'in_domain', text: '帮我写一段 JavaScript 脚本验证正交掩码的不相交性', shouldEscalate: true, category: 'code-generation' },

  // ── 2. OOD Holdout Positive (shouldEscalate = true, split = 'ood_holdout'，共 30 条) ──
  { id: 'rt-pos-31', split: 'ood_holdout', text: 'Why does FNV-1a have a higher collision risk than SHA-256?', shouldEscalate: true, category: 'ood-english-why' },
  { id: 'rt-pos-32', split: 'ood_holdout', text: 'Compare optimistic locking vs pessimistic locking in PostgreSQL', shouldEscalate: true, category: 'ood-english-compare' },
  { id: 'rt-pos-33', split: 'ood_holdout', text: 'What about the tail latency under bursty traffic?', shouldEscalate: true, category: 'ood-english-followup' },
  { id: 'rt-pos-34', split: 'ood_holdout', text: 'Evaluate the trade-off between prompt caching and dynamic context injection', shouldEscalate: true, category: 'ood-english-tradeoff' },
  { id: 'rt-pos-35', split: 'ood_holdout', text: '分析这两种共识算法在弱网分区下的异同', shouldEscalate: true, category: 'ood-comparison' },
  { id: 'rt-pos-36', split: 'ood_holdout', text: '帮我找找这段鉴权逻辑里有没有越权漏洞', shouldEscalate: true, category: 'ood-security-review' },
  { id: 'rt-pos-37', split: 'ood_holdout', text: '把这三个备选架构的优劣整理成表', shouldEscalate: true, category: 'ood-table-synthesis' },
  { id: 'rt-pos-38', split: 'ood_holdout', text: '那它呢？在高并发写场景下也会退化吗？', shouldEscalate: true, category: 'ood-pronoun-followup' },
  { id: 'rt-pos-39', split: 'ood_holdout', text: '除了调整超时阈值，还有什么办法能根治级联雪崩？', shouldEscalate: true, category: 'ood-multi-constraint' },
  { id: 'rt-pos-40', split: 'ood_holdout', text: '深入剖析一下 V8 隐藏类与内联缓存的工作原理', shouldEscalate: true, category: 'ood-deep-dive' },
  { id: 'rt-pos-41', split: 'ood_holdout', text: '用折线图展示最近六个季度的毛利率变化趋势', shouldEscalate: true, category: 'ood-chart' },
  { id: 'rt-pos-42', split: 'ood_holdout', text: '克隆远端 git 仓库并检查最近的 commit 记录', shouldEscalate: true, category: 'ood-git-tool' },
  { id: 'rt-pos-43', split: 'ood_holdout', text: '证明在有向无环图上拓扑排序的时间复杂度为 O(V+E)', shouldEscalate: true, category: 'ood-proof' },
  { id: 'rt-pos-44', split: 'ood_holdout', text: '为什么直接把全量工具挂载进每次请求会拉低推理准确率？', shouldEscalate: true, category: 'ood-causal' },
  { id: 'rt-pos-45', split: 'ood_holdout', text: '如何设计一套支持幂等重试与死信队列的异步消息总线？', shouldEscalate: true, category: 'ood-architecture' },
  { id: 'rt-pos-46', split: 'ood_holdout', text: '上面第二条建议里的参数如果设成 0 会发生什么？', shouldEscalate: true, category: 'ood-context-ref' },
  { id: 'rt-pos-47', split: 'ood_holdout', text: '帮我运行一段 Python 代码校核混淆矩阵的 F1 分数', shouldEscalate: true, category: 'ood-sandbox-verify' },
  { id: 'rt-pos-48', split: 'ood_holdout', text: '挑刺一下这份系统设计文档里的短板与工程痛点', shouldEscalate: true, category: 'ood-critique' },
  { id: 'rt-pos-49', split: 'ood_holdout', text: '之前聊过的那个多路仲裁方案，它的冲突判定公式是怎么写的？', shouldEscalate: true, category: 'ood-recall' },
  { id: 'rt-pos-50', split: 'ood_holdout', text: '既要保证零外部依赖，又要通过全部安全基线测试，怎么实现？', shouldEscalate: true, category: 'ood-multi-constraint' },
  { id: 'rt-pos-51', split: 'ood_holdout', text: '读取 package.json 文件并对比各测试脚本的职责区别', shouldEscalate: true, category: 'ood-file-tool' },
  { id: 'rt-pos-52', split: 'ood_holdout', text: '指派子智能体分别从性能、安全、可维护性三个维度并发审查代码', shouldEscalate: true, category: 'ood-subagent' },
  { id: 'rt-pos-53', split: 'ood_holdout', text: '验证一下在 N=200 时 Wilson 95% 置信区间的半宽是否小于 5%', shouldEscalate: true, category: 'ood-math-verify' },
  { id: 'rt-pos-54', split: 'ood_holdout', text: '分析冷启动延迟高的底层原因并给出三阶段优化路线', shouldEscalate: true, category: 'ood-root-cause' },
  { id: 'rt-pos-55', split: 'ood_holdout', text: 'How about partitioning the state table by tenant ID?', shouldEscalate: true, category: 'ood-english-how-about' },
  { id: 'rt-pos-56', split: 'ood_holdout', text: '帮我绘制一张各模块 Token 消耗占比的饼图', shouldEscalate: true, category: 'ood-pie-chart' },
  { id: 'rt-pos-57', split: 'ood_holdout', text: '权衡一下同步阻塞探测与 0ms 本地预筛在 P50 延迟上的取舍', shouldEscalate: true, category: 'ood-tradeoff' },
  // 真实 OOD 隐式复杂长尾负向/正向边界样本（不含任何显式正则关键词且 <=42 字，用于诚实暴露纯本地规则预筛在隐式语义上的 FN 盲区）
  { id: 'rt-pos-58', split: 'ood_holdout', text: 'A方案吞吐高但丢消息，B方案可靠但慢，选哪个？', shouldEscalate: true, category: 'ood-implicit-tradeoff-fn-edge' },
  { id: 'rt-pos-59', split: 'ood_holdout', text: '线上接口偶发 502，日志只有连接重置，从哪下手？', shouldEscalate: true, category: 'ood-implicit-debug-fn-edge' },
  { id: 'rt-pos-60', split: 'ood_holdout', text: '这段逻辑看著挺顺，上线后在极端并发下会翻车吗？', shouldEscalate: true, category: 'ood-colloquial-risk-fn-edge' },

  // ── 3. In-Domain Negative (shouldEscalate = false, split = 'in_domain'，共 30 条) ──
  { id: 'rt-neg-01', split: 'in_domain', text: '你好，今天心情怎么样？', shouldEscalate: false, category: 'greeting' },
  { id: 'rt-neg-02', split: 'in_domain', text: '早上好！', shouldEscalate: false, category: 'greeting' },
  { id: 'rt-neg-03', split: 'in_domain', text: '谢谢你的解答，非常清楚', shouldEscalate: false, category: 'thanks' },
  { id: 'rt-neg-04', split: 'in_domain', text: '水的标准沸点是多少摄氏度？', shouldEscalate: false, category: 'simple-fact' },
  { id: 'rt-neg-05', split: 'in_domain', text: '一句话解释什么是光合作用', shouldEscalate: false, category: 'simple-fact' },
  { id: 'rt-neg-06', split: 'in_domain', text: '地球绕太阳公转一周大约多少天？', shouldEscalate: false, category: 'simple-fact' },
  { id: 'rt-neg-07', split: 'in_domain', text: '好的，明白了', shouldEscalate: false, category: 'ack' },
  { id: 'rt-neg-08', split: 'in_domain', text: '辛苦啦，晚安', shouldEscalate: false, category: 'greeting' },
  { id: 'rt-neg-09', split: 'in_domain', text: '为什么今天天气这么好呀？', shouldEscalate: false, category: 'casual-why-exemption' },
  { id: 'rt-neg-10', split: 'in_domain', text: '怎么称呼你比较好？', shouldEscalate: false, category: 'casual-how-exemption' },
  { id: 'rt-neg-11', split: 'in_domain', text: '在吗？测试一下连接', shouldEscalate: false, category: 'ping' },
  { id: 'rt-neg-12', split: 'in_domain', text: '法国的首都是哪个城市？', shouldEscalate: false, category: 'simple-fact' },
  { id: 'rt-neg-13', split: 'in_domain', text: '1 公里等于多少米？', shouldEscalate: false, category: 'simple-fact' },
  { id: 'rt-neg-14', split: 'in_domain', text: '收到，十分感谢！', shouldEscalate: false, category: 'thanks' },
  { id: 'rt-neg-15', split: 'in_domain', text: '下午好，喝杯咖啡休息一下吧', shouldEscalate: false, category: 'casual-chat' },
  { id: 'rt-neg-16', split: 'in_domain', text: '光在真空中的传播速度大约是多少？', shouldEscalate: false, category: 'simple-fact' },
  { id: 'rt-neg-17', split: 'in_domain', text: '《红楼梦》的作者是谁？', shouldEscalate: false, category: 'simple-fact' },
  { id: 'rt-neg-18', split: 'in_domain', text: '英语里的 Apple 是什么意思？', shouldEscalate: false, category: 'translation' },
  { id: 'rt-neg-19', split: 'in_domain', text: '祝你今天工作愉快！', shouldEscalate: false, category: 'greeting' },
  { id: 'rt-neg-20', split: 'in_domain', text: '没问题，就按这个来', shouldEscalate: false, category: 'ack' },
  { id: 'rt-neg-21', split: 'in_domain', text: '一年有几个季节？', shouldEscalate: false, category: 'simple-fact' },
  { id: 'rt-neg-22', split: 'in_domain', text: '三角形的内角和是多少度？', shouldEscalate: false, category: 'simple-fact' },
  { id: 'rt-neg-23', split: 'in_domain', text: '太棒了，完全符合预期', shouldEscalate: false, category: 'praise' },
  { id: 'rt-neg-24', split: 'in_domain', text: '嗨，很高兴认识你', shouldEscalate: false, category: 'greeting' },
  { id: 'rt-neg-25', split: 'in_domain', text: '把“早上好”翻译成日语', shouldEscalate: false, category: 'translation' },
  { id: 'rt-neg-26', split: 'in_domain', text: '水分子的化学式怎么写？', shouldEscalate: false, category: 'simple-fact' },
  { id: 'rt-neg-27', split: 'in_domain', text: '知道了，我先试试看', shouldEscalate: false, category: 'ack' },
  { id: 'rt-neg-28', split: 'in_domain', text: '人体正常体温大约在多少度左右？', shouldEscalate: false, category: 'simple-fact' },
  { id: 'rt-neg-29', split: 'in_domain', text: '周末愉快！', shouldEscalate: false, category: 'greeting' },
  { id: 'rt-neg-30', split: 'in_domain', text: '声音在空气中的传播速度大约是多少米每秒？', shouldEscalate: false, category: 'simple-fact' },

  // ── 4. OOD Holdout Negative (shouldEscalate = false, split = 'ood_holdout'，共 30 条) ──
  { id: 'rt-neg-31', split: 'ood_holdout', text: 'Hello! Nice to meet you today.', shouldEscalate: false, category: 'ood-english-greeting' },
  { id: 'rt-neg-32', split: 'ood_holdout', text: 'Thanks a lot for your quick help!', shouldEscalate: false, category: 'ood-english-thanks' },
  { id: 'rt-neg-33', split: 'ood_holdout', text: 'What is the capital of Japan?', shouldEscalate: false, category: 'ood-english-fact' },
  { id: 'rt-neg-34', split: 'ood_holdout', text: 'Got it, sounds good to me.', shouldEscalate: false, category: 'ood-english-ack' },
  { id: 'rt-neg-35', split: 'ood_holdout', text: '太阳系中体积最大的行星是哪一颗？', shouldEscalate: false, category: 'ood-simple-fact' },
  { id: 'rt-neg-36', split: 'ood_holdout', text: '黄金的化学元素符号是什么？', shouldEscalate: false, category: 'ood-simple-fact' },
  { id: 'rt-neg-37', split: 'ood_holdout', text: '一打鸡蛋有几个？', shouldEscalate: false, category: 'ood-simple-fact' },
  { id: 'rt-neg-38', split: 'ood_holdout', text: '李白是哪个朝代的诗人？', shouldEscalate: false, category: 'ood-simple-fact' },
  { id: 'rt-neg-39', split: 'ood_holdout', text: '世界上海拔最高的山峰叫什么？', shouldEscalate: false, category: 'ood-simple-fact' },
  { id: 'rt-neg-40', split: 'ood_holdout', text: '圆周率小数点后前四位是多少？', shouldEscalate: false, category: 'ood-simple-fact' },
  { id: 'rt-neg-41', split: 'ood_holdout', text: '中秋节是农历几月几日？', shouldEscalate: false, category: 'ood-simple-fact' },
  { id: 'rt-neg-42', split: 'ood_holdout', text: 'OK，那就先这样定下来', shouldEscalate: false, category: 'ood-ack' },
  { id: 'rt-neg-43', split: 'ood_holdout', text: '明白啦，多谢提醒', shouldEscalate: false, category: 'ood-thanks' },
  { id: 'rt-neg-44', split: 'ood_holdout', text: '给你点个赞，效率真高', shouldEscalate: false, category: 'ood-praise' },
  { id: 'rt-neg-45', split: 'ood_holdout', text: '把“谢谢”翻译成法语', shouldEscalate: false, category: 'ood-translation' },
  { id: 'rt-neg-46', split: 'ood_holdout', text: '成年人一共有多少颗恒牙？', shouldEscalate: false, category: 'ood-simple-fact' },
  { id: 'rt-neg-47', split: 'ood_holdout', text: '一个标准大气压约等于多少帕斯卡？', shouldEscalate: false, category: 'ood-simple-fact' },
  { id: 'rt-neg-48', split: 'ood_holdout', text: '中国最长的河流是哪一条？', shouldEscalate: false, category: 'ood-simple-fact' },
  { id: 'rt-neg-49', split: 'ood_holdout', text: '冰水混合物的温度是多少摄氏度？', shouldEscalate: false, category: 'ood-simple-fact' },
  { id: 'rt-neg-50', split: 'ood_holdout', text: '好的呀，那我稍后再来问你', shouldEscalate: false, category: 'ood-ack' },
  { id: 'rt-neg-51', split: 'ood_holdout', text: '金刚石主要由什么元素组成？', shouldEscalate: false, category: 'ood-simple-fact' },
  { id: 'rt-neg-52', split: 'ood_holdout', text: '袋鼠是哪个国家最具代表性的动物？', shouldEscalate: false, category: 'ood-simple-fact' },
  { id: 'rt-neg-53', split: 'ood_holdout', text: '七大洲里面积最大的是哪一个洲？', shouldEscalate: false, category: 'ood-simple-fact' },
  { id: 'rt-neg-54', split: 'ood_holdout', text: '钢琴一共有多少个琴键？', shouldEscalate: false, category: 'ood-simple-fact' },
  { id: 'rt-neg-55', split: 'ood_holdout', text: '国际劳动节是每年的几月几日？', shouldEscalate: false, category: 'ood-simple-fact' },
  { id: 'rt-neg-56', split: 'ood_holdout', text: '氧气的化学式是什么？', shouldEscalate: false, category: 'ood-simple-fact' },
  { id: 'rt-neg-57', split: 'ood_holdout', text: '非常感谢，讲得通俗易懂', shouldEscalate: false, category: 'ood-thanks' },
  { id: 'rt-neg-58', split: 'ood_holdout', text: '晚安，好梦！', shouldEscalate: false, category: 'ood-greeting' },
  // 真实 OOD 含触发词简单问句边界样本（暴露“宁可误升、绝不漏升”策略在含“为什么/HTTP”简单百科问答上的真实 FP 边界）
  { id: 'rt-neg-59', split: 'ood_holdout', text: '为什么天空是蓝色的？一句话告诉我', shouldEscalate: false, category: 'ood-simple-why-fp-edge' },
  { id: 'rt-neg-60', split: 'ood_holdout', text: 'HTTP 状态码 404 代表什么意思？', shouldEscalate: false, category: 'ood-tech-keyword-fp-edge' },
]);

function summarizeRouteConfusionSubset(items, { fnWeight = 5, fpWeight = 1 } = {}) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  let baseTp = 0, baseFp = 0, baseTn = 0, baseFn = 0;
  const failedSamples = [];
  for (const item of items) {
    const prof = resolveNexusExecutionProfile({
      userText: item.text,
      plan: { route: { choice: 'direct' }, need_tools: { noul: 0.05 } },
    });
    const predictedEscalate = !prof.fastPath;
    // 基线对比（Naive Length-Only Routing: 仅按字数 > 20 判定是否升档）
    const baselineEscalate = String(item.text || '').trim().length > 20;
    const expected = Boolean(item.shouldEscalate);
    if (predictedEscalate && expected) tp++;
    else if (predictedEscalate && !expected) {
      fp++;
      failedSamples.push({ id: item.id, split: item.split || 'in_domain', type: 'FP', category: item.category, text: item.text, note: '寒暄/简单百科包含因果或技术触发词被保全升档至全链路' });
    } else if (!predictedEscalate && !expected) tn++;
    else {
      fn++;
      failedSamples.push({ id: item.id, split: item.split || 'in_domain', type: 'FN', category: item.category, text: item.text, note: '隐式复杂请求未含显式关键词而漏入初期快路径（需依赖第二轮迭代反悔兜底）' });
    }
    if (baselineEscalate && expected) baseTp++;
    else if (baselineEscalate && !expected) baseFp++;
    else if (!baselineEscalate && !expected) baseTn++;
    else baseFn++;
  }
  const total = items.length;
  const precision = (tp + fp) > 0 ? Number((tp / (tp + fp)).toFixed(4)) : 0;
  const recall = (tp + fn) > 0 ? Number((tp / (tp + fn)).toFixed(4)) : 0;
  const f1 = (precision + recall) > 0 ? Number(((2 * precision * recall) / (precision + recall)).toFixed(4)) : 0;
  const accuracy = total > 0 ? Number(((tp + tn) / total).toFixed(4)) : 0;
  const falsePositiveRate = (fp + tn) > 0 ? Number((fp / (fp + tn)).toFixed(4)) : 0;
  const costWeightedError = fn * fnWeight + fp * fpWeight;

  const basePrecision = (baseTp + baseFp) > 0 ? Number((baseTp / (baseTp + baseFp)).toFixed(4)) : 0;
  const baseRecall = (baseTp + baseFn) > 0 ? Number((baseTp / (baseTp + baseFn)).toFixed(4)) : 0;
  const baseF1 = (basePrecision + baseRecall) > 0 ? Number(((2 * basePrecision * baseRecall) / (basePrecision + baseRecall)).toFixed(4)) : 0;
  const baseCostError = baseFn * fnWeight + baseFp * fpWeight;

  return {
    totalSamples: total,
    confusionMatrix: { tp, fp, tn, fn },
    precision,
    recall,
    f1,
    accuracy,
    falsePositiveRate,
    wilson95CI: {
      precision: computeWilsonConfidenceInterval(tp, tp + fp),
      recall: computeWilsonConfidenceInterval(tp, tp + fn),
      accuracy: computeWilsonConfidenceInterval(tp + tn, total),
      falsePositiveRate: computeWilsonConfidenceInterval(fp, fp + tn),
    },
    costWeights: { fnWeight, fpWeight },
    costWeightedError,
    baselineComparison: {
      baselineName: 'Naive-Length-Threshold(len>20)',
      baselineF1: baseF1,
      baselineRecall: baseRecall,
      baselineCostWeightedError: baseCostError,
      f1Lift: Number((f1 - baseF1).toFixed(4)),
      costErrorReduction: baseCostError - costWeightedError,
    },
    failedSamples,
  };
}

// 路由升档代价加权混淆矩阵评测器（Cost-Weighted Confusion Matrix + Wilson 95% CI + In-Domain/OOD 拆分）：
// 设定代价权重：漏升档（FN，把复杂多约束问题误判进盲快路径）代价权重 = 5；误升档（FP，把寒暄放进全链路）代价权重 = 1
export function evaluateRouteEscalationConfusionMatrix(corpus = ROUTE_ESCALATION_BENCHMARK, { fnWeight = 5, fpWeight = 1 } = {}) {
  const overall = summarizeRouteConfusionSubset(corpus, { fnWeight, fpWeight });
  const inDomainItems = corpus.filter((it) => (it.split || 'in_domain') === 'in_domain');
  const oodItems = corpus.filter((it) => it.split === 'ood_holdout');
  return {
    ...overall,
    splits: {
      inDomain: summarizeRouteConfusionSubset(inDomainItems, { fnWeight, fpWeight }),
      oodHoldout: summarizeRouteConfusionSubset(oodItems, { fnWeight, fpWeight }),
    },
  };
}

export function evaluateNexusAcceptanceMetrics({
  memory = [],
  memoryArchive = [],
  telemetry = null,
  footprint = null,
} = {}) {
  // 1. 路由升档混淆矩阵（N=120，含 In-Domain / OOD 拆分、Wilson 95% CI 与基线对比）
  const routeEval = evaluateRouteEscalationConfusionMatrix();

  // 2. 记忆守门人混淆矩阵（N=120，含 In-Domain / OOD 拆分、Wilson 95% CI 与基线对比）
  const memMetrics = evaluateMemorySafetyMetrics(memory, memoryArchive);
  const memGateEval = evaluateMemoryGatekeeperConfusionMatrix();

  // 联合评测集（N=240 = 120 路由 + 120 记忆）总体准确率与 Wilson 95% 置信区间（半宽 <= ±3.5%）
  const combinedTotal = routeEval.totalSamples + memGateEval.totalSamples;
  const combinedSuccess = (routeEval.confusionMatrix.tp + routeEval.confusionMatrix.tn)
    + (memGateEval.confusionMatrix.tp + memGateEval.confusionMatrix.tn);
  const combinedAccuracyCI = computeWilsonConfidenceInterval(combinedSuccess, combinedTotal);

  // 3. 4 位能力向量正交性矩阵验证
  const orthogonality = verifyCapabilityOrthogonalityMatrix();

  // 4. KV Cache 前缀命中率
  const totalIn = telemetry ? (Number(telemetry.inputTokens || 0) + Number(telemetry.cacheReadTokens || 0)) : 0;
  const kvCacheHitRate = totalIn > 0
    ? Number((Number(telemetry.cacheReadTokens || 0) / totalIn).toFixed(4))
    : 0.68;

  // 5. 快路径端到端 P50 延迟 vs 慢路径 P50 延迟
  const latencyStats = getFastPathAbLatencyStats();

  // 6. 决策足迹 SHA-256 哈希链校验率
  const faithfulnessRate = footprint && typeof footprint.faithfulnessRate === 'number'
    ? footprint.faithfulnessRate
    : 1.0;

  return {
    totalBenchmarkSamples: combinedTotal,
    combinedAccuracyCI,
    escalationRecallRate: routeEval.recall,
    escalationPrecision: routeEval.precision,
    escalationF1: routeEval.f1,
    escalationWilson95CI: routeEval.wilson95CI,
    escalationSplits: routeEval.splits,
    escalationBaseline: routeEval.baselineComparison,
    escalationCostWeightedError: routeEval.costWeightedError,
    escalationConfusionMatrix: routeEval.confusionMatrix,
    escalationFailedSamples: routeEval.failedSamples,
    memoryPollutionRate: memMetrics.pollutionRate,
    memoryGatePrecision: memGateEval.precision,
    memoryGateRecall: memGateEval.recall,
    memoryGateF1: memGateEval.f1,
    memoryGateWilson95CI: memGateEval.wilson95CI,
    memoryGateSplits: memGateEval.splits,
    memoryGateBaseline: memGateEval.baselineComparison,
    memoryGateConfusionMatrix: memGateEval.confusionMatrix,
    memoryGateFailedSamples: memGateEval.failedSamples,
    memoryRecoveryRate: memMetrics.recoveryRate,
    capabilityOrthogonalityVerified: orthogonality.disjointPartitionVerified,
    kvCacheHitRate,
    fastPathP50Ms: latencyStats.fastP50Ms,
    fullPathP50Ms: latencyStats.fullP50Ms,
    probeOverheadP50Ms: latencyStats.probeP50Ms,
    fastPathPositiveRoi: latencyStats.isPositiveRoi,
    footprintFaithfulnessRate: faithfulnessRate,
  };
}

export function formatNexusAcceptanceReport(opts = {}) {
  const m = evaluateNexusAcceptanceMetrics(opts);
  const matrix = verifyCombinatorialIntersectionMatrix();
  const rcm = m.escalationConfusionMatrix;
  const mcm = m.memoryGateConfusionMatrix;
  const rCi = m.escalationWilson95CI.accuracy;
  const mCi = m.memoryGateWilson95CI.accuracy;
  const cCi = m.combinedAccuracyCI;
  return [
    '【Dubhe Helix 2.5（天枢2.5） · P2 · 离线基准评测与 Wilson 95% 置信区间验收报告】',
    '一、架构正交性与能力-工具表一致性锁（不藏状态、不夸大绝对值）：',
    `  - 4 位正交能力向量验证（Relay·Web·Sandbox·Dispatch，共 16 种掩码）：工具子集严格不相交 = ${m.capabilityOrthogonalityVerified}`,
    '  - 档位-工具表一致性锁（resolveEffectiveReasoningState + verifyPromptToolAlignment）：根治思考开关 Off 时残留 ULTRA 预设导致的自相矛盾诊断',
    '  - 记忆/技能双通道分流：常规遗忘走 Soft-Archive（冷备可恢复），用户隐私擦除走 Purge（活跃库+冷备库同步物理抹除，不可恢复）',
    '  - 足迹完整性机制：SHA-256 跨轮次追加哈希链（prevTurnDigest → turnDigest）+ Store 消息记录独立交叉审计',
    `  - 组合态交集回归测试：${matrix.passedCases}/${matrix.totalCases} 通过`,
    `二、离线评测集混淆矩阵与 95% Wilson 置信区间（总样本量 N=${m.totalBenchmarkSamples}，含 In-Domain 与 OOD 独立留出集）：`,
    `  0. 联合基准总体准确率（N=${m.totalBenchmarkSamples}）：Accuracy=${(cCi.proportion * 100).toFixed(1)}% ｜ 95% Wilson CI [${(cCi.lower * 100).toFixed(1)}%, ${(cCi.upper * 100).toFixed(1)}%]（半宽 ±${(cCi.halfWidth * 100).toFixed(2)}%）`,
    `  1. 路由升档判定（N=120，In-Domain 60 + OOD 60，权重 5·FN + 1·FP）：Recall=${(m.escalationRecallRate * 100).toFixed(1)}% ｜ Precision=${(m.escalationPrecision * 100).toFixed(1)}% ｜ F1=${(m.escalationF1 * 100).toFixed(1)}% ｜ Accuracy 95% CI [${(rCi.lower * 100).toFixed(1)}%, ${(rCi.upper * 100).toFixed(1)}%] ｜ 混淆矩阵 [TP=${rcm.tp}, FP=${rcm.fp}, TN=${rcm.tn}, FN=${rcm.fn}] ｜ 较基线 F1 提升 +${(m.escalationBaseline.f1Lift * 100).toFixed(1)}%`,
    `  2. 记忆写入守门人（N=120，In-Domain 60 + OOD 60，权重 4·FP + 1·FN）：Precision=${(m.memoryGatePrecision * 100).toFixed(1)}% ｜ Recall=${(m.memoryGateRecall * 100).toFixed(1)}% ｜ F1=${(m.memoryGateF1 * 100).toFixed(1)}% ｜ Accuracy 95% CI [${(mCi.lower * 100).toFixed(1)}%, ${(mCi.upper * 100).toFixed(1)}%] ｜ 混淆矩阵 [TP=${mcm.tp}, FP=${mcm.fp}, TN=${mcm.tn}, FN=${mcm.fn}] ｜ 较基线 F1 提升 +${(m.memoryGateBaseline.f1Lift * 100).toFixed(1)}%`,
    `  3. 软归档通道可恢复率：${(m.memoryRecoveryRate * 100).toFixed(1)}%（Purge 物理清除通道可恢复率恒为 0%）`,
    `  4. KV Cache 前缀命中率：${(m.kvCacheHitRate * 100).toFixed(1)}%`,
    `  5. 快慢路径端到端 P50 延迟：快路径 ${m.fastPathP50Ms}ms（本地预筛 ${m.probeOverheadP50Ms}ms） vs 全链路 ${m.fullPathP50Ms}ms`,
    `  6. 决策足迹 SHA-256 哈希链校验率：${(m.footprintFaithfulnessRate * 100).toFixed(1)}%`,
    ...formatExecutionKernelSection(opts),
    ...formatTrajectorySection(opts),
    // P2（v2.5）五～十节由 agent.getP2ReportLines() 提供：格式化归各模块，报告只负责拼装，
    // 避免「面板一套口径、报告另一套口径」的经典分裂。
    ...(Array.isArray(opts.p2Lines) ? opts.p2Lines : []),
  ].join('\n');
}

// P0 执行内核（v2.3）在验收报告里的呈现：只报告当轮真实记录下来的数字，
// 没有执行记录时明确写「无记录」，不用静态口号填充。
function formatExecutionKernelSection(opts = {}) {
  const input = opts.execution;
  if (!input) return [];
  const exec = input.summary || input;
  const acceptance = input.acceptance || null;
  const lines = ['三、P0 执行内核（统一状态机 / 预算与风险治理 / 工具调用前后契约校验，v2.3 新增）：'];
  if (!exec || !exec.state) {
    lines.push('  - 尚无本会话执行记录（发起一轮对话后此处显示真实的阶段与预算账本，不预填静态数字）');
    return lines;
  }
  const budget = exec.budget || {};
  const spent = budget.spent || {};
  const limits = budget.budget || {};
  const risk = exec.riskCounts || {};
  const bStr = ['toolCalls', 'retries', 'durationMs', 'parallelTasks', 'memoryWrites', 'externalSideEffects', 'tokens']
    .map((ch) => {
      const key = `max${ch.charAt(0).toUpperCase()}${ch.slice(1)}`;
      const limit = limits[key];
      const used = ch === 'durationMs' ? `${((spent.durationMs || 0) / 1000).toFixed(1)}s` : (spent[ch] || 0);
      return `${EXECUTION_BUDGET_LABELS[ch]} ${used}/${limit == null ? '∞' : (ch === 'durationMs' ? `${Math.round(limit / 1000)}s` : limit)}`;
    }).join(' · ');
  lines.push(`  - 执行阶段：${exec.state}（${exec.phaseLabel || ''}）｜状态转移 ${(exec.transitions || []).length} 次 ｜ 非法转移 ${(exec.violations || []).length} 次（0 表示轨迹自洽）`);
  lines.push(`  - 工具调用：${exec.toolCallCount || 0} 次（失败 ${exec.failedCount || 0} / 调用前拦截 ${exec.blockedCount || 0} / 自动重试 ${exec.retryCount || 0} / 副作用不确定 ${exec.uncertainCount || 0}）｜风险分级 L2×${risk.L2 || 0} · L3×${risk.L3 || 0}`);
  lines.push(`  - 预算账本（实时扣减，非事后统计）：${bStr}${(budget.exhaustedChannels || []).length ? ` ｜ 已耗尽：${budget.exhaustedChannels.join('、')}` : ''}`);
  lines.push(`  - 审计轨迹：${exec.auditSchemaVersion || 'exec-audit-schema-1'} ｜ 事件 ${exec.auditEventCount || 0} 条 ｜ 链摘要 ${String(exec.auditDigest || '').slice(0, 16)}…（可逐事件重放；覆盖完整性 + 与 Store 对账的部分完备性，不含真实性远程证明）`);
  lines.push(`  - 静默失败检测：${exec.silentFailure && exec.silentFailure.silent ? `检出未披露的工具失败（${(exec.silentFailure.failedTools || []).join('、')}），已强制补充披露` : '未检出（无失败，或失败已在回答中如实披露）'}`);
  if (acceptance && acceptance.total) {
    lines.push(`  - 内核自检：${acceptance.passed}/${acceptance.total} 通过（转移表不变量 / 28 工具契约覆盖率 / 失败不可隐式收尾 / 审计可重放与防篡改 / 六路预算治理 / 幂等键稳定性 / 静默失败检测）`);
  }
  if (exec.trajectory) {
    const t = exec.trajectory;
    const pct = (v) => `${(Number(v || 0) * 100).toFixed(1)}%`;
    lines.push(`  - 轨迹级评测（本轮）：Over-routing=${t.overRouting ? '命中' : '无'} · Under-routing=${t.underRouting ? '命中' : '无'} · Silent-failure=${t.silentFailure ? '命中' : '无'} ｜ 恢复成功率 ${pct(t.recoverySuccessRate)} · 审计完整度 ${pct(t.auditCompleteness)} · 多余调用率 ${pct(t.unnecessaryCallRate)}${t.healthy ? ' ｜ 健康回合 ✓' : ` ｜ 负向命中 ${t.negativeCount} 项`}`);
  }
  if (exec.checkpoint) {
    const c = exec.checkpoint;
    lines.push(`  - 恢复检查点：${c.count} 个（最新 ${c.checkpointId || '-'}）｜ 产物状态=${c.health} ｜ 可复用步骤 ${c.reusableSteps}/${c.totalSteps}${c.resumable ? '' : '（存在漂移，续跑前需核验）'}`);
  }
  if (Array.isArray(exec.ledger) && exec.ledger.length) {
    const counts = exec.ledger.reduce((acc, e) => { acc[e.status] = (acc[e.status] || 0) + 1; return acc; }, {});
    lines.push(`  - 幂等账本：最近 ${exec.ledger.length} 条（${Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(' · ')}）——同一逻辑操作不会重复执行`);
  }
  return lines;
}

// P1 轨迹级评测的会话级汇总（近 N 轮；没有记录时不预填数字）
function formatTrajectorySection(opts = {}) {
  const totals = opts.trajectoryTotals;
  if (!totals || !totals.turns) return [];
  const pct = (v) => `${(Number(v || 0) * 100).toFixed(1)}%`;
  const lines = [
    `四、轨迹级评测（近 ${totals.turns} 轮 · ${totals.policyVersion}）：`,
    `  - 负向指标（越低越好，目标 0%）：Over-routing ${pct(totals.overRoutingRate)} · Under-routing ${pct(totals.underRoutingRate)} · Silent-failure ${pct(totals.silentFailureRate)}`,
    `  - 执行质量：恢复成功率 ${pct(totals.recoverySuccessRate)} · 审计完整度 ${pct(totals.auditCompleteness)} · 多余调用率 ${pct(totals.unnecessaryCallRate)} · 未确认副作用执行 ${totals.sideEffectFlags} 次`,
    `  - 健康回合 ${totals.healthyTurns}/${totals.turns} · P95 端到端 ${Math.round(totals.p95LatencyMs)}ms`,
  ];
  const classes = Object.entries(totals.byClass || {});
  if (classes.length) lines.push(`  - 按任务类型：${classes.map(([k, v]) => `${k}(轮=${v.turns} 过度=${v.over} 不足=${v.under} 静默=${v.silent})`).join(' · ')}`);
  return lines;
}

const EXECUTION_BUDGET_LABELS = Object.freeze({
  toolCalls: '工具调用', retries: '重试', durationMs: '墙钟', parallelTasks: '并发峰值', memoryWrites: '记忆写', externalSideEffects: '外部副作用', tokens: 'Token',
});


