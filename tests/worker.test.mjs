import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../relay/worker.js';

const makeRequest = (path, method = 'GET') => new Request(`https://dubhe-worker.test${path}`, { method });
async function jsonCall(path, env = {}) {
  const response = await worker.fetch(makeRequest(path), env);
  return { response, body: await response.json() };
}
async function withMockFetch(mock, run) {
  const previous = globalThis.fetch;
  globalThis.fetch = mock;
  try { return await run(); } finally { globalThis.fetch = previous; }
}
const htmlResponse = (html, status = 200) => new Response(html, {
  status,
  headers: { 'content-type': 'text/html; charset=utf-8' },
});

test('Worker health advertises versioned fetch/search/crawl capabilities', async () => {
  const { response, body } = await jsonCall('/api/health');
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.version, '1.7.1');
  assert.equal(body.relay, 'dubhe-cf-worker', 'health identifier remains stable for compatibility');
  assert.deepEqual(body.capabilities, ['fetch', 'search', 'crawl', 'file']);
  assert.equal(body.limits.file_bytes, 16 * 1024 * 1024);
});

test('Worker root banner uses the Dubhe Agent identity', async () => {
  const response = await worker.fetch(makeRequest('/'));
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /Dubhe Agent Cloudflare Relay v1\.7\.1/);
  assert.match(text, /GET  \/api\/file\?url=/);
});

test('dashboard-compatible Worker source carries the migrated identity', () => {
  const source = readFileSync(new URL('../relay/worker-dashboard.js', import.meta.url), 'utf8');
  assert.match(source, /Dubhe Agent Cloudflare Relay v1\.5/);
  assert.match(source, /relay: 'dubhe-cf-worker'/);
});

test('SSRF guard rejects private, loopback, link-local, reserved, and internal host targets before fetch', async () => {
  await withMockFetch(async () => { throw new Error('SSRF target must not be fetched'); }, async () => {
    const targets = [
      'http://127.0.0.1/admin',
      'http://10.2.3.4/',
      'http://172.31.0.9/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.64.0.1/',
      'http://192.0.2.10/',
      'http://[::1]/',
      'http://[fd00::1]/',
      'http://metadata.google.internal/',
      'http://service.local/',
      'http://host.test/',
      'http://user:pass@example.org/private',
    ];
    for (const target of targets) {
      const { response, body } = await jsonCall(`/api/fetch?url=${encodeURIComponent(target)}`);
      assert.equal(response.status, 502, target);
      assert.match(body.error, /拒绝|不得包含/ , target);
    }
  });
});

test('SSRF guard accepts a public IPv4/IPv6 literal and returns fetched text', async () => {
  await withMockFetch(async (target) => {
    const host = new URL(target).hostname;
    assert.ok(host.includes('93.184.216.34') || host.includes('2001:4860:4860::8888'));
    return new Response('public text', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }, async () => {
    for (const target of ['https://93.184.216.34/doc', 'https://[2001:4860:4860::8888]/doc']) {
      const { response, body } = await jsonCall(`/api/fetch?url=${encodeURIComponent(target)}`);
      assert.equal(response.status, 200, body.error);
      assert.equal(body.text, 'public text');
    }
  });
});

test('every redirect is revalidated and crawl redirects cannot leave the initial origin', async () => {
  let calls = 0;
  await withMockFetch(async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
  }, async () => {
    const { response, body } = await jsonCall(`/api/fetch?url=${encodeURIComponent('https://public.example.org/start')}`);
    assert.equal(response.status, 502);
    assert.match(body.error, /内网|保留|拒绝/);
    assert.equal(calls, 1, 'blocked redirect must never be fetched');
  });

  calls = 0;
  await withMockFetch(async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: 'https://other.example.net/page' } });
  }, async () => {
    const { response, body } = await jsonCall(`/api/crawl?url=${encodeURIComponent('https://site.example.org/')}`);
    assert.equal(response.status, 502);
    assert.match(body.error, /重定向离开初始站点/);
    assert.equal(calls, 1, 'cross-origin crawl redirect must stop before the next request');
  });
});

test('SearXNG JSON adapter validates results, filters unsafe URLs, and enforces limit', async () => {
  const seen = [];
  await withMockFetch(async (target, options) => {
    seen.push({ target: String(target), options });
    const u = new URL(target);
    assert.equal(u.pathname, '/search');
    assert.equal(u.searchParams.get('q'), '東京の気候');
    assert.equal(u.searchParams.get('format'), 'json');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.cf, undefined, 'search queries should not be stored in the fetch cache');
    return new Response(JSON.stringify({ results: [
      { title: 'Official guide', url: 'https://docs.example.org/guide', content: 'Primary source', engine: 'brave' },
      { title: 'Unsafe local result', url: 'http://127.0.0.1/admin', content: 'ignore' },
      { title: 'Second result', url: 'https://news.example.net/story', snippet: 'News snippet' },
      { title: 'Duplicate', url: 'https://docs.example.org/guide', content: 'duplicate' },
    ] }), { headers: { 'content-type': 'application/json; charset=utf-8' } });
  }, async () => {
    const { response, body } = await jsonCall(`/api/search?q=${encodeURIComponent('東京の気候')}&limit=2`, { SEARXNG_URL: 'https://search.example.org/' });
    assert.equal(response.status, 200, body.error);
    assert.equal(body.provider, 'SearXNG');
    assert.equal(body.fallback, false);
    assert.equal(body.results.length, 2);
    assert.equal(body.results[0].source, 'brave');
    assert.equal(body.results[1].title, 'Second result');
    assert.equal(seen.length, 1);
  });
});

test('DuckDuckGo HTML adapter parses result links and records the provider', async () => {
  const html = `<html><body>
    <div class="result"><a class="result__a" href="https://docs.example.org/guide?a=1&amp;b=2">Example &amp; Docs</a>
      <a class="result__snippet">A useful primary-source summary.</a></div>
    <div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnews.example.net%2Fstory">News result</a>
      <a class="result__snippet">A news summary.</a></div>
  </body></html>`;
  await withMockFetch(async (target) => {
    assert.match(String(target), /^https:\/\/html\.duckduckgo\.com\/html\//);
    return htmlResponse(html);
  }, async () => {
    const { response, body } = await jsonCall(`/api/search?q=${encodeURIComponent('agent tools')}&limit=5`);
    assert.equal(response.status, 200, body.error);
    assert.equal(body.provider, 'DuckDuckGo');
    assert.equal(body.results.length, 2);
    assert.equal(body.results[0].title, 'Example & Docs');
    assert.equal(body.results[0].url, 'https://docs.example.org/guide?a=1&b=2');
    assert.match(body.results[0].snippet, /useful primary-source summary/i);
    assert.equal(body.results[1].url, 'https://news.example.net/story');
  });
});

test('DuckDuckGo 返回人机挑战页（202 anomaly，无 result__a）→ 自动回退 Bing RSS，并在 warning 里说明', async () => {
  const challenge = '<!DOCTYPE html><html><head><title>DuckDuckGo</title></head><body><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div><form id="challenge-form"></form></body></html>';
  const rss = `<?xml version="1.0" encoding="utf-8" ?><rss version="2.0"><channel><title>Bing: dubhe agent</title>
    <item><title>Dubhe Agent &#183; GitHub</title><link>https://github.com/imfufuu/dubhe-agent</link><description>Browser-side &lt;b&gt;agent&lt;/b&gt; with sandbox.</description><pubDate>Tue, 07 Oct 2026 00:00:00 GMT</pubDate></item>
    <item><title><![CDATA[Dubhe – Wikipedia &amp; friends]]></title><link>https://en.wikipedia.org/wiki/Dubhe</link><description><![CDATA[Dubhe is a star &amp; more.]]></description></item>
    <item><title>dup</title><link>https://github.com/imfufuu/dubhe-agent</link><description>duplicate url</description></item>
    <item><title>private</title><link>http://127.0.0.1/admin</link><description>must be dropped</description></item>
  </channel></rss>`;
  const seen = [];
  await withMockFetch(async (target) => {
    const u = String(target); seen.push(u);
    if (/html\.duckduckgo\.com/.test(u)) return new Response(challenge, { status: 202, headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (/lite\.duckduckgo\.com/.test(u)) return new Response(challenge, { status: 202, headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (/search\.brave\.com/.test(u)) return new Response('<html><body>Please verify you are human</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    if (/^https:\/\/www\.bing\.com\/search\?/.test(u)) {
      const url = new URL(u);
      assert.equal(url.searchParams.get('format'), 'rss');
      assert.equal(url.searchParams.get('q'), 'dubhe agent');
      assert.equal(url.searchParams.get('mkt'), null, '不要带 mkt / setlang（实测带上后 Bing 对数据中心请求返回整页无关结果）');
      return new Response(rss, { status: 200, headers: { 'content-type': 'application/rss+xml; charset=utf-8' } });
    }
    throw new Error(`unexpected fetch ${u}`);
  }, async () => {
    const { response, body } = await jsonCall(`/api/search?q=${encodeURIComponent('dubhe agent')}&limit=5`);
    assert.equal(response.status, 200, body.error);
    assert.equal(body.provider, 'Bing');
    assert.equal(body.fallback, true);
    assert.deepEqual(body.tried, ['DuckDuckGo', 'DuckDuckGo Lite', 'Brave']);
    assert.match(body.warning, /DuckDuckGo 不可用（DuckDuckGo HTML 没有解析到结果/);
    assert.match(body.warning, /DuckDuckGo Lite 不可用（DuckDuckGo Lite 没有解析到结果/);
    assert.match(body.warning, /Brave 不可用（Brave 没有解析到结果/);
    assert.match(body.warning, /已回退 Bing/);
    assert.equal(body.results.length, 2, '去重 + 丢私网地址');
    assert.equal(body.results[0].title, 'Dubhe Agent · GitHub');
    assert.equal(body.results[0].url, 'https://github.com/imfufuu/dubhe-agent');
    assert.equal(body.results[0].snippet, 'Browser-side agent with sandbox.');
    assert.equal(body.results[0].source, 'Bing');
    assert.equal(body.results[1].title, 'Dubhe – Wikipedia & friends');
    assert.equal(body.results[1].snippet, 'Dubhe is a star & more.');
    assert.deepEqual(seen.map((u) => new URL(u).hostname), ['html.duckduckgo.com', 'lite.duckduckgo.com', 'search.brave.com', 'www.bing.com'], 'DDG html → DDG lite → Brave → Bing，顺序固定');
  });
});

test('DuckDuckGo HTML 被挡但 Lite 的 POST 入口可用 → 用 Lite（表单 POST + kl=wt-wt），解析 result-link / result-snippet', async () => {
  const challenge = '<html><body><div class="anomaly-modal__title">bots</div></body></html>';
  const lite = `<html><body><table>
    <tr><td>1.&nbsp;</td><td><a rel="nofollow" href="https://teamorouter.com/" class='result-link'>TeamoRouter</a></td></tr>
    <tr><td>&nbsp;</td><td class='result-snippet'>Use one API key for <b>Claude Code</b>, Codex &amp; agents.</td></tr>
    <tr><td>2.&nbsp;</td><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fteamorouter.com%2Fabout" class='result-link'>About</a></td></tr>
    <tr><td>&nbsp;</td><td class='result-snippet'>Learn how it works.</td></tr>
    <tr><td>3.&nbsp;</td><td><a rel="nofollow" href="http://10.0.0.1/x" class='result-link'>private</a></td></tr>
  </table></body></html>`;
  const seen = [];
  await withMockFetch(async (target, init) => {
    const u = String(target); seen.push([u, init && init.method]);
    if (/html\.duckduckgo\.com/.test(u)) return new Response(challenge, { status: 202, headers: { 'content-type': 'text/html' } });
    if (/^https:\/\/lite\.duckduckgo\.com\/lite\/$/.test(u)) {
      assert.equal(init.method, 'POST');
      assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
      assert.equal(String(init.body), 'q=TeamoRouter&kl=wt-wt');
      assert.equal(init.cf, undefined, 'POST 不走边缘缓存');
      return new Response(lite, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    throw new Error(`unexpected fetch ${u}`);
  }, async () => {
    const { response, body } = await jsonCall('/api/search?q=TeamoRouter&limit=5');
    assert.equal(response.status, 200, body.error);
    assert.equal(body.provider, 'DuckDuckGo Lite');
    assert.deepEqual(body.tried, ['DuckDuckGo']);
    assert.equal(body.results.length, 2, '私网地址丢弃');
    assert.equal(body.results[0].title, 'TeamoRouter');
    assert.match(body.results[0].snippet, /^Use one API key for Claude Code ?, Codex & agents\.$/, '标签剥掉、实体解码');
    assert.equal(body.results[1].url, 'https://teamorouter.com/about', 'uddg 跳转链接要解包');
    assert.equal(body.results[1].snippet, 'Learn how it works.');
    assert.deepEqual(seen.map(([u]) => new URL(u).hostname), ['html.duckduckgo.com', 'lite.duckduckgo.com'], 'Lite 成功就不再打 Bing');
  });
});

test('DuckDuckGo 两个入口都被挡 → Brave HTML：解析 data-type="web" 块的落地页 / title 属性 / generic-snippet，过滤广告块与私网地址', async () => {
  const challenge = '<html><body><div class="anomaly-modal__title">bots</div></body></html>';
  const brave = `<html><body><div id="results">
    <div class="snippet svelte-x" data-pos="0" data-type="ad" data-keynav="true"><a href="https://ads.example.com/buy">Ad</a><div class="title search-snippet-title" title="Sponsored">Sponsored</div></div>
    <div class="snippet svelte-x" data-pos="1" data-type="web" data-keynav="true"><div class="result-content"><a href="https://github.com/imfufuu/dubhe-agent?utm=1&amp;x=2" target="_self" class="l1"><div class="site-name">GitHub</div><div class="title search-snippet-title line-clamp-1" title="GitHub - imfufuu/dubhe-agent &amp; more">GitHub - imfufuu/dubhe-agent &amp; more</div></a><div class="generic-snippet"><div class="content desktop-default-regular t-primary">Dubhe Agent <strong>V1.7</strong> · 构建 ·</div></div></div></div>
    <div class="snippet svelte-x" data-pos="2" data-type="web"><a href="http://192.168.1.1/x"><div class="title search-snippet-title" title="router">router</div></a></div>
    <div class="snippet svelte-x" data-pos="3" data-type="web"><a href="https://en.wikipedia.org/wiki/Dubhe"><div class="title search-snippet-title" title="Dubhe - Wikipedia">Dubhe - Wikipedia</div></a><div class="generic-snippet"><div class="content">Dubhe is a star.</div></div></div>
    <div class="snippet svelte-x" data-pos="4" data-type="web"><a href="https://en.wikipedia.org/wiki/Dubhe"><div class="title search-snippet-title" title="dup">dup</div></a></div>
  </div></body></html>`;
  const seen = [];
  await withMockFetch(async (target) => {
    const u = String(target); seen.push(u);
    if (/duckduckgo\.com/.test(u)) return new Response(challenge, { status: 202, headers: { 'content-type': 'text/html' } });
    if (/^https:\/\/search\.brave\.com\/search\?/.test(u)) {
      const url = new URL(u);
      assert.equal(url.searchParams.get('q'), 'dubhe agent');
      assert.equal(url.searchParams.get('source'), 'web');
      return new Response(brave, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    throw new Error(`unexpected fetch ${u}`);
  }, async () => {
    const { response, body } = await jsonCall(`/api/search?q=${encodeURIComponent('dubhe agent')}&limit=5`);
    assert.equal(response.status, 200, body.error);
    assert.equal(body.provider, 'Brave');
    assert.deepEqual(body.tried, ['DuckDuckGo', 'DuckDuckGo Lite']);
    assert.equal(body.results.length, 2, '广告块不算、私网丢弃、重复 URL 合并');
    assert.equal(body.results[0].title, 'GitHub - imfufuu/dubhe-agent & more');
    assert.equal(body.results[0].url, 'https://github.com/imfufuu/dubhe-agent?utm=1&x=2', 'href 实体解码');
    assert.match(body.results[0].snippet, /^Dubhe Agent V1\.7 · 构建 ·$/);
    assert.equal(body.results[0].source, 'Brave');
    assert.equal(body.results[1].url, 'https://en.wikipedia.org/wiki/Dubhe');
    assert.equal(body.results[1].snippet, 'Dubhe is a star.');
    assert.deepEqual(seen.map((u) => new URL(u).hostname), ['html.duckduckgo.com', 'lite.duckduckgo.com', 'search.brave.com'], 'Brave 成功就不再打 Bing');
  });
});

test('所有搜索源全挂 → 502 且错误里逐个列出原因', async () => {
  await withMockFetch(async () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }), async () => {
    const { response, body } = await jsonCall('/api/search?q=nothing');
    assert.equal(response.status, 502);
    assert.match(body.error, /所有搜索源都失败/);
    assert.match(body.error, /DuckDuckGo：/);
    assert.match(body.error, /DuckDuckGo Lite：/);
    assert.match(body.error, /Brave：/);
    assert.match(body.error, /Bing：Bing RSS 没有解析到结果/);
  });
});

test('invalid SearXNG configuration falls back to DuckDuckGo and exposes a warning', async () => {
  const html = '<a class="result__a" href="https://docs.example.org/">Docs</a><span class="result__snippet">Summary</span>';
  let calls = 0;
  await withMockFetch(async (target) => {
    calls++;
    assert.match(String(target), /^https:\/\/html\.duckduckgo\.com\//, 'invalid SearXNG URL must be rejected before fetch');
    return htmlResponse(html);
  }, async () => {
    const { response, body } = await jsonCall('/api/search?q=test', { SEARXNG_URL: 'http://search.example.org' });
    assert.equal(response.status, 200, body.error);
    assert.equal(body.provider, 'DuckDuckGo');
    assert.equal(body.fallback, true);
    assert.match(body.warning, /SearXNG 不可用/);
    assert.equal(calls, 1);
  });
});

test('crawl follows only same-origin text links, extracts page metadata, and skips scripts/navigation/binaries', async () => {
  const calls = [];
  const root = `<html><head><title>Home page</title><meta name="description" content="Site &amp; docs"></head>
    <body><nav>navigation secret</nav><script>script secret</script><h1>Home</h1><p>Welcome to the docs.</p>
      <a href="/docs">Docs page</a><a href="https://other.example.net/offsite">Off site</a><a href="/download.pdf">PDF</a></body></html>`;
  const docs = '<html><head><title>Docs</title></head><body><h1>Reference</h1><p>Useful reference text.</p></body></html>';
  await withMockFetch(async (target) => {
    const u = new URL(target);
    calls.push(u.href);
    if (u.pathname === '/') return htmlResponse(root);
    if (u.pathname === '/docs') return htmlResponse(docs);
    throw new Error(`unexpected crawl request: ${u.href}`);
  }, async () => {
    const { response, body } = await jsonCall(`/api/crawl?url=${encodeURIComponent('https://site.example.org/')}&max_pages=3&max_depth=1&max_chars=3000`);
    assert.equal(response.status, 200, body.error);
    assert.equal(body.pages.length, 2);
    assert.equal(body.pages[0].title, 'Home page');
    assert.equal(body.pages[0].description, 'Site & docs');
    assert.match(body.pages[0].text, /Welcome to the docs/);
    assert.doesNotMatch(body.pages[0].text, /navigation secret|script secret/);
    assert.equal(body.pages[1].url, 'https://site.example.org/docs');
    assert.equal(body.pages[1].title, 'Docs');
    assert.equal(body.errors.length, 0);
    assert.equal(body.visited, 2);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((x) => new URL(x).origin === 'https://site.example.org'));
  });
});

test('crawl enforces hard page/depth limits and omits binary links', async () => {
  const calls = [];
  await withMockFetch(async (target) => {
    const u = new URL(target);
    calls.push(u.pathname);
    const links = u.pathname === '/' ? '<a href="/a">a</a><a href="/b">b</a><a href="/c">c</a><a href="/file.zip">zip</a>' : '';
    return htmlResponse(`<html><head><title>${u.pathname}</title></head><body><p>Page ${u.pathname}</p>${links}</body></html>`);
  }, async () => {
    const { response, body } = await jsonCall(`/api/crawl?url=${encodeURIComponent('https://limit.example.org/')}&max_pages=99&max_depth=99`);
    assert.equal(response.status, 200, body.error);
    assert.equal(body.max_pages, 5);
    assert.equal(body.max_depth, 2);
    assert.equal(body.pages.length, 4, 'three same-origin pages plus start page; zip is not queued');
    assert.equal(calls.length, 4);
    assert.equal(body.truncated, false);
  });
});

test('search and crawl use documented limits when parameters are omitted', async () => {
  const requestedPaths = [];
  const searchHtml = Array.from({ length: 7 }, (_, i) => `<a class="result__a" href="https://docs.example.org/${i}">Result ${i}</a>`).join('');
  await withMockFetch(async (target) => {
    const u = new URL(target);
    if (u.hostname === 'html.duckduckgo.com') return htmlResponse(searchHtml);
    requestedPaths.push(u.pathname);
    if (u.pathname === '/') return htmlResponse('<a href="/one">One</a><a href="/two">Two</a><a href="/three">Three</a><p>Root</p>');
    return htmlResponse(`<p>${u.pathname}</p>`);
  }, async () => {
    const search = await jsonCall(`/api/search?q=${encodeURIComponent('default search limit')}`);
    assert.equal(search.response.status, 200, search.body.error);
    assert.equal(search.body.results.length, 5);

    const crawl = await jsonCall(`/api/crawl?url=${encodeURIComponent('https://defaults.example.org/')}`);
    assert.equal(crawl.response.status, 200, crawl.body.error);
    assert.equal(crawl.body.max_pages, 3);
    assert.equal(crawl.body.max_depth, 1);
    assert.equal(crawl.body.pages.length, 3);
    assert.equal(crawl.body.visited, 3);
    assert.equal(requestedPaths.length, 3);
  });
});

test('crawl page budget counts failed requests, not only successful pages', async () => {
  const calls = [];
  await withMockFetch(async (target) => {
    const u = new URL(target);
    calls.push(u.pathname);
    if (u.pathname === '/') return htmlResponse('<a href="/bad">bad</a><a href="/later">later</a><p>Home</p>');
    if (u.pathname === '/bad') throw new Error('upstream unavailable');
    if (u.pathname === '/later') return htmlResponse('<p>Later</p>');
    throw new Error(`unexpected request: ${u.pathname}`);
  }, async () => {
    const { response, body } = await jsonCall(`/api/crawl?url=${encodeURIComponent('https://budget.example.org/')}&max_pages=2`);
    assert.equal(response.status, 200, body.error);
    assert.equal(body.visited, 2, 'failed fetch attempts must consume page budget');
    assert.equal(body.pages.length, 1);
    assert.equal(body.errors.length, 1);
    assert.deepEqual(calls, ['/', '/bad']);
    assert.equal(body.truncated, true, 'unvisited queued links remain beyond the page budget');
  });
});

test('routes are GET-only except CORS preflight, and fetch honors caller cancellation', async () => {
  const post = await worker.fetch(makeRequest('/api/health', 'POST'));
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
  assert.match((await post.json()).error, /只允许 GET/);

  const options = await worker.fetch(makeRequest('/api/search', 'OPTIONS'));
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('access-control-allow-methods'), 'GET, OPTIONS');

  const controller = new AbortController();
  let observedAbortSignal;
  await withMockFetch(async (_target, init) => {
    observedAbortSignal = init.signal;
    controller.abort(new Error('client disconnected'));
    if (init.signal.aborted) throw init.signal.reason;
    await new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
    return new Response('unexpected');
  }, async () => {
    const request = new Request('https://dubhe-worker.test/api/fetch?url=https%3A%2F%2Fpublic.example.org%2F', { signal: controller.signal });
    const response = await worker.fetch(request);
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.match(body.error, /disconnect|abort|cancel/i);
    assert.equal(observedAbortSignal.aborted, true);
  });
});

test('/api/file：跨域二进制原样回传 + CORS + 文件名头；超限 413；SSRF 护栏生效', async () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  await withMockFetch(async (target) => {
    assert.match(String(target), /^https:\/\/cdn\.example\.org\/img\/logo\.png/);
    return new Response(bytes, { status: 200, headers: { 'content-type': 'image/png', 'last-modified': 'Mon, 05 Oct 2026 00:00:00 GMT' } });
  }, async () => {
    const response = await worker.fetch(makeRequest('/api/file?url=https%3A%2F%2Fcdn.example.org%2Fimg%2Flogo.png'));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal(response.headers.get('x-dubhe-file-name'), 'logo.png');
    assert.match(response.headers.get('access-control-expose-headers'), /x-dubhe-file-name/);
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [...bytes]);
  });
  // 没扩展名 → 按 Content-Type 补
  await withMockFetch(async () => new Response(new Uint8Array(16), { status: 200, headers: { 'content-type': 'video/mp4' } }), async () => {
    const response = await worker.fetch(makeRequest('/api/file?url=https%3A%2F%2Fcdn.example.org%2Fclip%2F123'));
    assert.equal(response.headers.get('x-dubhe-file-name'), '123.mp4');
  });
  // 超限：413 而不是截断
  await withMockFetch(async () => new Response(new Uint8Array(4096), { status: 200, headers: { 'content-type': 'application/zip' } }), async () => {
    const response = await worker.fetch(makeRequest('/api/file?url=https%3A%2F%2Fcdn.example.org%2Fa.zip&max=2048'));
    assert.equal(response.status, 413);
    assert.match((await response.json()).error, /超过上限/);
  });
  // SSRF：私网地址拒绝
  const blocked = await jsonCall('/api/file?url=http%3A%2F%2F127.0.0.1%2Fsecret.bin');
  assert.equal(blocked.response.status, 502);
  const missing = await jsonCall('/api/file');
  assert.equal(missing.response.status, 400);
});

test('search and crawl validate required parameters', async () => {
  const missingSearch = await jsonCall('/api/search');
  assert.equal(missingSearch.response.status, 400);
  const missingCrawl = await jsonCall('/api/crawl');
  assert.equal(missingCrawl.response.status, 400);
  const longSearch = await jsonCall(`/api/search?q=${'x'.repeat(501)}`);
  assert.equal(longSearch.response.status, 400);
});
