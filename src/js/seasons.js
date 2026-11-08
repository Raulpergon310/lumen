// New seasons and episodes to download: for every series on the server (the ones you watch or keep as
// favourites first), compares what is on the NAS with what has already aired according to TVmaze (free,
// no key; found through the TVDB/IMDb ids Jellyfin keeps, or by name and year). It reports
//  - seasons that have aired and aren't on the NAS, and
//  - for a season still airing (or just finished), aired episodes that aren't on the NAS yet.
// They show in a home row and on the series page. Checked at most every 12 hours, in the background.
import { h, button, toast } from './ui.js';
import { ctx } from './context.js';
import { store, log } from './store.js';
import { row } from './cards.js';

const TVMAZE = 'https://api.tvmaze.com';
const CHECK_MS = 12 * 3600 * 1000;
const MAX_SERIES = 500;
const RECENT_DAYS = 120; // episodes are compared only for seasons with an episode aired this recently
const STORE_KEY = 'seasonCheck3';

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

function fmtDate(d) {
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
      const have = Math.max(0, ...((await local(`/Shows/${s.Id}/Seasons`, {}))?.Items || []).filter((x) => x.IndexNumber > 0).map((x) => x.IndexNumber));
      if (!have) continue;
      const id = await tvmazeId(s);
      if (!id) { log(`novedades ${s.Name}: no está en TVmaze`); continue; }
      checked++;
      const show = await tvmaze(`/shows/${id}?embed[]=seasons&embed[]=episodes`);
      const seasons = (show?._embedded?.seasons || []).filter((x) => x.number > 0 && x.premiereDate && x.premiereDate <= now);
      const newest = seasons.reduce((m, x) => (x.number > m.number ? x : m), { number: 0 });

      if (newest.number > have) {
        const first = seasons.find((x) => x.number === have + 1) || newest;
        const f = { kind: 'season', id: s.Id, name: s.Name, from: have + 1, to: newest.number, premiere: first.premiereDate, airing: !newest.endDate || newest.endDate > now };
        found.push(f);
        log(`novedades ${s.Name}: en el NAS ${have} temporadas, emitidas ${newest.number}`);
        continue;
      }

      // Same season as the NAS: is it still airing, with episodes you don't have yet?
      const aired = (show?._embedded?.episodes || []).filter((e) => e.season === have && e.number > 0 && e.airdate && e.airdate <= now);
      const lastAired = aired.reduce((m, e) => (e.number > m.number ? e : m), { number: 0 });
      if (!lastAired.number || lastAired.airdate < recent) continue;
      const mine = (await local(`/Shows/${s.Id}/Episodes`, { season: have }))?.Items || [];
      const haveEp = Math.max(0, ...mine.filter((e) => (e.ParentIndexNumber ?? have) === have).map((e) => e.IndexNumberEnd || e.IndexNumber || 0));
      if (lastAired.number > haveEp) {
        const firstMissing = aired.filter((e) => e.number > haveEp).sort((a, b) => a.number - b.number)[0] || lastAired;
        found.push({ kind: 'episodes', id: s.Id, name: s.Name, season: have, fromEp: haveEp + 1, toEp: lastAired.number, premiere: firstMissing.airdate });
        log(`novedades ${s.Name}: T${have} en el NAS hasta E${haveEp}, emitidos hasta E${lastAired.number}`);
      }
    } catch (e) {
      log(`novedades ${s.Name}: ${e.message}`);
    }
  }
  saveIds(true);
  const seasonsFound = found.filter((f) => f.kind === 'season').length;
  log(`novedades: ${series.length} series, ${checked} en TVmaze, ${seasonsFound} con temporada nueva, ${found.length - seasonsFound} con episodios nuevos`);
  lastSummary = { series: series.length, checked, found: found.length, seasons: seasonsFound, episodes: found.length - seasonsFound };
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

function key(f) {
  return f.kind === 'episodes' ? `${f.id}:s${f.season}e${f.toEp}` : `${f.id}:${f.to}`;
}

function visible(found) {
  const hidden = store.get('seasonHidden', {});
  return (found || []).filter((f) => !hidden[key(f)]);
}

export function hideNewSeason(f) {
  store.set('seasonHidden', { ...store.get('seasonHidden', {}), [key(f)]: Date.now() });
}

function label(f) {
  if (f.kind === 'episodes') {
    const eps = f.toEp > f.fromEp ? `episodios ${f.fromEp}–${f.toEp}` : `episodio ${f.fromEp}`;
    return `Temporada ${f.season}: ${eps} · desde el ${fmtDate(f.premiere)}`;
  }
  const which = f.to > f.from ? `Temporadas ${f.from}–${f.to}` : `Temporada ${f.from}`;
  return `${which} · ${f.airing && f.to === f.from ? 'en emisión desde' : 'salió el'} ${fmtDate(f.premiere)}`;
}

function badge(f) {
  if (f.kind === 'episodes') return `T${f.season} E${f.fromEp}${f.toEp > f.fromEp ? `–${f.toEp}` : ''}`;
  return f.to > f.from ? `T${f.from}–T${f.to}` : `T${f.from}`;
}

// Home: row "Nuevo para descargar", in place of `slot`.
export async function newSeasonsRow(slot) {
  const api = ctx.api;
  const found = await newSeasons();
  if (!found.length || !slot.isConnected || ctx.api !== api) { slot.remove(); return; }
  const items = (await api.items({ Ids: found.map((f) => f.id).join(','), Fields: 'PrimaryImageAspectRatio' }).catch(() => null))?.Items || [];
  const byId = new Map(items.map((i) => [i.Id, i]));
  const ordered = found.filter((f) => byId.has(f.id));
  const section = row('Nuevo para descargar', ordered.map((f) => byId.get(f.id)));
  if (!section) { slot.remove(); return; }
  section.querySelectorAll('.row-track > .card').forEach((card, i) => {
    const f = ordered[i];
    card.querySelector('.card-art')?.append(h('span', { class: 'badge-new' }, badge(f)));
    const sub = card.querySelector('.card-sub') || card.appendChild(h('div', { class: 'card-sub' }));
    sub.textContent = label(f);
    card.title = `${f.name}: ${label(f)}`;
  });
  slot.replaceWith(section);

  // A heads-up once per novelty.
  const told = store.get('seasonTold', {});
  const fresh = ordered.filter((f) => !told[key(f)]);
  if (fresh.length) {
    toast(fresh.length === 1
      ? `${fresh[0].kind === 'episodes' ? 'Episodios nuevos' : 'Nueva temporada'} de ${fresh[0].name}: ${label(fresh[0])}`
      : `Hay ${fresh.length} series con temporadas o episodios nuevos para descargar`);
    store.set('seasonTold', { ...told, ...Object.fromEntries(fresh.map((f) => [key(f), Date.now()])) });
  }
}

// Series page: a note under the title when something newer is out.
export async function seriesNote(series, container) {
  const found = await newSeasons();
  const f = found.find((x) => x.id === series.Id);
  if (!f || !container.isConnected) return;
  const note = h('div', { class: 'new-season-note' },
    h('span', null, `Nuevo: ${label(f)}. Aún no está en el servidor.`),
    button('Ocultar aviso', { onclick: () => { hideNewSeason(f); note.remove(); } }));
  container.querySelector('.detail-info')?.append(note);
}
