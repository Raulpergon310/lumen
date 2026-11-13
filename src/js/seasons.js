// New seasons and episodes to download: for every series on the server (the ones you watch or keep as
// favourites first), compares what is on the NAS with what has already aired according to TVmaze (free,
// no key; found through the TVDB/IMDb ids Jellyfin keeps, or by name and year). It reports
//  - seasons that have aired and aren't on the NAS, and
//  - for a season still airing (or just finished), aired episodes that aren't on the NAS yet.
// A series with something new gets a green dot on its card, and its page says exactly which seasons
// and episodes are missing (this file only finds it out; cards.js and views/item.js draw it).
// Checked at most every 12 hours, in the background.
import { ctx } from './context.js';
import { store, log } from './store.js';

const TVMAZE = 'https://api.tvmaze.com';
const CHECK_MS = 12 * 3600 * 1000;
const MAX_SERIES = 500;
const RECENT_DAYS = 120; // episodes are compared only for seasons with an episode aired this recently
const STORE_KEY = 'seasonCheck4';

let running = null;
let lastSummary = null;
export function lastCheckSummary() {
  return lastSummary || store.get(STORE_KEY)?.summary || null;
}
export function isChecking() {
  return !!running;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

export function fmtDate(d) {
  try { return new Date(d + 'T12:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return d; }
}

// TVmaze allows about 20 calls every 10 seconds: calls are spaced out.
let nextCall = 0;
async function tvmaze(path) {
  const wait = nextCall - Date.now();
  nextCall = Math.max(Date.now(), nextCall) + 550;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(TVMAZE + path, { signal: ctl.signal });
    if (r.status === 404) return null;
    if (r.status === 429) { await new Promise((res) => setTimeout(res, 5000)); return tvmaze(path); }
    if (!r.ok) throw new Error(`TVmaze ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// Jellyfin series id -> TVmaze show id (0 = not on TVmaze, asked again after a month). Kept in memory
// during a check and saved every few new answers, not on each one.
let idCache = null;
let unsaved = 0;
function saveIds(force = false) {
  if (idCache && (force || unsaved >= 15)) { store.set('tvmazeIds', idCache); unsaved = 0; }
}

async function tvmazeId(series) {
  idCache ??= { ...store.get('tvmazeIds', {}) };
  const known = idCache[series.Id];
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
  idCache[series.Id] = { id: show?.id || 0, at: Date.now(), v: 2 };
  unsaved++;
  saveIds();
  return show?.id || 0;
}

async function runCheck() {
  const api = ctx.api;
  const bg = (q) => api.req('/Items', { background: true, timeout: 60000, query: { userId: api.userId, ...q } });
  const list = (r) => (r.status === 'fulfilled' && r.value ? r.value.Items || [] : []);
  const local = (path, query) => api.req(path, {
    background: true, timeout: 30000, query: { userId: api.userId, isMissing: false, EnableImages: false, EnableUserData: false, ...query },
  });

  // Every series on the server; the ones you watch (recently first) and your favourites go first.
  const [all, eps, favs] = await Promise.allSettled([
    bg({ Recursive: true, IncludeItemTypes: 'Series', Fields: 'ProviderIds,OriginalTitle', EnableImages: false, EnableUserData: false }),
    bg({ Recursive: true, IncludeItemTypes: 'Episode', Filters: 'IsPlayed', SortBy: 'DatePlayed', SortOrder: 'Descending', Limit: 400, EnableImages: false }),
    bg({ Recursive: true, IncludeItemTypes: 'Series', Filters: 'IsFavorite', Limit: 100, EnableImages: false }),
  ]);
  const rank = new Map();
  for (const e of list(eps)) if (e.SeriesId && !rank.has(e.SeriesId)) rank.set(e.SeriesId, rank.size);
  for (const s of list(favs)) if (!rank.has(s.Id)) rank.set(s.Id, rank.size);
  const series = list(all)
    .sort((a, b) => (rank.get(a.Id) ?? 1e9) - (rank.get(b.Id) ?? 1e9) || String(a.Name).localeCompare(String(b.Name)))
    .slice(0, MAX_SERIES);

  const found = [];
  const now = today();
  const recent = daysAgo(RECENT_DAYS);
  let checked = 0;
  for (const s of series) {
    try {
      // Seasons really on the NAS ("missing" seasons Jellyfin may list don't count).
      const mineSeasons = new Set(((await local(`/Shows/${s.Id}/Seasons`, {}))?.Items || []).filter((x) => x.IndexNumber > 0).map((x) => x.IndexNumber));
      const have = Math.max(0, ...mineSeasons);
      if (!have) continue;
      const id = await tvmazeId(s);
      if (!id) { log(`novedades ${s.Name}: no está en TVmaze`); continue; }
      checked++;
      const show = await tvmaze(`/shows/${id}?embed[]=seasons&embed[]=episodes`);
      // (Shows TVmaze numbers by year — 2019, 2020… — can't be matched with the NAS's 1, 2, 3.)
      const seasons = (show?._embedded?.seasons || []).filter((x) => x.number > 0 && x.number < 100 && x.premiereDate && x.premiereDate <= now);
      const airedEps = (show?._embedded?.episodes || []).filter((e) => e.number > 0 && e.airdate && e.airdate <= now);

      // Every aired season that isn't on the NAS: newer ones, and gaps in between.
      const missing = seasons.filter((x) => !mineSeasons.has(x.number)).sort((a, b) => a.number - b.number).map((x) => ({
        n: x.number,
        premiere: x.premiereDate,
        episodes: airedEps.filter((e) => e.season === x.number).length || x.episodeOrder || 0,
        airing: !x.endDate || x.endDate > now,
      }));

      // The newest season on the NAS: is it still airing (or just over), with episodes you don't have yet?
      let eps = null;
      const aired = airedEps.filter((e) => e.season === have);
      const lastAired = aired.reduce((m, e) => (e.number > m.number ? e : m), { number: 0 });
      if (lastAired.number && lastAired.airdate >= recent) {
        const mine = (await local(`/Shows/${s.Id}/Episodes`, { season: have }))?.Items || [];
        const haveEp = Math.max(0, ...mine.filter((e) => (e.ParentIndexNumber ?? have) === have).map((e) => e.IndexNumberEnd || e.IndexNumber || 0));
        if (lastAired.number > haveEp) {
          const firstMissing = aired.filter((e) => e.number > haveEp).sort((a, b) => a.number - b.number)[0] || lastAired;
          eps = { season: have, fromEp: haveEp + 1, toEp: lastAired.number, premiere: firstMissing.airdate };
        }
      }
      if (!missing.length && !eps) continue;
      found.push({ id: s.Id, name: s.Name, have, missing, eps });
      log(`novedades ${s.Name}: faltan ${missing.length ? 'T' + missing.map((m) => m.n).join(',T') : ''}${eps ? ` T${eps.season} E${eps.fromEp}-${eps.toEp}` : ''}`);
    } catch (e) {
      log(`novedades ${s.Name}: ${e.message}`);
    }
  }
  saveIds(true);
  const seasonsFound = found.filter((f) => newer(f).length).length;
  const epsFound = found.filter((f) => f.eps).length;
  log(`novedades: ${series.length} series, ${checked} en TVmaze, ${seasonsFound} con temporadas que faltan, ${epsFound} con episodios nuevos`);
  lastSummary = { series: series.length, checked, found: found.length, seasons: seasonsFound, episodes: epsFound };
  return found;
}

// The cached answer, refreshed in the background when it is older than 12 hours.
export function newSeasons({ force = false } = {}) {
  const serverId = store.get('activeServer');
  const cached = store.get(STORE_KEY);
  const fresh = cached && cached.serverId === serverId && Date.now() - cached.at < CHECK_MS;
  if (fresh && !force) return Promise.resolve(visible(cached.found));
  if (!running) {
    running = runCheck()
      .then((found) => {
        store.set(STORE_KEY, { at: Date.now(), serverId, found, summary: lastSummary });
        markCards();
        return found;
      })
      .catch((e) => {
        log(`novedades: ${e.message}`);
        return cached?.found || [];
      })
      .finally(() => { running = null; });
  }
  // While a long first check runs, show what the last one found.
  if (cached && cached.serverId === serverId && !force) return Promise.resolve(visible(cached.found));
  return running.then(visible);
}

// Seasons after the newest one on the NAS: those are news. Older gaps (seasons you never kept) are only
// listed on the series page, without a dot.
function newer(f) {
  return f.missing.filter((m) => m.n > f.have);
}

function key(f) {
  return `${f.id}:${newer(f).map((m) => m.n).join(',')}:${f.eps ? `s${f.eps.season}e${f.eps.toEp}` : ''}`;
}

function visible(found) {
  const hidden = store.get('seasonHidden', {});
  return (found || []).filter((f) => f.missing && !hidden[key(f)]);
}

// "No avisar": until something else comes out for that series.
export function hideNewSeason(f) {
  store.set('seasonHidden', { ...store.get('seasonHidden', {}), [key(f)]: Date.now() });
  markCards();
}

// Everything known right now about a series (no waiting): { have, missing: [{ n, premiere, episodes,
// airing }], eps: { season, fromEp, toEp, premiere } | null }, or null when nothing is missing.
export function missingFor(seriesId) {
  const cached = store.get(STORE_KEY);
  if (!cached || cached.serverId !== store.get('activeServer')) return null;
  return (cached.found || []).find((f) => f.missing && f.id === seriesId) || null;
}

// The same, only when there is something NEW (a later season, or new episodes) the user hasn't hidden:
// this is what earns the green dot.
export function newFor(seriesId) {
  const f = missingFor(seriesId);
  return f && (newer(f).length || f.eps) && visible([f]).length ? f : null;
}

// "Faltan las temporadas 3 y 4 · episodios 8–10 de la temporada 2"
export function describeNew(f) {
  const parts = [];
  const ns = newer(f).map((m) => m.n);
  if (ns.length === 1) parts.push(`la temporada ${ns[0]}`);
  else if (ns.length > 1) parts.push(`las temporadas ${ns.slice(0, -1).join(', ')} y ${ns[ns.length - 1]}`);
  if (f.eps) parts.push(`${f.eps.toEp > f.eps.fromEp ? `los episodios ${f.eps.fromEp}–${f.eps.toEp}` : `el episodio ${f.eps.fromEp}`} de la temporada ${f.eps.season}`);
  return `${ns.length > 1 || (f.eps && (ns.length || f.eps.toEp > f.eps.fromEp)) ? 'Faltan' : 'Falta'} ${parts.join(' y ')}`;
}

// The green dot on series cards already on screen (cards drawn later get theirs in cards.js).
export function markCards(root = document) {
  for (const card of root.querySelectorAll('.card[data-series]')) {
    const f = newFor(card.dataset.series);
    const dot = card.querySelector('.dot-new');
    if (f && !dot) card.querySelector('.card-art')?.append(newDot(f));
    else if (!f && dot) dot.remove();
  }
}

export function newDot(f) {
  const dot = document.createElement('span');
  dot.className = 'dot-new';
  dot.title = `${describeNew(f)} en el servidor`;
  return dot;
}