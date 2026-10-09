// ─── 按需挂载规则正文（Capability Registry 的附表）· Dubhe Helix 3.0 ────────────────
// 由 capabilities.js 读取并过滤（只保留登记为非核心的工具）。规则刻意保守——宁可多挂一个，也不要让该用的工具缺席
// （缺席时模型仍可点名调用，内核会当场挂载，见 toolrunner 的「本轮未启用」回执）。
// 命中任一 text 正则 / 附件类型即挂载；exclude 命中则不挂（例如纯口算不挂 data_tool）。
// 改这里会改变 p2-eval 的 tool_misselect_rate / tool_miss_rate，改完要跑 node tests/p2-eval.mjs。

export const TOOL_MOUNT_RULES_SOURCE = Object.freeze({
  get_current_time: { text: /现在(?:几点|是几号|时间|日期)|当前时间|几点|今天|明天|昨天|这周|本周|上周|这个月|本月|今年|日期|星期|周几|几号|\bnow\b|\btoday\b|\btime\b|\bdate\b/i },
  get_browser_environment: { text: /浏览器|运行环境|user.?agent|分辨率|时区|语言设置|\bbrowser\b|\benvironment\b|\bplatform\b/i },
  generate_image: { text: /画(?:一|个|张|幅|出)|生成.{0,8}(?:图片|照片|插画|海报|头像|logo|封面|壁纸)|生图|文生图|插画|海报|\bimage\b|\bpicture\b|\billustration\b|\bposter\b|\bdraw\b|\blogo\b/i, exclude: /折线图|柱状图|饼图|散点图|图表|流程图|架构图|时序图|思维导图|关系图|类图|状态图|甘特图|依赖图|拓扑/i },
  analyze_video: { text: /视频|影片|\bvideo\b|\.mp4\b|\.webm\b|\.mov\b/i, attachments: ['video'] },
  analyze_pdf: { text: /\bpdf\b|论文|扫描件/i, attachments: ['pdf'] },
  zip_files: { text: /压缩|打包|\bzip\b|归档|\barchive\b/i, attachments: ['zip'] },
  unzip_file: { text: /解压|\bunzip\b|\bextract\b|压缩包|打开.{0,4}zip/i, attachments: ['zip'] },
  crawl_site: { text: /爬(?:取|虫|一下)|抓取.{0,6}(?:站|网站|整站|文档|所有页)|整站|\bcrawl\b|站点地图|\bsitemap\b|多页/i },
  download_file: { text: /下载|拉取|\bdownload\b|保存.{0,6}(?:到沙箱|文件)|另存/i },
  screenshot_web: { text: /截图|截屏|截一?张|屏幕快照|\bscreenshot\b|看看.{0,8}(?:页面|网页|网站|首页)|长什么样|版式/i },
  run_git: { text: /\bgit\b|提交|\bcommit\b|分支|\bbranch\b|仓库|\brepo\b|版本库|\bmerge\b|\brebase\b/i },
  search_files: { text: /搜索|查找|搜一下|找出|找到|找一下|\bgrep\b|全文检索|\bsearch\b|出现在哪|引用|日志|\blogs?\b/i },
  diff_text: { text: /\bdiff\b|对比.{0,8}(?:文件|文本|两段|两份|版本|输出|结果)|(?:文件|文本|版本|输出|结果).{0,8}(?:差异|区别|对比)|逐行比较|改了什么|变更了什么/i },
  json_tool: { text: /\bjson\b|配置|\byaml\b|\btoml\b|字段|\bkey\b|键值|反序列化|\bparse\b|格式化.{0,4}(?:一下|输出|配置)/i },
  remember: { text: /记住|记一下|记下来|别忘了|记忆|忘记|忘掉|\bforget\b|\bremember\b|我的偏好|以后都|以后一律|下次/i },
  evaluate_expression: { text: /计算|算一下|算出|等于多少|是多少|多少钱|求值|表达式|推导|验算|\d\s*[+\-*/^×÷%]\s*\d|\bsqrt\b|\bsin\b|\bcos\b|\btan\b|\blog\b|阶乘|开方|平方|次方|百分之|利率|复利|\bmath\b/i },
  text_tool: { text: /正则|\bregex\b|\bregexp\b|哈希|\bhash\b|\bmd5\b|\bsha\d*\b|\bcrc\b|校验和|指纹|base64|\bhex\b|编码|解码|转码|\buuid\b|\bjwt\b|\bunicode\b|码位|字数|词数|词频|大小写|驼峰|下划线命名|去重|排序|转义|文本|替换|抽取|提取|统计.{0,4}(?:字|词|行)|邮箱|网址|链接|占位文|\blorem\b|截断|折行|日志|\blogs?\b/i },
  data_tool: { text: /\bcsv\b|\btsv\b|表格|数据|整理成表|制表|列名|按列|每列|行数|聚合|分组|日期|天数|工作日|星期|周几|几号|多少天|还有.{0,4}天|倒计时|年龄|时长|时间差|单位|换算|公里|英里|千米|公斤|英镑|磅|斤|摄氏|华氏|\bkg\b|\bkm\b|\bmile|\bgib?\b|\bmbps\b|油耗|二维码|\bqr\b|\bwifi\b|名片|\bvcard\b/i, attachments: ['csv'] },
  execute_sql: { text: /\bsql\b|sqlite|数据库|建表|查询语句|\bselect\b.*\bfrom\b|\bjoin\b|索引|\bwhere\b|\btable\b|\b(?:drop|create|alter|insert|update|delete)\s+(?:table|into|from|index)\b/i },
  render_mermaid: { text: /流程图|时序图|架构图|类图|状态图|甘特图|\bmermaid\b|泳道|\bsequence\b|\bflowchart\b|用图表示|画.{0,6}(?:流程|架构|结构|关系)/i },
  render_dot: { text: /\bgraphviz\b|\bdot\b|有向图|依赖图|关系图|拓扑|调用图|\bdigraph\b|节点.{0,6}边/i },
});
