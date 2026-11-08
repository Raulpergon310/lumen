// New seasons: for the series you watch (and your favourites), compares the seasons on the server with
// the seasons already aired according to TVmaze (free, no key; found through the TVDB/IMDb ids Jellyfin
// keeps). A season that has aired and isn't on the server shows in a home row and on the series page,
// so you can go and get it. Checked at most every 12 hours, one series at a time.
import { h, button, toast } from './ui.js';
import { ctx } from './context.js';
import { store, log } from './store.js';
import { row } from './cards.js';

const TVMAZE = 'https://api.tvmaze.com';
const CHECK_MS = 12 * 3600 * 1000;
const MAX_SERIES = 60;

let running = null;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function fmtDate(d) {
  try { return new Date(d + 'T12:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return d; }
}

async function tvmaze(path) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(TVMAZE + path, { signal: ctl.signal });
    if (r.status === 404) return null;
    if (r.status === 429) { await new Promise((res) => setTimeout(res, 3000)); return tvmaze(path); }
    if (!r.ok) throw new Error(`TVmaze ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// Jellyfin series id -> TVmaze show id (0 = not on TVmaze, asked again after a month).
async function tvmazeId(series) {
  const ids = store.get('tvmazeIds', {});
  const known = ids[series.Id];
  if (known && (known.id || Date.now() - known.at < 30 * 24 * 3600 * 1000)) return known.id;
  const p = series.ProviderIds || {};
  let show = null;
  if (p.Tvdb) show = await tvmaze(`/lookup/shows?thetvdb=${encodeURIComponent(p.Tvdb)}`);
  if (!show && p.Imdb) show = await tvmaze(`/lookup/shows?imdb=${encodeURIComponent(p.Imdb)}`);
  const next = { ...store.get('tvmazeIds', {}), [series.Id]: { id: show?.id || 0, at: Date.now() } };
  store.set('tvmazeIds', next);
  return show?.id || 0;
}

async function runCheck() {
  const api = ctx.api;
  const bg = (q) => api.req('/Items', { background: true, timeout: 30000, query: { userId: api.userId, ...q } });
  const list = (r) => (r.status === 'fulfilled' && r.value ? r.value.Items || [] : []);

  // Series you are following: anything with a watched episode, most recent first, plus favourites.
  const [eps, favs] = await Promise.allSettled([
    bg({ Recursive: true, IncludeItemTypes: 'Episode', Filters: 'IsPlayed', SortBy: 'DatePlayed', SortOrder: 'Descending', Limit: 400, EnableImages: false }),
    bg({ Recursive: true, IncludeItemTypes: 'Series', Filters: 'IsFavorite', Limit: 50, EnableImages: false }),
  ]);
  const ids = [];
  for (const e of list(eps)) if (e.SeriesId && !ids.includes(e.SeriesId)) ids.push(e.SeriesId);
  for (const s of list(favs)) if (!ids.includes(s.Id)) ids.push(s.Id);
  if (!ids.length) return [];
  const chosen = ids.slice(0, MAX_SERIES);

  const [seriesR, seasonsR] = await Promise.allSettled([
    bg({ Ids: chosen.join(','), Fields: 'ProviderIds', EnableImages: false }),
    bg({ Recursive: true, IncludeItemTypes: 'Season', EnableImages: false, EnableUserData: false }),
  ]);
  const series = list(seriesR);
  const localMax = new Map();
  for (const s of list(seasonsR)) {
    if (!s.SeriesId || !(s.IndexNumber > 0)) continue;
    localMax.set(s.SeriesId, Math.max(localMax.get(s.SeriesId) || 0, s.IndexNumber));
  }

  const found = [];
  const now = today();
  for (const s of series) {
    const have = localMax.get(s.Id) || 0;
    if (!have) continue;
    try {
      const id = await tvmazeId(s);
      if (!id) continue;
      const seasons = await tvmaze(`/shows/${id}/seasons`);
      const aired = (seasons || []).filter((x) => x.number > 0 && x.premiereDate && x.premiereDate <= now);
      const newest = aired.reduce((m, x) => (x.number > m.number ? x : m), { number: 0 });
      if (newest.number > have) {
        const first = aired.find((x) => x.number === have + 1) || newest;
        found.push({
          id: s.Id,
          name: s.Name,
          from: have + 1,
          to: newest.number,
          premiere: first.premiereDate,
          airing: !newest.endDate || newest.endDate > now,
        });
      }
    } catch (e) {
      log(`tvmaze ${s.Name}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 350)); // TVmaze allows ~20 calls every 10 s
  }
  return found;
}

// The cached answer, refreshed in the background when it is older than 12 hours.
export function newSeasons({ force = false } = {}) {
  const serverId = store.get('activeServer');
  const cached = store.get('seasonCheck');
  const fresh = cached && cached.serverId === serverId && Date.now() - cached.at < CHECK_MS;
  if (fresh && !force) return Promise.resolve(visible(cached.found));
  if (!running) {
    running = runCheck()
      .then((found) => {
        store.set('seasonCheck', { at: Date.now(), serverId, found });
        return found;
      })
      .catch((e) => {
        log(`new seasons: ${e.message}`);
        return cached?.found || [];
      })
      .finally(() => { running = null; });
  }
  return running.then(visible);
}

function key(f) {
  return `${f.id}:${f.to}`;
}

function visible(found) {
  const hidden = store.get('seasonHidden', {});
  return (found || []).filter((f) => !hidden[key(f)]);
}

export function hideNewSeason(f) {
  store.set('seasonHidden', { ...store.get('seasonHidden', {}), [key(f)]: Date.now() });
}

function label(f) {
  const which = f.to > f.from ? `Temporadas ${f.from}–${f.to}` : `Temporada ${f.from}`;
  return `${which} · ${f.airing && f.to === f.from ? 'en emisión desde' : 'salió el'} ${fmtDate(f.premiere)}`;
}

// Home: row "Temporadas nuevas para descargar", in place of `slot`.
export async function newSeasonsRow(slot) {
  const api = ctx.api;
  const found = await newSeasons();
  if (!found.length || !slot.isConnected || ctx.api !== api) { slot.remove(); return; }
  const items = (await api.items({ Ids: found.map((f) => f.id).join(','), Fields: 'PrimaryImageAspectRatio' }).catch(() => null))?.Items || [];
  const byId = new Map(items.map((i) => [i.Id, i]));
  const ordered = found.filter((f) => byId.has(f.id));
  const section = row('Temporadas nuevas para descargar', ordered.map((f) => byId.get(f.id)));
  if (!section) { slot.remove(); return; }
  section.querySelectorAll('.row-track > .card').forEach((card, i) => {
    const f = ordered[i];
    card.querySelector('.card-art')?.append(h('span', { class: 'badge-new' }, f.to > f.from ? `T${f.from}–T${f.to}` : `T${f.from}`));
    const sub = card.querySelector('.card-sub') || card.appendChild(h('div', { class: 'card-sub' }));
    sub.textContent = label(f);
    card.title = `${f.name}: ${label(f)}`;
  });
  slot.replaceWith(section);

  // A heads-up once per new season.
  const told = store.get('seasonTold', {});
  const fresh = ordered.filter((f) => !told[key(f)]);
  if (fresh.length) {
    toast(fresh.length === 1 ? `Nueva temporada de ${fresh[0].name}: ${label(fresh[0])}` : `Hay ${fresh.length} series con temporadas nuevas para descargar`);
    store.set('seasonTold', { ...told, ...Object.fromEntries(fresh.map((f) => [key(f), Date.now()])) });
  }
}

// Series page: a note under the title when a newer season is out.
export async function seriesNote(series, container) {
  const found = await newSeasons();
  const f = found.find((x) => x.id === series.Id);
  if (!f || !container.isConnected) return;
  const note = h('div', { class: 'new-season-note' },
    h('span', null, `Nueva: ${label(f)}. Aún no está en el servidor.`),
    button('Ocultar aviso', { onclick: () => { hideNewSeason(f); note.remove(); } }));
  container.querySelector('.detail-info')?.append(note);
}
