// ─── Skills：Hermes 式渐进披露（目录进稳定层，正文只在匹配时注入 ephemeral）──
// 不移植 skill_view 工具：浏览器 Agent 多一轮加载成本高，Jev/关键词命中后直接注入正文。
// 复杂回合结束后用工具轨迹蒸馏一条会话技能（无额外 LLM 调用，fail-open）。

export const BUNDLED_SKILLS = [
  {
    id: 'web-research',
    tag: 'research',
    description: '实时事实走服务端网页搜索，有来源再下结论',
    match: (plan, text) => {
      if (plan && (plan.route === 'search' || (plan.needSearch != null && plan.needSearch >= 0.55))) return true;
      return /最新|今天|当前|汇率|股价|版本号|news|today|price/i.test(String(text || ''));
    },
    body: [
      '## Skill: web-research',
      '- 时效性问题必须走本轮已开启的服务端网页搜索；没有检索事件就不要写「已联网」。',
      '- 回答里带来源链接。具体网页正文用 fetch_url（仅本地中继可用）。',
      '- 查不到就明说没查到，不要用记忆数字冒充刚搜到的。',
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
      '- 需要落盘的中间结果 write_file；读已有文件再算。沙箱关闭时不要假装执行过。',
      '- 互不依赖的只读步骤（read_file / list_files）可同一轮并行发出。',
    ].join('\n'),
  },
  {
    id: 'image-generation',
    tag: 'image',
    description: '出图必须调用 generate_image，禁止用文字代替',
    match: (plan, text) => {
      if (plan && (plan.route === 'image' || (plan.needImage != null && plan.needImage >= 0.55))) return true;
      return /画一|生成.*图|改图|插画|出张图|generate.?image/i.test(String(text || ''));
    },
    body: [
      '## Skill: image-generation',
      '- 用户要图：调用 generate_image。model 只能是网关 ID（gpt-image-2 / gpt-image-2.5-sunburst / gpt-image-2.5-flare）。',
      '- 改图用 reference_paths 指向沙箱内图片。不要用 ASCII / 纯文字描述代替真实出图。',
    ].join('\n'),
  },
  {
    id: 'git-workspace',
    tag: 'git',
    description: '真实仓库操作走 run_git（本地中继）',
    match: (plan, text) => /git|仓库|commit|clone|pull request|\bpr\b|分支|rebase/i.test(String(text || '')),
    body: [
      '## Skill: git-workspace',
      '- 写操作前先 run_git status / diff。commit 信息用完整句子，不要经 shell 拼接。',
      '- 没有本地中继时工具表里没有 run_git：说明限制，不要假装提交成功。',
    ].join('\n'),
  },
  {
    id: 'subagent-dispatch',
    tag: 'delegate',
    description: '专业视角任务主动 dispatch_subagent，task 自包含',
    match: (plan) => !!(plan && plan.needDispatch != null && plan.needDispatch >= 0.55),
    body: [
      '## Skill: subagent-dispatch',
      '- 适合专业视角（审查、研究、写作、数据分析）时主动 dispatch_subagent，不必等用户点名。',
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
  const out = (Array.isArray(list) ? list : []).filter((s) => s && s.id !== skill.id);
  out.unshift(skill);
  return out.slice(0, cap);
}
