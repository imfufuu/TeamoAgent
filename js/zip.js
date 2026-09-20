// ─── 极简 ZIP 打包（STORE，无压缩）─────────────────────────────────────
// 用途：把整个沙箱虚拟文件系统导出为一个 .zip 供用户下载。
// 浏览器没有内置 zip 能力，而为一次性导出引入几十 KB 依赖不划算，
// 这里手写 ZIP 容器（Local File Header + Central Directory + EOCD），
// 条目一律 STORE（method=0，正文原样存放，图片本身已是压缩格式）。
// 产出符合 APPNOTE 规范，可被 unzip / 系统归档工具与 Python zipfile 读取。

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// 沙箱文件值 → 字节：图片等二进制以 data URL 存放，解码还原真实字节；
// 其余按 UTF-8 文本处理。返回 { bytes, name }（文件名去掉 data URL 扩展名差异）
const B64_RE = /^data:([^;,]+)?;base64,([\s\S]*)$/;
export function fileBytesFromValue(value) {
  const s = value == null ? '' : String(value);
  const m = B64_RE.exec(s);
  if (m) {
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, mime: m[1] || 'application/octet-stream' };
  }
  return { bytes: new TextEncoder().encode(s), mime: 'text/plain' };
}

// data URL 里的 mime → 建议扩展名（写回文件名，解压后可直接打开）
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
export function withExtension(path, mime) {
  if (!mime || /\.[A-Za-z0-9]{1,5}$/.test(path)) return path;
  const ext = MIME_EXT[mime] || (String(mime).split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '');
  return `${path}.${ext}`;
}

function dosDateTime(d) {
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  return { date: date & 0xFFFF, time: time & 0xFFFF };
}

const enc = (s) => new TextEncoder().encode(s);

/**
 * 打包条目为 ZIP Blob。
 * @param {{name:string, bytes:Uint8Array, date?:Date}[]} entries
 * @returns {Blob}
 */
export function createZip(entries = []) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const dv = new DataView(new ArrayBuffer(30));

  const push = (bytes) => { chunks.push(bytes); offset += bytes.length; };

  for (const e of entries) {
    const nameBytes = enc(String(e.name).replace(/^\/+/, '').replace(/\\/g, '/'));
    const bytes = e.bytes || new Uint8Array(0);
    const crc = crc32(bytes);
    const { date, time } = dosDateTime(e.date || new Date());

    // Local File Header（30B + 名称）
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);          // version needed
    dv.setUint16(6, 0x0800, true);      // flags: UTF-8 文件名
    dv.setUint16(8, 0, true);            // method: store
    dv.setUint16(10, time, true);
    dv.setUint16(12, date, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, bytes.length, true); // compressed size
    dv.setUint32(22, bytes.length, true); // uncompressed size
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);            // extra len
    const localHeaderOffset = offset;
    push(new Uint8Array(dv.buffer.slice(0, 30)));
    push(nameBytes);
    push(bytes);

    // Central Directory 记录（46B + 名称）
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);           // version made by
    cd.setUint16(6, 20, true);           // version needed
    cd.setUint16(8, 0x0800, true);       // flags: UTF-8
    cd.setUint16(10, 0, true);           // method: store
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, bytes.length, true);
    cd.setUint32(24, bytes.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint16(30, 0, true);           // extra
    cd.setUint16(32, 0, true);           // comment
    cd.setUint16(34, 0, true);           // disk start
    cd.setUint16(36, 0, true);           // internal attrs
    cd.setUint32(38, 0o644 << 16, true); // external attrs（unix 权限）
    cd.setUint32(42, localHeaderOffset, true);
    central.push({ head: new Uint8Array(cd.buffer), name: nameBytes });
  }

  const cdStart = offset;
  for (const c of central) { push(c.head); push(c.name); }
  const cdSize = offset - cdStart;

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(4, 0, true);
  eocd.setUint16(6, 0, true);
  eocd.setUint16(8, central.length, true);
  eocd.setUint16(10, central.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, cdStart, true);
  eocd.setUint16(20, 0, true);
  chunks.push(new Uint8Array(eocd.buffer));

  return new Blob(chunks, { type: 'application/zip' });
}

// 便捷入口：沙箱 { path: value } 快照 → ZIP Blob（图片自动解码为二进制 + 补扩展名）
export function zipFileMap(files = {}, stamp = new Date()) {
  const entries = Object.entries(files).map(([path, value]) => {
    const { bytes, mime } = fileBytesFromValue(value);
    return { name: withExtension(path, mime.startsWith('image/') ? mime : ''), bytes, date: stamp };
  });
  return createZip(entries);
}
