// The couch interface: focus moved with a remote's arrows (or a game controller), big focus effects,
// and Back mapped to the right "close" for each screen. Always on inside the Android TV app
// (window.LumenTV comes from its WebView); elsewhere (the PC seen on the TV through Moonlight and
// Sunshine, a browser on a TV) it switches on by itself when a remote or controller is driving, or
// from Ajustes / ?tv=1.
import { ctx } from './context.js';
import { store, log } from './store.js';
import { toast } from './ui.js';
import { startGamepad } from './gamepad.js';

// The Android TV app itself: VLC, APK updates, the box's limits.
export const IS_TV_APP = !!window.LumenTV;
// The couch interface is on (a live binding: importers always see the current value).
export let IS_TV = IS_TV_APP;

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
  if (!IS_TV || e.defaultPrevented) return;
  const t = e.target;
  // Away from the TV app there's no Android Back: Backspace / Back / Esc do its job. Esc is left to
  // the player and sheets when one is open (they close themselves with it).
  if (!IS_TV_APP && ['Escape', 'Backspace', 'BrowserBack'].includes(e.key) && !t.matches?.(TEXT_INPUT)) {
    const layer = ctx.player || document.querySelector('.sheet-backdrop, .ctx-menu');
    if (e.key === 'Escape' && layer) return;
    e.preventDefault();
    back();
    return;
  }
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

// ---------- switching the couch interface on and off ----------
// tvMode (Ajustes, or ?tv=1 / ?tv=0 / ?tv=auto in the address): 'auto' | 'on' | 'off'.
const MODE_KEY = 'tvMode';
const mode = () => store.get(MODE_KEY, 'auto');
let auto = false; // switched on by detection, so the mouse may switch it off again
let enteredFullscreen = false;
let sunshine = false; // Sunshine running on this PC (Windows app): one arrow press is enough
let lastMouse = 0;
let arrows = [];

function setTvUi(on, { why = '', fromKey = false } = {}) {
  if (IS_TV === on) return;
  IS_TV = on;
  document.documentElement.classList.toggle('tv', on);
  log(`interfaz de tele ${on ? 'encendida' : 'apagada'}${why ? ` (${why})` : ''}`);
  if (on) {
    focusFirstSoon();
    fullscreen(true, fromKey);
    if (auto) toast('Interfaz para tele: muévete con las flechas o el mando. Mueve el ratón para volver a la normal.');
  } else {
    clearInterval(focusTimer);
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    fullscreen(false);
  }
}

// On a TV nothing of the window should show: full screen while the couch interface is on, and back
// as it was afterwards. The browser only allows it from a key press, not from a controller.
async function fullscreen(on, fromKey = false) {
  const host = window.lumenHost;
  try {
    if (on) {
      if (host?.win?.setFullscreen) enteredFullscreen = !(await host.win.setFullscreen(true));
      else if (fromKey && !document.fullscreenElement) { await document.documentElement.requestFullscreen(); enteredFullscreen = true; }
    } else if (enteredFullscreen) {
      enteredFullscreen = false;
      if (host?.win?.setFullscreen) await host.win.setFullscreen(false);
      else if (document.fullscreenElement) await document.exitFullscreen();
    }
  } catch {}
}

// Ajustes changed (or the app started): follow the chosen mode.
export function applyTvMode() {
  if (IS_TV_APP) return;
  auto = false;
  const m = mode();
  if (m === 'on') setTvUi(true, { why: 'ajuste' });
  else setTvUi(false, { why: m === 'off' ? 'ajuste' : '' });
}

// Arrows with the mouse untouched for a while: someone on the sofa with a remote (Moonlight sends
// the remote's keys as the keyboard's). Three presses in a few seconds, or one if Sunshine is running.
function detectKey(e) {
  if (IS_TV || mode() !== 'auto' || !DIRS[e.key] || e.target.matches?.(TEXT_INPUT) || e.target.matches?.('input[type=range], select')) return;
  const now = Date.now();
  if (lastMouse && now - lastMouse < 15000) return;
  arrows = arrows.filter((t) => now - t < 4000).concat(now);
  if (arrows.length < (sunshine ? 1 : 3)) return;
  arrows = [];
  auto = true;
  setTvUi(true, { why: sunshine ? 'flechas, con Sunshine en marcha' : 'flechas sin ratón', fromKey: true });
}

// A real mouse move (not a twitch) brings the normal interface back, if detection had switched it.
let moved = 0;
let movedAt = 0;
function onMouse(e) {
  const now = Date.now();
  if (now - movedAt > 1000) moved = 0;
  movedAt = now;
  moved += Math.abs(e.movementX || 0) + Math.abs(e.movementY || 0);
  if (moved < 60) return;
  lastMouse = now;
  if (IS_TV && auto) { auto = false; setTvUi(false, { why: 'ratón' }); }
}

function onControllerUse() {
  if (IS_TV || mode() !== 'auto') return;
  auto = true;
  setTvUi(true, { why: 'mando' });
}

// Called once settings are loaded (app.js).
export function initTv() {
  document.addEventListener('keydown', detectKey, true);
  document.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', () => { if (IS_TV) focusFirstSoon(); });
  if (IS_TV_APP) {
    setTimeout(() => import('./tv-update.js').then((m) => m.checkTvUpdate()), 20000);
    document.documentElement.classList.add('tv');
    window.lumenTvBack = back;
    window.lumenTvPause = () => ctx.player?.video?.pause();
    focusFirstSoon();
    return;
  }
  const q = new URLSearchParams(location.search).get('tv');
  if (q) store.set(MODE_KEY, ['1', 'on', 'si', 'sí'].includes(q) ? 'on' : ['0', 'off', 'no'].includes(q) ? 'off' : 'auto');
  window.addEventListener('mousemove', onMouse, { passive: true });
  startGamepad({ onUse: onControllerUse });
  window.lumenHost?.sunshine?.().then((on) => {
    sunshine = !!on;
    if (on) log('Sunshine en marcha en este PC: la interfaz de tele se enciende con la primera flecha');
  }).catch(() => {});
  applyTvMode();
}
