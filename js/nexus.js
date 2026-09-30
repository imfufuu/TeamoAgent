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
  version: '1.4.0',
  layers: [
    { id: 'L1-cognition', name: 'System-1/System-2 双系统认知路由层', modules: ['jev.js', 'temperature.js', 'reasoning.js'] },
    { id: 'L2-prompt', name: '四层缓存不变量提示词与上下文发现层', modules: ['prompt.js', 'nexus.js#discoverWorkspaceContext'] },
    { id: 'L3-memory', name: '三层持久记忆与跨会话 BM25 召回层', modules: ['memory.js', 'context.js', 'nexus.js#searchCrossSessionMemory'] },
    { id: 'L4-skills', name: '闭环自演进技能与 SKILL.md 开放标准层', modules: ['skills.js', 'nexus.js#refineSkillWithTelemetry'] },
    { id: 'L5-orchestration', name: 'DAG/Wave 并发工具与专家子智能体蜂群层', modules: ['agent.js#batchToolCalls', 'subagents.js', 'tools.js'] },
    { id: 'L6-reflection', name: '执行自省、死循环阻断与任务账本护栏层', modules: ['nexus.js#analyzeToolTrajectory', 'nexus.js#createTaskLedger'] },
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

// ─── 2. 跨会话 BM25 全文检索（对齐 Hermes session_search + FTS5 召回）──────────
const CJK_CHAR_RE = /[\u4e00-\u9fff]/;

export function tokenizeForSearch(text) {
  const s = String(text || '').toLowerCase();
  if (!s) return [];
  const tokens = [];
  // 拉丁/数字词元
  const words = s.match(/[a-z0-9_.-]{2,}/g) || [];
  tokens.push(...words);
  // CJK 双字切分（Bigram）兼顾单字关键检索
  const cjkRuns = s.match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const run of cjkRuns) {
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
    if (run.length <= 4) tokens.push(run);
  }
  return tokens;
}

export function shouldTriggerSessionRecall(userText) {
  const s = String(userText || '');
  return /上次|之前|前面那个|刚才那|历史会话|以前的对话|上个会话|记得吗|我们之前|previous\s+session|last\s+time|earlier\s+chat/i.test(s);
}

export function searchCrossSessionMemory(sessions, query, { excludeSessionId = '', limit = 3 } = {}) {
  const qTokens = [...new Set(tokenizeForSearch(query))];
  if (!qTokens.length || !Array.isArray(sessions) || !sessions.length) return [];

  const docs = [];
  for (const sess of sessions) {
    if (!sess || sess.id === excludeSessionId) continue;
    const msgs = Array.isArray(sess.messages) ? sess.messages : [];
    if (!msgs.length) continue;
    const userTexts = msgs.filter((m) => m && m.role === 'user' && m.text).map((m) => String(m.text).slice(0, 240));
    const asstTexts = msgs.filter((m) => m && m.role === 'assistant' && m.text && !m.transientModeration).map((m) => String(m.text).slice(0, 320));
    if (!userTexts.length && !asstTexts.length) continue;
    const fullText = `${sess.title || ''}\n${userTexts.join('\n')}\n${asstTexts.slice(-2).join('\n')}`;
    const tokens = tokenizeForSearch(fullText);
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

  // BM25 参数
  const N = docs.length;
  const avgDl = docs.reduce((s, d) => s + d.tokensLen, 0) / N || 1;
  const k1 = 1.5;
  const b = 0.75;

  const df = new Map();
  for (const q of qTokens) {
    let count = 0;
    for (const d of docs) if (d.freq.has(q)) count++;
    df.set(q, count);
  }

  const scored = [];
  for (const d of docs) {
    let score = 0;
    for (const q of qTokens) {
      const tf = d.freq.get(q) || 0;
      if (!tf) continue;
      const n_q = df.get(q) || 0;
      const idf = Math.log(1 + (N - n_q + 0.5) / (n_q + 0.5));
      const num = tf * (k1 + 1);
      const den = tf + k1 * (1 - b + b * (d.tokensLen / avgDl));
      score += idf * (num / den);
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
  const candidates = factsFromDigest(droppedDigest).filter((f) => DURABLE_FACT_RE.test(f));
  if (!candidates.length) return Array.isArray(existingMemory) ? existingMemory : [];
  return upsertFacts(existingMemory, candidates);
}

// ─── 4. 闭环自演进技能遥测与 SKILL.md 双向编解码（对齐 agentskills.io）────────
export function refineSkillWithTelemetry(skill, { toolSequence = [], hadErrors = false, recovered = false, durationMs = 0 } = {}) {
  if (!skill || !skill.id) return skill;
  const seq = toolSequence.filter(Boolean);
  const pipeline = seq.length ? seq.slice(0, 8).join(' → ') : '';
  const prevUses = Number(skill.uses) || 0;
  const prevSuccess = Number(skill.successCount) || 0;
  const uses = prevUses + 1;
  const successCount = prevSuccess + (hadErrors && !recovered ? 0 : 1);
  const bodyLines = String(skill.body || '').split('\n').filter((l) => !l.startsWith('- 推荐执行链：') && !l.startsWith('- 避坑记录：'));
  if (pipeline) bodyLines.push(`- 推荐执行链：${pipeline}`);
  if (hadErrors && recovered) {
    bodyLines.push('- 避坑记录：曾出现工具参数或环境报错后自愈，复用时请先校验前置路径与环境。');
  }
  return {
    ...skill,
    uses,
    successCount,
    successRate: Number((successCount / uses).toFixed(2)),
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
