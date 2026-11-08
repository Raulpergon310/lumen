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
let lastSummary = null;
export function lastCheckSummary() {
  return lastSummary || store.get('seasonCheck2')?.summary || null;
}

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
  // "Not found" answers from before the name search existed (no v) are asked again.
  if (known && (known.id || (known.v === 2 && Date.now() - known.at < 30 * 24 * 3600 * 1000))) return known.id;
  const p = series.ProviderIds || {};
  let show = null;
  if (p.Tvdb) show = await tvmaze(`/lookup/shows?thetvdb=${encodeURIComponent(p.Tvdb)}`);
  if (!show && p.Imdb) show = await tvmaze(`/lookup/shows?imdb=${encodeURIComponent(p.Imdb)}`);
  // Only a TMDB id (common with anime): search by name, accepted only if the year matches.
  if (!show && series.Name) {
    const hit = await tvmaze(`/singlesearch/shows?q=${encodeURIComponent(series.OriginalTitle || series.Name)}`)
      || (series.OriginalTitle && series.OriginalTitle !== series.Name ? await tvmaze(`/singlesearch/shows?q=${encodeURIComponent(series.Name)}`) : null);
    const y = parseInt(hit?.premiered, 10);
    if (hit && (!series.ProductionYear || !y || Math.abs(y - series.ProductionYear) <= 1)) show = hit;
  }
  const next = { ...store.get('tvmazeIds', {}), [series.Id]: { id: show?.id || 0, at: Date.now(), v: 2 } };
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

  const series = list((await Promise.allSettled([
    bg({ Ids: chosen.join(','), Fields: 'ProviderIds,OriginalTitle', EnableImages: false }),
  ]))[0]);

  // Seasons really on the NAS. Jellyfin can also list seasons it knows about but you don't have
  // ("missing" seasons, when it is set to show missing episodes): those must not count.
  const seasonsOnDisk = async (seriesId) => {
    const r = await api.req(`/Shows/${seriesId}/Seasons`, {
      background: true, timeout: 30000, query: { userId: api.userId, isMissing: false, EnableImages: false, EnableUserData: false },
    });
    return Math.max(0, ...(r?.Items || []).filter((x) => x.IndexNumber > 0).map((x) => x.IndexNumber));
  };

  const found = [];
  const now = today();
  let checked = 0;
  for (const s of series) {
    try {
      const have = await seasonsOnDisk(s.Id);
      if (!have) continue;
      const id = await tvmazeId(s);
      if (!id) { log(`temporadas ${s.Name}: no está en TVmaze`); continue; }
      checked++;
      const seasons = await tvmaze(`/shows/${id}/seasons`);
      const aired = (seasons || []).filter((x) => x.number > 0 && x.premiereDate && x.premiereDate <= now);
      const newest = aired.reduce((m, x) => (x.number > m.number ? x : m), { number: 0 });
      log(`temporadas ${s.Name}: en el NAS ${have}, emitidas ${newest.number}`);
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
  log(`temporadas: ${series.length} series, ${checked} en TVmaze, ${found.length} con temporada nueva`);
  lastSummary = { series: series.length, checked, found: found.length };
  return found;
}

// The cached answer, refreshed in the background when it is older than 12 hours.
export function newSeasons({ force = false } = {}) {
  const serverId = store.get('activeServer');
  const cached = store.get('seasonCheck2');
  const fresh = cached && cached.serverId === serverId && Date.now() - cached.at < CHECK_MS;
  if (fresh && !force) return Promise.resolve(visible(cached.found));
  if (!running) {
    running = runCheck()
      .then((found) => {
        store.set('seasonCheck2', { at: Date.now(), serverId, found, summary: lastSummary });
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
