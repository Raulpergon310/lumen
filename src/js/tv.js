// Android TV: moves focus with the remote's arrows and maps Back to the right "close" for each screen.
// Only active inside the Android TV app (window.LumenTV comes from its WebView).
import { ctx } from './context.js';

export const IS_TV = !!window.LumenTV;

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([type=hidden]):not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';
const TEXT_INPUT = 'input[type=text], input[type=search], input[type=url], input[type=password], input:not([type]), textarea';
const DIRS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

// Where focus may go right now: the topmost open layer, else the whole page.
function scope() {
  const layers = ['.sheet-backdrop', '.p-menu:not([hidden])', '.player', '.menu:not([hidden])'];
  for (const sel of layers) {
    const el = document.querySelector(sel);
    if (el && visible(el)) return el;
  }
  return document.body;
}

// Never targets: the play button inside a card (the card itself opens/plays) and hidden player controls.
const SKIP = '.card .card-play, .player:not(.show-ui) .p-controls *';

function visible(el) {
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const st = getComputedStyle(el);
  return st.visibility !== 'hidden' && Number(st.opacity) > 0.05;
}

// Cheap list (one layout pass, no style lookups): the home screen has hundreds of cards and the
// TV box's CPU is slow, so full visibility checks only run on the element finally picked.
function candidates(root = scope()) {
  const out = [];
  for (const el of root.querySelectorAll(FOCUSABLE)) {
    if (el.matches(SKIP)) continue;
    const r = el.getBoundingClientRect();
    if (r.width >= 2 && r.height >= 2) out.push({ el, r });
  }
  return out;
}

function inViewport(r) {
  return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
}

function focusEl(el) {
  if (!el) return false;
  el.focus({ preventScroll: true });
  if (!el.closest('.player, .menu')) reveal(el);
  ctx.player?.poke?.();
  return true;
}

// Rows glide only when the focused card reaches an edge; changing row glides the page so the row
// always lands at the same height on screen. Other elements scroll only if they are off screen.
function reveal(el) {
  const track = el.matches(CARD) && el.parentElement.classList.contains('row-track') ? el.parentElement : null;
  if (track) {
    const t = track.getBoundingClientRect();
    const c = el.getBoundingClientRect();
    const pad = 64;
    let dx = 0;
    if (c.right > t.right - pad) dx = c.right - (t.right - pad);
    else if (c.left < t.left + pad) dx = c.left - (t.left + pad);
    if (dx) track.scrollBy({ left: dx, behavior: 'smooth' });
    const row = el.closest('.row') || track;
    const target = Math.max(0, scrollY + row.getBoundingClientRect().top - innerHeight * 0.3);
    if (Math.abs(target - scrollY) > 4) scrollTo({ top: target, behavior: 'smooth' });
    return;
  }
  if (el.matches(CARD)) { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' }); return; }
  const r = el.getBoundingClientRect();
  if (el.closest('.nav') || el.closest('.hero')) { if (scrollY > 0 && el.closest('.hero')) scrollTo({ top: 0, behavior: 'smooth' }); return; }
  if (r.top < 80 || r.bottom > innerHeight - 20) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

export function focusFirst() {
  const view = document.getElementById('view');
  const root = scope() === document.body ? view : scope();
  const list = candidates(root).filter((c) => inViewport(c.r) && visible(c.el)).map((c) => c.el);
  const preferred = list.find((el) => el.matches('.btn-primary, .card, .episode, .field')) || list[0];
  return focusEl(preferred);
}

// After a page changes, put focus on its first item once it has rendered.
let focusTimer = null;
function focusFirstSoon() {
  clearInterval(focusTimer);
  let tries = 0;
  focusTimer = setInterval(() => {
    const active = document.activeElement;
    const settled = active && active !== document.body && document.contains(active) && visible(active);
    if (settled || focusFirst() || ++tries > 30) clearInterval(focusTimer);
  }, 150);
}

const CARD = '.card, .episode';

// Rows and grids of cards are walked by structure, touching only a few dozen elements: measuring
// every card on the home screen costs ~25 ms per key press on a TV box.
const firstCard = (track) => track && [...track.children].find((el) => el.matches(CARD));

function structuralMove(cur, dir) {
  // Hero ↔ first row: the jump everyone makes, without measuring the whole page.
  if (dir === 'down' && cur.closest('.hero')) return firstCard(document.querySelector('.rows .row-track'));
  if (!cur.matches(CARD)) return null;
  const track = cur.parentElement;
  const cards = () => [...track.children].filter((el) => el.matches(CARD));
  if (track.classList.contains('row-track')) {
    if (dir === 'left' || dir === 'right') {
      let el = cur;
      do el = dir === 'right' ? el.nextElementSibling : el.previousElementSibling; while (el && !el.matches(CARD));
      return el || cur; // end of the row: stay
    }
    const rows = [...document.querySelectorAll('.row-track')].filter((t) => t.querySelector(CARD) && t.offsetParent);
    const next = rows[rows.indexOf(track) + (dir === 'down' ? 1 : -1)];
    if (!next) return dir === 'up' ? document.querySelector('.hero .actions .btn') : null; // else geometry decides
    const x = cur.getBoundingClientRect().left;
    let best = null;
    let bestDx = Infinity;
    for (const el of next.children) {
      if (!el.matches(CARD)) continue;
      const dx = Math.abs(el.getBoundingClientRect().left - x);
      if (dx < bestDx) { bestDx = dx; best = el; }
    }
    return best;
  }
  if (track.classList.contains('grid')) {
    const list = cards();
    const i = list.indexOf(cur);
    const top = list[0].offsetTop;
    let cols = list.findIndex((el) => el.offsetTop !== top);
    if (cols < 1) cols = list.length;
    const j = { left: i - 1, right: i + 1, up: i - cols, down: i + cols }[dir];
    if ((dir === 'left' || dir === 'right') && Math.floor(j / cols) !== Math.floor(i / cols)) return cur;
    if (j < 0) return null;
    return list[Math.min(j, list.length - 1)] === cur ? null : list[Math.min(j, list.length - 1)];
  }
  return null;
}

// Picks the nearest element in the pressed direction, strongly preferring the same row/column.
function move(dir) {
  const cur = document.activeElement;
  const root = scope();
  if (!cur || cur === document.body || !root.contains(cur)) return focusFirst();
  if (root === document.body) {
    const next = structuralMove(cur, dir);
    if (next) return next === cur || focusEl(next);
  }
  if (!visible(cur)) return focusFirst();
  const a = cur.getBoundingClientRect();
  const scored = [];
  for (const { el, r: b } of candidates(root)) {
    if (el === cur || el.contains(cur) || cur.contains(el)) continue;
    let primary;
    let ortho;
    if (dir === 'right' || dir === 'left') {
      primary = dir === 'right' ? b.left - a.right : a.left - b.right;
      if (primary < -a.width / 2) continue;
      ortho = Math.max(0, Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom));
      if (ortho === 0) ortho = -Math.min(a.bottom, b.bottom) + Math.max(a.top, b.top); // overlap → bonus
    } else {
      primary = dir === 'down' ? b.top - a.bottom : a.top - b.bottom;
      if (primary < -a.height / 2) continue;
      const gap = Math.max(0, Math.max(a.left, b.left) - Math.min(a.right, b.right));
      ortho = gap + Math.abs((a.left + a.right) / 2 - (b.left + b.right) / 2) * 0.3;
    }
    scored.push({ el, score: Math.max(0, primary) + ortho * 4 });
  }
  scored.sort((x, y) => x.score - y.score);
  const best = scored.find((c) => visible(c.el));
  if (best) return focusEl(best.el);
  // Nothing further down/up: scroll the page so content without focusable items is still reachable.
  if (root === document.body && (dir === 'down' || dir === 'up')) scrollBy({ top: dir === 'down' ? 300 : -300, behavior: 'smooth' });
  return false;
}

function onKey(e) {
  if (e.defaultPrevented) return;
  const t = e.target;
  const dir = DIRS[e.key];
  if (dir) {
    // Inside a text box Left/Right move the cursor.
    if (t.matches?.(TEXT_INPUT) && (dir === 'left' || dir === 'right')) return;
    if (t.matches?.('input[type=range]') && (dir === 'left' || dir === 'right')) return;
    e.preventDefault();
    move(dir);
    return;
  }
  if (e.key === 'Enter' && t && t !== document.body && !t.matches('a, button, input, select, textarea, label')) {
    e.preventDefault();
    t.click();
    return;
  }
  // Menu button on the remote = right-click (poster options).
  if (e.key === 'ContextMenu' && t && t !== document.body) {
    e.preventDefault();
    const r = t.getBoundingClientRect();
    t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    setTimeout(focusFirst, 50);
  }
}

// Returns true when the app handled Back; false lets Android leave the app.
function back() {
  const esc = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  if (document.activeElement?.matches?.(TEXT_INPUT)) { document.activeElement.blur(); return true; }
  const navMenu = document.querySelector('.nav .menu:not([hidden])');
  if (navMenu) { navMenu.hidden = true; focusEl(document.querySelector('.avatar')); return true; }
  if (ctx.launch && !ctx.player) {
    ctx.launch.cancelled = true;
    document.querySelector('#player-root > .launching')?.remove();
    return true;
  }
  if (ctx.player || document.querySelector('.sheet-backdrop, .ctx-menu')) { esc(); return true; }
  const path = location.hash.replace(/^#/, '').split('?')[0];
  if (path && path !== '/home' && history.length > 1) { history.back(); return true; }
  return false;
}

if (IS_TV) {
  setTimeout(() => import('./tv-update.js').then((m) => m.checkTvUpdate()), 20000);
  document.documentElement.classList.add('tv');
  document.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', () => focusFirstSoon());
  window.lumenTvBack = back;
  window.lumenTvPause = () => ctx.player?.video?.pause();
  focusFirstSoon();
}
