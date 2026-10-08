// ─── P3 增量（Dubhe Helix 2.5 · P3）：编辑可视化 —— 「正在写入的代码」预览 ──────────
// 目标（用户诉求）：编辑文件时显示 "Editing File(s)"，展开能看到具体在改哪些文件；
// 下方一个小窗口，每隔几秒刷新最近写入的 ~10 行代码。
//
// 为什么不直接把 toolCalls 里的完整 content 丢给界面：
//   1) 写入内容可能上百 KB，每帧重算会拖慢渲染 → 这里只截尾部 N 行、且有字符上限；
//   2) 流式期间 arguments 是**半截 JSON**（api.js 的累积器解析失败时给 { __raw }），
//      直接 JSON.parse 拿不到东西，用户就只能等整段写完才看到任何预览。
//      scanJSONString 专门吃这种半截文本：按 JSON 转义规则扫一个键的字符串值，
//      未闭合就是「还在写」——这正是预览要显示的中间态。
//
// 本模块是纯函数（无 DOM、无 store），既能被 agent 调用，也能在 node 里直接测。

export const EDIT_PREVIEW_POLICY_VERSION = 'edit-preview-2.5.1';
export const EDIT_PREVIEW_SCHEMA_VERSION = 'edit-preview-schema-1';

/** 预览窗口显示的行数（用户要求「10 行左右」）。 */
export const PREVIEW_LINES = 10;
/** 参与行切分的尾部字符上限：超长内容只取尾部，保证每帧计算是常数级。 */
export const PREVIEW_SCAN_CHARS = 4000;
/** 单行显示上限：压缩过的单行 JSON/日志可能上万字符，截断避免把布局撑破。 */
export const PREVIEW_LINE_MAX = 240;
/**
 * 预览窗刷新节流（毫秒）：直播期间每 ~2.5 秒刷一次，换文件/收尾时立即刷。
 * 用户要的是「每隔几秒刷新最近写入的几行」，不是每帧重排——长文件逐帧重建会把界面拖卡。
 */
export const PREVIEW_REFRESH_MS = 2500;

/** 会产生「文件写入」预览的工具（可扩展；默认只认 write_file）。 */
export const EDIT_TOOLS = Object.freeze(['write_file']);

export const EDIT_MODES = Object.freeze({
  overwrite: { id: 'overwrite', label: '整文件写入' },
  append: { id: 'append', label: '追加写入' },
  replace: { id: 'replace', label: '局部替换' },
});

const unescapeJSONChar = (ch) => {
  switch (ch) {
    case 'n': return '\n';
    case 't': return '\t';
    case 'r': return '\r';
    case 'b': return '\b';
    case 'f': return '\f';
    case '"': return '"';
    case '\\': return '\\';
    case '/': return '/';
    default: return null;   // 交给 \u 分支或原样处理
  }
};

/**
 * 从**可能被截断**的 JSON 文本里扫出一个字符串键的值。
 * 返回 { found, value, complete, startIndex, endIndex }：
 *   complete=false 表示字符串没闭合（内容还在流式到达）→ 预览按「写入中」呈现。
 */
export function scanJSONString(text, key) {
  const src = String(text == null ? '' : text);
  if (!src || !key) return { found: false, value: '', complete: false };
  const needle = `"${key}"`;
  let at = src.indexOf(needle);
  while (at >= 0) {
    // 键必须是「某个对象的键」：后面允许空白 + 冒号
    let i = at + needle.length;
    while (i < src.length && /\s/.test(src[i])) i += 1;
    if (src[i] !== ':') { at = src.indexOf(needle, at + 1); continue; }
    i += 1;
    while (i < src.length && /\s/.test(src[i])) i += 1;
    if (src[i] !== '"') return { found: true, value: '', complete: false, startIndex: i, endIndex: i };
    i += 1;
    let out = '';
    let closed = false;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '\\') {
        const next = src[i + 1];
        if (next === undefined) { i += 1; break; }        // 转义符刚写到一半
        if (next === 'u') {
          const hex = src.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) { i += 1; break; }  // \uXXXX 还没写全
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        const mapped = unescapeJSONChar(next);
        out += mapped === null ? next : mapped;
        i += 2;
        continue;
      }
      if (ch === '"') { closed = true; i += 1; break; }
      out += ch;
      i += 1;
    }
    return { found: true, value: out, complete: closed, startIndex: at, endIndex: i };
  }
  return { found: false, value: '', complete: false };
}

/** 把一次工具调用的参数还原成「路径 + 内容」，同时兼容已解析对象与半截 JSON。 */
export function extractEditCall(call) {
  if (!call || typeof call !== 'object') return null;
  const raw = (call.args && typeof call.args === 'object' && typeof call.args.__raw === 'string')
    ? call.args.__raw
    : '';
  let path = '';
  let mode = '';
  let content = '';
  let complete = false;
  let replaceHint = '';
  if (raw) {
    const p = scanJSONString(raw, 'path');
    const m = scanJSONString(raw, 'mode');
    const c = scanJSONString(raw, 'content');
    const nw = scanJSONString(raw, 'new_text');
    const oldT = scanJSONString(raw, 'old_text');
    path = p.value || '';
    mode = m.value || '';
    if (c.found) { content = c.value; complete = c.complete; }
    if (!c.found && nw.found) { content = nw.value; complete = nw.complete; replaceHint = oldT.value || ''; }
    if (!path && !content) {
      // 参数还没写到任何有用的键（例如只收到 `{"pa`）→ 视为「正在准备」
      return { id: call.id, name: call.name, path: '', mode: '', content: '', complete: false, pending: true };
    }
  } else {
    const args = (call.args && typeof call.args === 'object') ? call.args : {};
    path = String(args.path || '');
    mode = String(args.mode || '');
    content = args.content != null ? String(args.content) : '';
    if (!content && args.new_text != null) {
      content = String(args.new_text);
      replaceHint = String(args.old_text || '');
    }
    complete = true;
  }
  if (!EDIT_MODES[mode]) mode = path && String(call.args && call.args.old_text || '').length ? 'replace' : (mode || 'overwrite');
  if (mode === 'overwrite' && replaceHint) mode = 'replace';
  return { id: call.id, name: call.name, path, mode, content, complete, pending: false };
}

/** 取一条消息里所有「写文件」类调用（保持模型给出的顺序）。 */
export function collectEdits(toolCalls = [], { tools = EDIT_TOOLS } = {}) {
  const list = Array.isArray(toolCalls) ? toolCalls : [];
  return list
    .filter((c) => c && tools.includes(c.name))
    .map((c) => extractEditCall(c))
    .filter((e) => e && (e.path || e.content || e.pending));
}

/** 字符数（不数 Unicode 字节：这里只用于面板展示，避免每次重绘做全文编码）。 */
export function charCount(text) {
  return String(text == null ? '' : text).length;
}

/**
 * 尾部 N 行。行号以**全量内容**为准（预览窗口要显示真实行号），
 * 但只对尾部 PREVIEW_SCAN_CHARS 个字符做切分。
 */
export function tailLines(text, { lines = PREVIEW_LINES, scanChars = PREVIEW_SCAN_CHARS, lineMax = PREVIEW_LINE_MAX } = {}) {
  const src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  const total = src.length ? src.split('\n').length : 0;
  const clipped = src.length > scanChars ? src.slice(-scanChars) : src;
  const all = clipped.length ? clipped.split('\n') : [];
  const take = all.slice(-lines);
  const startNo = total - take.length + 1;
  return {
    total,
    clipped: clipped.length !== src.length,
    truncatedLines: take.some((t) => t.length > lineMax),
    lines: take.map((t, i) => ({
      no: startNo + i,
      text: t.length > lineMax ? `${t.slice(0, lineMax)} …` : t,
    })),
  };
}

/**
 * 组装预览对象（agent 通过 getEditPreview 暴露给界面，界面不再自己解析 toolCalls）。
 * 返回 null 表示这条消息没有可预览的写入。
 */
export function buildEditPreview(toolCalls = [], { now = () => Date.now(), lines = PREVIEW_LINES } = {}) {
  const edits = collectEdits(toolCalls);
  if (!edits.length) return null;
  const withPath = edits.filter((e) => e.path);
  const last = withPath.length ? withPath[withPath.length - 1] : edits[edits.length - 1];
  const tail = tailLines(last.content, { lines });
  const samePath = withPath.filter((e) => e.path === last.path);
  const modeDef = EDIT_MODES[last.mode] || EDIT_MODES.overwrite;
  return {
    policyVersion: EDIT_PREVIEW_POLICY_VERSION,
    path: last.path,
    mode: last.mode,
    modeLabel: modeDef.label,
    lines: tail.lines,
    lineCount: tail.total,
    clipped: tail.clipped,
    truncatedLines: tail.truncatedLines,
    chars: charCount(last.content),
    // 展示用单位标签：字符数 ≠ 字节数，如实标注，不假装是体积
    unit: '字符',
    paths: [...new Set(edits.map((e) => e.path).filter(Boolean))],
    writes: withPath.length,
    samePathWrites: samePath.length,
    pending: !!last.pending,
    complete: !!last.complete,
    status: last.complete ? 'written' : 'streaming',
    at: now(),
  };
}

/** 一行摘要（面板头部 / 报告用）。 */
export function formatEditPreviewNote(preview) {
  if (!preview) return '';
  const bits = [preview.path || '(路径未定)'];
  bits.push(preview.complete ? preview.modeLabel : `${preview.modeLabel}·写入中`);
  if (preview.lineCount) bits.push(`${preview.lineCount} 行`);
  if (preview.chars) bits.push(`${preview.chars} 字符`);
  if (preview.paths.length > 1) bits.push(`本轮共 ${preview.paths.length} 个文件`);
  return bits.join(' · ');
}

/**
 * 只取路径清单（供 "Editing File(s)" 折叠行使用）：
 * 流式期间也能给出路径——半截 JSON 里 path 通常先到。
 */
export function pathsOfEdits(toolCalls = []) {
  return [...new Set(collectEdits(toolCalls).map((e) => e.path).filter(Boolean))];
}

/** 面板文案：编辑中 / 已完成。用户要求直播时显示 Editing File(s)。 */
export function editFoldLabel(count, { live = false } = {}) {
  const n = Number(count) || 0;
  if (live) return n === 1 ? 'Editing file' : `Editing files ${n}`;
  return n === 1 ? 'Edited file' : `Edited files ${n}`;
}

/**
 * P2 修正：找同一回合里 agent 挂上的临时沙箱提交结果（tempCommit = { committed, discarded }）。
 * 回合边界 = 相邻两条 user 消息之间；顺带算出整轮有没有 write_file，供 UI 决定丢弃清单画在哪条消息上。
 */
export function turnRange(messages, idx) {
  const msgs = Array.isArray(messages) ? messages : [];
  if (!(idx >= 0 && idx < msgs.length)) return [0, -1];
  let lo = idx; let hi = idx;
  while (lo - 1 >= 0 && msgs[lo - 1].role !== 'user') lo--;
  while (hi + 1 < msgs.length && msgs[hi + 1].role !== 'user') hi++;
  return [lo, hi];
}

export function findTurnTempCommit(messages, idx, pathsOfEdit = () => []) {
  const msgs = Array.isArray(messages) ? messages : [];
  const [lo, hi] = turnRange(msgs, idx);
  if (hi < lo) return null;
  let tc = null; let turnHasEdits = false;
  for (let i = hi; i >= lo; i--) {
    const x = msgs[i];
    if (!x || x.role !== 'assistant') continue;
    if (!tc && x.tempCommit && typeof x.tempCommit === 'object') tc = x.tempCommit;
    if (pathsOfEdit(x).length) turnHasEdits = true;
  }
  return tc ? { committed: tc.committed || [], discarded: tc.discarded || [], turnHasEdits } : null;
}

/** 丢弃清单只画一次：有 Edited 折叠就画在那块上；整轮没 write_file 时画在挂着 tempCommit 的最终消息上 */
export function discardedForFold(tempCommit, { editedCount = 0, hostHasCommit = false } = {}) {
  if (!tempCommit) return [];
  const show = editedCount > 0 || (!tempCommit.turnHasEdits && hostHasCommit);
  return show ? (tempCommit.discarded || []).slice() : [];
}

/** 整轮没有 write_file、只剩丢弃项时的折叠标题 */
export function discardedFoldLabel(count) {
  const n = Number(count) || 0;
  return n === 1 ? 'Discarded File' : `Discarded Files ${n}`;
}
