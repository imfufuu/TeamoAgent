const BPM = 124;
const BEAT = 60 / BPM; // ≈ 483.871ms；第 0 帧 = 第一拍
const WHIP = 0.48; // 约 232ms 砸进下一镜，卡在小节拍上

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

const SCENES = [
  { beat: 0, x: 0, y: 80, z: 920, rx: 16, ry: -22, rz: 0, focus: 'logo', title: '' },
  { beat: 4, x: 0, y: 0, z: 150, rx: 0, ry: 0, rz: 0, focus: 'logo', title: 'TEAMOAGENT' },
  { beat: 8, x: 0, y: -460, z: 210, rx: 12, ry: 8, rz: -3, focus: 'copy', title: '浏览器里的' },
  { beat: 12, x: 40, y: -440, z: 120, rx: 2, ry: -10, rz: 3, focus: 'copy', title: '智能体。' },
  { beat: 16, x: 480, y: 70, z: 380, rx: 8, ry: 24, rz: 0, focus: 'sandbox', title: '沙箱' },
  { beat: 20, x: 460, y: 40, z: 125, rx: 0, ry: 6, rz: 0, focus: 'sandbox', title: 'JS · Python · C++' },
  { beat: 24, x: -520, y: 240, z: 360, rx: -8, ry: -20, rz: 4, focus: 'files', title: '工作区' },
  { beat: 28, x: -500, y: 200, z: 115, rx: 0, ry: -4, rz: 0, focus: 'files', title: '120 MB' },
  { beat: 32, x: 160, y: -360, z: 480, rx: 14, ry: 10, rz: -5, focus: 'image', title: '出图' },
  { beat: 36, x: 140, y: -320, z: 145, rx: 2, ry: -12, rz: 0, focus: 'image', title: '识图' },
  { beat: 40, x: -240, y: -10, z: 190, rx: 0, ry: 18, rz: 0, focus: 'ultra', title: 'Ultra' },
  { beat: 44, x: -220, y: 20, z: 110, rx: -8, ry: -6, rz: 0, focus: 'ultra', title: '深度思考' },
  { beat: 48, x: 80, y: 400, z: 340, rx: -14, ry: 6, rz: 2, focus: 'term', title: '跑起来' },
  { beat: 52, x: 60, y: 360, z: 125, rx: -4, ry: 0, rz: 0, focus: 'term', title: '结果落盘' },
  { beat: 56, x: 620, y: -210, z: 300, rx: 10, ry: -24, rz: 0, focus: 'tools', title: '差分' },
  { beat: 60, x: 600, y: -180, z: 130, rx: 0, ry: -8, rz: 0, focus: 'tools', title: '搜索 · JSON' },
  { beat: 64, x: -620, y: -170, z: 280, rx: 8, ry: 22, rz: -3, focus: 'zip', title: 'ZIP' },
  { beat: 68, x: -600, y: -140, z: 120, rx: 0, ry: 8, rz: 0, focus: 'zip', title: '打包带走' },
  { beat: 72, x: 0, y: 20, z: 780, rx: 10, ry: 0, rz: 0, focus: 'logo', title: '现在就开始' },
  { beat: 80, x: 0, y: 0, z: 180, rx: 0, ry: 0, rz: 0, focus: 'logo', title: 'TeamoAgent' },
  { beat: 88, x: 40, y: 30, z: 1280, rx: 8, ry: -6, rz: 0, focus: '', title: '' },
  { beat: 100, x: 0, y: 0, z: 1700, rx: 4, ry: 0, rz: 0, focus: '', title: '' },
];

const FILM_SEC = 47.65;

let playing = false;
let raf = 0;
let lastBeat = -1;
let lastTitle = '';
let t0 = 0;

function easeOutCubic(t) {
  const x = Math.min(1, Math.max(0, t));
  return 1 - (1 - x) ** 3;
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
  const prev = i === 0
    ? { x: cur.x, y: cur.y + 40, z: cur.z + 720, rx: cur.rx + 10, ry: cur.ry - 8, rz: 0 }
    : SCENES[i - 1];
  const local = beatF - cur.beat;
  const u = easeOutCubic(local / WHIP);
  const t = Math.min(1, u);
  const c = {
    x: lerp(prev.x, cur.x, t),
    y: lerp(prev.y, cur.y, t),
    z: lerp(prev.z, cur.z, t),
    rx: lerp(prev.rx, cur.rx, t),
    ry: lerp(prev.ry, cur.ry, t),
    rz: lerp(prev.rz, cur.rz, t),
    focus: t > 0.55 ? cur.focus : prev.focus,
    title: cur.title,
  };
  if (local > WHIP) {
    const drift = local - WHIP;
    c.z -= drift * 22;
    c.y += Math.sin(drift * 1.4) * 6;
    c.ry += Math.sin(drift * 0.9) * 1.8;
  }
  return c;
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

function kickShot(hard) {
  const el = document.querySelector('.shot.focus .shot-inner');
  if (!el) return;
  el.animate(
    [
      { transform: 'translate(-50%, -50%) scale(1)' },
      { transform: `translate(-50%, -50%) scale(${hard ? 1.07 : 1.03})`, offset: 0.14 },
      { transform: 'translate(-50%, -50%) scale(1)' },
    ],
    { duration: hard ? 340 : 220, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  );
}

function onBeat(beat) {
  const i = sceneIndex(beat);
  const sc = SCENES[i];
  if (sc.beat === beat) slam(sc.title || '');
  kickShot(beat % 4 === 0);
}

function nowSec() {
  if (audio && !audio.paused && !audio.ended && Number.isFinite(audio.currentTime) && audio.currentTime > 0.03) {
    return audio.currentTime;
  }
  return (performance.now() - t0) / 1000;
}

function frame() {
  if (!playing) return;
  const t = Math.max(0, nowSec());
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

function openSite() {
  playing = false;
  cancelAnimationFrame(raf);
  root.classList.remove('gate', 'scoring');
  root.classList.add('open');
  lockScroll(false);
  if (beatBar) beatBar.style.transform = 'scaleX(0)';
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
  openSite();
}

if (themeBtn) {
  themeBtn.addEventListener('click', () => {
    root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('teamo-home-theme', root.dataset.theme);
  });
}
window.addEventListener('scroll', () => {
  if (nav) nav.classList.toggle('scrolled', window.scrollY > 8);
}, { passive: true });

if (reduce) {
  openSite();
} else {
  root.classList.add('gate');
  root.classList.remove('open', 'scoring');
  if (audio) {
    audio.addEventListener('ended', () => { if (playing) openSite(); });
  }
  explore && explore.addEventListener('click', startFilm);
  skip && skip.addEventListener('click', skipFilm);
}
