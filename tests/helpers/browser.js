import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
export const ROOT = new URL('../../', import.meta.url).pathname;
export async function staticSite() {
  const shares = new Map();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (shares.has(url.pathname)) { res.setHeader('Content-Type','text/html;charset=utf-8');res.end(shares.get(url.pathname));return; }
    const name = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'app.html';
    const file = path.resolve(ROOT, name);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {res.writeHead(404);res.end('not found');return;}
    const ext = path.extname(file);res.setHeader('Content-Type',({'.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.html':'text/html;charset=utf-8','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2','.ttf':'font/ttf','.webmanifest':'application/manifest+json'})[ext]||'application/octet-stream');fs.createReadStream(file).pipe(res);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {base:`http://127.0.0.1:${server.address().port}`,shares,close:async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
export async function openPage(browser, base, {locale='en-US', main=false, width=1100, init}={}) {
  const context=await browser.newContext({locale,viewport:{width,height:850}});
  if(init)await context.addInitScript(init);
  await context.route('**/*',route=>{
    const u=route.request().url();
    if(u.startsWith(base)&&(!u.includes('/js/main.js')||main)&&!u.includes('/assets/moderation/')) route.continue();else route.abort();
  });
  const page=await context.newPage();await page.goto(base+'/app.html');return {context,page};
}
