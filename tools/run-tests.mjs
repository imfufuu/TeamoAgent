#!/usr/bin/env node
// ─── 统一测试入口（P5：外部验证闭环）────────────────────────────────────────
// 一条命令跑完 tests/ 下全部 .mjs（外加 python 护栏），并把「每个文件通过了多少项」从各自输出里
// 解析出来——数字由测试进程产出，不再手填进文档。
//
//   npm test                              # 全部（= CI 跑的那一套）
//   node tools/run-tests.mjs tests/x.mjs  # 单个文件（CI 每步调用它，顺手把计数写进 job summary）
//   node tools/run-tests.mjs --summary    # 读取本次 CI 各步落下的结果，汇总成 ::notice:: + Markdown 表
//   node tools/run-tests.mjs --list       # 只列出会跑哪些文件（给 ci.yml 覆盖率自检用）
//
// 规则：
//   · 需要外部资源的文件（真实网关 key / puppeteer / pyodide）自己打印「⏭ … 跳过」并以 0 退出，
//     这里把它们记为 skipped 而不是 pass——文档里的数字因此是「真跑过的」。
//   · 任一文件非 0 退出 → 整体非 0；但不会因为前面失败就不跑后面（CI 里每个文件也是独立 step）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULT_DIR = process.env.DUBHE_TEST_RESULTS || path.join(ROOT, '.test-results');

// python 护栏也算在「全部」里（CI 与 npm test 行为一致）；放在最后，缺 python3 时记 skipped。
export const PYTHON_CHECKS = [
  { id: 'server.py py_compile', cmd: ['python3', '-m', 'py_compile', 'server.py'], countable: false },
  { id: 'tests/server_checks.py', cmd: ['python3', 'tests/server_checks.py'] },
  { id: 'tests/sandbox_server_checks.py', cmd: ['python3', 'tests/sandbox_server_checks.py'] },
];

export function listTestFiles() {
  return fs.readdirSync(path.join(ROOT, 'tests')).filter((f) => f.endsWith('.mjs')).sort().map((f) => `tests/${f}`);
}

// 各测试文件收尾行五花八门，这里只认「数字 + 通过」这类强信号；认不出就退回数 ✓ 行；再不行记 1（跑过且退出 0）。
export function parseCount(output) {
  const text = String(output || '');
  const rules = [
    /^#\s*pass\s+(\d+)/m,                       // node:test TAP 汇总（worker.test.mjs）
    /(\d+)\s*项(?:测试|护栏自检)?(?:全部)?通过/,     // agent.test「398 项测试全部通过」/ server_checks「65 项护栏自检通过」
    /(\d+)\s*通过\s*\/\s*\d+\s*失败/,              // assets-integrity「38 通过 / 0 失败」
    /(?:冒烟|评测|验收)[：:]\s*(\d+)\/\d+\s*通过/,  // p2/p3-kernel-smoke「40/40 通过」
    /全部通过[（(]\s*(\d+)\s*项/,
    /评测[（(]N=(\d+)[）)]与全部架构不变量校验通过/, // run-nexus-eval：按评测样本数计
  ];
  for (const re of rules) { const m = re.exec(text); if (m) return Number(m[1]); }
  const ticks = (text.match(/^\s*[✓✔]\s/gm) || []).length;
  return ticks || 1;
}

export function isSkipped(output) {
  return /^\s*(?:⏭|跳过)/m.test(String(output || '')) && !/[✓✔]\s/.test(String(output || ''));
}

function runOne(file) {
  const t0 = Date.now();
  const isPy = Array.isArray(file);
  const cmd = isPy ? file : ['node', file];
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd: ROOT, encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const spec = isPy ? PYTHON_CHECKS.find((c) => c.cmd === file) : null;
  const id = spec ? spec.id : file;
  if (r.error && r.error.code === 'ENOENT') return { id, status: 'skipped', count: 0, ms: Date.now() - t0, note: `未找到 ${cmd[0]}`, out };
  const status = r.status !== 0 ? 'fail' : (isSkipped(out) ? 'skipped' : 'pass');
  const count = status === 'pass' && !(spec && spec.countable === false) ? parseCount(out) : 0;
  const note = status === 'skipped' ? ((/^\s*(?:⏭\s*)?(.*?)$/m.exec(out.split('\n').find((l) => /⏭|跳过/.test(l)) || '') || [])[1] || '') : '';
  return { id, status, count, ms: Date.now() - t0, note: note.replace(/^tests\/[\w.-]+\s*/, '').slice(0, 120), out };
}

function saveResult(res) {
  fs.mkdirSync(RESULT_DIR, { recursive: true });
  const name = res.id.replace(/[^\w.-]+/g, '_');
  fs.writeFileSync(path.join(RESULT_DIR, `${name}.json`), JSON.stringify({ ...res, out: undefined }));
}

function loadResults() {
  if (!fs.existsSync(RESULT_DIR)) return [];
  return fs.readdirSync(RESULT_DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(RESULT_DIR, f), 'utf8')));
}

const ICON = { pass: '✅', fail: '❌', skipped: '⏭' };
function markdownTable(results) {
  const rows = results.map((r) => `| ${ICON[r.status]} ${r.status} | \`${r.id}\` | ${r.status === 'pass' && r.count ? r.count : '—'} | ${(r.ms / 1000).toFixed(1)}s | ${r.note || ''} |`);
  return ['| 状态 | 文件 | 通过项 | 耗时 | 备注 |', '|---|---|---:|---:|---|', ...rows].join('\n');
}
function noticeLine(results) {
  const ran = results.filter((r) => r.status === 'pass' && r.count > 0);
  const total = ran.reduce((s, r) => s + r.count, 0);
  const parts = ran.map((r) => `${r.id.replace(/^tests\//, '').replace(/\.(test\.)?mjs$|\.py$/, '')} ${r.count}`);
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  return `测试计数（由 CI 产出）：合计 ${total} 项 · ${ran.length} 个文件真跑 · ${skipped} 个按需跳过${failed ? ` · ${failed} 个失败` : ''} ｜ ${parts.join(' / ')}`;
}
function appendStepSummary(md) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
}

// 只在作为入口脚本运行时执行；被 import（测试里校验 parseCount 等）时不跑任何东西——否则会递归跑到自己
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();

async function main() {
const args = process.argv.slice(2);
if (args.includes('--list')) {
  for (const f of listTestFiles()) console.log(f);
  for (const c of PYTHON_CHECKS) console.log(c.cmd.join(' '));
  process.exit(0);
}
if (args.includes('--summary')) {
  const results = loadResults().sort((a, b) => a.id.localeCompare(b.id));
  const line = noticeLine(results);
  console.log(line);
  console.log(`::notice title=测试计数::${line}`);
  appendStepSummary(`## 测试汇总\n\n${line}\n\n${markdownTable(results)}`);
  process.exit(results.some((r) => r.status === 'fail') ? 1 : 0);
}

const targets = args.length ? args : [...listTestFiles(), ...PYTHON_CHECKS.map((c) => c.cmd)];
const single = args.length === 1;
const results = [];
for (const t of targets) {
  // 允许用 id / 文件名 指定 python 护栏：`server_checks.py`、`tests/server_checks.py`、`server.py`
  const py = typeof t === 'string' ? PYTHON_CHECKS.find((c) => c.id === t || c.cmd.some((x) => x === t || x.endsWith('/' + t))) : null;
  const file = py ? py.cmd : t;
  const res = runOne(file);
  results.push(res);
  if (single || res.status === 'fail') process.stdout.write(res.out);
  console.log(`${ICON[res.status]} ${res.id} — ${res.status}${res.status === 'pass' && res.count ? ` ${res.count} 项` : ''}${res.note ? `（${res.note}）` : ''} · ${(res.ms / 1000).toFixed(1)}s`);
  saveResult(res);
  if (single) appendStepSummary(`- ${ICON[res.status]} \`${res.id}\` ${res.status}${res.status === 'pass' && res.count ? ` · ${res.count} 项` : ''}${res.note ? ` · ${res.note}` : ''}`);
}
if (!single) {
  console.log('\n' + markdownTable(results));
  console.log('\n' + noticeLine(results));
}
process.exit(results.some((r) => r.status === 'fail') ? 1 : 0);
}
