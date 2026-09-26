// ─── Agent 工具集：定义 + 执行调度 ─────────────────────────────────────
import { runJavaScript, runPython, runCpp, pythonAvailable } from './sandbox.js';
import { generateImage, editImage, bytesToDataUrl, sniffImage } from './api.js';
import { analyzeImage, VISION_TOOL_MODEL } from './vision.js';
import { SUBAGENTS } from './subagents.js';
import { DEFAULT_IMAGE_MODEL, IMAGE_SIZES, IMAGE_QUALITIES, IMAGE_FORMATS, IMAGE_BACKGROUNDS, IMAGE_MODEL_IDS, resolveImageModel } from './config.js';
import { fetchPage, gitRun } from './net.js';
import { createZip, fileBytesFromValue } from './zip.js';
import { unpackZip, unpackZipFromDataUrl } from './unzip.js';
import { runRegex, runHash, runCodec, runUnicode } from './codetools.js';

export const TOOL_DEFS = [
  {
    name: 'execute_javascript',
    description: '在隔离的 Web Worker 沙箱中执行 JavaScript 代码（支持顶层 await）。沙箱提供 console（输出被捕获）和 files 对象（虚拟文件系统的键值快照，读写字典即可增改文件）。代码必须完整可运行，不要省略实现。return 值或最后一个表达式作为结果返回。适合数学计算、数据处理、算法验证。',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '要执行的 JavaScript 代码' },
      },
      required: ['code'],
    },
  },
  {
    name: 'execute_python',
    description: '在 Pyodide（WebAssembly Python 3）沙箱中执行 Python 代码。提供 FILES 字典（虚拟文件系统）。print 输出会被捕获；将最终结果赋给全局变量 result 可被返回。code 必须完整可运行，不要省略实现。可用 micropip / loadPackage 安装第三方库（numpy、pandas 等），已装库名会记在本机，刷新页面后自动重装。运行时常驻，仅会话首次调用需下载（约 10-30 秒）。',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '要执行的 Python 代码' },
        packages: { type: 'array', items: { type: 'string' }, description: '可选：先安装的 PyPI / Pyodide 包名，如 ["numpy","pandas"]。代码里的 import 也会自动尝试安装。' },
      },
      required: ['code'],
    },
  },
  {
    name: 'execute_cpp',
    description: '编译并执行 C++ 代码（通过 Compiler Explorer 公共服务远程执行：g++ -O2 -std=c++20）。代码需包含 main 函数；stdout/stderr 与退出码会被捕获。注意：远程服务，需数秒网络往返；不能访问虚拟文件系统；适合算法验证与性能测试。',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '完整的 C++ 程序（含 #include 与 main）' },
      },
      required: ['code'],
    },
  },
  {
    name: 'write_file',
    description: '向会话虚拟文件系统写入文本。mode=overwrite（默认整文件覆盖）、append（末尾追加）、replace（把 old_text 换成 new_text，局部修改）。文件对沙箱代码可见。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，如 data/notes.md' },
        content: { type: 'string', description: 'overwrite/append 时的内容；replace 时可用 new_text 代替' },
        mode: { type: 'string', enum: ['overwrite', 'append', 'replace'], description: 'overwrite 覆盖整文件（默认）；append 追加；replace 局部替换' },
        old_text: { type: 'string', description: 'replace 模式：要被替换的原文片段' },
        new_text: { type: 'string', description: 'replace 模式：替换后的新片段' },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_file',
    description: '读取会话虚拟文件系统中的文本文件内容。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '文件路径' } },
      required: ['path'],
    },
  },
  {
    name: 'list_files',
    description: '列出会话虚拟文件系统中的所有文件及其大小。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_current_time',
    description: '获取当前日期时间（默认 Asia/Shanghai 时区）。',
    parameters: {
      type: 'object',
      properties: { timezone: { type: 'string', description: 'IANA 时区名，如 Asia/Tokyo，缺省为 Asia/Shanghai' } },
    },
  },
  {
    name: 'regex',
    description:
      '在本地用 JavaScript 正则处理文本（无需沙箱）。action=match 列出全部匹配与捕获组/命名组及偏移；test 只判断是否匹配；replace 替换（支持 $1 $& $<name>）；split 分割；explain 解释 pattern。' +
      'flags 为 JS 正则标志（gimsuvyd）。Unicode 属性如 \\p{L}、\\p{Script=Han} 需带 u 或 v。text 或 path（沙箱文件）二选一。写正则、抽字段、改文本时用本工具，不要口算。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['match', 'test', 'replace', 'split', 'explain'], description: '默认 match' },
        pattern: { type: 'string', description: '正则源码，不要写成 /foo/g 这种字面量，flags 单独传' },
        flags: { type: 'string', description: 'g i m s u v y d 的组合，可空' },
        text: { type: 'string', description: '待处理文本' },
        path: { type: 'string', description: '可选：从沙箱读取文本，代替 text' },
        replacement: { type: 'string', description: 'replace 时的替换串' },
        limit: { type: 'integer', description: '最多返回多少处匹配，默认 250' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'hash',
    description: '计算哈希/校验和（本地，无需沙箱）：md5 / sha1 / sha256 / sha384 / sha512 / crc32。text 或 path（沙箱文件；图片 data URL 按原字节）。安全场景用 sha256。',
    parameters: {
      type: 'object',
      properties: {
        algorithm: { type: 'string', enum: ['md5', 'sha1', 'sha256', 'sha384', 'sha512', 'crc32'], description: '默认 sha256' },
        text: { type: 'string', description: '要哈希的文本（UTF-8）' },
        path: { type: 'string', description: '可选：哈希沙箱文件字节' },
      },
    },
  },
  {
    name: 'codec',
    description:
      '本地编解码：base64 / base64url / hex / url（percent-encoding）/ html 实体；action=encode 或 decode。' +
      'action=uuid 生成 UUID v4。format=jwt 且 decode 时拆 JWT header/payload（不校验签名）。不要为这些小事去开沙箱。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['encode', 'decode', 'uuid'], description: '默认 encode' },
        format: { type: 'string', enum: ['base64', 'base64url', 'hex', 'url', 'html', 'jwt'], description: '默认 base64；uuid 动作可省略' },
        text: { type: 'string', description: '输入文本' },
        path: { type: 'string', description: '可选：从沙箱读入' },
      },
    },
  },
  {
    name: 'unicode',
    description:
      '查询/转换 Unicode：inspect 逐码位给出 U+XXXX、UTF-8、General_Category、Script、区块提示；from_codes 把 U+XXXX / 0xNN / 十进制码位拼成字符串；normalize（NFC/NFD/NFKC/NFKD）；escape / unescape（\\u / \\u{…}）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['inspect', 'from_codes', 'normalize', 'escape', 'unescape'], description: '默认 inspect' },
        text: { type: 'string', description: '待分析或转换的文本；from_codes 也可把码位写在这里' },
        path: { type: 'string', description: '可选：从沙箱读入' },
        form: { type: 'string', enum: ['NFC', 'NFD', 'NFKC', 'NFKD'], description: 'normalize 时的正规化形式，默认 NFC' },
        codes: { type: 'string', description: 'from_codes 的码位串，如 U+4F60 0x41 128512' },
      },
    },
  },
  {
    name: 'generate_image',
    description:
      '调用文生图模型生成图片。不要传 model：一律用用户在模型菜单选定的生图模型（会话 runtime 会写明当前 ID）。' +
      'GPT Image 走 POST /v1/images/generations；给了 reference_paths 则走 /v1/images/edits。' +
      'gemini-3.1-flash-image（Nano Banana 2）走 Gemini 原生 generateContent，不要发到 /v1/images/*。' +
      '若传入 reference_paths（沙箱内图片路径，如用户附件 uploads/xx.png），则进入「图片编辑」模式，按 prompt 指令修改原图。' +
      '结果以 data URL 写入沙箱 outputs/ 目录（可下载/打包/继续编辑），并在对话中直接展示。' +
      '生图耗时较长（实测 30–65 秒，超时上限 300 秒）。需要出图时请调用本工具，不要只用文字描述画面。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '画面描述（生成模式）或修改指令（编辑模式），如「一只在键盘上打字的橘猫，插画风格」' },
        reference_paths: { type: 'array', items: { type: 'string' }, description: '可选：沙箱内参考图路径数组（如 ["uploads/cat.png"]）；提供即进入编辑模式' },
        size: { type: 'string', enum: IMAGE_SIZES, description: `输出尺寸（宽x高像素），默认 ${'auto'} 由模型决定` },
        quality: { type: 'string', enum: IMAGE_QUALITIES, description: '质量档位，默认 auto' },
        output_format: { type: 'string', enum: IMAGE_FORMATS, description: '输出格式，默认 png' },
        background: { type: 'string', enum: IMAGE_BACKGROUNDS, description: '背景：transparent 为透明底（png/webp 有效），默认 auto 由模型决定' },
        n: { type: 'integer', enum: [1, 2, 3, 4], description: '一次生成几张候选图（默认 1）；多张会全部写入沙箱 outputs/' },
        model: {
          type: 'string',
          enum: IMAGE_MODEL_IDS,
          description: `不要传。生图模型由用户在菜单选定（runtime 里的「生图模型」）。若仍传入，会被忽略并改用会话选定值。可选 ID 仅供识别：${IMAGE_MODEL_IDS.join(' / ')}（不要传「2.5 Sunburst」这类显示名）`,
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'analyze_image',
    description:
      '分析一张图片（OCR、描述画面、读图表）。对话模型本身是纯文本，不能直接看图：必须调用本工具。' +
      `内部固定使用 ${VISION_TOOL_MODEL}，不要把该模型当对话模型选。` +
      'path 指向沙箱内图片（用户附件在 uploads/，生图在 outputs/）；也可以不传 path 而分析用户本轮刚上传的图。' +
      '返回完整识别结果（不会截成摘要）；全文同时写入沙箱同名 .ocr.md，可用 read_file 再读。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '沙箱图片路径，如 uploads/photo.png 或 outputs/image-001.png' },
        prompt: { type: 'string', description: '分析要求，如「读出图中全部文字」或「描述这张架构图」；缺省为全面描述' },
      },
    },
  },
  {
    name: 'zip_files',
    description: '把沙箱文件打成 ZIP 写入虚拟文件系统（STORE 容器，图片保持原字节）。paths 省略则打包全部文件。用户要压缩/打包时用这个，不要只口述。',
    parameters: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: '要打包的沙箱路径；省略=全部' },
        out: { type: 'string', description: '输出路径，默认 archives/bundle.zip' },
      },
    },
  },
  {
    name: 'unzip_file',
    description: '解压沙箱中的 ZIP 到目标目录（支持 STORE 与 DEFLATE）。用户上传的 .zip 也会自动解到 uploads/。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'ZIP 路径，如 uploads/src.zip 或 archives/bundle.zip' },
        dest: { type: 'string', description: '解压目录，默认 extracted/' },
      },
      required: ['path'],
    },
  },
  {
    name: 'fetch_url',
    description:
      '抓取一个 http(s) 网址并转成正文文本（或原始 HTML）。用于读文档、CHANGELOG、issue、API 响应。' +
      '长内容会自动写入沙箱 web/ 目录（可用 read_file 续读，也能交给子智能体），返回值给前 6000 字符预览。' +
      '本工具只走本地中继（server.py 的 /api/fetch）：页面抓取需要服务端发请求，浏览器 CSP 与目标站点的 CORS 都不允许直连。' +
      '中继没在跑时会直接返回原因，此时请让用户启动中继，或用联网搜索（顶栏「联网」开关，走模型 API 自带格式）替代。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '完整网址（含 http:// 或 https://）' },
        mode: { type: 'string', enum: ['text', 'raw'], description: 'text=去标签正文（默认）；raw=原始 HTML/JSON（自己做正则/解析时用）' },
        max_bytes: { type: 'integer', description: '最多抓取字节数，默认 2000000，上限 4000000' },
        save_path: { type: 'string', description: '可选：把全文写到沙箱的指定路径（默认 web/<host>/<slug>.md）' },
      },
      required: ['url'],
    },
  },
  {
    name: 'run_git',
    description:
      '在本机工作区（server.py 所在目录的 ./workspace/）里执行 git 命令：可 clone/pull 仓库、status/diff/log 查看、' +
      'add/commit 提交，也可 push（凭据由本机 git 配置提供，网站不接触）。服务端只允许 git 子命令白名单，' +
      '不经过 shell，因此不能拼接管道或重定向。需要静态托管环境无法执行外部程序时，工具会明确说明并提示启动本地中继。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '完整 git 命令，如 "git clone https://github.com/x/y.git" 或 "git log --oneline -5"' },
        repo: { type: 'string', description: '可选：workspace 下的子目录名（仓库目录），默认在 workspace 根执行' },
        timeout_sec: { type: 'integer', description: '超时秒数，默认 25，最大 120' },
      },
      required: ['command'],
    },
  },
  {
    name: 'dispatch_subagent',
    description:
      '把专业任务委派给子智能体（同模型、专属系统提示词与工具子集，独立上下文），无需用户点名即可调用。' +
      '子智能体看不到对话历史，task 必须自包含（附必要代码/数据/上下文）。返回其文字报告，由你整合后答复。' +
      '互不依赖的子任务可以在同一轮里一次发出多个调用并行委派。完整名录与适用场景见系统提示词的「子智能体委派」一节。',
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: SUBAGENTS.map((a) => a.id), description: '子智能体 ID' },
        task: { type: 'string', description: '自包含的任务描述（含必要上下文、代码、数据与期望产出格式）' },
      },
      required: ['agent', 'task'],
    },
  },
];

// 真正需要「沙箱开关」的只有代码执行（浏览器内 WASM/Worker 与远程编译器）；
// 文件、生图、时间、子智能体委派都不执行任意代码，关闭沙箱时也应可用 ——
// 否则「让 Agent 更自主地委派子智能体」会被一个无关开关掐断。
export const CODE_TOOL_NAMES = ['execute_javascript', 'execute_python', 'execute_cpp'];

/** 按沙箱开关给出本轮可用的工具定义列表（纯过滤，不改原数组） */
export function toolsFor(sandboxEnabled) {
  if (sandboxEnabled) return TOOL_DEFS;
  return TOOL_DEFS.filter((t) => !CODE_TOOL_NAMES.includes(t.name));
}

// 模型给的沙箱路径经常带前导 '/' 或 './'，直接当字典键就会分裂成两套目录树
// （/data/a.md 与 data/a.md 是两个键）。这里归一，非法路径返回 ''（由调用方反馈纠错）。
export function normalizeFsPath(p) {
  const parts = String(p == null ? '' : p).trim().split('/').map((s) => s.trim()).filter((s) => s && s !== '.');
  if (!parts.length || parts.includes('..') || /[\u0000-\u001f]/.test(parts.join('/'))) return '';
  return parts.join('/');
}

function readToolText(args, fs) {
  if (args && args.path) {
    const p = normalizeFsPath(args.path);
    if (!p) return { error: '非法 path' };
    try { return { text: String(fs.read(p)), label: p }; }
    catch { return { error: `沙箱中找不到 ${args.path}` }; }
  }
  return { text: args && args.text != null ? String(args.text) : '', label: 'text' };
}

// 执行工具并返回字符串结果（会回填进对话）；onUi 用于驱动沙箱面板
export async function executeTool(name, args, ctx) {
  const { fs, onUi } = ctx;
  const emit = (patch) => onUi && onUi({ name, args, ...patch });
  // 兜底防线：工具列表按开关过滤过，但缓存错配或旧上下文里的工具调用仍可能打进来
  if (ctx.sandboxEnabled === false && CODE_TOOL_NAMES.includes(name)) {
    emit({ status: 'error', error: { message: '代码沙箱已关闭' } });
    return `沙箱已关闭，${name} 未执行。请让用户打开「沙箱」开关，或改用 read_file / write_file / dispatch_subagent。`;
  }

  try {
    switch (name) {
      case 'execute_javascript': {
        emit({ status: 'running', lang: 'javascript' });
        const out = await runJavaScript(args.code || '', fs);
        emit({ status: out.ok ? 'ok' : 'error', lang: 'javascript', logs: out.logs, result: out.result, error: out.error, durationMs: out.durationMs, timedOut: out.timedOut });
        return formatExecResult('JavaScript', out);
      }
      case 'execute_python': {
        if (!pythonAvailable()) {
          const msg = 'Python 沙箱不可用（Pyodide CDN 加载失败），请改用 execute_javascript。';
          emit({ status: 'error', lang: 'python', error: { message: msg } });
          return msg;
        }
        emit({ status: 'running', lang: 'python', note: '执行中…' });
        const extraPkgs = Array.isArray(args.packages) ? args.packages.map((p) => String(p || '').trim()).filter(Boolean) : [];
        const out = await runPython(args.code || '', fs, (note) => emit({ status: 'running', lang: 'python', note }), extraPkgs);
        emit({ status: out.ok ? 'ok' : 'error', lang: 'python', logs: out.logs, result: out.result, error: out.error, durationMs: out.durationMs, timedOut: out.timedOut });
        return formatExecResult('Python', out);
      }
      case 'execute_cpp': {
        emit({ status: 'running', lang: 'cpp', note: '远程编译执行中…' });
        const out = await runCpp(args.code || '');
        emit({ status: out.ok ? 'ok' : 'error', lang: 'cpp', logs: out.logs, error: out.error, durationMs: out.durationMs });
        return formatExecResult('C++', out);
      }
      case 'write_file': {
        // 路径缺失/非法要在本地挡掉：否则沙箱里会凭空多出「undefined」这种文件，
        // 而且模型收到「已写入 undefined」还以为成功了（附件同名冲突逻辑也依赖真实路径）
        const path = normalizeFsPath(args.path);
        if (!path) return 'write_file 缺少合法的 path 参数（需要形如 data/notes.md 的相对路径，不能是空值或 "/"）。';
        const content = String(args.content ?? '');
        const mode = String(args.mode || 'overwrite').toLowerCase();
        let msg;
        if (mode === 'append') {
          let prev = '';
          try { prev = fs.read(path); } catch { prev = ''; }
          fs.write(path, prev + content);
          msg = `已追加 ${path}（+${content.length} 字符，现 ${prev.length + content.length} 字符）`;
        } else if (mode === 'replace') {
          const oldText = String(args.old_text ?? '');
          const newText = args.new_text != null ? String(args.new_text) : content;
          if (!oldText) return 'write_file replace 模式需要 old_text（要被替换的原文片段）。';
          let prev;
          try { prev = fs.read(path); } catch { return `write_file replace 失败：文件不存在 ${path}`; }
          if (!prev.includes(oldText)) return `write_file replace 失败：在 ${path} 中找不到指定片段。`;
          const next = prev.replace(oldText, newText);
          fs.write(path, next);
          msg = `已局部修改 ${path}（${prev.length} → ${next.length} 字符）`;
        } else {
          fs.write(path, content);
          msg = `已写入 ${path}（${content.length} 字符）`;
        }
        emit({ status: 'ok', fsChange: true, editedPath: path, note: msg });
        return msg;
      }
      case 'read_file': {
        const path = normalizeFsPath(args.path);
        if (!path) return 'read_file 缺少合法的 path 参数。可用 list_files 查看现有文件。';
        const content = fs.read(path);
        emit({ status: 'ok', fsChange: false, note: `读取 ${path}` });
        return `── ${path} ──\n${content}`;
      }
      case 'list_files': {
        const list = fs.list();
        const msg = list.length ? list.map((f) => `${f.path} (${f.size} B)`).join('\n') : '（文件系统为空）';
        emit({ status: 'ok', fsChange: false, note: '列出文件' });
        return msg;
      }
      case 'get_current_time': {
        const tz = args.timezone || 'Asia/Shanghai';
        const msg = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'full', timeStyle: 'long', timeZone: tz }).format(new Date()) + ` (${tz})`;
        emit({ status: 'ok', note: msg });
        return msg;
      }
      case 'regex': {
        emit({ status: 'running', note: '正则…' });
        const src = readToolText(args, fs);
        if (src.error) { emit({ status: 'error', error: { message: src.error } }); return src.error; }
        const out = runRegex({ ...args, text: src.text });
        emit({ status: out.ok ? 'ok' : 'error', note: out.ok ? '正则完成' : out.error, error: out.ok ? undefined : { message: out.error } });
        return out.text;
      }
      case 'hash': {
        emit({ status: 'running', note: `哈希 ${args.algorithm || 'sha256'}…` });
        let bytes; let label = '';
        if (args.path) {
          const p = normalizeFsPath(args.path);
          if (!p) { emit({ status: 'error', error: { message: '非法 path' } }); return 'hash：非法 path'; }
          let val;
          try { val = fs.read(p); } catch { emit({ status: 'error', error: { message: `找不到 ${args.path}` } }); return `hash：沙箱中找不到 ${args.path}`; }
          bytes = fileBytesFromValue(val).bytes;
          label = p;
        } else {
          bytes = new TextEncoder().encode(String(args.text == null ? '' : args.text));
        }
        const out = await runHash({ algorithm: args.algorithm, bytes, label });
        emit({ status: out.ok ? 'ok' : 'error', note: out.ok ? '哈希完成' : out.error, error: out.ok ? undefined : { message: out.error } });
        return out.text;
      }
      case 'codec': {
        emit({ status: 'running', note: `codec ${args.action || 'encode'}…` });
        let text = args.text;
        if (args.path && args.action !== 'uuid') {
          const src = readToolText(args, fs);
          if (src.error) { emit({ status: 'error', error: { message: src.error } }); return src.error; }
          text = src.text;
        }
        const out = runCodec({ ...args, text });
        emit({ status: out.ok ? 'ok' : 'error', note: out.ok ? '编解码完成' : out.error, error: out.ok ? undefined : { message: out.error } });
        return out.text;
      }
      case 'unicode': {
        emit({ status: 'running', note: 'Unicode…' });
        let text = args.text;
        if (args.path) {
          const src = readToolText(args, fs);
          if (src.error) { emit({ status: 'error', error: { message: src.error } }); return src.error; }
          text = src.text;
        }
        const out = runUnicode({ ...args, text });
        emit({ status: out.ok ? 'ok' : 'error', note: out.ok ? 'Unicode 完成' : out.error, error: out.ok ? undefined : { message: out.error } });
        return out.text;
      }
      case 'fetch_url': {
        emit({ status: 'running', note: `抓取 ${String(args.url || '').slice(0, 50)}` });
        const r = await fetchPage({
          url: args.url, mode: args.mode, maxBytes: args.max_bytes, signal: ctx.signal, fs,
          // 模型指定的落盘路径同样要过路径归一（防 ../ 跑出沙箱语义、吃掉绝对路径）
          savePath: args.save_path ? normalizeFsPath(args.save_path) : '',
        });
        if (!r.ok) {
          emit({ status: 'error', error: { message: r.error } });
          return `fetch_url 失败：${r.error}`;
        }
        emit({ status: 'ok', fsChange: !!r.savedTo, note: `${r.status || ''} ${(r.chars / 1024).toFixed(1)}K${r.savedTo ? ` → ${r.savedTo}` : ''}` });
        return `[抓取完成] ${r.url}（HTTP ${r.status || '?'} · ${r.contentType || '未知类型'} · ${r.chars} 字符${r.savedTo ? ` · 全文已存 ${r.savedTo}` : ''}）${r.note ? `\n说明：${r.note}` : ''}\n\n${r.preview}`;
      }
      case 'run_git': {
        emit({ status: 'running', note: String(args.command || 'git').slice(0, 46) });
        const r = await gitRun({ command: args.command, repo: args.repo, timeoutSec: args.timeout_sec, signal: ctx.signal });
        if (!r.ok) {
          const msg = r.error || `git 退出码 ${r.code}\n${r.text}`;
          emit({ status: 'error', error: { message: String(msg).slice(0, 300) } });
          return r.error ? `run_git 失败：${r.error}` : `[git 退出码 ${r.code}]（${r.cwd || 'workspace'}）\n${r.text}${r.note ? `\n${r.note}` : ''}`;
        }
        emit({ status: 'ok', note: `git 完成（${(r.text || '').length} 字符）` });
        const body = r.text.length > 8000 ? `${r.text.slice(0, 6000)}\n…（git 输出过长，中间省略 ${r.text.length - 7000} 字符；可加 --oneline/-n 限制）\n${r.text.slice(-1000)}` : r.text;
        return `[git] ${String(args.command).slice(0, 120)}\n目录：${r.cwd || 'workspace'} · 退出码 0${r.note ? ` · ${r.note}` : ''}\n\n${body}`;
      }
      case 'dispatch_subagent': {
        if (ctx.allowDispatch === false) {
          return '当前思考级别不是 Max/Ultra，不能委派子智能体。请用户把「思考」调到 Max 或 Ultra，或由你直接回答。';
        }
        if (!ctx.dispatch) return '子智能体调度器不可用。';
        emit({ status: 'running', note: `子智能体 ${args.agent} 执行中…` });
        const report = await ctx.dispatch(args.agent, args.task || '', (note) => emit({ status: 'running', note }));
        emit({ status: 'ok', note: '报告已返回' });
        return report;
      }
      case 'generate_image': {
        if (!ctx.apiKey) {
          emit({ status: 'error', error: { message: '未配置 API Key' } });
          return '未配置 TeamoRouter API Key，无法调用图像模型。';
        }
        const prompt = String(args.prompt || '').trim();
        if (!prompt) return 'generate_image 缺少 prompt 参数。';
        // 会话菜单选定的生图模型优先：对话模型常在 args.model 里填 gpt-image-2，
        // 会把用户刚选的 Nano Banana 盖掉。args.model 只作纠错提示，不覆盖菜单。
        const session = resolveImageModel(ctx.imageModel || DEFAULT_IMAGE_MODEL, DEFAULT_IMAGE_MODEL);
        const model = session.id;
        const format = IMAGE_FORMATS.includes(args.output_format) ? args.output_format : 'png';
        const size = IMAGE_SIZES.includes(args.size) ? args.size : 'auto';
        const quality = IMAGE_QUALITIES.includes(args.quality) ? args.quality : 'auto';
        const background = IMAGE_BACKGROUNDS.includes(args.background) ? args.background : 'auto';
        const count = [1, 2, 3, 4].includes(Number(args.n)) ? Number(args.n) : 1;
        const refs = (Array.isArray(args.reference_paths) ? args.reference_paths : [])
          .map((p) => String(p || '').trim()).filter(Boolean);
        // 缺失的原图先在本地拦下来：否则网关 400 之后用户只看到一句「调用失败」
        const readSafe = (p) => { try { return fs.read(p); } catch { return ''; } };
        const missing = refs.filter((p) => !readSafe(p));
        if (missing.length) {
          const msg = `沙箱中找不到参考图：${missing.join('、')}（现有图片：${fs.list().filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f.path)).map((f) => f.path).join('、') || '无'}）`;
          emit({ status: 'error', error: { message: msg } });
          return `图像调用在发起前失败：${msg}`;
        }
        const argModel = args.model != null && String(args.model).trim() ? resolveImageModel(String(args.model), model) : null;
        const note = argModel && argModel.id !== model
          ? `已使用会话选定的生图模型 ${model}（忽略工具参数里的「${argModel.input}」）。下次不要传 model。`
          : (argModel && argModel.corrected && argModel.input ? `已把模型名「${argModel.input}」解析为 ${model}。` : '');
        const onRetry = (_err, attempt) => emit({ status: 'running', note: `图像接口抖动，第 ${attempt} 次重试中…` });
        try {
          let out;
          if (refs.length) {
            const images = refs.map((p) => ({ name: p.split('/').pop(), dataUrl: readSafe(p) }));
            emit({ status: 'running', note: `图像编辑中（${model} · ${images.length} 张原图）…` });
            out = await editImage({ model, apiKey: ctx.apiKey, prompt, images, size, quality, format, n: count, signal: ctx.signal, onRetry });
          } else {
            emit({ status: 'running', note: `图像生成中（${model}${size !== 'auto' ? ` · ${size}` : ''}${count > 1 ? ` · ${count} 张` : ''}）…` });
            out = await generateImage({ model, apiKey: ctx.apiKey, prompt, size, quality, background, format, n: count, signal: ctx.signal, onRetry });
          }
          // 网关也可能只给远程 URL：落地成 data URL，保证沙箱内可再编辑、可打包下载
          const list = (out.images && out.images.length ? out.images : [{ dataUrl: out.dataUrl, mime: out.mime, ext: out.ext, width: out.width, height: out.height }]);
          const written = [];
          for (const img of list) {
            let dataUrl = img.dataUrl;
            let mime = img.mime;
            let ext = img.ext;
            let { width, height } = img;
            if (!/^data:/.test(dataUrl)) {
              try {
                const blob = await (await fetch(dataUrl)).blob();
                const bytes = new Uint8Array(await blob.arrayBuffer());
                dataUrl = bytesToDataUrl(bytes, mime);
                const sniff = sniffImage(bytes);
                if (sniff.mime) { mime = sniff.mime; ext = sniff.ext; }
                if (sniff.width) { width = sniff.width; height = sniff.height; }
              } catch { /* 取不到字节就保留远程 URL（仅用于展示） */ }
            }
            // 序号取「现有最大值 +1」而不是「文件个数 +1」：用户在面板里删过一个文件后，
            // 按个数计数会算出已占用的序号，把上一张图覆盖掉
            let last = 0;
            for (const f of fs.list()) {
              const m = /^outputs\/image-(\d+)\.[^.]*$/.exec(f.path);
              if (m) last = Math.max(last, Number(m[1]));
            }
            const path = `outputs/image-${String(last + 1).padStart(3, '0')}.${ext}`;
            fs.write(path, dataUrl);
            written.push({ path, dataUrl, mime, ext, width: width || 0, height: height || 0 });
            emit({ status: 'ok', image: dataUrl, imagePath: path, width, height, fsChange: true, note: `已生成 ${path}${width && height ? `（${width}x${height}）` : ''}` });
          }
          const dims = written.filter((w) => w.width && w.height).map((w) => `${w.width}x${w.height}`).join(' / ');
          const billed = out.usage && out.usage.total_tokens ? `，计费 ${out.usage.input_tokens || 0} 输入 / ${out.usage.output_tokens || 0} 输出 tokens` : '';
          const paths = written.map((w) => w.path).join('、');
          const summary = [
            `[图像${refs.length ? '编辑' : '生成'}完成]`,
            `- 模型：${model}`,
            `- 尺寸：${dims || size}${count > 1 ? `（共 ${written.length} 张）` : ''}`,
            `- 输出：${paths}（已写入沙箱，可在文件面板下载或打包 ZIP）${billed}`,
            `- 继续修改：以 reference_paths=["${written[written.length - 1].path}"] 再次调用本工具`,
          ];
          if (note) summary.push(`- ${note}`);
          return summary.join('\n');
        } catch (err) {
          if (err && (err.name === 'AbortError' || ctx.signal && ctx.signal.aborted)) throw err;
          emit({ status: 'error', error: { message: err.message } });
          return `图像模型调用失败（${model}）：${err.message}${note ? `\n${note}` : ''}`;
        }
      }
      case 'analyze_image': {
        if (!ctx.apiKey) {
          emit({ status: 'error', error: { message: '未配置 API Key' } });
          return '未配置 TeamoRouter API Key，无法调用识图模型。';
        }
        let path = normalizeFsPath(args.path);
        const listImgs = () => fs.list().filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f.path)).map((f) => f.path);
        if (!path) {
          const imgs = listImgs();
          if (imgs.length === 1) path = imgs[0];
          else if (!imgs.length) return 'analyze_image 缺少 path：沙箱里还没有图片（用户上传会进 uploads/）。';
          else return `analyze_image 缺少 path。沙箱中的图片：${imgs.join('、')}`;
        }
        let dataUrl = '';
        try { dataUrl = fs.read(path); } catch { return `analyze_image 失败：找不到 ${path}（现有图片：${listImgs().join('、') || '无'}）`; }
        if (!/^data:image\//i.test(dataUrl) && !/^https?:\/\//i.test(dataUrl)) {
          return `analyze_image 失败：${path} 不是图片 data URL（当前是文本文件？）。`;
        }
        const prompt = String(args.prompt || '').trim();
        emit({ status: 'running', note: `识图中（${VISION_TOOL_MODEL} · ${path}）…` });
        try {
          const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
          const text = await analyzeImage({ apiKey: ctx.apiKey, prompt, dataUrl, signal: ctx.signal });
          const ms = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0);
          const slash = path.lastIndexOf('/');
          const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
          const base = slash >= 0 ? path.slice(slash + 1) : path;
          const stem = base.replace(/\.[^.]+$/, '') || 'image';
          const ocrPath = `${dir}${stem}.ocr.md`;
          try { fs.write(ocrPath, text); } catch { /* 落盘失败仍回全文 */ }
          emit({ status: 'ok', note: `已分析 ${path}`, durationMs: ms });
          return `[识图完成] 模型 ${VISION_TOOL_MODEL} · 文件 ${path} · 全文 ${text.length} 字已写入 ${ocrPath}\n\n${text}`;
        } catch (err) {
          if (err && (err.name === 'AbortError' || ctx.signal && ctx.signal.aborted)) throw err;
          emit({ status: 'error', error: { message: err.message } });
          return `analyze_image 失败：${err.message}`;
        }
      }
      case 'zip_files': {
        const listed = fs.list().map((f) => f.path);
        const paths = Array.isArray(args.paths) && args.paths.length
          ? args.paths.map((p) => normalizeFsPath(p)).filter(Boolean)
          : listed;
        if (!paths.length) return 'zip_files：沙箱里没有文件可打包。';
        const entries = [];
        const missing = [];
        for (const p of paths) {
          try {
            const { bytes } = fileBytesFromValue(fs.read(p));
            entries.push({ name: p, bytes });
          } catch { missing.push(p); }
        }
        if (!entries.length) return `zip_files 失败：找不到 ${missing.join('、') || '指定文件'}`;
        const blob = createZip(entries);
        const buf = new Uint8Array(await blob.arrayBuffer());
        const out = normalizeFsPath(args.out) || 'archives/bundle.zip';
        fs.write(out, `data:application/zip;base64,${u8ToB64(buf)}`);
        emit({ status: 'ok', fsChange: true, editedPath: out, note: `已打包 ${entries.length} → ${out}` });
        const miss = missing.length ? `\n未找到：${missing.join('、')}` : '';
        return `已写入 ${out}（${entries.length} 个文件，${buf.length} 字节）${miss}`;
      }
      case 'unzip_file': {
        const path = normalizeFsPath(args.path);
        if (!path) return 'unzip_file 缺少 path。';
        let raw;
        try { raw = fs.read(path); } catch { return `unzip_file 失败：找不到 ${path}`; }
        const destRoot = normalizeFsPath(args.dest) || 'extracted';
        const got = typeof raw === 'string' && raw.startsWith('data:')
          ? await unpackZipFromDataUrl(raw)
          : await unpackZip(typeof raw === 'string' ? new TextEncoder().encode(raw) : raw);
        if (!got.ok) {
          emit({ status: 'error', error: { message: got.error } });
          return `unzip_file 失败：${got.error}`;
        }
        const written = [];
        for (const f of got.files) {
          const dest = normalizeFsPath(`${destRoot}/${f.path}`);
          if (!dest) continue;
          fs.write(dest, f.content);
          written.push(dest);
        }
        emit({ status: 'ok', fsChange: true, note: `解压 ${written.length} 个文件 → ${destRoot}/` });
        return `已解压 ${path} → ${destRoot}/（${written.length} 个文件）\n${written.slice(0, 40).join('\n')}${written.length > 40 ? '\n…' : ''}`;
      }
      default:
        return `未知工具: ${name}`;
    }
  } catch (err) {
    const msg = `工具执行失败: ${err.message}`;
    emit({ status: 'error', error: { message: msg } });
    return msg;
  }
}

function formatExecResult(lang, out) {
  const parts = [];
  if (out.logs && out.logs.length) {
    parts.push('── 控制台输出 ──\n' + out.logs.map((l) => `[${l.level}] ${l.text}`).join('\n'));
  }
  if (out.result !== undefined) parts.push(`── 返回值 ──\n${typeof out.result === 'string' ? out.result : JSON.stringify(out.result, null, 2)}`);
  if (!out.ok) {
    const errMsg = (out.error && out.error.message) || '沙箱未返回错误信息';
    const stack = out.error && out.error.stack ? String(out.error.stack).split('\n').slice(1, 4).join('\n') : '';
    parts.push(`── 错误 ──\n${errMsg}${stack ? `\n${stack}` : ''}`);
  }
  if (!parts.length) parts.push('（执行完成，无输出）');
  parts.push(`[执行耗时 ${out.durationMs}ms${out.timedOut ? '，已超时终止' : ''}]`);
  return `[${lang} 沙箱]\n${parts.join('\n')}`;
}

function u8ToB64(u8) {
  const chunk = 0x8000;
  let s = '';
  for (let i = 0; i < u8.length; i += chunk) s += String.fromCharCode(...u8.subarray(i, i + chunk));
  return btoa(s);
}
