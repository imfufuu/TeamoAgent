// ─── 提示词装配（Hermes 风格三层：stable → context → volatile，外加 ephemeral）──
// 参考：Nous Research hermes-agent 的 prompt_builder / system_prompt
//   · cached = stable（身份、技能目录）→ context（项目/子智能体指引）→ volatile（记忆、沙箱快照、时间）
//   · ephemeral 只在本轮 API 调用时附加：Jev、已加载技能正文、预算压力、压缩摘要
// 同一用户回合内（工具循环多次迭代）复用 cached 前缀，避免把每秒变化的内容写进稳定层。
// 不在这里 import config.systemPrompt：身份字符串由调用方传入，混版缓存更安全。

const join = (parts) => (parts || []).map((p) => (p == null ? '' : String(p).trim())).filter(Boolean).join('\n\n');

export function assembleSystemLayers({
  identity = '',
  skillsIndex = '',
  contextFiles = '',
  memory = '',
  runtime = '',
  ephemeral = '',
} = {}) {
  const stable = join([identity, skillsIndex]);
  const context = join([contextFiles]);
  const volatile = join([memory, runtime]);
  const cached = join([stable, context, volatile]);
  const eph = join([ephemeral]);
  const messages = [{ role: 'system', text: cached, cache: true, layer: 'cached' }];
  if (eph) messages.push({ role: 'system', text: eph, layer: 'ephemeral' });
  return { messages, stable, context, volatile, cached, ephemeral: eph };
}

export function formatRuntime({ now, model, filesNote, webNote, relayNote } = {}) {
  const lines = ['# TeamoAgent runtime'];
  if (now) lines.push(`当前时间：${now instanceof Date ? now.toISOString() : String(now)}`);
  if (model) lines.push(`Session model: ${model}`);
  const extra = join([filesNote, webNote, relayNote]);
  return extra ? `${lines.join('\n')}\n\n${extra}` : lines.join('\n');
}

export function formatBudgetNote(iteration, maxIter) {
  const n = Number(iteration) || 0;
  const cap = Number(maxIter) || 0;
  if (!cap || n < cap - 1) return '';
  if (n >= cap) return '【上下文压力】工具循环次数已用尽，必须给出最终回答，不要再发起新的工具调用。';
  return `【上下文压力】只剩最后一次工具循环（${n}/${cap}），请收敛为最终回答，不要再开新的长链路。`;
}
