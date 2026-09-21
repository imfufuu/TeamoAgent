import puppeteer from 'puppeteer';
const b = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: '/home/user/.local/chromedeps/usr/lib/x86_64-linux-gnu' } });
const page = await b.newPage();
console.log('emulateMediaFeatures?', typeof page.emulateMediaFeatures, '| emulateMedia?', typeof page.emulateMedia);
try { await page.emulateMediaFeatures([{ name: 'hover', value: 'hover' }]); console.log('hover 设置成功'); }
catch (e) { console.log('错误:', e.message.slice(0, 200)); }
await b.close();
