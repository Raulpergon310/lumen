import { IS_TV } from './tv.js';
import { startTvPlayback } from './tv-player.js';
import { store, log } from './store.js';
import { Api, findReachable } from './api.js';
import { ctx } from './context.js';
import { h, toast, spinner, button } from './ui.js';
import { renderNav, updateNav } from './nav.js';
import { connectView } from './views/connect.js';
import { homeView } from './views/home.js';
import { itemView } from './views/item.js';
import { libraryView } from './views/library.js';
import { searchView } from './views/search.js';
import { personView } from './views/person.js';
import { settingsView } from './views/settings.js';
import { playbackPlan } from './compat.js';
import { chooseSubtitle, fetchSpanishSubtitles } from './subs.js';

// In a plain browser (the web version) there are no window buttons to leave room for.
if (!window.lumenHost && !window.LumenTV) document.documentElement.classList.add('web');

const viewRoot = document.getElementById('view');
const nav = document.getElementById('nav');

const routes = [
  [/^\/home$/, homeView],
  [/^\/item\/([^/]+)$/, itemView],
  [/^\/library\/([^/]+)$/, libraryView],
  [/^\/search$/, searchView],
  [/^\/person\/([^/]+)$/, personView],
  [/^\/settings$/, settingsView],
];

// ---------- errors never leave a blank screen ----------
window.addEventListener('error', (e) => {
  log(`error: ${e.message} @ ${e.filename}:${e.lineno}`);
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason?.message || String(e.reason);
  log(`unhandledrejection: ${msg}`);
  toast(msg, 'error');
});

function hideBoot() {
  document.getElementById('boot')?.classList.add('gone');
}

// ---------- sessions ----------
export function savedServers() {
  return store.get('servers', []);
}

function activeServer() {
  const id = store.get('activeServer');
  return savedServers().find((s) => s.id === id && s.token) || null;
}

export function saveServer(entry) {
  const list = savedServers().filter((s) => s.id !== entry.id);
  list.unshift(entry);
  store.set('servers', list);
  store.set('activeServer', entry.id);
}

export async function signOut({ forget = false } = {}) {
  const s = activeServer();
  await ctx.player?.close?.();
  if (ctx.api) await ctx.api.logout();
  if (s) {
    const list = savedServers()
      .map((x) => (x.id === s.id ? { ...x, token: null } : x))
      .filter((x) => !(forget && x.id === s.id));
    store.set('servers', list);
  }
  store.set('activeServer', undefined);
  ctx.api = null;
  showConnect({ serverId: forget ? null : s?.id });
}

export function showConnect(opts = {}) {
  nav.hidden = true;
  window.removeEventListener('hashchange', onRoute);
  hideBoot();
  viewRoot.replaceChildren(connectView({
    ...opts,
    deviceId: store.get('deviceId'),
    onDone: (entry) => {
      saveServer(entry);
      history.replaceState(null, '', '#/home');
      start();
    },
  }));
}

function showOffline(server, err) {
  hideBoot();
  nav.hidden = true;
  let seconds = 10;
  const counter = h('span', null, `. Reintentando en ${seconds} s…`);
  const retry = () => { clearInterval(timer); start(); };
  const timer = setInterval(() => {
    seconds -= 1;
    counter.textContent = `. Reintentando en ${seconds} s…`;
    if (seconds <= 0) retry();
  }, 1000);
  viewRoot.replaceChildren(h('div', { class: 'fullscreen-card' },
    h('div', { class: 'glass-card' },
      h('div', { class: 'card-eyebrow' }, server.name || 'Servidor'),
      h('h1', null, 'No se puede conectar'),
      h('p', { class: 'muted' }, err.message, counter),
      h('p', { class: 'muted small' }, server.urls.join('  ·  ')),
      h('div', { class: 'actions' },
        button('Reintentar ahora', { kind: 'primary', icon: 'refresh', onclick: retry }),
        button('Cambiar de servidor', { onclick: () => { clearInterval(timer); showConnect({ serverId: server.id }); } })))));
}

let started = false;

async function start() {
  const server = activeServer();
  if (!server) return showConnect();

  viewRoot.replaceChildren(spinner());
  let reach;
  try {
    reach = await findReachable(server.urls, 6000);
  } catch (e) {
    return showOffline(server, e);
  }

  const api = new Api({ url: reach.url, token: server.token, userId: server.userId, deviceId: store.get('deviceId') });
  let lastSlowWarning = 0;
  api.onNetworkError = () => {
    if (Date.now() - lastSlowWarning < 30000) return;
    lastSlowWarning = Date.now();
    toast('El servidor no responde. Puede estar saturado o reiniciándose.', 'error');
  };
  // After playback the server's new position arrives: update the page in place.
  api.onDataChanged = () => { if (!ctx.player) ctx.refresh({ quiet: true }); };
  api.onUnauthorized = () => {
    if (ctx.api !== api) return;
    ctx.api = null;
    toast('La sesión ha caducado. Vuelve a iniciar sesión.', 'error');
    const list = savedServers().map((x) => (x.id === server.id ? { ...x, token: null } : x));
    store.set('servers', list);
    showConnect({ serverId: server.id });
  };

  try {
    ctx.user = await api.me();
  } catch (e) {
    if (e.status === 401) return;
    return showOffline(server, e);
  }

  ctx.api = api;
  ctx.server = { ...server, name: reach.info.ServerName || server.name, url: reach.url, version: reach.info.Version };
  ctx.views = await api.views().catch(() => []);

  renderNav(nav);
  nav.hidden = false;
  hideBoot();
  if (!started) {
    started = true;
    window.addEventListener('scroll', () => nav.classList.toggle('scrolled', window.scrollY > 24), { passive: true });
  }
  window.removeEventListener('hashchange', onRoute);
  window.addEventListener('hashchange', onRoute);
  if (!location.hash || location.hash === '#' || location.hash.startsWith('#/connect')) location.replace('#/home');
  onRoute();
}

// ---------- router ----------
const scrollMemory = new Map();
let currentKey = null;
let navToken = 0;
let cleanup = null;

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/home';
  const [path, qs] = raw.split('?');
  return { path, query: Object.fromEntries(new URLSearchParams(qs || '')) , key: raw };
}

// quiet: re-render in place (after playback) without a spinner or jumping to the top.
async function onRoute({ quiet = false } = {}) {
  if (!ctx.api) return;
  const { path, query, key } = parseHash();
  if (currentKey) scrollMemory.set(currentKey, window.scrollY);
  currentKey = key;

  let match = null;
  let view = null;
  for (const [re, fn] of routes) {
    match = path.match(re);
    if (match) { view = fn; break; }
  }
  if (!view) return location.replace('#/home');

  const token = ++navToken;
  try { cleanup?.(); } catch {}
  cleanup = null;
  updateNav(nav, path);
  // Only show a spinner if the page is actually slow; cached pages appear without flashing.
  const spinTimer = quiet ? null : setTimeout(() => { if (token === navToken) viewRoot.replaceChildren(spinner()); }, 180);
  if (!quiet) window.scrollTo(0, 0);

  const isStale = () => token !== navToken;
  try {
    const result = await view({ params: match.slice(1), query, isStale });
    clearTimeout(spinTimer);
    if (isStale()) return;
    const node = result?.node || result;
    cleanup = result?.cleanup || null;
    viewRoot.replaceChildren(node);
    const y = scrollMemory.get(key);
    if (y) requestAnimationFrame(() => window.scrollTo(0, y));
  } catch (e) {
    clearTimeout(spinTimer);
    if (isStale() || e.status === 401) return;
    if (quiet) return;
    log(`view ${path}: ${e.stack || e.message}`);
    viewRoot.replaceChildren(h('div', { class: 'fullscreen-card' },
      h('div', { class: 'glass-card' },
        h('h1', null, 'Algo ha fallado'),
        h('p', { class: 'muted' }, e.message || String(e)),
        h('div', { class: 'actions' },
          button('Reintentar', { kind: 'primary', icon: 'refresh', onclick: () => onRoute() }),
          button('Ir al inicio', { onclick: () => { location.hash = '#/home'; } })))));
  }
}

ctx.refresh = ({ quiet = false } = {}) => {
  if (currentKey) scrollMemory.set(currentKey, window.scrollY);
  onRoute({ quiet });
};

// 'auto': files the app plays as-is stay in the built-in player; everything else (HDR, Dolby Vision,
// Dolby Digital/DTS/TrueHD audio, other audio tracks…) plays the original file in mpv inside the
// window — faster to start than a server conversion and no load on the NAS.
ctx.play = async (item, opts = {}) => {
  // Instant feedback while the file info arrives.
  const root = document.getElementById('player-root');
  if (!root.firstChild) root.replaceChildren(h('div', { class: 'launching' }, h('div', { class: 'spinner' })));
  const clearLaunching = () => root.querySelector(':scope > .launching')?.remove();
  // A busy server can take long to answer: say so, and let Back/Esc give up (ctx.launch.cancelled).
  const launch = (ctx.launch = { cancelled: false });
  const slow = setTimeout(() => {
    root.querySelector(':scope > .launching')?.append(h('p', { class: 'launching-msg' }, 'El servidor está tardando en responder… (Atrás para cancelar)'));
  }, 8000);
  try {
    const result = await startPlayback(item, opts);
    if (launch.cancelled) await ctx.player?.close?.();
    return result;
  } finally {
    clearTimeout(slow);
    clearLaunching();
    if (ctx.launch === launch) ctx.launch = null;
  }
};

async function startPlayback(item, opts) {
  if (IS_TV) return startTvPlayback(item, opts);
  const { mpvAvailable, openMpv, probeInfo, forgetProbe } = await import('./mpv-player.js');
  const mode = store.get('player', 'auto');
  const hasMpv = await mpvAvailable();
  if (hasMpv && mode === 'mpv') return openMpv(item, opts);
  if (hasMpv && mode === 'auto') {
    let plan = { mode: 'direct' };
    let probe = null;
    let wantSubs = false;
    // No Spanish subtitles in the file: ask the server's providers, then add them to what's playing.
    const findSubs = () => { if (wantSubs) fetchSpanishSubtitles(item).then((sub) => sub && ctx.addSubtitle(item, sub)); };
    try {
      probe = await probeInfo(item);
      forgetProbe(item.Id);
      // Spanish subtitles whenever the audio isn't Spanish (decided before choosing the player,
      // since image subtitles change which player fits).
      const ms = probe?.MediaSources?.[0];
      const choice = chooseSubtitle(ms);
      if (ms && choice.index !== undefined) ms.DefaultSubtitleStreamIndex = choice.index;
      if (choice.missing) wantSubs = true;
      plan = playbackPlan(ms);
    } catch (e) {
      log(`probe ${item.Id}: ${e.message}`);
    }
    const embedded = store.get('mpvEmbedded', true);
    if (plan.mode === 'mpv' || (plan.mode === 'remux' && embedded)) {
      await openMpv(item, { ...opts, probe });
      findSubs();
      return;
    }
    const { openPlayer } = await import('./player.js');
    await openPlayer(item, { ...opts, plan, probe });
    findSubs();
    return;
  }
  const { openPlayer } = await import('./player.js');
  return openPlayer(item, opts);
}

// A subtitle found after playback started is added to whichever player is showing that item.
ctx.addSubtitle = async (item, sub) => {
  if (ctx.player?.item?.Id === item.Id) return ctx.player.addSubtitle(sub);
  const m = await import('./mpv-player.js');
  m.addSubtitleToSession(item, sub);
};

// Closing the window: stop any playback first so the server doesn't keep converting for nobody.
window.lumenHost?.onClosing(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const { stopMpvForExit } = await import('./mpv-player.js');
    await Promise.race([
      Promise.all([ctx.player?.close?.({ refresh: false }), stopMpvForExit()]),
      sleep(2000),
    ]);
  } catch {}
  window.lumenHost.canClose();
});

// A new version copied from the NAS: offer to restart now (otherwise it installs when the app closes).
window.lumenHost?.update?.onReady(({ version }) => {
  const banner = h('div', { class: 'update-banner glass' },
    h('div', null, h('strong', null, `Lumen ${version} está lista`), h('div', { class: 'muted small' }, 'Se instalará al cerrar la app, o ahora mismo:')),
    button('Reiniciar y actualizar', { kind: 'primary', onclick: () => window.lumenHost.update.install() }),
    h('button', { class: 'icon-btn', title: 'Más tarde', html: '&times;', onclick: () => banner.remove() }));
  document.body.append(banner);
});

ctx.signOut = signOut;
ctx.showConnect = showConnect;
ctx.savedServers = savedServers;

store.load();
start().catch((e) => {
  log('start: ' + (e.stack || e.message));
  showConnect();
});
