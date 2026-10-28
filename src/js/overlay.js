// Controls drawn over the embedded mpv video. Same look as the built-in player; every action is an mpv command.
import { h, fmtTime, fmtEndsAt, image } from './ui.js';
import { icons } from './icons.js';

const host = window.lumenHost;
const mpv = host.mpv;
const cmd = (...c) => mpv.command(c);

const st = { pos: 0, dur: 0, paused: false, volume: 100, mute: false, tracks: [], aid: null, sid: null, cache: 0, buffering: false };
let data = {};
let hideTimer = null;
let dragging = false;
let hovering = false;

// ---------- DOM ----------
const titleEl = h('div', { class: 'p-title' });
const modeEl = h('div', { class: 'p-mode' });
const timeEl = h('span', { class: 'p-time' }, '0:00');
const durEl = h('span', { class: 'p-time dim' }, '0:00');
const endsEl = h('span', { class: 'p-ends' });
const prog = h('div', { class: 'p-prog' });
const buf = h('div', { class: 'p-buf' });
const knob = h('div', { class: 'p-knob' });
const markers = h('div', { class: 'p-markers' });
const hoverTime = h('div', { class: 'p-hover-time' });
const track = h('div', { class: 'p-track' }, buf, markers, prog, knob);
const seek = h('div', { class: 'p-seek' }, track, hoverTime);
const playBtn = h('button', { class: 'p-btn big', title: 'Reproducir/Pausa (Espacio)', html: icons.pause, onclick: () => cmd('cycle', 'pause') });
const muteBtn = h('button', { class: 'p-btn', title: 'Silenciar (M)', onclick: () => cmd('cycle', 'mute') });
const volSlider = h('input', { class: 'p-vol', type: 'range', min: 0, max: 100, step: 1, value: 100 });
volSlider.addEventListener('input', () => { cmd('set_property', 'volume', Number(volSlider.value)); cmd('set_property', 'mute', false); });
const nextBtn = h('button', { class: 'p-btn', title: 'Siguiente episodio (N)', html: icons.skipNext, hidden: true, onclick: () => cmd('script-message', 'lumen-next') });
const tracksBtn = h('button', { class: 'p-btn', title: 'Audio y subtítulos', html: icons.subtitles, onclick: (e) => { e.stopPropagation(); toggleMenu(); } });
const fsBtn = h('button', { class: 'p-btn', title: 'Pantalla completa (F)', html: icons.fullscreen, onclick: () => host.win.fullscreen() });
const menu = h('div', { class: 'p-menu glass', hidden: true, onclick: (e) => e.stopPropagation() });
const skipBtn = h('button', { class: 'p-skip', hidden: true, onclick: () => cmd('script-message', 'lumen-skip') });
const upNext = h('div', { class: 'p-upnext glass', hidden: true });
const spinner = h('div', { class: 'p-spinner' }, h('div', { class: 'spinner' }));
const flash = h('div', { class: 'p-flash' });

const winBtns = h('div', { class: 'p-winbtns' },
  h('button', { class: 'p-btn small', title: 'Minimizar', html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 12h12"/></svg>', onclick: () => host.win.minimize() }),
  h('button', { class: 'p-btn small', title: 'Cerrar la app', html: icons.close, onclick: () => host.win.close() }));

const topBar = h('div', { class: 'p-top' },
  h('button', { class: 'p-btn', title: 'Volver (Esc)', html: icons.back, onclick: () => mpv.stop() }),
  titleEl, modeEl, winBtns);

const controls = h('div', { class: 'p-controls' },
  topBar,
  h('div', { class: 'p-bottom' },
    seek,
    h('div', { class: 'p-row' },
      h('div', { class: 'p-group' },
        playBtn,
        h('button', { class: 'p-btn', title: 'Atrás 10 s (←)', html: icons.rewind, onclick: () => seekBy(-10) }),
        h('button', { class: 'p-btn', title: 'Adelante 30 s (→)', html: icons.forward, onclick: () => seekBy(30) }),
        h('div', { class: 'p-times' }, timeEl, h('span', { class: 'dim' }, ' / '), durEl),
        endsEl),
      h('div', { class: 'p-group' },
        nextBtn, tracksBtn,
        h('div', { class: 'p-volume' }, muteBtn, volSlider),
        fsBtn))));

const surface = h('div', { class: 'p-surface' });
const root = h('div', { class: 'player overlay-player show-ui' }, surface, spinner, flash, controls, skipBtn, upNext, menu);
document.getElementById('root').append(root);

// ---------- state from mpv ----------
mpv.onEvent((e) => {
  if (e.event !== 'property-change') return;
  switch (e.name) {
    case 'time-pos': if (typeof e.data === 'number') { st.pos = e.data; paintTime(); } break;
    case 'duration': if (e.data) { st.dur = e.data; paintTime(); paintMarkers(); } break;
    case 'pause': st.paused = !!e.data; playBtn.innerHTML = st.paused ? icons.play : icons.pause; if (st.paused) show(true); else poke(); break;
    case 'volume': st.volume = e.data ?? 100; paintVolume(); break;
    case 'mute': st.mute = !!e.data; paintVolume(); break;
    case 'track-list': st.tracks = e.data || []; if (!menu.hidden) toggleMenu(true); break;
    case 'aid': st.aid = e.data; break;
    case 'sid': st.sid = e.data; break;
    case 'demuxer-cache-time': st.cache = e.data || 0; paintTime(); break;
    case 'paused-for-cache': spinner.classList.toggle('show', !!e.data); break;
    default:
  }
});

host.overlay.onData((d) => {
  data = { ...data, ...d };
  titleEl.replaceChildren(...[h('div', { class: 'p-title-main' }, data.title || ''), data.subtitle ? h('div', { class: 'p-title-sub' }, data.subtitle) : null].filter(Boolean));
  modeEl.className = 'p-mode p-mode-direct';
  modeEl.title = data.modeDetail || '';
  modeEl.replaceChildren(h('span', { class: 'p-mode-dot' }), h('span', { class: 'p-mode-label' }, 'Reproducción directa'), h('span', { class: 'p-mode-detail' }, data.modeDetail || ''));
  nextBtn.hidden = !data.hasNext;
  skipBtn.hidden = !data.skip;
  skipBtn.textContent = data.skip || '';
  paintUpNext();
  paintMarkers();
  spinner.classList.toggle('show', !!data.loading);
});

host.overlay.ready();

// ---------- painting ----------
function paintTime() {
  const d = st.dur;
  if (!dragging) {
    const pct = `${d ? (st.pos / d) * 100 : 0}%`;
    prog.style.width = pct;
    knob.style.left = pct;
  }
  buf.style.width = `${d ? Math.min(100, (st.cache / d) * 100) : 0}%`;
  timeEl.textContent = fmtTime(st.pos);
  durEl.textContent = fmtTime(d);
  endsEl.textContent = d ? fmtEndsAt(d - st.pos) : '';
}

function paintVolume() {
  const silent = st.mute || st.volume === 0;
  muteBtn.innerHTML = silent ? icons.mute : icons.volume;
  const v = st.mute ? 0 : Math.min(100, st.volume);
  volSlider.value = v;
  volSlider.style.setProperty('--fill', `${v}%`);
}

function paintMarkers() {
  const d = st.dur;
  if (!d || !data.segments) return;
  markers.replaceChildren(...data.segments.map((s) => h('div', {
    class: 'p-marker',
    style: { left: `${(s.start / d) * 100}%`, width: `${((s.end - s.start) / d) * 100}%` },
  })));
}

function paintUpNext() {
  const n = data.upNext;
  if (!n) { upNext.hidden = true; return; }
  upNext.replaceChildren(
    image(n.art, { cls: 'p-upnext-art', placeholder: n.title }),
    h('div', { class: 'p-upnext-info' },
      h('div', { class: 'p-upnext-eyebrow' }, 'Siguiente episodio'),
      h('div', { class: 'p-upnext-title' }, n.title),
      h('div', { class: 'p-upnext-actions' },
        h('button', { class: 'btn btn-primary small', onclick: () => cmd('script-message', 'lumen-next') }, h('span', { class: 'btn-icon', html: icons.play }), h('span', null, 'Reproducir ahora')),
        h('button', { class: 'btn btn-glass small', onclick: () => { upNext.hidden = true; data.upNext = null; } }, 'Ocultar'))));
  upNext.hidden = false;
}

// ---------- tracks menu ----------
function trackLabel(t) {
  const lang = t.lang ? langName(t.lang) : '';
  return t.title && !/^(track|pista)?\s*\d*$/i.test(t.title) ? t.title : lang || `Pista ${t.id}`;
}

function trackDetail(t) {
  const ch = t['demux-channel-count'] ? ({ 1: 'Mono', 2: 'Estéreo', 6: '5.1', 8: '7.1' }[t['demux-channel-count']] || `${t['demux-channel-count']} canales`) : '';
  return [t.title && t.lang ? langName(t.lang) : '', String(t.codec || '').toUpperCase(), ch, t.forced ? 'Forzados' : '', t.external ? 'Externo' : '']
    .filter(Boolean).join(' · ');
}

function toggleMenu(force) {
  const open = force ?? menu.hidden;
  if (!open) { menu.hidden = true; return; }
  const opt = (label, sub, active, onclick) => h('button', { class: `p-opt ${active ? 'active' : ''}`, onclick },
    h('span', { class: 'p-opt-check', html: active ? icons.check : '' }),
    h('span', { class: 'p-opt-text' }, h('span', null, label), sub ? h('span', { class: 'p-opt-sub' }, sub) : null));
  const audios = st.tracks.filter((t) => t.type === 'audio');
  const subs = st.tracks.filter((t) => t.type === 'sub');
  menu.replaceChildren(
    h('div', { class: 'p-menu-col' },
      h('div', { class: 'p-menu-head' }, 'Audio'),
      audios.map((t) => opt(trackLabel(t), trackDetail(t), t.selected, () => { cmd('set_property', 'aid', t.id); menu.hidden = true; }))),
    h('div', { class: 'p-menu-col' },
      h('div', { class: 'p-menu-head' }, 'Subtítulos'),
      opt('Desactivados', null, !subs.some((t) => t.selected), () => { cmd('set_property', 'sid', 'no'); menu.hidden = true; }),
      subs.map((t) => opt(trackLabel(t), trackDetail(t), t.selected, () => { cmd('set_property', 'sid', t.id); menu.hidden = true; }))));
  menu.hidden = false;
  show(true);
}

const names = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(['es'], { type: 'language' }) : null;
const ISO3 = { spa: 'es', eng: 'en', jpn: 'ja', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', ita: 'it', por: 'pt', chi: 'zh', zho: 'zh', kor: 'ko', rus: 'ru', cat: 'ca', und: '' };
function langName(code) {
  const c = String(code).toLowerCase();
  if (c === 'und') return '';
  try {
    const n = names?.of(ISO3[c] ?? c);
    return n ? n[0].toUpperCase() + n.slice(1) : code;
  } catch {
    return code;
  }
}

// ---------- interaction ----------
function seekBy(delta) {
  cmd('seek', delta, 'relative');
  flashIcon(delta < 0 ? icons.rewind : icons.forward);
  poke();
}

function flashIcon(svg) {
  flash.innerHTML = svg;
  flash.classList.remove('go');
  void flash.offsetWidth;
  flash.classList.add('go');
}

function show(sticky) {
  root.classList.add('show-ui');
  clearTimeout(hideTimer);
  if (!sticky) hideTimer = setTimeout(hide, 3000);
}
function hide() {
  if (st.paused || hovering || dragging || !menu.hidden) return;
  root.classList.remove('show-ui');
}
function poke() { show(false); }

// "Hovering" keeps the controls up only while the mouse is really moved over the bars: a pointer
// resting where the bottom bar appears (by the taskbar, say) mustn't pin them on screen for the
// whole movie, and leaving the bars must clear it.
// Chromium also fires mousemove without any movement whenever what is under the pointer changes
// (the clock ticking every second), which kept resetting the hide timer: only real moves count.
let lastPointer = '';
root.addEventListener('mousemove', (e) => {
  const at = `${e.screenX},${e.screenY}`;
  const first = !lastPointer;
  if (at === lastPointer) return;
  lastPointer = at;
  if (first) return; // sent when the window appears under a still pointer, not a real move
  hovering = !!e.target.closest('.p-bottom, .p-top');
  poke();
});
controls.addEventListener('mouseout', () => { hovering = false; });
document.addEventListener('mouseleave', () => { hovering = false; clearTimeout(hideTimer); hideTimer = setTimeout(hide, 600); });
surface.addEventListener('click', () => {
  if (!menu.hidden) { menu.hidden = true; return; }
  cmd('cycle', 'pause');
  flashIcon(st.paused ? icons.play : icons.pause);
});
surface.addEventListener('dblclick', () => host.win.fullscreen());
document.addEventListener('click', () => { menu.hidden = true; });

// Dragging the top bar moves the window when it isn't fullscreen.
let dragFrom = null;
topBar.addEventListener('pointerdown', (e) => {
  if (e.target.closest('button')) return;
  dragFrom = [e.screenX, e.screenY];
  topBar.setPointerCapture(e.pointerId);
});
topBar.addEventListener('pointermove', (e) => {
  if (!dragFrom) return;
  host.win.moveBy(e.screenX - dragFrom[0], e.screenY - dragFrom[1]);
  dragFrom = [e.screenX, e.screenY];
});
topBar.addEventListener('pointerup', () => { dragFrom = null; });
topBar.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) host.win.maximize(); });

const ratioAt = (e) => {
  const r = track.getBoundingClientRect();
  return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
};
seek.addEventListener('pointermove', (e) => {
  const ratio = ratioAt(e);
  hoverTime.textContent = fmtTime(ratio * st.dur);
  hoverTime.style.left = `${ratio * 100}%`;
  if (dragging) { prog.style.width = `${ratio * 100}%`; knob.style.left = `${ratio * 100}%`; }
});
seek.addEventListener('pointerdown', (e) => {
  dragging = true;
  seek.setPointerCapture(e.pointerId);
  seek.classList.add('dragging');
});
seek.addEventListener('pointerup', (e) => {
  if (!dragging) return;
  dragging = false;
  seek.classList.remove('dragging');
  cmd('seek', ratioAt(e) * st.dur, 'absolute');
});

document.addEventListener('keydown', (e) => {
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const map = {
    ' ': () => cmd('cycle', 'pause'),
    k: () => cmd('cycle', 'pause'),
    ArrowLeft: () => seekBy(-10),
    ArrowRight: () => seekBy(30),
    ArrowUp: () => cmd('add', 'volume', 5),
    ArrowDown: () => cmd('add', 'volume', -5),
    f: () => host.win.fullscreen(),
    m: () => cmd('cycle', 'mute'),
    a: () => cmd('cycle', 'audio'),
    c: () => cmd('cycle', 'sub'),
    n: () => cmd('script-message', 'lumen-next'),
    s: () => cmd('script-message', 'lumen-skip'),
    Escape: () => { if (!menu.hidden) menu.hidden = true; else mpv.stop(); },
  }[k];
  if (!map) return;
  e.preventDefault();
  map();
  poke();
});

poke();
