// ─── 空状态任务示例池（纯函数 + 数据，便于单测）────────────────────────
// 卡片展示 20–30 字概括（title）；点击填入约 200 字的完整提示词（text）。
// 任务有挑战性，但只使用真实工具：JS/Python/C++ 沙箱、文件、ZIP、生图、
// regex/hash/codec/unicode、search_files/diff_text/json_tool。
// 不写切模型、点回滚、未上传的图、只有 Max 才能委派、联网搜索。

export const SUGGESTIONS = [
  {
    title: '用 Python 做线性回归并写出带残差表的报告',
    text: '用 Python 沙箱（可装 numpy）生成 80 个点：x 均匀取 [0,10]，y=1.7x-0.4 再加标准差 0.6 的噪声。手写正规方程求出斜率与截距（不要调用 sklearn），列出前 8 个残差，把方法、系数、RMSE 写成 Markdown 报告，保存到 files/regression.md。系数保留四位小数，报告须能单独阅读。',
  },
  {
    title: 'C++ 实现 LRU 缓存并和暴力解对拍一百组',
    text: '在 C++ 沙箱实现容量为 4 的 LRU（get/put，最近使用的留在缓存）。再写一个暴力字典作对照。随机生成 100 组操作（键 0–15，含 get/put），逐步对拍每次 get 的返回值。全部通过则打印 PASS 与耗时；若失败，打印第一组失败的操作序列、两边结果，不要只说有错。代码含 main，可直接编译。',
  },
  {
    title: '从杂乱服务日志抽出字段做成可校验的 CSV',
    text: '把下面日志写入 files/raw.log，用 regex 工具抽出 ts、level、service、code。忽略破行。写成 files/events.csv（表头 ts,level,service,code），再用 JavaScript 断言：行数≥5、code 都是三位数字、没有 ERROR 行丢失。最后用 hash 算 csv 的 sha256，把校验和写进 files/events.sha256。\n\n2026-09-26T10:01:02Z INFO api code=200 path=/health\n2026-09-26T10:01:03Z ERROR billing code=503 path=/pay\n[garbage]\n2026-09-26T10:01:04Z WARN api code=429 path=/v1/chat\n2026-09-26T10:01:05Z INFO worker code=201 path=/job\n2026-09-26T10:01:06Z ERROR api code=500 path=/v1/messages',
  },
  {
    title: '用差分测试两种排序并保存第一组失败用例',
    text: '用 JavaScript 沙箱实现插入排序（稳定、原地）。对 120 组随机整数数组（长度 8–40，含负数与重复）与 Array.prototype.sort 的数值序对拍。若全部一致，打印 PASS 与最大数组长度；一旦失败，把该组输入、两种输出写入 files/sort-fail.json，并停止后续组。不要用内置 sort 充当插入排序的实现。',
  },
  {
    title: '生成 TeamoAgent 发布海报并写入沙箱路径',
    text: '生成一张 1024×1024 海报：近黑底、极细白线网格、中心是轨道枢纽几何标（三弧+核心），主标题 TeamoAgent，副标题「浏览器里的智能体 / V1.2」。留足够负空间，不要堆满装饰。生成后告诉我沙箱路径，并用一句话说明构图（不超过 40 字）。不要用 ASCII 画代替真实出图。',
  },
  {
    title: '在沙箱搭三页静态站并打包成可分发 ZIP',
    text: '在沙箱创建 site/index.html、site/about.html、site/style.css。首页介绍 TeamoAgent 三句话+两个内链；about 写能力列表（沙箱、生图、文件、思考档）。CSS 黑白极简、系统字体、max-width 640。用 list_files 核对路径后 zip_files 打成 archives/site.zip，回报 zip 路径和三个文件的字节量。页面须能直接打开，不要占位注释。',
  },
  {
    title: '把一份模拟销售账做成队列、留存与异常检测',
    text: '用 JavaScript 生成 120 行销售 CSV：日期 2026-07-01 起、城市（东京/大阪/京都）、品类、金额 20–800。写入 files/sales.csv。计算：各城市 GMV、金额最高的 5 单、连续 3 天低于该市均值 40% 的日期。结果写成 Markdown 表格保存 files/sales-report.md。金额保留整数，城市名保持中文。',
  },
  {
    title: 'NFC 与 NFD 往返日文浊音并解释码位差异',
    text: '用 unicode 工具分别 inspect「が」与「か」+ 结合用浊点（U+3099）。再 normalize 到 NFD 与 NFC，确认往返是否回到同一字符串。把每步的码位、名称、UTF-8 字节写成 files/kana-normalize.md。最后用 JavaScript 断言 NFC(NFD(が))===が，失败则打印实际码位序列。不要只给结论不给码位。',
  },
  {
    title: '用正则实现一套口令策略并列出会失败的样例',
    text: '写一组 JS 正则（要带 u 标志），检查口令同时满足：长度≥10、含大写、小写、数字、以及非 ASCII 符号（例如全角感叹号）。用 regex 工具对下列样例逐条 match，输出通过/失败原因，写入 files/password-policy.md：Hello12345、Hello1234!、你好Hello12、Hello12！！、Abcdefghij1。不要在沙箱里循环口算，必须走 regex 工具。',
  },
  {
    title: '在沙箱写 JSON Schema 校验器并跑正反用例',
    text: '用 JavaScript 实现一个极简校验器：支持 type object/string/number、required、properties。schema 为 {type:"object",required:["id","name"],properties:{id:{type:"number"},name:{type:"string"}}}。对三组输入跑校验（合法一份、缺 name 一份、id 为字符串一份），把每次的 errors 数组写入 files/schema-results.json。校验器代码放 files/schema.js，不要依赖外部库。',
  },
  {
    title: '解码一段 JWT 并核对 header 里的算法字段',
    text: '用 codec 工具（format=jwt, action=decode）解码：eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZWFtbyIsInJvbGUiOiJhZ2VudCIsImV4cCI6MTc5MDQwMDAwMH0.dGVhbW8. 若 padding 导致失败，先补等号再试。把 header.alg、payload.sub、payload.role 写成表格，并明确说明本工具不校验签名，因此不能据此认证。结果保存 files/jwt-audit.md。',
  },
  {
    title: '对比两份配置并用 diff 生成可应用的补丁',
    text: '写入 files/config.old.json：{"port":8787,"models":["claude-sonnet-5"],"thinking":false}。files/config.new.json：{"port":8787,"models":["claude-sonnet-5","gpt-5.6-sol"],"thinking":true,"fast":false}。用 json_tool pretty 后再 diff_text 对比两个文件，把 unified diff 保存到 files/config.patch。最后用一句话解释新增了哪些键、thinking 为何变化。不要手写差异。',
  },
  {
    title: '批量哈希沙箱里的文件并输出可复核校验清单',
    text: '在沙箱写入 files/a.txt（内容 Teamo）、files/b.txt（内容 Agent）、files/c.txt（内容 2026-09-26）。用 hash 工具分别算 sha256，生成 files/SHA256SUMS，格式与 GNU sha256sum 一致（哈希、两个空格、文件名）。再用 JavaScript 读回清单，逐行重新哈希核对，打印全部 OK 或第一处 mismatch。不要口算哈希。',
  },
  {
    title: '用蒙特卡洛为欧式看涨期权定价并写清假设',
    text: '用 JavaScript 沙箱：S0=100，K=100，r=0.03，sigma=0.2，T=1，路径 20000。欧式看涨，贴现均值作价格，再报 95% 置信区间（用样本标准差）。把假设、公式、价格、区间写入 files/option.md，保留四位小数。不要引入外部定价库；随机数用 mulberry32，种子 42，保证可复现。',
  },
  {
    title: '写一个 Markdown 看板并导入三张带标签的卡',
    text: '在 files/board.md 用简单语法实现看板：## Todo / ## Doing / ## Done，卡片格式 - [ ] title #tag。导入三张卡：「梳理工具 schema」#docs 在 Todo，「修彩虹闪白」#ui 在 Done，「沙箱卡片化」#ui 在 Doing。再用 regex 抽出所有 #ui 卡片标题，写入 files/board-ui.txt。最后 list_files 确认这两个文件都在。卡片标题保持中文。',
  },
];

export function shuffled(list, rnd = Math.random) {
  const a = [...(list || [])];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

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
  for (const item of order) {
    if (picked.length >= n) break;
    if (!picked.includes(item)) picked.push(item);
  }
  return picked;
}
