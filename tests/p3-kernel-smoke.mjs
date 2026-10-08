// ─── P3 增量冒烟（Dubhe Helix 2.5 · P3）─────────────────────────────────────────────
// 目的：把编辑直播预览在**真实数据形状**上跑一遍，断言可核验的输出。
//   · js/editpreview.js —— 流式半截 JSON → 最近 N 行预览窗
// 运行：node tests/p3-kernel-smoke.mjs
//
// 纪律：不 mock 被测模块；半截 JSON 与 Unicode 转义必须无损。

import { strict as assert } from 'node:assert';
import {
  EDIT_PREVIEW_POLICY_VERSION, PREVIEW_LINES, EDIT_TOOLS,
  scanJSONString, extractEditCall, collectEdits, charCount, tailLines,
  buildEditPreview, formatEditPreviewNote, pathsOfEdits, editFoldLabel,
} from '../js/editpreview.js';

let passed = 0;
const failures = [];
const check = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { failures.push({ name, message: err.message }); console.log(`  ✗ ${name}\n      ${err.message}`); }
};
const group = (title) => console.log(`\n${title}`);

// ── 真实数据形状：写文件工具的流式参数 ────────────────────────────────────
// 模型流式输出参数时，累积器在 JSON 还没闭合前给 { __raw: '<半截 JSON>' }（见 js/api.js）。
const writeCall = (path, content, extra = {}) => ({ id: `c_${path}`, name: 'write_file', args: { path, content, ...extra } });
const rawCall = (id, raw) => ({ id, name: 'write_file', args: { __raw: raw } });

// ════════════════════════════════════════════════════════════════════════════
group('一、编辑直播预览（editpreview.js）：半截 JSON 也要看得见');

check('scanJSONString：完整 JSON 取到字符串值并标记 complete', () => {
  const r = scanJSONString('{"path":"a.md","content":"hello"}', 'content');
  assert.equal(r.found, true);
  assert.equal(r.value, 'hello');
  assert.equal(r.complete, true);
});

check('scanJSONString：半截 JSON（字符串未闭合）→ complete=false，已到达的内容仍然可用', () => {
  const r = scanJSONString('{"path":"out/report.md","content":"第一行\\n第二行\\n第三', 'content');
  assert.equal(r.found, true);
  assert.equal(r.complete, false, '未闭合必须判为「还在写」');
  assert.equal(r.value, '第一行\n第二行\n第三', '转义 \\n 必须还原成真实换行');
  assert.equal('out/report.md', scanJSONString('{"path":"out/report.md","content":"x', 'path').value);
});

check('scanJSONString：转义与 \\uXXXX 在截断边界上不崩', () => {
  assert.equal(scanJSONString('{"c":"a\\"b"}', 'c').value, 'a"b');
  assert.equal(scanJSONString('{"c":"\\u4e2d\\u6587"}', 'c').value, '中文');
  // 刚好截在转义符 / \u 中间：不能抛异常，且标记未完成
  assert.equal(scanJSONString('{"c":"abc\\', 'c').complete, false);
  assert.equal(scanJSONString('{"c":"abc\\u4e', 'c').complete, false);
  assert.equal(scanJSONString('{"c":"abc\\u4e2d', 'c').value, 'abc中');
  assert.equal(scanJSONString('', 'c').found, false);
  assert.equal(scanJSONString('{"other":1}', 'c').found, false);
});

check('extractEditCall：已解析对象 / 半截 JSON / 参数未到 三种形态都能识别', () => {
  const done = extractEditCall(writeCall('notes.md', '# 标题\n正文'));
  assert.equal(done.path, 'notes.md');
  assert.equal(done.content, '# 标题\n正文');
  assert.equal(done.complete, true);
  const streaming = extractEditCall(rawCall('x1', '{"path":"tmp/draft.md","content":"abc\\ndef'));
  assert.equal(streaming.path, 'tmp/draft.md');
  assert.equal(streaming.complete, false, '半截 JSON 必须判为写入中');
  const pending = extractEditCall(rawCall('x2', '{"pa'));
  assert.equal(pending.pending, true);
  assert.equal(pending.path, '');
  assert.equal(extractEditCall(null), null);
});

check('extractEditCall：局部替换（new_text/old_text）也当作一次编辑', () => {
  const e = extractEditCall({ id: 'c1', name: 'write_file', args: { path: 'a.md', old_text: '旧', new_text: '新' } });
  assert.equal(e.mode, 'replace');
  assert.equal(e.content, '新');
});

check('collectEdits 只收写文件类工具；pathsOfEdits 去重且保序', () => {
  const calls = [
    writeCall('a.md', '1'),
    { id: 'c2', name: 'read_file', args: { path: 'b.md' } },
    writeCall('tmp/x.json', '{}'),
    writeCall('a.md', '2'),
  ];
  assert.equal(EDIT_TOOLS.includes('write_file'), true);
  const edits = collectEdits(calls);
  assert.equal(edits.length, 3, `应识别 3 次写入，实际 ${edits.length}`);
  assert.deepEqual(pathsOfEdits(calls), ['a.md', 'tmp/x.json'], '同一路径只列一次');
});

check(`tailLines：只取尾部 ${PREVIEW_LINES} 行，行号以全量内容为准`, () => {
  const text = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行`).join('\n');
  const t = tailLines(text);
  assert.equal(t.total, 40, '总行数必须是全量内容的行数');
  assert.equal(t.lines.length, PREVIEW_LINES);
  assert.equal(t.lines[0].no, 40 - PREVIEW_LINES + 1, '首行行号 = 总行数 - 预览行数 + 1');
  assert.equal(t.lines[t.lines.length - 1].no, 40);
  // 超长单行截断（压缩过的 JSON/日志可能上万字符）
  const long = tailLines('x'.repeat(5000));
  assert.equal(long.truncatedLines, true);
  assert.ok(long.lines[0].text.length < 5000, '单行必须截断显示');
  // 超大内容只扫尾部
  const huge = tailLines(`${'a'.repeat(9000)}\n尾部一行`);
  assert.equal(huge.clipped, true);
  assert.equal(huge.lines[huge.lines.length - 1].text, '尾部一行');
});

check('buildEditPreview：字段齐全（路径 / 模式 / 行数 / 字符数 / 状态 / 同路径写入次数）', () => {
  const calls = [
    writeCall('out/report.md', 'a\nb\nc', { mode: 'overwrite' }),
    writeCall('tmp/scratch.json', '{"x":1}'),
    writeCall('out/report.md', 'a\nb\nc\nd'),
  ];
  const p = buildEditPreview(calls);
  assert.equal(p.policyVersion, EDIT_PREVIEW_POLICY_VERSION);
  assert.equal(p.path, 'out/report.md', '预览取最后一次写入');
  assert.equal(p.modeLabel, '整文件写入');
  assert.equal(p.lineCount, 4);
  assert.equal(p.chars, charCount('a\nb\nc\nd'));
  assert.equal(p.status, 'written');
  assert.equal(p.complete, true);
  assert.deepEqual(p.paths, ['out/report.md', 'tmp/scratch.json']);
  assert.equal(p.writes, 3);
  assert.equal(p.samePathWrites, 2);
  assert.equal(p.unit, '字符', '单位如实标注为字符（不是字节）');
  assert.equal(buildEditPreview([]), null, '没有写入 → null，界面不应画预览窗');
  assert.equal(buildEditPreview(undefined), null);
});

check('buildEditPreview：流式中判 streaming，写完才判 written', () => {
  const live = buildEditPreview([rawCall('l1', '{"path":"big.md","content":"line1\\nline2')]);
  assert.equal(live.status, 'streaming');
  assert.equal(live.complete, false);
  assert.equal(live.path, 'big.md');
  assert.ok(live.lines.length >= 1, '流式期间也应能显示已到达的行');
  const done = buildEditPreview([writeCall('big.md', 'line1\nline2')]);
  assert.equal(done.status, 'written');
});

check('文案：折叠行直播显示 Editing files，完成显示 Edited files N', () => {
  assert.equal(editFoldLabel(1, { live: true }), 'Editing file');
  assert.equal(editFoldLabel(2, { live: true }), 'Editing files 2');
  assert.equal(editFoldLabel(1), 'Edited file');
  assert.equal(editFoldLabel(3), 'Edited files 3');
  const note = formatEditPreviewNote(buildEditPreview([writeCall('a.md', 'x\ny')]));
  assert.ok(note.includes('a.md') && note.includes('2 行'), note);
  assert.equal(formatEditPreviewNote(null), '');
});

// ════════════════════════════════════════════════════════════════════════════

// ────────────────────────────────────────────────────────────────────────────
const total = passed + failures.length;
console.log(`\nP3 增量冒烟：${passed}/${total} 通过${failures.length ? ` ❌\n${failures.map((f) => `  · ${f.name}：${f.message}`).join('\n')}` : ' ✅'}`);
process.exit(failures.length ? 1 : 0);
