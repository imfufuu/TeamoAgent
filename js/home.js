const BPM = 124;
const BEAT = 60 / BPM; // ≈ 483.871ms；第 0 帧 = 第一拍

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

const CAM = [
  { beat: 0, x: 0, y: 40, z: 1280, rx: 12, ry: -16 },
  { beat: 8, x: 0, y: 0, z: 160, rx: 0, ry: 0 },
  { beat: 16, x: 0, y: -8, z: 320, rx: 3, ry: 14 },
  { beat: 22, x: 640, y: 10, z: 380, rx: 2, ry: -10 },
  { beat: 30, x: 640, y: 0, z: 130, rx: 0, ry: 6 },
  { beat: 38, x: 640, y: 6, z: 300, rx: 1, ry: 0 },
  { beat: 42, x: 1280, y: 16, z: 360, rx: 4, ry: -8 },
  { beat: 50, x: 1280, y: 0, z: 120, rx: 0, ry: 4 },
  { beat: 58, x: 1920, y: -24, z: 340, rx: -3, ry: 10 },
  { beat: 66, x: 1920, y: -8, z: 140, rx: 0, ry: -4 },
  { beat: 74, x: 2560, y: 8, z: 360, rx: 2, ry: -12 },
  { beat: 82, x: 2560, y: 0, z: 130, rx: 0, ry: 8 },
  { beat: 88, x: 3200, y: 20, z: 340, rx: 5, ry: 0 },
  { beat: 94, x: 3200, y: 0, z: 150, rx: 0, ry: 0 },
  { beat: 100, x: 1600, y: 0, z: 1680, rx: 6, ry: 0 },
];

let playing = false;
let raf = 0;
let lastBeat = -1;
let lastKick = 0;

function smoother(t) {
  const x = Math.min(1, Math.max(0, t));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

function camAt(beatF) {
  let i = 0;
  while (i < CAM.length - 1 && beatF >= CAM[i + 1].beat) i++;
  const a = CAM[i];
  const b = CAM[Math.min(i + 1, CAM.length - 1)];
  const span = Math.max(0.0001, b.beat - a.beat);
  const u = smoother((beatF - a.beat) / span);
  const mix = (k) => a[k] + (b[k] - a[k]) * u;
  return { x: mix('x'), y: mix('y'), z: mix('z'), rx: mix('rx'), ry: mix('ry') };
}

function applyCam(c, beatF) {
  if (!world) return;
  world.style.transform = `translate3d(${-c.x}px, ${-c.y}px, ${-c.z}px) rotateX(${c.rx}deg) rotateY(${c.ry}deg)`;
  root.style.setProperty('--beat-phase', String(beatF - Math.floor(beatF)));
  for (const shot of shots) {
    const sx = Number(shot.dataset.x || 0);
    const dist = Math.abs(sx - c.x) * 0.55 + Math.abs(c.z - 140) * 0.45;
    shot.classList.toggle('focus', dist < 220);
    shot.style.filter = `blur(${Math.min(18, dist / 90).toFixed(2)}px)`;
    shot.style.opacity = String(dist < 220 ? 1 : Math.max(0.12, 1 - dist / 1400));
  }
}

function kickHard() {
  if (reduce || !world) return;
  const now = performance.now();
  if (now - lastKick < 200) return;
  lastKick = now;
  world.animate(
    [
      { offset: 0, filter: 'brightness(1)' },
      { offset: 0.12, filter: 'brightness(1.06)' },
      { offset: 1, filter: 'brightness(1)' },
    ],
    { duration: 420, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  );
}

function frame() {
  if (!playing || !audio) return;
  const t = Math.max(0, audio.currentTime);
  const beatF = t / BEAT;
  const beat = Math.max(0, Math.floor(beatF + 1e-9));
  applyCam(camAt(beatF), beatF);
  root.dataset.beat = String(beat);
  root.dataset.bar = String(Math.floor(beat / 4));
  if (beat !== lastBeat) {
    lastBeat = beat;
    if (beat % 4 === 0) kickHard();
  }
  if (beatBar && audio.duration) beatBar.style.transform = `scaleX(${Math.min(1, t / audio.duration)})`;
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
  if (!audio) { openSite(); return; }
  lastBeat = -1;
  root.classList.remove('gate', 'open');
  root.classList.add('scoring');
  lockScroll(true);
  applyCam(camAt(0), 0);
  audio.currentTime = 0;
  try { await audio.play(); }
  catch { openSite(); }
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
    audio.addEventListener('play', () => {
      playing = true;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(frame);
    });
    audio.addEventListener('ended', () => openSite());
  }
  explore && explore.addEventListener('click', startFilm);
  skip && skip.addEventListener('click', skipFilm);
}
