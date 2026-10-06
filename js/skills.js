// ─── Skills：Hermes 式渐进披露（目录进稳定层，正文只在匹配时注入 ephemeral）──
// 不移植 skill_view 工具：浏览器 Agent 多一轮加载成本高，Jev/关键词命中后直接注入正文。
// 复杂回合结束后用工具轨迹蒸馏一条会话技能（无额外 LLM 调用，fail-open）。

import { tokenizeForSearch } from './nexus.js';

export const BUNDLED_SKILLS = [
  {
    id: 'web-research',
    tag: 'research',
    description: '实时事实经本地中继 fetch_url 核实，查不到就明说',
    match: (plan, text) => {
      if (plan && (plan.route === 'search' || (plan.needSearch != null && plan.needSearch >= 0.55))) return true;
      return /最新|今天|当前|汇率|股价|版本号|news|today|price/i.test(String(text || ''));
    },
    body: [
      '## Skill: web-research',
      '- 时效性问题：工具表有 search_web 时先检索并记录来源；随后用 fetch_url 核实具体页面，文档站可用 crawl_site 限量抓取。没有对应工具或开关关闭就直说无法核实。',
      '- 不要写「已联网搜索」。查不到就明说没查到，不要用记忆数字冒充刚搜到的。',
    ].join('\n'),
  },
  {
    id: 'sandbox-compute',
    tag: 'compute',
    description: '计算/验证写进沙箱执行，不要口算',
    match: (plan, text) => {
      if (plan && (plan.route === 'tools' || (plan.needCode != null && plan.needCode >= 0.55))) return true;
      return /计算|运行|代码|python|javascript|统计|验证/i.test(String(text || ''));
    },
    body: [
      '## Skill: sandbox-compute',
      '- 计算、数据处理、算法验证：用 execute_javascript / execute_python / execute_cpp，以工具结果为准。',
      '- 需要落盘的中间结果 write_file；读已有文件再算。对拍用 diff_text，搜引用用 search_files。沙箱关闭时不要假装执行过。',
      '- 互不依赖的只读步骤（read_file / list_files）可同一轮并行发出。',
    ].join('\n'),
  },
  {
    id: 'structured-diagrams',
    tag: 'diagram',
    description: '图表/流程/思维导图走 SVG、Mermaid、DOT 或 Markdown 快捷语法，不走生图',
    match: (plan, text) => /图表|统计图|折线图|柱状图|饼图|散点图|s[-－—–]?t|位移[-－—–]?时间|路程[-－—–]?时间|流程图|思维导图|脑图|架构图|Mermaid|Graphviz|DOT|SVG|chart|flowchart|mind\s*map|diagram/i.test(String(text || '')),
    body: [
      '## Skill: structured-diagrams',
      '- 统计图（柱状 / 条形 / 折线 / 面积 / 饼 / 环形 / 堆叠 / 直方 / 箱线 / 散点 / 气泡 / 漏斗 / 桑基 / 地图）：直接用 Markdown 快捷语法 ```:::chart line 标题``` / ```:::chart sankey 标题``` / ```:::chart map 标题``` 等，位移-时间等物理关系图用 line 或 scatter；或写 SVG 文件后用 sandbox:// 嵌入。',
      '- 流程图：优先用 :::flow 简短语法；复杂流程/时序图调用 render_mermaid 生成 SVG。',
      '- 思维导图：用 :::mind；架构图/依赖图调用 render_dot 或写 SVG。禁止为这些任务调用 generate_image。',
    ].join('\n'),
  },
  {
    id: 'image-generation',
    tag: 'image',
    description: '照片/插画/海报等栅格出图才调用 generate_image',
    match: (plan, text) => {
      const s = String(text || '');
      if (/图表|统计图|折线图|柱状图|饼图|散点图|s[-－—–]?t|流程图|思维导图|脑图|架构图|Mermaid|Graphviz|DOT|SVG|chart|flowchart|mind\s*map|diagram/i.test(s)) return false;
      if (plan && (plan.route === 'image' || (plan.needImage != null && plan.needImage >= 0.55))) return true;
      return /画一|生成.*图|改图|插画|出张图|海报|封面|照片|头像|generate.?image/i.test(s);
    },
    body: [
      '## Skill: image-generation',
      '- 用户要照片/插画/海报/头像等栅格画面：调用 generate_image。model 只能是会话 runtime 指定的生图模型 ID。',
      '- 改图用 reference_paths 指向沙箱内图片。统计图、流程图、思维导图、架构图不属于本技能，禁止调用 generate_image。',
    ].join('\n'),
  },
  {
    id: 'git-workspace',
    tag: 'git',
    description: '仓库操作走 run_git（内置沙箱 Git / 本地中继真 Git）',
    match: (plan, text) => /git|仓库|commit|clone|pull request|\bpr\b|分支|rebase/i.test(String(text || '')),
    body: [
      '## Skill: git-workspace',
      '- 写操作前先 run_git status / diff。commit 信息用完整句子，不要经 shell 拼接。',
      '- 没有本地中继时 run_git 仍可做沙箱内 init/status/diff/add/commit/log；clone/push 等远端网络操作要说明需要中继。',
    ].join('\n'),
  },
  {
    id: 'subagent-dispatch',
    tag: 'delegate',
    description: '专业视角任务主动 dispatch_subagent，task 自包含',
    match: (plan) => !!(plan && plan.needDispatch != null && plan.needDispatch >= 0.55),
    body: [
      '## Skill: subagent-dispatch',
      '- 仅当思考级别为 Max 或 Ultra 时才有 dispatch_subagent。适合专业视角时主动委派，不必等用户点名。',
      '- task 必须自包含：子智能体看不到主对话。互不依赖的委派同一轮并行发出。',
      '- 不要把冗长报告原样转贴；综合后再答。报告异常时自己补做。',
    ].join('\n'),
  },
];

const SKILL_DEFAULT_TTL_MS = 14 * 24 * 3600 * 1000; // 14 天未命中转入冷备软归档（绝不因时间硬删有效技能）
const MAX_SKILL_ARCHIVE = 32;
const skillArchiveMap = new Map();

export function getSoftArchivedSkills(externalArchive = []) {
  if (Array.isArray(externalArchive)) {
    for (const s of externalArchive) {
      if (s && s.id) skillArchiveMap.set(s.id, s);
    }
  }
  return [...skillArchiveMap.values()].sort((a, b) => (b.archivedAt || b.ts || 0) - (a.archivedAt || a.ts || 0));
}

export function restoreArchivedSkill(activeList = [], idOrQuery = 'last', now = Date.now()) {
  const pool = getSoftArchivedSkills();
  if (!pool.length) return { next: pruneLearnedSkills(activeList, { now }), restored: [] };
  const q = String(idOrQuery || 'last').trim().toLowerCase();
  const matched = (!q || q === 'last')
    ? [pool[0]]
    : pool.filter((s) => s.id.toLowerCase() === q || String(s.description || '').toLowerCase().includes(q));
  if (!matched.length) return { next: pruneLearnedSkills(activeList, { now }), restored: [] };
  let next = pruneLearnedSkills(activeList, { now });
  const restored = [];
  for (const s of matched) {
    skillArchiveMap.delete(s.id);
    const revived = {
      ...s,
      archived: false,
      archivedAt: undefined,
      archiveReason: undefined,
      lastHitAt: now,
      hits: (Number(s.hits) || 0) + 1,
      vitality: Math.max(0.75, computeSkillVitality({ ...s, lastHitAt: now, hits: (Number(s.hits) || 0) + 1 }, now)),
    };
    restored.push(revived);
    next = rememberSkill(next, revived);
  }
  return { next, restored };
}

// 技能物理彻底清除通道（Purge · 合规不可恢复）：同时从活跃列表与冷备归档中物理删除
export function purgeLearnedSkill(activeList = [], idOrQuery = '') {
  const q = String(idOrQuery || '').trim().toLowerCase();
  if (!q) return { next: Array.isArray(activeList) ? activeList : [], purgedIds: [], recoverable: false };
  const isMatch = (s) => {
    if (!s || !s.id) return false;
    if (q === 'all' || q === '*') return true;
    return s.id.toLowerCase() === q || String(s.description || '').toLowerCase().includes(q);
  };
  const purgedIds = [];
  const next = (Array.isArray(activeList) ? activeList : []).filter((s) => {
    if (isMatch(s)) {
      purgedIds.push(s.id);
      return false;
    }
    return true;
  });
  for (const [k, v] of [...skillArchiveMap.entries()]) {
    if (isMatch(v) || purgedIds.includes(k)) {
      if (!purgedIds.includes(k)) purgedIds.push(k);
      skillArchiveMap.delete(k);
    }
  }
  return { next, purgedIds, recoverable: false };
}

// 技能写入质量守门人（Skill Quality Gatekeeper）：
// 拦截指代残片（如“这个呢”）、寒暄追问、过短无语义标题或未自愈的失败回合
const NOISE_SKILL_TITLE_RE = /^(?:这个呢|那个呢|那这个|那那个|这个|那个|继续|接着|接着写|再来|再来一次|重试|为什么|怎么回事|不对|改一下|换一个|还有吗|然后呢|再看看|帮我看看|看下这个|看看这个|好的|谢谢|明白|行吗|可以吗|怎么办|是什么|what\s+about\s+this|and\s+this|continue|try\s+again|why|fix\s+it)$/i;
const PURE_PARTICLE_RE = /^[这那哪它你我他她什怎吗呢吧啊哦嗯哈的了么呀\s]+$/;

export function isValidSkillCandidate(rawTitle, { toolNames = [], iterations = 0, unrecoveredError = false } = {}) {
  if (unrecoveredError) return false;
  const tools = [...new Set((toolNames || []).filter(Boolean))];
  const n = Number(iterations) || 0;
  if (n < 3 && tools.length < 3) return false;
  const title = String(rawTitle || '').replace(/^learned-/, '').replace(/\s+/g, ' ').trim();
  const core = title.replace(/[\s\p{P}\p{S}]+/gu, '');
  if (!core || core.length < 5) return false;
  if (NOISE_SKILL_TITLE_RE.test(core) || NOISE_SKILL_TITLE_RE.test(title)) return false;
  if (PURE_PARTICLE_RE.test(core)) return false;
  return true;
}

export function computeSkillVitality(skill, now = Date.now()) {
  if (!skill || !skill.id) return 0;
  const baseConf = typeof skill.confidence === 'number' ? skill.confidence : 0.85;
  const sr = typeof skill.successRate === 'number' ? skill.successRate : 1;
  const lastTouch = Number(skill.lastHitAt || skill.ts || now);
  const ageDays = Math.max(0, (now - lastTouch) / (24 * 3600 * 1000));
  const decay = Math.pow(0.94, ageDays); // 每日自然衰减 6%，被命中后刷新 lastHitAt 恢复活力
  const hitBoost = Math.min(0.18, (Number(skill.hits) || 0) * 0.03);
  return Number((baseConf * sr * decay + hitBoost).toFixed(3));
}

export function pruneLearnedSkillsWithReport(list = [], { now = Date.now(), cap = 8 } = {}) {
  if (!Array.isArray(list) || !list.length) return { kept: [], prunedIds: [], archivedIds: [], softArchived: [] };
  const candidates = [];
  const prunedIds = [];
  const archivedIds = [];
  const softArchived = [];
  const seen = new Set();

  const pushSoftArchive = (s, reason) => {
    const arc = { ...s, archived: true, archiveReason: reason, archivedAt: now };
    skillArchiveMap.set(s.id, arc);
    if (skillArchiveMap.size > MAX_SKILL_ARCHIVE) {
      const oldest = skillArchiveMap.keys().next().value;
      if (oldest) skillArchiveMap.delete(oldest);
    }
    archivedIds.push(s.id);
    softArchived.push(arc);
  };

  for (const s of list) {
    if (!s || !s.id) continue;
    const label = s.description || s.id.replace(/^learned-/, '');
    const ttlMs = Number(s.ttlMs) || SKILL_DEFAULT_TTL_MS;
    const lastTouch = Number(s.lastHitAt || s.ts || now);
    const expired = (now - lastTouch > ttlMs) && ((Number(s.hits) || 0) === 0);
    const lowSuccess = s.successRate != null && Number(s.successRate) < 0.45;
    const validTitle = isValidSkillCandidate(label, { toolNames: ['a', 'b', 'c'], iterations: 3 });
    const vitality = computeSkillVitality(s, now);

    // 1. 真正的噪声残片（如 learned-这个呢）或持续失败错招：硬清除，绝不归档
    if (!validTitle || lowSuccess || seen.has(s.id)) {
      prunedIds.push(s.id);
      skillArchiveMap.delete(s.id);
      continue;
    }
    seen.add(s.id);
    // 2. 时间超期或活力暂时下降的有效技能：转入软归档冷库（平时 0 Token，再次提及时自动唤醒，绝不因时间误删）
    if (expired || vitality < 0.36) {
      pushSoftArchive(s, expired ? 'ttl-cold' : 'vitality-cold');
      continue;
    }
    candidates.push({
      ...s,
      archived: false,
      confidence: typeof s.confidence === 'number' ? s.confidence : 0.85,
      ttlMs,
      vitality,
    });
  }
  candidates.sort((a, b) => (b.vitality - a.vitality) || ((b.ts || 0) - (a.ts || 0)));
  const kept = candidates.slice(0, cap);
  for (const overflow of candidates.slice(cap)) {
    pushSoftArchive(overflow, 'capacity-cold');
  }
  return { kept, prunedIds, archivedIds, softArchived };
}

export function pruneLearnedSkills(list = [], opts = {}) {
  return pruneLearnedSkillsWithReport(list, opts).kept;
}

export function formatSkillsIndex(learned = []) {
  const extra = pruneLearnedSkills(learned).filter((s) => s && s.id && s.description);
  const lines = [
    '## Skills（目录）',
    '回复前扫描下列技能。与本轮任务匹配的技能正文会注入「本轮规程」层——按它执行，不要再发明工具表里没有的工具。',
    '<available_skills>',
  ];
  const byTag = new Map();
  for (const s of BUNDLED_SKILLS) {
    if (!byTag.has(s.tag)) byTag.set(s.tag, []);
    byTag.get(s.tag).push(s);
  }
  for (const [tag, list] of byTag) {
    lines.push(`  ${tag}:`);
    for (const s of list) lines.push(`    - ${s.id}: ${s.description}`);
  }
  if (extra.length) {
    lines.push('  learned:');
    for (const s of extra.slice(0, 8)) lines.push(`    - ${s.id}: ${s.description} (vitality=${s.vitality ?? 0.85})`);
  }
  lines.push('</available_skills>');
  return lines.join('\n');
}

export function selectSkillBodies(plan, userText, learned = []) {
  const hits = [];
  for (const s of BUNDLED_SKILLS) {
    try {
      if (s.match(plan, userText)) hits.push(s);
    } catch { /* 单条技能匹配失败不影响其它 */ }
  }
  const cleanLearned = pruneLearnedSkills(learned);
  const archivedCandidates = getSoftArchivedSkills();
  const allSearchable = [...cleanLearned, ...archivedCandidates];
  const q = String(userText || '').slice(0, 200);
  const qTokens = new Set(tokenizeForSearch(q, { expandSynonyms: true }));
  for (const s of allSearchable) {
    if (!s || !s.body) continue;
    const key = `${s.id} ${s.description || ''} ${s.body}`;
    let matched = false;
    if (q && q.length >= 4 && key.toLowerCase().includes(q.slice(0, 24).toLowerCase())) {
      matched = true;
    } else if (qTokens.size >= 2) {
      const skillTokens = tokenizeForSearch(key, { expandSynonyms: true });
      let overlap = 0;
      for (const st of new Set(skillTokens)) {
        if (qTokens.has(st)) overlap++;
      }
      if (overlap >= 2) matched = true;
    }
    if (matched) {
      s.hits = (Number(s.hits) || 0) + 1;
      s.lastHitAt = Date.now();
      if (s.archived) {
        s.archived = false;
        skillArchiveMap.delete(s.id);
        if (Array.isArray(learned) && !learned.some((x) => x && x.id === s.id)) {
          learned.unshift(s);
        }
      }
      hits.push(s);
    }
  }
  const seen = new Set();
  const uniq = [];
  for (const s of hits) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    uniq.push(s);
    if (uniq.length >= 2) break;
  }
  if (!uniq.length) return '';
  return ['【本轮规程】已按任务匹配加载下列技能，请遵守：', ...uniq.map((s) => s.body)].join('\n\n');
}

export function distillSkill({ userText, toolNames, iterations, unrecoveredError = false } = {}) {
  const tools = [...new Set((toolNames || []).filter(Boolean))];
  const n = Number(iterations) || 0;
  const title = String(userText || '').replace(/\s+/g, ' ').trim().slice(0, 48);
  if (!isValidSkillCandidate(title, { toolNames: tools, iterations: n, unrecoveredError })) {
    return null;
  }
  const slug = title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'task';
  const now = Date.now();
  return {
    id: `learned-${slug}`,
    description: title,
    confidence: 0.86,
    ttlMs: SKILL_DEFAULT_TTL_MS,
    hits: 0,
    lastHitAt: now,
    body: [
      `## Learned skill: ${title}`,
      `- 当时用过的工具：${tools.join(', ') || '（无）'}`,
      `- 迭代 ${n} 次。类似请求可复用这条路径，不要无故加步骤。`,
    ].join('\n'),
    ts: now,
  };
}

export function rememberSkill(list, skill, cap = 8) {
  const cleanList = pruneLearnedSkills(list, { cap });
  if (!skill || !skill.id) return cleanList;
  if (!isValidSkillCandidate(skill.description || skill.id, { toolNames: ['a', 'b', 'c'], iterations: 3 })) {
    return cleanList;
  }
  const prev = cleanList.find((s) => s && s.id === skill.id);
  let merged = skill;
  if (prev) {
    const uses = (Number(prev.uses) || 1) + (Number(skill.uses) || 1);
    const successCount = (Number(prev.successCount) || 1) + (Number(skill.successCount) || 1);
    const successRate = Number((successCount / Math.max(1, uses)).toFixed(2));
    merged = {
      ...prev,
      ...skill,
      uses,
      successCount,
      successRate,
      confidence: Math.min(0.98, Number(((prev.confidence || 0.85) + 0.04).toFixed(2))),
      lastHitAt: Date.now(),
    };
  }
  const out = cleanList.filter((s) => s && s.id !== skill.id);
  out.unshift(merged);
  return pruneLearnedSkills(out, { cap });
}
