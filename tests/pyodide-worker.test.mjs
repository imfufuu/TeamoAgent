// ─── Python 沙箱 Worker 真实运行测试（node tests/pyodide-worker.test.mjs）──
// 与另外三层测试一样：这是「跑真实的 js/worker-py.js」，不是照抄一份逻辑。
// worker 文件只依赖 self.postMessage / importScripts / loadPyodide 三个全局，
// 因此可以在 Node 里用极薄的垫片启动，用来验证：
//   ① Python 里对 FILES 的写入能回流到虚拟文件系统
//   ② 全局 result 能被捕获成工具返回值
//   ③ 常驻 Worker 不会把上一轮的 result 残留到本轮（曾经的真实缺陷：result 全局不清）
//   ④ Pyodide 的 API 名称必须是 proxy.toJs(...)（写成 pyodide.toJS 会抛错并被
//      catch 静默吞掉，①② 就会「看起来正常、实际全丢」）
// 需要本机装过 pyodide（npm i -D pyodide@0.26.4）；没装就跳过，不阻断 npm run test:all。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

let loadPyodide;
try {
  ({ loadPyodide } = await import('pyodide'));
} catch {
  console.log('⏭  tests/pyodide-worker.test.mjs 跳过：未安装 pyodide 包（npm i -D pyodide@0.26.4 后可运行）');
  process.exit(0);
}

const require = createRequire(import.meta.url);
// 包目录（含 pyodide.asm.wasm / python_stdlib.zip）：Node 侧 loadPyodide 只认本地路径
const PYODIDE_DIR = require.resolve('pyodide').replace(/[^/]+$/, '');

const posted = [];
globalThis.self = { postMessage: (m) => posted.push(m) };
globalThis.importScripts = () => {}; // 浏览器里靠它注入 pyodide.js，Node 侧已准备好实现
// worker 里写的是 CDN indexURL（浏览器用途）；Node 的 pyodide 只认本地目录
globalThis.loadPyodide = (opts = {}) => loadPyodide({ ...opts, indexURL: PYODIDE_DIR });

await import(new URL('../js/worker-py.js', import.meta.url).href);

const run = (code, files) => new Promise((resolve, reject) => {
  const before = posted.length;
  const t0 = Date.now();
  const timer = setInterval(() => {
    const done = posted.slice(before).find((m) => m && m.ok !== undefined);
    if (done) { clearInterval(timer); resolve(done); }
    else if (Date.now() - t0 > 180000) { clearInterval(timer); reject(new Error('Pyodide 执行超时')); }
  }, 30);
  globalThis.self.onmessage({ data: { code, files } });
});

const out = [];
const ok = (name, cond, extra = '') => {
  assert.ok(cond, `${name}${extra ? ` — ${extra}` : ''}`);
  out.push(name);
  console.log(`  ✓ ${name}`);
};

const r1 = await run(`
nums = [int(x) for x in FILES['in/nums.txt'].split()]
FILES['out/sum.txt'] = str(sum(nums))
result = {'sum': sum(nums), 'n': len(nums)}
print('computed', sum(nums))
`, { 'in/nums.txt': '3 4 5 6' });

ok('Python 执行成功且 stdout 被捕获', r1.ok === true && /computed 18/.test(JSON.stringify(r1.logs)));
ok('FILES 写入回流到虚拟文件系统', r1.files && r1.files['out/sum.txt'] === '18', JSON.stringify(r1.files));
ok('全局 result 被捕获为返回值', typeof r1.result === 'string' && r1.result.includes('"sum":18'), String(r1.result));

// 第二轮故意不设 result：常驻 Worker 里若不清全局，本轮就会报出上一轮的 18
const r2 = await run(`print('second run, no result')`, {});
ok('下一轮不残留上一轮的 result', r2.ok === true && r2.result === undefined, JSON.stringify(r2));

// 报错路径：error 必须带 Python 的异常文本（工具层据此判 ✕）
const r3 = await run(`raise ValueError('boom-42')`, {});
ok('异常转成 error 且信息可见', r3.ok === false && /boom-42/.test(String(r3.error && r3.error.message)));

console.log(`\npyodide worker ${out.length} 项测试全部通过 ✅`);
