import { readThemePreference, writeThemePreference, THEME_STORAGE_KEY } from './theme.js';

const BPM = 124;
const BEAT = 60 / BPM; // ≈ 483.871ms；第 0 帧 = 第一拍
const WHIP = 2.8; // 切镜只轻轻拉远，避免高速甩镜
const SWITCH_OUT = 0.58; // 拉远阶段占比更长，镜头切换慢一点
const FOCUS_CUT = 0.42;  // 更晚切到下一个主体
const FILM_SCALE = 1.08; // 片中元素整体放大
const INTEGRATE_START = 72;
const INTEGRATE_END = 88;

const root = document.documentElement;
const preferDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
root.dataset.theme = readThemePreference(preferDark ? 'dark' : 'light');
writeThemePreference(root.dataset.theme);

const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const audio = document.getElementById('home-audio');
const stage = document.getElementById('stage');
const world = document.getElementById('world');
const shots = [...document.querySelectorAll('.shot')];
const beatBar = document.getElementById('beat-bar');
const explore = document.getElementById('explore');
const exploreCta = explore && explore.querySelector('.explore-cta');
const skip = document.getElementById('film-skip');
const pauseBtn = document.getElementById('film-pause');
const pauseFlash = document.getElementById('film-pause-flash');
const nav = document.querySelector('.nav');
const themeBtn = document.getElementById('theme-toggle');
const bill = document.getElementById('bill-text');
const billboard = document.getElementById('billboard');
const curtain = document.getElementById('curtain');

const SCENES = [
  { beat: 0, x: 0, y: 36, z: 980, rx: 6, ry: -8, rz: 0, focus: 'logo', title: '' },
  { beat: 4, x: 0, y: 0, z: 280, rx: 0, ry: 0, rz: 0, focus: 'logo', title: 'DUBHEAGENT' },
  { beat: 8, x: 0, y: -720, z: 320, rx: 3, ry: 3, rz: 0, focus: 'copy', title: '浏览器里的智能体' },
  { beat: 12, x: 0, y: -700, z: 260, rx: 0, ry: -2, rz: 0, focus: 'copy' },
  { beat: 16, x: 820, y: 40, z: 400, rx: 2, ry: 8, rz: 0, focus: 'sandbox', title: '沙箱隔离执行' },
  { beat: 20, x: 800, y: 24, z: 280, rx: 0, ry: 3, rz: 0, focus: 'sandbox' },
  { beat: 24, x: -840, y: 180, z: 400, rx: -2, ry: -8, rz: 0, focus: 'files', title: '工作区 120 MB' },
  { beat: 28, x: -820, y: 160, z: 280, rx: 0, ry: -3, rz: 0, focus: 'files' },
  { beat: 32, x: 1530, y: -690, z: 420, rx: 4, ry: 3, rz: 0, focus: 'image', title: '出图与识图' },
  { beat: 36, x: 1510, y: -670, z: 280, rx: 1, ry: -3, rz: 0, focus: 'image' },
  { beat: 40, x: -1530, y: -680, z: 340, rx: 0, ry: 6, rz: 0, focus: 'ultra', title: '思考档 Off → Ultra' },
  { beat: 44, x: -1510, y: -672, z: 260, rx: -1, ry: -2, rz: 0, focus: 'ultra' },
  { beat: 48, x: 60, y: 760, z: 380, rx: -4, ry: 2, rz: 0, focus: 'term', title: '跑起来，结果落盘' },
  { beat: 52, x: 40, y: 740, z: 280, rx: -2, ry: 0, rz: 0, focus: 'term' },
  { beat: 56, x: 900, y: -830, z: 400, rx: 3, ry: -8, rz: 0, focus: 'tools', title: '差分 · 搜索 · JSON' },
  { beat: 60, x: 880, y: -810, z: 300, rx: 0, ry: -3, rz: 0, focus: 'tools' },
  { beat: 64, x: -900, y: 810, z: 400, rx: 2, ry: 8, rz: 0, focus: 'zip', title: 'ZIP 打包带走' },
  { beat: 68, x: -880, y: 830, z: 300, rx: 0, ry: 3, rz: 0, focus: 'zip' },
  { beat: 72, x: 0, y: 10, z: 720, rx: 2, ry: 0, rz: 0, focus: 'logo', title: '现在就开始' },
  { beat: 84, x: 0, y: 0, z: 300, rx: 0, ry: 0, rz: 0, focus: 'logo', title: '' },
  { beat: 92, x: 0, y: 0, z: 980, rx: 2, ry: 0, rz: 0, focus: 'logo' },
  { beat: 100, x: 0, y: 0, z: 1400, rx: 0, ry: 0, rz: 0, focus: '', title: '' },
];

const FILM_SEC = 47.65;
const CURTAIN_SEC = 2.4;
const BLACK_SEC = 1.0;
const OPEN_FADE = 1.05;
const GATE_ENTER_MS = 560;
const hudScene = document.getElementById('hud-scene');
const HUD_LABELS = {
  logo: '01 / 09 · DUBHE CORE',
  copy: '02 / 09 · WEB AGENT',
  sandbox: '03 / 09 · SANDBOX RUNTIME',
  files: '04 / 09 · WORKSPACE 120MB',
  image: '05 / 09 · VISION & IMAGE',
  ultra: '06 / 09 · ULTRA THINKING',
  term: '07 / 09 · PYTHON EXECUTION',
  tools: '08 / 09 · LOCAL WORKBENCH',
  zip: '09 / 09 · ZIP ARCHIVE',
};

let playing = false;
let enteringFilm = false;
let enterTimer = 0;
let paused = false;
let pauseAt = 0;
let raf = 0;
let lastBeat = -1;
let lastTitle = '';
let t0 = 0;
let audioReady = !audio;
let audioBlobUrl = '';
let loadAbort = null;
const loadBar = document.getElementById('gate-load-bar');
const loadBox = document.getElementById('gate-load');
const loadLabel = document.getElementById('gate-load-label');

function smoother(t) {
  const x = Math.min(1, Math.max(0, t));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function sceneIndex(beatF) {
  let i = 0;
  while (i < SCENES.length - 1 && beatF >= SCENES[i + 1].beat) i++;
  return i;
}

function camAt(beatF) {
  const i = sceneIndex(beatF);
  const cur = SCENES[i];
  const next = SCENES[Math.min(i + 1, SCENES.length - 1)];
  const span = Math.max(0.0001, next.beat - cur.beat);
  const u = smoother((beatF - cur.beat) / span);
  const same = cur.focus === next.focus;
  // 换镜先拉远再落到下一物，避免主体被挤到画幅边缘后直接裁掉
  const far = Math.max(cur.z, next.z) + (same ? 0 : WHIP * 90);
  if (same) {
    return {
      x: lerp(cur.x, next.x, u),
      y: lerp(cur.y, next.y, u),
      z: lerp(cur.z, next.z, u),
      rx: lerp(cur.rx, next.rx, u),
      ry: lerp(cur.ry, next.ry, u),
      rz: lerp(cur.rz, next.rz, u),
      focus: cur.focus,
      title: cur.title,
      integrate: beatF >= INTEGRATE_START && beatF < INTEGRATE_END,
    };
  }
  if (u < SWITCH_OUT) {
    const t = smoother(u / SWITCH_OUT);
    return {
      x: cur.x,
      y: cur.y,
      z: lerp(cur.z, far, t),
      rx: lerp(cur.rx, 0, t),
      ry: lerp(cur.ry, 0, t),
      rz: lerp(cur.rz, 0, t),
      focus: cur.focus,
      title: cur.title,
      integrate: beatF >= INTEGRATE_START && beatF < INTEGRATE_END,
    };
  }
  const t = smoother((u - SWITCH_OUT) / (1 - SWITCH_OUT));
  return {
    x: lerp(cur.x, next.x, t),
    y: lerp(cur.y, next.y, t),
    z: lerp(far, next.z, t),
    rx: lerp(0, next.rx, t),
    ry: lerp(0, next.ry, t),
    rz: lerp(0, next.rz, t),
    focus: t < FOCUS_CUT ? cur.focus : next.focus,
    title: cur.title,
    integrate: beatF >= INTEGRATE_START && beatF < INTEGRATE_END,
  };
}

function applyCam(c) {
  if (!world) return;
  world.style.transform = `translate3d(${-c.x}px, ${-c.y}px, ${-c.z}px) rotateX(${c.rx}deg) rotateY(${c.ry}deg) rotateZ(${c.rz}deg) scale(${FILM_SCALE})`;
  root.classList.toggle('integrating', !!c.integrate);
  root.dataset.focus = c.focus || (c.integrate ? 'logo' : '');
  if (hudScene) {
    hudScene.textContent = c.integrate
      ? 'CONSTELLATION · ALL SYSTEMS READY'
      : (HUD_LABELS[c.focus] || '01 / 09 · DUBHE CORE');
  }
  for (const shot of shots) {
    const on = shot.dataset.id === c.focus;
    shot.classList.toggle('focus', on);
  }
}

function slam(text) {
  if (!billboard || !bill) return;
  if (text === lastTitle) return;
  lastTitle = text;
  billboard.classList.remove('slam');
  bill.textContent = text || '';
  billboard.classList.toggle('empty', !text);
  if (!text) return;
  void billboard.offsetWidth;
  billboard.classList.add('slam');
}

function onBeat(beat) {
  const i = sceneIndex(beat);
  const sc = SCENES[i];
  if (sc.beat !== beat) return;
  if (!Object.prototype.hasOwnProperty.call(sc, 'title')) return;
  slam(sc.title || '');
}

function nowSec() {
  if (audio && !audio.paused && !audio.ended && Number.isFinite(audio.currentTime) && audio.currentTime > 0.03) {
    return audio.currentTime;
  }
  return (performance.now() - t0) / 1000;
}

function pauseLocked(t = nowSec()) {
  return t >= FILM_SEC - CURTAIN_SEC;
}
function triggerPauseFlash(isPaused) {
  if (!pauseFlash) return;
  pauseFlash.classList.remove('flash', 'mode-pause', 'mode-play');
  pauseFlash.classList.add(isPaused ? 'mode-play' : 'mode-pause');
  void pauseFlash.offsetWidth;
  pauseFlash.classList.add('flash');
}
function setPaused(on) {
  if (!playing) return;
  const t = Math.max(0, nowSec());
  if (on && pauseLocked(t)) return; // 最后收束渐变不可暂停
  const nextPaused = !!on;
  if (nextPaused === paused) return;
  paused = nextPaused;
  root.classList.toggle('paused', paused);
  if (pauseBtn) pauseBtn.textContent = paused ? '继续' : '暂停';
  triggerPauseFlash(paused);
  if (paused) {
    pauseAt = t;
    cancelAnimationFrame(raf);
    if (audio) try { audio.pause(); } catch { /* ignore */ }
    return;
  }
  t0 = performance.now() - pauseAt * 1000;
  if (audio) {
    try { audio.currentTime = pauseAt; audio.play().then(() => { t0 = performance.now() - audio.currentTime * 1000; }).catch(() => {}); } catch { /* ignore */ }
  }
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(frame);
}
function togglePause() { setPaused(!paused); }

function paintCurtain(t) {
  if (!curtain) return;
  curtain.style.transition = 'none';
  if (t < OPEN_FADE) {
    curtain.style.background = '#000';
    curtain.style.opacity = String(1 - smoother(t / OPEN_FADE));
    return;
  }
  const u = t - (FILM_SEC - CURTAIN_SEC);
  if (u <= 0) {
    curtain.style.opacity = '0';
    curtain.style.background = '#000';
    return;
  }
  if (u < BLACK_SEC) {
    curtain.style.background = '#000';
    curtain.style.opacity = String(Math.min(1, u / BLACK_SEC));
  } else {
    const v = Math.min(1, (u - BLACK_SEC) / Math.max(0.001, CURTAIN_SEC - BLACK_SEC));
    const g = Math.round(255 * v);
    curtain.style.background = `rgb(${g},${g},${g})`;
    curtain.style.opacity = '1';
  }
}

function frame() {
  if (!playing || paused) return;
  const t = Math.max(0, nowSec());
  if (pauseBtn) pauseBtn.disabled = pauseLocked(t);
  paintCurtain(t);
  if (t >= FILM_SEC) { openSite(); return; }
  const beatF = t / BEAT;
  const beat = Math.max(0, Math.floor(beatF + 1e-9));
  const phase = beatF - beat;
  const rawKick = phase < 0.055 ? phase / 0.055 : Math.exp(-(phase - 0.055) * 7.8);
  const barWeight = (beat % 4 === 0) ? 1.0 : 0.52;
  const c = camAt(beatF);
  applyCam(c);
  root.style.setProperty('--beat-phase', String(phase));
  root.style.setProperty('--beat-kick', (rawKick * barWeight).toFixed(3));
  root.dataset.beat = String(beat);
  root.dataset.bar = String(Math.floor(beat / 4));
  if (beat !== lastBeat) {
    lastBeat = beat;
    onBeat(beat);
  }
  if (beatBar) beatBar.style.transform = `scaleX(${Math.min(1, t / FILM_SEC)})`;
  raf = requestAnimationFrame(frame);
}

function lockScroll(on) {
  document.body.style.overflow = on ? 'hidden' : '';
}

function pinTop() {
  if (location.hash) {
    history.replaceState(null, '', `${location.pathname}${location.search}`);
  }
  window.scrollTo(0, 0);
}

function finishOpen(instant) {
  root.classList.remove('gate', 'scoring', 'leaving', 'integrating', 'entering-film');
  root.classList.add('open');
  lockScroll(false);
  pinTop();
  if (beatBar) beatBar.style.transform = 'scaleX(0)';
  if (curtain) {
    curtain.style.transition = instant
      ? 'none'
      : 'opacity .52s var(--film, cubic-bezier(.16,1,.3,1))';
    curtain.style.opacity = '0';
  }
  watchReveal();
}

const AUDIO_CACHE = 'teamo-assets-v1';
let pendingPlayAfterLoad = false;

function openSite(instant) {
  if (root.classList.contains('open')) return;
  // 不中断后台音频下载：即使跳过片头，下载完成后也随时能从介绍页重播（Requirement 5.1）
  playing = false;
  enteringFilm = false;
  if (enterTimer) { clearTimeout(enterTimer); enterTimer = 0; }
  paused = false;
  root.classList.remove('paused', 'entering-film');
  cancelAnimationFrame(raf);
  if (audio) try { audio.pause(); audio.volume = 1; } catch { /* ignore */ }
  if (instant || reduce) {
    if (curtain) { curtain.style.opacity = '0'; curtain.style.background = '#000'; }
    finishOpen(true);
    return;
  }
  if (root.classList.contains('leaving')) return;
  root.classList.add('leaving');
  if (curtain) {
    curtain.style.transition = 'none';
    curtain.style.background = '#fff';
    curtain.style.opacity = '1';
  }
  window.setTimeout(() => finishOpen(false), 60);
}

function setLoadProgress(p, text) {
  const x = Math.max(0, Math.min(1, Number(p) || 0));
  if (loadBar) loadBar.style.transform = `scaleX(${x})`;
  if (loadBox) {
    loadBox.setAttribute('aria-valuenow', String(Math.round(x * 100)));
    loadBox.classList.toggle('ready', x >= 1);
  }
  if (loadLabel) loadLabel.textContent = text || (x >= 1 ? '影片已就绪' : `正在加载影片 ${Math.round(x * 100)}%`);
}

function setExploreReady(on) {
  if (explore) explore.classList.toggle('waiting', !on);
  if (exploreCta) exploreCta.disabled = !on;
  document.querySelectorAll('[data-play-film]').forEach((btn) => {
    btn.disabled = !on;
  });
}

function markAudioReady(label) {
  audioReady = true;
  setExploreReady(true);
  setLoadProgress(1, label || '影片已就绪');
  // 下载进度条结束后淡出消失（Requirement 5.2）
  if (loadBox) {
    window.setTimeout(() => {
      loadBox.classList.add('gone');
      loadBox.setAttribute('aria-hidden', 'true');
    }, 760);
  }
  if (pendingPlayAfterLoad) {
    pendingPlayAfterLoad = false;
    beginFilmTransition();
  }
}

async function bindAudioBlob(blob) {
  if (!audio || !blob) return;
  if (audioBlobUrl) URL.revokeObjectURL(audioBlobUrl);
  audioBlobUrl = URL.createObjectURL(blob);
  audio.src = audioBlobUrl;
  audio.preload = 'auto';
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (settled) return; settled = true; resolve(); };
    audio.addEventListener('canplaythrough', finish, { once: true });
    audio.addEventListener('error', finish, { once: true });
    window.setTimeout(finish, 4000);
    try { audio.load(); } catch { finish(); }
  });
}

async function prefetchAudio() {
  if (!audio) { markAudioReady(); return; }
  if (audioReady && audioBlobUrl) { markAudioReady(); return; }
  setExploreReady(false);
  setLoadProgress(0.02, '正在加载影片');
  loadAbort = new AbortController();
  const src = audio.getAttribute('src') || 'assets/audio/teamo-home.mp3';
  try {
    // 优先命中本地持久化 CacheStorage：下载过一次后随时零延迟播放
    if (typeof caches !== 'undefined') {
      try {
        const cache = await caches.open(AUDIO_CACHE);
        const cachedRes = await cache.match(src);
        if (cachedRes && cachedRes.ok) {
          const blob = await cachedRes.blob();
          if (blob && blob.size > 0) {
            setLoadProgress(1, '影片已就绪');
            await bindAudioBlob(blob);
            markAudioReady();
            return;
          }
        }
      } catch { /* CacheStorage 不可用则走网络流 */ }
    }
    const res = await fetch(src, { signal: loadAbort.signal, cache: 'force-cache' });
    if (!res.ok || !res.body) throw new Error(String(res.status || 'no body'));
    const total = Number(res.headers.get('Content-Length') || 0);
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      setLoadProgress(total ? received / total : Math.min(0.95, received / 1600000));
    }
    const mime = res.headers.get('Content-Type') || 'audio/mpeg';
    const blob = new Blob(chunks, { type: mime });
    if (typeof caches !== 'undefined' && blob.size > 0) {
      try {
        const cache = await caches.open(AUDIO_CACHE);
        await cache.put(src, new Response(blob.slice(0, blob.size, mime), { headers: { 'Content-Type': mime } }));
      } catch { /* 写入缓存失败不影响本次播放 */ }
    }
    await bindAudioBlob(blob);
    markAudioReady();
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    try { audio.preload = 'auto'; audio.load(); } catch { /* ignore */ }
    markAudioReady('影片未就绪，开片时尝试播放');
  }
}

function beginFilmTransition() {
  if (playing || enteringFilm || root.classList.contains('scoring')) return;
  if (reduce || !curtain) {
    startFilm();
    return;
  }
  enteringFilm = true;
  root.classList.add('entering-film');
  lockScroll(true);
  if (audio) {
    try {
      audio.muted = true;
      audio.currentTime = 0;
      audio.play().catch(() => {});
    } catch { /* ignore */ }
  }
  curtain.style.transition = 'none';
  curtain.style.background = '#08080a';
  curtain.style.opacity = '0';
  void curtain.offsetWidth;
  curtain.style.transition = `opacity ${GATE_ENTER_MS}ms var(--film, cubic-bezier(.16,1,.3,1))`;
  curtain.style.opacity = '1';
  if (enterTimer) clearTimeout(enterTimer);
  enterTimer = window.setTimeout(() => {
    enterTimer = 0;
    enteringFilm = false;
    startFilm();
  }, GATE_ENTER_MS);
}

function requestFilm() {
  if (playing || enteringFilm || root.classList.contains('scoring')) return;
  if (!audioReady) {
    pendingPlayAfterLoad = true;
    return;
  }
  beginFilmTransition();
}

async function startFilm() {
  enteringFilm = false;
  if (enterTimer) { clearTimeout(enterTimer); enterTimer = 0; }
  lastBeat = -1;
  lastTitle = '';
  paused = false;
  pauseAt = 0;
  root.classList.remove('paused', 'entering-film');
  if (pauseBtn) { pauseBtn.disabled = false; pauseBtn.textContent = '暂停'; }
  if (pauseFlash) pauseFlash.classList.remove('flash', 'mode-pause', 'mode-play');
  slam('');
  if (curtain) {
    curtain.style.transition = 'none';
    curtain.style.background = '#08080a';
    curtain.style.opacity = '1';
  }
  root.classList.remove('gate', 'open', 'integrating');
  root.classList.add('scoring');
  lockScroll(true);
  applyCam(camAt(0));
  playing = true;
  t0 = performance.now();
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(frame);
  if (!audio) return;
  try {
    audio.muted = false;
    audio.volume = 1;
    audio.currentTime = 0;
    if (audio.paused) await audio.play();
    t0 = performance.now() - audio.currentTime * 1000;
  } catch {
    /* 无声也把片子演完，绝不跳进展览页 */
  }
}

function skipFilm() {
  if (enterTimer) { clearTimeout(enterTimer); enterTimer = 0; }
  enteringFilm = false;
  if (audio) { audio.pause(); audio.currentTime = 0; audio.muted = false; audio.volume = 1; }
  playing = false;
  paused = false;
  root.classList.remove('paused', 'entering-film');
  if (pauseFlash) pauseFlash.classList.remove('flash', 'mode-pause', 'mode-play');
  cancelAnimationFrame(raf);
  if (reduce || !curtain) { openSite(true); return; }
  const start = performance.now();
  const dur = 680;
  const tick = (now) => {
    const p = Math.min(1, (now - start) / dur);
    curtain.style.transition = 'none';
    if (p < 0.45) {
      curtain.style.background = '#08080a';
      curtain.style.opacity = String(p / 0.45);
    } else {
      const v = (p - 0.45) / 0.55;
      const g = Math.round(255 * v);
      curtain.style.background = `rgb(${g},${g},${g})`;
      curtain.style.opacity = '1';
    }
    if (p < 1) requestAnimationFrame(tick);
    else openSite();
  };
  requestAnimationFrame(tick);
}

function openGate() {
  playing = false;
  enteringFilm = false;
  if (enterTimer) { clearTimeout(enterTimer); enterTimer = 0; }
  paused = false;
  cancelAnimationFrame(raf);
  if (audio) try { audio.pause(); audio.currentTime = 0; audio.volume = 1; } catch { /* ignore */ }
  if (curtain) {
    curtain.style.transition = 'none';
    curtain.style.opacity = '0';
  }
  root.classList.remove('open', 'scoring', 'leaving', 'integrating', 'entering-film', 'paused');
  root.classList.add('gate');
  lockScroll(false);
  pinTop();
}

function syncThemeBtn() {
  if (!themeBtn) return;
  const dark = root.dataset.theme === 'dark';
  themeBtn.textContent = dark ? '浅色' : '深色';
  themeBtn.title = dark ? '切换到浅色主题' : '切换到深色主题';
}
function flipTheme() {
  root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  writeThemePreference(root.dataset.theme);
  syncThemeBtn();
}
syncThemeBtn();
window.addEventListener('storage', (event) => {
  if (event.key !== THEME_STORAGE_KEY && event.key !== 'teamo-home-theme') return;
  root.dataset.theme = readThemePreference(event.newValue || root.dataset.theme);
  syncThemeBtn();
});

function prepareReveal() {
  if (reduce) return;
  const site = document.querySelector('.site');
  if (!site) return;
  const sels = ['.hero > div', '.stat', '.section h2', '.section .sub', '.card', '.think-table', '.steps li', '.panel-preview', '.chip', '.faq details', '.honesty li', '.cta-block h2', '.cta-block p', '.cta-block .cta', 'footer'];
  let i = 0;
  for (const sel of sels) {
    site.querySelectorAll(sel).forEach((el) => {
      if (el.classList.contains('reveal')) return;
      el.classList.add('reveal');
      // 三个 Q&A 卡片使用统一零延迟，保证滚入与点击展开手感完全一致
      el.style.setProperty('--delay', sel === '.faq details' ? '0ms' : `${(i % 4) * 70}ms`);
      i += 1;
    });
  }
}

function watchReveal() {
  if (reduce) return;
  const nodes = document.querySelectorAll('.site .reveal:not(.in)');
  if (!nodes.length) return;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('in');
      e.target.style.removeProperty('--delay');
      io.unobserve(e.target);
    }
  }, { threshold: 0.14, rootMargin: '0px 0px -8% 0px' });
  nodes.forEach((n) => io.observe(n));
}

function bindFaqAccordion() {
  document.querySelectorAll('.faq details').forEach((det) => {
    const sum = det.querySelector('summary');
    const body = det.querySelector('p');
    if (!sum || !body) return;
    let anim = null;
    sum.addEventListener('click', (e) => {
      e.preventDefault();
      if (reduce || typeof det.animate !== 'function') {
        det.open = !det.open;
        det.classList.toggle('is-open', det.open);
        return;
      }
      if (anim) { anim.cancel(); anim = null; }
      const isOpening = !det.open || det.classList.contains('is-closing');
      const startH = det.offsetHeight;
      if (isOpening) {
        det.classList.remove('is-closing');
        det.classList.add('is-open');
        det.open = true;
        const endH = sum.offsetHeight + body.offsetHeight;
        anim = det.animate(
          [{ height: `${startH}px` }, { height: `${endH}px` }],
          { duration: 300, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
        );
        body.animate(
          [{ opacity: 0, transform: 'translateY(-5px)' }, { opacity: 1, transform: 'translateY(0)' }],
          { duration: 260, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
        );
        anim.onfinish = () => { det.style.height = ''; anim = null; };
        anim.oncancel = () => { det.style.height = ''; };
      } else {
        det.classList.remove('is-open');
        det.classList.add('is-closing');
        const endH = sum.offsetHeight;
        anim = det.animate(
          [{ height: `${startH}px` }, { height: `${endH}px` }],
          { duration: 260, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
        );
        body.animate(
          [{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-4px)' }],
          { duration: 200, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
        );
        anim.onfinish = () => {
          det.open = false;
          det.classList.remove('is-closing');
          det.style.height = '';
          anim = null;
        };
        anim.oncancel = () => {
          det.classList.remove('is-closing');
          det.style.height = '';
        };
      }
    });
  });
}

if (themeBtn) {
  themeBtn.addEventListener('click', () => flipTheme());
}
window.addEventListener('scroll', () => {
  if (nav) nav.classList.toggle('scrolled', window.scrollY > 8);
}, { passive: true });
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

const initialView = new URLSearchParams(location.search).get('view') || (location.hash === '#nav' ? 'nav' : '');
if (initialView && history.replaceState) {
  history.replaceState(null, '', location.pathname);
}
pinTop();
prepareReveal();
bindFaqAccordion();

const navBrand = document.querySelector('.nav .brand');
if (navBrand) {
  navBrand.addEventListener('click', (e) => {
    e.preventDefault();
    openGate();
  });
}

const gateSkip = document.getElementById('gate-skip');
document.querySelectorAll('[data-play-film]').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    requestFilm();
  });
});

try {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
  }
} catch { /* ignore */ }

/* 片尾由时钟收束（最后 5 秒黑→白），不在 audio.ended 时硬切 */
exploreCta && exploreCta.addEventListener('click', requestFilm);
pauseBtn && pauseBtn.addEventListener('click', togglePause);
stage && stage.addEventListener('click', (e) => {
  if (e.target && e.target.closest && e.target.closest('#film-skip, #film-pause')) return;
  if (!playing || pauseLocked()) return;
  togglePause();
});
skip && skip.addEventListener('click', skipFilm);
gateSkip && gateSkip.addEventListener('click', () => openSite(true));
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (root.classList.contains('gate')) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      requestFilm();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      openSite(true);
    }
  } else if (root.classList.contains('scoring') && !root.classList.contains('leaving')) {
    if (e.key === 'Escape') {
      e.preventDefault();
      skipFilm();
    } else if (e.key === ' ' || e.key.toLowerCase() === 'p') {
      e.preventDefault();
      togglePause();
    }
  }
});

if (reduce || initialView === 'nav') {
  openSite(true);
  prefetchAudio();
} else {
  root.classList.add('gate');
  root.classList.remove('open', 'scoring');
  prefetchAudio();
}
