// Safe subset of Pandoc / MultiMarkdown extensions used by Dubhe Agent.
// Raw HTML is never handed to markdown-it's HTML parser: tags are tokenized,
// allow-listed, attribute-filtered, and restored only after Markdown rendering.
const TOKEN = '\uE000TE';
const escapeAttr = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const SAFE_TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'cite', 'code', 'dd', 'del', 'details',
  'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'i', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'section', 'small',
  'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'tr', 'u', 'ul', 'img',
]);
const VOID_TAGS = new Set(['br', 'hr', 'img']);
const DROP_CONTENT_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template', 'noscript']);
const RAW_BLOCK_TAGS = new Set(['address', 'blockquote', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'header', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'li', 'main', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul']);
const COLOR = /^(?:#[\da-f]{3,8}|transparent|currentcolor|[a-z]{1,24}|(?:rgb|rgba|hsl|hsla)\([\d.% ,+-]+\))$/i;
const LENGTH = /^(?:0|\d+(?:\.\d+)?(?:px|em|rem|%|pt|pc|ch|ex|vw|vh))$/i;
const SAFE_CSS_PROPS = new Set([
  'color', 'background-color', 'text-align', 'font-size', 'font-weight', 'font-style',
  'text-decoration', 'vertical-align', 'white-space', 'line-height', 'width', 'max-width',
  'min-width', 'height', 'max-height', 'margin', 'margin-top', 'margin-right', 'margin-bottom',
  'margin-left', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border', 'border-color', 'border-width', 'border-style', 'border-radius',
]);

function safeLengthList(value, max = 4) {
  const parts = String(value).trim().split(/\s+/);
  return parts.length <= max && parts.every((v) => LENGTH.test(v) && !v.startsWith('-'));
}

export function sanitizeMarkdownStyle(raw) {
  const output = [];
  for (const declaration of String(raw || '').split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 1) continue;
    const prop = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (!SAFE_CSS_PROPS.has(prop) || !value || /[<>\\{}]|url\s*\(|expression|var\s*\(|attr\s*\(|@|!important/i.test(value)) continue;
    let valid = false;
    if (prop === 'color' || prop === 'background-color' || prop === 'border-color') valid = COLOR.test(value);
    else if (prop === 'text-align') valid = /^(left|right|center|justify|start|end)$/i.test(value);
    else if (prop === 'font-weight') valid = /^(normal|bold|bolder|lighter|[1-9]00)$/i.test(value);
    else if (prop === 'font-style') valid = /^(normal|italic|oblique)$/i.test(value);
    else if (prop === 'text-decoration') valid = /^(none|underline|overline|line-through)(?:\s+(?:underline|overline|line-through))*$/i.test(value);
    else if (prop === 'vertical-align') valid = /^(baseline|top|middle|bottom|sub|super)$/i.test(value);
    else if (prop === 'white-space') valid = /^(normal|nowrap|pre|pre-wrap|pre-line|break-spaces)$/i.test(value);
    else if (prop === 'font-size') valid = /^(?:\d+(?:\.\d+)?)(?:px|em|rem|%|pt)?$/i.test(value) && Number.parseFloat(value) <= 96;
    else if (prop === 'line-height') valid = /^(?:[0-9]+(?:\.[0-9]+)?|\d+(?:\.\d+)?(?:px|em|rem|%))$/i.test(value) && Number.parseFloat(value) <= 4;
    else if (prop === 'width' || prop === 'max-width' || prop === 'min-width' || prop === 'height' || prop === 'max-height') {
      valid = value.toLowerCase() === 'auto' || (LENGTH.test(value) && !value.startsWith('-'));
    } else if (/^(?:margin|padding)(?:-(?:top|right|bottom|left))?$/.test(prop)) {
      valid = safeLengthList(value, 4);
    } else if (prop === 'border-width' || prop === 'border-radius') {
      valid = safeLengthList(value, 4);
    } else if (prop === 'border-style') valid = /^(none|solid|dashed|dotted|double)(?:\s+(?:none|solid|dashed|dotted|double)){0,3}$/i.test(value);
    else if (prop === 'border') {
      valid = /^(?:0|\d+(?:\.\d+)?(?:px|em|rem))\s+(?:none|solid|dashed|dotted|double)\s+(?:#[\da-f]{3,8}|[a-z]{1,24})$/i.test(value);
    }
    if (valid) output.push(`${prop}:${value}`);
  }
  return output.join(';');
}

function safeHref(value) {
  const href = String(value || '').trim();
  if (!href || /[\u0000-\u0020<>"'`]/.test(href)) return '';
  if (/^#[\w:.-]{1,180}$/.test(href)) return href;
  if (/^(?:\/|\.\/|\.\.\/)(?!\/)/.test(href)) return href;
  try {
    const url = new URL(href);
    if (url.protocol === 'http:' || url.protocol === 'https:') return href;
    if (url.protocol === 'mailto:' && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(decodeURIComponent(url.pathname || ''))) return href;
  } catch { /* disallowed */ }
  return '';
}

function safeImage(value) {
  const src = String(value || '').trim();
  if (/^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(src)) return src.replace(/\s+/g, '');
  try {
    const url = new URL(src);
    if (url.protocol === 'https:' || url.protocol === 'http:') return src;
  } catch { /* disallowed */ }
  return '';
}

function findTagEnd(source, start) {
  let quote = '';
  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i];
    if (quote) { if (ch === quote) quote = ''; }
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return i;
  }
  return -1;
}

function readAttributes(raw) {
  const attrs = [];
  let i = 0;
  const s = String(raw || '').replace(/\/\s*$/, '');
  while (i < s.length) {
    while (/\s/.test(s[i] || '')) i++;
    if (i >= s.length) break;
    const nameMatch = /^[A-Za-z_:][A-Za-z0-9:._-]*/.exec(s.slice(i));
    if (!nameMatch) { i++; continue; }
    const name = nameMatch[0].toLowerCase();
    i += nameMatch[0].length;
    while (/\s/.test(s[i] || '')) i++;
    let value = '';
    if (s[i] === '=') {
      i++;
      while (/\s/.test(s[i] || '')) i++;
      const quote = s[i] === '"' || s[i] === "'" ? s[i++] : '';
      const from = i;
      if (quote) {
        while (i < s.length && s[i] !== quote) i++;
        value = s.slice(from, i);
        if (s[i] === quote) i++;
      } else {
        while (i < s.length && !/\s/.test(s[i])) i++;
        value = s.slice(from, i);
      }
    }
    attrs.push([name, value]);
  }
  return attrs;
}

function sanitizeRawTag(raw) {
  const match = /^<\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)\b([\s\S]*?)>$/i.exec(raw);
  if (!match) return '';
  const closing = !!match[1];
  const tag = match[2].toLowerCase();
  if (!SAFE_TAGS.has(tag)) return '';
  if (closing) return VOID_TAGS.has(tag) ? '' : `</${tag}>`;

  const input = readAttributes(match[3]);
  const attrs = new Map(input);
  const allowed = new Set(['class', 'id', 'title', 'style']);
  if (tag === 'a') for (const name of ['href', 'target']) allowed.add(name);
  if (tag === 'img') for (const name of ['src', 'alt', 'width', 'height']) allowed.add(name);
  if (['ol', 'td', 'th'].includes(tag)) allowed.add(tag === 'ol' ? 'start' : 'colspan'), allowed.add(tag === 'ol' ? 'type' : 'rowspan');
  if (['td', 'th', 'caption'].includes(tag)) allowed.add('align');
  if (tag === 'details') allowed.add('open');

  const kept = [];
  for (const [name, rawValue] of attrs) {
    if (!allowed.has(name)) continue;
    let value = rawValue;
    if (name === 'class') {
      value = value.split(/\s+/).filter((x) => /^[A-Za-z][\w-]{0,39}$/.test(x)).slice(0, 8).join(' ');
      if (value) kept.push(`class="${escapeAttr(value)}"`);
    } else if (name === 'id') {
      if (/^[A-Za-z][\w:.-]{0,100}$/.test(value)) kept.push(`id="${escapeAttr(value)}"`);
    } else if (name === 'title' || name === 'alt') {
      kept.push(`${name}="${escapeAttr(value.slice(0, 500))}"`);
    } else if (name === 'style') {
      const style = sanitizeMarkdownStyle(value);
      if (style) kept.push(`style="${escapeAttr(style)}"`);
    } else if (name === 'href' && tag === 'a') {
      const href = safeHref(value);
      if (href) kept.push(`href="${escapeAttr(href)}"`);
    } else if (name === 'src' && tag === 'img') {
      const src = safeImage(value);
      if (src) kept.push(`src="${escapeAttr(src)}"`);
    } else if (name === 'target' && tag === 'a') {
      if (value === '_blank' || value === '_self') kept.push(`target="${value}"`);
    } else if (name === 'align') {
      if (/^(left|right|center|justify)$/i.test(value)) kept.push(`align="${value.toLowerCase()}"`);
    } else if (['width', 'height'].includes(name)) {
      if (/^(?:\d{1,4})(?:px|%)?$/i.test(value) && Number.parseInt(value, 10) <= 4096) kept.push(`${name}="${escapeAttr(value)}"`);
    } else if (['colspan', 'rowspan', 'start'].includes(name)) {
      if (/^\d{1,3}$/.test(value) && Number(value) >= 1 && Number(value) <= 1000) kept.push(`${name}="${value}"`);
    } else if (name === 'type' && tag === 'ol') {
      if (/^[1aAiI]$/.test(value)) kept.push(`type="${value}"`);
    } else if (name === 'open' && tag === 'details') {
      kept.push('open');
    }
  }
  if (tag === 'a' && kept.some((x) => x.startsWith('href=')) && attrs.get('target') === '_blank') kept.push('rel="noopener noreferrer nofollow"');
  return `<${tag}${kept.length ? ` ${kept.join(' ')}` : ''}${VOID_TAGS.has(tag) ? ' />' : ''}>`;
}

function sanitizeHtmlFragment(source) {
  const input = String(source || '');
  let out = '';
  for (let i = 0; i < input.length;) {
    if (input[i] !== '<') { out += input[i++]; continue; }
    if (input.startsWith('<!--', i)) {
      const end = input.indexOf('-->', i + 4);
      i = end < 0 ? input.length : end + 3;
      continue;
    }
    const dangerous = /^<\s*(script|style|iframe|object|embed|svg|math|template|noscript)\b/i.exec(input.slice(i));
    if (dangerous) {
      const end = findTagEnd(input, i);
      if (end < 0) break;
      const close = new RegExp(`<\\/\\s*${dangerous[1]}\\s*>`, 'ig');
      close.lastIndex = end + 1;
      const found = close.exec(input);
      i = found ? close.lastIndex : input.length;
      continue;
    }
    const end = findTagEnd(input, i);
    if (end < 0) { out += input[i++]; continue; }
    const raw = input.slice(i, end + 1);
    if (!/^<\s*[!?]/.test(raw)) out += sanitizeRawTag(raw);
    i = end + 1;
  }
  return out;
}

function findMatchingBlockEnd(input, start, tag, openEnd) {
  let depth = 1;
  for (let i = openEnd + 1; i < input.length;) {
    const at = input.indexOf('<', i);
    if (at < 0) return -1;
    if (input.startsWith('<!--', at)) {
      const end = input.indexOf('-->', at + 4);
      i = end < 0 ? input.length : end + 3;
      continue;
    }
    const end = findTagEnd(input, at);
    if (end < 0) return -1;
    const raw = input.slice(at, end + 1);
    const match = /^<\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)\b([\s\S]*?)>$/i.exec(raw);
    if (match && match[2].toLowerCase() === tag) {
      if (match[1]) {
        depth--;
        if (!depth) return end + 1;
      } else if (!/\/\s*>$/.test(raw)) depth++;
    }
    i = end + 1;
  }
  return -1;
}

function protectRawHtml(source, state) {
  const input = String(source || '');
  let out = '';
  for (let i = 0; i < input.length;) {
    if (input[i] !== '<') { out += input[i++]; continue; }
    if (input.startsWith('<!--', i)) {
      const end = input.indexOf('-->', i + 4);
      i = end < 0 ? input.length : end + 3;
      continue;
    }
    const dangerous = /^<\s*(script|style|iframe|object|embed|svg|math|template|noscript)\b/i.exec(input.slice(i));
    if (dangerous) {
      const tag = dangerous[1].toLowerCase();
      const openEnd = findTagEnd(input, i);
      if (openEnd < 0) break;
      const close = new RegExp(`<\\/\\s*${tag}\\s*>`, 'ig');
      close.lastIndex = openEnd + 1;
      const endMatch = close.exec(input);
      i = endMatch ? close.lastIndex : input.length;
      continue;
    }
    const end = findTagEnd(input, i);
    if (end < 0) { out += input[i++]; continue; }
    const raw = input.slice(i, end + 1);
    const match = /^<\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)\b([\s\S]*?)>$/i.exec(raw);
    if (match && !match[1] && RAW_BLOCK_TAGS.has(match[2].toLowerCase()) && !/\/\s*>$/.test(raw)) {
      const tag = match[2].toLowerCase();
      const blockEnd = findMatchingBlockEnd(input, i, tag, end);
      if (blockEnd > 0) {
        const safeBlock = sanitizeHtmlFragment(input.slice(i, blockEnd));
        const index = state.rawHtml.push(safeBlock) - 1;
        state.rawHtmlBlocks.add(index);
        out += `\n\n${TOKEN}HTML${index}\uE001\n\n`;
        i = blockEnd;
        continue;
      }
    }
    if (/^<\s*[!?]/.test(raw)) { i = end + 1; continue; }
    const safe = sanitizeRawTag(raw);
    if (safe) {
      const index = state.rawHtml.push(safe) - 1;
      out += `${TOKEN}HTML${index}\uE001`;
    }
    i = end + 1;
  }
  return out;
}

function splitAttributeTokens(raw) {
  const input = String(raw || '').trim().replace(/^\{\s*/, '').replace(/\s*\}$/, '');
  const tokens = [];
  let token = '';
  let quote = '';
  for (const ch of input) {
    if (quote) {
      token += ch;
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch; token += ch;
    } else if (/\s/.test(ch)) {
      if (token) tokens.push(token), token = '';
    } else token += ch;
  }
  if (token) tokens.push(token);
  return tokens;
}

export function parsePandocAttributes(raw) {
  const result = { id: '', classes: [], style: '', title: '' };
  for (const token of splitAttributeTokens(raw)) {
    if (token[0] === '#') {
      const value = token.slice(1);
      if (/^[A-Za-z][\w:.-]{0,100}$/.test(value) && !result.id) result.id = value;
      continue;
    }
    if (token[0] === '.') {
      const value = token.slice(1);
      if (/^[A-Za-z][\w-]{0,39}$/.test(value) && !result.classes.includes(value) && result.classes.length < 8) result.classes.push(value);
      continue;
    }
    const eq = token.indexOf('=');
    if (eq < 1) continue;
    const key = token.slice(0, eq).toLowerCase();
    let value = token.slice(eq + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (key === 'id' && /^[A-Za-z][\w:.-]{0,100}$/.test(value) && !result.id) result.id = value;
    else if (key === 'class') {
      for (const cls of value.split(/\s+/)) if (/^[A-Za-z][\w-]{0,39}$/.test(cls) && !result.classes.includes(cls) && result.classes.length < 8) result.classes.push(cls);
    } else if (key === 'style') result.style = sanitizeMarkdownStyle(value);
    else if (key === 'title') result.title = value.slice(0, 500);
  }
  return result;
}

export function pandocAttributesHtml(attrs, baseClass = '') {
  const a = attrs || {};
  const classes = [...new Set([...(baseClass ? String(baseClass).split(/\s+/) : []), ...(a.classes || [])])].filter((x) => /^[A-Za-z][\w-]{0,39}$/.test(x));
  const parts = [];
  if (a.id && /^[A-Za-z][\w:.-]{0,100}$/.test(a.id)) parts.push(`id="${escapeAttr(a.id)}"`);
  if (classes.length) parts.push(`class="${escapeAttr(classes.join(' '))}"`);
  if (a.title) parts.push(`title="${escapeAttr(a.title.slice(0, 500))}"`);
  const style = sanitizeMarkdownStyle(a.style || '');
  if (style) parts.push(`style="${escapeAttr(style)}"`);
  return parts.length ? ` ${parts.join(' ')}` : '';
}

function placeholder(type, index) { return `${TOKEN}${type}${index}\uE001`; }

function extractDefinitions(source, state) {
  const lines = String(source || '').split('\n');
  const kept = [];
  for (let i = 0; i < lines.length;) {
    const m = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*(.*)$/.exec(lines[i]);
    if (!m) { kept.push(lines[i++]); continue; }
    const id = m[1];
    const body = [m[2]];
    i++;
    while (i < lines.length) {
      if (/^\t/.test(lines[i]) || /^ {2,}\S/.test(lines[i])) {
        body.push(lines[i].replace(/^(?:\t| {2,})/, ''));
        i++;
        continue;
      }
      if (!lines[i].trim() && i + 1 < lines.length && (/^\t/.test(lines[i + 1]) || /^ {2,}\S/.test(lines[i + 1]))) {
        body.push(''); i++; continue;
      }
      break;
    }
    if (!state.footnoteDefs.has(id)) state.footnoteDefs.set(id, body.join('\n').trim());
  }
  return kept.join('\n');
}

function protectFootnoteRefs(source, state) {
  return String(source || '').replace(/\[\^([^\]\s]+)\]/g, (whole, id) => {
    if (!state.footnoteDefs.has(id)) return whole;
    let entry = state.footnotes.find((x) => x.id === id);
    if (!entry) {
      entry = { id, number: state.footnotes.length + 1, refs: [] };
      state.footnotes.push(entry);
    }
    const refIndex = entry.refs.length + 1;
    entry.refs.push(refIndex);
    const index = state.footnoteRefs.push({ id, number: entry.number, refIndex }) - 1;
    return placeholder('FNREF', index);
  });
}

// 普通 Markdown 正文里常见的化学式写法 H_2O / H~_2O（误把 Pandoc 波浪号
// 与 TeX 下划线叠在一起）也应显示为下标。这里只解析元素符号组成的化学式 token；
// 行内代码、代码围栏、原始 HTML 与 $...$ 数学段此前均已占位保护，不会被改写。
const CHEMICAL_ELEMENTS = '(?:Ac|Ag|Al|Am|Ar|As|At|Au|Ba|Be|Bh|Bi|Bk|Br|Ca|Cd|Ce|Cf|Cl|Cm|Cn|Co|Cr|Cs|Cu|Db|Ds|Dy|Er|Es|Eu|Fe|Fl|Fm|Fr|Ga|Gd|Ge|He|Hf|Hg|Ho|Hs|In|Ir|Kr|La|Li|Lr|Lu|Lv|Mc|Md|Mg|Mn|Mo|Mt|Na|Nb|Nd|Ne|Nh|Ni|No|Np|Og|Os|Pa|Pb|Pd|Pm|Po|Pr|Pt|Pu|Ra|Rb|Re|Rf|Rg|Rh|Rn|Ru|Sb|Sc|Se|Sg|Si|Sm|Sn|Sr|Ta|Tb|Tc|Te|Th|Ti|Tl|Tm|Ts|Xe|Yb|Zn|Zr|Ac|B|C|N|O|F|P|S|K|V|Y|I|W|U|H)';
function protectChemicalSubscripts(source, state) {
  const term = `(?:${CHEMICAL_ELEMENTS})(?:~?_[0-9]+)?`;
  const formulaRe = new RegExp(`(?<![A-Za-z])(${term}(?:${term})*)`, 'g');
  const subscriptRe = new RegExp(`(${CHEMICAL_ELEMENTS})(?:~)?_([0-9]+)`, 'g');
  return String(source || '').replace(formulaRe, (formula) => formula.replace(subscriptRe, (_whole, element, digits) => {
    const token = placeholder('SUB', state.superSub.push({ tag: 'sub', content: digits }) - 1);
    return `${element}${token}`;
  }));
}

function protectSuperSub(source, state) {
  const text = protectChemicalSubscripts(source, state);
  return text
    .replace(/(?<!\\)\^([^\s^]+)\^(?!\^)/g, (whole, content) => placeholder('SUP', state.superSub.push({ tag: 'sup', content }) - 1))
    .replace(/(?<!\\)~(?!~)([^\s~]+)~(?!~)/g, (whole, content) => placeholder('SUB', state.superSub.push({ tag: 'sub', content }) - 1));
}

function protectHighlights(source, state) {
  return String(source || '').replace(/(?<![=\\])==(?!=)(?=\S)([^\n]*?\S)(?<![=\\])==(?!=)/g, (whole, content) => {
    return placeholder('MARK', state.highlights.push(content) - 1);
  });
}

function protectDefinitionLists(source, state) {
  const lines = String(source || '').split('\n');
  const output = [];
  const isDef = (line) => /^ {0,3}:[ \t]+/.test(line || '');
  for (let i = 0; i < lines.length;) {
    if (i + 1 >= lines.length || !lines[i].trim() || !isDef(lines[i + 1])) {
      output.push(lines[i++]);
      continue;
    }
    const pairs = [];
    let term = lines[i].trim();
    while (i + 1 < lines.length && isDef(lines[i + 1])) {
      i++;
      const definitions = [];
      while (i < lines.length && isDef(lines[i])) {
        const first = lines[i].replace(/^ {0,3}:[ \t]+/, '');
        const body = [first];
        i++;
        while (i < lines.length) {
          if (/^(?: {2,}|\t)\S/.test(lines[i])) { body.push(lines[i].replace(/^(?:\t| {2,})/, '')); i++; continue; }
          if (!lines[i].trim() && i + 1 < lines.length && /^(?: {2,}|\t)\S/.test(lines[i + 1])) { body.push(''); i++; continue; }
          break;
        }
        definitions.push(body.join('\n').trim());
      }
      pairs.push({ term, definitions });
      if (i < lines.length && lines[i].trim() && i + 1 < lines.length && isDef(lines[i + 1])) term = lines[i].trim();
      else break;
    }
    const index = state.definitionLists.push(pairs) - 1;
    output.push(placeholder('DL', index));
  }
  return output.join('\n');
}

function protectFencedDivs(source, state) {
  const lines = String(source || '').split('\n');
  const root = [];
  const stack = [];
  const addLine = (line) => (stack.length ? stack[stack.length - 1].lines : root).push(line);
  for (const line of lines) {
    const open = /^ {0,3}:{3,}[ \t]+(.+?)[ \t]*$/.exec(line);
    if (open) {
      const attrsRaw = open[1].trim();
      const attrs = parsePandocAttributes(attrsRaw.startsWith('{') ? attrsRaw : `{ .${attrsRaw.replace(/^\./, '')} }`);
      stack.push({ attrs, lines: [] });
      continue;
    }
    if (/^ {0,3}:{3,}[ \t]*$/.test(line) && stack.length) {
      const node = stack.pop();
      const index = state.fencedDivs.push({ attrs: node.attrs, body: node.lines.join('\n') }) - 1;
      const token = placeholder('DIV', index);
      if (stack.length) stack[stack.length - 1].lines.push(token);
      else root.push(token);
      continue;
    }
    addLine(line);
  }
  // Unclosed generic divs are left as literal Markdown instead of being partially swallowed.
  if (stack.length) return String(source || '');
  return root.join('\n');
}

function normalizeLenientStrikethrough(source) {
  // Commonly mistyped Markdown with two opening tildes and one closing tilde
  // should still read as strikethrough. Code spans are already tokenized by the
  // caller; escaped delimiters and valid ~~...~~ pairs are left untouched.
  return String(source || '').replace(/(?<![~\\])~~(?!~)([^~\n]*?\S[^~\n]*)(?<![~\\])~(?!~)/g, (_whole, content) => {
    const edges = /^(\s*)([\s\S]*?\S)(\s*)$/.exec(content);
    return edges ? `${edges[1]}~~${edges[2]}~~${edges[3]}` : _whole;
  });
}

export function prepareMarkdownExtensions(source) {
  const state = {
    rawHtml: [], rawHtmlBlocks: new Set(), superSub: [], highlights: [], definitionLists: [], footnoteDefs: new Map(), footnotes: [], footnoteRefs: [], fencedDivs: [],
  };
  let text = protectRawHtml(source, state);
  text = normalizeLenientStrikethrough(text);
  text = extractDefinitions(text, state);
  text = protectFootnoteRefs(text, state);
  text = protectSuperSub(text, state);
  text = protectHighlights(text, state);
  text = protectDefinitionLists(text, state);
  text = protectFencedDivs(text, state);

  const tokenRe = new RegExp(`${TOKEN}(HTML|SUP|SUB|DL|FNREF|DIV|MARK)(\\d+)\\uE001`, 'g');
  const rawHtmlRe = new RegExp(`${TOKEN}HTML(\\d+)\\uE001`, 'g');
  function restore(html, renderInline = (x) => x, renderBlock = (x) => x) {
    let prepared = String(html || '');
    const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const unwrapMarker = (marker) => {
      prepared = prepared.replace(new RegExp(`<p>\\s*${escapeRegExp(marker)}\\s*</p>`, 'g'), marker);
    };
    // Markdown-it wraps standalone block placeholders in <p>; unwrap those before inserting block HTML.
    for (const [type, length] of [['DL', state.definitionLists.length], ['DIV', state.fencedDivs.length]]) {
      for (let i = 0; i < length; i++) unwrapMarker(`${TOKEN}${type}${i}\uE001`);
    }
    for (const i of state.rawHtmlBlocks) unwrapMarker(`${TOKEN}HTML${i}\uE001`);
    const expand = (input, depth = 0) => {
      if (depth > 12) return input;
      return String(input || '').replace(tokenRe, (token, type, rawIndex) => {
        const index = Number(rawIndex);
        if (type === 'HTML') return state.rawHtml[index] || '';
        if (type === 'SUP' || type === 'SUB') {
          const item = state.superSub[index];
          return item ? `<${item.tag}>${renderInline(item.content)}</${item.tag}>` : '';
        }
        if (type === 'MARK') {
          const content = state.highlights[index];
          return content == null ? '' : `<mark class="md-highlight">${expand(renderInline(content), depth + 1)}</mark>`;
        }
        if (type === 'FNREF') {
          const ref = state.footnoteRefs[index];
          if (!ref) return '';
          return `<sup class="md-footnote-ref"><a id="fnref-${ref.number}-${ref.refIndex}" href="#fn-${ref.number}" role="doc-noteref">${ref.number}</a></sup>`;
        }
        if (type === 'DL') {
          const pairs = state.definitionLists[index] || [];
          return `<dl class="md-definition-list">${pairs.map((pair) => `<dt>${renderInline(pair.term)}</dt>${pair.definitions.map((d) => `<dd>${renderBlock(d)}</dd>`).join('')}`).join('')}</dl>`;
        }
        if (type === 'DIV') {
          const item = state.fencedDivs[index];
          return item ? `<div${pandocAttributesHtml(item.attrs, 'md-fenced-div')}>${expand(renderBlock(item.body), depth + 1)}</div>` : '';
        }
        return token;
      });
    };
    let out = expand(prepared);
    if (state.footnotes.length) {
      const items = state.footnotes.map((entry) => {
        const body = state.footnoteDefs.get(entry.id) || '';
        const backlinks = entry.refs.map((n) => `<a class="md-footnote-back" href="#fnref-${entry.number}-${n}" role="doc-backlink" aria-label="返回注释 ${entry.number}">↩</a>`).join(' ');
        return `<li id="fn-${entry.number}" role="doc-endnote">${expand(renderBlock(body))} ${backlinks}</li>`;
      }).join('');
      out += `<section class="md-footnotes" role="doc-endnotes"><hr><ol>${items}</ol></section>`;
    }
    return out;
  }
  return { text, state, restore };
}

export function stripRawHtmlForTest(source) {
  const state = { rawHtml: [] };
  return protectRawHtml(source, state);
}
