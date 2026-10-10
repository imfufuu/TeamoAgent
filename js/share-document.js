import { renderGeoMapSvg } from './quickviz.js?v=2026.10.10.1';
import { decorateGeoMap } from './quickmap.js?v=2026.10.10.1';
import { renderMarkdown, renderAttachments, hydrateSandboxMedia, esc, sanitizeSvgRaw } from './ui-markdown.js?v=2026.10.10.1';
import { commandWindowText, splitToolStreams, renderToolWindowsHtml } from './toolwindows.js?v=2026.10.10.1';
import { APP_LOGO, providerIcon } from './icons.js';
import { providerOf, APP_VERSION } from './config.js?v=2026.10.10.1';
import { isSmartRouter, SMART_ROUTER_LABEL, ROUTER_ICON_SVG } from './smartrouter.js?v=2026.10.10.1';
import { getLanguage, text } from './locale.js';
const STYLE_URLS = ['../css/styles.css', '../assets/hljs/dubhe.css', '../assets/katex/katex.min.css', '../fonts/literary.css'];
export const SHARE_CSS = `
html,body{margin:0;min-height:100%;background:var(--bg);color:var(--fg)}body{display:block;height:auto;overflow:auto;font-family:var(--font);font-size:14px}
.share-page{width:min(760px,100%);margin:auto;padding:32px 0 24px;box-sizing:border-box}.share-page .msg{max-width:100%;margin-bottom:24px;animation:none!important;opacity:1;transform:none;overflow:visible}
.share-head{margin:0 28px 32px;border-bottom:1px solid var(--line);padding-bottom:20px;display:flex;gap:12px;align-items:center}.share-brand{width:32px;height:32px;flex:0 0 auto}.share-head h1{font-size:18px;line-height:1.4;margin:0;overflow-wrap:anywhere}.share-subtitle{font-family:var(--mono);font-size:10px;color:var(--fg-2);margin-top:5px}.share-footer{margin:28px 28px 0;border-top:1px solid var(--line);padding-top:18px;font-size:11px;color:var(--fg-2)}
.share-controls{display:flex;gap:8px;margin:0 28px 24px}.share-controls button,.share-copy{border:1px solid var(--line);border-radius:7px;background:var(--bg-soft);color:var(--fg-2);padding:5px 9px;font-size:11px;cursor:pointer}.share-page .tool-chips{display:block}.share-page .tool-call-chip{margin:8px 0}.share-page .chip-detail{overflow:visible}.share-page .expanded>.chip-detail{display:block;height:auto!important;max-height:none;opacity:1}.share-reason{margin:12px 0;border:1px solid var(--line);border-radius:10px;padding:12px;color:var(--fg-2);font-size:12px}.share-reason pre{white-space:pre-wrap;word-break:break-word;margin:10px 0 0}.share-file{display:inline-block;color:var(--link);border:1px solid var(--line);border-radius:8px;padding:8px 12px;text-decoration:none}
.share-overlay{position:fixed;inset:0;z-index:100;display:grid;place-items:center;padding:24px;background:rgba(0,0,0,.86)}.share-overlay img,.share-overlay video{max-width:95vw;max-height:88vh;object-fit:contain}.share-overlay button{position:absolute;right:20px;top:16px;background:transparent;color:white;border:0;font-size:28px;cursor:pointer}.share-page .copy-code,.share-page .chip-copy{cursor:pointer}.share-page .code-block pre,.share-page .chip-win-b{max-height:none}
@media print{.share-controls,.copy-code,.chip-copy,.share-copy{display:none}.share-page{width:100%}.share-page .msg{break-inside:avoid}}`;
const dataURL = (blob) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(blob); });
let stylesPromise;
export function shareStyles() {
  return stylesPromise ||= (async () => {
    const sheets = await Promise.all(STYLE_URLS.map(async (path) => {
      const base = new URL(path, import.meta.url); base.searchParams.set('v', APP_VERSION); const r = await fetch(base); if (!r.ok) throw new Error('无法加载分享样式：' + path);
      let css = await r.text();
      // The bundled KaTeX distribution retains WOFF2 only; remove non-existent legacy fallbacks.
      css = css.replace(/src\s*:\s*url\(([^)]*\.woff2[^)]*)\)[^;]*;/g, 'src:url($1) format("woff2");'); const matches = [...css.matchAll(/url\((?:['"])?([^)'"\s]+)(?:['"])?\)/g)];
      const unique = [...new Set(matches.map((m) => m[1]).filter((u) => !u.startsWith('data:')))];
      const replacements = new Map(await Promise.all(unique.map(async (url) => {
        const u = new URL(url, base); if (u.origin !== location.origin) return [url, 'data:,'];
        const res = await fetch(u, { credentials: 'omit' }); if (!res.ok) throw new Error('无法嵌入分享字体：' + u.pathname);
        return [url, await dataURL(await res.blob())];
      })));
      for (const [url, value] of replacements) css = css.split(url).join(value);
      return css;
    }));
    return sheets.join('\n') + '\n' + SHARE_CSS;
  })().catch((error) => { stylesPromise = null; throw error; });
}
function resultForCall(messages, m, c) {
  if (Object.hasOwn(c, 'finalOutput')) return String(c.finalOutput ?? '');
  const at = messages.indexOf(m); let i = at + 1;
  while (i < messages.length && messages[i].role === 'tool') { const r = messages[i++]; if (r.toolCallId === c.id) return String(r.content ?? ''); }
  return String(c.liveOutput ?? '');
}
export function snapshotMessage(m, messages, fs, { tools = false, reasoning = false } = {}) {
  const node = document.createElement('article'); node.className = `msg msg-${m.role}`; node.dataset.shareMessage = String(m.id);
  const router = isSmartRouter(m.userModel), model = router ? SMART_ROUTER_LABEL : m.model || 'Dubhe Agent';
  const avatar = router ? ROUTER_ICON_SVG : providerIcon(providerOf(model)) || APP_LOGO;
  const body = renderMarkdown(m.text || '') + renderAttachments(m.attachments || []);
  if (m.role === 'user') node.innerHTML = `<div class="bubble md-body">${body}</div>`;
  else node.innerHTML = `<div class="msg-head"><span class="avatar">${avatar}</span><span class="msg-model mono">${esc(model)}</span></div>`
    + (reasoning && m.reasoning ? `<details class="share-reason"><summary>${text('思考过程', 'Reasoning')}</summary><pre>${esc(m.reasoning)}</pre></details>` : '')
    + `<div class="md-body">${body}${m.error ? `<p class="error-notice">${esc(m.error)}</p>` : ''}</div>`;
  hydrateSandboxMedia(node, fs);
  if (tools && m.toolCalls?.length) {
    const box = document.createElement('div'); box.className = 'tool-chips';
    for (const c of m.toolCalls) {
      const windows = renderToolWindowsHtml({ command: commandWindowText(c.args), ...splitToolStreams(resultForCall(messages, m, c)) });
      const chip = document.createElement('div'); chip.className = 'tool-call-chip'; chip.setAttribute('role', 'button'); chip.tabIndex = 0;
      chip.innerHTML = `<span class="chip-ico">›</span><span class="chip-name mono">${esc(c.name || 'tool')}</span><div class="chip-detail">${windows}</div>`;
      box.append(chip);
    }
    node.append(box);
  }
  if (!body && !tools && m.toolCalls?.length) {
    const n = document.createElement('p'); n.className = 'share-note'; n.textContent = text('该消息仅含工具记录；需勾选工具详情才能导出内容', 'This message contains tool calls only. Include tool details to export their content.'); node.append(n);
  }
  return node;
}
async function hydrateShareMaps(root) {
  for (const box of root.querySelectorAll('.md-chart-map[data-map]')) {
    const id = box.dataset.map === 'china' ? 'china' : 'world';
    let rows = []; try { rows = JSON.parse(box.dataset.rows || '[]'); } catch { /* empty */ }
    const url = new URL(`../assets/geo/${id}.json`, import.meta.url); url.searchParams.set('v', APP_VERSION);
    const r = await fetch(url); if (!r.ok) throw new Error('无法嵌入地图边界：' + id);
    const geo = await r.json(); const placeholder = box.querySelector('svg');
    if (placeholder) { placeholder.outerHTML = renderGeoMapSvg(geo, rows, box.dataset.mapTitle || '', id); box.dataset.mapState = 'ready'; decorateGeoMap(box, rows); }
  }
}
async function embedMedia(node, selected, fs) {
  // Never serialize the store, settings, key, non-selected messages or unrelated filesystem content.
  for (const m of selected) {
    const scope = [...node.querySelectorAll('[data-share-message]')].find((x) => x.dataset.shareMessage === String(m.id));
    for (const v of scope?.querySelectorAll('.att-video[data-att-idx]') || []) {
      const a = m.attachments?.[Number(v.dataset.attIdx)]; if (a?.dataUrl?.startsWith('data:video/')) v.dataset.shareVideo = a.dataUrl;
    }
    for (const a of scope?.querySelectorAll('a[href^="sandbox:"],.sb-dl[data-sb-dl]') || []) {
      const path = a.dataset.sbDl || (a.getAttribute('href') || '').replace(/^sandbox:\/\//, '');
      let raw; try { raw = fs.read(path); } catch { raw = null; }
      if (raw == null) { a.removeAttribute('href'); continue; }
      const link = document.createElement('a'); link.className = 'share-file'; link.textContent = a.textContent || path;
      link.href = /^data:/i.test(raw) ? raw : await dataURL(new Blob([raw], { type: 'text/plain;charset=utf-8' })); link.download = path.split('/').pop(); a.replaceWith(link);
    }
  }
  for (const image of node.querySelectorAll('img')) {
    const src = image.getAttribute('src') || ''; if (!src || src.startsWith('data:')) continue;
    try { const r = await fetch(src, { credentials: 'omit' }); if (!r.ok) throw new Error(); let blob = await r.blob();
      if (blob.type.includes('svg')) {
        const xml = new DOMParser().parseFromString(sanitizeSvgRaw(await blob.text()), 'image/svg+xml'); const svg = xml.documentElement;
        const box = (svg.getAttribute('viewBox') || '').split(/[ ,]+/).map(Number);
        if (box.length === 4 && box[2] > 0 && box[3] > 0) { svg.setAttribute('width', box[2]); svg.setAttribute('height', box[3]); }
        blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' });
      }
      image.src = await dataURL(blob); }
    catch { const missing = document.createElement('span'); missing.className = 'share-note'; missing.textContent = (image.alt || text('图片', 'Image')) + text('（无法嵌入远程资源）', ' (remote image could not be embedded)'); image.replaceWith(missing); }
  }
  for (const n of node.querySelectorAll('script,iframe,object,embed,base,meta,link,form')) n.remove();
  for (const n of node.querySelectorAll('*')) {
    for (const a of [...n.attributes]) if (/^on/i.test(a.name) || ['srcdoc', 'srcset', 'formaction', 'nonce'].includes(a.name)) n.removeAttribute(a.name);
    if (n.tagName === 'A') { const href = n.getAttribute('href') || ''; if (!/^(https?:|data:|#)/i.test(href)) n.removeAttribute('href'); n.rel = 'noopener noreferrer'; if (/^https?:/i.test(href)) n.target = '_blank'; }
  }
}
export async function buildShareDocument({ messages, selected, fs, title = 'Dubhe Agent', tools = false, reasoning = false, interactive = true, theme = document.documentElement.dataset.theme } = {}) {
  const style = await shareStyles();
  const main = document.createElement('main'); main.className = 'share-page';
  main.innerHTML = `<header class="share-head"><span class="share-brand">${APP_LOGO}</span><div><h1>${esc(title)}</h1><div class="share-subtitle">Dubhe Agent · ${text('对话分享', 'Shared conversation')}</div></div></header>`
    + (interactive ? `<nav class="share-controls"><button type="button" id="share-theme">${text('切换主题', 'Toggle theme')}</button><button type="button" id="share-expand">${text('展开全部', 'Expand all')}</button><button type="button" id="share-collapse">${text('收起全部', 'Collapse all')}</button></nav>` : '');
  for (const m of selected) main.append(snapshotMessage(m, messages, fs, { tools, reasoning }));
  main.insertAdjacentHTML('beforeend', `<footer class="share-footer">Dubhe Agent · ${text('仅包含选中消息；独立离线页面，不连接模型或应用中继', 'Selected messages only · self-contained offline page · no model or app relay connection')}</footer>`);
  await hydrateShareMaps(main);
  await embedMedia(main, selected, fs);
  let client = '', scriptPolicy = "'none'";
  if (interactive) {
    const r = await fetch(new URL('./share-client.js', import.meta.url)); if (!r.ok) throw new Error('无法加载分享交互'); client = await r.text();
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(client)));
    scriptPolicy = `'sha256-${btoa(String.fromCharCode(...hash))}'`;
  }
  const csp = `default-src 'none'; script-src ${scriptPolicy}; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  return `<!doctype html><html lang="${getLanguage() === 'en' ? 'en' : 'zh-CN'}" data-theme="${theme === 'dark' ? 'dark' : 'light'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>${esc(title)} · Dubhe Agent</title><style>${style.replace(/</g, '\\3c ')}</style></head><body>${main.outerHTML}${client ? `<script>${client}</script>` : ''}</body></html>`;
}
