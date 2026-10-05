// ─── UI 层：渲染 / 交互 / 动画 ─────────────────────────────────────────
import { FALLBACK_MODELS, PROVIDER_ORDER, sortModelsInFamily, providerOf, isFreeModel, supportsFastMode, supportsVision, isImageModel, IMAGE_MODELS, imageModelLabel, DEFAULT_IMAGE_MODEL, APP_VERSION, APP_RELEASE, systemPrompt, SMART_ROUTER_ID, SMART_ROUTER_PROVIDER } from './config.js?v=2026.10.5.12';
import { routeModel, isSmartRouter, ROUTER_ICON_SVG } from './smartrouter.js';
import { REASONING_LEVELS, normalizeReasoningLevel, reasoningLevelLabel, reasoningLevelHint } from './reasoning.js';
import { isJevModel } from './jev.js';
import { createZip, fileBytesFromValue, withExtension, mimeFromPath } from './zip.js';
import { buildFileTree, collectPaths, treeStats, flattenTree } from './filetree.js';
import { fetchModels, getTransport } from './api.js?v=2026.10.5.12';
import { gatewayBase, gatewayChosenBy, setGatewayBase } from './endpoint.js';
import { estimateTokens, contextBudgetFor } from './context.js';
import { providerIcon, APP_LOGO, ICON } from './icons.js';
import { readThemePreference, writeThemePreference, THEME_STORAGE_KEY } from './theme.js';
import { autoTitle } from './titler.js';
import { SUGGESTIONS, pickSuggestions } from './suggestions.js';
import { claimsWebSearch, webRefusal } from './websearch.js';
import { effectiveApiKey, unlockAdminKey, adminUnlocked, isAdminAlias } from './adminkey.js';
import { SANDBOX_STORAGE_CAP, sandboxQuotaLabel } from './storagefmt.js';
import { filterCmds, tokenBreakdown, formatTokBreak, shortSuggest } from './commands.js';
import { pdfToImages } from './pdfpages.js';
import { summarizeTurnCost, formatUsd, priceBadgeFor } from './pricing.js';
import { relayAvailable, relaySupports, currentRelay, resetRelayProbe } from './net.js';
import { formatDecisionFootprintSummary, formatDecisionFootprintForPrompt, formatObservabilityReport, formatNexusAcceptanceReport } from './nexus.js';
// P3：编辑直播预览模块单独版本化；缺失时不影响核心对话。
import { buildEditPreview, editFoldLabel, pathsOfEdits, PREVIEW_REFRESH_MS } from './editpreview.js?v=2026.10.5.12';
import { historyWindowStart, previousHistoryWindowStart, HISTORY_WINDOW_MAX_MESSAGES, HISTORY_WINDOW_MAX_CHARS } from './history.js?v=2026.10.5.12';
import { prepareMarkdownExtensions, parsePandocAttributes, pandocAttributesHtml } from './markdown-extensions.js?v=2026.10.5.12';
import { openPhotoEditor } from './photo-editor.js?v=2026.10.5.12';
import { installLightbox } from './ui-lightbox.js?v=2026.10.5.12';
import { installFilesPanel } from './ui-files-panel.js?v=2026.10.5.12';
import { installAttachments } from './ui-attachments.js?v=2026.10.5.12';
import { getCoarseBrowserEnvironment } from './browser-env.js?v=2026.10.5.12';

// 预览窗刷新节流：直播时每 ~2.5 秒一次（换文件/收尾立即刷）
const EDIT_PREVIEW_REFRESH_MS = PREVIEW_REFRESH_MS;

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeHref = (href) => {
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
const safeImgSrc = (src) => {
  const s = String(src || '').trim();
  if (IMG_DATA_URL_RE.test(s)) return s.replace(/\s+/g, '');
  if (/^blob:/i.test(s)) return s;
  return safeHref(s);
};
const sandboxPath = (src) => {
  const s = String(src || '').trim();
  const m = /^(?:sandbox:\/\/|sandbox:)(.+)$/i.exec(s);
  if (!m) return '';
  const parts = m[1].trim().split('/').map((x) => x.trim()).filter((x) => x && x !== '.');
  if (!parts.length || parts.includes('..') || /[\u0000-\u001f]/.test(parts.join('/'))) return '';
  return parts.join('/');
};
const headingSlug = (text) => {
  const s = String(text || '').trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s-]+/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return s || 'section';
};
// P3：预览窗 HTML（最近 N 行 + 行号 + 模式/行数/字符数）。只在节流命中时重建。
const editPreviewHtml = (preview, live) => {
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

import { parseChartInfo, parseDiagramInfo, renderQuickChart, renderQuickDiagram } from './quickviz.js?v=2026.10.5.12';

function sanitizeSvgRaw(raw) {
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

function hydrateSandboxMedia(root, fs) {
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

function bindFoldRows(root) {
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

const fmtSize = (n) => {
  if (n == null) return '';
  const v = Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : 0;
  const kb = v / 1024;
  return kb > 1024 ? `${(v / 1048576).toFixed(1)}MB` : `${kb.toFixed(1)}KB`;
};

const contextBudgetLabel = (model) => {
  const b = contextBudgetFor(model);
  return b >= 1000 ? `${Math.round(b / 1000)}k` : String(b);
};

// 附件展示（用户气泡内）
function renderAttachments(atts) {
  if (!atts || !atts.length) return '';
  const items = atts.map((a) => {
    if (a.kind === 'image') {
      const src = safeImgSrc(a.dataUrl);
      return src
        ? `<button type="button" class="att-img" title="${esc(a.name)}"><img src="${src}" alt="${esc(a.name)}"></button>`
        : `<span class="att-file mono" title="内容未持久化">🖼 ${esc(a.name)}（已省略）</span>`;
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
function highlightCode(code, lang, escapeFn) {
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
function fenceHtml(lang, code, escapeFn, open = false, attributes = null) {
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
function getMd() {
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
function sysReplyHtml(text) {
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
  t = t.replace(/^:::(?:chart[ \t]+([^\n]+)|(bar|bars|line|scatter|scat|st|s-t|s–t|s—t|pie|柱状图|柱状|条形图|折线图|折线|趋势图|散点图|散点|位移时间图|位移-时间图|路程时间图|路程-时间图|饼图|饼|环形图)[ \t]*([^\n]*))\n([\s\S]*?)^:::[ \t]*$/gm, (_, info, direct, restTitle, body) => {
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

// ── Toast（底部最多堆叠 3 条，超出自动隐藏并移除最旧消息）──────────────────
export const MAX_TOAST_STACK = 3;
export function toast(msg, type = 'info', ms = 2600) {
  const wrap = $('#toasts');
  if (!wrap) return;
  const active = [...wrap.querySelectorAll('.toast:not(.leaving)')];
  while (active.length >= MAX_TOAST_STACK) {
    const oldest = active.shift();
    if (oldest) {
      oldest.classList.remove('in');
      oldest.classList.add('leaving');
      setTimeout(() => oldest.remove(), 220);
    }
  }
  const t = el('div', `toast ${type}`, `<span>${esc(msg)}</span>`);
  wrap.appendChild(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => {
    t.classList.remove('in');
    t.classList.add('leaving');
    setTimeout(() => t.remove(), 350);
  }, ms);
}

// ── 主 UI ───────────────────────────────────────────────────────────────
function fmtSpan(ms) {
  const n = Math.max(0, Math.round(Number(ms) || 0));
  if (n < 1000) return n + 'ms';
  if (n < 60000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 's';
  const min = Math.floor(n / 60000);
  const sec = Math.round((n % 60000) / 1000);
  return sec ? `${min}min ${sec}s` : `${min}min`;
}
function fmtClock(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m <= 0) return `${s}s`;
  return `${m}m ${s}s`;
}
function fmtAgo(ts) {
  const sec = Math.max(0, Math.round((Date.now() - Number(ts || 0)) / 1000));
  if (sec < 45) return 'just now';
  if (sec < 90) return '1 minute ago';
  if (sec < 3600) {
    const n = Math.round(sec / 60);
    return n === 1 ? '1 minute ago' : `${n} minutes ago`;
  }
  if (sec < 5400) return '1 hour ago';
  if (sec < 86400) {
    const n = Math.round(sec / 3600);
    return n === 1 ? '1 hour ago' : `${n} hours ago`;
  }
  const d = Math.round(sec / 86400);
  return d === 1 ? '1 day ago' : `${d} days ago`;
}

export function mountUI(store, agent) {
  const msgList = $('#messages');
  const composer = $('#composer-input');
  const sendBtn = $('#send-btn');
  const statusDot = $('#status-dot');
  const statusText = $('#status-text');
  const msgNodes = new Map();
  // 未决的高风险确认卡（每个回合结束时由 agent 作废；重绘消息时一并清掉，避免残留旧卡）
  const confirmNodes = new Map();
  const clearConfirmCards = () => {
    for (const n of confirmNodes.values()) { try { n.remove(); } catch { /* 忽略 */ } }
    confirmNodes.clear();
  };

  let rafPending = false;
  let rafMsg = null;
  const schedulePaint = (m) => {
    if (!m || !msgNodes.get(m.id)) return;
    rafMsg = m;
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const msg = rafMsg;
      rafMsg = null;
      if (!msg) return;
      const w = msgNodes.get(msg.id);
      if (w) paintAssistant(w, msg);
      scrollToBottom();
    });
  };

  // ── 主题 ──
  const SUN_SVG = '<svg class="pill-ico ico-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m4.93 19.07 1.41-1.41"/><path d="m17.66 6.34 1.41-1.41"/></svg>';
  const MOON_SVG = '<svg class="pill-ico ico-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/></svg>';
  function syncThemeToggle() {
    const t = store.state.settings.theme;
    const btn = $('#theme-toggle');
    if (!btn) return;
    // app.html 版：双图标，只显示当前状态对应的一个
    const sun = btn.querySelector('.ico-sun');
    const moon = btn.querySelector('.ico-moon');
    if (sun && moon) {
      sun.style.display = t === 'dark' ? '' : 'none';
      moon.style.display = t === 'light' ? '' : 'none';
      btn.title = t === 'dark' ? '切换到浅色' : '切换到深色';
      btn.setAttribute('aria-label', btn.title);
    } else {
      // index.html（落地页）：文字按钮 → 同步文字标签
      if (!btn.querySelector('.pill-ico')) {
        btn.textContent = t === 'dark' ? '浅色' : '深色';
        btn.title = t === 'dark' ? '切换到浅色主题' : '切换到深色主题';
      }
    }
  }
  store.state.settings.theme = readThemePreference(store.state.settings.theme || 'light');
  const applyTheme = ({ persist = true } = {}) => {
    const theme = store.state.settings.theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    if (persist) writeThemePreference(theme);
    syncThemeToggle();
  };
  applyTheme();
  window.addEventListener('storage', (event) => {
    if (event.key !== THEME_STORAGE_KEY) return;
    store.state.settings.theme = readThemePreference(event.newValue || store.state.settings.theme);
    applyTheme({ persist: false });
    if (typeof store.save === 'function') store.save();
  });
  const themeBtn = $('#theme-toggle');
  if (themeBtn) themeBtn.addEventListener('click', () => {
    store.state.settings.theme = store.state.settings.theme === 'light' ? 'dark' : 'light';
    applyTheme(); store.notify();
  });

  // ── 模型下拉 ──
  const ddBtn = $('#model-btn');
  const ddMenu = $('#model-menu');
  const ddSearch = $('#model-search');
  // 网关仍可能返回已下线的福利档；本地兜底表删了也不够，这里再挡一层。
  const HIDDEN_MODELS = new Set(['glm-5.3-flash-free']);
  // 对话模型列表：过滤掉生图模型（只能由主智能体通过 generate_image 工具调用，
  // 直接选中会绕过工具循环、破坏 Agent 特性；网关 /v1/models 里带它们时也照样隐藏）
  function mergedModels() {
    const map = new Map();
    for (const m of FALLBACK_MODELS) {
      if (HIDDEN_MODELS.has(m.id) || isImageModel(m.id) || isJevModel(m.id)) continue;
      map.set(m.id, { ...m });
    }
    for (const id of store.state.models || []) {
      if (HIDDEN_MODELS.has(id) || isImageModel(id) || isJevModel(id)) continue;
      if (!map.has(id)) map.set(id, { id, provider: providerOf(id) });
    }
    return [...map.values()];
  }
  if (HIDDEN_MODELS.has(store.state.model)) {
    store.state.model = SMART_ROUTER_ID;
    store.notify();
  }
  function renderModelMenu() {
    const q = ddSearch.value.trim().toLowerCase();
    // 隐藏通道：搜索 /system 出现「系统命令识别器」（输入命令获取系统反馈，如 /debug on）
    if (q === '/system' || q.startsWith('/system ')) {
      ddMenu.querySelectorAll('.dd-group, .dd-empty').forEach((n) => n.remove());
      const g = el('div', 'dd-group');
      g.appendChild(el('div', 'dd-group-title', `<span class="sys-gear">${ICON.system}</span><span>Dubhe Agent</span>`));
      const item = el('button', 'dd-item' + (store.state.model === '__system__' ? ' active' : ''));
      item.type = 'button';
      // 简约：一行式条目（图标 + 名称），介绍信息省略
      item.innerHTML = '<span class="dd-item-id mono">system-commands</span>';
      item.addEventListener('click', () => selectModel('__system__'));
      g.appendChild(item);
      ddMenu.appendChild(g);
      const foot = $('.dd-foot', ddMenu);
      if (foot) ddMenu.appendChild(foot);
      return;
    }
    const list = mergedModels().filter((m) => !q || m.id.toLowerCase().includes(q));
    const groups = new Map();
    for (const m of list) {
      if (!groups.has(m.provider)) groups.set(m.provider, []);
      groups.get(m.provider).push(m);
    }
    const order = [...PROVIDER_ORDER.filter((p) => groups.has(p)), ...[...groups.keys()].filter((p) => !PROVIDER_ORDER.includes(p))];
    ddMenu.querySelectorAll('.dd-group, .dd-empty').forEach((n) => n.remove());
    for (const p of order) {
      const g = el('div', 'dd-group');
      const isRouterGroup = p === SMART_ROUTER_PROVIDER;
      g.appendChild(el('div', 'dd-group-title', `${isRouterGroup ? `<span class="router-group-ico">${ROUTER_ICON_SVG}</span>` : providerIcon(p)}<span>${esc(isRouterGroup ? 'TEAMOROUTER' : p)}</span>`));
      for (const m of sortModelsInFamily(groups.get(p))) {
        const item = el('button', 'dd-item' + (m.id === store.state.model ? ' active' : ''));
        item.type = 'button';
        const hit = FALLBACK_MODELS.find((x) => x.id === m.id) || {};
        const free = isFreeModel(m.id);
        const hot = !!hit.hot;
        const cheap = !!hit.cheap || free || /haiku|mini|lite|-free$/i.test(m.id);
        const isRouter = isSmartRouter(m.id);
        item.innerHTML = isRouter
          ? `<span class="dd-item-id mono router-name">smart-router</span>
            <span class="dd-item-badges">
              <span class="badge hot">智能</span>
            </span>`
          : `<span class="dd-item-id mono">${esc(m.id)}</span>
            <span class="dd-item-badges">
              ${hot ? '<span class="badge hot">热门</span>' : ''}
              ${free ? '<span class="badge">FREE</span>' : (cheap ? '<span class="badge cheap">低价</span>' : '')}
              ${supportsVision(m.id) ? '<span class="badge vision" title="支持图片输入（多模态）"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg></span>' : ''}
            </span>`;
        item.addEventListener('click', () => selectModel(m.id));
        g.appendChild(item);
      }
      ddMenu.appendChild(g);
    }
    if (!order.length) ddMenu.appendChild(el('div', 'dd-empty', '无匹配模型'));
    const foot = $('.dd-foot', ddMenu);
    if (foot) ddMenu.appendChild(foot); // 生图模型行始终排在分组之后（sticky bottom 生效）
  }
  // ── /system 通道隔离（.17）：进入时收起真实会话现场、换一次性草稿；
  // state.js 的 commit 对 __system__ 直接跳过 → 真实会话零写入，退出后原样恢复 ──
  let preSystem = null;
  const inSystem = () => store.state.model === '__system__';
  function enterSystem() {
    if (preSystem) return;
    preSystem = { messages: store.state.messages, checkpoints: store.state.checkpoints, files: store.state.files };
    store.state.messages = []; store.state.checkpoints = []; store.state.files = {};
    // 沙箱文件也要隔离：agent.fs 换成空的（真实文件随 preSystem 暂存，退出时恢复）
    try { agent.loadFiles({}); } catch { /* 忽略 */ }
    rebuildMessages(); renderSessions(); renderFiles(); updateStats();
    syncCapLine(); // 能力行同步显示通道态，不再定格上一个模型（.18）
  }
  function exitSystem() {
    if (!preSystem) return;
    store.state.messages = preSystem.messages; store.state.checkpoints = preSystem.checkpoints; store.state.files = preSystem.files;
    preSystem = null;
    try { agent.loadFiles(store.state.files); } catch { /* 忽略 */ }
    rebuildMessages(); renderSessions(); renderFiles(); updateStats();
    syncCapLine();
  }
  // 通道内：思考/沙箱按钮灰置，会话列表禁点（防止系统输出混进 Agent 会话）
  function applySystemLock() {
    const sys = inSystem();
    for (const sel of ['#thinking-toggle', '#sandbox-toggle']) {
      const b = $(sel);
      if (!b) continue;
      b.disabled = sys;
      b.classList.toggle('sys-locked', sys);
    }
    const list = $('#session-list');
    if (list) list.classList.toggle('sys-locked', sys);
  }
  function selectModel(id) {
    if (!id) return;
    if (id === '__system__') {
      if (preSystem) { closeMenu(); return; }
      if (getBusy()) { closeMenu(); return toast('请等待当前回合结束再进入系统命令通道', 'warn'); }
      store.state.model = id;
      enterSystem();
      store.notify();
      updateModelBtn(); closeMenu(); applySystemLock();
      toast('已进入 /system 隐藏通道：直接输入 /help 查看命令（真实会话不会被写入）', 'ok', 4200);
      return;
    }
    if (preSystem) {
      if (getBusy()) { closeMenu(); return toast('请等待当前回合结束', 'warn'); }
      store.state.model = id;
      exitSystem();
      store.notify();
      updateModelBtn(); closeMenu(); applySystemLock();
      syncCapLine();
      toast('已退出隐藏通道，回到原会话', 'ok', 2400);
      return;
    }
    store.state.model = id; store.notify();
    if (typeof syncWeb === 'function') syncWeb();
    updateModelBtn(); closeMenu();
    const fast = $('#fast-toggle');
    if (fast) {
      fast.disabled = !supportsFastMode(id);
      if (store.state.settings.fastMode && !supportsFastMode(id)) {
        store.state.settings.fastMode = false; fast.classList.remove('on');
      }
    }
    syncCapLine();
  }
  function chatModels() {
    return mergedModels();
  }
  function updateModelBtn() {
    const sys = store.state.model === '__system__';
    const router = !sys && isSmartRouter(store.state.model);
    let icon, name, prov;
    if (sys) {
      icon = `<span class="sys-gear">${ICON.system || '⚙'}</span>`;
      name = 'system-commands';
      prov = 'Dubhe Agent';
    } else if (router) {
      icon = `<span class="router-ico">${ROUTER_ICON_SVG}</span>`;
      name = 'smart-router';
      prov = 'TEAMOROUTER';
    } else {
      icon = providerIcon(providerOf(store.state.model));
      name = store.state.model;
      prov = providerOf(store.state.model);
    }
    $('#model-btn-icon').innerHTML = icon;
    $('#model-btn-name').textContent = name;
    $('#model-btn-provider').textContent = prov;
    syncImageModelSelect();
  }
  // 生图模型（由 Agent 调用，不作为对话模型）：与会话绑定，切会话时同步显示
  function syncImageModelSelect() {
    const sel = $('#image-model');
    if (!sel) return;
    if (!sel.options.length) {
      for (const m of IMAGE_MODELS) {
        const o = document.createElement('option');
        o.value = m.id;
        o.textContent = `${m.label}（${m.note}）`;
        o.title = `模型 ID：${m.id}`;
        sel.appendChild(o);
      }
    }
    // 会话里存的值可能来自旧版本/导入：不在目录内就退回默认，避免 select 显示空值
    let want = store.state.imageModel;
    if (!IMAGE_MODELS.some((m) => m.id === want)) {
      want = DEFAULT_IMAGE_MODEL;
      store.state.imageModel = want;
    }
    if (sel.value !== want) sel.value = want;
  }
  $('#image-model')?.addEventListener('change', (e) => {
    store.state.imageModel = e.target.value;
    store.notify();
    toast(`生图模型已切换为 ${imageModelLabel(e.target.value)}（由 Agent 的 generate_image 工具调用）`, 'ok');
  });
  const openMenu = () => {
    renderModelMenu();
    // fixed 定位（脱离侧栏 overflow:hidden 裁剪），按按钮实际位置摆放
    const r = ddBtn.getBoundingClientRect();
    ddMenu.style.left = `${r.left}px`;
    ddMenu.style.top = `${r.bottom + 6}px`;
    ddMenu.style.width = `${Math.max(r.width + 60, 260)}px`;
    ddMenu.classList.add('open');
  };
  const closeMenu = () => ddMenu.classList.remove('open');
  ddBtn.addEventListener('click', () => ddMenu.classList.contains('open') ? closeMenu() : openMenu());
  ddSearch.addEventListener('input', renderModelMenu);
  // 搜索框一键清空（.18）
  const ddClear = $('#model-search-clear');
  if (ddClear) {
    const syncClear = () => { ddClear.hidden = !ddSearch.value; };
    ddSearch.addEventListener('input', syncClear);
    ddClear.addEventListener('click', () => { ddSearch.value = ''; syncClear(); renderModelMenu(); ddSearch.focus(); });
    syncClear();
  }
  document.addEventListener('click', (e) => { if (!$('#model-picker').contains(e.target)) closeMenu(); });
  window.addEventListener('resize', closeMenu);
  updateModelBtn();

  $('#refresh-models').addEventListener('click', async () => {
    if (!store.state.apiKey) return openKeyModal();
    $('#refresh-models').classList.add('spin');
    try {
      const list = await fetchModels(effectiveApiKey(store.state.apiKey));
      store.state.models = list; store.notify();
      renderModelMenu();
      toast(`已获取 ${list.length} 个模型（GET /v1/models）`, 'ok');
    } catch (err) { toast('模型列表获取失败：' + err.message, 'err'); }
    finally { $('#refresh-models').classList.remove('spin'); }
  });

  // ── 开关 ──
  const sandboxToggle = $('#sandbox-toggle');
  const syncSandbox = () => { sandboxToggle.classList.toggle('on', store.state.settings.sandboxEnabled); syncCapLine(); };
  sandboxToggle.addEventListener('click', () => {
    store.state.settings.sandboxEnabled = !store.state.settings.sandboxEnabled;
    syncSandbox(); store.notify();
    toast(store.state.settings.sandboxEnabled
      ? '沙箱已开启：Agent 可执行 JS/Python/C++ 代码'
      : '代码沙箱已关闭：不再执行代码，文件读写、生图与子智能体委派仍可用');
  });
  syncSandbox();

  // 联网：需探测到可用 relay（本地 server.py 或 Worker）才可开；搜索/爬虫工具按 Worker health 特性单独裁剪。
  // 原生网页搜索请求字段仍关闭，网页检索走显式 Worker 工具。
  const GLOBE_SVG = '<svg class="pill-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3.2 9.5h17.6"/><path d="M3.2 14.5h17.6"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18"/></svg>';
  const webToggle = $('#web-toggle');
  const hasRelay = () => store.state.relayOk === true;
  const syncWeb = () => {
    if (!webToggle) return;
    webToggle.innerHTML = GLOBE_SVG + '联网';
    if (!hasRelay()) {
      const checking = store.state.relayOk == null;
      webToggle.disabled = checking;
      webToggle.classList.remove('on');
      webToggle.classList.toggle('relay-checking', checking);
      webToggle.classList.toggle('degraded-off', !checking);
      webToggle.setAttribute('aria-pressed', 'false');
      webToggle.dataset.webCapabilities = '';
      webToggle.removeAttribute('aria-disabled');
      webToggle.title = checking
        ? '正在检查同源中继与 Cloudflare Worker…'
        : '点此重新探测中继（公共 Cloudflare Worker 或本地 server.py）';
      syncCapLine();
      return;
    }
    webToggle.disabled = false;
    webToggle.classList.remove('degraded-off', 'relay-checking');
    webToggle.removeAttribute('aria-disabled');
    const on = store.state.settings.webEnabled !== false;
    webToggle.classList.toggle('on', on);
    webToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
    const rel = currentRelay();
    const relName = rel ? (rel.label === 'origin' ? '同源' : rel.base) : '中继';
    const capabilities = ['fetch_url'];
    if (relaySupports('search')) capabilities.push('search_web');
    if (relaySupports('crawl')) capabilities.push('crawl_site');
    webToggle.dataset.webCapabilities = capabilities.join(' ');
    const capabilityLabels = capabilities.map((name) => ({ fetch_url: '单页抓取', search_web: '搜索', crawl_site: '站点抓取' })[name]);
    webToggle.title = on
      ? `联网已开：${relName}可用；工具表能力：${capabilityLabels.join('、')}。再点关闭。`
      : `联网已关。${relName}可用；可恢复能力：${capabilityLabels.join('、')}。点此开启。`;
    syncCapLine();
  };
  if (webToggle) {
    webToggle.addEventListener('click', async () => {
      if (!hasRelay()) {
        if (store.state.relayOk == null) return;
        store.state.relayOk = null;
        syncWeb();
        resetRelayProbe();
        let liveOk = false;
        try { liveOk = await relayAvailable(); } catch { liveOk = false; }
        store.state.relayOk = liveOk;
        if (liveOk) {
          store.state.settings.webEnabled = true;
          store.notify();
          syncWeb();
          const rel = currentRelay();
          toast(`✓ 已探测到可用中继（${rel && rel.base || '同源'}），联网抓取已开启`, 'ok', 3600);
          return;
        }
        syncWeb();
        toast('未检测到可用中继（公共 Cloudflare Worker 或本地 server.py 都不可达），联网抓取暂不可用', 'warn', 4200);
        return;
      }
      store.state.settings.webEnabled = store.state.settings.webEnabled === false;
      store.notify();
      syncWeb();
      toast(store.state.settings.webEnabled !== false
        ? '联网已开：可经中继抓取网页'
        : '联网已关', store.state.settings.webEnabled !== false ? 'ok' : 'warn');
    });
    syncWeb();
  }

  // 思考模式：关闭 或 Mini/Low/Medium/High/Max/Ultra（按模型家族映射协议参数）
  const thinkingToggle = $('#thinking-toggle');
  const thinkMenu = $('#think-menu');
  const thinkPicker = $('#think-picker');
  const closeThinkMenu = () => {
    if (thinkMenu) thinkMenu.classList.remove('open');
    if (thinkingToggle) thinkingToggle.setAttribute('aria-expanded', 'false');
  };
  const syncThinking = () => {
    const on = store.state.settings.thinking !== false;
    thinkingToggle.classList.toggle('on', on);
    thinkingToggle.classList.toggle('ultra', on && normalizeReasoningLevel(store.state.settings.reasoningLevel) === 'ultra');
    thinkingToggle.title = on
      ? `推理级别 ${reasoningLevelLabel(store.state.settings.reasoningLevel)}（点击切换 Mini/Low/Medium/High/Max/Ultra）`
      : '思考已关闭（点击选择推理级别）';
    syncCapLine();
  };
  const renderThinkMenu = () => {
    if (!thinkMenu) return;
    const on = store.state.settings.thinking !== false;
    const cur = normalizeReasoningLevel(store.state.settings.reasoningLevel);
    const rows = [`<button type="button" class="think-item${on ? '' : ' active'}" data-think="off"><span class="think-lab">Off</span><span class="think-hint">不发送思考参数</span></button>`];
    for (const lv of REASONING_LEVELS) {
      rows.push(`<button type="button" class="think-item${on && cur === lv ? ' active' : ''}" data-think="${lv}"><span class="think-lab">${reasoningLevelLabel(lv)}</span><span class="think-hint">${reasoningLevelHint(lv)}</span></button>`);
    }
    thinkMenu.innerHTML = rows.join('');
  };
  const openThinkMenu = () => {
    renderThinkMenu();
    const r = thinkingToggle.getBoundingClientRect();
    thinkMenu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 200))}px`;
    thinkMenu.style.top = `${r.bottom + 6}px`;
    thinkMenu.style.width = '196px';
    thinkMenu.classList.add('open');
    thinkingToggle.setAttribute('aria-expanded', 'true');
  };
  thinkingToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    if (thinkMenu && thinkMenu.classList.contains('open')) closeThinkMenu();
    else openThinkMenu();
  });
  if (thinkMenu) {
    thinkMenu.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-think]');
      if (!btn) return;
      const v = btn.getAttribute('data-think');
      if (v === 'off') {
        store.state.settings.thinking = false;
        toast('思考 Off');
      } else {
        store.state.settings.thinking = true;
        store.state.settings.reasoningLevel = normalizeReasoningLevel(v);
        toast(`推理级别 ${reasoningLevelLabel(v)}`);
      }
      store.notify();
      syncThinking();
      closeThinkMenu();
    });
  }
  document.addEventListener('click', (e) => {
    if (thinkPicker && !thinkPicker.contains(e.target)) closeThinkMenu();
  });
  window.addEventListener('resize', closeThinkMenu);
  syncThinking();

  const fastToggle = $('#fast-toggle');
  const syncFast = () => {
    fastToggle.classList.toggle('on', store.state.settings.fastMode);
    fastToggle.disabled = !supportsFastMode(store.state.model);
  };
  fastToggle.addEventListener('click', () => {
    store.state.settings.fastMode = !store.state.settings.fastMode;
    syncFast(); store.notify();
    toast(store.state.settings.fastMode ? '快速模式开启（service_tier=fast，2x 计费，仅 GPT 系列）' : '快速模式关闭');
  });
  syncFast();

  // ── API Key 弹窗（role=dialog + Esc 关闭 + 焦点圈定，a11y P2-3）──
  const keyModal = $('#key-modal');
  const keyInput = $('#key-input');
  let modalReturnFocus = null;
  window.openKeyModal = openKeyModal;
  function openKeyModal() {
    modalReturnFocus = document.activeElement;
    keyInput.value = store.state.apiKey;
    keyModal.classList.add('open');
    setTimeout(() => keyInput.focus(), 100);
  }
  function closeKeyModal() {
    if (!keyModal.classList.contains('open')) return;
    keyModal.classList.remove('open');
    // 归还焦点，键盘用户不迷失
    if (modalReturnFocus && modalReturnFocus.focus) modalReturnFocus.focus();
    modalReturnFocus = null;
  }
  $('#key-btn').addEventListener('click', openKeyModal);
  $('#key-close').addEventListener('click', closeKeyModal);
  // 点击遮罩区域关闭
  keyModal.addEventListener('click', (e) => { if (e.target === keyModal) closeKeyModal(); });
  document.addEventListener('keydown', (e) => {
    if (!keyModal.classList.contains('open')) return;
    if (e.key === 'Escape') { closeKeyModal(); return; }
    // 焦点圈定：Tab 只在弹窗内循环
    if (e.key === 'Tab') {
      const focusables = [$('#key-close'), keyInput, $('#key-save')];
      const idx = focusables.indexOf(document.activeElement);
      if (idx < 0) return;
      if (e.shiftKey && idx === 0) { e.preventDefault(); focusables[focusables.length - 1].focus(); }
      else if (!e.shiftKey && idx === focusables.length - 1) { e.preventDefault(); focusables[0].focus(); }
    }
  });
/** API Key 格式校验：
 *  - 空值允许（清除 key）
 *  - admin- 开头的管理员别名直接放行（isAdminAlias 另作口令校验）
 *  - 普通 key 必须以 sk-teamo- 开头，后面只允许字母数字 _-，总长度 ≥ 25
 */
function validateApiKey(s) {
  const v = String(s || '').trim();
  if (!v) return { ok: true };
  if (isAdminAlias(v)) return { ok: true };
  if (!/^sk-teamo-[A-Za-z0-9_-]+$/.test(v)) {
    return { ok: false, reason: 'Key 应以 sk-teamo- 开头，后面只能包含字母/数字/_/-' };
  }
  if (v.length < 25) return { ok: false, reason: 'Key 长度过短，请检查是否复制完整' };
  if (v.length > 200) return { ok: false, reason: 'Key 过长，请检查是否粘贴了多余字符' };
  return { ok: true };
}
  $('#key-save').addEventListener('click', async () => {
    const typed = keyInput.value.trim();
    const chk = validateApiKey(typed);
    if (!chk.ok) { toast('Key 格式错误：' + chk.reason, 'err', 5000); keyInput.focus(); keyInput.select(); return; }
    // 管理员别名：先用口令解封（解不开就拒绝保存，避免存进去一把用不了的 key）
    if (isAdminAlias(typed)) {
      const r = await unlockAdminKey(typed);
      if (!r.ok) {
        return toast(r.reason === 'bad-password' ? '管理员口令不正确（admin- 开头的密钥会被当作管理员口令）' : '管理员密钥不可用',
          'err', 5200);
      }
      store.state.apiKey = typed; store.notify();
      closeKeyModal();
      toast('管理员密钥已启用：请求会用管理员密钥发出（明文密钥不落盘、不上屏）', 'ok', 4200);
      updateKeyBtn(); updateTransportBadge();
      return;
    }
    store.state.apiKey = typed; store.notify();
    closeKeyModal();
    toast(store.state.apiKey ? 'API Key 已保存（仅存于浏览器 localStorage）' : 'API Key 已清除', 'ok');
    updateKeyBtn(); updateTransportBadge();
  });
  // 底部「API Key」按钮的文案：管理员模式下明确标出来（但不显示密钥任何片段）
  function updateKeyBtn() {
    const b = $('#key-btn');
    if (!b) return;
    const admin = isAdminAlias(store.state.apiKey);
    b.textContent = admin ? '管理员' : 'API Key';
    b.classList.toggle('admin-mode', admin);
    b.title = admin
      ? (adminUnlocked() ? '管理员密钥已启用（请求使用管理员密钥，明文不落盘）' : '管理员密钥未解封：点开重新输入口令')
      : '填入 TeamoRouter API Key（或管理员口令）';
  }
  updateKeyBtn();
  keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#key-save').click(); });

  // ── 会话记录（侧栏只做记录与切换；回滚全部在对话区）─────────────────
  function sessionActivityAt(s) {
    const msgs = (s && Array.isArray(s.messages)) ? s.messages : [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const ts = Number(msgs[i] && msgs[i].ts);
      if (ts > 0) return ts;
    }
    return Number((s && (s.createdAt || s.updatedAt)) || Date.now());
  }
  function startOfDay(ts) {
    const d = new Date(ts || Date.now());
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  function sessionSpanLabel(ts) {
    const days = Math.floor((startOfDay(Date.now()) - startOfDay(ts)) / 86400000);
    if (days <= 0) return '今天';
    if (days === 1) return '昨天';
    if (days === 2) return '前天';
    if (days <= 6) return '7天内';
    if (days <= 29) return '30天内';
    return '更早';
  }
  function sessionMeta(s) {
    const n = (s.messages || []).filter((m) => m.role === 'user').length;
    const t = new Date(sessionActivityAt(s));
    const time = t.toDateString() === new Date().toDateString()
      ? t.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      : `${t.getMonth() + 1}/${t.getDate()}`;
    return `${n} 轮 · ${time}`;
  }
  let memSelected = new Set();
  function syncMemDelBtn() {
    const btn = $('#memory-del');
    if (!btn) return;
    const n = memSelected.size;
    btn.disabled = n === 0;
    btn.textContent = n ? `删除 ${n}` : '删除';
  }
  function renderMemory() {
    const box = $('#memory-list');
    if (!box) return;
    const list = Array.isArray(store.state.memory) ? store.state.memory : [];
    box.innerHTML = '';
    memSelected = new Set([...memSelected].filter((i) => i >= 0 && i < list.length));
    if (!list.length) {
      box.innerHTML = '<div class="mem-empty">还没有长效记忆。重要约定由智能体自行记下，不能在这里手写。</div>';
      memSelected = new Set();
      syncMemDelBtn();
      return;
    }
    for (const [i, f] of list.entries()) {
      const text = String((f && (f.text || f)) || '').trim();
      if (!text) continue;
      const bubble = el('button', 'mem-bubble' + (memSelected.has(i) ? ' selected' : ''));
      bubble.type = 'button';
      bubble.setAttribute('role', 'listitem');
      bubble.dataset.mem = String(i);
      bubble.setAttribute('aria-pressed', memSelected.has(i) ? 'true' : 'false');
      bubble.title = '点击选中，可多选后删除';
      bubble.textContent = text;
      box.appendChild(bubble);
    }
    syncMemDelBtn();
  }
  function commitMemory(next) {
    store.state.memory = Array.isArray(next) ? next : [];
    if (typeof store.save === 'function') store.save(true);
    renderMemory();
  }
  const memListEl = $('#memory-list');
  if (memListEl) memListEl.addEventListener('click', (e) => {
    const bubble = e.target.closest('[data-mem]');
    if (!bubble || !memListEl.contains(bubble)) return;
    const i = Number(bubble.getAttribute('data-mem'));
    if (!Number.isInteger(i) || i < 0) return;
    if (memSelected.has(i)) memSelected.delete(i);
    else memSelected.add(i);
    bubble.classList.toggle('selected', memSelected.has(i));
    bubble.setAttribute('aria-pressed', memSelected.has(i) ? 'true' : 'false');
    syncMemDelBtn();
  });
  const memDel = $('#memory-del');
  if (memDel) memDel.addEventListener('click', () => {
    if (!memSelected.size) return;
    const cur = Array.isArray(store.state.memory) ? store.state.memory : [];
    const n = memSelected.size;
    if (!confirm(`删除选中的 ${n} 条长效记忆？不可恢复。`)) return;
    const next = cur.filter((_, i) => !memSelected.has(i));
    memSelected = new Set();
    commitMemory(next);
  });

  // 侧栏只列「有内容的」会话：空的「新对话」草稿在用户发出第一条消息之前不进列表
  //（store.listableSessions 负责过滤，「＋ 新建」也会复用空草稿，不堆 invisible 记录）
  function renderSessions() {
    const box = $('#session-list'); box.innerHTML = '';
    box.classList.toggle('sys-locked', inSystem());
    const list = store.listableSessions ? store.listableSessions() : store.sortedSessions();
    if (!list.length) {
      box.appendChild(el('div', 'sess-empty-hint', '还没有会话记录'));
      return;
    }
    let lastSpan = '';
    for (const s of list) {
      const span = sessionSpanLabel(sessionActivityAt(s));
      if (span !== lastSpan) {
        const sep = el('div', 'sess-date-sep');
        sep.textContent = span;
        box.appendChild(sep);
        lastSpan = span;
      }
      const node = el('div', 'sess-item' + (s.id === store.state.activeSessionId && store.state.model !== '__system__' ? ' active' : ''));
      node.innerHTML = `<span class="sess-main"><span class="sess-title">${esc(s.title || '新对话')}</span><span class="sess-meta">${sessionMeta(s)}</span></span>`
        + `<button class="sess-rename" type="button" title="重命名会话">${ICON.pencil || ''}</button>`
        + `<button class="sess-del" type="button" title="删除会话" aria-label="删除会话「${esc(s.title || '新对话')}」">${ICON.x}</button>`;
      node.addEventListener('click', () => switchToSession(s.id));
      const del = $('.sess-del', node);
      if (del) del.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasActive = s.id === store.state.activeSessionId;
        if (getBusy() && wasActive) return toast('当前会话正在输出，不能删这一条', 'warn');
        if (!confirm(`删除会话「${s.title || '新对话'}」？不可恢复。`)) return;
        store.deleteSession(s.id);
        // 删除任意一条后都回到空白主页；当前会话仍有内容时复用 store 的空草稿/新建草稿。
        if ((store.state.messages || []).length && typeof store.ensureDraft === 'function') store.ensureDraft();
        agent.loadFiles(store.state.files);
        wrapLazyInit = false; lazyLoadedFrom = 0;
        rebuildMessages(); renderSessions(); renderFiles(); updateStats(); renderTimeStats(); updateModelBtn();
        toast('会话已删除，已回到新对话');
      });
      const rename = $('.sess-rename', node);
      if (rename) {
        rename.addEventListener('click', (e) => { e.stopPropagation(); startRename(node, s); });
        // 双击标题也进改名（桌面用户的直觉路径）
        $('.sess-title', node).addEventListener('dblclick', (e) => { e.stopPropagation(); startRename(node, s); });
      }
      box.appendChild(node);
    }
    renderMemory();
  }

  // 就地改名：Enter 提交、Esc 取消、失焦提交；改名后 titleSource='user'，
  // Agent 的自动总结不再覆盖它
  function startRename(node, s) {
    const span = $('.sess-title', node);
    if (!span || $('.sess-rename-input', node)) return;
    const input = el('input', 'sess-rename-input');
    input.type = 'text';
    input.value = s.title || '';
    input.maxLength = 48;
    input.setAttribute('aria-label', '重命名会话');
    span.replaceWith(input);
    input.focus(); input.select();
    let closed = false;
    const done = (commit) => {
      if (closed) return;
      closed = true;
      const v = input.value.trim();
      input.replaceWith(span);
      if (commit && v && v !== (s.title || '') && typeof store.renameSession === 'function') {
        store.renameSession(s.id, v);
        toast('会话已重命名', 'ok', 1400);
      }
      renderSessions();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); done(true); }
      else if (e.key === 'Escape') { e.preventDefault(); done(false); }
    });
    input.addEventListener('blur', () => done(true));
    input.addEventListener('click', (e) => e.stopPropagation());
  }
  function switchToSession(id) {
    if (id === store.state.activeSessionId) return;
    if (inSystem()) return toast('系统命令通道内不能进入其他会话：先在模型菜单选回普通模型', 'warn');
    if (getBusy()) return toast('请等待当前回合结束再切换会话', 'warn');
    store.switchSession(id);
    agent.loadFiles(store.state.files);
    // 切换会话时重置懒加载窗口
    wrapLazyInit = false; lazyLoadedFrom = 0;
    // 模型随会话恢复：切回来后模型按钮显示该会话自己的模型，而不是上一次的全局选择
    rebuildMessages(); renderSessions(); renderFiles(); updateStats(); renderTimeStats(); updateModelBtn();
    syncThinking(); syncCapLine();
  }
  $('#new-session').addEventListener('click', () => {
    if (inSystem()) return toast('系统命令通道内不能新建会话：先在模型菜单选回普通模型', 'warn');
    if (getBusy()) return toast('请等待当前回合结束', 'warn');
    (store.ensureDraft ? store.ensureDraft() : store.createSession());
    agent.loadFiles({});
    rebuildMessages(); renderSessions(); renderFiles(); updateStats(); renderTimeStats(); updateModelBtn();
    syncThinking(); syncCapLine();
    composer.focus();
  });
  // 一键清除所有会话记录（含各自的沙箱文件与检查点）：不可恢复，所以必须确认
  $('#clear-sessions').addEventListener('click', () => {
    if (getBusy()) return toast('请等待当前回合结束', 'warn');
    const n = (store.listableSessions ? store.listableSessions() : store.sortedSessions()).length;
    if (!n) { toast('当前没有任何会话记录'); return; }
    if (!confirm(`清除全部 ${n} 条会话记录？所有消息、检查点与沙箱文件都会被删除，且不可恢复。`)) return;
    if (!confirm('再次确认：此操作不可恢复。确定清空全部会话？')) return;
    if (typeof store.clearAllSessions !== 'function') {
      return toast('浏览器缓存了旧版本代码，请硬刷新（Ctrl/Cmd + Shift + R）后再用「清空」', 'warn', 5000);
    }
    const removed = store.clearAllSessions();
    agent.loadFiles({});
    rebuildMessages(); renderSessions(); renderFiles(); updateStats(); renderTimeStats(); updateModelBtn();
    toast(`已清除 ${removed || n} 条会话记录`, 'ok');
    composer.focus();
  });
  renderSessions();

  // ── 回滚撤销浮条（对话区内，回滚后出现 8 秒）+ 粒子粉碎动画（Requirement 6）──
  const undoPill = $('#undo-pill');
  let undoTimer = null;
  let activeRollbackAnim = null;
  function cancelRollbackAnim() {
    if (activeRollbackAnim && typeof activeRollbackAnim.cancel === 'function') {
      activeRollbackAnim.cancel();
    }
    activeRollbackAnim = null;
  }
  function showUndoPill() {
    undoPill.classList.add('show');
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => undoPill.classList.remove('show'), 8000);
  }
  undoPill.addEventListener('click', () => {
    cancelRollbackAnim();
    undoPill.classList.remove('show');
    if (store.undoRollback()) { rebuildMessages(); renderSessions(); updateStats(); toast('已撤销回滚'); }
  });
  function disintegrateMessageNodes(nodes, onDone) {
    cancelRollbackAnim();
    const list = (nodes || []).filter((n) => n && n.isConnected);
    const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!list.length || reduced || typeof HTMLCanvasElement === 'undefined') {
      onDone && onDone();
      return;
    }
    const hostRect = msgList.getBoundingClientRect();
    if (!(hostRect.width > 0 && hostRect.height > 0)) {
      onDone && onDone();
      return;
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const canvas = document.createElement('canvas');
    canvas.className = 'rollback-particle-canvas';
    canvas.style.cssText = `position:fixed;left:${hostRect.left}px;top:${hostRect.top}px;width:${hostRect.width}px;height:${hostRect.height}px;pointer-events:none;z-index:60;`;
    canvas.width = Math.round(hostRect.width * dpr);
    canvas.height = Math.round(hostRect.height * dpr);
    document.body.appendChild(canvas);
    const ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) {
      canvas.remove();
      onDone && onDone();
      return;
    }
    ctx.scale(dpr, dpr);
    const dark = document.documentElement.dataset.theme === 'dark';
    // 小黑色微粒调色盘：高精细度墨黑/炭黑/石墨微尘（深色模式下混入少量深灰炭粒保证清晰层次）
    const BLACK_MICRO_PALETTE = dark
      ? ['#09090b', '#111110', '#18181b', '#27272a', '#3f3f46', '#52525b', '#71717a']
      : ['#050505', '#09090b', '#111110', '#18181b', '#27272a', '#3f3f46', '#52525b'];
    const particles = [];
    for (const node of list) {
      const r = node.getBoundingClientRect();
      node.style.height = `${r.height}px`;
      node.classList.add('msg-disintegrating');
      const relX = r.left - hostRect.left;
      const relY = r.top - hostRect.top;
      const w = Math.max(40, Math.min(r.width, hostRect.width));
      const h = Math.max(24, Math.min(r.height, hostRect.height));
      if (relY + r.height < -40 || relY > hostRect.height + 40) continue;
      const area = w * h;
      // 提升粒子密度与空间采样精细度（分层网格抖动采样 + 微米级墨粒尺寸 0.65px ~ 2.2px）
      const count = Math.max(260, Math.min(720, Math.round(area / 92)));
      const cols = Math.max(12, Math.round(Math.sqrt(count * (w / Math.max(1, h)))));
      const rowsGrid = Math.max(6, Math.ceil(count / cols));
      const cellW = w / cols;
      const cellH = h / rowsGrid;
      for (let i = 0; i < count; i++) {
        const gx = i % cols;
        const gy = Math.floor(i / cols) % rowsGrid;
        const px = relX + (gx + 0.15 + Math.random() * 0.7) * cellW;
        const py = Math.max(0, Math.min(hostRect.height, relY + (gy + 0.15 + Math.random() * 0.7) * cellH));
        const wave = ((px - relX) / Math.max(1, w)) * 0.44 + ((py - relY) / Math.max(1, h)) * 0.2;
        const angle = (Math.random() - 0.5) * Math.PI * 1.35 - Math.PI * 0.32;
        const speed = 22 + Math.random() * 84;
        particles.push({
          x: px,
          y: py,
          vx: Math.cos(angle) * speed + (Math.random() - 0.34) * 36,
          vy: Math.sin(angle) * speed - (16 + Math.random() * 42),
          size: 0.65 + Math.random() * 1.55,
          rot: Math.random() * Math.PI * 2,
          vrot: (Math.random() - 0.5) * 11,
          phase: Math.random() * Math.PI * 2,
          delay: wave * 210 + Math.random() * 55,
          life: 460 + Math.random() * 260,
          color: BLACK_MICRO_PALETTE[i % BLACK_MICRO_PALETTE.length],
          grainKind: i % 4, // 0,1: 极细圆点墨尘；2: 微矩炭粒；3: 锐利微晶碎屑
        });
      }
    }
    const t0 = performance.now();
    let lastT = t0;
    let rafId = 0;
    let finished = false;
    const finish = (runCallback) => {
      if (finished) return;
      finished = true;
      if (rafId) cancelAnimationFrame(rafId);
      canvas.remove();
      if (activeRollbackAnim && activeRollbackAnim.canvas === canvas) activeRollbackAnim = null;
      if (runCallback && onDone) onDone();
    };
    activeRollbackAnim = { canvas, cancel: () => finish(false) };
    const tick = (now) => {
      if (finished) return;
      const dt = Math.min(0.05, Math.max(0.001, (now - lastT) / 1000));
      lastT = now;
      const elapsed = now - t0;
      ctx.clearRect(0, 0, hostRect.width, hostRect.height);
      let alive = 0;
      for (const p of particles) {
        const local = elapsed - p.delay;
        if (local < 0) { alive++; continue; }
        const prog = local / p.life;
        if (prog >= 1) continue;
        alive++;
        // 微湍流旋涡扰动 + 轻盈上浮墨尘感
        const turbX = Math.sin(prog * 8.5 + p.phase) * 20;
        const turbY = Math.cos(prog * 6.5 + p.phase) * 12;
        p.x += (p.vx + turbX) * dt;
        p.y += (p.vy + turbY) * dt;
        p.vy -= 24 * dt;
        p.vx *= (1 - 1.05 * dt);
        p.rot += p.vrot * dt;
        const alpha = Math.max(0, (1 - prog) * (1 - prog * 0.58));
        const s = Math.max(0.35, p.size * (1 - prog * 0.42));
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(p.x, p.y);
        ctx.fillStyle = p.color;
        if (p.grainKind <= 1) {
          ctx.beginPath();
          ctx.arc(0, 0, s * 0.68, 0, Math.PI * 2);
          ctx.fill();
        } else if (p.grainKind === 2) {
          ctx.rotate(p.rot);
          ctx.fillRect(-s * 0.55, -s * 0.55, s * 1.1, s * 1.1);
        } else {
          ctx.rotate(p.rot);
          ctx.beginPath();
          ctx.moveTo(-s * 0.85, -s * 0.45);
          ctx.lineTo(s * 0.95, -s * 0.15);
          ctx.lineTo(s * 0.3, s * 0.9);
          ctx.lineTo(-s * 0.65, s * 0.55);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
      }
      if (alive > 0 && elapsed < 780) {
        rafId = requestAnimationFrame(tick);
      } else {
        finish(true);
      }
    };
    rafId = requestAnimationFrame(tick);
  }
  function doRollback(m) {
    if (getBusy()) return toast('请等待当前回合结束');
    if (!confirm('回滚到本轮对话之前？该轮及其后的消息将被移除（可撤销）。')) return;
    const msgs = store.state.messages || [];
    const idx = msgs.findIndex((x) => x.id === m.id);
    let userIdx = idx;
    while (userIdx >= 0 && msgs[userIdx].role !== 'user') userIdx--;
    const targetCount = userIdx >= 0 ? userIdx : idx;
    const discardedIds = new Set(targetCount >= 0 ? msgs.slice(targetCount).map((x) => x.id) : [m.id]);
    const discardedNodes = $$('.msg', msgList).filter((n) => discardedIds.has(n.dataset.id));
    store.rollbackBeforeMessage(m.id);
    renderSessions(); updateStats(); showUndoPill();
    toast('已回滚，可点击「撤销回滚」恢复', 'ok');
    if (discardedNodes.length) {
      disintegrateMessageNodes(discardedNodes, () => rebuildMessages());
    } else {
      rebuildMessages();
    }
  }

  // ── 侧栏 & 沙箱面板收起体系 ───────────────────────────────────────────
  // 宽屏：两者都并入网格（收起=列宽归零，展开=挤压布局，绝不遮挡内容）
  // 中等桌面宽度：沙箱面板改右侧浮层；移动窄屏才自底部全屏滑入，✕ / Esc 收回
  const sidebar = $('.sidebar');
  const panel = $('#sandbox-panel');
  const backdrop = $('#overlay-backdrop');
  const fab = $('#sidebar-fab');
  const mqSidebar = window.matchMedia('(max-width: 860px)');
  const mqPanel = window.matchMedia('(max-width: 1180px)');

  function updateBackdrop() {
    const show = (mqSidebar.matches && sidebar.classList.contains('sidebar-open'))
      || (mqPanel.matches && !panel.classList.contains('collapsed'));
    backdrop.classList.toggle('show', show);
  }
  function setPanelCollapsed(v) {
    panel.classList.toggle('collapsed', v);
    // 以前这里把按钮内容整体替换成两个方块符号字符：既丢掉了 pill 的「SVG 图标 + 中文文字」统一外观，
    // 又在窄屏下把按钮压到 30 多像素宽（点不中）。改成切状态类 + 提示语，外观与其它 pill 一致。
    const btn = $('#panel-toggle');
    btn.classList.toggle('on', !v);
    btn.setAttribute('aria-pressed', v ? 'false' : 'true');
    btn.title = v ? '沙箱面板已收起（文件树 / 下载 / 清空）：点开' : '沙箱面板已展开：点此收起';
    if (typeof syncCapLine === 'function') syncCapLine();
    // 面板浮层会盖住内容：打开时关掉移动侧栏；关闭靠面板内 ✕ / Esc，也可点遮罩。
    if (!v && mqSidebar.matches) sidebar.classList.remove('sidebar-open');
    updateBackdrop();
  }
  function setSidebarOpen(open) {
    sidebar.classList.toggle('sidebar-open', open);
    const t = $('#sidebar-toggle');
    if (t) {
      t.title = mqSidebar.matches ? '关闭侧栏' : '收起侧栏';
      t.setAttribute('aria-label', t.title);
      t.setAttribute('aria-expanded', mqSidebar.matches ? String(open) : String(!sidebar.classList.contains('collapsed')));
    }
    if (open && mqPanel.matches && !panel.classList.contains('collapsed')) setPanelCollapsed(true);
    else updateBackdrop();
  }
  $('#panel-toggle').addEventListener('click', () => setPanelCollapsed(!panel.classList.contains('collapsed')));
  $('#panel-close')?.addEventListener('click', () => setPanelCollapsed(true));
  $$('[data-panel-tab]').forEach((b) => {
    b.addEventListener('click', () => {
      const id = b.dataset.panelTab;
      $$('[data-panel-tab]').forEach((x) => x.classList.toggle('on', x.dataset.panelTab === id));
      const files = $('#tab-files');
      const mem = $('#tab-memory');
      if (files) files.hidden = id !== 'files';
      if (mem) mem.hidden = id !== 'memory';
    });
  });
  $('#sidebar-toggle').addEventListener('click', () => {
    if (mqSidebar.matches) setSidebarOpen(false);
    else sidebar.classList.add('collapsed');
  });
  fab.addEventListener('click', () => {
    if (mqSidebar.matches) setSidebarOpen(!sidebar.classList.contains('sidebar-open'));
    else sidebar.classList.remove('collapsed');
  });
  const dismissDrawers = () => {
    setSidebarOpen(false);
    if (mqPanel.matches) setPanelCollapsed(true);
    else updateBackdrop();
  };
  backdrop.addEventListener('click', dismissDrawers);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (keyModal.classList.contains('open')) return;
    if (sidebar.classList.contains('sidebar-open') || (mqPanel.matches && !panel.classList.contains('collapsed'))) {
      e.preventDefault();
      dismissDrawers();
    }
  });
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!mqSidebar.matches) sidebar.classList.remove('sidebar-open');
      updateBackdrop();
    }, 120);
  });
  // 初始：面板默认收起；侧栏宽屏展开、窄屏隐藏（由 fab 打开）
  setPanelCollapsed(true);
  updateBackdrop();


  // 品牌图标加载失败兜底（捕获阶段监听资源错误）：替换为首字母徽章
  document.addEventListener('error', (e) => {
    const t = e.target;
    if (t && t.classList && t.classList.contains('p-icon')) {
      const span = document.createElement('span');
      span.className = 'p-icon-fallback';
      span.textContent = (t.alt || '?').slice(0, 1);
      t.replaceWith(span);
    }
  }, true);
  // ── 沙箱文件面板：见 ui-files-panel.js（文件树 / 下载 ZIP / 单文件 / 预览窗）──
  const { renderFiles, openFileViewer } = installFilesPanel({ store, agent, toast, fmtSize, highlightCode, sanitizeSvgRaw, safeImgSrc });
  renderFiles();

  // ── 消息渲染 ──────────────────────────────────────────────────────────
  function loadLastSuggest() {
    try { return JSON.parse(sessionStorage.getItem('dubhe.suggest.last') || '[]'); } catch { return []; }
  }
  function saveLastSuggest(picks) {
    try { sessionStorage.setItem('dubhe.suggest.last', JSON.stringify((picks || []).map((x) => x.text))); } catch { /* 无 storage */ }
  }
  function renderEmpty() {
    if (store.state.messages.length) return;
    const jb = $('#jump-bottom');
    if (jb) jb.classList.remove('show');
    const exclude = loadLastSuggest();
    let picks = pickSuggestions(SUGGESTIONS, 3, Math.random, exclude);
    const same = picks.map((x) => x.text).join('\0') === exclude.join('\0');
    if (same && SUGGESTIONS.length > 3) picks = pickSuggestions(SUGGESTIONS, 3, Math.random, exclude);
    saveLastSuggest(picks);
    msgList.appendChild(el('div', 'empty-state', `
      <div class="empty-logo">${APP_LOGO}</div>
      <h2>Dubhe Agent</h2>
      <p>Dubhe Agent · 基于 <span class="mono">TeamoRouter</span> 网关的网页端智能体<br>模型自选 · 代码沙箱 · 对话回滚 · 工具调用循环</p>
      <div class="empty-cards">
        ${picks.map((x) => {
          const shown = x.title || (mqPanel.matches ? shortSuggest(x.text) : x.text);
          return `<button class="suggest" type="button" data-prompt="${esc(x.text)}">${esc(shown)}</button>`;
        }).join('')}
      </div>
      <button class="suggest-shuffle" type="button" title="换一批任务示例">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/></svg>换一批</button>`));
    $$('.suggest', msgList).forEach((b) => b.addEventListener('click', () => {
      composer.value = b.dataset.prompt || b.textContent;
      composer.focus(); autoGrow();
    }));
    const shuffle = $('.suggest-shuffle', msgList);
    if (shuffle) shuffle.addEventListener('click', () => { clearEmpty(); renderEmpty(); });
  }
  function clearEmpty() { const e = $('.empty-state', msgList); if (e) e.remove(); }

  function messageNode(m) {
    const wrap = el('div', `msg msg-${m.role} enter`);
    wrap.dataset.id = m.id;
    if (m.transientModeration || (m.moderation && m.moderation.blocked)) wrap.classList.add('msg-moderation');
    if (m.role === 'user') {
      wrap.innerHTML = `<div class="bubble md-body">${renderMarkdown(m.text)}${renderAttachments(m.attachments)}</div>
        <div class="msg-user-bar">
        ${m.jev && m.jev.summary ? `<div class="jev-chip" title="TypeSafe Jev 对本轮的校准分类">Jev · ${esc(m.jev.summary)}</div>` : ''}
        <div class="msg-actions msg-actions-user">
          <button class="act" data-act="copy" title="复制这条消息">${ICON.copy || ''}<span>复制</span></button>
        </div>
        </div>`;
      bindFoldRows($('.md-body', wrap) || wrap);
      $$('.act', wrap).forEach((b) => b.addEventListener('click', () => {
        if (b.dataset.act === 'copy') {
          // 优先从已渲染的 DOM 取纯文本（浏览器自动解码 HTML 实体 / URI 编码，避免 %20/&amp; 等直接进入剪贴板）；
          // 如果 body 尚未渲染再回落到原始 m.text。
          const body = $('.md-body', wrap);
          const plain = body ? body.innerText : (m.text || '');
          navigator.clipboard.writeText(plain).then(() => toast('已复制', 'ok', 1200), () => toast('复制失败：浏览器拒绝了剪贴板权限', 'err'));
        }
      }));
    } else {
      // 模型名/头像每轮（一次 user 提问开始的回合）只显示一次：
      // 仅当上一条消息是 user 时渲染 msg-head，工具循环产生的后续 assistant 消息不再重复
      const idx = store.state.messages.findIndex((x) => x.id === m.id);
      const prev = idx > 0 ? store.state.messages[idx - 1] : null;
      const moderationNotice = !!(m.transientModeration || (m.moderation && m.moderation.blocked));
      // 审核拦截消息自带 Moderator 头像与名称：它前面不是 user（用户气泡已被移除），
      // 旧逻辑 showHead 会判 false 导致「无图标无审核员」，这里强制显示
      const showHead = moderationNotice || !prev || prev.role === 'user';
      // 用这条消息生成时实际使用的模型（而不是当前选择），切换会话/换模型后回看不再张冠李戴
      // 智能路由器：消息头显示路由图标 + smart-router（不暴露真实模型）
      const headIsRouter = isSmartRouter(m.userModel);
      const headModel = m.model || store.state.model;
      let headName, headIcon;
      if (headModel === '__system__') {
        headName = 'system-commands';
        headIcon = `<span class="sys-gear">${ICON.system || '⚙'}</span>`;
      } else if (headModel === 'Moderator') {
        headName = 'Moderator · 审核员';
        headIcon = providerIcon(providerOf(headModel));
      } else if (headIsRouter) {
        headName = '智能';
        headIcon = `<span class="router-ico">${ROUTER_ICON_SVG}</span>`;
      } else {
        headName = headModel;
        headIcon = providerIcon(providerOf(headModel));
      }
      wrap.innerHTML = `
        ${showHead ? `<div class="msg-head"><span class="avatar">${headIcon}</span><span class="msg-model mono">${esc(headName)}</span><span class="msg-meta"></span></div>` : ''}
        <div class="md-body"></div>
        <div class="tool-chips"></div>
        <div class="msg-toolbar"${moderationNotice ? ' hidden' : ''}>
        <div class="msg-actions">
          <button class="act" data-act="copy" title="复制本轮回复">${ICON.copy || ''}<span>复制</span></button>
          <button class="act act-danger" data-act="rollback" title="回滚到本轮之前（将移除该轮及其后的消息）">${ICON.rollback || ''}<span>回滚</span></button>
          <button class="act act-regen" data-act="regen" title="重新生成并覆盖最近这一条回答（更早的回答请先「回滚」再重新提问）">${ICON.regen || ''}<span>重新生成</span></button>
        </div>
        <div class="msg-foot mono" hidden></div>
        </div>`;
      $$('.act', wrap).forEach((b) => b.addEventListener('click', () => {
        const act = b.dataset.act;
        if (act === 'copy') {
          // 取渲染后纯文本，自动解码 HTML 实体/URI 编码，避免 %20/&amp; 等进入剪贴板
          const body = $('.md-body', wrap);
          const plain = body ? body.innerText : (m.text || '');
          navigator.clipboard.writeText(plain).then(() => toast('已复制', 'ok', 1200), () => toast('复制失败：浏览器拒绝了剪贴板权限', 'err'));
        }
        if (act === 'rollback') doRollback(m);
        if (act === 'regen') {
          if (getBusy()) return;
          // 「重新生成」= 覆盖这一次的回答：先把旧回答从会话与视图里一起抹掉，再重跑同一轮。
          // 之前只调 agent.regenerate()：store 里旧消息删了，但 DOM 节点还挂在消息区，
          // 新回答又追加在下面 → 看起来像「没重新生成」或「生成了两条」。
          const removed = store.dropLastAssistantTurn();
          if (removed) { rebuildMessages(); toast('已覆盖上一次回答，正在重新生成…', 'ok', 1600); }
          agent.regenerate();
        }
      }));
    }
    return wrap;
  }

  // ── 「重试并联网检索」：上游模型偶发不调用服务端搜索（直接回「我上不了网」）时的补救 ──
  // 真机对照实验里，提问里写明「先联网检索再回答」能明显提高命中率，所以这里一键改写重问；
  // 不放在通用 .act 处理器里 —— 提示条是在动作条之后才挂上去的，那时监听器已经绑定完了。
  function doWebRetry(m) {
    if (getBusy()) return;
    const i = store.state.messages.findIndex((x) => x.id === m.id);
    const um = i > 0 ? store.state.messages[i - 1] : null;
    if (!um || um.role !== 'user') { toast('找不到对应的提问，请手动重新提问', 'err', 2200); return; }
    if (i !== store.state.messages.length - 1) { toast('这条不是最近一轮，请先「回滚」再重问', 'err', 2400); return; }
    if (/先联网(检索|查|搜索)/.test(um.text || '')) { toast('这一轮已经要求过「先联网检索」了 —— 建议换个模型（Claude / GPT 系列）再试', 'err', 2800); return; }
    store.dropLastAssistantTurn();   // 覆盖式重试：别把没检索到的旧回答留在上面
    store.updateMessage(um.id, { text: '先联网检索再回答：' + (um.text || '') });
    rebuildMessages();
    toast('已改写提问（先联网检索再回答），正在重试…', 'ok', 1800);
    agent.regenerate();
  }

  function paintFoot(wrap, m) {
    const foot = $('.msg-foot', wrap);
    if (!foot) return;
    if (m.role !== 'assistant' || !m.done) { foot.hidden = true; foot.textContent = ''; return; }
    if (m.toolCalls && m.toolCalls.length) { foot.hidden = true; foot.textContent = ''; return; }
    const bits = [];
    if (m.reasoningLevel && m.reasoningLevel !== 'off') bits.push(reasoningLevelLabel(m.reasoningLevel));
    const clock = m.durationMs != null ? fmtClock(m.durationMs) : '';
    const ago = m.ts ? fmtAgo(m.ts) : '';
    const time = [clock, ago].filter(Boolean).join(' | ');
    const head = bits.join(' · ');
    const line = head && time ? `${head} · ${time}` : (head || time);
    if (!line) { foot.hidden = true; foot.textContent = ''; return; }
    foot.hidden = false;
    foot.textContent = line;
    foot.title = m.reasoningLevel === 'off' ? '本轮思考 Off' : (m.ts ? new Date(m.ts).toLocaleString() : '');
  }

  const TOOL_RESULT_ERROR = /^(?:工具执行失败|图像模型调用失败|图像调用在发起前失败|未配置 TeamoRouter API Key|Python 沙箱不可用|(?:[A-Za-z][\w-]*)(?:\s+[A-Za-z][\w-]*)*\s+(?:失败|缺少|不可用|拒绝执行|错误)(?:[：:]|\b))/i;
  function toolResultFailed(text) {
    const body = String(text == null ? '' : text).trim();
    return TOOL_RESULT_ERROR.test(body)
      || /^\[git 退出码 (?!0\b)\d+\]/i.test(body)
      || /^fatal:|^error:/im.test(body)
      || /── 错误 ──|不是合法 JSON|未配置 TeamoRouter API Key/.test(body);
  }
  function toolIds(chip) {
    return String(chip && (chip.dataset.callIds || chip.dataset.callId) || '').split(',').filter(Boolean);
  }
  function hasToolOutput(chip, id) {
    return !!chip && !!chip._outs && Object.prototype.hasOwnProperty.call(chip._outs, id);
  }
  function toolCallSettled(chip, id) {
    const status = chip && chip._toolStates && chip._toolStates[id] && chip._toolStates[id].status;
    return hasToolOutput(chip, id) || status === 'ok' || status === 'error';
  }
  function syncRanCommandsFold(fold) {
    if (!fold) return;
    const children = $$('.tool-call-chip', fold);
    if (!children.length) return;
    const total = children.reduce((n, chip) => n + toolIds(chip).length, 0);
    const settled = children.reduce((n, chip) => {
      const ids = toolIds(chip);
      return n + (chip.classList.contains('done') ? ids.length : ids.filter((id) => toolCallSettled(chip, id)).length);
    }, 0);
    const allDone = children.every((chip) => chip.classList.contains('done'));
    const cancelled = children.some((chip) => chip.dataset.cancelled === 'true');
    const failed = children.some((chip) => chip.classList.contains('fail'));
    const label = $('.chip-name', fold);
    if (label) label.textContent = total === 1 ? 'Ran Command' : `Ran Commands ${total}`;
    fold.classList.toggle('done', allDone);
    fold.classList.toggle('live', getBusy() && !allDone);
    fold.classList.toggle('ok', allDone && !failed && !cancelled);
    fold.classList.toggle('fail', allDone && failed);
    const state = $('.chip-state', fold);
    if (state) {
      if (allDone && failed) {
        const firstFailure = children.find((chip) => chip.classList.contains('fail'));
        state.innerHTML = '<span class="chip-fail">✗</span>';
        state.title = firstFailure ? String(($('.chip-state', firstFailure) || {}).title || '') : '';
        state.classList.add('bad');
      } else if (allDone && cancelled) {
        state.textContent = '已停止'; state.title = ''; state.classList.remove('bad');
      } else if (allDone) {
        state.innerHTML = '<span class="chip-ok">✓</span>';
        state.title = ''; state.classList.remove('bad');
      } else {
        state.textContent = settled ? `${settled}/${total}` : '…';
        state.title = ''; state.classList.remove('bad');
      }
    }
    if (fold._userToggle == null) fold.classList.toggle('expanded', getBusy() && !allDone);
  }
  function syncToolChip(chip, { cancelled = false } = {}) {
    if (!chip) return;
    if (!chip._toolStates) chip._toolStates = {};
    if (!chip._outs) chip._outs = {};
    if (cancelled) chip.dataset.cancelled = 'true';
    const ids = toolIds(chip);
    const terminal = (id) => {
      const status = chip._toolStates[id] && chip._toolStates[id].status;
      return hasToolOutput(chip, id) || status === 'ok' || status === 'error';
    };
    const allDone = chip.dataset.cancelled === 'true' || (ids.length > 0 && ids.every(terminal));
    const failed = chip.dataset.cancelled !== 'true' && ids.some((id) => {
      const state = chip._toolStates[id];
      return (state && state.status === 'error') || (hasToolOutput(chip, id) && toolResultFailed(chip._outs[id]));
    });
    const settled = ids.filter(terminal).length;
    const running = ids.map((id) => chip._toolStates[id]).find((x) => x && x.status === 'running');
    chip.classList.toggle('done', allDone);
    chip.classList.toggle('live', getBusy() && !allDone);
    chip.classList.toggle('running', !allDone && !!running);
    chip.classList.toggle('ok', allDone && !failed && chip.dataset.cancelled !== 'true');
    chip.classList.toggle('fail', allDone && failed);
    const state = $('.chip-state', chip);
    if (state) {
      if (chip.dataset.cancelled === 'true') {
        state.textContent = '已停止'; state.title = ''; state.classList.remove('bad');
      } else if (allDone && failed) {
        const failId = ids.find((id) => {
          const item = chip._toolStates[id];
          return (item && item.status === 'error') || (hasToolOutput(chip, id) && toolResultFailed(chip._outs[id]));
        });
        const item = chip._toolStates[failId] || {};
        const errTxt = String(item.note || chip._outs[failId] || '工具失败').slice(0, 400);
        state.innerHTML = `<span class="chip-fail" title="${esc(errTxt)}">✗</span>`;
        state.title = errTxt; state.classList.add('bad');
      } else if (allDone) {
        const dur = ids.map((id) => chip._toolStates[id] && chip._toolStates[id].durationMs).find((x) => Number.isFinite(Number(x)));
        state.innerHTML = `<span class="chip-ok">✓</span>${dur != null ? ` <span class="chip-time">${fmtSpan(dur)}</span>` : ''}`;
        state.title = ''; state.classList.remove('bad');
      } else {
        state.textContent = running ? (running.note || '执行中…') : (settled ? `${settled}/${ids.length}` : '…');
        state.title = running ? (running.note || '') : ''; state.classList.remove('bad');
      }
    }
    if (chip._userToggle == null) chip.classList.toggle('expanded', !allDone && chip.dataset.cancelled !== 'true');
    syncRanCommandsFold(chip.closest('.ran-commands'));
  }

  function renderToolChipDetail(chip) {
    if (!chip || !chip._detail) return;
    const ids = toolIds(chip);
    const items = chip._items || [];
    const argJson = (value) => {
      try { return JSON.stringify(value == null ? {} : value); } catch { return String(value); }
    };
    const argHtml = items.length > 1
      ? items.map((t, i) => `<div class="chip-args">#${i + 1} ${esc(argJson(t.args))}</div>`).join('')
      : `<div class="chip-args">参数 ${esc(argJson(chip._args))}</div>`;
    const outHtml = ids.map((id, i) => {
      const label = ids.length > 1 ? `<div class="chip-args">出参 #${i + 1}</div>` : '';
      if (hasToolOutput(chip, id)) {
        const value = String(chip._outs[id] == null ? '' : chip._outs[id]);
        return `${label}<pre class="chip-result">${esc(value || '（空输出）')}</pre>`;
      }
      const status = chip._toolStates && chip._toolStates[id] && chip._toolStates[id].status;
      if (status === 'ok' || status === 'error') {
        const note = chip._toolStates[id].note || (status === 'ok' ? '工具已结束，但未收到出参。' : '工具失败，但未收到结果正文。');
        return `${label}<pre class="chip-result tool-result-missing">${esc(note)}</pre>`;
      }
      return '';
    }).join('');
    chip._out = ids.filter((id) => hasToolOutput(chip, id)).map((id) => String(chip._outs[id] == null ? '' : chip._outs[id])).join('\n\n');
    const detailSig = JSON.stringify([items.map((t) => t.args), ids.map((id) => hasToolOutput(chip, id) ? chip._outs[id] : null)]);
    if (chip._detailSig !== detailSig) {
      chip._detailSig = detailSig;
      chip._detail.innerHTML = `<div class="fold-inner">${argHtml}${outHtml}</div>`;
    }
  }

  function paintAssistant(wrap, m) {
    wrap.classList.toggle('cancelled', !!m.cancelled);
    const body = $('.md-body', wrap);
    let html = '';
    const noOutputYet = !m.text && !m.reasoning && !(m.toolCalls && m.toolCalls.length);
    // 光标/连接动画只属于「正在跑的这一条」。导入的历史回复没有 done 字段，
    // 不能靠 !m.done 一直闪烁 —— 必须叠上本轮忙碌状态。
    const live = !m.done && getBusy();
    // 思考过程：Off 本轮不画。Claude 5 / GPT / Gemini 常只返回签名或 reasoning_tokens、没有正文。
    const thinkOn = m.reasoningLevel !== 'off';
    const showThink = thinkOn && m.reasoning;
    const hiddenThink = thinkOn && !m.reasoning && (m.thoughtHidden || (m.usage && m.usage.reasoning) || (m.thinkingBlocks && m.thinkingBlocks.length));
    if (live && noOutputYet && !thinkOn) {
      // 连接动画：请求已发出但首字未到（网关排队 / TTFB 慢），明确提示当前状态
      html += `<div class="connect-line"><span class="connect-ring" aria-hidden="true"></span><span>正在连接 <b class="mono">${esc(m.model || store.state.model)}</b>，等待首个响应…</span></div>`;
    }
    html += m.model === '__system__' ? sysReplyHtml(m.text) : renderMarkdown(m.text || '');
    if (live && !noOutputYet) html += '<span class="cursor"></span>';
    if (m.cancelled) html += '<span class="cancelled-tag">已停止</span>';
    const lengthCapped = /^(length|max_tokens|max_output_tokens)$/i.test(String(m.finishReason || ''));
    if (m.done && !String(m.text || '').trim() && !(m.toolCalls && m.toolCalls.length) && !m.error) {
      html += lengthCapped
        ? '<div class="trunc-note">输出在长度上限前结束，未收到可见正文。请点击「重新生成」重试。</div>'
        : '<div class="trunc-note">模型未返回可见答复。请点击「重新生成」重试。</div>';
    } else if (m.done && lengthCapped) {
      html += '<div class="trunc-note">输出碰到长度上限，未写完。再说「继续」或点重新生成。</div>';
    }
    body.innerHTML = html;
    body.classList.toggle('empty', !String(html || '').trim());
    hydrateSandboxMedia(body, agent.fs);
    bindFoldRows(body);
    const msgs = store.state.messages;
    const idx = msgs.findIndex((x) => x.id === m.id);
    const followedByUser = idx >= 0 && msgs.slice(idx + 1).some((x) => x.role === 'user' && !x.silent);
    for (const box of $$('.choice-box', body)) {
      if (!m.done || followedByUser) box.remove();
    }
    // 思考过程与工具芯片同构：整行 click + .expanded + .chip-detail，不用 <details>
    // 有可见思考正文时边流边展开；思考结束（正文/工具出现或 round done）自动折叠。
    // 流式时只改 fold-inner，禁止整段 innerHTML（会把 0fr→1fr 动画打回 0 高，看起来像没流式）。
    let reason = $('.reasoning', wrap);
    const thinkPending = live && thinkOn && !m.cancelled && !showThink && !hiddenThink;
    if (showThink || hiddenThink || thinkPending) {
      if (!reason) {
        reason = el('div', 'reasoning');
        reason.addEventListener('click', (e) => {
          if (e.target.closest('a, button, .chip-copy')) return;
          reason.classList.toggle('expanded');
          wrap._reasonUser = reason.classList.contains('expanded');
        });
        reason.innerHTML = `<span class="think-ico">${ICON.thinking || ''}</span><span class="mono chip-name"></span><span class="chip-state"></span><div class="chip-detail reason-detail"><div class="fold-inner"></div></div>`;
        wrap.insertBefore(reason, body);
      }
      const bits = [];
      // 注意：不再把「思考中」塞进 bits——title 已经是「思考中」，重复会出现「思考中 · 思考中」（.17）
      if (m.reasoningLevel && m.reasoningLevel !== 'off') bits.push(reasoningLevelLabel(m.reasoningLevel));
      if (hiddenThink && m.usage && m.usage.reasoning) bits.push(`${m.usage.reasoning} tok`);
      if (m.reasoningMs) bits.push(fmtSpan(m.reasoningMs));
      // 思考进行中（本轮还没有正文/工具）只显示「思考中」，完成后才定名为「思考过程」
      const thinkStreaming = live && !m.text && !(m.toolCalls && m.toolCalls.length);
      const title = (showThink || thinkPending) ? (thinkStreaming ? '思考中' : '思考过程') : '已思考';
      const nameEl = $('.chip-name', reason);
      const stateEl = $('.chip-state', reason);
      if (nameEl) nameEl.textContent = title;
      if (stateEl) stateEl.textContent = bits.join(' · ');
      const inner = $('.fold-inner', reason);
      const detail = showThink
        ? (live ? `<pre class="think-stream">${esc(m.reasoning)}</pre>` : renderMarkdown(m.reasoning))
        : (hiddenThink
          ? '<div class="think-hidden">该模型在网关侧做了推理，但不返回可见思考文本。DeepSeek、GLM、Claude Haiku 会显示正文。</div>'
          : '');
      const sig = `${live ? 'live' : 'done'}:${(m.reasoning || '').length}:${hiddenThink ? 1 : 0}`;
      if (inner && inner.dataset.sig !== sig) {
        inner.dataset.sig = sig;
        // 流式思考：只改既有 <pre> 的 textContent（整段 innerHTML 会让长思考逐帧重建，越流越卡）
        const pre = live && showThink ? inner.querySelector('pre.think-stream') : null;
        if (pre) pre.textContent = m.reasoning || '';
        else inner.innerHTML = detail;
        if (!live) {
          hydrateSandboxMedia($('.reason-detail', reason) || reason, agent.fs);
          bindFoldRows($('.reason-detail', reason) || reason);
        }
      }
      const thinkLive = live && (thinkPending || !!m.reasoning) && !m.text && !(m.toolCalls && m.toolCalls.length);
      const autoOpen = thinkLive;
      reason.classList.toggle('live', thinkLive);
      reason.classList.toggle('expanded', wrap._reasonUser == null ? autoOpen : !!wrap._reasonUser);
    } else if (reason) {
      reason.remove();
    }
    if (m.webSearch) body.appendChild(webNote(m.webSearch));
    // 诚实性护栏：正文说「已联网搜索」但本轮没有任何服务端检索事件 → 如实提醒，不替模型背书
    else if (m.done && m.role === 'assistant' && claimsWebSearch(m.text)) {
      const warn = el('div', 'web-note warn');
      warn.innerHTML = '<span class="web-fail">未见检索事件</span>'
        + '<span>本轮没有收到任何网页搜索事件（模型的「已联网」说法无法证实），其中的具体数字请另行核实</span>';
      body.appendChild(warn);
    }
    // 开关开着、模型却回「我上不了网」：上游没去调用服务器搜索（网关侧实测会发生），给一句可操作提示
    else if (m.done && m.role === 'assistant' && store.state.settings.webEnabled !== false && webRefusal(m.text)) {
      const hint = el('div', 'web-note hint');
      hint.innerHTML = '<span class="web-hint">联网开关是开着的，但本轮没有发生检索</span>'
        + '<span>上游模型自己没调用服务端搜索（网关侧偶发）。需要实时数据的话，点右边的按钮用同一句提问重试（会自动写明「先联网检索再回答」），或换个模型重问一次</span>'
        + `<button class="act web-act" data-act="web-retry" title="同一句提问重试，并在提问前面写明「先联网检索再回答」">${ICON.globe || ''}<span>重试并联网检索</span></button>`;
      body.appendChild(hint);
      const wb = $('.web-act', hint);
      if (wb) wb.addEventListener('click', (e) => { e.preventDefault(); doWebRetry(m); });
    }
    if (m.error) body.innerHTML += `<div class="err-box">⚠ ${esc(m.error)}</div>`;
    // 所有命令收在 Ran Commands；读/写/识图分别进入 Explored / Edited File(s)。
    const chips = $('.tool-chips', wrap);
    const groups = [];
    const seen = new Map();
    for (const t of (m.toolCalls || [])) {
      if (['write_file', 'read_file', 'analyze_image'].includes(t.name)) continue;
      if (!seen.has(t.name)) {
        const g = { name: t.name, items: [] };
        seen.set(t.name, g);
        groups.push(g);
      }
      seen.get(t.name).items.push(t);
    }
    const sig = groups.map((g) => `${g.name}:${g.items.map((t) => t.id).join('+')}`).join('|');
    if (chips.dataset.sig !== sig) {
      chips.dataset.sig = sig;
      chips.innerHTML = '';
      if (groups.length) {
        const fold = el('div', 'ran-commands');
        fold.dataset.sig = sig;
        fold._userToggle = null;
        fold.innerHTML = `<span class="chip-ico">${ICON.tool || ''}</span><span class="mono chip-name"></span><span class="chip-state">…</span><div class="chip-detail"><div class="fold-inner"><div class="ran-command-items"></div></div></div>`;
        fold.addEventListener('click', (e) => {
          if (e.target.closest('.tool-call-chip, a, button, .chip-copy')) return;
          fold.classList.toggle('expanded');
          fold._userToggle = fold.classList.contains('expanded');
        });
        chips.appendChild(fold);
        const itemsBox = $('.ran-command-items', fold);
        for (const g of groups) {
          const child = el('div', 'chip tool-call-chip');
          const ids = g.items.map((t) => t.id).filter(Boolean);
          child.dataset.callIds = ids.join(',');
          child.dataset.callId = ids[0] || '';
          child.innerHTML = `<span class="chip-ico">${ICON.tool || ''}</span><span class="mono chip-name">${esc(g.items.length > 1 ? `${g.name} ×${g.items.length}` : g.name)}</span><span class="chip-json"><button type="button" class="chip-copy" data-which="in" title="复制入参 JSON">入参</button><button type="button" class="chip-copy" data-which="out" title="复制出参 JSON">出参</button></span><span class="chip-state">…</span>`;
          child.addEventListener('click', (e) => {
            if (e.target.closest('.chip-copy, button, a')) return;
            child.classList.toggle('expanded');
            child._userToggle = child.classList.contains('expanded');
          });
          const detail = el('div', 'chip-detail mono');
          child.appendChild(detail);
          child._detail = detail;
          child._items = g.items.map((t) => ({ id: t.id, args: t.args, name: t.name }));
          child._args = g.items.length === 1 ? g.items[0].args : g.items.map((t) => t.args);
          child._outs = {};
          child._toolStates = {};
          itemsBox.appendChild(child);
        }
      }
    }
    const fold = $('.ran-commands', chips);
    if (fold) {
      const resultById = new Map((store.state.messages || [])
        .filter((x) => x && x.role === 'tool' && x.toolCallId != null)
        .map((x) => [String(x.toolCallId), x]));
      for (const g of groups) {
        const ids = g.items.map((t) => String(t.id || '')).filter(Boolean);
        const child = $$('.tool-call-chip', fold).find((x) => String(x.dataset.callIds || '') === ids.join(','));
        if (!child) continue;
        child._items = g.items.map((t) => ({ id: t.id, args: t.args, name: t.name }));
        child._args = g.items.length === 1 ? g.items[0].args : g.items.map((t) => t.args);
        for (const id of ids) {
          const tm = resultById.get(id);
          if (tm) {
            const body = String(tm.content == null ? '' : tm.content);
            child._outs[id] = body;
            const previous = child._toolStates[id] || {};
            child._toolStates[id] = { ...previous, status: previous.status === 'error' || toolResultFailed(body) ? 'error' : 'ok' };
          }
        }
        if (m.cancelled) {
          syncToolChip(child, { cancelled: true });
        } else {
          if (m.done && !getBusy()) {
            for (const id of ids) if (!toolCallSettled(child, id)) child._toolStates[id] = { status: 'error', note: '工具结果缺失' };
          }
          syncToolChip(child);
        }
        renderToolChipDetail(child);
      }
      syncRanCommandsFold(fold);
    }
    // 连续 Edited / Explored File 合并到同一轮最后一条对应工具的助手消息，避免连着两块
    const msgsAll = store.state.messages;
    const idxA = msgsAll.findIndex((x) => x.id === m.id);
    const pathsOf = (msg, name) => [...new Set((msg && msg.toolCalls || []).filter((c) => c.name === name && c.args && c.args.path).map((c) => String(c.args.path)))];
    const imagePaths = (() => {
      try {
        return (agent && agent.fs && agent.fs.list ? agent.fs.list() : [])
          .map((f) => String(f && f.path || ''))
          .filter((p) => /\.(?:png|jpe?g|webp|gif)$/i.test(p));
      } catch { return []; }
    })();
    const decodeRawJsonString = (raw, key) => {
      const re = new RegExp('"' + key + '"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"');
      const match = re.exec(raw);
      if (!match) return '';
      try { return JSON.parse('"' + match[1] + '"'); } catch { return match[1]; }
    };
    const pathsOfAnalyze = (msg) => {
      const out = [];
      for (const call of (msg && msg.toolCalls || [])) {
        if (call.name !== 'analyze_image') continue;
        const args = call.args && typeof call.args === 'object' ? call.args : {};
        const raw = String(args.__raw || '');
        let declared = [];
        if (Array.isArray(args.paths)) declared = args.paths.map(String);
        else if (args.path) declared = [String(args.path)];
        if (!declared.length && raw) {
          const rawPaths = /"paths"\s*:\s*\[([\s\S]*?)(?:\]|$)/.exec(raw);
          if (rawPaths) {
            for (const q of rawPaths[1].matchAll(/"((?:\\.|[^"\\])*)"/g)) {
              try { declared.push(String(JSON.parse('"' + q[1] + '"'))); } catch { /* incomplete stream fragment */ }
            }
          }
          if (!declared.length) {
            const path = decodeRawJsonString(raw, 'path');
            if (path) declared = [path];
          }
        }
        const prefix = String(args.prefix || decodeRawJsonString(raw, 'prefix') || '');
        if (!declared.length && prefix) declared = imagePaths.filter((path) => path.startsWith(prefix));
        const toolMsg = (store.state.messages || []).find((x) => x.role === 'tool' && String(x.toolCallId) === String(call.id));
        const result = String(toolMsg && toolMsg.content != null ? toolMsg.content : '');
        const found = /^\[识图完成\][^\n]*?· 文件 (.*?) · 全文 \d+ 字/.exec(result);
        if (found) declared = found[1].split('、').map((path) => path.trim()).filter(Boolean);
        else if (!declared.length && imagePaths.length === 1) declared = [imagePaths[0]];
        for (const path of declared) {
          const page = /^(.*)-p\d+(\.[^.]+)$/i.exec(path);
          if (page) {
            const siblings = imagePaths.filter((candidate) => {
              const match = /^(.*)-p\d+(\.[^.]+)$/i.exec(candidate);
              return match && match[1] === page[1] && match[2].toLowerCase() === page[2].toLowerCase();
            }).sort((a, b) => Number((/-p(\d+)\./i.exec(a) || [])[1] || 0) - Number((/-p(\d+)\./i.exec(b) || [])[1] || 0));
            out.push(...(siblings.length ? siblings : [path]));
          } else out.push(path);
        }
      }
      return [...new Set(out)];
    };
    const pathsOfExplored = (msg) => [...new Set([...pathsOf(msg, 'read_file'), ...pathsOfAnalyze(msg)])];
    // P3：写文件类的路径要走 editpreview —— 流式期间 args 是半截 JSON（{__raw}），
    // 只有它能从「还没写完的文本」里把 path 扫出来，否则直播行会一直空着直到整段写完。
    const pathsOfEdit = (msg) => {
      const calls = (msg && msg.toolCalls) || [];
      if (!calls.length) return [];
      try {
        if (agent && typeof agent.getEditPaths === 'function') return agent.getEditPaths(calls);
      } catch { /* 旧内核没有该 API → 用界面自己加载的纯函数兜底 */ }
      return pathsOfEdits(calls);
    };
    const mergedPaths = (name, extractor = (msg) => pathsOf(msg, name)) => {
      let later = false;
      if (idxA >= 0) {
        for (let i = idxA + 1; i < msgsAll.length; i++) {
          if (msgsAll[i].role === 'user') break;
          if (msgsAll[i].role === 'assistant' && extractor(msgsAll[i]).length) { later = true; break; }
        }
      }
      const out = [];
      if (!later && idxA >= 0) {
        const seen = new Set();
        for (let i = idxA; i >= 0; i--) {
          const x = msgsAll[i];
          if (x.role === 'user') break;
          if (x.role !== 'assistant') continue;
          const ps = extractor(x);
          if (!ps.length) break;
          for (let j = ps.length - 1; j >= 0; j--) {
            const p = ps[j];
            if (!seen.has(p)) { seen.add(p); out.unshift(p); }
          }
        }
      } else if (!later) {
        out.push(...extractor(m));
      }
      return out;
    };
    // 同一轮里同名折叠只留最后一条消息上的那一块（重复节点会让「合并后的清单」看起来被分成两块）
    const dropEarlierFold = (cls, extractor) => {
      if (idxA < 0) return;
      for (let i = idxA - 1; i >= 0; i--) {
        const x = msgsAll[i];
        if (x.role === 'user') break;
        if (x.role !== 'assistant') continue;
        if (!extractor(x).length) break;
        const w = msgList.querySelector(`.msg-assistant[data-id="${CSS.escape(x.id)}"]`);
        const old = w && $(`.${cls}`, w);
        if (old) {
          old.remove();
          syncAssistantShell(w);
        }
      }
    };
    const paintPathFold = (cls, name, icon, one, many, afterEl, extractor = (msg) => pathsOf(msg, name)) => {
      const paths = mergedPaths(name, extractor);
      let node = $(`.${cls}`, wrap);
      if (paths.length) {
        if (!node) {
          node = el('div', cls);
          node.addEventListener('click', (e) => {
            if (e.target.closest('a, button, .chip-copy')) return;
            node.classList.toggle('expanded');
            node._userToggle = node.classList.contains('expanded');
          });
          afterEl.after(node);
        } else if (node.previousElementSibling !== afterEl) {
          afterEl.after(node);
        }
        const label = paths.length === 1 ? one : `${many} ${paths.length}`;
        node.innerHTML = `<span class="chip-ico think-ico">${icon || ''}</span><span class="mono chip-name">${esc(label)}</span><div class="chip-detail"><div class="fold-inner"><ul>${paths.map((x) => `<li class="mono">${esc(x)}</li>`).join('')}</ul></div></div>`;
        // 与思考/工具芯片同构：流式期间展开，回合完成后自动折叠（用户手动展开过则尊重）
        if (node._userToggle == null) node.classList.toggle('expanded', !!live);
        dropEarlierFold(cls, extractor);
      } else if (node) node.remove();
      return $(`.${cls}`, wrap) || afterEl;
    };
    // P3：写文件的折叠行 = 直播「Editing File(s)」+ 下方预览窗（最近 ~10 行，节流刷新）。
    // 完成后自动变回「Edited File(s) N」并折叠——展开时仍能看到最后写入的内容。
    const paintEditFold = (afterEl, liveNow) => {
      const paths = mergedPaths('write_file', pathsOfEdit);
      const calls = (m && m.toolCalls) || [];
      let node = $('.edited-files', wrap);
      if (paths.length) {
        const previewOf = () => {
          if (!calls.length) return null;
          try {
            if (agent && typeof agent.getEditPreview === 'function') return agent.getEditPreview(calls);
          } catch { /* 旧内核 → 本地纯函数 */ }
          return buildEditPreview(calls);
        };
        const preview = previewOf();
        // 预览窗按「文件 + 行数 + 字符数 + 状态」做签名：内容没变就不重排（长文件逐帧重建是卡顿主因）
        const sig = [liveNow ? 'live' : 'done', paths.join('\u0001'), preview ? `${preview.lineCount}/${preview.chars}/${preview.status}` : 'none'].join('\u0002');
        const now = Date.now();
        if (!node) {
          node = el('div', 'edited-files');
          node.addEventListener('click', (e) => {
            if (e.target.closest('a, button, .chip-copy')) return;
            node.classList.toggle('expanded');
            node._userToggle = node.classList.contains('expanded');
          });
          afterEl.after(node);
          node._sig = '';
        } else if (node._prev !== afterEl) {
          afterEl.after(node);
        }
        node._prev = afterEl;
        const label = editFoldLabel(paths.length, { live: !!liveNow });
        // 节流：直播期间预览窗每 EDIT_PREVIEW_REFRESH_MS 刷一次；换文件或收尾时立刻刷（不然窗口会落后几秒）
        const pathChanged = node._previewPath !== (preview && preview.path || '');
        const throttleOk = !liveNow || node._previewAt == null || (now - node._previewAt) >= EDIT_PREVIEW_REFRESH_MS;
        if (node._sig !== sig && (pathChanged || throttleOk)) {
          node._sig = sig;
          node._previewAt = now;
          node._previewPath = (preview && preview.path) || '';
          const head = `<span class="chip-ico think-ico">${ICON.edited || ''}</span><span class="mono chip-name">${esc(label)}</span>` +
            (preview && liveNow ? `<span class="chip-state ep-state">${esc(preview.complete ? '写入完成' : '写入中…')}</span>` : '');
          const list = `<ul>${paths.map((x) => `<li class="mono">${esc(x)}</li>`).join('')}</ul>`;
          const win = preview ? editPreviewHtml(preview, liveNow) : '';
          node.innerHTML = `${head}<div class="chip-detail"><div class="fold-inner">${list}${win}</div></div>`;
        }
        if (node._userToggle == null) node.classList.toggle('expanded', !!liveNow);
        dropEarlierFold('edited-files', pathsOfEdit);
      } else if (node) node.remove();
      return $('.edited-files', wrap) || afterEl;
    };
    const afterRead = paintPathFold('explored-files', 'read_file', ICON.file, 'Explored File', 'Explored Files', chips, pathsOfExplored);
    paintEditFold(afterRead, live);
    // meta（无 msg-head 的续消息没有该节点；多轮工具调用时汇总整轮 token 与官方预估价格到本轮首条 msg-head）
    paintTurnMeta(wrap, m);
    paintFoot(wrap, m);
    syncAssistantShell(wrap);
    // 复制/回滚/重新生成的显隐统一交给 refreshActionVisibility（回合结束才显示）
    refreshActionVisibility();
  }

  function syncAssistantShell(w) {
    if (!w || !w.classList.contains('msg-assistant')) return;
    const hasHead = !!$('.msg-head', w);
    const bodyEl = $('.md-body', w);
    const hasBody = !!(bodyEl && !bodyEl.classList.contains('empty') && String(bodyEl.innerHTML || '').trim());
    const hasReason = !!$('.reasoning', w);
    const chipsEl = $('.tool-chips', w);
    const hasChips = !!(chipsEl && chipsEl.children.length > 0);
    const hasExplored = !!$('.explored-files', w);
    const hasEdited = !!$('.edited-files', w);
    const footEl = $('.msg-foot', w);
    const hasFoot = !!(footEl && !footEl.hidden && String(footEl.textContent || '').trim());
    const emptyShell = !hasHead && !hasBody && !hasReason && !hasChips && !hasExplored && !hasEdited && !hasFoot;
    w.classList.toggle('msg-collapsed', emptyShell);
  }

  function collectTurnCostInfo(m) {
    const msgs = store.state.messages || [];
    const idx = msgs.findIndex((x) => x.id === m.id);
    if (idx < 0) {
      const c = summarizeTurnCost({ messages: [m], model: m.model || store.state.model, fastMode: !!(m.fastMode ?? store.state.settings.fastMode) });
      return { headMsg: m, turnDone: !!m.done, hasUsage: !!m.usage, summary: c };
    }
    let start = idx;
    while (start > 0 && msgs[start - 1].role !== 'user') start--;
    const turnAssistants = [];
    for (let i = start; i < msgs.length; i++) {
      if (i > start && msgs[i].role === 'user') break;
      if (msgs[i].role === 'assistant') turnAssistants.push(msgs[i]);
    }
    const headMsg = turnAssistants[0] || m;
    const lastA = turnAssistants[turnAssistants.length - 1] || m;
    const turnDone = turnAssistants.length > 0
      && turnAssistants.every((x) => !!x.done)
      && (!getBusy() || !(lastA.toolCalls && lastA.toolCalls.length));
    const hasExplicitUsage = turnAssistants.some((x) => x.usage && (x.usage.input != null || x.usage.output != null));
    const toolCosts = [];
    for (const a of turnAssistants) {
      for (const tc of a.toolCalls || []) {
        if (!tc) continue;
        if (tc.billing) {
          toolCosts.push(tc.billing);
        } else if (tc.name === 'generate_image') {
          const args = tc.args || {};
          toolCosts.push({
            kind: 'image',
            model: args.model || store.state.imageModel || DEFAULT_IMAGE_MODEL,
            size: (tc.width && tc.height) ? `${tc.width}x${tc.height}` : (args.size || '1024x1024'),
            quality: args.quality || 'auto',
            count: Number(args.n) || 1,
          });
        } else if (tc.name === 'analyze_image') {
          const tm = msgs.find((x) => x.role === 'tool' && x.toolCallId === tc.id);
          const outChars = tm && tm.content ? String(tm.content).length : 600;
          toolCosts.push({
            kind: 'vision',
            model: 'deepseek-v4-flash-vision-exp',
            usage: { input: 1600, output: Math.max(120, Math.ceil(outChars / 2)) },
            imageCount: 1,
          });
        }
      }
    }
    const normalizedAssistants = turnAssistants.map((a) => {
      if (a.usage && (a.usage.input != null || a.usage.output != null)) return a;
      if (!a.done || a.model === 'Moderator' || a.model === '__system__') return a;
      if (!a.text && !a.reasoning && !(a.toolCalls && a.toolCalls.length)) return a;
      const prevMsgs = msgs.slice(0, msgs.indexOf(a));
      const estIn = Math.max(64, estimateTokens(prevMsgs));
      const estOut = Math.max(1, estimateTokens([{ role: 'assistant', text: (a.text || '') + (a.reasoning || '') }]));
      return { ...a, usage: { input: estIn, output: estOut }, _estimatedUsage: true };
    });
    const hasAnyUsage = hasExplicitUsage || normalizedAssistants.some((a) => !!a.usage) || toolCosts.length > 0;
    const summary = summarizeTurnCost({
      messages: normalizedAssistants,
      model: headMsg.model || store.state.model,
      fastMode: !!(headMsg.fastMode ?? store.state.settings.fastMode),
      toolCosts,
      jevUsage: headMsg.jevUsage,
    });
    return { headMsg, turnDone: turnDone || (!!m.done && !getBusy()), hasUsage: hasAnyUsage, summary };
  }

  function paintTurnMeta(wrap, m) {
    const info = collectTurnCostInfo(m);
    const targetWrap = (info.headMsg && msgNodes.get(info.headMsg.id)) || wrap;
    const meta = $('.msg-meta', targetWrap);
    if (!meta) return;
    const headModel = (info.headMsg && info.headMsg.model) || m.model || '';
    if (headModel === 'Moderator' || headModel === '__system__') {
      meta.innerHTML = '';
      return;
    }
    const parts = [];
    // 智能路由器：任务完成后显示芯片，点击显示服务商（不暴露具体模型）
    const routerInfo = info.headMsg && info.headMsg.router ? info.headMsg.router : (m.router || null);
    if (routerInfo) {
      parts.push(`<button type="button" class="router-chip" data-router-info="1" title="智能路由器选择的服务提供商（不显示具体模型）">${ROUTER_ICON_SVG}<span>${esc(routerInfo.chosenProvider)}</span></button>`);
    }
    if (info.hasUsage) {
      const s = info.summary;
      const costReady = info.turnDone;
      const costHtml = costReady ? ` · <span class="tok-cost" title="按模型官方列表价预估（含识图/生图/子智能体）">${esc(s.formatted)}</span>` : '';
      const tipParts = [`本轮 API 用量：输入 ${s.inputTokens} tok / 输出 ${s.outputTokens} tok${s.reasoningTokens ? `（含推理 ${s.reasoningTokens} tok）` : ''}`];
      if (costReady) {
        tipParts.push(`官方定价预估：${s.formatted}`);
        if (s.visionUsd > 0) tipParts.push(`含识图模型：${formatUsd(s.visionUsd)}`);
        if (s.imageUsd > 0) tipParts.push(`含生图模型：${formatUsd(s.imageUsd)}`);
        if (s.subagentUsd > 0) tipParts.push(`含子智能体：${formatUsd(s.subagentUsd)}`);
      }
      parts.push(`<button type="button" class="tok-btn" title="${esc(tipParts.join(' · '))}">↑${s.inputTokens} ↓${s.outputTokens} tok${costHtml}</button>`);
    }
    const tr = (info.headMsg && info.headMsg.transport) || m.transport;
    if (tr) parts.push(tr === 'proxy' ? '中继' : '直连');
    meta.innerHTML = parts.join(' · ');
    const tb = $('.tok-btn', meta);
    if (tb) tb.addEventListener('click', (e) => { e.stopPropagation(); showTokBreak(tb, info); });
  }

  // 操作条显隐规则：
  //   ① 复制 / 重新生成 只出现在「本轮末尾」的 assistant 消息上（每轮一次）
  //   ② 整轮输出没结束（流式、工具执行、子智能体跑着）时，本轮所有按钮一律不显示
  //      —— 用户要的是「输出完了再动手」，半截输出上点复制/回滚都不是想要的结果
  // 联网来源条：搜索由模型服务端完成，这里只把「查了什么、来自哪儿」亮出来（含引用链接）
  function webNote(w) {
    const box = el('div', 'web-note');
    const sources = (w.sources || []).filter((x) => x && x.url).slice(0, 6);
    if (w.status === 'searching') box.innerHTML = '<span class="web-dot"></span><span>联网检索中…</span>';
    else if (w.status === 'error') {
      // 上游检索服务不可用（如 Anthropic 的 error_code:"unavailable"）：如实说清，不显示「0 条来源」
      box.innerHTML = `<span class="web-fail">联网检索未成功</span><span class="mono">${esc(String(w.message || '上游未返回结果').slice(0, 90))}</span>`
        + (sources.length ? '' : '<span class="web-hint">可稍后重试，或换用其它支持原生联网的模型</span>');
    }
    else {
      // 各家原生格式给的计数字段不一致（有的只给 sources），取两者较大值，别显示「0 条来源」
      const n = Math.max(Number(w.results) || 0, sources.length);
      const q = (w.queries || []).slice(0, 2).map((x) => `「${String(x).slice(0, 40)}」`).join(' ');
      box.innerHTML = `<span class="web-tag">联网</span><span>${q ? esc(q) + ' · ' : ''}服务端检索到 ${n} 条来源</span>`;
      if (sources.length) {
        const ul = el('div', 'web-srcs');
        for (const x of sources) {
          const a = el('a', 'web-src'); a.href = x.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
          a.textContent = String(x.title || x.url).slice(0, 90);
          ul.appendChild(a);
        }
        box.appendChild(ul);
      }
    }
    return box;
  }

  function refreshActionVisibility() {
    const msgs = store.state.messages;
    const busy = getBusy();
    const turnStartOf = (i) => {
      while (i > 0 && msgs[i].role !== 'user') i--;
      return msgs[i] && msgs[i].role === 'user' ? i : -1;
    };
    const readyByStart = new Map();
    const turnReady = (start) => {
      if (start < 0) return false;
      if (readyByStart.has(start)) return readyByStart.get(start);
      let anyAssistant = false, allDone = true;
      for (let k = start + 1; k < msgs.length && msgs[k].role !== 'user'; k++) {
        if (msgs[k].role === 'assistant') { anyAssistant = true; if (!msgs[k].done) allDone = false; }
      }
      const v = !busy && anyAssistant && allDone;
      readyByStart.set(start, v);
      return v;
    };
    // 每轮末尾的 assistant（按轮起点记住）+ 整个会话最后一条 assistant（「重新生成」才给）
    const lastAssistantOfTurn = new Map();
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].role !== 'assistant') continue;
      const st = turnStartOf(i);
      if (st >= 0) lastAssistantOfTurn.set(st, msgs[i].id);
    }
    const lastOverall = [...msgs].reverse().find((x) => x.role === 'assistant');
    for (const wrap of $$('.msg-user, .msg-assistant', msgList)) {
      const idx = msgs.findIndex((x) => x.id === wrap.dataset.id);
      if (idx < 0) continue;
      const m = msgs[idx];
      const start = m.role === 'user' ? idx : turnStartOf(idx);
      const ready = turnReady(start);
      const show = m.role === 'user' ? ready : ready && lastAssistantOfTurn.get(start) === m.id;
      wrap.classList.toggle('actions-pending', !show);
      const regen = $('.act-regen', wrap);
      if (regen) regen.style.display = show && lastOverall && lastOverall.id === m.id ? '' : 'none';
      if (m.role === 'assistant') syncAssistantShell(wrap);
    }
  }
  function appendMessage(m) {
    clearEmpty();
    const wrap = messageNode(m);
    msgNodes.set(m.id, wrap);
    wrap._msg = m;
    if (m.role === 'assistant') {
      // 新 assistant 消息重置流式计数，避免跨消息泄漏
      wrap._streamRevealAt = 0;
      paintAssistant(wrap, m);
    }
    msgList.appendChild(wrap);
    if (m.role === 'assistant') refreshActionVisibility();
    scrollToBottom();
  }

  function renderLazyLoadMoreBtn() {
    const btn = el('button', 'lazy-load-more', `${ICON.chevRight || ''}<span>更早的消息</span>`);
    btn.type = 'button';
    btn.title = `加载更早的完整轮次（每段最多 ${LAZY_WINDOW} 条可见消息 / ${LAZY_MAX_CHARS.toLocaleString()} 字）`;
    btn.addEventListener('click', () => {
      // 记住当前滚动位置的锚点消息，展开后保持视觉位置不跳
      const firstMsg = msgList.querySelector('.msg-user, .msg-assistant');
      const anchorId = firstMsg ? firstMsg.dataset.id : null;
      const anchorOffset = firstMsg ? firstMsg.getBoundingClientRect().top : 0;
      lazyLoadedFrom = previousHistoryWindowStart(store.state.messages, lazyLoadedFrom, LAZY_WINDOW, LAZY_MAX_CHARS);
      rebuildMessages();
      // 锚点回位
      requestAnimationFrame(() => {
        if (anchorId) {
          const anchor = msgList.querySelector(`[data-id="${CSS.escape(anchorId)}"]`);
          if (anchor) {
            const newTop = anchor.getBoundingClientRect().top;
            msgList.scrollTop += newTop - anchorOffset;
          }
        }
        // 如果已加载全部，移除按钮
        if (lazyLoadedFrom <= 0) {
          const b = $('.lazy-load-more', msgList);
          if (b) b.remove();
        }
      });
    });
    return btn;
  }

  // ── 长会话分段加载 ─────────────────────────────────────────────
  const LAZY_WINDOW = HISTORY_WINDOW_MAX_MESSAGES;
  const LAZY_MAX_CHARS = HISTORY_WINDOW_MAX_CHARS;
  let lazyLoadedFrom = 0;   // 已加载的消息数组起始下标
  let wrapLazyInit = false; // 标记 rebuildMessages 是否已做过首次窗口计算

  function rebuildMessages() {
    cancelRollbackAnim();
    clearConfirmCards();
    msgNodes.clear(); msgList.innerHTML = '';
    renderEmpty();
    // 收集可见消息（跳过 tool/silent）
    const visible = store.state.messages.filter((m) => m.role !== 'tool' && !m.silent);
    // 首屏同时受可见消息数与字符数限制；history.js 只在完整用户轮次边界切分。
    if (!wrapLazyInit) {
      lazyLoadedFrom = historyWindowStart(store.state.messages, LAZY_WINDOW, LAZY_MAX_CHARS);
      wrapLazyInit = true;
    }
    // 如果还有更早的消息没渲染，顶部放"展开更早对话"按钮
    if (lazyLoadedFrom > 0) {
      // 统计 skipped 里有多少可见消息
      let skipped = 0;
      for (let i = 0; i < lazyLoadedFrom; i++) {
        const mm = store.state.messages[i];
        if (mm.role !== 'tool' && !mm.silent) skipped++;
      }
      const btn = renderLazyLoadMoreBtn();
      const badge = document.createElement('span');
      badge.className = 'lazy-load-count';
      badge.textContent = skipped > 99 ? '99+' : String(skipped);
      btn.appendChild(badge);
      msgList.appendChild(btn);
    }
    for (let i = lazyLoadedFrom; i < store.state.messages.length; i++) {
      const m = store.state.messages[i];
      if (m.role === 'tool' || m.silent) continue;
      appendMessage(m);
    }
    for (const n of $$('.msg', msgList)) n.classList.remove('enter');
    // 把 tool 结果回填到芯片（需要在可见范围内查找）
    for (const m of store.state.messages) if (m.role === 'tool') attachToolResult(m);
    refreshActionVisibility();
    scrollToBottom(true);
  }

  function attachToolResult(toolMsg) {
    const id = String(toolMsg && toolMsg.toolCallId != null ? toolMsg.toolCallId : '');
    if (!id) return;
    const chip = $$('.tool-call-chip', msgList).find((c) => toolIds(c).includes(id));
    if (!chip) return;
    const body = String(toolMsg.content == null ? '' : toolMsg.content);
    if (!chip._outs) chip._outs = {};
    if (!chip._toolStates) chip._toolStates = {};
    chip._outs[id] = body; // 空字符串也是已收到的出参，不能被当成「结果还没回来」
    const previous = chip._toolStates[id] || {};
    chip._toolStates[id] = {
      ...previous,
      status: previous.status === 'error' || toolResultFailed(body) ? 'error' : 'ok',
    };
    syncToolChip(chip);
    renderToolChipDetail(chip);
  }

  function scrollToBottom(force) {
    const near = msgList.scrollHeight - msgList.scrollTop - msgList.clientHeight < 160;
    if (near || force) msgList.scrollTo({ top: msgList.scrollHeight, behavior: 'smooth' });
  }

  // ── 定位到最新输出（向上滚动超过阈值时浮现；空状态初始页绝不显示）─────
  const jumpBtn = $('#jump-bottom');
  msgList.addEventListener('scroll', () => {
    if (!store.state.messages || store.state.messages.length === 0 || $('.empty-state', msgList)) {
      jumpBtn.classList.remove('show');
      return;
    }
    const dist = msgList.scrollHeight - msgList.scrollTop - msgList.clientHeight;
    jumpBtn.classList.toggle('show', dist > 240);
  }, { passive: true });
  jumpBtn.addEventListener('click', () => {
    jumpBtn.classList.remove('show');
    scrollToBottom(true);
  });

  // ── 状态栏（连接/生成过程可见化：脉冲状态点 + 跳动点 + 实时耗时）──────
  const STATUS = {
    idle: ['', 'ok'],
    moderating: ['连接模型中', 'busy'],  // 对用户只显示「连接模型中」，不暴露审核过程（避免心理负担）；fail-closed 拦截时气泡会说明
    connecting: ['连接模型中', 'busy'],
    thinking: ['思考中', 'busy'], streaming: ['生成中', 'busy'],
    executing: ['沙箱执行中', 'busy'], done: ['完成', 'ok'], error: ['出错', 'err'], cancelled: ['已停止', 'warn'],
  };
  const DOTS = '<span class="sdots" aria-hidden="true"><i></i><i></i><i></i></span>';
  let busySince = 0;
  let busyTimer = null;
  const stopBusyTicker = () => { if (busyTimer) { clearInterval(busyTimer); busyTimer = null; } };
  function paintStatus(s) {
    const [label] = STATUS[s] || STATUS.idle;
    statusText.innerHTML = `${esc(label)}${DOTS}<span class="selapsed mono"></span>`;
    paintElapsed();
  }
  // 只刷新耗时文本，绝不重建 DOTS 节点——之前 ticker 每 200ms 重写整个 innerHTML，
  // CSS 弹跳动效每帧被重置，三个点看起来一卡一卡（.17 修复）
  function paintElapsed() {
    if (!busySince) return;
    const el = statusText.querySelector('.selapsed');
    if (!el) return;
    const secs = (performance.now() - busySince) / 1000;
    el.textContent = secs >= 0.8 ? `${secs.toFixed(1)}s` : '';
  }
  function setStatus(s) {
    const [label, cls] = STATUS[s] || STATUS.idle;
    const busy = ['moderating', 'connecting', 'thinking', 'streaming', 'executing'].includes(s);
    if (busy) {
      if (!busySince) busySince = performance.now();
      statusDot.className = `dot busy ${s}`;
      if (!busyTimer) busyTimer = setInterval(paintElapsed, 100);
      paintStatus(s);
    } else {
      busySince = 0; stopBusyTicker();
      statusDot.className = 'dot ' + cls;
      // 完成态短暂回显后清空，避免状态栏留白显得突兀
      if (s === 'done') {
        statusText.textContent = label;
        setTimeout(() => { if (agent.getStatus() === 'done') statusText.textContent = ''; }, 1600);
        const lastA = [...(store.state.messages || [])].reverse().find((x) => x && x.role === 'assistant');
        if (lastA) {
          const w = msgNodes.get(lastA.id);
          if (w && typeof paintTurnMeta === 'function') paintTurnMeta(w, lastA);
        }
      } else {
        statusText.textContent = label;
      }
    }
    if (typeof refreshActionVisibility === 'function') refreshActionVisibility();
    sendBtn.classList.toggle('stop-mode', busy);
    $('#send-ico').textContent = busy ? '■' : '↑';
    sendBtn.title = busy ? '停止' : '发送 (Enter)';
    // 顶栏不确定进度条：连接阶段更快，让用户一眼看出「正在等模型响应」
    const bar = $('#turn-bar');
    if (bar) bar.classList.toggle('on', busy);
    if (bar) bar.classList.toggle('connecting', s === 'connecting' || s === 'moderating');
  }
  function getBusy() { return ['moderating', 'connecting', 'thinking', 'streaming', 'executing'].includes(agent.getStatus()); }

  function updateTransportBadge() {
    const b = $('#transport-badge');
    const proxy = getTransport() === 'proxy';
    const host = gatewayBase().replace(/^https?:\/\//, '');
    // 徽章要一眼看出「现在走哪个域名」：国内用户最关心的就是这一格（完整域名在悬停提示里）
    const short = (host.match(/teamorouter\.(com|cn)/) || [])[1] ? '.' + host.match(/teamorouter\.(com|cn)/)[1] : host;
    b.textContent = `${proxy ? '中继' : '直连'} · ${short}`;
    const by = gatewayChosenBy();
    const why = by === 'probe' ? '启动探测自动选择' : by === 'failover' ? '直连失败后自动切换' : by === 'manual' ? '手动选择' : by === 'stored' ? '沿用上次选择' : '默认';
    b.title = proxy
      ? `浏览器直连失败，已通过本地服务器代理转发（目标 ${host}）`
      : `浏览器直连 ${host}（${why}）· 点这里可切换到另一个域名（国内网络建议用 api.teamorouter.cn）`;
    syncCapLine();
  }
  // 点传输徽章 = 手动切换接入点（国内网络下用户可能知道哪个更快）
  $('#transport-badge').addEventListener('click', () => {
    const from = gatewayBase();
    const to = setGatewayBase(null, 'manual');
    updateTransportBadge();
    toast(`网关接入点已切换：${to.replace(/^https?:\/\//, '')}（原 ${from.replace(/^https?:\/\//, '')}）`, 'ok', 3200);
  });
  // 请求期发生自动切换（直连失败→换域名）时提示一次
  window.addEventListener('dubhe:endpoint-switched', (e) => {
    updateTransportBadge();
    const to = e && e.detail && e.detail.to ? e.detail.to.replace(/^https?:\/\//, '') : '';
    toast(`直连域名不可达，已自动切换到 ${to}`, 'warn', 5000);
  });

  // ── 输出用时（本轮 / 会话累计，随会话持久化）────────────────────────
  const fmtDur = (ms) => {
    if (!(ms > 0)) return '—';
    if (ms < 1000) return `${ms}ms`;
    const s = ms / 1000;
    return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  };
  function renderTimeStats() {
    const st = store.state.stats || {};
    $('#time-stats').textContent = st.totalMs ? `本轮 ${fmtDur(st.lastMs)} · 累计 ${fmtDur(st.totalMs)}` : '';
  }

  // ── 会话统计 & 导出 ───────────────────────────────────────────────────
  function hideTokPop() {
    const pop = $('#tok-pop');
    if (pop) pop.hidden = true;
  }
  function placeTokPop(anchor) {
    const pop = $('#tok-pop');
    if (!pop || pop.hidden) return;
    const r = (anchor && anchor.getBoundingClientRect) ? anchor.getBoundingClientRect() : ($('#conv-stats') || {}).getBoundingClientRect?.();
    if (!r) return;
    const pw = pop.offsetWidth || 240;
    const ph = pop.offsetHeight || 160;
    let left = Math.min(Math.max(8, r.left), window.innerWidth - pw - 8);
    let top = r.top - ph - 10;
    if (top < 8) top = Math.min(window.innerHeight - ph - 8, r.bottom + 8);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }
  function showTokBreak(anchor, turnInfo = null) {
    const pop = $('#tok-pop');
    const body = $('#tok-pop-body');
    const stats = $('#conv-stats');
    if (!pop) return;
    if (!pop.hidden) { hideTokPop(); return; }
    const sysTok = estimateTokens([{ role: 'system', text: systemPrompt(new Date(), { webEnabled: false }) }]);
    const b = tokenBreakdown(store.state.messages, estimateTokens, sysTok);
    const n = (x) => (x >= 1000 ? `${(x / 1000).toFixed(1)}k` : String(x || 0));
    const rows = [
      ['系统', b.system], ['历史', b.history], ['工具结果', b.tools], ['本轮', b.current], ['合计', b.total],
    ];
    let html = rows.map(([k, v], i) => `<div class="tok-row${i === rows.length - 1 ? ' total' : ''}"><span>${k}</span><span>${n(v)}</span></div>`).join('');
    if (turnInfo && turnInfo.summary) {
      const s = turnInfo.summary;
      const headModel = (turnInfo.headMsg && turnInfo.headMsg.model) || store.state.model;
      const rateBadge = priceBadgeFor(headModel, { fastMode: !!(turnInfo.headMsg && turnInfo.headMsg.fastMode) });
      html += `<div class="tok-row total"><span>对话模型 (${esc(rateBadge || headModel)})</span><span>${esc(formatUsd(s.chatUsd))}</span></div>`;
      if (s.visionUsd > 0) html += `<div class="tok-row"><span>识图模型</span><span>${esc(formatUsd(s.visionUsd))}</span></div>`;
      if (s.imageUsd > 0) html += `<div class="tok-row"><span>生图模型</span><span>${esc(formatUsd(s.imageUsd))}</span></div>`;
      if (s.subagentUsd > 0) html += `<div class="tok-row"><span>子智能体</span><span>${esc(formatUsd(s.subagentUsd))}</span></div>`;
      html += `<div class="tok-row total"><span>本轮预估总价</span><span>${esc(s.formatted)}</span></div>`;
    }
    if (body) body.innerHTML = html;
    const line = formatTokBreak(b);
    if (stats) stats.title = line + '（再点一次收起）';
    pop.hidden = false;
    placeTokPop(anchor && anchor.nodeType ? anchor : stats);
  }
  function updateStats() {
    const msgs = store.state.messages;
    const n = msgs.filter((m) => m.role !== 'tool').length;
    const stats = $('#conv-stats');
    if (!n) { if (stats) stats.textContent = ''; hideTokPop(); return; }
    const tk = estimateTokens(msgs);
    const budget = contextBudgetLabel(store.state.model);
    stats.textContent = `${n} 条 · ~${tk >= 1000 ? (tk / 1000).toFixed(1) + 'k' : tk} tok / ${budget}`;
    stats.title = '点击查看 token 构成（系统 / 历史 / 工具结果 / 本轮）';
    const pop = $('#tok-pop');
    if (pop && !pop.hidden) {
      pop.hidden = true;
      showTokBreak(stats);
    }
  }
  $('#export-btn').addEventListener('click', () => {
    if (!store.state.messages.length) return toast('暂无可导出的对话');
    const active = store.state.sessions.find((s) => s.id === store.state.activeSessionId) || {};
    const data = {
      app: 'Dubhe Agent', exportedAt: new Date().toISOString(), model: store.state.model,
      imageModel: store.state.imageModel, title: active.title || '',
      checkpoints: store.state.checkpoints,
      messages: store.state.messages.map((m) => ({
        role: m.role, text: m.text, content: m.content, toolCalls: m.toolCalls,
        toolCallId: m.toolCallId, name: m.name, usage: m.usage, ts: m.ts, model: m.model,
        done: m.done !== false, cancelled: !!m.cancelled,
        reasoning: m.reasoning, reasoningMs: m.reasoningMs, reasoningLevel: m.reasoningLevel,
        durationMs: m.durationMs, thinkingBlocks: m.thinkingBlocks, thoughtHidden: m.thoughtHidden,
        attachments: (m.attachments || []).map((a) => ({ kind: a.kind, name: a.name, size: a.size, stripped: !!a.stripped })),
      })),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `dubhe-agent-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('已导出会话 JSON', 'ok');
  });

  // ── 导入会话（兼容本应用导出的 JSON）────────────────────────────────
  $('#import-btn').addEventListener('click', () => $('#import-input').click());
  $('#import-input').addEventListener('change', async () => {
    const input = $('#import-input');
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    try {
      // 忙判定必须在改 store 之前：旧写法先 importSession 再判忙，
      // 回合进行中导入会把正在跑的对话数组换掉（半轮丢失 + 状态栏错乱）
      if (getBusy()) return toast('请等待当前回合结束再导入', 'warn');
      const data = JSON.parse(await file.text());
      const s = store.importSession(data);
      if (!s) return toast('导入失败：文件里没有有效的 messages 数组', 'err');
      agent.loadFiles(store.state.files);
      rebuildMessages(); renderSessions(); renderFiles(); updateStats(); renderTimeStats();
      toast(`已导入会话「${s.title}」（${s.messages.length} 条消息）`, 'ok');
    } catch (err) {
      toast('导入失败：' + err.message, 'err');
    }
  });

  // ── 附件：见 ui-attachments.js（按钮 / 相机 / 拖拽 / 粘贴 → addFiles；发送时 takePending()）──
  const attachments = installAttachments({ composer, toast, safeImgSrc, fmtSize });

  // ── 输入区 ────────────────────────────────────────────────────────────
  function autoGrow() {
    composer.style.height = 'auto';
    composer.style.height = Math.min(composer.scrollHeight, 200) + 'px';
  }
  composer.addEventListener('input', autoGrow);
  composer.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); doSend(); }
  });
  sendBtn.addEventListener('click', () => {
    if (getBusy()) { agent.abort(); return; }
    doSend();
  });
  function doSend() {
    const text = composer.value.trim();
    if (!text && !attachments.hasPending()) return;
    if (store.state.model === '__system__') {
      if (getBusy()) return;
      composer.value = ''; autoGrow();
      handleSystemCommand(text);
      return;
    }
    if (!store.state.apiKey) { openKeyModal(); toast('请先配置 TeamoRouter API Key', 'warn'); return; }
    if (getBusy()) return;
    composer.value = ''; autoGrow();
    const atts = attachments.takePending();
    agent.send(text, atts);
  }

  // ── /system 隐藏通道：命令识别器（本地执行，不走网关）──
  async function handleSystemCommand(input) {
    const raw = String(input || '').trim();
    store.pushMessage({ role: 'user', text: raw, done: true });
    const cmd = raw.replace(/^[/／]+/, '').trim();
    const sp = cmd.indexOf(' ');
    const name = (sp < 0 ? cmd : cmd.slice(0, sp)).toLowerCase();
    const arg = sp < 0 ? '' : cmd.slice(sp + 1).trim();
    let out = '';
    if (name === 'help' || !name) {
      out = [
        '⌙ /system 可用命令：',
        '/debug on | off —— 开/关调试浮窗（系统日志：网络/错误/审核全链路）',
        '/status —— 版本 / 模型 / 预热 / 审核状态',
        '/version —— 仅版本一行',
        '/env —— 查看粗略浏览器/设备环境（不读取 Cookie 或精确定位）',
        '/stats —— 会话与耗时统计',
        '/model <模型ID> —— 切换模型（需完整 ID）',
        '/models —— 列出可用模型',
        '/theme dark|light —— 切换深/浅主题',
        '/cache [clear] —— 查看离线缓存 / 清空后自动重建',
        '/key —— 查看 API Key 尾号（完整 Key 不回显）',
        '/export —— 导出全部会话记录（JSON 下载）',
        '/clear —— 清空通道草稿（真实会话不受影响）',
        '/p2 [report|policy|fault|exp] —— P2（v2.5）：策略版本 / 统一指标 / 审计三层目标 / 故障注入 / 策略实验',
        '/guard observe|strict|strict-l2 —— 执行内核高风险确认档位（L3 / L2+L3 是否需人工确认）',
        '/resume —— 查看断点续跑计划（未完成步骤 / 需先核验的产物 / 是否需重新确认）',
        '提示：模型菜单搜索 /system 可回到本识别器',
      ].join('\n');
    } else if (name === 'debug') {
      const on = /^(on|1|开|开启|open|show)$/i.test(arg);
      const off = /^(off|0|关|关闭|close|hide)$/i.test(arg);
      if (!on && !off) out = '用法：/debug on 或 /debug off';
      else if (typeof globalThis.__dubheDebugSet !== 'function') out = '调试浮窗模块未加载（旧版本缓存），请强刷页面后重试';
      else {
        const now = globalThis.__dubheDebugSet(on);
        out = now ? '✓ 调试浮窗已开启：审核全链路 / console.warn·error / Agent 状态将实时上屏（Ctrl+Alt+D 可关）'
                  : '✓ 调试浮窗已关闭';
      }
    } else if (name === 'status') {
      const log = globalThis.__dubheModLog || [];
      const pw = [...log].reverse().find((e) => e.stage === 'prewarm:done');
      out = [
        `版本：${APP_RELEASE} · 构建 ${APP_VERSION}`,
        `当前模型：${store.state.model === '__system__' ? '（未选择，处于 /system 通道）' : store.state.model}`,
        `可用模型：${chatModels().length} 个`,
        `调试浮窗：${globalThis.__dubheDebugActive && globalThis.__dubheDebugActive() ? '开启' : '关闭'}`,
        `审核模型预热：${pw ? `已完成（NudeNet ${pw.nudenet ? '✓' : '✗'} / NSFWJS ${pw.nsfwjs ? '✓' : '✗'}${pw.toxicity != null ? ` / Toxicity ${pw.toxicity ? '✓' : '✗'}` : ''}）` : '尚未执行（发图或打开页面 2 秒后自动开始）'}`,
        `内容审核：${store.state.settings.contentModeration === true ? '开启（图片 fail-closed）' : '关闭'}`,
      ].join('\n');
    } else if (name === 'version') {
      out = `Dubhe Agent ${APP_RELEASE} · 构建 ${APP_VERSION}`;
    } else if (name === 'env' || name === 'environment') {
      out = JSON.stringify(getCoarseBrowserEnvironment(), null, 2);
    } else if (name === 'stats') {
      const st = store.state.stats || {};
      const msgs = store.state.messages || [];
      const rounds = msgs.filter((m) => m.role === 'user').length;
      out = [
        `通道草稿：${msgs.length} 条消息（${rounds} 轮）`,
        `真实会话：${(store.state.sessions || []).length} 个（${preSystem ? '已隔离，未写入' : '当前'}）`,
        `最近回合：${st.lastMs ? fmtSpan(st.lastMs) : '—'}`,
        `累计耗时：${st.totalMs ? fmtSpan(st.totalMs) : '—'}`,
        '',
        formatObservabilityReport(store.state.lastNexusTelemetry),
        '',
        formatNexusAcceptanceReport({
          memory: store.state.memory || [],
          memoryArchive: store.state.memoryArchive || [],
          telemetry: store.state.lastNexusTelemetry,
          // P0 执行内核（v2.3）：报告里给出当轮真实的状态轨迹、预算账本与静默失败检测结果
          execution: {
            summary: store.state.lastExecutionRecord || null,
            acceptance: store.state.lastExecutionAcceptance || null,
          },
          trajectoryTotals: store.state.trajectoryTotals || null,
          // P2（v2.5）：策略 / 指标 / 审计三层目标 / 故障注入 / 实验 / 执行上下文
          p2Lines: (() => { try { return agent && agent.getP2ReportLines ? agent.getP2ReportLines() : []; } catch { return []; } })(),
        }),
      ].join('\n');
    } else if (name === 'guard') {
      const v = String(arg || '').toLowerCase().trim();
      const modes = { observe: '观察（记录并披露，不打断）', strict: '严格（L3 必须人工确认）', 'strict-l2': '严格+（L2 与 L3 都需确认）' };
      if (!v) out = `当前确认档位：${store.state.settings.executionGuard || 'observe'}（${modes[store.state.settings.executionGuard || 'observe']}）\n用法：/guard observe | strict | strict-l2`;
      else if (!modes[v]) out = '用法：/guard observe | strict | strict-l2';
      else {
        store.state.settings.executionGuard = v;
        store.notify();
        out = `✓ 执行内核确认档位已切换：${v}（${modes[v]}）\n高风险操作会先给出「操作 / 原因 / 影响 / 可逆性 / 参数摘要」，再由你决定是否放行；超时或未应答一律按拒绝处理。`;
      }
    } else if (name === 'p2') {
      // P2 面板：一次看全「策略版本 / 指标 / 审计三层 / 故障 / 实验 / 上下文一致性」
      const sub = String(arg || '').toLowerCase().trim();
      const lines = [];
      if (!sub || sub === 'report') {
        try { lines.push(...(agent && agent.getP2ReportLines ? agent.getP2ReportLines() : ['（执行内核未就绪）'])); } catch (e) { lines.push(`（报告生成失败：${e.message}）`); }
      }
      if (!sub || sub === 'policy') {
        try {
          const r = agent && agent.verifyPolicies ? await agent.verifyPolicies() : null;
          lines.push('', r ? (r.ok ? `✓ 策略注册表自检通过（${r.checked}/${r.total} 项）` : `⚠ 策略漂移：${r.mismatches.map((m) => `${m.key} 声明=${m.declared} 实际=${m.actual}`).join('；')}`) : '（策略自检不可用）');
        } catch (e) { lines.push(`（策略自检失败：${e.message}）`); }
      }
      if (!sub || sub === 'fault') {
        const kinds = ['tool-timeout', 'tool-empty-result', 'tool-bad-schema', 'artifact-modified-externally', 'duplicate-tool-call', 'audit-event-missing', 'capability-mask-mismatch', 'memory-instruction-conflict', 'authorization-revoked-midway'];
        const want = String(arg || '').split(/\s+/).slice(1);
        if (want.length && agent && agent.armFaultInjection) {
          const r = agent.armFaultInjection(want);
          lines.push('', r.cleared ? '✓ 已清除待注入故障' : `✓ 已装备故障注入：${r.kinds.join('、')}（下一轮生效一次）`);
        } else {
          lines.push('', '可用故障类型（下一轮生效一次）：', kinds.map((k) => `  · ${k}`).join('\n'), '用法：/p2 fault tool-timeout 或 /p2 fault tool-timeout,audit-event-missing');
        }
      }
      if (!sub || sub === 'exp') {
        const id = 'guard-default';
        try {
          const rep = agent && agent.getExperimentReport ? agent.getExperimentReport(id) : null;
          lines.push('', rep && rep.ok ? `实验 ${id}：${rep.action}（${rep.reason}）｜对照 n=${rep.control.samples} 变体 n=${rep.treatment.samples}` : `实验 ${id}：尚无足够样本（灰度默认关闭，需在设置里显式开启 allocation）`);
        } catch (e) { lines.push(`（实验汇总失败：${e.message}）`); }
      }
      out = lines.join('\n');
    } else if (name === 'resume') {
      let plan = null;
      try { plan = agent && agent.getResumePlan ? agent.getResumePlan() : null; } catch { plan = null; }
      if (!plan) out = '当前没有可续跑的执行检查点（完成一轮工具任务后才会生成）。';
      else {
        out = [
          `断点续跑计划（检查点 ${plan.checkpointId || '-'}，策略 ${plan.policyVersion || '-'}）`,
          plan.summary,
          plan.reusableSteps && plan.reusableSteps.length ? `可直接复用：${plan.reusableSteps.join('、')}` : '可直接复用：无',
          plan.verificationSteps && plan.verificationSteps.length ? `续跑前先核验：${plan.verificationSteps.join('；')}` : '续跑前先核验：无（产物与检查点一致）',
          plan.needsConfirmation ? '⚠ 涉及高风险或能力变化：续跑前需要你明确确认' : '无需重新确认',
        ].join('\n');
      }
    } else if (name === 'theme') {
      const v = String(arg || '').toLowerCase();
      if (v !== 'dark' && v !== 'light') out = '用法：/theme dark 或 /theme light';
      else { store.state.settings.theme = v; applyTheme(); store.notify(); out = `✓ 主题已切换：${v === 'dark' ? '深色' : '浅色'}`; }
    } else if (name === 'cache') {
      if (typeof caches === 'undefined') out = '当前环境不支持 Cache Storage（需 https 或 localhost）';
      else {
        const names = await caches.keys();
        if (/^(clear|清空|clean)$/i.test(arg)) {
          await Promise.all(names.map((n) => caches.delete(n)));
          out = `✓ 已清空 ${names.length} 个离线缓存。刷新页面后自动重建（模型/审核资产会重新下载一次）`;
        } else {
          let n = 0;
          for (const nm of names) { try { n += (await (await caches.open(nm)).keys()).length; } catch { /* 忽略 */ } }
          out = `离线缓存：${names.length} 个（${names.join('、') || '无'}），共 ${n} 条资产\n用法：/cache clear 清空（SW 之后自动重建）`;
        }
      }
    } else if (name === 'key') {
      const k = store.state.apiKey || '';
      out = k ? `API Key：${k.slice(0, 10)}…${k.slice(-4)}（已配置；完整 Key 不回显）` : '尚未配置 API Key（普通对话需要；/system 通道本身不需要）';
    } else if (name === 'export') {
      try {
        const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), version: APP_VERSION, sessions: store.state.sessions }, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `dubhe-sessions-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        out = `✓ 已导出 ${(store.state.sessions || []).length} 个会话（JSON，含沙箱文件清单）`;
      } catch (e) { out = `导出失败：${e && e.message ? e.message : e}`; }
    } else if (name === 'model') {
      const id = arg.trim();
      if (!id) out = '用法：/model <模型完整 ID>（如 /model claude-sonnet-5）';
      else if (id === '__system__') out = '不能切换到保留标识';
      else if (chatModels().some((m) => m.id === id)) { selectModel(id); out = `✓ 已切换模型：${id}`; }
      else out = `未找到模型「${id}」——输入 /models 查看可用列表`;
    } else if (name === 'models') {
      const ids = chatModels().map((m) => m.id);
      out = `可用模型 ${ids.length} 个：\n` + ids.join('、');
    } else if (name === 'clear') {
      store.state.messages = [];
      store.state.checkpoints = [];
      // 通道内清的是一次性草稿；真实沙箱文件只在真实会话里才动
      if (!inSystem()) { try { agent.loadFiles({}); } catch { /* 忽略 */ } }
      store.notify();
      rebuildMessages(); renderFiles(); updateStats();
      out = inSystem() ? '✓ 通道草稿已清空（真实会话不受影响）' : '✓ 当前会话消息与沙箱文件已清空（会话本身保留）';
    } else {
      out = `未知命令「${name}」——输入 /help 查看可用命令`;
    }
    store.pushMessage({ role: 'assistant', text: out, model: '__system__', done: true });
    store.notify();
    rebuildMessages(); renderSessions(); updateStats();
    const last = store.state.messages[store.state.messages.length - 1];
    if (last && last.model === '__system__') { try { scrollToBottom(); } catch { /* 忽略 */ } }
  }

  function readChoiceAnswers(box) {
    try { return JSON.parse(box.dataset.choiceAnswers || '[]'); } catch { return []; }
  }
  function writeChoiceAnswers(box, answers) {
    box.dataset.choiceAnswers = JSON.stringify((answers || []).map((x) => String(x || '')));
  }
  function setChoiceStep(box, step) {
    if (!box) return;
    const blocks = $$('.choice-qblock', box);
    const count = blocks.length || Number(box.dataset.choiceCount || 1) || 1;
    const idx = Math.max(0, Math.min(count - 1, Number(step) || 0));
    box.dataset.choiceStep = String(idx);
    blocks.forEach((b, i) => b.classList.toggle('active', i === idx));
    const answers = readChoiceAnswers(box);
    const summary = $('[data-choice-summary]', box);
    if (summary) {
      summary.innerHTML = answers.length
        ? answers.map((a, i) => a ? `<button type="button" class="choice-pill" data-choice-jump="${i}" title="回到第 ${i + 1} 题"><b>${i + 1}</b>${esc(a)}</button>` : '').join('')
        : '';
    }
    blocks.forEach((b, i) => {
      const ans = answers[i] || '';
      for (const opt of $$('.choice-opt', b)) opt.classList.toggle('selected', !!ans && opt.getAttribute('data-choice-send') === ans);
    });
    const back = $('[data-choice-back]', box);
    if (back) back.disabled = idx <= 0;
    const progress = $('[data-choice-progress]', box);
    if (progress) progress.textContent = `${idx + 1} / ${count}`;
  }
  function choiceReplyText(box) {
    const answers = readChoiceAnswers(box);
    const qs = $$('.choice-qblock', box).map((b, i) => (($('.choice-q', b) || {}).textContent || `问题 ${i + 1}`).trim());
    return answers.map((a, i) => `${qs[i] || `问题 ${i + 1}`}：${a}`).join('\n');
  }
  // 复制代码块按钮（事件委托）
  msgList.addEventListener('click', (e) => {
    // 图表选中态：点击空白处（不在任何 datum、tooltip、按钮内）→ 清空所有图表的激活态
    const inDatum = e.target.closest('[data-chart-label], .md-chart-tooltip, button, a');
    if (!inDatum) {
      $$('.md-chart [data-chart-label].is-active, .md-diagram [data-chart-label].is-active', msgList).forEach((n) => n.classList.remove('is-active'));
      $$('.md-chart .md-chart-tooltip.show', msgList).forEach((t) => t.classList.remove('show'));
    }
    const btn = e.target.closest('.copy-code');
    if (btn) {
      const block = btn.closest('.code-block') || btn.parentElement;
      const code = block.querySelector('code');
      if (!code) return;
      navigator.clipboard.writeText(code.textContent).then(() => { btn.textContent = '已复制'; setTimeout(() => (btn.textContent = '复制'), 1500); });
      return;
    }
    const jump = e.target.closest('a.md-jump, a[href^="#"]');
    if (jump && jump.getAttribute('href') && jump.getAttribute('href').startsWith('#')) {
      const wrap = jump.closest('.md-body, .msg');
      const id = decodeURIComponent(jump.getAttribute('href').slice(1));
      const target = wrap && id ? wrap.querySelector(`#${CSS.escape(id)}`) : null;
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      return;
    }
    const opt = e.target.closest('[data-choice-send]');
    if (opt) {
      if (getBusy()) return;
      const box = opt.closest('.choice-box');
      const block = opt.closest('.choice-qblock');
      if (!box || !block) return;
      const text = opt.getAttribute('data-choice-send') || '';
      if (!text) return;
      const idx = Number(block.dataset.choiceIdx || box.dataset.choiceStep || 0) || 0;
      const count = Number(box.dataset.choiceCount || $$('.choice-qblock', box).length || 1) || 1;
      const answers = readChoiceAnswers(box);
      answers.length = idx;
      answers[idx] = text;
      writeChoiceAnswers(box, answers);
      if (idx + 1 < count) {
        setChoiceStep(box, idx + 1);
        return;
      }
      if (!store.state.apiKey) { openKeyModal(); toast('请先配置 TeamoRouter API Key', 'warn'); setChoiceStep(box, idx); return; }
      const reply = choiceReplyText(box) || text;
      for (const b of $$('.choice-box', msgList)) b.remove();
      agent.send(reply, []);
      return;
    }
    const back = e.target.closest('[data-choice-back]');
    if (back) {
      e.preventDefault();
      const box = back.closest('.choice-box');
      if (!box) return;
      const target = Math.max(0, (Number(box.dataset.choiceStep || 0) || 0) - 1);
      const answers = readChoiceAnswers(box);
      answers.length = target; // 回退即清掉目标题及其后的旧选择状态
      writeChoiceAnswers(box, answers);
      setChoiceStep(box, target);
      return;
    }
    const choiceJump = e.target.closest('[data-choice-jump]');
    if (choiceJump) {
      e.preventDefault();
      const box = choiceJump.closest('.choice-box');
      if (!box) return;
      setChoiceStep(box, Number(choiceJump.getAttribute('data-choice-jump') || 0));
      return;
    }
    const chartDatum = e.target.closest('[data-chart-label]');
    if (chartDatum) {
      const chartBox = chartDatum.closest('.md-chart');
      if (chartBox) {
        const wasActive = chartDatum.classList.contains('is-active');
        chartBox.querySelectorAll('[data-chart-label].is-active').forEach((n) => n.classList.remove('is-active'));
        if (!wasActive) {
          chartDatum.classList.add('is-active');
          showChartDatumTooltip(chartBox, chartDatum);
        } else {
          hideChartDatumTooltip(chartBox);
        }
      }
      return;
    }
    const routerChip = e.target.closest('[data-router-info]');
    if (routerChip) {
      e.preventDefault(); e.stopPropagation();
      // 找到对应的 assistant 消息以拿到路由详情
      const wrap = routerChip.closest('.msg');
      let ri = null;
      if (wrap && wrap._msg && wrap._msg.router) {
        ri = wrap._msg.router;
      } else {
        const mid = wrap && wrap.dataset && wrap.dataset.id;
        for (const mm of store.state.messages) {
          if (mm.role === 'assistant' && mm.router && mid === mm.id) { ri = mm.router; break; }
        }
        if (!ri) {
          // 退而求其次：从最近一条带 router 的消息取
          for (let i = store.state.messages.length - 1; i >= 0; i--) {
            if (store.state.messages[i].role === 'assistant' && store.state.messages[i].router) { ri = store.state.messages[i].router; break; }
          }
        }
      }
      if (ri) {
        toast(`智能路由器：任务类型「${ri.categoryLabel}」· 难度「${ri.difficultyLabel}」· 路由至 ${ri.chosenProvider}`, 'ok', 4000);
      } else {
        toast('智能路由器已为本轮选择了合适的模型', 'ok');
      }
      return;
    }
    const dl = e.target.closest('[data-sb-dl]');
    if (dl) {
      e.preventDefault();
      const path = dl.getAttribute('data-sb-dl') || '';
      let raw = '';
      try { raw = agent.fs.read(path); } catch { raw = ''; }
      if (!raw) return;
      const { bytes, mime: detectedMime } = fileBytesFromValue(raw);
      const mime = (detectedMime && !detectedMime.startsWith('text/plain')) ? detectedMime : mimeFromPath(path);
      const blob = new Blob([bytes], { type: mime });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const rawName = path.split('/').pop() || 'file';
      a.download = withExtension(rawName, detectedMime && detectedMime.startsWith('image/') ? detectedMime : '');
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }
  });

  function showChartDatumTooltip(chartBox, datum) {
    if (!chartBox || !datum) return;
    let tip = chartBox.querySelector('.md-chart-tooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'md-chart-tooltip';
      chartBox.appendChild(tip);
    }
    const label = datum.getAttribute('data-chart-label') || '';
    const val = datum.getAttribute('data-chart-val') || '';
    const pct = datum.getAttribute('data-chart-pct') || '';
    const color = datum.getAttribute('data-chart-color') || '#4f46e5';
    tip.innerHTML = `<span class="md-chart-tip-dot" style="background:${esc(color)}"></span>`
      + `<strong class="md-chart-tip-label">${esc(label)}</strong>`
      + `<span class="md-chart-tip-val">${esc(val)}${pct ? ` (${esc(pct)})` : ''}</span>`;
    tip.hidden = false;
    const boxRect = chartBox.getBoundingClientRect();
    const dRect = datum.getBoundingClientRect();
    if (boxRect.width > 0 && dRect.width >= 0) {
      const left = Math.max(48, Math.min(boxRect.width - 48, (dRect.left - boxRect.left) + dRect.width / 2));
      const top = Math.max(28, (dRect.top - boxRect.top));
      tip.style.left = `${left.toFixed(1)}px`;
      tip.style.top = `${top.toFixed(1)}px`;
    }
    requestAnimationFrame(() => tip.classList.add('show'));
  }

  function hideChartDatumTooltip(chartBox) {
    if (!chartBox) return;
    const pinned = chartBox.querySelector('[data-chart-label].is-active');
    if (pinned) {
      showChartDatumTooltip(chartBox, pinned);
      return;
    }
    const tip = chartBox.querySelector('.md-chart-tooltip');
    if (tip) {
      tip.classList.remove('show');
    }
  }

  msgList.addEventListener('keydown', (e) => {
    const datum = e.target.closest && e.target.closest('[data-chart-label]');
    if (!datum || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    datum.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  });

  msgList.addEventListener('pointerover', (e) => {
    const datum = e.target.closest && e.target.closest('[data-chart-label]');
    if (!datum) return;
    const chartBox = datum.closest('.md-chart');
    if (chartBox) showChartDatumTooltip(chartBox, datum);
  });
  msgList.addEventListener('pointerout', (e) => {
    const datum = e.target.closest && e.target.closest('[data-chart-label]');
    if (!datum) return;
    const chartBox = datum.closest('.md-chart');
    if (chartBox && (!e.relatedTarget || !datum.contains(e.relatedTarget))) {
      hideChartDatumTooltip(chartBox);
    }
  });


  function syncCapLine() {
    const eln = $('#cap-line');
    if (!eln) return;
    const bits = [store.state.model === '__system__' ? 'system-commands' : (isSmartRouter(store.state.model) ? '智能' : store.state.model)]; // 通道态与模型钮同一叫法（.18）
    if (store.state.settings.thinking !== false) bits.push(`思考 ${reasoningLevelLabel(store.state.settings.reasoningLevel)}`);
    if (store.state.settings.sandboxEnabled) bits.push('沙箱');
    if (store.state.relayOk === true && store.state.settings.webEnabled !== false) bits.push('联网');
    bits.push(getTransport() === 'proxy' ? '中继' : '直连');
    const panelOpen = $('#sandbox-panel') && !$('#sandbox-panel').classList.contains('collapsed');
    if (panelOpen) bits.push('面板');
    eln.textContent = bits.join('  ·  ');
  }

  const statsEl = $('#conv-stats');
  if (statsEl) {
    statsEl.addEventListener('click', (e) => { e.stopPropagation(); showTokBreak(statsEl); });
    statsEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showTokBreak(statsEl); } });
  }
  document.addEventListener('click', (e) => {
    const pop = $('#tok-pop');
    if (!pop || pop.hidden) return;
    if (pop.contains(e.target) || (statsEl && statsEl.contains(e.target)) || e.target.closest('.tok-btn')) return;
    hideTokPop();
  });
  window.addEventListener('resize', () => { if ($('#tok-pop') && !$('#tok-pop').hidden) placeTokPop($('#conv-stats')); });

  function syncComposerPh() {
    if (!composer) return;
    composer.placeholder = mqPanel.matches
      ? '输入消息，可粘贴或拖入附件…'
      : '输入消息，Enter 发送 / Shift+Enter 换行，可拖入或粘贴附件…';
  }
  syncComposerPh();
  if (mqPanel.addEventListener) mqPanel.addEventListener('change', () => { syncComposerPh(); if (!store.state.messages.length) { clearEmpty(); renderEmpty(); } });

  // ── 全屏预览：见 ui-lightbox.js（图片 / SVG / 图表全屏，缩放拖动，document 级事件委派）──
  installLightbox();

  // 复制工具入参/出参 JSON（不触发展开）
  msgList.addEventListener('click', (e) => {
    const btn = e.target.closest('.chip-copy');
    if (!btn) return;
    e.preventDefault(); e.stopPropagation();
    const chip = btn.closest('.chip');
    if (!chip) return;
    const which = btn.dataset.which;
    const payload = which === 'out' ? (chip._out || $('.chip-result', chip)?.textContent || '') : JSON.stringify(chip._args ?? {}, null, 2);
    navigator.clipboard.writeText(String(payload || '')).then(() => {
      const prev = btn.textContent; btn.textContent = '已复制'; setTimeout(() => (btn.textContent = prev), 1200);
    }).catch(() => toast('复制失败', 'warn'));
  });

  // ⌘K 命令面板
  const pal = $('#cmd-palette');
    const palInput = $('#cmd-input');
  const palList = $('#cmd-list');
  let palItems = [];
  let palIdx = 0;
  function collectCmds() {
    const items = [];
    chatModels().forEach((m, i) => items.push({
      group: '模型', id: 'm:' + m.id, label: m.id, hint: m.provider || '',
      kbd: i < 9 ? '⌃' + (i + 1) : '',
      run: () => selectModel(m.id),
    }));
    try {
      for (const f of agent.fs.list()) {
        items.push({ group: '文件', id: 'f:' + f.path, label: f.path, run: () => {
          setPanelCollapsed(false);
          openFileViewer(f.path);
        } });
      }
    } catch { /* fs 未就绪 */ }
    items.push({ group: '操作', id: 'p:panel', label: '打开 / 收起沙箱面板', kbd: '⌘B', run: () => setPanelCollapsed(!$('#sandbox-panel').classList.contains('collapsed')) });
    items.push({ group: '操作', id: 'p:new', label: '新建会话', run: () => $('#new-session').click() });
    // P2 诊断入口（等价于输入 /p2）：命令通道是本地执行的，不受当前模型影响
    items.push({ group: '诊断', id: 'd:p2', label: 'P2 报告（策略 / 指标 / 审计三层 / 故障 / 实验 / 上下文）', run: () => { if (store.state.model !== '__system__') selectModel('__system__'); handleSystemCommand('/p2'); } });
    items.push({ group: '诊断', id: 'd:p2f', label: 'P2 故障注入（红队自测：列出可注入故障）', run: () => { if (store.state.model !== '__system__') selectModel('__system__'); handleSystemCommand('/p2 fault'); } });
    if (globalThis.__dubheDebugToggle) items.push({ group: '操作', id: 'p:debug', label: globalThis.__dubheDebugActive && globalThis.__dubheDebugActive() ? '关闭调试浮窗（系统日志）' : '打开调试浮窗（系统日志）', kbd: '⌃⌥D', run: () => globalThis.__dubheDebugToggle() });
    return items;
  }
  function paintPal() {
    if (!palList) return;
    const vis = filterCmds(palInput ? palInput.value : '', palItems);
    palList.innerHTML = vis.map((it, i) => `<button type="button" class="cmd-item${i === palIdx ? ' active' : ''}" data-i="${i}" role="option"><span class="cmd-g">${esc(it.group)}</span><span class="cmd-l">${esc(it.label)}</span>${it.kbd ? `<span class="cmd-k">${esc(it.kbd)}</span>` : ''}</button>`).join('')
      || '<div class="empty-hint">无匹配</div>';
    palList._vis = vis;
  }
  function openPal() {
    if (!pal) return;
    palItems = collectCmds();
    palIdx = 0;
    pal.hidden = false;
    if (palInput) { palInput.value = ''; palInput.focus(); }
    paintPal();
  }
  function closePal() {
    if (pal) pal.hidden = true;
  }
  function runPal(it) {
    closePal();
    if (it && typeof it.run === 'function') it.run();
  }
  if (palInput) palInput.addEventListener('input', () => { palIdx = 0; paintPal(); });
  if (palList) palList.addEventListener('click', (e) => {
    const row = e.target.closest('.cmd-item');
    if (!row) return;
    const vis = palList._vis || [];
    runPal(vis[+row.dataset.i]);
  });
  if (pal) pal.addEventListener('click', (e) => { if (e.target === pal) closePal(); });

  document.addEventListener('keydown', (e) => {
    const meta = e.metaKey || e.ctrlKey;
    const inPal = pal && !pal.hidden;
    if (inPal) {
      const vis = palList && palList._vis || [];
      if (e.key === 'Escape') { e.preventDefault(); closePal(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); palIdx = Math.min(vis.length - 1, palIdx + 1); paintPal(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); palIdx = Math.max(0, palIdx - 1); paintPal(); return; }
      if (e.key === 'Enter') { e.preventDefault(); runPal(vis[palIdx]); return; }
    }
    if (e.key === 'Escape' && pal && !pal.hidden) { e.preventDefault(); closePal(); return; }
    if (meta && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); inPal ? closePal() : openPal(); return; }
    if (meta && (e.key === 'b' || e.key === 'B')) {
      e.preventDefault();
      setPanelCollapsed(!$('#sandbox-panel').classList.contains('collapsed'));
      return;
    }
    if ((e.ctrlKey || e.altKey) && /^[1-9]$/.test(e.key)) {
      const mods = chatModels();
      const pick = mods[+e.key - 1];
      if (pick) { e.preventDefault(); selectModel(pick.id); toast(`模型 ${pick.id}`, 'ok', 1800); }
    }
  });

  // ── 初次渲染 ──
  rebuildMessages();
  setInterval(() => {
    for (const m of store.state.messages || []) {
      if (m.role !== 'assistant' || !m.done) continue;
      const wrap = msgNodes.get(m.id);
      if (wrap) paintFoot(wrap, m);
    }
  }, 30000);
  setStatus('idle');
  updateTransportBadge();
  updateStats();
  renderTimeStats();
  syncCapLine();
  // 构建标识：静态站点无法靠响应头保证刷新即最新，先把版本号亮出来便于自检
  const stampEl = $('#build-stamp');
  if (stampEl) {
    // 入口 index.html 自带 app-version meta；子资源 URL 没有版本参数（Pages 对所有静态文件统一回
    // cache-control: max-age=600），所以「入口已新、某个 js 还是旧的」是真实存在的窗口期
    //（这正是硬刷新后仍看到旧版本号的机制）。这里直接比对并把原因说出来。
    const entryVer = (document.querySelector('meta[name="app-version"]') || {}).content || '';
    const drifted = !!entryVer && entryVer !== APP_VERSION;
    const rel = `Dubhe Agent ${APP_RELEASE}`;
    stampEl.textContent = drifted ? `${rel} · v${APP_VERSION} / 入口 ${entryVer}` : `${rel} · v${APP_VERSION}`;
    stampEl.title = `${rel}（构建 ${APP_VERSION}）${drifted ? `；入口 index.html 是 ${entryVer}（两者应一致）` : ''} · 若看到的不是最新改动，请按 Ctrl/Cmd + Shift + R 强制刷新`;
    if (drifted) setTimeout(() => toast(`资源缓存不一致（入口 ${entryVer}，模块 ${APP_VERSION}）：请硬刷新或用无痕窗口打开`, 'warn', 9000), 700);
  }

  if (!store.state.apiKey) setTimeout(openKeyModal, 600);

  // ── 暴露给 agent hooks ───────────────────────────────────────────────
  const ui = {
    setStatus,
    refreshKeyBtn: updateKeyBtn,   // main.js 解封成功后刷新按钮文案
    // 刷新页面后：外置在 IndexedDB 的重数据取回来了 → 重绘消息（附件图片、芯片里的生成图）
    // 与文件面板（沙箱里的图），并把沙箱重新灌进 agent（createAgent 建 fs 时它们还没回来）
    afterHydrate() {
      try { agent.loadFiles(store.state.files); } catch { /* 忽略 */ }
      rebuildMessages(); renderFiles(); renderSessions(); updateStats(); updateTransportBadge();
    },
    updateTransportBadge,
    updateStats,
    renderSessions,
    renderFiles,
    rebuildMessages, // 外部触发整段对话重绘（会话切换、示例卡刷新等）
    // 用户消息入列后立刻上屏：否则要等本轮输出完（甚至切出再切回会话）才看得到自己说了什么
    onUserMessage(m) {
      // 兼容只传文本的旧调用方（缓存错配时会出现）：退化为「最近一条还没上屏的 user 消息」
      const msg = (m && m.id) ? m : [...store.state.messages].reverse().find((x) => x.role === 'user' && !msgNodes.has(x.id));
      if (!msg || !msg.id || msgNodes.has(msg.id)) return;
      if (!msg.silent) {
        for (const box of $$('.choice-box', msgList)) box.remove();
        appendMessage(msg);
      }
      refreshActionVisibility();
    },
    onJevPlan(m) {
      const wrap = m && m.id ? msgNodes.get(m.id) : null;
      if (!wrap || !m.jev || !m.jev.summary) return;
      if ($('.jev-chip', wrap)) {
        $('.jev-chip', wrap).textContent = `Jev · ${m.jev.summary}`;
        return;
      }
      const chip = el('div', 'jev-chip', `Jev · ${esc(m.jev.summary)}`);
      chip.title = 'TypeSafe Jev 对本轮的校准分类';
      const bar = $('.msg-user-bar', wrap);
      const actions = $('.msg-actions-user', wrap);
      if (bar && actions) bar.insertBefore(chip, actions);
      else if (bar) bar.prepend(chip);
      else wrap.appendChild(chip);
    },
    onAssistantStart(m) { appendMessage(m); },
    onDelta(m) { schedulePaint(m); },
    onReasoning(m) { schedulePaint(m); },
    onToolDelta(m) { schedulePaint(m); },
    onAssistantDone(m) {
      const wrap = msgNodes.get(m.id);
      if (wrap) paintAssistant(wrap, m);
      scrollToBottom();
      renderSessions(); // 刷新会话记录的轮数/时间
      refreshActionVisibility();
      updateTransportBadge();
    },
    onTurnTiming(ms) {
      if (!(ms > 0)) return;
      const st = store.state.stats || (store.state.stats = { lastMs: 0, totalMs: 0 });
      st.lastMs = ms;
      st.totalMs += ms;
      store.notify();
      renderTimeStats();
    },
    // 回合结束后给会话起个标题（Agent 总结；用户手改过的不会被覆盖）
    // 联网：进度与来源（兼容解析模型服务端 web_search 事件）
    onWebSearch: (m) => {
      const wrap = msgNodes.get(m && m.id);
      if (!wrap) return;
      paintAssistant(wrap, store.state.messages.find((x) => x.id === m.id) || m);
    },
    onWebFallback: (model, why) => {
      toast(`联网已自动关闭（${String(why || '').slice(0, 120)}）`, 'warn', 7000);
      syncWeb();
    },
    // 起标题失败绝不能冒泡到回合流程（catch 掉，标题自然退回「首条消息截断」）
    autoTitle: () => autoTitle(store).then((r) => { if (r && r.ok) renderSessions(); return r; }, () => ({ ok: false, reason: 'view-error' })),
    onToolStart() { scrollToBottom(); },
    // ── P1 高风险操作确认卡（执行内核 · 最小信息格式 + 三个决定）──
    onConfirmationRequest(call, requestText, key) {
      clearConfirmCards();
      const node = el('div', 'confirm-card');
      node.dataset.key = String(key || '');
      node.innerHTML = [
        '<div class="confirm-title">⚠ 执行内核：该操作需要你的确认</div>',
        `<pre class="confirm-body">${esc(requestText || '')}</pre>`,
        '<div class="confirm-actions">',
        '<button class="confirm-btn allow" data-decision="allow-once">允许本次</button>',
        '<button class="confirm-btn allow-session" data-decision="allow-session">本会话允许该工具</button>',
        '<button class="confirm-btn deny" data-decision="deny">拒绝</button>',
        '</div>',
        '<div class="confirm-note">未选择时不会执行该操作；等待超时按拒绝处理（fail-closed）。</div>',
      ].join('');
      const settle = (decision, label) => {
        const res = (() => { try { return agent.resolveConfirmation(node.dataset.key, decision, label); } catch { return { ok: false }; } })();
        node.classList.add('resolved');
        node.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        const tag = el('div', `confirm-result ${decision === 'deny' ? 'deny' : 'allow'}`, esc(label));
        node.appendChild(tag);
        if (!res || res.ok === false) toast('该确认已过期或回合已结束，操作未执行（默认拒绝）', 'warn', 4200);
        scrollToBottom();
      };
      node.querySelector('[data-decision="allow-once"]').addEventListener('click', () => settle('allow-once', '已允许本次执行'));
      node.querySelector('[data-decision="allow-session"]').addEventListener('click', () => settle('allow-session', '本会话内该工具不再逐次确认'));
      node.querySelector('[data-decision="deny"]').addEventListener('click', () => settle('deny', '已拒绝执行'));
      msgList.appendChild(node);
      confirmNodes.set(node.dataset.key, node);
      scrollToBottom();
    },
    onConfirmationResolved(call, rec) {
      const node = [...confirmNodes.values()].find((n) => n && n.dataset.key === String(rec && rec.key || ''));
      if (!node) return;
      if (node.classList.contains('resolved')) return;
      node.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      node.classList.add('resolved');
      const timeout = rec && rec.decision === 'timeout';
      node.appendChild(el('div', `confirm-result ${timeout ? 'deny' : 'allow'}`, esc(timeout ? '等待确认超时：未执行（默认拒绝）' : `已处理：${rec && rec.decision || ''}`)));
      scrollToBottom();
    },
    onToolResult(call, result) {
      renderFiles();
      updateStats();
      renderMemory();
      // 同步回填对话流中的工具芯片（成功 ✓ / 失败红点 + 展开详情）
      attachToolResult({ toolCallId: call.id, content: result });
    },
    // 用户点了「停止」：Agent 已把那条消息标成 cancelled+done，但视图不会自己重画 ——
    // 停止前若首字还没到，屏上会一直留着「正在连接 xxx，等待首个响应…」和转圈。
    // 这里显式重绘这一条（并收起未完成的工具芯片），保证停下就是停下。
    onCancelled() {
      const last = [...store.state.messages].reverse().find((m) => m.role === 'assistant' && m.cancelled)
        || [...store.state.messages].reverse().find((m) => m.role === 'assistant' && !m.done);
      if (last) {
        const wrap = msgNodes.get(last.id);
        if (wrap) paintAssistant(wrap, last);
        for (const chip of $$('.tool-call-chip', wrap || msgList)) {
          if (!chip.classList.contains('done')) syncToolChip(chip, { cancelled: true });
        }
        for (const fold of $$('.ran-commands', wrap || msgList)) syncRanCommandsFold(fold);
      }
      refreshActionVisibility();
      scrollToBottom();
    },

    // 沙箱执行进度 → 回写到对应工具芯片的状态位（Pyodide 首次加载 10~30s、
    // C++ 远程编译、子智能体委派都需要可见的进度，否则界面看起来像卡死）
    onToolEvent(call, patch) {
      const id = String(call && call.id || '');
      const chip = $$('.tool-call-chip', msgList).find((node) => toolIds(node).includes(id));
      if (!chip) return;
      if (!chip._toolStates) chip._toolStates = {};
      if (['running', 'ok', 'error'].includes(patch.status)) {
        const previous = chip._toolStates[id] || {};
        const errTxt = String((patch.error && patch.error.message) || patch.note || '工具失败').slice(0, 400);
        chip._toolStates[id] = {
          ...previous,
          status: patch.status,
          note: patch.status === 'error' ? errTxt : (patch.note || previous.note || ''),
          durationMs: patch.durationMs != null ? Number(patch.durationMs) : previous.durationMs,
        };
        syncToolChip(chip);
      }
      if (patch.image) {
        // 图走正文 sandbox:// 占位，不在芯片里画。仍记在 toolCall 上，好进 IDB。
        call.image = patch.image;
        if (patch.imagePath) call.imagePath = patch.imagePath;
        if (patch.width) call.width = patch.width;
        if (patch.height) call.height = patch.height;
        store.save();
      }
      if (patch.status === 'running' || patch.image) scrollToBottom();
    },
    attachToolResult,
    // 用户附件已通过审核并复制到沙箱 uploads/ → 刷新文件面板并提示（可在面板内单个下载或整包 ZIP）
    onFsChange(paths) {
      renderFiles();
      if (paths && paths.length) toast(`附件已复制到沙箱：${paths.join('、')}`, 'ok', 4200);
    },
    scrollToBottom: () => scrollToBottom(true),
    syncWeb,
  };
  // UI 挂载完成：同步取消启动超时，再淡出加载屏，避免慢网下先闪出误报。
  const bootGuard = window.__dubheBootGuard;
  if (bootGuard && typeof bootGuard.complete === 'function') {
    bootGuard.complete();
  } else {
    requestAnimationFrame(() => {
      const boot = document.getElementById('boot-screen');
      if (!boot) return;
      boot.classList.add('fade-out');
      setTimeout(() => { boot.remove(); }, 500);
    });
  }
  return ui;
}
