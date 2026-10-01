// ─── Teamo-Hermes Nexus（「天枢·赫尔墨斯」自研双系统自演进融合 Agent 架构）──
// 深度融合 Nous Research Hermes Agent 架构精髓与 TeamoAgent 端云协同双系统优势：
//   1. System-1 / System-2 双系统认知路由（Jev 预判向量 × 自适应温度 × 零额外轮次技能直注）
//   2. 四层缓存不变量提示词编译器（stable → context → volatile 锁死前缀缓存 + ephemeral 动态注入）
//   3. 沙箱工作区规范自发现（自动扫描 TEAMO.md / AGENTS.md / HERMES.md / CLAUDE.md / .cursorrules）
//   4. 三层时序与程序性记忆内核（会话工作记忆 + 压缩前记忆刷盘 Flush + 跨会话 BM25 检索 Recall）
//   5. 闭环自演进技能引擎（轨迹蒸馏 → 耗时/成功率遥测 → 坑点记录 → agentskills.io SKILL.md 双向编解码）
//   6. 执行自省与防死循环护栏（Turn Recovery：重复调用检测、连续报错归因、长链路任务账本）

import { upsertFacts, factsFromDigest } from './memory.js';

export const NEXUS_ARCHITECTURE_SPEC = Object.freeze({
  id: 'teamo-hermes-nexus-v1',
  code: 'THN',
  shortName: '天枢 THN',
  name: '天枢 THN · Teamo-Hermes Nexus Architecture (天枢·赫尔墨斯融合架构)',
  version: '1.6.0',
  layers: [
    { id: 'L1-cognition', name: 'System-1/System-2 双系统可逆认知路由层（Reversible Fast-Path & Mid-Turn Escalation）', modules: ['jev.js', 'temperature.js', 'reasoning.js', 'nexus.js#resolveNexusExecutionProfile', 'nexus.js#escalateNexusProfile'] },
    { id: 'L2-prompt', name: '四层缓存不变量提示词与可解释降级诊断层（Cache-Invariant Compiler & Explainable Degradation）', modules: ['prompt.js', 'nexus.js#discoverWorkspaceContext', 'nexus.js#buildDegradationDiagnostics'] },
    { id: 'L3-memory', name: '带质量闸门、置信度与 TTL 衰减 GC 的三层持久记忆与中英概念簇混合 BM25 召回层', modules: ['memory.js#isValidMemoryFact', 'memory.js#pruneMemoryFacts', 'nexus.js#searchCrossSessionMemory'] },
    { id: 'L4-skills', name: '带写入守门人、活力衰减淘汰（Forgetting GC）与 SKILL.md 标准的自演进技能引擎', modules: ['skills.js#isValidSkillCandidate', 'skills.js#pruneLearnedSkills', 'nexus.js#refineSkillWithTelemetry'] },
    { id: 'L5-orchestration', name: 'DAG/Wave 并发、0ms 本地工具优先与全档位统一冲突仲裁层（子智能体矩阵 + 多工具核验 + 内源双视角自检）', modules: ['agent.js#batchToolCalls', 'subagents.js', 'nexus.js#arbitrateSubagentReports', 'nexus.js#arbitrateUnifiedEvidence'] },
    { id: 'L6-reflection', name: '执行自省护栏、Task Ledger 四阶段账本與面向用户的决策足迹层（Decision Footprint & Observability）', modules: ['nexus.js#analyzeToolTrajectory', 'nexus.js#createTaskLedger', 'nexus.js#buildDecisionFootprint'] },
  ],
  enhancements: [
    '记忆与技能统一质量闸门 + TTL/命中衰减自动遗忘 GC（Memory & Skill Gatekeeper + Decay GC）：拦截“这个呢”等指代噪声固化，自动淘汰过期低活力条目，支持按 [mem-xxxx] ID 精准删除',
    'L1 路由可逆化与中途反悔升档（Reversible Fast-Path Escalation）：探测到多约束、隐式指代或触发工具调用时，实时从 Fast-Path 反悔升级至全链路慢思考',
    '面向用户与输出的轻量决策足迹（User-Facing Decision Footprint）：每轮显式标注路由路径、命中的记忆 ID、激活的技能、GC 清理项与工具引擎，告别黑箱',
    '全档位统一的 L5 冲突仲裁（Cross-Tier Unified Arbitration）：Max/Ultra 跑子智能体置信度矩阵，普通档位自动降级为「多工具结果交叉核验 + 内源正反双视角自检」',
    '可解释的优雅降级诊断（Explainable Degradation）：工具裁剪（如静态页面无本地 server.py 中继隐藏 fetch_url）时，向用户与 Agent 同步输出缺失原因与一键恢复指令',
  ],
});

// ─── 1. 工作区上下文文件自发现（对齐 Hermes AGENTS.md / HERMES.md / CLAUDE.md）──
export const CONTEXT_FILE_CANDIDATES = [
  'TEAMO.md',
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

// ─── 7. L1 可逆认知路由与中途自动升档（Reversible Fast-Path & Mid-Turn Escalation）──
// 针对简单直答回合启用 Fast-Path；但一旦检测到多约束、隐式上下文指代、外部事实依赖或中途触发工具调用，
// 立即允许“中途反悔”升级为全链路慢思考（Reversible Escalation），杜绝静默降级交付次品。
const MULTI_CONSTRAINT_OR_IMPLICIT_RE = /(?:首先|然后|接着|同时|并且|不仅|除了|对比|区别|优缺点|深入|底层|架构|原理|为什么|如何|怎么(?!样)|一步步|推导|证明|核实|验证|评估|评价|自评|这个呢|那个呢|那如果|如果把|刚才)/i;

export function resolveNexusExecutionProfile({ userText = '', plan = null, hasAttachments = false, iteration = 1, toolCallsCount = 0 } = {}) {
  const s = String(userText || '').trim();
  const route = plan && plan.route && plan.route.choice ? plan.route.choice : '';
  const needTools = plan && plan.need_tools && typeof plan.need_tools.noul === 'number' ? plan.need_tools.noul : null;
  const needCode = plan && plan.need_code && typeof plan.need_code.noul === 'number' ? plan.need_code.noul : null;
  const recallAsked = shouldTriggerSessionRecall(s);
  const complexSignal = /(?:代码|脚本|运行|计算|文件|搜索|联网|抓取|架构|对比|重构|画图|图表|子智能体|python|javascript|sql|regex|hash|http)/i.test(s);
  const multiConstraint = MULTI_CONSTRAINT_OR_IMPLICIT_RE.test(s);

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
      fastPath: true,
      escalated: false,
      reversible: true,
      activeLayers: ['L1-cognition', 'L2-prompt', 'L3-persistent-memory'],
      bypassedLayers: ['L3-session-recall', 'L5-swarm-arbitration', 'L6-task-ledger'],
      reason: '单步轻量直答请求，启用 L1 可逆轻快路径（若中途触发工具或深层依赖将自动升档）',
    };
  }
  return {
    mode: 'full-nexus',
    fastPath: false,
    escalated: false,
    reversible: true,
    activeLayers: ['L1-cognition', 'L2-prompt', 'L3-memory', 'L4-skills', 'L5-orchestration', 'L6-reflection'],
    bypassedLayers: [],
    reason: '多约束或专业任务，天枢 L1→L6 全链路协同激活',
  };
}

// L1 中途反悔升档器：若初始走 Fast-Path，但产生了工具调用、迭代推进或发现隐式复杂约束，立即升档解锁全层
export function escalateNexusProfile(prevProfile, { iteration = 1, toolCallsCount = 0, finishReason = '', userText = '' } = {}) {
  if (!prevProfile || !prevProfile.fastPath) return prevProfile;
  const s = String(userText || '');
  const needsEscalation = iteration > 1
    || toolCallsCount > 0
    || /^(?:length|max_tokens|max_output_tokens)$/i.test(String(finishReason || ''))
    || MULTI_CONSTRAINT_OR_IMPLICIT_RE.test(s);
  if (!needsEscalation) return prevProfile;
  return {
    mode: 'escalated-full-nexus',
    fastPath: false,
    escalated: true,
    reversible: true,
    activeLayers: ['L1-cognition', 'L2-prompt', 'L3-memory', 'L4-skills', 'L5-orchestration', 'L6-reflection'],
    bypassedLayers: [],
    reason: `检测到多步工具依赖或深层约束（迭代 #${iteration}），已由 L1 Fast-Path 自动反悔升档至 L1→L6 全链路模式`,
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
  return `【天枢 THN · L5 工具引擎优选路由（${rec.tier}）】建议优先调用：${rec.recommendedTools.join(' / ')}（${rec.rationale}；环境溯源：算力=${rec.provenance.compute}，网络=${rec.provenance.network}）。`;
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
    '【天枢 THN · L5 子智能体冲突仲裁与置信度矩阵】',
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
  if (!telemetry) return '（暂无天枢 THN 遥测数据）';
  const totalIn = telemetry.inputTokens + telemetry.cacheReadTokens;
  const cacheHitRate = totalIn > 0 ? `${Math.round((telemetry.cacheReadTokens / totalIn) * 100)}%` : '0%';
  const spans = Object.entries(telemetry.layerSpans || {})
    .map(([k, v]) => `${k}:${v.durationMs}ms`)
    .join(' · ') || 'L1-L6:0ms';
  const tools = (telemetry.toolTrajectory || [])
    .map((t) => `${t.name}(${t.engine},${t.durationMs}ms${t.ok ? '' : ',ERR'})`)
    .join(' → ') || '无工具调用';
  return [
    `【天枢 THN · L6+ 全链路可观测性遥测（v${telemetry.version || '1.6.0'}）】`,
    `- 执行模式：${telemetry.escalated ? 'L1↗L6 中途反悔升档' : (telemetry.fastPath ? 'L1 Fast-Path 轻快直达' : 'L1-L6 全链路协同')} ｜ 总耗时：${telemetry.totalDurationMs || 0}ms`,
    `- 分层耗时：${spans}`,
    `- L2 缓存命中率：${cacheHitRate}（缓存读取 ${telemetry.cacheReadTokens} tok / 新增缓存 ${telemetry.cacheCreationTokens} tok / 输入 ${telemetry.inputTokens} tok）`,
    `- L3/L4 记忆与技能激活：长期记忆 ${telemetry.activeMemoryCount} 条 · 跨会话召回 ${telemetry.recalledSessions} 条 · 技能直注 ${telemetry.recalledSkills} 项`,
    `- L5 工具与蜂群轨迹：${tools}${telemetry.subagentDispatches ? `（子智能体委派 ${telemetry.subagentDispatches} 次，冲突仲裁 ${telemetry.subagentConflicts} 项）` : ''}`,
  ].join('\n');
}

// ─── 11. L5 全档位统一冲突仲裁（子智能体矩阵 + 多工具交叉核验 + 内源双视角自检）──
// 解决“dispatch_subagent 仅在 Max/Ultra 出现导致普通档位无冲突仲裁”的架构边界割裂问题
export function arbitrateUnifiedEvidence({
  canDispatch = false,
  reasoningLevel = 'medium',
  userText = '',
  stepHistory = [],
  subagentReports = [],
} = {}) {
  // 1) 若已有 >= 2 份子智能体报告，优先执行多专家置信度矩阵仲裁
  if (Array.isArray(subagentReports) && subagentReports.length >= 2) {
    const subArb = arbitrateSubagentReports(subagentReports);
    return {
      mode: 'subagent-matrix',
      modeLabel: '子智能体置信度矩阵仲裁',
      hasConflict: subArb.hasConflict,
      note: formatSubagentArbitrationNote(subArb),
    };
  }

  // 2) 若当前回合已执行 >= 2 次工具调用（全档位通用），执行多工具结果交叉核验仲裁
  const steps = Array.isArray(stepHistory) ? stepHistory : [];
  if (steps.length >= 2) {
    const okTools = steps.filter((s) => s && !s.isError).map((s) => s.name);
    const errTools = steps.filter((s) => s && s.isError).map((s) => s.name);
    const hasConflict = errTools.length > 0 && okTools.length > 0;
    const note = [
      `【天枢 THN · L5 多工具证据交叉仲裁（当前档位：${reasoningLevel}）】`,
      `- 已完成工具证据链：成功 [${okTools.join(', ') || '无'}]${errTools.length ? ` ｜ 异常 [${errTools.join(', ')}]` : ''}`,
      hasConflict
        ? '- 分歧仲裁：部分工具曾返回报错或空结果，最终结论必须以最新成功执行的沙箱/本地工具实测输出为准，严禁混用失败步骤的中间猜测。'
        : '- 交叉核验：多步工具执行均通过，请校核各工具返回数值/路径的一致性后再收敛结论。',
    ].join('\n');
    return {
      mode: 'multi-tool-cross-check',
      modeLabel: '多工具结果交叉核验',
      hasConflict,
      note,
    };
  }

  // 3) 非 Max/Ultra 档位且遇到对比/评估/架构/多约束问题时，激活“内源正反双视角自检仲裁”
  const s = String(userText || '');
  if (!canDispatch && MULTI_CONSTRAINT_OR_IMPLICIT_RE.test(s) && s.length >= 10) {
    return {
      mode: 'internal-dual-perspective',
      modeLabel: '内源正反双视角自检',
      hasConflict: false,
      note: `【天枢 THN · L5 内源双视角交叉仲裁（当前思考档位 ${reasoningLevel} 未开启外部子智能体 RPC，已自动切换为内源双视角自检）】请在内部同时从「方案正向成立依据」与「边界反例/潜在隐患」两个对立视角交叉审视后再输出最终结论。`,
    };
  }

  return { mode: 'none', modeLabel: '按需待命', hasConflict: false, note: '' };
}

// ─── 12. 可解释的优雅降级诊断（Explainable Degradation Diagnostics）──────────
// 解决“工具表裁剪合理但缺失原因不解释”的问题：明确说明何处降级、原因及恢复命令
export function buildDegradationDiagnostics({
  relayOk = false,
  webEnabled = false,
  sandboxEnabled = true,
  canDispatch = false,
  reasoningLevel = 'medium',
} = {}) {
  const items = [];
  if (!relayOk) {
    items.push({
      id: 'relay-offline',
      capability: 'fetch_url 网页抓取 / 远端真实 Git (clone/push)',
      status: 'degraded',
      reason: '当前运行在纯静态页面环境（如 GitHub Pages），未检测到本地 127.0.0.1:8787 的 server.py 中继服务',
      recovery: '在项目根目录终端执行 `python3 server.py` 启动本地中继后刷新页面，即可解锁顶栏「联网」与真实远端 Git',
    });
  } else if (!webEnabled) {
    items.push({
      id: 'web-switched-off',
      capability: 'fetch_url 网页抓取',
      status: 'paused',
      reason: '本地中继在线，但当前会话已手动关闭顶栏「联网」开关',
      recovery: '点击顶栏「联网」胶囊开关即可立即恢复网页抓取能力',
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
  if (!canDispatch) {
    items.push({
      id: 'subagent-tier-gated',
      capability: 'dispatch_subagent 外部专家子智能体并发委派',
      status: 'fallback',
      reason: `当前思考档位为 ${String(reasoningLevel || 'medium').toUpperCase()}（外部子智能体 RPC 仅在 Max / Ultra 档位开放以节省延迟与额度）`,
      recovery: '已自动降级为「L5 内源正反双视角自检 + 多工具交叉核验」；如需 18 路独立子智能体并发，可将思考档位切换至 Max 或 Ultra',
    });
  }
  return items;
}

export function formatDegradationDiagnostics(items = []) {
  if (!Array.isArray(items) || !items.length) return '';
  const lines = ['【天枢 THN · L2 能力边界与降级可解释性诊断】若用户询问某项能力为何不可用或如何开启，请如实说明下列原因与恢复方法：'];
  for (const it of items) {
    lines.push(`- ${it.capability}：原因=${it.reason} ｜ 恢复方式=${it.recovery}`);
  }
  return lines.join('\n');
}

// ─── 13. 面向用户与输出的轻量决策足迹（User-Facing Decision Footprint）───────
// 把可观测性从后台仪表盘搬到用户与输出眼前：清晰记录本轮走了哪条路径、召回了哪些记忆、命中了哪些技能
export function buildDecisionFootprint({
  profile = null,
  memories = [],
  recalledSessions = [],
  matchedSkillIds = [],
  prunedSkillIds = [],
  usedTools = [],
  arbitration = null,
  degradations = [],
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
  const tools = [...new Set((Array.isArray(usedTools) ? usedTools : []).filter(Boolean))];
  const degShort = (Array.isArray(degradations) ? degradations : []).map((d) => d.id);

  return {
    mode,
    fastPath,
    escalated,
    modeLabel,
    memoryCount: Array.isArray(memories) ? memories.length : 0,
    memoryTags: memTags,
    recalledSessions: sessTitles,
    matchedSkills: skills,
    prunedSkills: pruned,
    usedTools: tools,
    arbitrationMode: (arbitration && arbitration.modeLabel) || '按需待命',
    degradations: degShort,
  };
}

export function formatDecisionFootprintForPrompt(fp) {
  if (!fp) return '';
  const parts = [
    `路径=${fp.modeLabel}`,
    `生效记忆=${fp.memoryCount}条${fp.memoryTags && fp.memoryTags.length ? `(${fp.memoryTags.join(', ')})` : ''}`,
    `跨会话召回=${fp.recalledSessions && fp.recalledSessions.length ? fp.recalledSessions.join('、') : '无'}`,
    `命中技能=${fp.matchedSkills && fp.matchedSkills.length ? fp.matchedSkills.join(', ') : '无'}`,
    ...(fp.prunedSkills && fp.prunedSkills.length ? [`GC淘汰噪声技能=${fp.prunedSkills.join(', ')}`] : []),
    `L5仲裁=${fp.arbitrationMode || '按需待命'}`,
  ];
  return `【天枢 THN · 本轮决策足迹（透明可归因）】${parts.join(' ｜ ')}`;
}

export function formatDecisionFootprintSummary(fp) {
  if (!fp) return '';
  const bits = [`天枢 ${fp.modeLabel}`];
  if (fp.memoryCount > 0) bits.push(`记忆×${fp.memoryCount}`);
  if (fp.recalledSessions && fp.recalledSessions.length) bits.push(`召回×${fp.recalledSessions.length}`);
  if (fp.matchedSkills && fp.matchedSkills.length) bits.push(`技能:${fp.matchedSkills.join('/')}`);
  if (fp.usedTools && fp.usedTools.length) bits.push(`工具×${fp.usedTools.length}`);
  if (fp.prunedSkills && fp.prunedSkills.length) bits.push(`GC清理×${fp.prunedSkills.length}`);
  return bits.join(' · ');
}

