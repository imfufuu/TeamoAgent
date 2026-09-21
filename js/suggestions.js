// ─── 空状态任务示例池（纯函数 + 数据，便于单测）────────────────────────
// 每次渲染空状态时从池子里随机抽 3 条，覆盖不同能力面（沙箱执行 / 生图改图 /
// 文件与打包 / 子智能体 / 多模型对比 / 上下文与回滚），让新用户一眼看到「能干什么」。
// 卡片上只显示任务本身：早先每条前面挂过「任务类型」小标签（沙箱 / 文生图 / 协议…），
// 用户要求去掉 —— 类型在文案里已经能读出来，标签只是额外的视觉噪音。
// 注意：示例里提到的模型必须是网关真实存在的（此前有一条点名 qwen，而 /v1/models
// 里根本没有 qwen 系模型，点了只会得到一轮「找不到模型」的失败演示）。

export const SUGGESTIONS = [
  // 代码沙箱
  { text: '用沙箱计算：前 100 个斐波那契数中有多少个质数？' },
  { text: '写一段 JS 在沙箱里用蒙特卡洛估算 π，跑 10 万次并验证误差' },
  { text: '用 Python 沙箱（Pyodide）画出 1~20 的阶乘增长表，并把结果写入 files/factorials.md' },
  { text: '在 C++ 沙箱里写一个快速排序，用 10 组随机数组对拍 std::sort 验证正确性' },
  { text: '把《静夜思》写入 files/poem.txt，读出来后逐句翻译成英文并存成 files/poem.en.md' },
  // 生图 / 图片编辑
  { text: '画一张「深夜实验室里的机械猫」，1024x1024，生成后把图写进沙箱并告诉我路径' },
  { text: '用 generate_image 生成三张候选图（n=3），再把最满意的一张改成夜晚霓虹配色' },
  { text: '把我刚上传的图片改成透明底，并把结果连同原图一起打包成 ZIP' },
  // 文件 / 导出
  { text: '在沙箱里建三个目录 demo/a、demo/b、demo/c 并各写一个文件，然后按目录树列出来' },
  { text: '生成一份 200 行的销售数据 CSV 写入沙箱，用 JS 聚合出 Top5 并输出 Markdown 表格' },
  // 子智能体 / 工具循环
  { text: '派 code-reviewer 审查这段代码的问题：function f(a){for(i=0;i<a.length;i++) if(a[i]==0) return}' },
  { text: '让 security-auditor 与 debugger 协作：先审一段 Express 路由的鉴权漏洞，再修复并给出验证用例' },
  // 多模型 / 网关能力
  { text: '对比网关里带 -free 的免费模型（deepseek、glm 等）：各写一首关于秋天的五言绝句，再点评优劣' },
  { text: '打开「快速」模式（service_tier=fast）跑一次 GPT 模型，告诉我它和默认档的耗时差异' },
  { text: 'GET /v1/models 里现在有哪些模型？按供应商分组列出来，并标出支持视觉的' },
  // 上下文 / 回滚
  { text: '连续问我三轮再回答，最后演示用「回滚」退回到第二轮之前，并说明消息数组怎么变的' },
  { text: '把一段 3000 字的中文长文压缩成 5 条要点，再展开成结构化大纲（验证上下文压缩策略）' },
  { text: '解释一下 TeamoRouter 的 Claude 为什么要走 /v1/messages 而不是 /v1/chat/completions，并给出请求头示例' },
];

// 洗牌（Fisher-Yates，不改动原数组）
export function shuffled(list, rnd = Math.random) {
  const a = [...(list || [])];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 抽取本轮展示的任务示例：随机、不重复，且尽量分散在不同能力面
 * （同一 tag 最多一条；池子里同类不够时用剩余随机项补齐）。
 */
export function pickSuggestions(list = SUGGESTIONS, n = 3, rnd = Math.random) {
  const pool = Array.isArray(list) ? list.filter((x) => x && x.text) : [];
  const order = shuffled(pool, rnd);
  const picked = [];
  const usedTags = new Set();
  for (const item of order) {
    if (picked.length >= n) break;
    const tag = item.tag || '';
    if (tag && usedTags.has(tag)) continue;
    usedTags.add(tag);
    picked.push(item);
  }
  for (const item of order) { // 标签去重后不足则补齐
    if (picked.length >= n) break;
    if (!picked.includes(item)) picked.push(item);
  }
  return picked;
}
