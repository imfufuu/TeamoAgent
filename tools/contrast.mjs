#!/usr/bin/env node
// ─── WCAG 2.x 对比度量化（2026.10.9.1 · 第 3 条）──────────────────────────────
// 直接读取 css/styles.css 里的主题令牌（:root = 浅色，[data-theme="dark"] = 暗色），
// 按 WCAG 2.x 公式（相对亮度 + (L1+0.05)/(L2+0.05)）计算正文 / 次要文字与背景的对比度，
// 判定是否达到 AA：正文 ≥ 4.5:1，大字（≥ 18.66px 粗体或 ≥ 24px）≥ 3:1。
//
//   node tools/contrast.mjs            # 打印表格（退出码 0 = 全部达标 / 1 = 有不达标项）
//   node tools/contrast.mjs --json     # 机器可读输出（测试用）
//
// 被 tests/agent.test.mjs 的「暗色对比度」组引用：任何暗色文字令牌回退到不达标，测试即红。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const AA_NORMAL = 4.5;
export const AA_LARGE = 3;

const channel = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };

/** #rgb / #rrggbb → [r, g, b] */
export function parseHex(input) {
  let h = String(input || '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(h)) h = h.split('').map((x) => x + x).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error(`不是 #rgb / #rrggbb：${input}`);
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 相对亮度（WCAG 2.x §1.4.3） */
export function relativeLuminance(hex) {
  const [r, g, b] = parseHex(hex).map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 对比度（1 … 21） */
export function contrastRatio(fg, bg) {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function passesAA(ratio, { large = false } = {}) {
  return ratio >= (large ? AA_LARGE : AA_NORMAL);
}

/** 从 CSS 文本里取出某个选择器块内的 --令牌: 值 映射（只取纯色值，忽略 color-mix / rgba 之类） */
export function tokensOf(css, selector) {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`找不到 ${selector} 块`);
  const body = css.slice(start, css.indexOf('}', start));
  const out = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-f]{3,6})\s*;/gi)) out[m[1]] = m[2].toLowerCase();
  return out;
}

/**
 * 正文类文字令牌在各背景上的全部组合。
 * 文字令牌：--fg / --fg-2 / --fg-3 / --link / --accent / --warn（都在正文或界面文字里用到）
 * 背景令牌：--bg / --bg-soft / --bg-hover（聊天区、侧栏、悬停底）
 */
export const TEXT_TOKENS = Object.freeze(['--fg', '--fg-2', '--fg-3', '--link', '--accent', '--warn']);
export const SURFACE_TOKENS = Object.freeze(['--bg', '--bg-soft', '--bg-hover']);

export function auditTheme(tokens) {
  const rows = [];
  for (const fgName of TEXT_TOKENS) {
    for (const bgName of SURFACE_TOKENS) {
      const fg = tokens[fgName];
      const bg = tokens[bgName];
      if (!fg || !bg) continue;
      const ratio = contrastRatio(fg, bg);
      rows.push({ text: fgName, surface: bgName, fg, bg, ratio: Math.round(ratio * 100) / 100, pass: passesAA(ratio) });
    }
  }
  return rows;
}

export function auditFile(cssPath = path.join(ROOT, 'css', 'styles.css')) {
  const css = fs.readFileSync(cssPath, 'utf8');
  return {
    light: auditTheme(tokensOf(css, ':root')),
    dark: auditTheme(tokensOf(css, '[data-theme="dark"]')),
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = auditFile();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const theme of ['dark', 'light']) {
      console.log(`\n${theme === 'dark' ? '暗色（[data-theme="dark"]）' : '浅色（:root）'} · WCAG AA 正文 ≥ 4.5:1`);
      console.log('文字      背景        前景      背景色    对比度   结果');
      for (const r of report[theme]) {
        console.log(`${r.text.padEnd(9)} ${r.surface.padEnd(11)} ${r.fg}  ${r.bg}  ${r.ratio.toFixed(2).padStart(6)}:1  ${r.pass ? 'PASS' : 'FAIL'}`);
      }
    }
    const darkFails = report.dark.filter((r) => !r.pass);
    console.log(`\n暗色不达标项：${darkFails.length} 条${darkFails.length ? '' : '（全部通过）'}`);
    process.exitCode = darkFails.length ? 1 : 0;
  }
}
