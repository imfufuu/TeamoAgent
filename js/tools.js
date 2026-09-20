// ─── Agent 工具集：定义 + 执行调度 ─────────────────────────────────────
import { runJavaScript, runPython, runCpp, pythonAvailable } from './sandbox.js';
import { generateImage, editImage, bytesToDataUrl } from './api.js';
import { SUBAGENTS } from './subagents.js';
import { DEFAULT_IMAGE_MODEL, IMAGE_SIZES, IMAGE_QUALITIES, IMAGE_FORMATS } from './config.js';

export const TOOL_DEFS = [
  {
    name: 'execute_javascript',
    description: '在隔离的 Web Worker 沙箱中执行 JavaScript 代码（支持顶层 await）。沙箱提供 console（输出被捕获）和 files 对象（虚拟文件系统的键值快照，读写字典即可增改文件）。代码的 return 值或最后一个表达式作为结果返回。适合数学计算、数据处理、算法验证。',
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
    description: '在 Pyodide（WebAssembly Python 3）沙箱中执行 Python 代码。提供 FILES 字典（虚拟文件系统）。print 输出会被捕获；将最终结果赋给全局变量 result 可被返回。运行时常驻，仅会话首次调用需下载（约 10-30 秒）。注意：无网络、无本地磁盘。',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '要执行的 Python 代码' },
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
    description: '向会话虚拟文件系统写入/覆盖一个文本文件。文件对沙箱代码可见。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，如 data/notes.md' },
        content: { type: 'string', description: '文件完整内容' },
      },
      required: ['path', 'content'],
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
    name: 'generate_image',
    description:
      '调用文生图模型生成图片（GPT Image 2 / 2.5 Sunburst / 2.5 Flare，走 POST /v1/images/generations）。' +
      '若传入 reference_paths（沙箱内图片路径，如用户附件 uploads/xx.png），则自动切换为「图片编辑」模式（POST /v1/images/edits），按 prompt 指令修改原图。' +
      '结果以 data URL 写入沙箱 outputs/ 目录（可下载/打包/继续编辑），并在对话中直接展示。' +
      '生图耗时较长（最长约 300 秒）。需要出图时请调用本工具，不要只用文字描述画面。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '画面描述（生成模式）或修改指令（编辑模式），如「一只在键盘上打字的橘猫，插画风格」' },
        reference_paths: { type: 'array', items: { type: 'string' }, description: '可选：沙箱内参考图路径数组（如 ["uploads/cat.png"]）；提供即进入编辑模式' },
        size: { type: 'string', enum: IMAGE_SIZES, description: `输出尺寸（宽x高像素），默认 ${'auto'} 由模型决定` },
        quality: { type: 'string', enum: IMAGE_QUALITIES, description: '质量档位，默认 auto' },
        output_format: { type: 'string', enum: IMAGE_FORMATS, description: '输出格式，默认 png' },
        model: { type: 'string', description: `可选：本次使用的生图模型；缺省沿用用户在模型菜单选定的生图模型（默认 ${DEFAULT_IMAGE_MODEL}）` },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'dispatch_subagent',
    description:
      '把专业任务委派给子智能体（同模型、专属系统提示词与工具子集，独立上下文）。' +
      '子智能体看不到对话历史，task 必须自包含（附必要代码/数据/上下文）。返回其文字报告，由你整合后答复。可用子智能体：' +
      SUBAGENTS.map((a) => `${a.id}=${a.name}(${a.description.split('：')[0].split('，')[0]})`).join('；'),
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

// 执行工具并返回字符串结果（会回填进对话）；onUi 用于驱动沙箱面板
export async function executeTool(name, args, ctx) {
  const { fs, onUi } = ctx;
  const emit = (patch) => onUi && onUi({ name, args, ...patch });

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
        const out = await runPython(args.code || '', fs, (note) => emit({ status: 'running', lang: 'python', note }));
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
        fs.write(args.path, args.content ?? '');
        const msg = `已写入 ${args.path}（${String(args.content ?? '').length} 字符）`;
        emit({ status: 'ok', fsChange: true, note: msg });
        return msg;
      }
      case 'read_file': {
        const content = fs.read(args.path);
        emit({ status: 'ok', fsChange: false, note: `读取 ${args.path}` });
        return `── ${args.path} ──\n${content}`;
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
      case 'dispatch_subagent': {
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
        const model = String(args.model || ctx.imageModel || DEFAULT_IMAGE_MODEL);
        const format = IMAGE_FORMATS.includes(args.output_format) ? args.output_format : 'png';
        const size = IMAGE_SIZES.includes(args.size) ? args.size : 'auto';
        const quality = IMAGE_QUALITIES.includes(args.quality) ? args.quality : 'auto';
        const refs = (Array.isArray(args.reference_paths) ? args.reference_paths : [])
          .map((p) => String(p || '').trim()).filter(Boolean);
        try {
          let out;
          if (refs.length) {
            // 编辑模式：沙箱内图片（data URL）还原为上传文件
            const images = refs.map((p) => ({ name: p.split('/').pop(), dataUrl: fs.read(p) }));
            emit({ status: 'running', note: `图像编辑中（${model} · ${images.length} 张原图）…` });
            out = await editImage({ model, apiKey: ctx.apiKey, prompt, images, size, quality, format, signal: ctx.signal });
          } else {
            emit({ status: 'running', note: `图像生成中（${model}${size !== 'auto' ? ` · ${size}` : ''}）…` });
            out = await generateImage({ model, apiKey: ctx.apiKey, prompt, size, quality, background: args.background, format, signal: ctx.signal });
          }
          // 网关也可能只给远程 URL：落地成 data URL，保证沙箱内可再编辑、可打包下载
          let dataUrl = out.dataUrl;
          if (!/^data:/.test(dataUrl)) {
            try {
              const blob = await (await fetch(dataUrl)).blob();
              dataUrl = bytesToDataUrl(new Uint8Array(await blob.arrayBuffer()), out.mime);
            } catch { /* 取不到字节就保留远程 URL（仅用于展示） */ }
          }
          const seq = fs.list().filter((f) => f.path.startsWith('outputs/')).length + 1;
          const path = `outputs/image-${seq.toString().padStart(3, '0')}.${out.ext}`;
          fs.write(path, dataUrl);
          emit({ status: 'ok', image: dataUrl, imagePath: path, fsChange: true, note: `已生成 ${path}` });
          return `[图像${refs.length ? '编辑' : '生成'}完成]\n- 模型：${model}\n- 尺寸：${size}\n- 输出：${path}（已写入沙箱，可在文件面板下载或打包 ZIP）\n- 继续修改：以 reference_paths=["${path}"] 再次调用本工具`;
        } catch (err) {
          if (err && (err.name === 'AbortError' || ctx.signal && ctx.signal.aborted)) throw err;
          emit({ status: 'error', error: { message: err.message } });
          return `图像模型调用失败（${model}）：${err.message}`;
        }
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
  if (!out.ok) parts.push(`── 错误 ──\n${out.error.message}${out.error.stack ? '\n' + String(out.error.stack).split('\n').slice(1, 4).join('\n') : ''}`);
  if (!parts.length) parts.push('（执行完成，无输出）');
  parts.push(`[执行耗时 ${out.durationMs}ms${out.timedOut ? '，已超时终止' : ''}]`);
  return `[${lang} 沙箱]\n${parts.join('\n')}`;
}
