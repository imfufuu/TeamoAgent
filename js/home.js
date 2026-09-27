const BPM = 124;
const BEAT = 60 / BPM; // ≈ 483.871ms；第 0 帧 = 第一拍
const WHIP = 2.8; // 切镜只轻轻拉远，避免高速甩镜
const SWITCH_OUT = 0.58; // 拉远阶段占比更长，镜头切换慢一点
const FOCUS_CUT = 0.42;  // 更晚切到下一个主体
const FILM_SCALE = 1.08; // 片中元素整体放大
const INTEGRATE_START = 72;
const INTEGRATE_END = 88;

const root = document.documentElement;
const saved = localStorage.getItem('teamo-home-theme');
const preferDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
root.dataset.theme = saved || (preferDark ? 'dark' : 'light');

const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const audio = document.getElementById('home-audio');
const world = document.getElementById('world');
const shots = [...document.querySelectorAll('.shot')];
const beatBar = document.getElementById('beat-bar');
const explore = document.getElementById('explore');
const exploreCta = explore && explore.querySelector('.explore-cta');
const skip = document.getElementById('film-skip');
const nav = document.querySelector('.nav');
const themeBtn = document.getElementById('theme-toggle');
const bill = document.getElementById('bill-text');
const billboard = document.getElementById('billboard');
const curtain = document.getElementById('curtain');

const SCENES = [
  { beat: 0, x: 0, y: 36, z: 980, rx: 6, ry: -8, rz: 0, focus: 'logo', title: '' },
  { beat: 4, x: 0, y: 0, z: 280, rx: 0, ry: 0, rz: 0, focus: 'logo', title: 'TEAMOAGENT' },
  { beat: 8, x: 0, y: -720, z: 320, rx: 3, ry: 3, rz: 0, focus: 'copy', title: '浏览器里的智能体' },
  { beat: 12, x: 0, y: -700, z: 260, rx: 0, ry: -2, rz: 0, focus: 'copy' },
  { beat: 16, x: 820, y: 40, z: 400, rx: 2, ry: 8, rz: 0, focus: 'sandbox', title: '沙箱隔离执行' },
  { beat: 20, x: 800, y: 24, z: 280, rx: 0, ry: 3, rz: 0, focus: 'sandbox' },
  { beat: 24, x: -840, y: 180, z: 400, rx: -2, ry: -8, rz: 0, focus: 'files', title: '工作区 120 MB' },
  { beat: 28, x: -820, y: 160, z: 280, rx: 0, ry: -3, rz: 0, focus: 'files' },
  { beat: 32, x: 220, y: -680, z: 420, rx: 4, ry: 3, rz: 0, focus: 'image', title: '出图与识图' },
  { beat: 36, x: 200, y: -660, z: 280, rx: 1, ry: -3, rz: 0, focus: 'image' },
  { beat: 40, x: -300, y: 0, z: 340, rx: 0, ry: 6, rz: 0, focus: 'ultra', title: '思考档 Off → Ultra' },
  { beat: 44, x: -280, y: 8, z: 260, rx: -1, ry: -2, rz: 0, focus: 'ultra' },
  { beat: 48, x: 60, y: 760, z: 380, rx: -4, ry: 2, rz: 0, focus: 'term', title: '跑起来，结果落盘' },
  { beat: 52, x: 40, y: 740, z: 280, rx: -2, ry: 0, rz: 0, focus: 'term' },
  { beat: 56, x: 900, y: -260, z: 400, rx: 3, ry: -8, rz: 0, focus: 'tools', title: '差分 · 搜索 · JSON' },
  { beat: 60, x: 880, y: -240, z: 300, rx: 0, ry: -3, rz: 0, focus: 'tools' },
  { beat: 64, x: -900, y: -220, z: 400, rx: 2, ry: 8, rz: 0, focus: 'zip', title: 'ZIP 打包带走' },
  { beat: 68, x: -880, y: -200, z: 300, rx: 0, ry: 3, rz: 0, focus: 'zip' },
  { beat: 72, x: 0, y: 10, z: 720, rx: 2, ry: 0, rz: 0, focus: 'logo', title: '现在就开始' },
  { beat: 84, x: 0, y: 0, z: 300, rx: 0, ry: 0, rz: 0, focus: 'logo', title: '' },
  { beat: 92, x: 0, y: 0, z: 980, rx: 2, ry: 0, rz: 0, focus: 'logo' },
  { beat: 100, x: 0, y: 0, z: 1400, rx: 0, ry: 0, rz: 0, focus: '', title: '' },
];

const FILM_SEC = 47.65;
const CURTAIN_SEC = 5;
const BLACK_SEC = 2.5;
const OPEN_FADE = 1.2;

let playing = false;
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
  if (!playing) return;
  const t = Math.max(0, nowSec());
  paintCurtain(t);
  if (t >= FILM_SEC) { openSite(); return; }
  const beatF = t / BEAT;
  const beat = Math.max(0, Math.floor(beatF + 1e-9));
  const c = camAt(beatF);
  applyCam(c);
  root.style.setProperty('--beat-phase', String(beatF - beat));
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
  root.classList.remove('gate', 'scoring', 'leaving', 'integrating');
  root.classList.add('open');
  lockScroll(false);
  pinTop();
  if (beatBar) beatBar.style.transform = 'scaleX(0)';
  if (curtain) {
    curtain.style.transition = instant
      ? 'none'
      : 'opacity .8s var(--film, cubic-bezier(.16,1,.3,1))';
    curtain.style.opacity = '0';
  }
  watchReveal();
}

function abortAudioLoad() {
  try { loadAbort && loadAbort.abort(); } catch { /* ignore */ }
}

function openSite(instant) {
  if (root.classList.contains('open')) return;
  abortAudioLoad();
  playing = false;
  cancelAnimationFrame(raf);
  if (audio) try { audio.pause(); } catch { /* ignore */ }
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
  window.setTimeout(() => finishOpen(false), 120);
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
}

function markAudioReady(label) {
  audioReady = true;
  setExploreReady(true);
  setLoadProgress(1, label || '影片已就绪');
}

async function prefetchAudio() {
  if (!audio) { markAudioReady(); return; }
  setExploreReady(false);
  setLoadProgress(0.02, '正在加载影片');
  loadAbort = new AbortController();
  const src = audio.getAttribute('src') || 'assets/audio/teamo-home.mp3';
  try {
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
    const blob = new Blob(chunks, { type: res.headers.get('Content-Type') || 'audio/mpeg' });
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
    markAudioReady();
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    try { audio.preload = 'auto'; audio.load(); } catch { /* ignore */ }
    markAudioReady('影片未就绪，开片时尝试播放');
  }
}

function requestFilm() {
  if (playing || root.classList.contains('scoring') || root.classList.contains('open')) return;
  if (!audioReady) return;
  startFilm();
}

async function startFilm() {
  lastBeat = -1;
  lastTitle = '';
  slam('');
  if (curtain) {
    curtain.style.transition = 'none';
    curtain.style.background = '#000';
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
    audio.currentTime = 0;
    await audio.play();
    t0 = performance.now() - audio.currentTime * 1000;
  } catch {
    /* 无声也把片子演完，绝不跳进展览页 */
  }
}

function skipFilm() {
  if (audio) { audio.pause(); audio.currentTime = 0; }
  playing = false;
  cancelAnimationFrame(raf);
  if (reduce || !curtain) { openSite(true); return; }
  const start = performance.now();
  const dur = 1200;
  const tick = (now) => {
    const p = Math.min(1, (now - start) / dur);
    curtain.style.transition = 'none';
    if (p < 0.5) {
      curtain.style.background = '#000';
      curtain.style.opacity = String(p / 0.5);
    } else {
      const v = (p - 0.5) / 0.5;
      const g = Math.round(255 * v);
      curtain.style.background = `rgb(${g},${g},${g})`;
      curtain.style.opacity = '1';
    }
    if (p < 1) requestAnimationFrame(tick);
    else openSite();
  };
  requestAnimationFrame(tick);
}

function flipTheme() {
  root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('teamo-home-theme', root.dataset.theme);
}

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
      el.style.setProperty('--delay', `${(i % 4) * 70}ms`);
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
      io.unobserve(e.target);
    }
  }, { threshold: 0.14, rootMargin: '0px 0px -8% 0px' });
  nodes.forEach((n) => io.observe(n));
}

if (themeBtn) {
  themeBtn.addEventListener('click', () => flipTheme());
}
window.addEventListener('scroll', () => {
  if (nav) nav.classList.toggle('scrolled', window.scrollY > 8);
}, { passive: true });
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
pinTop();
prepareReveal();

const gateSkip = document.getElementById('gate-skip');

if (reduce) {
  openSite(true);
} else {
  root.classList.add('gate');
  root.classList.remove('open', 'scoring');
  /* 片尾由时钟收束（最后 5 秒黑→白），不在 audio.ended 时硬切 */
  exploreCta && exploreCta.addEventListener('click', requestFilm);
  skip && skip.addEventListener('click', skipFilm);
  gateSkip && gateSkip.addEventListener('click', () => openSite(true));
  prefetchAudio();
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
    } else if (root.classList.contains('scoring') && !root.classList.contains('leaving') && e.key === 'Escape') {
      e.preventDefault();
      skipFilm();
    }
  });
}
