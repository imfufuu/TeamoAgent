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
