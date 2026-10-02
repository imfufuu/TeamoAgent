// ─── P3 增量冒烟（THN v2.5.1）─────────────────────────────────────────────
// 目的：把 P3 的两个新模块在**真实数据形状**上跑一遍，断言可核验的输出。
//   · js/editpreview.js —— 编辑直播预览（流式半截 JSON → 最近 N 行预览窗）
//   · js/cleanup.js     —— 任务后文件自清理（只删自己创建的临时文件）
// 运行：node tests/p3-kernel-smoke.mjs
//
// 纪律：不 mock 被测模块；坏输入必须 fail-safe（宁可漏删，不可错删）。

import { strict as assert } from 'node:assert';
import {
  EDIT_PREVIEW_POLICY_VERSION, PREVIEW_LINES, EDIT_TOOLS,
  scanJSONString, extractEditCall, collectEdits, charCount, tailLines,
  buildEditPreview, formatEditPreviewNote, pathsOfEdits, editFoldLabel,
} from '../js/editpreview.js';
import {
  CLEANUP_POLICY_VERSION, CLEANUP_MODES, SCRATCH_DIRS,
  normalizeCleanupPolicy, cleanupPolicyOf, isScratchDir, isScratchExt, isScratchName,
  isProtectedPath, isReferenced, planCleanup, applyCleanup, mergeArtifacts, pruneArtifacts,
  formatCleanupBrief, formatCleanupReport, formatChars,
} from '../js/cleanup.js';

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

check('文案：折叠行直播显示 Editing File(s)，完成显示 Edited File(s) N', () => {
  assert.equal(editFoldLabel(1, { live: true }), 'Editing File');
  assert.equal(editFoldLabel(2, { live: true }), 'Editing File(s) 2');
  assert.equal(editFoldLabel(1), 'Edited File');
  assert.equal(editFoldLabel(3), 'Edited File(s) 3');
  const note = formatEditPreviewNote(buildEditPreview([writeCall('a.md', 'x\ny')]));
  assert.ok(note.includes('a.md') && note.includes('2 行'), note);
  assert.equal(formatEditPreviewNote(null), '');
});

// ════════════════════════════════════════════════════════════════════════════
group('二、自清理策略（cleanup.js）：三档 + 分类 + 台账 + 删除核验');

check('三档策略：默认 strip；坏值回落 strip（不认识的档位不能变成「随机行为」）', () => {
  assert.deepEqual(Object.keys(CLEANUP_MODES).sort(), ['off', 'report', 'strip']);
  assert.equal(CLEANUP_MODES.strip.del, true);
  assert.equal(CLEANUP_MODES.report.del, false);
  assert.equal(CLEANUP_MODES.report.run, true, '只报告档也要扫描（否则用户看不到代价）');
  assert.equal(CLEANUP_MODES.off.run, false);
  assert.equal(normalizeCleanupPolicy(undefined), 'strip');
  assert.equal(normalizeCleanupPolicy('BOGUS'), 'strip');
  assert.equal(cleanupPolicyOf({}).id, 'strip');
  assert.equal(cleanupPolicyOf({ cleanupPolicy: 'off' }).id, 'off');
  assert.equal(CLEANUP_POLICY_VERSION, 'cleanup-policy-2.5.1');
});

check('临时文件分类：目录 / 后缀 / 命名三种规则，且不误伤同形词', () => {
  assert.equal(isScratchDir('tmp/a.json'), true);
  assert.equal(isScratchDir('a/b/scratch/x.txt'), false, '只有路径开头才算临时目录');
  assert.ok(SCRATCH_DIRS.length >= 3);
  assert.equal(isScratchExt('notes.tmp'), true);
  assert.equal(isScratchExt('dump.log'), true);
  assert.equal(isScratchExt('report.md'), false);
  assert.equal(isScratchName('draft-notes.md'), true);
  assert.equal(isScratchName('tmp2.md'), false, 'tmp2 不是 tmp（按分隔符切分，不做前缀匹配）');
  assert.equal(isScratchName('report-tempest.md'), false, 'tempest 不是 temp');
  assert.equal(isScratchName('template.md'), false, 'template 不是 temp');
  assert.equal(isScratchName('调研草稿.md'), true, '中文按包含匹配');
  // 路径必须能落在真实沙箱命名空间里（a/b/c 形式）
  assert.equal(isScratchDir('./tmp/x'), true, './ 前缀不该影响判定');
});

check('受保护路径与引用判定：uploads/ 一定保留；回答/提问提到过的文件不删', () => {
  assert.equal(isProtectedPath('uploads/pic.png'), true);
  assert.equal(isProtectedPath('uploads/sub/deep.txt'), true);
  assert.equal(isProtectedPath('outputs/chart.svg'), false);
  assert.equal(isReferenced('outputs/final-report.md', ['见 outputs/final-report.md，结论如下']), true);
  assert.equal(isReferenced('outputs/final-report.md', ['报告已生成：final-report.md']), true, '只写文件名也算引用');
  assert.equal(isReferenced('outputs/final-report.md', ['生成了 outputs/final-report']), true, '不带扩展名也算');
  assert.equal(isReferenced('outputs/final-report.md', ['无关内容']), false);
});

// 一个「像真的」回合：Agent 自己写了交付物，也留了临时产物，中途还改了用户原件
const FILES = {
  'uploads/用户原始数据.csv': 'a,b\n1,2',
  'outputs/report.md': '# 报告\n结论如上',
  'tmp/debug.json': '{"step":1}',
  'scratch/try.py': 'print(1)',
  'notes.draft': '草稿',
  'empty-probe.txt': '',
  'src/main.js': 'console.log(1)',
  'outputs/chart.svg': '<svg/>',
};
const LEDGER = [
  { path: 'outputs/report.md' }, { path: 'tmp/debug.json' }, { path: 'scratch/try.py' },
  { path: 'notes.draft' }, { path: 'empty-probe.txt' }, { path: 'uploads/用户原始数据.csv' },
];

check('planCleanup：只删「台账内 + 命中临时规则 + 未被引用」的文件', () => {
  const plan = planCleanup({
    files: FILES, artifacts: LEDGER,
    answerText: '报告已生成：outputs/report.md（图表见 outputs/chart.svg）',
    userText: '帮我做一份数据报告',
  });
  const deleted = plan.deletes.map((d) => d.path).sort();
  assert.deepEqual(deleted, ['empty-probe.txt', 'notes.draft', 'scratch/try.py', 'tmp/debug.json'], JSON.stringify(deleted));
  assert.equal(plan.scanned, Object.keys(FILES).length);
  assert.equal(plan.ledgerSize, LEDGER.length);
  const ruleOf = (p) => (plan.deletes.find((d) => d.path === p) || {}).rule;
  assert.equal(ruleOf('tmp/debug.json'), 'scratch-dir');
  assert.equal(ruleOf('scratch/try.py'), 'scratch-dir');
  assert.equal(ruleOf('notes.draft'), 'scratch-ext');
  assert.equal(ruleOf('empty-probe.txt'), 'empty-agent-file');
  // 保留项必须有理由，而不是悄悄放过
  const keepOf = (p) => (plan.keeps.find((k) => k.path === p) || {}).rule;
  assert.equal(keepOf('uploads/用户原始数据.csv'), 'protectedPath', '用户原件永远不能进删除集合');
  assert.equal(keepOf('outputs/report.md'), 'referencedInAnswer', '回答里点名的交付物是交付物，不是垃圾');
  assert.equal(keepOf('outputs/chart.svg'), 'notAgentCreated', '没台账 = 不是本 Agent 创建 = 不碰');
  assert.equal(keepOf('src/main.js'), 'notAgentCreated');
  assert.equal(plan.deletes.every((d) => d.reason && d.reason.length), true, '每次删除都要给理由');
  assert.equal(plan.deletes.every((d) => 'preview' in d), true, '支持「删前看一眼」');
});

check('planCleanup：单轮上限截断为 deferred，不会一口气删光', () => {
  const files = {}; const artifacts = [];
  for (let i = 0; i < 30; i++) { files[`tmp/f${i}.json`] = 'x'; artifacts.push({ path: `tmp/f${i}.json` }); }
  const plan = planCleanup({ files, artifacts, maxDeletes: 24 });
  assert.equal(plan.deletes.length, 24);
  assert.equal(plan.deferred.length, 6);
  assert.ok(plan.deferred[0].reason.includes('下一轮'));
});

check('planCleanup：enabled=false（只报告档）仍给出「本来会删什么」', () => {
  const plan = planCleanup({ files: FILES, artifacts: LEDGER, answerText: '', userText: '', enabled: false });
  assert.equal(plan.enabled, false);
  assert.equal(plan.wouldDelete, plan.deletes.length);
  assert.ok(plan.deletes.length > 0, '关闭删除 ≠ 关闭检查：用户要看得到代价');
});

check('applyCleanup：删除后必须核验；核验不过 / remove 抛错都要如实报', () => {
  const files = { 'tmp/a.json': '{}', 'tmp/b.json': '{}' };
  const store = { ...files };
  const plan = planCleanup({ files, artifacts: [{ path: 'tmp/a.json' }, { path: 'tmp/b.json' }] });
  assert.equal(plan.deletes.length, 2);
  const okRun = applyCleanup({ plan, io: { remove: (p) => { delete store[p]; }, exists: (p) => p in store } });
  assert.equal(okRun.ok, true);
  assert.equal(okRun.verified, true);
  assert.equal(okRun.deleted.length, 2);
  assert.deepEqual(Object.keys(store), []);
  // 说删了却还在（例如被别的路径拦下）→ 不能报成功
  const liars = applyCleanup({ plan, io: { remove: () => {}, exists: () => true } });
  assert.equal(liars.verified, false);
  assert.equal(liars.ok, false);
  assert.equal(liars.survivors.length, 2);
  // remove 抛错 → failed 清单里如实记录，而不是静默跳过
  const broken = applyCleanup({ plan, io: { remove: () => { throw new Error('EPERM'); } } });
  assert.equal(broken.ok, false);
  assert.equal(broken.failed.length, 2);
  assert.ok(broken.failed[0].error.includes('EPERM'));
  // 没有计划 / 没有 io：不能装作清理过
  assert.equal(applyCleanup({ plan: null, io: {} }).skipped, true);
});

check('台账：去重 + 限容 + 瘦身（删干净的不再挂着）', () => {
  const merged = mergeArtifacts(
    [{ path: 'a.md', chars: 10 }, { path: 'b.md', chars: 20 }],
    [{ path: 'b.md', chars: 30, tool: 'write_file' }, { path: './c.md' }],
    { at: 1700000000000, turnId: 't1' },
  );
  assert.equal(merged.length, 3, '同路径合并，不重复记');
  assert.equal(merged.find((x) => x.path === 'b.md').chars, 30, '同一文件的新信息覆盖旧信息');
  assert.equal(merged.find((x) => x.path === 'c.md').path, 'c.md', './ 前缀要归一化');
  const capped = mergeArtifacts([], Array.from({ length: 260 }, (_, i) => ({ path: `f${i}` })), { max: 200 });
  assert.equal(capped.length, 200);
  assert.equal(capped[capped.length - 1].path, 'f259', '限容保留最新');
  const pruned = pruneArtifacts(merged, { 'a.md': 'x', 'c.md': 'y' });
  assert.deepEqual(pruned.map((x) => x.path), ['a.md', 'c.md'], '已被删除的文件不应留在台账里');
  assert.deepEqual(mergeArtifacts(undefined, undefined), []);
  assert.deepEqual(pruneArtifacts(null, {}), []);
});

check('报告格式化：简要 / 详情 / 字符数都如实（含「只报告不删」与核验失败）', () => {
  assert.equal(formatChars(999), '999 字符');
  assert.equal(formatChars(1500), '1.5K 字符');
  assert.equal(formatChars(1200000), '1.20M 字符');
  const plan = planCleanup({ files: FILES, artifacts: LEDGER, answerText: '', userText: '' });
  const brief = formatCleanupBrief({ deleted: plan.deletes.map((d) => ({ path: d.path })), deletedChars: plan.deleteChars });
  assert.ok(brief.startsWith('🧹') && brief.includes('4'), brief);
  const dry = formatCleanupReport({ ...plan, enabled: false }, null);
  assert.ok(dry.includes('只报告不删') || dry.includes('自动清理已关闭'), dry);
  const survivors = formatCleanupReport(plan, { deleted: plan.deletes.map((d) => ({ ...d })), deletedChars: plan.deleteChars, verified: false, survivors: ['tmp/debug.json'], failed: [] });
  assert.ok(survivors.includes('仍在文件系统里'), '核验失败必须出现在报告里');
  assert.ok(formatCleanupReport(plan, null).includes(CLEANUP_POLICY_VERSION));
});

// ────────────────────────────────────────────────────────────────────────────
const total = passed + failures.length;
console.log(`\nP3 增量冒烟：${passed}/${total} 通过${failures.length ? ` ❌\n${failures.map((f) => `  · ${f.name}：${f.message}`).join('\n')}` : ' ✅'}`);
process.exit(failures.length ? 1 : 0);
