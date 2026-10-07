// ─── UI · Markdown / 消息片段渲染（P4 拆分：从 ui.js 模块级抽出，不依赖 mountUI 闭包）────────
// 拥有：DOM 小工具（$ / $$ / el / esc）、安全链接与沙箱媒体（safeHref / safeImgSrc / sandboxPath / hydrateSandboxMedia）、
//       编辑预览片段、choice / chart 围栏、代码高亮与 KaTeX、markdown-it 引擎（getMd）、renderMarkdown 及其围栏/行内码保护、
//       附件缩略图（renderAttachments / videoBlobUrl）、折叠行绑定（bindFoldRows）、尺寸/时长格式化（fmtSize / fmtVideoLen / contextBudgetLabel）。
// 不拥有：任何 store / agent 状态、toast、消息列表与 mountUI 内的交互。本文件绝不 import ui.js。
import { contextBudgetFor } from './context.js';
import { ICON } from './icons.js';
import { prepareMarkdownExtensions, parsePandocAttributes, pandocAttributesHtml } from './markdown-extensions.js?v=2026.10.5.29';
import { parseChartInfo, parseDiagramInfo, renderQuickChart, renderQuickDiagram, CHART_DIRECT_ALIASES } from './quickviz.js?v=2026.10.5.29';

export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
export const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const safeHref = (href) => {
  const h = String(href || '').trim();
  if (!h || /[\s<>"'`]/.test(h)) return '';
  if (h.startsWith('#') && h.length < 200) return h;
  try {
    const u = new URL(h);
    if (u.protocol === 'http:' || u.protocol === 'https:') return h;
    if (u.protocol === 'mailto:') {
      const addr = decodeURIComponent(u.pathname || '');
      if (/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(addr)) return `mailto:${addr}`;
    }
  } catch { /* 非法 URL */ }
  return '';
};
// 支持的图像 data URL MIME：PNG / JPEG / GIF / WEBP / BMP / ICO / TIFF / AVIF / APNG / HEIC / HEIF / SVG
// 覆盖主要模型供应商（DeepSeek/OpenAI/Claude/Gemini 共通接受 JPEG/PNG/GIF/WEBP；额外 BMP/ICO/TIFF/AVIF/HEIC/SVG 在
// 客户端 UI 上可预览；发给视觉模型时会统一转成 PNG/JPEG，避免供应商不支持的格式导致 400。
const IMG_DATA_URL_RE = /^data:image\/(png|jpe?g|gif|webp|bmp|ico|tiff?|avif|apng|heic|heif|svg\+xml);base64,[A-Za-z0-9+/=\s]+$/i;
const IMG_MIME_RE = /^image\/(png|jpe?g|gif|webp|bmp|ico|tiff?|avif|apng|heic|heif|svg\+xml)$/i;
export const safeImgSrc = (src) => {
  const s = String(src || '').trim();
  if (IMG_DATA_URL_RE.test(s)) return s.replace(/\s+/g, '');
  if (/^blob:/i.test(s)) return s;
  return safeHref(s);
};
export const sandboxPath = (src) => {
  const s = String(src || '').trim();
  const m = /^(?:sandbox:\/\/|sandbox:)(.+)$/i.exec(s);
  if (!m) return '';
  const parts = m[1].trim().split('/').map((x) => x.trim()).filter((x) => x && x !== '.');
  if (!parts.length || parts.includes('..') || /[\u0000-\u001f]/.test(parts.join('/'))) return '';
  return parts.join('/');
};
export const headingSlug = (text) => {
  const s = String(text || '').trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s-]+/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return s || 'section';
};
// P3：预览窗 HTML（最近 N 行 + 行号 + 模式/行数/字符数）。只在节流命中时重建。
export const editPreviewHtml = (preview, live) => {
  if (!preview) return '';
  const rows = (preview.lines || []).map((l) => `<div class="ep-line"><span class="ep-no">${esc(String(l.no))}</span><span class="ep-tx">${esc(l.text) || '&nbsp;'}</span></div>`).join('');
  const meta = [
    preview.modeLabel,
    preview.lineCount ? `${preview.lineCount} 行` : '',
    preview.chars ? `${preview.chars} ${preview.unit || '字符'}` : '',
    preview.clipped ? '仅显示尾部' : '',
    preview.fromDisk ? '来自已落盘文件' : '',
  ].filter(Boolean).join(' · ');
  const foot = preview.writes > 1
    ? `<div class="ep-foot mono">本轮对该路径写入 ${preview.samePathWrites} 次${preview.paths.length > 1 ? `，共涉及 ${preview.paths.length} 个文件` : ''}</div>`
    : '';
  return `<div class="edit-preview" data-policy="${esc(preview.policyVersion || '')}" data-status="${esc(preview.status || '')}">`
    + `<div class="ep-head mono">${esc(preview.path || '(路径未定)')}${meta ? `<span class="ep-meta">${esc(meta)}</span>` : ''}</div>`
    + `<div class="ep-body">${rows || '<div class="ep-line"><span class="ep-tx ep-empty">（还没有内容）</span></div>'}${live && !preview.complete ? '<span class="ep-caret" aria-hidden="true"></span>' : ''}</div>`
    + foot
    + '</div>';
};
const parseChoiceOpts = (body) => {
  const listed = [];
  for (const line of String(body || '').split('\n')) {
    const m = /^\s*(?:[-*]|\d+\.|[A-Za-z]\.)\s+(.+?)\s*$/.exec(line);
    if (m) listed.push(m[1].trim());
  }
  if (listed.length) return listed;
  return String(body || '').split('\n').map((l) => l.trim()).filter(Boolean);
};
const peelChoices = (src) => {
  const blocks = [];
  let rest = String(src || '').replace(/[ \t]+\n/g, '\n').replace(/\s+$/, '');
  // 从文末向前剥离完整 :::choice 块。旧版正则会把连续多个 choice
  // 贪成「第一个问题 + 所有选项」，导致第二个问题不渲染。
  const openRe = /(?:^|\n):::choice(?:[ \t]+([^\n]*))?[ \t]*\n/g;
  // 结束符可能是 `:::` 或 `:::>`（模型把引用块 > 紧贴结束符），接受两种
  const closeRe = /\n:::(?:>[^\n]*)?[ \t]*$/;
  while (closeRe.test(rest)) {
    const close = rest.match(closeRe);
    if (!close || close.index == null) break;
    const beforeClose = rest.slice(0, close.index);
    let last = null;
    openRe.lastIndex = 0;
    for (let m; (m = openRe.exec(beforeClose)); ) last = m;
    if (!last) break;
    const title = (last[1] || '').trim();
    const body = beforeClose.slice(last.index + last[0].length);
    blocks.unshift({ title, body });
    rest = beforeClose.slice(0, last.index).replace(/\s+$/, '');
  }
  return { rest, blocks };
};
const choiceHtml = (blocks) => {
  const list = (Array.isArray(blocks) ? blocks : [blocks]).filter(Boolean);
  const safe = list.length ? list : [{ title: '请选择', body: '' }];
  const count = safe.length;
  const groups = safe.map((block, i) => {
    const q = esc(block.title || `问题 ${i + 1}`);
    const opts = parseChoiceOpts(block.body);
    const buttons = opts.map((o) => `<button type="button" class="choice-opt" data-choice-send="${esc(o)}">${esc(o)}</button>`).join('');
    return `<div class="choice-qblock${i === 0 ? ' active' : ''}" data-choice-idx="${i}"><div class="choice-qrow"><span class="choice-step">${i + 1}/${count}</span><div class="choice-q">${q}</div></div><div class="choice-opts">${buttons}</div></div>`;
  }).join('');
  const label = esc(count > 1 ? `选择框（${count} 个问题）` : (safe[0].title || '请选择'));
  return `<div class="choice-box${count > 1 ? ' multi' : ''}" role="group" aria-label="${label}" data-choice-count="${count}" data-choice-step="0" data-choice-answers="[]"><div class="choice-head"><div class="choice-title">${count > 1 ? `请选择 · ${count} 题` : '请选择'}</div></div><div class="choice-summary" data-choice-summary></div>${groups}<div class="choice-nav"><button type="button" class="choice-back" data-choice-back disabled>← 回退</button><span class="choice-progress" data-choice-progress>1 / ${count}</span></div></div>`;
};

// :::chart 围栏正则：直接别名按长度降序，避免「柱状」抢先吃掉「柱状图」
const CHART_FENCE_RE = new RegExp(`^:::(?:chart[ \\t]+([^\\n]+)|(${[...CHART_DIRECT_ALIASES].sort((a, b) => b.length - a.length).map((k) => k.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('|')})[ \\t]*([^\\n]*))\\n([\\s\\S]*?)^:::[ \\t]*$`, 'gm');

export function sanitizeSvgRaw(raw) {
  let s = String(raw || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // 确保有 xmlns（否则 <img src="data:image/svg+xml"> 不认，渲染为 0×0）
  if (/<svg[\s>]/i.test(s) && !/xmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/i.test(s)) {
    s = s.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  // 若只有 viewBox 没有 width/height，补 width/height 避免 intrinsic size 塌陷成 0
  if (/<svg[\s>][\s\S]*viewBox/i.test(s)) {
    const hasW = /<svg[^>]*\swidth\s*=\s*["']?[\d.]+/i.test(s);
    const hasH = /<svg[^>]*\sheight\s*=\s*["']?[\d.]+/i.test(s);
    if (!hasW || !hasH) {
      const vm = /viewBox\s*=\s*["']?\s*([\-\d.]+)[\s,]+([\-\d.]+)[\s,]+([\-\d.]+)[\s,]+([\-\d.]+)/i.exec(s);
      if (vm) {
        const w = parseFloat(vm[3]), h = parseFloat(vm[4]);
        s = s.replace(/<svg/i, (m) => {
          let tag = m;
          if (!hasW) tag += ` width="${w}"`;
          if (!hasH) tag += ` height="${h}"`;
          return tag;
        });
      }
    }
  }
  return s;
}

export function hydrateSandboxMedia(root, fs) {
  if (!root || !fs) return;
  for (const img of root.querySelectorAll('img[data-sandbox]')) {
    const p = img.getAttribute('data-sandbox') || '';
    let raw = '';
    try { raw = fs.read(p); } catch { raw = ''; }
    if (/^data:image\//i.test(String(raw))) {
      const safe = safeImgSrc(raw);
      if (safe) {
        img.src = safe;
        if (!img.alt) img.alt = p;
        img.classList.add('zoomable');
        continue;
      }
    }
    if (/\.svg$/i.test(p) && /<svg[\s>]/i.test(String(raw))) {
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sanitizeSvgRaw(raw))}`;
      if (!img.alt) img.alt = p;
      img.classList.add('zoomable');
      continue;
    }
    const card = document.createElement('div');
    card.className = 'sb-file' + (raw ? '' : ' missing');
    const name = esc((p.split('/').pop() || p));
    card.innerHTML = raw
      ? `<span class="mono">${name}</span><button type="button" class="sb-dl" data-sb-dl="${esc(p)}">下载</button>`
      : `<span class="mono">${esc(p)}</span><span>沙箱中没有这个文件</span>`;
    img.replaceWith(card);
  }
}

export function bindFoldRows(root) {
  if (!root) return;
  for (const n of root.querySelectorAll('.md-fold')) {
    if (n.dataset.bound) continue;
    n.dataset.bound = '1';
    const toggle = () => n.classList.toggle('expanded');
    n.addEventListener('click', (e) => {
      if (e.target.closest('a, button, .chip-copy')) return;
      toggle();
    });
    n.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  }
}

// 耗时格式化（工具芯片 / 折叠头 / /status 命令共用）
export function fmtSpan(ms) {
  const n = Math.max(0, Math.round(Number(ms) || 0));
  if (n < 1) return '<1ms';
  if (n < 1000) return n + 'ms';
  if (n < 60000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 's';
  const min = Math.floor(n / 60000);
  const sec = Math.round((n % 60000) / 1000);
  return sec ? `${min}min ${sec}s` : `${min}min`;
}
export const fmtSize = (n) => {
  if (n == null) return '';
  const v = Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : 0;
  const kb = v / 1024;
  return kb > 1024 ? `${(v / 1048576).toFixed(1)}MB` : `${kb.toFixed(1)}KB`;
};

export const contextBudgetLabel = (model) => {
  const b = contextBudgetFor(model);
  return b >= 1000 ? `${Math.round(b / 1000)}k` : String(b);
};

// 附件展示（用户气泡内）
export const fmtVideoLen = (sec) => { const s = Math.max(0, Math.round(Number(sec) || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
// data:video/… → blob URL（16MB 的 data URL 直接塞 <video src> 既慢又占内存；blob 可被 <video> 流式读）
export function videoBlobUrl(dataUrl) {
  const s = String(dataUrl || '');
  const m = /^data:([^;,]+);base64,/.exec(s);
  if (!m) return '';
  try {
    const bin = atob(s.slice(s.indexOf(',') + 1));
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([u8], { type: m[1] }));
  } catch { return ''; }
}
export function renderAttachments(atts) {
  if (!atts || !atts.length) return '';
  const items = atts.map((a, idx) => {
    if (a.kind === 'image') {
      const src = safeImgSrc(a.dataUrl);
      return src
        ? `<button type="button" class="att-img" title="${esc(a.name)}"><img src="${src}" alt="${esc(a.name)}"></button>`
        : `<span class="att-file mono" title="内容未持久化">🖼 ${esc(a.name)}（已省略）</span>`;
    }
    const isVideo = a.source === 'video' || /^video\//i.test(String(a.mime || '')) || /\.(mp4|webm|mov|m4v)$/i.test(String(a.name || ''));
    if (isVideo) {
      // 视频：首帧海报 + ▶ 角标；点击在气泡内就地播放（blob URL，CSP media-src 已放行）
      const poster = safeImgSrc(a.poster);
      const dur = a.durationSec ? fmtVideoLen(a.durationSec) : '';
      const can = !a.stripped && /^data:video\//i.test(String(a.dataUrl || ''));
      return `<button type="button" class="att-video${can ? '' : ' is-off'}" data-att-idx="${idx}" title="${esc(a.name)}${can ? '（点击播放）' : '（内容未持久化）'}">`
        + (poster ? `<img src="${poster}" alt="${esc(a.name)}">` : `<span class="att-video-blank">🎬</span>`)
        + `<span class="att-video-badge">${can ? '▶' : '⊘'}${dur ? ` ${dur}` : ''}</span>`
        + `<span class="att-video-name mono">${esc(a.name)}${a.stripped ? '（已省略）' : ` · ${fmtSize(a.size)}`}</span></button>`;
    }
    return `<span class="att-file mono" title="${esc(a.name)}">📄 ${esc(a.name)}${a.stripped ? '（已省略）' : ` · ${fmtSize(a.size)}`}</span>`;
  }).join('');
  return `<div class="att-row">${items}</div>`;
}

const LANG_ALIAS = {
  js: 'javascript', javascript: 'javascript', jsx: 'javascript', node: 'javascript',
  ts: 'typescript', typescript: 'typescript', tsx: 'typescript',
  py: 'python', python: 'python', py3: 'python',
  java: 'java',
  c: 'c', h: 'c',
  cpp: 'cpp', 'c++': 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  csharp: 'csharp', 'c#': 'csharp', cs: 'csharp',
  go: 'go', golang: 'go',
  rs: 'rust', rust: 'rust',
  rb: 'ruby', ruby: 'ruby',
  php: 'php',
  swift: 'swift',
  kt: 'kotlin', kotlin: 'kotlin',
  scala: 'scala',
  dart: 'dart',
  objc: 'objectivec', 'objective-c': 'objectivec', objectivec: 'objectivec',
  m: 'matlab', matlab: 'matlab', octave: 'matlab',
  sh: 'bash', bash: 'bash', shell: 'bash', zsh: 'bash', fish: 'bash',
  ps1: 'powershell', psm1: 'powershell', powershell: 'powershell', pwsh: 'powershell',
  bat: 'dos', cmd: 'dos', batch: 'dos', dos: 'dos',
  sql: 'sql',
  json: 'json', jsonc: 'json',
  yml: 'yaml', yaml: 'yaml',
  toml: 'toml', ini: 'ini', conf: 'ini', gitconfig: 'ini', gitignore: 'ini', properties: 'ini',
  xml: 'xml', htm: 'xml', html: 'xml', svg: 'xml', vue: 'xml', svelte: 'xml',
  css: 'css', scss: 'scss', less: 'less',
  md: 'markdown', markdown: 'markdown',
  r: 'r',
  jl: 'julia', julia: 'julia',
  sas: 'sas', do: 'stata', stata: 'stata',
  hs: 'haskell', haskell: 'haskell',
  erl: 'erlang', erlang: 'erlang',
  ex: 'elixir', exs: 'elixir', elixir: 'elixir',
  clj: 'clojure', cljs: 'clojure', clojure: 'clojure',
  lisp: 'lisp', cl: 'lisp', scm: 'scheme', scheme: 'scheme',
  fs: 'fsharp', fsharp: 'fsharp', 'f#': 'fsharp',
  ml: 'ocaml', ocaml: 'ocaml',
  asm: 'x86asm', s: 'x86asm', x86asm: 'x86asm', armasm: 'armasm', arm: 'armasm',
  vhd: 'vhdl', vhdl: 'vhdl',
  v: 'verilog', sv: 'verilog', verilog: 'verilog',
  cu: 'cpp', cuda: 'cpp',
  sol: 'javascript', solidity: 'javascript',
  graphql: 'graphql', gql: 'graphql',
  tex: 'latex', latex: 'latex',
  hbs: 'handlebars', handlebars: 'handlebars',
  jinja: 'django', jinja2: 'django', j2: 'django', django: 'django',
  dockerfile: 'dockerfile', docker: 'dockerfile',
  mk: 'makefile', make: 'makefile', makefile: 'makefile',
  nginx: 'nginx', apache: 'apache', apacheconf: 'apache',
  diff: 'diff', patch: 'diff',
  regex: 'javascript', regexp: 'javascript',
};
export function highlightCode(code, lang, escapeFn) {
  const raw = String(code || '').replace(/\n$/, '');
  const L = LANG_ALIAS[(lang || '').toLowerCase()] || (lang || '').toLowerCase();
  if (typeof hljs !== 'undefined') {
    try {
      if (L && hljs.getLanguage && hljs.getLanguage(L)) return hljs.highlight(raw, { language: L, ignoreIllegals: true }).value;
      return hljs.highlightAuto(raw).value;
    } catch { /* 回退纯文本 */ }
  }
  return escapeFn(raw);
}
// 代码块 HTML：open=true 表示未闭合（流式中 ``` 还没配对），不显示复制按钮；
// 闭合后渲染完整 code-head（语言标签 + 复制按钮）。
export function fenceHtml(lang, code, escapeFn, open = false, attributes = null) {
  const L = (lang || 'text').trim() || 'text';
  const body = highlightCode(code, L, escapeFn);
  const head = open
    ? `<div class="code-head code-head-open"><span class="code-lang">${escapeFn(L)}</span></div>`
    : `<div class="code-head"><span class="code-lang">${escapeFn(L)}</span><button class="copy-code" type="button">复制</button></div>`;
  const classes = ['code-block', open ? 'code-block-open' : '', ...(attributes && attributes.classes || [])].filter(Boolean).join(' ');
  const outerAttrs = pandocAttributesHtml(attributes, classes);
  return `<div${outerAttrs}>${head}<pre data-lang="${escapeFn(L)}"><code class="hljs">${body}</code></pre></div>`;
}
// 数学公式 HTML：display=true 块级；open=true 表示流式中未闭合（不复制按钮，但 KaTeX 仍渲染）
// 数学公式本就不可编辑，复制按钮对公式没意义——这里的"完成后显示复制按钮"仅对代码块生效
// （用户对公式的诉求主要是立即看到渲染效果而非复制）。
function mathHtml(html, display, open = false) {
  const cls = display ? 'katex-display-block' : 'katex-inline';
  const state = open ? ' data-state="streaming"' : '';
  return `<span class="${cls}"${state}>${html}</span>`;
}

// ── Markdown 渲染：markdown-it（本地打包 assets/md/，完整 CommonMark + GFM 表格）
//    + KaTeX 公式；两者任一未加载时回退到内置精简渲染器（先转义再解析，无 XSS 面）──
let mdEngine; // undefined=未初始化 null=不可用
export function getMd() {
  if (mdEngine === undefined) {
    if (typeof markdownit === 'undefined') { mdEngine = null; }
    else {
      const md = markdownit({ html: false, linkify: true, breaks: false, typographer: false });
      md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
        const tok = tokens[idx];
        const href = safeHref(tok.attrGet('href'));
        tok.attrSet('href', href);
        if (href.startsWith('#')) {
          tok.attrSet('target', '');
          tok.attrSet('rel', '');
          tok.attrJoin('class', 'md-jump');
        } else if (href) {
          tok.attrSet('target', '_blank');
          tok.attrSet('rel', 'noopener noreferrer nofollow');
        } else {
          tok.attrSet('target', '');
          tok.attrSet('rel', '');
        }
        return self.renderToken(tokens, idx, options);
      };
      const defaultImage = md.renderer.rules.image;
      md.renderer.rules.image = (tokens, idx, options, env, self) => {
        const tok = tokens[idx];
        const raw = String(tok.attrGet('src') || '');
        const sb = sandboxPath(raw);
        if (sb) {
          tok.attrSet('src', '');
          tok.attrSet('data-sandbox', sb);
          tok.attrJoin('class', 'sb-img');
        } else {
          tok.attrSet('src', safeImgSrc(raw));
        }
        return defaultImage ? defaultImage(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
      };
      md.core.ruler.push('heading-ids', (state) => {
        const seen = Object.create(null);
        for (let i = 0; i < state.tokens.length; i++) {
          const tok = state.tokens[i];
          if (tok.type !== 'heading_open') continue;
          const inline = state.tokens[i + 1];
          let text = inline && inline.content ? inline.content : '';
          const attrMatch = /[ \t]+(\{[^{}]*\})[ \t]*$/.exec(text);
          let attrs = null;
          if (attrMatch) {
            attrs = parsePandocAttributes(attrMatch[1]);
            text = text.slice(0, attrMatch.index).trimEnd();
            inline.content = text;
            const suffix = attrMatch[0];
            const children = inline.children || [];
            for (let j = children.length - 1; j >= 0; j--) {
              const child = children[j];
              if (child.type !== 'text') continue;
              if (child.content.endsWith(suffix)) {
                child.content = child.content.slice(0, -suffix.length);
                break;
              }
              // markdown-it may attach the leading space to a preceding text node.
              if (child.content.endsWith(attrMatch[1])) {
                child.content = child.content.slice(0, -attrMatch[1].length).replace(/[ \t]+$/, '');
                break;
              }
            }
          }
          let id = (attrs && attrs.id) || headingSlug(text);
          if (seen[id]) { seen[id] += 1; id = `${id}-${seen[id]}`; }
          else seen[id] = 1;
          tok.attrSet('id', id);
          if (attrs && attrs.classes.length) tok.attrSet('class', attrs.classes.join(' '));
          if (attrs && attrs.style) tok.attrSet('style', attrs.style);
          if (attrs && attrs.title) tok.attrSet('title', attrs.title);
        }
      });
      md.renderer.rules.fence = (tokens, idx) => {
        const tk = tokens[idx];
        const info = (tk.info || '').trim();
        const lang = info.split(/\s+/)[0] || 'text';
        const attrMatch = /\{[^{}]*\}[ \t]*$/.exec(info);
        const attrs = attrMatch ? parsePandocAttributes(attrMatch[0]) : null;
        return fenceHtml(lang, tk.content, md.utils.escapeHtml, false, attrs);
      };
      // GFM 任务列表（markdown-it 核心不含）：[ ] / [x] 开头的列表项 → checkbox
      md.core.ruler.after('inline', 'task-lists', (state) => {
        let inList = 0;
        for (const tok of state.tokens) {
          if (tok.type === 'bullet_list_open' || tok.type === 'ordered_list_open') inList++;
          else if (tok.type === 'bullet_list_close' || tok.type === 'ordered_list_close') inList--;
          if (tok.type !== 'inline' || !inList || !tok.children || !tok.children.length) continue;
          const first = tok.children[0];
          if (first.type !== 'text') continue;
          const m = /^\[([ xX])\]\s+/.exec(first.content);
          if (!m) continue;
          first.content = first.content.slice(m[0].length);
          const cb = new state.Token('html_inline', '', 0);
          cb.content = m[1] === ' ' ? '<input type="checkbox" disabled> ' : '<input type="checkbox" checked disabled> ';
          tok.children.unshift(cb);
        }
      });
      mdEngine = md;
    }
  }
  return mdEngine;
}

// ── /system 回复格式化（.18）：行级结构化——命令行/结果行/小节标题，不再挤成一团 ──
export function sysReplyHtml(text) {
  const rows = String(text || '').split('\n').map((ln) => {
    const e = esc(ln);
    const s = ln.trim();
    let cls = 'sys-row';
    if (/^\/[a-z]/i.test(s)) cls += ' sys-cmd';
    else if (/^✓/.test(s)) cls += ' sys-ok';
    else if (/^(✗|⚠)/.test(s)) cls += ' sys-err';
    else if (/^⌙|：$/.test(s)) cls += ' sys-head';
    return `<div class="${cls}">${e || '&nbsp;'}</div>`;
  });
  return `<div class="sys-reply">${rows.join('')}</div>`;
}

function extractCodeFences(source, codeBlocks) {
  const lines = [];
  for (let start = 0; start < source.length;) {
    const nl = source.indexOf('\n', start);
    const end = nl < 0 ? source.length : nl + 1;
    const rawEnd = nl < 0 ? source.length : nl;
    lines.push({ start, end, text: source.slice(start, rawEnd).replace(/\r$/, '') });
    start = end;
  }
  let out = '';
  let cursor = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const open = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(line.text);
    if (!open) continue;
    const fence = open[1];
    const marker = fence[0];
    const size = fence.length;
    const info = String(open[2] || '').trim();
    // CommonMark 禁止反引号围栏的信息字符串再含反引号。
    if (marker === '`' && info.includes('`')) continue;
    const lang = info.split(/\s+/, 1)[0] || 'text';
    const closeRe = marker === '`' ? /^ {0,3}(`+)[ \t]*$/ : /^ {0,3}(~+)[ \t]*$/;
    let closeAt = -1;
    let closeEnd = source.length;
    let closeLine = i;
    for (let j = i + 1; j < lines.length; j++) {
      const close = closeRe.exec(lines[j].text);
      if (close && close[1].length >= size) {
        closeAt = lines[j].start;
        closeEnd = lines[j].end;
        closeLine = j;
        break;
      }
    }
    out += source.slice(cursor, line.start);
    const closed = closeAt >= 0;
    const code = source.slice(line.end, closed ? closeAt : source.length);
    const attrMatch = /\{[^{}]*\}[ \t]*$/.exec(info);
    const attrs = attrMatch ? parsePandocAttributes(attrMatch[0]) : null;
    codeBlocks.push({ lang, code, open: !closed, attrs });
    out += `\uE000CB${codeBlocks.length - 1}\uE000`;
    cursor = closed ? closeEnd : source.length;
    i = closeLine;
    if (!closed) break; // 流式输入中的末尾围栏：整段保留为一个未闭合代码块
  }
  return out + source.slice(cursor);
}

function isEscapedMarkdownDelimiter(source, index) {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && source[i] === '\\'; i--) backslashes++;
  return (backslashes & 1) === 1;
}

function extractInlineCodeSpans(source, inlineCodes) {
  const text = String(source || '');
  let out = '';
  let cursor = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '`') { i++; continue; }
    const openStart = i;
    while (text[i] === '`') i++;
    const runLength = i - openStart;
    if (isEscapedMarkdownDelimiter(text, openStart)) continue;

    let search = i;
    let closeStart = -1;
    let closeEnd = -1;
    while (search < text.length) {
      const candidate = text.indexOf('`', search);
      if (candidate < 0) break;
      let end = candidate + 1;
      while (text[end] === '`') end++;
      if (end - candidate === runLength && !isEscapedMarkdownDelimiter(text, candidate)) {
        closeStart = candidate;
        closeEnd = end;
        break;
      }
      search = end;
    }
    if (closeStart < 0) continue;

    out += text.slice(cursor, openStart);
    const codeIndex = inlineCodes.push(text.slice(i, closeStart)) - 1;
    out += `\uE000IC${codeIndex}\uE000`;
    cursor = closeEnd;
    i = closeEnd;
  }
  return out + text.slice(cursor);
}

function isMarkdownEscapablePunctuation(char) {
  const code = char ? char.charCodeAt(0) : 0;
  return (code >= 0x21 && code <= 0x2f)
    || (code >= 0x3a && code <= 0x40)
    || (code >= 0x5b && code <= 0x60)
    || (code >= 0x7b && code <= 0x7e);
}

function protectFallbackEscapes(source, escapedChars) {
  let out = '';
  for (let i = 0; i < source.length;) {
    if (source[i] === '\\' && isMarkdownEscapablePunctuation(source[i + 1])) {
      const index = escapedChars.push(source[i + 1]) - 1;
      out += `\uE000ESC${index}\uE000`;
      i += 2;
    } else {
      out += source[i++];
    }
  }
  return out;
}

export function renderMarkdown(src) {
  const codeBlocks = [];
  let t = extractCodeFences(String(src || ''), codeBlocks);
  // 先以转义感知方式剥离成对的行内代码（.18）：其中的 $…$ 不能被当数学定界符——
  // 正则/命令含 $ 锚点时曾被 KaTeX 当数学渲染（数学模式吃空格 + 未知命令标红，产生整段乱码）。
  const inlineCodes = [];
  t = extractInlineCodeSpans(t, inlineCodes);
  // LaTeX：$$..$$ / \[..\] 块级，$..$ / \(..\) 行内；在渲染前提取，占位保护。
  // 数学段守卫：像正则/代码/自然语言的内容不当数学渲染，原文保留可读；
  // \(..\) / \[..\] 是显式定界不受守卫影响。
  // 修复：\text{中文}、\color{red}{\text{中文}} 这类含 LaTeX 命令（反斜杠+字母）的公式
  // 不应被中文守卫误拒——先剥离 \text/\mbox/\textrm/\mathrm/\color/\textbf 等命令的花括号内容，
  // 若剩余部分仍有明显数学命令（\alpha/\frac/^/_/等），判定为数学；否则再看是否像纯文本中的 $...$。
  const MATH_CMD = /\\(?:text|mbox|textrm|mathrm|textbf|textit|mathbf|mathit|mathsf|mathtt|mathcal|color|operatorname|tag|label|ref|eqref|cite|frac|dfrac|tfrac|sqrt|sum|int|prod|lim|alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|vartheta|iota|kappa|lambda|mu|nu|xi|pi|rho|sigma|tau|upsilon|phi|varphi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega|partial|infty|nabla|forall|exists|neg|land|lor|implies|iff|to|mapsto|leftarrow|rightarrow|leftarrow|rightarrow|Leftarrow|Rightarrow|approx|sim|simeq|cong|equiv|ne|neq|leq|geq|lt|gt|le|ge|cdot|times|div|pm|mp|oplus|otimes|circ|bullet|dots|ldots|cdots|vdots|ddots|hat|bar|vec|dot|ddot|tilde|widehat|widetilde|overline|underline|overbrace|underbrace|left|right|big|Big|bigg|Bigg|bigl|Bigr|biggl|Biggr|newcommand|renewcommand|def|DeclareMathOperator|begin|end|array|pmatrix|bmatrix|cases|align|aligned|gather| gathered)/;
  const _stripBraced = (s) => {
    // 粗略剥离 \xxx{...} 一层（不计嵌套，够用来判断中文是否仅在 \text 内）
    return String(s).replace(/\\[a-zA-Z]+\s*\{[^{}]*\}/g, '');
  };
  const MATH_REJECT = /(\(\?|\\p\{|\\P\{|\\x[0-9A-Fa-f]{2}|\\u[0-9A-Fa-f{]|\*\/|\^\$|\.\*|\$\{|=>|https?:\/\/)/;
  const PLAIN_TEXT_RE = /[A-Za-z]{3,}\s+[A-Za-z]{3,}/;
  const mathOk = (x) => {
    if (MATH_REJECT.test(x)) return false;
    // 有 LaTeX 命令（\frac、\text、\color、\alpha 等）→ 大概率是真公式，放行（中文可在 \text{} 里）
    if (MATH_CMD.test(x)) return true;
    // 含数学运算符（^ _ / 等）→ 真公式
    if (/[\^_]/.test(x)) return true;
    // 含独立中文且没有明显数学命令 → 可能是自然语言里的 $5 之类，拒
    const stripped = _stripBraced(x);
    if (/[\u4e00-\u9fff]/.test(stripped)) return false;
    // 三个以上英文单词连写（自然语言）→ 拒
    if (PLAIN_TEXT_RE.test(x)) return false;
    return true;
  };
  const maths = [];
  const hasKatex = typeof katex !== 'undefined';
  const pushMath = (tex, display, open) => {
    if (hasKatex) {
      try {
        const html = katex.renderToString(tex, { displayMode: display, throwOnError: false });
        maths.push({ html, display, open });
        return `\uE000M${maths.length - 1}\uE000`;
      } catch { /* 渲染失败按原文处理 */ }
    }
    // KaTeX 不可用时降级为代码（代码块显示时未闭合状态没有复制按钮）
    if (open) {
      codeBlocks.push({ lang: 'tex', code: tex, open: true });
      return `\uE000CB${codeBlocks.length - 1}\uE000`;
    }
    return display ? `\n\`\`\`tex\n${tex}\n\`\`\`\n` : `\`${tex}\``;
  };
  // 先替换闭合的数学定界符，再替换未闭合的（末尾正在输入）
  t = t
    // 块级：$$...$$
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, x) => mathOk(x) ? pushMath(x, true, false) : _)
    // 未闭合 $$（开头有 $$ 但没第二个 $$，且在文末）
    .replace(/\$\$([\s\S]*)$/g, (_, x) => mathOk(x + ' ') ? pushMath(x, true, true) : _)
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, x) => pushMath(x, true, false))
    .replace(/\\\[([\s\S]*)$/g, (_, x) => pushMath(x, true, true))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, x) => pushMath(x, false, false))
    .replace(/\\\(([\s\S]*)$/g, (_, x) => pushMath(x, false, true))
    .replace(/\$([^\s$](?:[^$\n]*?[^\s$])?)\$/g, (_, x) => mathOk(x) ? pushMath(x, false, false) : _)
    // 行内未闭合 $ 不处理（$ 单独出现太容易误判）——只处理 $$ 和 \[ 开头的块级

  const peeled = peelChoices(t);
  t = peeled.rest;
  // 模型有时会把块结束符写成 `:::>`（紧接着引用块的 > 警告标记连在同一行），
  // 把这一行拆成 `:::` 单独一行 + 后面的引用块内容（防止所有 `:::xxx` 块匹配失败 → 不渲染）。
  t = t.replace(/^:::(>[^\n]*)$/gm, (_, tail) => `:::\n${tail.startsWith('>') ? tail : `>${tail.replace(/^>/, '')}`}`);
  const folds = [];
  t = t.replace(/^:::fold[ \t]+(.+)\n([\s\S]*?)^:::[ \t]*$/gm, (_, title, body) => {
    folds.push({ title: String(title || '').trim(), body });
    return `\n\n\uE000FOLD${folds.length - 1}\uE000\n\n`;
  });
  const ALIGN_ALIAS = {
    center: 'center', centre: 'center', 居中: 'center', 居中对齐: 'center', 中: 'center',
    right: 'right', 右: 'right', 右对齐: 'right', 靠右: 'right',
  };
  const aligns = [];
  t = t.replace(/^:::(?:align[ \t]+(.+?)|([Cc]enter|[Rr]ight|居中|右对齐))[ \t]*\n([\s\S]*?)^:::[ \t]*$/gm, (_, a, b, body) => {
    const raw = String(a || b || '').trim();
    const key = ALIGN_ALIAS[raw] || ALIGN_ALIAS[raw.toLowerCase()] || '';
    if (!key) return _;
    aligns.push({ cls: key, body });
    return `\n\n\uE000ALIGN${aligns.length - 1}\uE000\n\n`;
  });
  const charts = [];
  // 直接别名（:::bar / :::柱状图 / :::桑基图 …）与 :::chart <kind> 两种写法；别名表来自 quickviz.js，长别名优先匹配
  t = t.replace(CHART_FENCE_RE, (_, info, direct, restTitle, body) => {
    const spec = parseChartInfo(info || restTitle || '', direct ? String(direct).toLowerCase() : '');
    charts.push({ ...spec, body });
    return `\n\n\uE000CHART${charts.length - 1}\uE000\n\n`;
  });
  const diagrams = [];
  t = t.replace(/^:::(?:diagram[ \t]+([^\n]+)|(flow|flowchart|mind|mindmap|mind-map|流程图|流程|思维导图|脑图)[ \t]*([^\n]*))\n([\s\S]*?)^:::[ \t]*$/gm, (_, info, direct, restTitle, body) => {
    const spec = parseDiagramInfo(info || restTitle || '', direct ? String(direct).toLowerCase() : '');
    diagrams.push({ ...spec, body });
    return `\n\n\uE000DIAGRAM${diagrams.length - 1}\uE000\n\n`;
  });
  const FONT_ALIAS = {
    楷体: 'kai', 楷: 'kai', kai: 'kai', kaiti: 'kai',
    宋体: 'song', 宋: 'song', song: 'song', songti: 'song',
    仿宋: 'fangsong', fangsong: 'fangsong',
    黑体: 'heiti', 黑: 'heiti', heiti: 'heiti', sans: 'heiti',
    行楷: 'xingkai', xingkai: 'xingkai',
    serif: 'serif', latin: 'serif', 衬线: 'serif',
    jp: 'jp', 日文: 'jp', japanese: 'jp',
  };
  const fonts = [];
  t = t.replace(/^:::font[ \t]+(.+)\n([\s\S]*?)^:::[ \t]*$/gm, (_, name, body) => {
    const raw = String(name || '').trim();
    const cls = FONT_ALIAS[raw] || FONT_ALIAS[raw.toLowerCase()] || 'serif';
    fonts.push({ cls, body });
    return `\n\n\uE000FONT${fonts.length - 1}\uE000\n\n`;
  });
  // 颜色文本：:::color <名>\n正文\n:::（正文继续走 Markdown 渲染；中英别名见 COLOR_ALIAS）
  const COLOR_ALIAS = {
    red: 'red', 红: 'red', 红色: 'red', crimson: 'red', 深红: 'red',
    blue: 'blue', 蓝: 'blue', 蓝色: 'blue',
    green: 'green', 绿: 'green', 绿色: 'green',
    orange: 'orange', 橙: 'orange', 橙色: 'orange',
    purple: 'purple', 紫: 'purple', 紫色: 'purple',
    teal: 'teal', 青: 'teal', 青色: 'teal', cyan: 'teal',
    pink: 'pink', 粉: 'pink', 粉色: 'pink',
    gold: 'gold', 金: 'gold', 金色: 'gold', yellow: 'gold', 黄: 'gold', 黄色: 'gold',
    gray: 'gray', grey: 'gray', 灰: 'gray', 灰色: 'gray',
    brown: 'brown', 棕: 'brown', 棕色: 'brown', 咖啡: 'brown',
    olive: 'olive', 橄榄: 'olive',
    accent: 'accent', 强调: 'accent', 高亮: 'accent',
  };
  const colors = [];
  t = t.replace(/^:::color[ \t]+(.+)\n([\s\S]*?)^:::[ \t]*$/gm, (_, name, body) => {
    const raw = String(name || '').trim();
    const cls = COLOR_ALIAS[raw] || COLOR_ALIAS[raw.toLowerCase()] || '';
    if (!cls) return _;
    colors.push({ cls, body });
    return `\n\n\uE000COLOR${colors.length - 1}\uE000\n\n`;
  });

  const mdExtensions = prepareMarkdownExtensions(t);
  t = mdExtensions.text;

  const restoreCb = (html) => {
    const draw = (i) => {
      const { lang, code, open, attrs } = codeBlocks[+i] || {};
      return fenceHtml(lang, code, esc, !!open, attrs);
    };
    const token = /\uE000CB(\d+)\uE000/g;
    return html.replace(/<p>\s*\uE000CB(\d+)\uE000\s*<\/p>/g, (_, i) => draw(i)).replace(token, (_, i) => draw(i));
  };
  const restoreMath = (html) => html.replace(/\uE000M(\d+)\uE000/g, (_, i) => {
    const m = maths[+i];
    if (!m) return '';
    return mathHtml(m.html, m.display, !!m.open);
  });
  const restoreInlineCodeTokens = (html) => String(html || '').replace(/\uE000IC(\d+)\uE000/g, (_, i) => `<code>${esc(inlineCodes[+i] || '')}</code>`);
  const restoreWidgets = (html) => {
    const foldAt = (_, i) => {
      const f = folds[+i];
      const innerMd = getMd();
      const inner = innerMd ? renderMarkdown(f.body) : `<p>${esc(f.body)}</p>`;
      return `<div class="md-fold" role="button" tabindex="0"><span class="chip-ico">${ICON.chevRight || ''}</span><span class="chip-name">${esc(f.title)}</span><div class="chip-detail"><div class="fold-inner md-fold-body">${inner}</div></div></div>`;
    };
    const fontAt = (_, i) => {
      const f = fonts[+i];
      const innerMd = getMd();
      const inner = innerMd ? renderMarkdown(f.body) : `<p>${esc(f.body)}</p>`;
      return `<div class="md-font md-font-${f.cls}">${inner}</div>`;
    };
    const colorAt = (_, i) => {
      const f = colors[+i];
      const innerMd = getMd();
      const inner = innerMd ? renderMarkdown(f.body) : `<p>${esc(f.body)}</p>`;
      return `<div class="md-color md-c-${f.cls}">${inner}</div>`;
    };
    const alignAt = (_, i) => {
      const a = aligns[+i];
      const innerMd = getMd();
      const inner = innerMd ? renderMarkdown(a.body) : `<p>${esc(a.body)}</p>`;
      return `<div class="md-align md-align-${a.cls}">${inner}</div>`;
    };
    const chartAt = (_, i) => {
      const c = charts[+i];
      return renderQuickChart(c.kind, c.body, c.title);
    };
    const diagramAt = (_, i) => {
      const d = diagrams[+i];
      return renderQuickDiagram(d.kind, d.body, d.title);
    };
    let out = html.replace(/<p>\s*\uE000FOLD(\d+)\uE000\s*<\/p>/g, foldAt)
      .replace(/\uE000FOLD(\d+)\uE000/g, foldAt)
      .replace(/<p>\s*\uE000ALIGN(\d+)\uE000\s*<\/p>/g, alignAt)
      .replace(/\uE000ALIGN(\d+)\uE000/g, alignAt)
      .replace(/<p>\s*\uE000CHART(\d+)\uE000\s*<\/p>/g, chartAt)
      .replace(/\uE000CHART(\d+)\uE000/g, chartAt)
      .replace(/<p>\s*\uE000DIAGRAM(\d+)\uE000\s*<\/p>/g, diagramAt)
      .replace(/\uE000DIAGRAM(\d+)\uE000/g, diagramAt)
      .replace(/<p>\s*\uE000FONT(\d+)\uE000\s*<\/p>/g, fontAt)
      .replace(/\uE000FONT(\d+)\uE000/g, fontAt)
      .replace(/<p>\s*\uE000COLOR(\d+)\uE000\s*<\/p>/g, colorAt)
      .replace(/\uE000COLOR(\d+)\uE000/g, colorAt)
      .replace(/\uE000IC(\d+)\uE000/g, (_, i) => `<code>${esc(inlineCodes[+i])}</code>`);
    if (peeled.blocks.length) out += choiceHtml(peeled.blocks);
    return out;
  };

  const md = getMd();
  if (md) {
    let html = md.render(t);
    html = restoreWidgets(html);
    html = mdExtensions.restore(html, (x) => md.renderInline(x), (x) => renderMarkdown(x));
    html = restoreInlineCodeTokens(html);
    html = restoreCb(html);
    html = restoreMath(html);
    // 独占一段的代码块去掉外层 <p>，避免 <p><pre> 嵌套
    return html.replace(/<p>(<pre[\s\S]*?<\/pre>)<\/p>/g, '$1');
  }

  // ── 内置精简回退（markdown-it 未加载时）──
  // 最小解析器也要遵守 CommonMark 的反斜杠转义；占位符避免被后续强调/链接正则误处理。
  const fallbackEscapes = [];
  t = protectFallbackEscapes(t, fallbackEscapes);
  t = esc(t);
  t = t.replace(/!\[([^\]]*)\]\((sandbox:\/\/[^)]+)\)/gi, (_, alt, src) => {
    const sb = sandboxPath(src);
    return sb ? `<img src="" alt="${alt}" data-sandbox="${esc(sb)}" class="sb-img">` : '';
  });
  t = t.replace(/^(#{1,6}) (.*)$/gm, (_, hashes, title) => {
    const n = hashes.length;
    const id = headingSlug(title.replace(/<[^>]+>/g, ''));
    return `<h${n} id="${esc(id)}">${title}</h${n}>`;
  });
  t = t.replace(/^&gt; (.*)$/gm, '<blockquote>$1</blockquote>');
  t = t.replace(/~~([^~]+?)~~/g, '<s>$1</s>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // 列表（连续行聚合）
  t = t.replace(/(?:^|\n)((?:[-*] .+(?:\n|$))+)/g, (m) => '\n<ul>' + m.trim().split('\n').map((l) => `<li>${l.replace(/^[-*] /, '')}</li>`).join('') + '</ul>');
  t = t.replace(/(?:^|\n)((?:\d+\. .+(?:\n|$))+)/g, (m) => '\n<ol>' + m.trim().split('\n').map((l) => `<li>${l.replace(/^\d+\. /, '')}</li>`).join('') + '</ol>');
  t = t.replace(/\n{2,}/g, '</p><p>').replace(/^(?!<[a-z])/, '<p>').replace(/(?!>)$/, '</p>');
  t = t.replace(/<p>\s*(<(?:h\d|ul|ol|blockquote|pre))/g, '$1').replace(/(<\/(?:h\d|ul|ol|blockquote|pre)>)\s*<\/p>/g, '$1');
  const fallbackInline = (x) => esc(x).replace(/~~([^~]+?)~~/g, '<s>$1</s>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  const fallbackHtml = restoreInlineCodeTokens(restoreMath(restoreCb(mdExtensions.restore(restoreWidgets(t), fallbackInline, (x) => renderMarkdown(x)))));
  return fallbackHtml.replace(/\uE000ESC(\d+)\uE000/g, (_, i) => esc(fallbackEscapes[+i] || ''));
}
