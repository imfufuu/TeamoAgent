// ─── 工具详情三窗口（2026.10.9.1 · 第 4 项）──────────────────────────────────────
// 「Ran command(s)」里每条命令展开后是三个窗口：COMMAND / STDOUT / STDERR（有内容才出现）。
// 每个窗口右上角各一枚复制按钮，复制的是本窗口的原文。替代旧版「入参 / 出参」两个按钮。
// 纯函数（不碰 DOM 状态），便于单测；ui.js 只负责接线。
import { esc } from './ui-markdown.js?v=2026.10.9.5';

/** execute_* 的结果正文里，错误段落的分隔标记（见 tools.js formatExecResult）。 */
export const WINDOW_ERROR_MARK = '── 错误 ──';
const COMMAND_PRIMARY_KEYS = Object.freeze(['code', 'command', 'query', 'url', 'path']);

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const prettyJson = (v) => {
  try { return JSON.stringify(v == null ? {} : v, null, 2); } catch { return String(v); }
};

/**
 * COMMAND 窗口：有代码 / 命令 / 查询词 / 地址 / 路径字段的，直接显示原文（多行代码不转义）；
 * 其余参数追加在下面的 JSON 里。没有任何主字段时整体显示格式化的入参 JSON。
 */
export function commandWindowText(args) {
  const a = isPlainObject(args) ? args : {};
  if (typeof a.__raw === 'string') return a.__raw;
  const key = COMMAND_PRIMARY_KEYS.find((k) => typeof a[k] === 'string' && a[k].trim());
  if (!key) return prettyJson(a);
  const rest = Object.fromEntries(Object.entries(a).filter(([k]) => k !== key));
  const head = String(a[key]).replace(/\s+$/, '');
  return Object.keys(rest).length ? `${head}\n\n${prettyJson(rest)}` : head;
}

/**
 * 把工具结果正文拆成 STDOUT / STDERR：
 * · 「── 错误 ──」之后的段落 → STDERR；
 * · 以 `[error] ` 开头的控制台行 → STDERR（沙箱里 console.error / 错误输出的级别）；
 * · 其余 → STDOUT（保留「── 控制台输出 ──」「── 返回值 ──」等分段标题，便于对照原文）。
 */
export function splitToolStreams(body) {
  const text = String(body == null ? '' : body);
  const at = text.indexOf(WINDOW_ERROR_MARK);
  const errorBlock = at >= 0 ? text.slice(at + WINDOW_ERROR_MARK.length).replace(/^\n/, '') : '';
  const main = at >= 0 ? text.slice(0, at) : text;
  const out = [];
  const err = [];
  for (const line of main.split('\n')) (/^\[error\] /.test(line) ? err : out).push(line);
  const stdout = out.join('\n').replace(/\s+$/, '').replace(/^\n+/, '');
  const stderr = [err.join('\n').trim(), errorBlock.trim()].filter(Boolean).join('\n');
  return { stdout, stderr };
}

/** 单个窗口的 HTML。body 为空串时由调用方决定占位文案（STDOUT 用「（空输出）」）。 */
function windowHtml({ kind, title, text, extraClass = '', copyLabel }) {
  const payload = String(text == null ? '' : text);
  return `<section class="chip-win chip-win-${kind}${extraClass}" data-win="${kind}">`
    + `<div class="chip-win-h"><span class="chip-win-t">${esc(title)}</span>`
    + `<button type="button" class="chip-copy" data-which="${kind}" aria-label="复制 ${esc(copyLabel || title)}" title="复制 ${esc(copyLabel || title)}">复制</button></div>`
    + `<pre class="chip-win-b${kind === 'command' ? '' : ' chip-result'}${kind === 'stderr' ? ' chip-result-err' : ''}">${esc(payload)}</pre>`
    + '</section>';
}

/**
 * 三窗口整体 HTML。
 * @param {object} p
 * @param {string} p.command  COMMAND 原文
 * @param {string} p.stdout   STDOUT 原文（空串 → 显示「（空输出）」或「（无标准输出）」）
 * @param {string} [p.stderr] STDERR 原文（空串 → 不出现该窗口）
 * @param {boolean} [p.missing] STDOUT 是「未收到出参」占位（加 tool-result-missing）
 */
export function renderToolWindowsHtml({ command = '', stdout = '', stderr = '', missing = false } = {}) {
  const err = String(stderr || '');
  const out = String(stdout || '');
  const emptyOut = err ? '（无标准输出）' : '（空输出）';
  return `<div class="fold-inner tool-windows">`
    + windowHtml({ kind: 'command', title: 'COMMAND', text: command, copyLabel: 'COMMAND' })
    + windowHtml({ kind: 'stdout', title: 'STDOUT', text: out || emptyOut, extraClass: missing ? ' tool-result-missing' : '', copyLabel: 'STDOUT' })
    + (err ? windowHtml({ kind: 'stderr', title: 'STDERR', text: err, copyLabel: 'STDERR' }) : '')
    + '</div>';
}

export function toolWindowsOf(chip) {
    const ids = String(chip?.dataset.callIds || chip?.dataset.callId || '').split(',').filter(Boolean);
    const items = chip._items || [];
    const commands = [];
    const outs = [];
    const errs = [];
    let missing = false;
    ids.forEach((id, i) => {
      const item = items.find((t) => String(t && t.id) === id) || items[i] || {};
      commands.push(commandWindowText(item.args !== undefined ? item.args : chip._args));
      const state = (chip._toolStates && chip._toolStates[id]) || {};
      if (chip._outs && Object.hasOwn(chip._outs, id)) {
        const body = String(chip._outs[id] == null ? '' : chip._outs[id]);
        const split = splitToolStreams(body);
        let stdout = split.stdout;
        let stderr = split.stderr;
        // 失败但正文里没有「── 错误 ──」段（如 fetch_url 的「工具执行失败：…」）：整段正文就是错误信息
        if (!stderr && state.status === 'error' && body.trim()) { stdout = ''; stderr = body.trim(); }
        if (stdout) outs.push(stdout);
        if (stderr) errs.push(stderr);
      } else if (item.liveOutput) {
        if (item.liveOutput.stdout) outs.push(item.liveOutput.stdout);
        if (item.liveOutput.stderr) errs.push(item.liveOutput.stderr);
      } else if (state.status === 'ok') {
        outs.push('工具已结束，但未收到出参。');
        missing = true;
      } else if (state.status === 'error') {
        errs.push(state.note || '工具失败，但未收到结果正文。');
      }
    });
    return { command: commands.join('\n\n'), stdout: outs.join('\n\n'), stderr: errs.join('\n\n'), missing };
  }
