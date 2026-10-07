// ─── 空状态任务示例池（纯函数 + 数据，便于单测）────────────────────────
// 卡片展示 30–50 字概括（title 长短不一，卡已拉齐宽度）；点击填入约 200 字的完整提示词（text）。
// 任务有挑战性，但只使用真实工具：JS/Python/C++ 沙箱、文件、ZIP、生图、
// text_tool（含 regex/hash/codec/unicode）/ data_tool、search_files/diff_text/json_tool。
// 不写切模型、点回滚、未上传的图、只有 Max 才能委派、联网搜索。

export const SUGGESTIONS = [
  {
    title: '用 Python 沙箱手写正规方程做线性回归，并写出带残差表与 RMSE 的完整报告',
    text: '用 Python 沙箱（可装 numpy）生成 80 个点：x 均匀取 [0,10]，y=1.7x-0.4 再加标准差 0.6 的噪声。手写正规方程求出斜率与截距（不要调用 sklearn），列出前 8 个残差，把方法、系数、RMSE 写成 Markdown 报告，保存到 files/regression.md。系数保留四位小数，报告须能单独阅读。',
  },
  {
    title: '在 C++ 沙箱实现容量为 4 的 LRU 缓存，再和暴力字典对拍一百组随机操作',
    text: '在 C++ 沙箱实现容量为 4 的 LRU（get/put，最近使用的留在缓存）。再写一个暴力字典作对照。随机生成 100 组操作（键 0–15，含 get/put），逐步对拍每次 get 的返回值。全部通过则打印 PASS 与耗时；若失败，打印第一组失败的操作序列、两边结果，不要只说有错。代码含 main，可直接编译。',
  },
  {
    title: '从一份夹杂垃圾行的服务日志里抽出字段，做成可校验的事件 CSV 并哈希',
    text: '把下面日志写入 files/raw.log，用 text_tool（action=regex）抽出 ts、level、service、code。忽略破行。写成 files/events.csv（表头 ts,level,service,code），再用 JavaScript 断言：行数≥5、code 都是三位数字、没有 ERROR 行丢失。最后用 hash 算 csv 的 sha256，把校验和写进 files/events.sha256。\n\n2026-09-26T10:01:02Z INFO api code=200 path=/health\n2026-09-26T10:01:03Z ERROR billing code=503 path=/pay\n[garbage]\n2026-09-26T10:01:04Z WARN api code=429 path=/v1/chat\n2026-09-26T10:01:05Z INFO worker code=201 path=/job\n2026-09-26T10:01:06Z ERROR api code=500 path=/v1/messages',
  },
  {
    title: '用差分测试插入排序与内置排序，一旦失败就把该组输入输出写入文件',
    text: '用 JavaScript 沙箱实现插入排序（稳定、原地）。对 120 组随机整数数组（长度 8–40，含负数与重复）与 Array.prototype.sort 的数值序对拍。若全部一致，打印 PASS 与最大数组长度；一旦失败，把该组输入、两种输出写入 files/sort-fail.json，并停止后续组。不要用内置 sort 充当插入排序的实现。',
  },
  {
    title: '生成一张黑白极简的 Dubhe Agent 发布海报，完成后把沙箱路径告诉我',
    text: '生成一张 1024×1024 海报：近黑底、极细白线网格、中心是轨道枢纽几何标（三弧+核心），主标题 Dubhe Agent，副标题「浏览器里的智能体 / V1.6」。留足够负空间，不要堆满装饰。生成后告诉我沙箱路径，并用一句话说明构图（不超过 40 字）。不要用 ASCII 画代替真实出图。',
  },
  {
    title: '在沙箱搭好三页可打开的静态站，再用 zip_files 打成可分发的 ZIP',
    text: '在沙箱创建 site/index.html、site/about.html、site/style.css。首页介绍 Dubhe Agent 三句话+两个内链；about 写能力列表（沙箱、生图、文件、思考档）。CSS 黑白极简、系统字体、max-width 640。用 list_files 核对路径后 zip_files 打成 archives/site.zip，回报 zip 路径和三个文件的字节量。页面须能直接打开，不要占位注释。',
  },
  {
    title: '用模拟销售账计算各城市 GMV、最高五单，以及连续低于均值的异常日',
    text: '用 JavaScript 生成 120 行销售 CSV：日期 2026-07-01 起、城市（东京/大阪/京都）、品类、金额 20–800。写入 files/sales.csv。计算：各城市 GMV、金额最高的 5 单、连续 3 天低于该市均值 40% 的日期。结果写成 Markdown 表格保存 files/sales-report.md。金额保留整数，城市名保持中文。',
  },
  {
    title: '用 text_tool 把日文浊音做 NFC / NFD 往返，并解释每一步的码位差异',
    text: '用 text_tool（action=unicode, op=inspect）分别检查「が」与「か」+ 结合用浊点（U+3099）。再 normalize 到 NFD 与 NFC，确认往返是否回到同一字符串。把每步的码位、名称、UTF-8 字节写成 files/kana-normalize.md。最后用 JavaScript 断言 NFC(NFD(が))===が，失败则打印实际码位序列。不要只给结论不给码位。',
  },
  {
    title: '写一组带 u 标志的口令策略正则，并对五条样例逐条说明通过或失败原因',
    text: '写一组 JS 正则（要带 u 标志），检查口令同时满足：长度≥10、含大写、小写、数字、以及非 ASCII 符号（例如全角感叹号）。用 text_tool（action=regex）对下列样例逐条 match，输出通过/失败原因，写入 files/password-policy.md：Hello12345、Hello1234!、你好Hello12、Hello12！！、Abcdefghij1。不要在沙箱里循环口算，必须走 text_tool（action=regex）。',
  },
  {
    title: '在沙箱写一个极简 JSON Schema 校验器，跑正反用例后把 errors 数组落盘',
    text: '用 JavaScript 实现一个极简校验器：支持 type object/string/number、required、properties。schema 为 {type:"object",required:["id","name"],properties:{id:{type:"number"},name:{type:"string"}}}。对三组输入跑校验（合法一份、缺 name 一份、id 为字符串一份），把每次的 errors 数组写入 files/schema-results.json。校验器代码放 files/schema.js，不要依赖外部库。',
  },
  {
    title: '解码一段 JWT，核对 header 里的算法字段，并写明本工具并不校验签名',
    text: '用 text_tool（action=codec, op=decode, format=jwt）解码：eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZWFtbyIsInJvbGUiOiJhZ2VudCIsImV4cCI6MTc5MDQwMDAwMH0.dGVhbW8. 若 padding 导致失败，先补等号再试。把 header.alg、payload.sub、payload.role 写成表格，并明确说明本工具不校验签名，因此不能据此认证。结果保存 files/jwt-audit.md。',
  },
  {
    title: '对比两份 JSON 配置，用 diff_text 生成可应用的 unified diff 补丁文件',
    text: '写入 files/config.old.json：{"port":8787,"models":["claude-sonnet-5"],"thinking":false}。files/config.new.json：{"port":8787,"models":["claude-sonnet-5","gpt-5.6-sol"],"thinking":true,"fast":false}。用 json_tool pretty 后再 diff_text 对比两个文件，把 unified diff 保存到 files/config.patch。最后用一句话解释新增了哪些键、thinking 为何变化。不要手写差异。',
  },
  {
    title: '给沙箱里的三个文本文件批量算 sha256，并输出可再核对的 SHA256SUMS',
    text: '在沙箱写入 files/a.txt（内容 Dubhe）、files/b.txt（内容 Agent）、files/c.txt（内容 2026-09-26）。用 hash 工具分别算 sha256，生成 files/SHA256SUMS，格式与 GNU sha256sum 一致（哈希、两个空格、文件名）。再用 JavaScript 读回清单，逐行重新哈希核对，打印全部 OK 或第一处 mismatch。不要口算哈希。',
  },
  {
    title: '用可复现的蒙特卡洛为欧式看涨期权定价，写清假设、价格与 95% 置信区间',
    text: '用 JavaScript 沙箱：S0=100，K=100，r=0.03，sigma=0.2，T=1，路径 20000。欧式看涨，贴现均值作价格，再报 95% 置信区间（用样本标准差）。把假设、公式、价格、区间写入 files/option.md，保留四位小数。不要引入外部定价库；随机数用 mulberry32，种子 42，保证可复现。',
  },
  {
    title: '写一个 Markdown 看板，导入三张带标签的卡片，再用正则抽出所有 #ui 卡',
    text: '在 files/board.md 用简单语法实现看板：## Todo / ## Doing / ## Done，卡片格式 - [ ] title #tag。导入三张卡：「梳理工具 schema」#docs 在 Todo，「修彩虹闪白」#ui 在 Done，「沙箱卡片化」#ui 在 Doing。再用 regex 抽出所有 #ui 卡片标题，写入 files/board-ui.txt。最后 list_files 确认这两个文件都在。卡片标题保持中文。',
  },
  // ── 以下为 V1.7.1 新增：覆盖更多领域（金融 / 生物 / 物理 / 语言 / 地理 / 音乐 / 教育 / 法务 / 运筹 / 数据库 / 图表 / 时间）──
  {
    title: '用 SQL 沙箱建一张图书馆借阅表，查出逾期最久的读者并给出罚金明细',
    text: '用 execute_sql 建表 books(id,title,author)、members(id,name)、loans(id,book_id,member_id,borrowed_on,due_on,returned_on)。插入 6 本书、4 位读者、10 条借阅（其中 4 条逾期未还，日期用 2026-09 月份）。写查询：① 每位读者当前在借数；② 逾期天数最多的三条借阅（以 2026-10-06 计）；③ 按每天 0.5 元算罚金并按读者汇总。把三段 SQL 与结果整理成表格，最后用 write_file 把建表 + 查询语句存为 files/library.sql。',
  },
  {
    title: '用 Mermaid 画出一次 HTTPS 握手的时序图，并逐步标注每条消息的作用',
    text: '用 render_mermaid 画 TLS 1.3 握手时序图：参与者 Client / Server；消息依次 ClientHello（含 key_share、supported_versions）、ServerHello、EncryptedExtensions、Certificate、CertificateVerify、Finished、Client Finished、Application Data。每条消息用 note 标注一句作用（≤ 20 字）。图渲染出来后，再用 3–5 句话解释 1.3 相比 1.2 为什么少了一个往返，以及 0-RTT 的风险是什么。',
  },
  {
    title: '模拟孟德尔双因子杂交：用 Python 跑一万次随机配子，验证 9:3:3:1',
    text: '用 Python 沙箱模拟豌豆双杂合子 YyRr × YyRr：随机生成配子组合 10000 次，统计四种表型（黄圆 / 黄皱 / 绿圆 / 绿皱）的计数与比例，与理论 9:3:3:1 比较，并做一次卡方检验（手写公式，不用 scipy）给出 χ² 与自由度 3 下是否显著（临界值 7.815）。用 Markdown 表格列出观察值 / 期望值 / 贡献项，最后把结果写入 files/mendel.csv。',
  },
  {
    title: '做一份房贷对比：等额本息与等额本金 30 年总利息差多少，画出月供曲线',
    text: '贷款 200 万元，年利率 3.6%，期限 30 年。用 JavaScript 分别计算等额本息与等额本金：首月月供、末月月供、总利息，以及两者总利息之差。再生成前 360 期的月供序列，用 :::chart 快捷语法画两条月供曲线。最后用 3 句话说明：如果计划第 8 年提前还清，哪种方式更划算，差额大约多少。注意：这是数学演算，不构成投资建议。',
  },
  {
    title: '把一段英文摘要做成词频与可读性报告：Flesch 分数、最长句、生僻词',
    text: '把下面这段写入 files/abstract.txt：「Large language models can call tools to extend their capabilities. However, orchestrating many tools reliably remains difficult. We present a scheduler that groups independent calls into waves and bounds concurrency per category.」用 JavaScript 统计：总词数、句数、平均句长、音节数（用简单元音组计数法），算 Flesch Reading Ease；列出最长的句子与所有 ≥ 10 个字母的词。用 text_tool 做一次大小写无关的词频 Top 10。输出一份简短可读性报告。',
  },
  {
    title: '用 Haversine 公式算出大阪到东京、札幌、那霸的距离，并按远近排好',
    text: '用 JavaScript 实现 Haversine 公式（地球半径 6371 km）。坐标：大阪 34.6937,135.5023；东京 35.6762,139.6503；札幌 43.0618,141.3545；那霸 26.2124,127.6809。算出大阪到另外三城的大圆距离（保留 1 位小数），按远近排序，并估算新干线 / 飞机大致用时（新干线按 250 km/h、飞机按 800 km/h + 1 小时地面时间粗估）。把结果写成 Markdown 表，并用 convert_units 把最远一程换算成英里。',
  },
  {
    title: '生成 C 大调下的和弦进行 I–V–vi–IV 的音名与频率表，再写一首 8 小节旋律',
    text: '用 JavaScript 按十二平均律（A4 = 440 Hz）算出 C4–C5 各音的频率。列出 C 大调 I–V–vi–IV（C、G、Am、F）每个和弦的组成音与频率。再随机但受约束地生成一段 8 小节 4/4 的旋律：每小节 4 个四分音符，音只能取当前小节和弦的和弦内音或级进经过音，起止都落在 C。输出为「小节 | 和弦 | 四个音名」表格，并把旋律写成简单 JSON（files/melody.json：数组 of {bar, chord, notes, hz}）。',
  },
  {
    title: '用 Python 数值求解单摆运动，比较小角近似与真实周期在 10°–90° 的误差',
    text: '用 Python 沙箱（numpy 可装）对单摆 θ″ = −(g/L)·sin θ 做四阶龙格–库塔积分：L = 1 m，g = 9.81，初始角速度 0，初始角 10°、30°、60°、90°，步长 1 ms，积一个完整周期。从过零点测出真实周期，与小角近似 T = 2π√(L/g) 比较，给出相对误差表。再把 90° 的 θ(t) 前 2 秒用 :::chart 折线画出来。最后两句话解释为什么振幅越大周期越长。',
  },
  {
    title: '设计一周 5 天的中学课程表：6 个班、8 位老师、不冲突，用约束求解器思路',
    text: '用 JavaScript 写一个带回溯的课程表求解器：5 天 × 6 节，6 个班（A–F），科目与周课时：语文 5、数学 5、英语 4、物理 3、化学 3、历史 2、地理 2、体育 2、美术 2、自习 2。8 位老师，各教 1–2 门，每位老师同一节只能在一个班；每班每天同一科不超过 2 节；体育不排第 1 节。输出：是否找到解、回溯次数、A 班与 D 班的完整课表（Markdown 表），并把全部课表写入 files/timetable.json。',
  },
  {
    title: '把一份用户协议里的关键条款抽成结构化清单：期限、违约、争议解决、单方变更',
    text: '把下面条款写入 files/terms.txt：「本协议自用户点击同意起生效，有效期一年，期满自动续展。用户违反第 3 条的，平台有权立即终止服务且不退还费用。因本协议产生的争议，双方应友好协商；协商不成的，提交平台所在地有管辖权的人民法院诉讼解决。平台有权在提前 7 日公告后修改本协议。」用 regex 与 json_tool 抽成 JSON：生效条件、期限、续展、违约后果、争议解决（方式 + 管辖）、单方变更（通知期）。再用三句话指出其中对用户最不利的两处，并说明本回答不构成法律意见。',
  },
  {
    title: '用 CSV 工具清洗一份带脏数据的问卷：去重、统一日期、把年龄分桶出直方图',
    text: '用 write_file 写入 files/survey.csv，12 行：列 id,name,age,joined,city，故意混入 2 行重复 id、年龄字段有「25岁」「三十」「-1」、日期有「2026/9/3」「3 Sep 2026」「2026-09-03」三种写法、城市大小写不一。用 data_tool（kind=csv）+ JavaScript：去重（保留首次）、年龄解析为整数并剔除非法、日期统一为 ISO、城市首字母大写。输出清洗日志（每条改动一行）与清洗后的 files/survey.clean.csv；再按年龄分桶（<20、20–29、30–39、≥40）用 :::chart 柱状图画直方图。',
  },
  {
    title: '算出 2026 年剩余的每个月第二个星期二，并生成一个可导入的 ICS 日程文件',
    text: '用 data_tool（kind=date）与 JavaScript 配合：从 2026-10-06 起到年底，找出每个月的第二个星期二（10/11/12 月），同时给出距今天的天数。再写一个 iCalendar 文件 files/patch-tuesday.ics：每个日期一个 VEVENT（SUMMARY「补丁星期二 · 例行更新」，10:00–11:00，TZID=Asia/Tokyo，UID 唯一，DTSTAMP 取当前时间）。最后用 text_tool（action=regex）校验文件里 DTSTART 的格式全部是 YYYYMMDDTHHMMSS，并告诉我校验结果。',
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
