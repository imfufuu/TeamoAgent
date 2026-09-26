// ─── 空状态任务示例池（纯函数 + 数据，便于单测）────────────────────────
// 卡片只显示短主题（title）；点击后把完整提示词（text）填进输入框。
// 能力范围对齐真实工具：JS/Python/C++ 沙箱、读写文件、ZIP、生图、本地
// regex/hash/codec/unicode。不写「切换模型 / 打开快速模式 / 点回滚 /
// 审查未上传的图 / 只有 Max 才能委派」这类用户或环境做不到的演示。

export const SUGGESTIONS = [
  {
    title: '斐波那契里的质数',
    text: '用 JavaScript 沙箱计算前 100 个斐波那契数中有多少个质数。列出这些质数，把计算过程写成 Markdown，保存到 files/fib-primes.md。',
  },
  {
    title: '蒙特卡洛估 π',
    text: '用 JavaScript 沙箱做蒙特卡洛估算圆周率：随机投点 100000 次，输出估计值、与 Math.PI 的误差，以及一段不超过 5 行的结论。',
  },
  {
    title: '1–20 阶乘表',
    text: '用 Python 沙箱生成 1 到 20 的阶乘表，排成 Markdown 表格（列：n、n!），写入 files/factorials.md。不要省略中间的行。',
  },
  {
    title: '快排对拍 std::sort',
    text: '在 C++ 沙箱里实现 quicksort（可改原地）。生成 10 组长度 20 的随机整数数组，与 std::sort 的结果对拍，打印每组是否一致；若有失败给出那一组数据。',
  },
  {
    title: '静夜思英译存档',
    text: '把李白《静夜思》原文写入 files/poem.txt。再按原诗四句逐句译成英文，保存为 files/poem.en.md（中英对照）。',
  },
  {
    title: '深夜机械猫插画',
    text: '生成一张 1024×1024 插画：深夜实验室里的机械猫，冷色顶光、金属反光、浅景深。生成后告诉我沙箱里的文件路径。',
  },
  {
    title: '三目录打包 ZIP',
    text: '在沙箱创建 demo/a、demo/b、demo/c，每个目录写一个 README.md（一句话说明该目录用途）。列出目录树，再打包成 zip 并告诉我 zip 路径。',
  },
  {
    title: '销售数据 Top5',
    text: '在沙箱生成一份 50 行销售 CSV，列：日期、城市、品类、金额。用 JavaScript 汇总出金额最高的 5 个城市，输出 Markdown 表格并写入 files/top5.md。',
  },
  {
    title: '修这段 JS 循环',
    text: '指出下面这段 JavaScript 的问题（含隐式全局、比较、提前 return），给出修复后的完整函数并各用一个正例/反例说明：\n\nfunction f(a){for(i=0;i<a.length;i++) if(a[i]==0) return}',
  },
  {
    title: '字符串双哈希',
    text: '对字符串 TeamoAgent 分别计算 SHA-256 和 MD5。给出两个十六进制结果，并各用一句话说明长度为什么不同。',
  },
  {
    title: '拆开生僻字码位',
    text: '用 unicode 工具分别拆开「𰻞」和「TeamoAgent」：列出每个字符的码位（U+xxxx）和 Unicode 名称。',
  },
  {
    title: 'Base64 往返校验',
    text: '把「你好，TeamoAgent」做 Base64 编码，再解码回原文。对照是否完全一致；再给出对应的 URL 编码（encodeURIComponent 风格）。',
  },
  {
    title: '正则抽出日期',
    text: '用正则从这段文本抽出所有 ISO 日期（YYYY-MM-DD），列出匹配与捕获组：\n会议订在 2026-09-26，备份窗口 2026-10-01 到 2026-10-03，过期稿 2025-12-31 已归档。',
  },
  {
    title: 'CSV 转 Markdown 表',
    text: '把下面三行写成 files/people.csv，再读出来转成 Markdown 表格输出：\nname,role,city\nAda,engineer,Tokyo\nLin,designer,Kyoto',
  },
  {
    title: 'FizzBuzz 写测试',
    text: '用 JavaScript 沙箱实现 FizzBuzz（1 到 30）：3 的倍数 Fizz、5 的倍数 Buzz、15 的倍数 FizzBuzz。打印结果，并断言第 15 项是 FizzBuzz、第 7 项是 7。',
  },
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
 * 抽取本轮展示的任务示例：随机、不重复。
 * exclude：上一批的 text（或条目），刷新时尽量避开，避免连续两次同一组。
 */
export function pickSuggestions(list = SUGGESTIONS, n = 3, rnd = Math.random, exclude = []) {
  const pool = Array.isArray(list) ? list.filter((x) => x && x.text) : [];
  const ban = new Set((Array.isArray(exclude) ? exclude : []).map((x) => (typeof x === 'string' ? x : (x && x.text) || '')));
  ban.delete('');
  const order = shuffled(pool, rnd);
  const picked = [];
  const usedTags = new Set();
  const take = (allowBanned) => {
    for (const item of order) {
      if (picked.length >= n) break;
      if (picked.includes(item)) continue;
      if (!allowBanned && ban.has(item.text)) continue;
      const tag = item.tag || '';
      if (tag && usedTags.has(tag)) continue;
      if (tag) usedTags.add(tag);
      picked.push(item);
    }
  };
  take(false);
  // 标签去重后不足、或 exclude 把池子抽干：不再挡 tag / ban，只保证不重复
  for (const item of order) {
    if (picked.length >= n) break;
    if (!picked.includes(item)) picked.push(item);
  }
  return picked;
}
