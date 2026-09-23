// ─── 浏览器内 PDF 正文提取（不依赖 pdf.js / 第三方服务）────────────────
// 覆盖常见情况：未压缩内容流、FlateDecode 流、Tj/TJ/'/" 文本算子、字面量与十六进制串。
// 不追求排版还原（CID 字体、加密 PDF、Form XObject 图片会丢字）——提取失败时调用方应明确告知。

const LATIN = typeof TextDecoder !== 'undefined' ? new TextDecoder('latin1') : null;
const utf8 = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { fatal: false }) : null;

export function isPdfBytes(bytes) {
  const u8 = toU8(bytes);
  if (!u8 || u8.length < 5) return false;
  return u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46 && u8[4] === 0x2d; // %PDF-
}

function toU8(bytes) {
  if (!bytes) return new Uint8Array(0);
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return new Uint8Array(0);
}

async function inflateZlib(u8) {
  if (typeof DecompressionStream === 'function') {
    for (const format of ['deflate', 'deflate-raw']) {
      try {
        const ds = new DecompressionStream(format);
        const stream = new Blob([u8]).stream().pipeThrough(ds);
        const buf = await new Response(stream).arrayBuffer();
        if (buf && buf.byteLength) return new Uint8Array(buf);
      } catch { /* 试下一种 */ }
    }
  }
  try {
    const zlib = await import('node:zlib');
    const { promisify } = await import('node:util');
    try {
      return await promisify(zlib.inflate)(u8);
    } catch {
      return await promisify(zlib.inflateRaw)(u8);
    }
  } catch {
    return null;
  }
}

function decodePdfString(raw) {
  // 字面量：(Hello \(x\)) ；八进制 \nnn ；常见转义 \n \r \t \\ \( \)
  let s = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') { s += c; continue; }
    const n = raw[i + 1];
    if (n === undefined) break;
    if (n >= '0' && n <= '7') {
      let oct = n; i++;
      if (raw[i + 1] >= '0' && raw[i + 1] <= '7') { oct += raw[++i]; }
      if (raw[i + 1] >= '0' && raw[i + 1] <= '7') { oct += raw[++i]; }
      s += String.fromCharCode(parseInt(oct, 8) & 0xff);
      continue;
    }
    i++;
    s += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[n] || n);
  }
  // UTF-16BE BOM
  if (s.charCodeAt(0) === 0xfe && s.charCodeAt(1) === 0xff && s.length >= 2) {
    let out = '';
    for (let i = 2; i + 1 < s.length; i += 2) {
      out += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
    }
    return out;
  }
  return s;
}

function decodeHexString(hex) {
  const h = hex.replace(/[\s\r\n]/g, '');
  const even = h.length % 2 ? h + '0' : h;
  const bytes = new Uint8Array(even.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(even.slice(i * 2, i * 2 + 2), 16) || 0;
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return out;
  }
  return LATIN ? LATIN.decode(bytes) : String.fromCharCode(...bytes);
}

function takePdfTokens(src, into) {
  const re = /\((?:\\.|[^\\)])*\)|<[^>]*>/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[0][0] === '(') into.push(decodePdfString(m[0].slice(1, -1)));
    else into.push(decodeHexString(m[0].slice(1, -1)));
  }
}

function extractFromContent(content) {
  const parts = [];
  const src = String(content || '');
  // 单串算子： (Hello) Tj / ' / "
  const reTj = /\((?:\\.|[^\\)])*\)\s*(?:Tj|'|")/g;
  let m;
  while ((m = reTj.exec(src))) {
    const inner = m[0].replace(/\s*(?:Tj|'|")\s*$/, '');
    parts.push(decodePdfString(inner.slice(1, -1)));
  }
  const reHex = /<([0-9A-Fa-f\s]+)>\s*(?:Tj|'|")/g;
  while ((m = reHex.exec(src))) parts.push(decodeHexString(m[1]));
  // 数组算子： [(H) 120 (ello)] TJ
  const reTJ = /\[([\s\S]*?)\]\s*TJ/g;
  while ((m = reTJ.exec(src))) takePdfTokens(m[1], parts);
  return parts.join('').replace(/\r\n/g, '\n');
}

function dictBefore(latin, streamAt) {
  const from = Math.max(0, streamAt - 800);
  return latin.slice(from, streamAt);
}

function streamPayload(u8, latin, streamKwAt) {
  // "stream" 后接 \r\n 或 \n，载荷直到 endstream
  let i = streamKwAt + 6;
  if (latin[i] === '\r') i++;
  if (latin[i] === '\n') i++;
  const end = latin.indexOf('endstream', i);
  if (end < 0) return null;
  let hi = end;
  if (latin[hi - 1] === '\n') hi--;
  if (latin[hi - 1] === '\r') hi--;
  return u8.subarray(i, hi);
}

export async function extractPdfText(bytes, { maxChars = 80000 } = {}) {
  const u8 = toU8(bytes);
  if (!isPdfBytes(u8)) {
    return { ok: false, error: '不是 PDF 文件（缺少 %PDF- 头）', text: '', pages: 0 };
  }
  const latin = LATIN ? LATIN.decode(u8) : '';
  const pages = (latin.match(/\/Type\s*\/Page(?![sA-Z])/g) || []).length;
  const chunks = [];
  let from = 0;
  while (from < latin.length) {
    const at = latin.indexOf('stream', from);
    if (at < 0) break;
    // 避开 endstream 里的 stream
    if (at >= 3 && latin.slice(at - 3, at) === 'end') { from = at + 6; continue; }
    if (at > 0 && /[A-Za-z]/.test(latin[at - 1])) { from = at + 6; continue; }
    const dict = dictBefore(latin, at);
    const payload = streamPayload(u8, latin, at);
    from = at + 6;
    if (!payload || !payload.length) continue;
    // 图像流没有文本算子， squirt 过去
    if (/\/Subtype\s*\/Image/.test(dict)) continue;
    let body = payload;
    if (/\/Filter\s*\/FlateDecode/.test(dict) || /\/Filter\s*\[\s*\/FlateDecode/.test(dict)) {
      const inf = await inflateZlib(payload);
      if (!inf) continue;
      body = inf;
    }
    const text = LATIN ? LATIN.decode(body) : '';
    if (/Tj|TJ|T\*|Td|TD|'|"/.test(text)) {
      const got = extractFromContent(text);
      if (got && got.trim()) chunks.push(got);
    }
  }
  let text = chunks.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  // 去拉丁 1 控制符
  text = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  if (!text) {
    return { ok: false, error: '未能从 PDF 提取出文字（可能是扫描件、加密文档或 CID 字体）', text: '', pages };
  }
  const truncated = text.length > maxChars;
  if (truncated) text = text.slice(0, maxChars) + `\n\n…[PDF 正文过长，已截断至 ${maxChars} 字符]`;
  return { ok: true, text, pages, truncated, chars: text.length };
}

export function formatExtractedPdf(name, result) {
  const n = String(name || 'document.pdf');
  const pages = result && result.pages ? ` · ${result.pages} 页` : '';
  const head = `[PDF 提取 · ${n}${pages}]`;
  if (!result || !result.ok) {
    return `${head}\n提取失败：${(result && result.error) || '未知错误'}\n（扫描件、加密 PDF 或 CID 字体目前无法还原文字）\n`;
  }
  return `${head}\n\n${result.text}\n`;
}

export function pdfTextName(name) {
  const n = String(name || 'document.pdf').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim() || 'document.pdf';
  return /\.pdf$/i.test(n) ? `${n}.txt` : `${n}.pdf.txt`;
}

export async function extractPdfFromDataUrl(dataUrl, opts) {
  const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(String(dataUrl || ''));
  if (!m) return { ok: false, error: '不是 data URL', text: '', pages: 0 };
  let bytes;
  if (m[2]) {
    const bin = atob(m[3]);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(m[3]));
  }
  return extractPdfText(bytes, opts);
}
