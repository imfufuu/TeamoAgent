// ZIP 解压（STORE + DEFLATE）。新文件，避免给 zip.js 加导出触发混版缓存。

function toU8(bytes) {
  if (!bytes) return new Uint8Array(0);
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return new Uint8Array(0);
}

export function isZipBytes(bytes) {
  const u8 = toU8(bytes);
  return u8.length >= 4 && u8[0] === 0x50 && u8[1] === 0x4b && (u8[2] === 0x03 || u8[2] === 0x05 || u8[2] === 0x07);
}

function u16(u8, i) { return u8[i] | (u8[i + 1] << 8); }
function u32(u8, i) { return (u8[i] | (u8[i + 1] << 8) | (u8[i + 2] << 16) | (u8[i + 3] << 24)) >>> 0; }

function findEocd(u8) {
  const min = 22;
  if (u8.length < min) return -1;
  const start = Math.max(0, u8.length - min - 65535);
  for (let i = u8.length - min; i >= start; i--) {
    if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) return i;
  }
  return -1;
}

function safeRelPath(name) {
  const parts = String(name || '').replace(/\\/g, '/').split('/').map((s) => s.trim()).filter((s) => s && s !== '.');
  if (!parts.length || parts.some((p) => p === '..' || p.includes('\0'))) return '';
  if (/^[a-zA-Z]:/.test(parts[0])) return '';
  return parts.join('/');
}

async function inflateRaw(u8) {
  if (typeof DecompressionStream === 'function') {
    const ds = new DecompressionStream('deflate-raw');
    const buf = await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer();
    return new Uint8Array(buf);
  }
  const zlib = await import('node:zlib');
  const { promisify } = await import('node:util');
  return await promisify(zlib.inflateRaw)(u8);
}

function u8ToB64(u8) {
  const chunk = 0x8000;
  let s = '';
  for (let i = 0; i < u8.length; i += chunk) s += String.fromCharCode(...u8.subarray(i, i + chunk));
  return btoa(s);
}

function sniffEntry(path, bytes) {
  const n = String(path).toLowerCase();
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { kind: 'image', content: `data:image/jpeg;base64,${u8ToB64(bytes)}` };
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { kind: 'image', content: `data:image/png;base64,${u8ToB64(bytes)}` };
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { kind: 'image', content: `data:image/gif;base64,${u8ToB64(bytes)}` };
  }
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) {
    return { kind: 'image', content: `data:image/webp;base64,${u8ToB64(bytes)}` };
  }
  if (/\.(png|jpe?g|gif|webp)$/i.test(n) && bytes.length) {
    const mime = n.endsWith('.png') ? 'image/png' : n.endsWith('.gif') ? 'image/gif' : n.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    return { kind: 'image', content: `data:${mime};base64,${u8ToB64(bytes)}` };
  }
  let binary = false;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0) { binary = true; break; }
  if (binary) return { kind: 'bin', content: `data:application/octet-stream;base64,${u8ToB64(bytes)}` };
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return { kind: 'text', content: text };
}

/**
 * @returns {Promise<{ok:boolean, files:{path:string, kind:string, content:string}[], error?:string}>}
 */
export async function unpackZip(bytes, { maxFiles = 80, maxUncompressed = 24 * 1024 * 1024 } = {}) {
  const u8 = toU8(bytes);
  if (!isZipBytes(u8)) return { ok: false, files: [], error: '不是 ZIP 文件' };
  const eocd = findEocd(u8);
  if (eocd < 0) return { ok: false, files: [], error: 'ZIP 目录损坏（找不到 EOCD）' };
  const count = u16(u8, eocd + 10);
  const cdSize = u32(u8, eocd + 12);
  const cdOff = u32(u8, eocd + 16);
  if (cdOff + cdSize > u8.length) return { ok: false, files: [], error: 'ZIP 中央目录越界' };
  const files = [];
  let total = 0;
  let p = cdOff;
  const cdEnd = cdOff + cdSize;
  for (let n = 0; n < count && p + 46 <= cdEnd; n++) {
    if (u32(u8, p) !== 0x02014b50) break;
    const flag = u16(u8, p + 8);
    const method = u16(u8, p + 10);
    const comp = u32(u8, p + 20);
    const uncomp = u32(u8, p + 24);
    const nameLen = u16(u8, p + 28);
    const extraLen = u16(u8, p + 30);
    const commentLen = u16(u8, p + 32);
    const localOff = u32(u8, p + 42);
    const nameBytes = u8.subarray(p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (flag & 1) continue; // encrypted
    let name;
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes); }
    catch { name = new TextDecoder('latin1').decode(nameBytes); }
    if (name.endsWith('/')) continue;
    const rel = safeRelPath(name);
    if (!rel) continue;
    if (files.length >= maxFiles) return { ok: false, files, error: `条目超过 ${maxFiles} 个，已停止` };
    if (method !== 0 && method !== 8) continue;
    if (localOff + 30 > u8.length) continue;
    if (u32(u8, localOff) !== 0x04034b50) continue;
    const locName = u16(u8, localOff + 26);
    const locExtra = u16(u8, localOff + 28);
    const dataAt = localOff + 30 + locName + locExtra;
    const slice = u8.subarray(dataAt, dataAt + comp);
    let raw;
    try {
      raw = method === 0 ? slice : await inflateRaw(slice);
    } catch (err) {
      return { ok: false, files, error: `解压 ${rel} 失败：${err.message || err}` };
    }
    total += raw.length;
    if (total > maxUncompressed) return { ok: false, files, error: '解压后体积过大' };
    const { kind, content } = sniffEntry(rel, raw);
    files.push({ path: rel, kind, content });
  }
  if (!files.length) return { ok: false, files: [], error: 'ZIP 里没有可解压的文件（可能加密或全是目录）' };
  return { ok: true, files };
}

export async function unpackZipFromDataUrl(dataUrl, opts) {
  const s = String(dataUrl || '');
  const m = /^data:[^;,]*;base64,([\s\S]*)$/.exec(s);
  if (m) {
    const bin = atob(m[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return unpackZip(bytes, opts);
  }
  return unpackZip(new TextEncoder().encode(s), opts);
}
