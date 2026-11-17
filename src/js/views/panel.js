// Panel: a read-only look at the server for administrators. Who is watching what right now (refreshed
// every few seconds), how loaded the NAS is, the library, users, friends' ratings and recommendations,
// and the server's recent activity. Nothing here changes anything.
import { h, episodeLabel, image } from '../ui.js';
import { ctx } from '../context.js';
import { social } from '../social.js';
import { posterSrc, thumbSrc } from '../media.js';
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
  const activity = h('div', { class: 'panel-card' });

  const page = h('div', { class: 'page panel' },
    h('h1', null, 'Panel'),
    section('Ahora mismo', live),
    section('NAS', nas),
    section('Biblioteca', library),
    section('Usuarios', usersBox),
    section('Amigos', friends),
    section('Actividad reciente', activity));

  // Live part: sessions every 5 s, the NAS figures every 15 s (only while the page is visible).
  let stats = null;
  let userList = null; // painted again when the friends figures arrive
  let ticks = 0;
  const refresh = async () => {
    if (document.hidden) return;
    const [sessions, st] = await Promise.allSettled([
      api.req('/Sessions', { fresh: true, quiet: true, query: { ActiveWithinSeconds: 960 } }),
      ticks++ % 3 === 0 ? social.stats() : Promise.resolve(stats),
    ]);
    if (isStale()) return;
    paintLive(live, sessions.status === 'fulfilled' ? sessions.value : null);
    if (st.status === 'fulfilled' && st.value) {
      const first = !stats;
      stats = st.value;
      paintNas(nas, stats);
      if (first && userList) paintUsers(usersBox, userList, stats);
    }
    else if (!stats) paintNas(nas, null, st.reason);
  };
  const timer = setInterval(refresh, LIVE_MS);
  await refresh();

  // The rest once.
  Promise.allSettled([
    api.req('/Items/Counts', { query: { userId: api.userId } }),
    api.req('/System/Info'),
    api.req('/Users'),
    api.req('/System/ActivityLog/Entries', { fresh: true, query: { limit: 25 } }),
  ]).then(([counts, info, users, log]) => {
    if (isStale()) return;
    const val = (r) => (r.status === 'fulfilled' ? r.value : null);
    paintLibrary(library, val(counts), val(info));
    userList = val(users);
    paintUsers(usersBox, userList, stats);
    paintActivity(activity, val(log));
  });
  // Friends needs item names: after stats has arrived.
  (stats ? Promise.resolve(stats) : social.stats()).then((s) => paintFriends(friends, s)).catch((e) => {
    friends.replaceChildren(h('p', { class: 'muted' }, e.offline ? 'El servicio de amigos no está disponible.' : e.message));
  });

  return { node: page, cleanup: () => clearInterval(timer) };
}

function section(title, body) {
  return h('section', { class: 'panel-section' }, h('h2', null, title), body);
}

// ---------- now playing ----------
function paintLive(box, sessions) {
  if (!sessions) { box.replaceChildren(h('p', { class: 'muted' }, 'No se pudo consultar el servidor.')); return; }
  const playing = sessions.filter((s) => s.NowPlayingItem);
  const idle = sessions.filter((s) => !s.NowPlayingItem && s.UserName);
  const api = ctx.api;
  const cards = playing.map((s) => {
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
    const title = it.Type === 'Episode' ? `${it.SeriesName} · ${episodeLabel(it)}` : it.Name;
    return h('a', { class: 'panel-session', href: `#/item/${it.Type === 'Episode' && it.SeriesId ? it.SeriesId : it.Id}` },
      image(it.Type === 'Episode' ? thumbSrc(api, it, 400) : posterSrc(api, it, 200), { cls: it.Type === 'Episode' ? 'panel-thumb wide' : 'panel-thumb', placeholder: it.Name }),
      h('div', { class: 'panel-session-text' },
        h('div', { class: 'panel-session-user' }, s.UserName, ps.IsPaused ? h('span', { class: 'panel-tag' }, 'En pausa') : null),
        h('div', { class: 'panel-session-title' }, title),
        h('div', { class: 'muted small' }, `${s.Client || ''} · ${s.DeviceName || ''}`),
        h('div', { class: 'progress panel-progress' }, h('div', { style: { width: `${pct}%` } })),
        h('div', { class: 'muted small' }, `${fmtClock(ps.PositionTicks)} de ${fmtClock(it.RunTimeTicks)} · `, h('span', { class: how === 'Directo' ? 'ok' : 'warn' }, how))));
  });
  box.replaceChildren(...[
    cards.length ? h('div', { class: 'panel-sessions' }, cards) : h('p', { class: 'muted' }, 'Nadie está viendo nada ahora mismo.'),
    idle.length ? h('p', { class: 'muted small' }, `Conectados sin reproducir: ${[...new Set(idle.map((s) => s.UserName))].join(', ')}`) : null,
  ].filter(Boolean));
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
    box.replaceChildren(h('p', { class: 'muted' }, err?.offline ? 'Para ver la carga del NAS hace falta el servicio de amigos.' : `No se pudo leer: ${err?.message || ''}`));
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
      h('td', null, u.Name, u.Policy?.IsAdministrator ? h('span', { class: 'panel-tag' }, 'admin') : null, u.Policy?.IsDisabled ? h('span', { class: 'panel-tag' }, 'desactivado') : null),
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
    tile('Notas', String(s.totals.ratings), `en ${s.totals.rated} títulos`),
    tile('Recomendaciones', String(s.totals.recommendations)),
    tile('En «Tengo que verla»', String(s.totals.watchlist)));

  const top = s.topRated.filter((r) => byId.has(r.itemId));
  const topRow = top.length ? h('div', { class: 'panel-top' }, top.map((r) => {
    const it = byId.get(r.itemId);
    return h('a', { class: 'panel-top-item', href: `#/item/${it.Id}`, title: it.Name },
      image(posterSrc(ctx.api, it, 200), { cls: 'panel-thumb', placeholder: it.Name }),
      h('div', { class: 'panel-top-score' }, h('span', { html: icons.star }), r.average.toLocaleString('es-ES'), h('span', { class: 'muted' }, ` · ${r.count}`)),
      h('div', { class: 'panel-top-name' }, it.Name));
  })) : h('p', { class: 'muted' }, 'Todavía nadie ha puntuado nada.');

  const list = (items, empty) => (items.length ? h('ul', { class: 'panel-list' }, items) : h('p', { class: 'muted' }, empty));
  box.replaceChildren(
    totals,
    h('h3', null, 'Mejor valoradas'),
    topRow,
    h('div', { class: 'panel-columns' },
      h('div', { class: 'panel-card' }, h('h3', null, 'Últimas notas'),
        list(s.recentRatings.map((r) => h('li', null, h('b', null, r.user), ' le ha puesto ', h('span', { class: 'panel-stars' }, '★'.repeat(r.score) + '☆'.repeat(5 - r.score)), ' a ', link(r.itemId), h('span', { class: 'muted small' }, ` · ${ago(r.at)}`))), 'Sin notas todavía.')),
      h('div', { class: 'panel-card' }, h('h3', null, 'Últimas recomendaciones'),
        list(s.recentRecommendations.map((r) => h('li', null, h('b', null, r.from), ' → ', h('b', null, r.to), ': ', link(r.itemId),
          r.note ? h('span', { class: 'muted' }, ` «${r.note}»`) : null,
          h('span', { class: 'muted small' }, ` · ${ago(r.at)}${r.dismissed ? ' · vista o descartada' : ''}`))), 'Nadie ha recomendado nada todavía.'))));
}

// ---------- activity ----------
function paintActivity(box, log) {
  const items = log?.Items || [];
  if (!items.length) { box.replaceChildren(h('p', { class: 'muted' }, log ? 'Sin actividad reciente.' : 'No se pudo leer la actividad.')); return; }
  box.replaceChildren(h('ul', { class: 'panel-list' }, items.map((e) => h('li', { class: e.Severity === 'Error' || e.Severity === 'Warning' ? 'warn' : '' },
    e.Name, h('span', { class: 'muted small' }, ` · ${ago(e.Date)}`)))));
}

function ago(date) {
  const s = Math.max(0, (Date.now() - new Date(date).getTime()) / 1000);
  if (s < 60) return 'ahora';
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  if (s < 86400 * 30) return `hace ${Math.floor(s / 86400)} d`;
  return new Date(date).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
}
