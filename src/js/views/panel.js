// Panel: a read-only look at the server for administrators. Who is watching what right now (refreshed
// every few seconds), how loaded the NAS is, the library, users, friends' ratings and recommendations,
// and the server's recent activity. Nothing here changes anything.
import { h, episodeLabel, image } from '../ui.js';
import { ctx } from '../context.js';
import { social, configured, waitForSocial } from '../social.js';
import { watchedSection } from './panel-watched.js';
import { backdropSrc, posterSrc, thumbSrc } from '../media.js';
import { posterCard, rowOf } from '../cards.js';
import { icons } from '../icons.js';

const LIVE_MS = 5000;

export async function panelView({ isStale }) {
  const api = ctx.api;
  if (!ctx.user?.Policy?.IsAdministrator) {
    return h('div', { class: 'page panel' }, h('h1', null, 'Panel'), h('p', { class: 'muted' }, 'El panel solo está disponible para administradores del servidor.'));
  }

  const live = h('div', { class: 'panel-live' });
  const nas = h('div', { class: 'panel-tiles' });
  const library = h('div', { class: 'panel-tiles' });
  const usersBox = h('div', { class: 'panel-card' });
  const friends = h('div', { class: 'panel-friends' });
  const watchedBox = h('div');
  const activity = h('div', { class: 'panel-card' });

  // Header over the backdrop of whatever is playing right now (Apple TV style); dark when nothing is.
  const stageBg = h('div', { class: 'panel-stage-bg' });
  const headSub = h('p', { class: 'panel-head-sub' }, ctx.server?.name || '');
  const page = h('div', { class: 'page panel' },
    h('div', { class: 'panel-stage' }, stageBg, h('div', { class: 'panel-stage-shade' }),
      h('div', { class: 'panel-head' }, h('h1', null, 'Panel'), headSub)),
    section('Ahora mismo', live),
    section('Lo que se ha visto', watchedBox),
    section('NAS', nas),
    section('Biblioteca', library),
    section('Usuarios', usersBox),
    section('Amigos', friends),
    section('Actividad reciente', activity));

  // The friends service (NAS figures, ratings) may still be starting: say so and keep waiting.
  const waiting = (text) => h('p', { class: 'friends-status' }, h('span', { class: 'mini-spinner' }), text);
  nas.replaceChildren(waiting('Conectando con el servicio de amigos…'));
  friends.replaceChildren(waiting('Conectando con el servicio de amigos…'));

  // Live part: sessions every 5 s, the NAS figures every 15 s (only while the page is visible).
  let stats = null;
  let userList = null; // painted again when the friends figures arrive
  let socialReady = false;
  let ticks = 0;
  const loadStats = () => social.stats().then((st) => {
    if (isStale()) return;
    const first = !stats;
    stats = st;
    paintNas(nas, stats);
    if (first) {
      if (userList) paintUsers(usersBox, userList, stats);
      paintFriends(friends, stats).catch((e) => friends.replaceChildren(h('p', { class: 'muted' }, e.message)));
    }
  }).catch((e) => {
    if (isStale() || stats) return;
    paintNas(nas, null, e);
    friends.replaceChildren(h('p', { class: 'muted' }, e.message));
  });
  const refresh = async () => {
    if (document.hidden) return;
    if (socialReady && ticks++ % 3 === 0) loadStats();
    const sessions = await api.req('/Sessions', { fresh: true, quiet: true, query: { ActiveWithinSeconds: 960 } }).catch(() => null);
    if (isStale()) return;
    paintLive(live, sessions);
    paintStage(stageBg, sessions);
  };
  const timer = setInterval(refresh, LIVE_MS);
  await refresh();

  waitForSocial({
    isStale, maxMs: 15 * 60 * 1000,
    onWaiting: () => {
      if (isStale()) return;
      nas.replaceChildren(waiting('Arrancando el servicio de amigos… en cuanto conteste aparecen aquí la carga del NAS y las notas.'));
      friends.replaceChildren(waiting('Arrancando el servicio de amigos…'));
    },
  }).then((url) => {
    if (isStale()) return;
    if (!url) {
      const msg = configured()
        ? 'El servicio de amigos no ha contestado en 15 minutos. Comprueba que está encendido en el NAS.'
        : 'No se encuentra el servicio de amigos. Pon su dirección en Ajustes → Amigos.';
      nas.replaceChildren(h('p', { class: 'muted' }, msg));
      friends.replaceChildren(h('p', { class: 'muted' }, msg));
      return;
    }
    socialReady = true;
    ticks = 1;
    loadStats();
  });

  // The rest once.
  Promise.allSettled([
    api.req('/Items/Counts', { query: { userId: api.userId } }),
    api.req('/System/Info'),
    api.req('/Users'),
    api.req('/System/ActivityLog/Entries', { fresh: true, query: { limit: 25 } }),
  ]).then(([counts, info, users, log]) => {
    if (isStale()) return;
    const val = (r) => (r.status === 'fulfilled' ? r.value : null);
    const si = val(info);
    if (si) headSub.textContent = `${si.ServerName}  ·  Jellyfin ${si.Version}`;
    paintLibrary(library, val(counts), si);
    userList = val(users);
    paintUsers(usersBox, userList, stats);
    paintActivity(activity, val(log));
    watchedBox.replaceChildren(userList ? watchedSection(userList) : h('p', { class: 'muted' }, 'No se pudo leer la lista de usuarios.'));
  });

  return { node: page, cleanup: () => { clearInterval(timer); document.querySelector('.wv-tip')?.remove(); } };
}

function section(title, body) {
  return h('section', { class: 'panel-section' }, h('h2', null, title), body);
}

// ---------- now playing ----------
// Big 16:9 cards like "Seguir viendo": the picture, who is watching over it, the progress bar, and
// under it what and how (direct or converted).
let liveKey = '';
function paintLive(box, sessions) {
  if (!sessions) { box.replaceChildren(h('p', { class: 'muted' }, 'No se pudo consultar el servidor.')); liveKey = ''; return; }
  const playing = sessions.filter((s) => s.NowPlayingItem);
  const idle = sessions.filter((s) => !s.NowPlayingItem && s.UserName);
  const api = ctx.api;
  // Same people watching the same things: only move the bars, so the pictures don't flash every 5 s.
  const key = playing.map((s) => `${s.Id}:${s.NowPlayingItem.Id}`).join('|') + `#${idle.length}`;
  if (key === liveKey && box.querySelector('.panel-now')) {
    for (const s of playing) {
      const card = box.querySelector(`[data-session="${CSS.escape(s.Id)}"]`);
      if (card) fillNow(card, s);
    }
    return;
  }
  liveKey = key;
  const cards = playing.map((s) => {
    const it = s.NowPlayingItem;
    const card = h('a', { class: 'card card-thumb panel-now', href: `#/item/${it.Type === 'Episode' && it.SeriesId ? it.SeriesId : it.Id}`, dataset: { session: s.Id } },
      h('div', { class: 'card-art' },
        image(thumbSrc(api, it, 640) || backdropSrc(api, it, 640), { placeholder: it.Name }),
        h('div', { class: 'panel-now-shade' }),
        h('div', { class: 'panel-now-who' }, userAvatar(s.UserId, s.UserName, s.UserPrimaryImageTag), h('span', null, s.UserName), h('span', { class: 'panel-tag pause-tag' }, 'En pausa')),
        h('div', { class: 'progress' }, h('div', { class: 'panel-now-bar' }))),
      h('div', { class: 'card-title' }, it.Type === 'Episode' ? it.SeriesName : it.Name),
      h('div', { class: 'card-sub panel-now-sub' }));
    fillNow(card, s);
    return card;
  });
  box.replaceChildren(...[
    cards.length ? h('div', { class: 'row-body' }, h('div', { class: 'row-track row-thumb' }, cards)) : h('p', { class: 'muted' }, 'Nadie está viendo nada ahora mismo.'),
    idle.length ? h('p', { class: 'muted small panel-idle' }, `Conectados sin reproducir: ${[...new Set(idle.map((s) => s.UserName))].join(', ')}`) : null,
  ].filter(Boolean));
}

function fillNow(card, s) {
  const it = s.NowPlayingItem;
  const ps = s.PlayState || {};
  const pct = it.RunTimeTicks ? Math.min(100, (ps.PositionTicks || 0) / it.RunTimeTicks * 100) : 0;
  const t = s.TranscodingInfo;
  let how = 'Directo';
  if (ps.PlayMethod === 'Transcode' && t) {
    how = t.IsVideoDirect ? 'Convirtiendo el audio' : 'Convirtiendo la imagen';
    const why = (t.TranscodeReasons || []).map(reason).filter(Boolean)[0];
    if (why) how += ` · ${why}`;
  } else if (ps.PlayMethod === 'DirectStream') how = 'Directo (reempaquetado)';
  card.querySelector('.panel-now-bar').style.width = `${Math.max(2, pct)}%`;
  card.querySelector('.pause-tag').hidden = !ps.IsPaused;
  card.querySelector('.panel-now-sub').replaceChildren(
    h('span', null, `${it.Type === 'Episode' ? `${episodeLabel(it)}  ·  ` : ''}${fmtClock(ps.PositionTicks)} de ${fmtClock(it.RunTimeTicks)}`),
    h('span', { class: 'panel-now-device' },
      h('span', { class: how.startsWith('Directo') ? 'ok' : 'warn' }, how),
      `  ·  ${s.Client || ''}${s.DeviceName ? ` · ${s.DeviceName}` : ''}`));
}

// Behind the title: the backdrop of the first thing playing, cross-faded when it changes.
function paintStage(bg, sessions) {
  const it = sessions?.find((s) => s.NowPlayingItem)?.NowPlayingItem;
  const src = it ? backdropSrc(ctx.api, it, 1920) : null;
  if ((bg.dataset.src || '') === (src || '')) return;
  bg.dataset.src = src || '';
  const old = [...bg.children];
  if (!src) { old.forEach((l) => l.classList.remove('on')); return; }
  const img = h('img', { alt: '', decoding: 'async', src });
  img.addEventListener('load', () => { img.classList.add('on'); setTimeout(() => old.forEach((l) => l.remove()), 1200); });
  bg.append(img);
}

function userAvatar(id, name, tag) {
  return tag
    ? h('img', { class: 'panel-avatar', alt: '', src: ctx.api.buildUrl(`/Users/${id}/Images/Primary`, { fillWidth: 56, quality: 90, tag }) })
    : h('span', { class: 'panel-avatar letter' }, (name || '?')[0].toUpperCase());
}

function reason(r) {
  return {
    ContainerNotSupported: 'formato no compatible',
    VideoCodecNotSupported: 'vídeo no compatible',
    AudioCodecNotSupported: 'audio no compatible',
    SubtitleCodecNotSupported: 'subtítulos incrustados',
    ContainerBitrateExceedsLimit: 'calidad limitada',
    VideoBitrateNotSupported: 'calidad limitada',
    AudioChannelsNotSupported: 'canales de audio',
    VideoRangeTypeNotSupported: 'HDR no compatible',
  }[r] || '';
}

function fmtClock(ticks) {
  if (!ticks) return '0:00';
  const s = Math.floor(ticks / 1e7);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  return hh ? `${hh}:${String(mm).padStart(2, '0')}` : `${mm}:${String(s % 60).padStart(2, '0')}`;
}

// ---------- NAS ----------
function paintNas(box, stats, err) {
  if (!stats) {
    box.replaceChildren(h('p', { class: 'muted' }, err?.offline ? 'El servicio de amigos todavía no contesta.' : `No se pudo leer: ${err?.message || ''}`));
    return;
  }
  const s = stats.system;
  const cpu = Math.min(100, Math.round((s.load[0] / s.cpus) * 100));
  const mem = Math.round((1 - s.memAvailable / s.memTotal) * 100);
  const tiles = [
    tile('Procesador', `${cpu}%`, `carga ${s.load.map((x) => x.toFixed(2)).join(' · ')} · ${s.cpus} núcleos`, cpu),
    tile('Memoria', `${mem}%`, `${gb(s.memTotal - s.memAvailable)} de ${gb(s.memTotal)}`, mem),
  ];
  if (s.disk) {
    const used = Math.round((1 - s.disk.free / s.disk.total) * 100);
    tiles.push(tile('Disco', `${used}%`, `libres ${gb(s.disk.free)} de ${gb(s.disk.total)}`, used));
  }
  tiles.push(tile('Encendido', uptime(s.uptime), 'desde el último reinicio'));
  box.replaceChildren(...tiles);
}

function tile(label, value, sub, pct) {
  return h('div', { class: 'panel-tile' },
    h('div', { class: 'panel-tile-label' }, label),
    h('div', { class: 'panel-tile-value' }, value),
    pct != null ? h('div', { class: `panel-meter ${pct >= 90 ? 'high' : pct >= 70 ? 'mid' : ''}` }, h('div', { style: { width: `${pct}%` } })) : null,
    sub ? h('div', { class: 'muted small' }, sub) : null);
}

const gb = (b) => (b >= 1e12 ? `${(b / 1e12).toFixed(1)} TB` : `${(b / 1e9).toFixed(1)} GB`).replace('.', ',');
function uptime(sec) {
  const d = Math.floor(sec / 86400);
  const hrs = Math.floor((sec % 86400) / 3600);
  return d ? `${d} d ${hrs} h` : `${hrs} h ${Math.floor((sec % 3600) / 60)} min`;
}

// ---------- library ----------
function paintLibrary(box, counts, info) {
  const n = (x) => (x || 0).toLocaleString('es-ES');
  box.replaceChildren(...[
    counts ? tile('Películas', n(counts.MovieCount)) : null,
    counts ? tile('Series', n(counts.SeriesCount), `${n(counts.EpisodeCount)} episodios`) : null,
    info ? tile('Jellyfin', info.Version, info.ServerName) : null,
  ].filter(Boolean));
}

// ---------- users ----------
function paintUsers(box, users, stats) {
  if (!users) { box.replaceChildren(h('p', { class: 'muted' }, 'No se pudo leer la lista de usuarios.')); return; }
  const social = new Map((stats?.perUser || []).map((u) => [u.name, u]));
  const rows = [...users].sort((a, b) => String(b.LastActivityDate || '').localeCompare(String(a.LastActivityDate || ''))).map((u) => {
    const s = social.get(u.Name);
    return h('tr', null,
      h('td', null, h('span', { class: 'panel-user' }, userAvatar(u.Id, u.Name, u.PrimaryImageTag), u.Name,
        u.Policy?.IsAdministrator ? h('span', { class: 'panel-tag' }, 'admin') : null, u.Policy?.IsDisabled ? h('span', { class: 'panel-tag' }, 'desactivado') : null)),
      h('td', { class: 'muted' }, u.LastActivityDate ? ago(u.LastActivityDate) : 'nunca'),
      h('td', null, s?.ratings || '–'),
      h('td', null, s ? `${s.sent} / ${s.received}` : '–'),
      h('td', null, s?.watchlist || '–'));
  });
  box.replaceChildren(h('div', { class: 'panel-table-wrap' }, h('table', { class: 'panel-table' },
    h('thead', null, h('tr', null, ['Usuario', 'Última actividad', 'Notas', 'Recom. enviadas / recibidas', 'Tengo que verla'].map((t) => h('th', null, t)))),
    h('tbody', null, rows))));
}

// ---------- friends ----------
async function paintFriends(box, s) {
  const ids = [...new Set([...s.topRated.map((r) => r.itemId), ...s.recentRatings.map((r) => r.itemId), ...s.recentRecommendations.map((r) => r.itemId)])];
  const byId = new Map();
  if (ids.length) {
    const r = await ctx.api.items({ Ids: ids.join(','), Recursive: true }).catch(() => ({ Items: [] }));
    for (const it of r.Items || []) byId.set(it.Id.replace(/-/g, '').toLowerCase(), it);
  }
  const nameOf = (id) => byId.get(id)?.Name || 'Título borrado';
  const link = (id) => (byId.has(id) ? h('a', { href: `#/item/${byId.get(id).Id}` }, nameOf(id)) : nameOf(id));

  const totals = h('div', { class: 'panel-tiles' },
    s.totals.requests != null ? h('a', { href: '#/requests', class: 'panel-tile-link' }, tile('Peticiones', String(s.totals.requests), s.totals.requests ? 'esperando a que las añadas' : 'ninguna pendiente')) : null,
    tile('Notas', String(s.totals.ratings), `en ${s.totals.rated} títulos`),
    tile('Recomendaciones', String(s.totals.recommendations)),
    tile('En «Tengo que verla»', String(s.totals.watchlist)));

  // Best rated: real poster cards in a row, with the friends' average over the corner.
  const top = s.topRated.filter((r) => byId.has(r.itemId));
  const topRow = top.length
    ? rowOf('Mejor valoradas', top.map((r) => {
      const card = posterCard(byId.get(r.itemId));
      card.querySelector('.card-art')?.append(h('span', { class: 'panel-score' }, h('span', { html: icons.star }), r.average.toLocaleString('es-ES')));
      const sub = card.querySelector('.card-sub') || card.appendChild(h('div', { class: 'card-sub' }));
      sub.textContent = `${r.count} ${r.count === 1 ? 'nota' : 'notas'}`;
      return card;
    }), { cls: 'panel-row' })
    : h('p', { class: 'muted' }, 'Todavía nadie ha puntuado nada.');

  const thumb = (id) => (byId.has(id) ? image(posterSrc(ctx.api, byId.get(id), 80), { cls: 'panel-list-art', placeholder: '' }) : h('span', { class: 'panel-list-art' }));
  const list = (items, empty) => (items.length ? h('ul', { class: 'panel-list' }, items) : h('p', { class: 'muted' }, empty));
  box.replaceChildren(
    totals,
    topRow,
    h('div', { class: 'panel-columns' },
      h('div', { class: 'panel-card' }, h('h3', null, 'Últimas notas'),
        list(s.recentRatings.map((r) => h('li', { class: 'with-art' }, thumb(r.itemId), h('div', null, h('b', null, r.user), ' le ha puesto ', h('span', { class: 'panel-stars' }, '★'.repeat(r.score) + '☆'.repeat(5 - r.score)), ' a ', link(r.itemId), h('span', { class: 'muted small' }, ` · ${ago(r.at)}`)))), 'Sin notas todavía.')),
      h('div', { class: 'panel-card' }, h('h3', null, 'Últimas recomendaciones'),
        list(s.recentRecommendations.map((r) => h('li', { class: 'with-art' }, thumb(r.itemId), h('div', null, h('b', null, r.from), ' → ', h('b', null, r.to), ': ', link(r.itemId),
          r.note ? h('span', { class: 'muted' }, ` «${r.note}»`) : null,
          h('span', { class: 'muted small' }, ` · ${ago(r.at)}${r.dismissed ? ' · vista o descartada' : ''}`)))), 'Nadie ha recomendado nada todavía.'))));
}

// ---------- activity ----------
function paintActivity(box, log) {
  const items = log?.Items || [];
  if (!items.length) { box.replaceChildren(h('p', { class: 'muted' }, log ? 'Sin actividad reciente.' : 'No se pudo leer la actividad.')); return; }
  box.replaceChildren(h('ul', { class: 'panel-list activity' }, items.map((e) => h('li', { class: e.Severity === 'Error' || e.Severity === 'Warning' ? 'warn' : '' },
    h('span', { class: 'panel-dot' }), h('span', null, e.Name, h('span', { class: 'muted small' }, ` · ${ago(e.Date)}`))))));
}

function ago(date) {
  const s = Math.max(0, (Date.now() - new Date(date).getTime()) / 1000);
  if (s < 60) return 'ahora';
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  if (s < 86400 * 30) return `hace ${Math.floor(s / 86400)} d`;
  return new Date(date).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
}
