#!/usr/bin/env node
// ─── 部署产物清单（P7 供应链可验证性）────────────────────────────────────
// 在 Pages 部署（.github/workflows/pages.yml）打包前运行，把「这次发布到底是哪个提交、每个文件的 sha256 是多少」
// 写进产物根目录的 build.json。线上 https://imfufuu.github.io/dubhe-agent/build.json 可被任何人拉取，
// 用 tools/verify-build.mjs 与仓库里对应的提交逐文件比对。
//
// 边界（如实写在 README「供应链可验证性」）：这份清单 + 提交签名只覆盖「完整性与来源」——
// 线上字节 = 仓库该提交的字节、该提交由持有签名密钥者推出；不覆盖「代码本身无害」与「运行时行为」。
//
// 用法：node tools/build-manifest.mjs [--root .] [--out build.json] [--commit <sha>] [--print]
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT_DEFAULT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 不进清单：版本库元数据、依赖目录、清单自身、本地运行产生的目录；所有点开头的文件 / 目录也不算站点内容
export const MANIFEST_EXCLUDES = ['.git', 'node_modules', 'build.json', '.test-results', 'workspace', '__pycache__', '.DS_Store'];

export function listDeployFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (MANIFEST_EXCLUDES.includes(ent.name) || MANIFEST_EXCLUDES.includes(r)) continue;
      if (ent.name.startsWith('.')) continue; // .github / .gitignore 等点文件不是站点内容（Pages 也不保证会发出去）
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) walk(path.join(dir, ent.name), r);
      else if (ent.isFile()) out.push(r);
    }
  };
  walk(root, '');
  return out.sort();
}

export function sha256File(p) {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

export function readAppVersion(root) {
  try {
    const cfg = fs.readFileSync(path.join(root, 'js/config.js'), 'utf8');
    const m = /export const APP_VERSION = '([^']+)'/.exec(cfg);
    return m ? m[1] : '';
  } catch { return ''; }
}

function gitSha(root) {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try { return execSync('git rev-parse HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; }
}

export function buildManifest({ root = ROOT_DEFAULT, commit = '', now = new Date() } = {}) {
  const files = {};
  let total = 0;
  for (const rel of listDeployFiles(root)) {
    const abs = path.join(root, rel);
    const size = fs.statSync(abs).size;
    files[rel] = { sha256: sha256File(abs), size };
    total += size;
  }
  const entries = Object.keys(files);
  // 清单自身的摘要：对「路径\tsha256\n」逐行拼接再 sha256，方便只记一个值就能核对整份清单
  const manifestDigest = createHash('sha256').update(entries.map((k) => `${k}\t${files[k].sha256}\n`).join('')).digest('hex');
  return {
    schema: 'dubhe-build-manifest/1',
    app: 'Dubhe Agent',
    version: readAppVersion(root),
    commit: commit || gitSha(root),
    ref: process.env.GITHUB_REF || '',
    repository: process.env.GITHUB_REPOSITORY || 'imfufuu/dubhe-agent',
    workflow_run_id: process.env.GITHUB_RUN_ID || '',
    workflow_run_attempt: process.env.GITHUB_RUN_ATTEMPT || '',
    built_at: now.toISOString(),
    file_count: entries.length,
    total_bytes: total,
    manifest_sha256: manifestDigest,
    files,
  };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
  const root = path.resolve(opt('--root', ROOT_DEFAULT));
  const out = opt('--out', path.join(root, 'build.json'));
  const manifest = buildManifest({ root, commit: opt('--commit', '') });
  fs.writeFileSync(out, `${JSON.stringify(manifest, null, 1)}\n`);
  const line = `build.json：commit ${manifest.commit.slice(0, 12) || '(unknown)'} · 版本 ${manifest.version} · ${manifest.file_count} 个文件 · ${(manifest.total_bytes / 1048576).toFixed(1)} MB · 清单摘要 ${manifest.manifest_sha256.slice(0, 16)}…`;
  console.log(line);
  if (args.includes('--print')) console.log(JSON.stringify(manifest, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### 部署清单\n\n- commit \`${manifest.commit}\`\n- 版本 \`${manifest.version}\`\n- 文件 ${manifest.file_count} 个 · ${(manifest.total_bytes / 1048576).toFixed(1)} MB\n- 清单摘要 \`${manifest.manifest_sha256}\`\n`); } catch { /* 摘要写不进去不影响部署 */ }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
