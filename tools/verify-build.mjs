#!/usr/bin/env node
// ─── 核对线上部署与仓库提交是否一字不差（P7 供应链可验证性）─────────────────
// 任何人都可以在自己的机器上跑：
//   git clone https://github.com/imfufuu/dubhe-agent && cd dubhe-agent
//   node tools/verify-build.mjs                      # 拉线上 build.json，checkout 到它声明的提交，逐文件比 sha256
//   node tools/verify-build.mjs --fetch              # 再把线上每个文件都下载一遍，确认「服务器实际发出的字节」= 清单 = 仓库
//   node tools/verify-build.mjs --url https://…/     # 核对别的部署（例如自建镜像）
//
// 退出码：0 一致；1 不一致（会逐条列出）；2 无法核对（网络 / 提交不存在 / 清单格式不对）。
// 它证明的只有「完整性与来源」：线上字节 == 该提交的字节；提交是否可信看签名（git log --show-signature），
// 代码是否无害、运行时是否按文档行事，这个脚本管不了，也不要假装它能。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildManifest } from './build-manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const BASE = opt('--url', 'https://imfufuu.github.io/dubhe-agent/').replace(/\/?$/, '/');
const FETCH_ALL = args.includes('--fetch');

export function diffManifests(remote, local) {
  const problems = [];
  const rf = remote.files || {};
  const lf = local.files || {};
  for (const k of Object.keys(rf)) {
    if (!lf[k]) problems.push({ path: k, kind: 'missing-in-repo', remote: rf[k].sha256 });
    else if (lf[k].sha256 !== rf[k].sha256) problems.push({ path: k, kind: 'sha-mismatch', remote: rf[k].sha256, local: lf[k].sha256 });
  }
  for (const k of Object.keys(lf)) if (!rf[k]) problems.push({ path: k, kind: 'missing-in-deploy', local: lf[k].sha256 });
  return problems;
}

async function main() {
  let remote;
  try {
    const res = await fetch(`${BASE}build.json?x=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    remote = await res.json();
  } catch (err) {
    console.error(`✗ 拉不到 ${BASE}build.json：${err && err.message || err}`);
    process.exit(2);
  }
  if (!remote || remote.schema !== 'dubhe-build-manifest/1' || !remote.commit || !remote.files) {
    console.error('✗ build.json 不是 dubhe-build-manifest/1 格式');
    process.exit(2);
  }
  console.log(`线上清单：commit ${remote.commit} · 版本 ${remote.version} · ${remote.file_count} 个文件 · 构建于 ${remote.built_at}`);

  // 把该提交导出到临时目录（不动当前工作区），在那上面算本地清单
  let tmp;
  try {
    execSync(`git cat-file -e ${remote.commit}^{commit}`, { cwd: ROOT, stdio: 'ignore' });
  } catch {
    try { execSync(`git fetch --quiet origin ${remote.commit}`, { cwd: ROOT, stdio: 'ignore' }); } catch { /* 下面再报 */ }
  }
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dubhe-verify-'));
    execSync(`git archive --format=tar ${remote.commit} | tar -x -C "${tmp}"`, { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], shell: '/bin/sh' });
  } catch (err) {
    console.error(`✗ 本地仓库里没有提交 ${remote.commit}（先 git fetch），或导出失败：${String(err && err.stderr || err).slice(0, 200)}`);
    process.exit(2);
  }
  const local = buildManifest({ root: tmp, commit: remote.commit, now: new Date(remote.built_at || Date.now()) });
  const problems = diffManifests(remote, local);
  const headSha = (() => { try { return execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim(); } catch { return ''; } })();
  console.log(`仓库提交 ${remote.commit.slice(0, 12)}：${local.file_count} 个文件 · 清单摘要 ${local.manifest_sha256 === remote.manifest_sha256 ? '一致' : '不一致'}${headSha && headSha !== remote.commit ? `（注意：你本地 HEAD 是 ${headSha.slice(0, 12)}，线上部署的是 ${remote.commit.slice(0, 12)}）` : ''}`);

  let fetched = 0, fetchBad = 0;
  if (FETCH_ALL) {
    const { createHash } = await import('node:crypto');
    for (const [rel, meta] of Object.entries(remote.files)) {
      try {
        const res = await fetch(`${BASE}${rel.split('/').map(encodeURIComponent).join('/')}?x=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const sha = createHash('sha256').update(buf).digest('hex');
        fetched += 1;
        if (sha !== meta.sha256) { fetchBad += 1; problems.push({ path: rel, kind: 'served-bytes-mismatch', remote: meta.sha256, served: sha }); }
      } catch (err) {
        fetchBad += 1; problems.push({ path: rel, kind: 'fetch-failed', error: String(err && err.message || err) });
      }
    }
    console.log(`逐文件下载核对：${fetched} 个已核对 · ${fetchBad} 个异常`);
  }

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  if (!problems.length) {
    console.log(`✓ 线上部署与提交 ${remote.commit.slice(0, 12)} 逐文件一致（${local.file_count} 个文件）${FETCH_ALL ? '，且服务器实际发出的字节与清单一致' : ''}`);
    console.log('  注意：这只证明完整性与来源（线上 = 仓库该提交，提交签名另见 git log --show-signature），不证明代码无害或运行时行为。');
    process.exit(0);
  }
  console.log(`✗ 发现 ${problems.length} 处不一致：`);
  for (const p of problems.slice(0, 50)) console.log(`  - ${p.kind}  ${p.path}${p.remote ? `  线上 ${p.remote.slice(0, 12)}` : ''}${p.local ? `  仓库 ${p.local.slice(0, 12)}` : ''}${p.served ? `  实际发出 ${p.served.slice(0, 12)}` : ''}${p.error ? `  ${p.error}` : ''}`);
  if (problems.length > 50) console.log(`  …另有 ${problems.length - 50} 处`);
  process.exit(1);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
