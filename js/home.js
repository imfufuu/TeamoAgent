const BPM = 124;
const BEAT = 60 / BPM; // ≈ 483.871ms；第 0 帧 = 第一拍
const WHIP = 4; // 整段小节内滑到下一机位，不再短促砸镜

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
const skip = document.getElementById('film-skip');
const nav = document.querySelector('.nav');
const themeBtn = document.getElementById('theme-toggle');
const bill = document.getElementById('bill-text');
const billboard = document.getElementById('billboard');
const curtain = document.getElementById('curtain');

const SCENES = [
  { beat: 0, x: 0, y: 80, z: 920, rx: 16, ry: -22, rz: 0, focus: 'logo', title: '' },
  { beat: 4, x: 0, y: 0, z: 150, rx: 0, ry: 0, rz: 0, focus: 'logo', title: 'TEAMOAGENT' },
  { beat: 8, x: 0, y: -460, z: 210, rx: 8, ry: 6, rz: 0, focus: 'copy', title: '浏览器里的智能体。' },
  { beat: 12, x: 20, y: -440, z: 130, rx: 2, ry: -6, rz: 0, focus: 'copy' },
  { beat: 16, x: 480, y: 70, z: 360, rx: 6, ry: 18, rz: 0, focus: 'sandbox', title: '沙箱隔离执行' },
  { beat: 20, x: 460, y: 40, z: 140, rx: 0, ry: 6, rz: 0, focus: 'sandbox' },
  { beat: 24, x: -520, y: 240, z: 340, rx: -6, ry: -16, rz: 0, focus: 'files', title: '工作区 120 MB' },
  { beat: 28, x: -500, y: 200, z: 130, rx: 0, ry: -4, rz: 0, focus: 'files' },
  { beat: 32, x: 160, y: -360, z: 440, rx: 10, ry: 8, rz: 0, focus: 'image', title: '出图与识图' },
  { beat: 36, x: 140, y: -320, z: 150, rx: 2, ry: -8, rz: 0, focus: 'image' },
  { beat: 40, x: -240, y: -10, z: 190, rx: 0, ry: 12, rz: 0, focus: 'ultra', title: '思考档 Off → Ultra' },
  { beat: 44, x: -220, y: 16, z: 120, rx: -4, ry: -4, rz: 0, focus: 'ultra' },
  { beat: 48, x: 80, y: 400, z: 320, rx: -10, ry: 4, rz: 0, focus: 'term', title: '跑起来，结果落盘' },
  { beat: 52, x: 60, y: 360, z: 140, rx: -4, ry: 0, rz: 0, focus: 'term' },
  { beat: 56, x: 620, y: -210, z: 280, rx: 8, ry: -18, rz: 0, focus: 'tools', title: '差分 · 搜索 · JSON' },
  { beat: 60, x: 600, y: -180, z: 140, rx: 0, ry: -6, rz: 0, focus: 'tools' },
  { beat: 64, x: -620, y: -170, z: 260, rx: 6, ry: 16, rz: 0, focus: 'zip', title: 'ZIP 打包带走' },
  { beat: 68, x: -600, y: -140, z: 130, rx: 0, ry: 6, rz: 0, focus: 'zip' },
  { beat: 72, x: 0, y: 20, z: 640, rx: 6, ry: 0, rz: 0, focus: 'logo', title: '现在就开始' },
  { beat: 84, x: 0, y: 0, z: 220, rx: 0, ry: 0, rz: 0, focus: 'logo', title: '' },
  { beat: 92, x: 0, y: 0, z: 900, rx: 4, ry: 0, rz: 0, focus: 'logo' },
  { beat: 100, x: 0, y: 0, z: 1400, rx: 2, ry: 0, rz: 0, focus: '', title: '' },
];

const FILM_SEC = 47.65;
const CURTAIN_SEC = 5;
const BLACK_SEC = 2.5;

let playing = false;
let raf = 0;
let lastBeat = -1;
let lastTitle = '';
let t0 = 0;

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
  return {
    x: lerp(cur.x, next.x, u),
    y: lerp(cur.y, next.y, u),
    z: lerp(cur.z, next.z, u),
    rx: lerp(cur.rx, next.rx, u),
    ry: lerp(cur.ry, next.ry, u),
    rz: lerp(cur.rz, next.rz, u),
    focus: u < 0.5 ? cur.focus : next.focus,
    title: cur.title,
  };
}

function applyCam(c) {
  if (!world) return;
  world.style.transform = `translate3d(${-c.x}px, ${-c.y}px, ${-c.z}px) rotateX(${c.rx}deg) rotateY(${c.ry}deg) rotateZ(${c.rz}deg)`;
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
  const u = t - (FILM_SEC - CURTAIN_SEC);
  curtain.style.transition = 'none';
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

function finishOpen(instant) {
  root.classList.remove('gate', 'scoring', 'leaving');
  root.classList.add('open');
  lockScroll(false);
  if (beatBar) beatBar.style.transform = 'scaleX(0)';
  if (curtain) {
    curtain.style.transition = instant
      ? 'none'
      : 'opacity .8s var(--film, cubic-bezier(.16,1,.3,1))';
    curtain.style.opacity = '0';
  }
  watchReveal();
}

function openSite(instant) {
  if (root.classList.contains('open')) return;
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

async function startFilm() {
  lastBeat = -1;
  lastTitle = '';
  slam('');
  root.classList.remove('gate', 'open');
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
  const sels = ['.hero > div', '.stat', '.section h2', '.section .sub', '.card', '.steps li', '.panel-preview', '.chip', '.faq details', '.honesty li', '.cta-block h2', '.cta-block p', '.cta-block .cta', 'footer'];
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
prepareReveal();

const gateSkip = document.getElementById('gate-skip');

if (reduce) {
  openSite(true);
} else {
  root.classList.add('gate');
  root.classList.remove('open', 'scoring');
  /* 片尾由时钟收束（最后 5 秒黑→白），不在 audio.ended 时硬切 */
  explore && explore.addEventListener('click', startFilm);
  skip && skip.addEventListener('click', skipFilm);
  gateSkip && gateSkip.addEventListener('click', () => openSite(true));
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (root.classList.contains('gate')) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        startFilm();
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
