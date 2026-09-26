const BPM = 124;
const BEAT = 60 / BPM; // 精确拍长 ≈ 483.871ms，避免用 484ms 取整后漂移

const root = document.documentElement;
const saved = localStorage.getItem('teamo-home-theme');
const preferDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
root.dataset.theme = saved || (preferDark ? 'dark' : 'light');

const nav = document.querySelector('.nav');
const onScroll = () => { if (nav) nav.classList.toggle('scrolled', window.scrollY > 8); };
onScroll();
window.addEventListener('scroll', onScroll, { passive: true });

const themeBtn = document.getElementById('theme-toggle');
if (themeBtn) {
  themeBtn.addEventListener('click', () => {
    root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('teamo-home-theme', root.dataset.theme);
  });
}

const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const audio = document.getElementById('home-audio');
const playBtn = document.getElementById('score-play');
const playNav = document.getElementById('score-nav');
const beatBar = document.getElementById('beat-bar');
const kickEl = document.querySelector('.orbit-kick');
const cues = [...document.querySelectorAll('.beat-cue')];

let playing = false;
let raf = 0;
let lastBeat = -1;

function setPlaying(on) {
  playing = on;
  root.classList.toggle('scoring', on);
  for (const b of [playBtn, playNav]) {
    if (!b) continue;
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.classList.toggle('on', on);
  }
  if (playNav) playNav.textContent = on ? '暂停' : '播放';
}

function applyCues(beat) {
  for (const el of cues) {
    const on = Number(el.dataset.on || 0);
    const off = el.dataset.off === undefined ? Infinity : Number(el.dataset.off);
    el.classList.toggle('beat-in', beat >= on && beat < off);
  }
}

function kick(hard) {
  if (!kickEl || reduce) return;
  kickEl.animate(
    [
      { transform: 'scale(1)' },
      { transform: hard ? 'scale(1.055)' : 'scale(1.022)', offset: 0.14 },
      { transform: 'scale(1)' },
    ],
    { duration: hard ? 520 : 380, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  );
}

function frame() {
  if (!playing || !audio) return;
  const t = Math.max(0, audio.currentTime);
  const beatF = t / BEAT;
  const beat = Math.max(0, Math.floor(beatF + 1e-9));
  const phase = beatF - beat;
  root.style.setProperty('--beat-phase', String(phase));
  root.dataset.beat = String(beat);
  root.dataset.bar = String(Math.floor(beat / 4));
  if (beat !== lastBeat) {
    lastBeat = beat;
    applyCues(beat);
    kick(beat % 4 === 0);
  }
  if (beatBar && audio.duration) beatBar.style.transform = `scaleX(${Math.min(1, t / audio.duration)})`;
  raf = requestAnimationFrame(frame);
}

async function startScore() {
  if (!audio || reduce) return;
  lastBeat = -1;
  applyCues(-1);
  audio.currentTime = 0;
  try { await audio.play(); }
  catch { setPlaying(false); return; }
}

function stopScore() {
  if (audio) { audio.pause(); audio.currentTime = 0; }
  cancelAnimationFrame(raf);
  setPlaying(false);
  lastBeat = -1;
  applyCues(1e9);
  root.style.removeProperty('--beat-phase');
  delete root.dataset.beat;
  delete root.dataset.bar;
  if (beatBar) beatBar.style.transform = 'scaleX(0)';
}

async function toggleScore() {
  if (reduce) return;
  if (playing) stopScore();
  else await startScore();
}

if (audio && !reduce) {
  audio.addEventListener('play', () => {
    setPlaying(true);
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
  });
  audio.addEventListener('pause', () => {
    if (audio.currentTime > 0 && !audio.ended) {
      setPlaying(false);
      cancelAnimationFrame(raf);
    }
  });
  audio.addEventListener('ended', () => {
    cancelAnimationFrame(raf);
    setPlaying(false);
    applyCues(1e9);
    root.classList.add('scored');
  });
  playBtn && playBtn.addEventListener('click', toggleScore);
  playNav && playNav.addEventListener('click', toggleScore);
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' && e.key !== ' ') return;
    if (e.target && /^(INPUT|TEXTAREA|BUTTON|A)$/.test(e.target.tagName)) return;
    e.preventDefault();
    toggleScore();
  });
} else {
  applyCues(1e9);
}
