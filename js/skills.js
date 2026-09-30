// ─── Skills：Hermes 式渐进披露（目录进稳定层，正文只在匹配时注入 ephemeral）──
// 不移植 skill_view 工具：浏览器 Agent 多一轮加载成本高，Jev/关键词命中后直接注入正文。
// 复杂回合结束后用工具轨迹蒸馏一条会话技能（无额外 LLM 调用，fail-open）。

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
      '- 时效性问题：联网已开且有中继时用 fetch_url 抓来源页；没有中继或开关关掉就直说无法核实。',
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
      '- 统计图、折线图、柱状图、饼图、散点图、物理 s-t 图：直接用 Markdown 快捷语法 ```:::chart line 标题``` / ```:::chart st 标题``` 等，或写 SVG 文件后用 sandbox:// 嵌入。',
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

export function formatSkillsIndex(learned = []) {
  const extra = (learned || []).filter((s) => s && s.id && s.description);
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
    for (const s of extra.slice(0, 8)) lines.push(`    - ${s.id}: ${s.description}`);
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
  const q = String(userText || '').slice(0, 200);
  for (const s of learned || []) {
    if (!s || !s.body) continue;
    const key = `${s.id} ${s.description || ''} ${s.body}`;
    if (q && key.toLowerCase().includes(q.slice(0, 24).toLowerCase())) hits.push(s);
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

export function distillSkill({ userText, toolNames, iterations } = {}) {
  const tools = [...new Set((toolNames || []).filter(Boolean))];
  const n = Number(iterations) || 0;
  if (n < 3 && tools.length < 3) return null;
  const title = String(userText || '').replace(/\s+/g, ' ').trim().slice(0, 48);
  if (!title) return null;
  const slug = title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'task';
  return {
    id: `learned-${slug}`,
    description: title,
    body: [
      `## Learned skill: ${title}`,
      `- 当时用过的工具：${tools.join(', ') || '（无）'}`,
      `- 迭代 ${n} 次。类似请求可复用这条路径，不要无故加步骤。`,
    ].join('\n'),
    ts: Date.now(),
  };
}

export function rememberSkill(list, skill, cap = 8) {
  if (!skill || !skill.id) return Array.isArray(list) ? list.slice() : [];
  const arr = Array.isArray(list) ? list : [];
  const prev = arr.find((s) => s && s.id === skill.id);
  let merged = skill;
  if (prev) {
    const uses = (Number(prev.uses) || 1) + (Number(skill.uses) || 1);
    const successCount = (Number(prev.successCount) || 1) + (Number(skill.successCount) || 1);
    merged = {
      ...prev,
      ...skill,
      uses,
      successCount,
      successRate: Number((successCount / Math.max(1, uses)).toFixed(2)),
    };
  }
  const out = arr.filter((s) => s && s.id !== skill.id);
  out.unshift(merged);
  return out.slice(0, cap);
}
