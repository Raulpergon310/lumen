// Lumen social: a tiny service that lives next to Jellyfin and keeps what Jellyfin can't share between
// users: star ratings, recommendations to friends, a "tengo que verla" list and requests for films
// and series that aren't on the server yet. It also answers who else has watched an item, and
// searches TMDB through Jellyfin for requests, using an admin API key that never leaves the server.
//
// No dependencies (Node 20+). Everything is kept in one JSON file in DATA_DIR.
// Every request must carry the user's own Jellyfin session token (X-Jellyfin-Token): the service asks
// Jellyfin who that is, so nobody can read or write as someone else.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const VERSION = '1.3.0';
const PORT = Number(process.env.PORT) || 8097;
const JELLYFIN_URL = String(process.env.JELLYFIN_URL || 'http://localhost:8096').replace(/\/+$/, '');
const API_KEY = process.env.JELLYFIN_API_KEY || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
// The address friends use from outside (https). Lumen learns it from /api/ping, so a device that has
// found the service at home once also finds it away from home.
const PUBLIC_URL = String(process.env.PUBLIC_URL || '').replace(/\/+$/, '');

if (!API_KEY) {
  console.error('Falta JELLYFIN_API_KEY: créala en Jellyfin → Panel de control → Claves API.');
  process.exit(1);
}

// ---------- storage ----------
// hidden: users who chose not to appear in "who else has seen it".
// requests: films and series friends asked for that aren't on the server (see "requests" below).
let db = { ratings: {}, watchlist: {}, recs: [], hidden: {}, requests: [] };
try {
  db = { ...db, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
} catch (e) {
  if (e.code !== 'ENOENT') { console.error(`No se puede leer ${DATA_FILE}: ${e.message}`); process.exit(1); }
}
fs.mkdirSync(DATA_DIR, { recursive: true });

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DATA_FILE);
  }, 300);
}
function flush() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DATA_FILE);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flush(); process.exit(0); });

// ---------- Jellyfin ----------
async function jf(pathname, token, timeout = 8000) {
  const r = await fetch(JELLYFIN_URL + pathname, {
    headers: { Authorization: `MediaBrowser Client="Lumen social", Device="server", DeviceId="lumen-social", Version="${VERSION}", Token="${token}"` },
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) { const e = new Error(`Jellyfin ${r.status}`); e.status = r.status; throw e; }
  return r.json();
}

async function jfPost(pathname, body, token, timeout = 30000) {
  const r = await fetch(JELLYFIN_URL + pathname, {
    method: 'POST',
    headers: {
      Authorization: `MediaBrowser Client="Lumen social", Device="server", DeviceId="lumen-social", Version="${VERSION}", Token="${token}"`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) { const e = new Error(`Jellyfin ${r.status}`); e.status = r.status; throw e; }
  return r.json();
}

// Small time-limited caches so opening a page never means a burst of questions to Jellyfin.
function cached(map, key, ms, fn) {
  const hit = map.get(key);
  if (hit && Date.now() - hit.t < ms) return hit.p;
  const p = fn();
  map.set(key, { t: Date.now(), p });
  p.catch(() => { if (map.get(key)?.p === p) map.delete(key); });
  if (map.size > 2000) map.delete(map.keys().next().value);
  return p;
}

// Kept only a minute, so a session closed in Jellyfin stops working here soon after.
const sessions = new Map();
function whoIs(token) {
  return cached(sessions, token, 60 * 1000, async () => {
    const u = await jf('/Users/Me', token).catch(async (e) => {
      if (e.status === 401 || e.status === 403) throw e;
      throw Object.assign(new Error('Jellyfin no responde'), { status: 502 });
    });
    return { id: u.Id, name: u.Name, admin: !!u.Policy?.IsAdministrator };
  });
}

const usersCache = new Map();
function users() {
  return cached(usersCache, 'all', 5 * 60 * 1000, async () => {
    const list = await jf('/Users', API_KEY);
    return list.filter((u) => !u.Policy?.IsDisabled).map((u) => ({ id: u.Id, name: u.Name, imageTag: u.PrimaryImageTag || null }));
  });
}

async function userItem(userId, itemId) {
  try {
    return await jf(`/Items/${itemId}?userId=${userId}`, API_KEY);
  } catch (e) {
    if (e.status !== 404 && e.status !== 400) throw e;
    return jf(`/Users/${userId}/Items/${itemId}`, API_KEY);
  }
}

const watchedCache = new Map();
function watched(itemId) {
  return cached(watchedCache, itemId, 2 * 60 * 1000, async () => {
    const all = await users();
    const seen = await Promise.all(all.map(async (u) => {
      try {
        const it = await userItem(u.id, itemId);
        const ud = it?.UserData || {};
        const pct = ud.PlayedPercentage || (it?.RunTimeTicks && ud.PlaybackPositionTicks ? (ud.PlaybackPositionTicks / it.RunTimeTicks) * 100 : 0);
        if (!ud.Played && !pct) return null;
        return { ...u, played: !!ud.Played, pct: Math.round(pct), lastPlayed: ud.LastPlayedDate || null };
      } catch {
        return null;
      }
    }));
    return seen.filter(Boolean).sort((a, b) => (b.played - a.played) || String(b.lastPlayed).localeCompare(String(a.lastPlayed)));
  });
}

// ---------- requests: films and series that aren't on the server ----------
// A friend searches TMDB (through Jellyfin's own metadata search, with the admin key: Jellyfin only
// lets administrators use it), picks the right one and asks for it. When a title with the same
// TMDB / IMDb / TVDB id shows up in the library, the request is marked done and whoever asked is told.
const KINDS = new Set(['Movie', 'Series']);
const ID_KEYS = ['tmdb', 'imdb', 'tvdb'];
const libCache = new Map();

function pickIds(pids) {
  const out = {};
  for (const [k, v] of Object.entries(pids || {})) {
    const key = ID_KEYS.find((x) => x === k.toLowerCase());
    if (key && v && /^[\w.-]{1,40}$/.test(String(v))) out[key[0].toUpperCase() + key.slice(1)] = String(v);
  }
  return out;
}
const idKeys = (pids) => Object.entries(pickIds(pids)).map(([k, v]) => `${k.toLowerCase()}:${v.toLowerCase()}`);
const safeUrl = (u) => (typeof u === 'string' && /^https:\/\/[^\s"'<>]{1,500}$/.test(u) ? u : null);

// Every film and series on the server by provider id, refreshed every few minutes.
function library() {
  return cached(libCache, 'all', 3 * 60 * 1000, async () => {
    const r = await jf('/Items?Recursive=true&IncludeItemTypes=Movie,Series&Fields=ProviderIds&EnableImages=false&EnableUserData=false', API_KEY, 60000);
    const map = new Map();
    for (const it of r.Items || []) {
      for (const key of idKeys(it.ProviderIds)) map.set(`${it.Type}|${key}`, { id: normId(it.Id), name: it.Name });
    }
    return map;
  });
}
function inLibrary(lib, kind, pids) {
  for (const key of idKeys(pids)) { const hit = lib.get(`${kind}|${key}`); if (hit) return hit; }
  return null;
}
function sameTitle(r, kind, pids) {
  const keys = new Set(idKeys(pids));
  return r.kind === kind && idKeys(r.providerIds).some((k) => keys.has(k));
}

// Pending requests whose title has arrived: done, with the library item to open.
async function settleRequests() {
  const pending = db.requests.filter((r) => r.status === 'pending');
  if (!pending.length) return;
  const lib = await library().catch(() => null);
  if (!lib) return;
  let changed = false;
  for (const r of pending) {
    const hit = inLibrary(lib, r.kind, r.providerIds);
    if (hit) { Object.assign(r, { status: 'done', itemId: hit.id, doneAt: new Date().toISOString() }); changed = true; }
  }
  if (changed) save();
}
setInterval(() => { libCache.clear(); settleRequests().catch(() => {}); }, 10 * 60 * 1000).unref();

const askers = (r) => [r.by, ...(r.also || [])];
function requestOut(r, me, nameOf) {
  return {
    id: r.id, kind: r.kind, name: r.name, year: r.year, poster: r.poster, overview: r.overview, providerIds: r.providerIds,
    status: r.status, itemId: r.itemId || null, at: r.at, doneAt: r.doneAt || null, reply: r.reply || '',
    by: { id: r.by, name: nameOf(r.by) }, also: (r.also || []).map((id) => ({ id, name: nameOf(id) })),
    notes: (r.notes || []).map((n) => ({ from: nameOf(n.from), note: n.note })),
    mine: askers(r).includes(me.id), canManage: me.admin, canCancel: r.status === 'pending' && askers(r).includes(me.id),
  };
}

// ---------- HTTP ----------
const ID = /^[0-9a-f]{32}$|^[0-9a-f-]{36}$/i;
const normId = (s) => String(s).replace(/-/g, '').toLowerCase();

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 16 * 1024) { reject(Object.assign(new Error('Demasiado grande'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('JSON no válido'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// Who else has seen it, without me and without those who asked not to appear (filtered after the
// cache, so changing the setting applies at once).
async function watchedByOthers(me, itemId) {
  return (await watched(itemId)).filter((u) => u.id !== me.id && !db.hidden[u.id]);
}

function ratingsOf(itemId) {
  return Object.entries(db.ratings[itemId] || {}).map(([userId, r]) => ({ userId, score: r.score, at: r.at }));
}

async function itemInfo(me, itemId, withWatched = true) {
  const [list, seen] = await Promise.all([users().catch(() => []), withWatched ? watchedByOthers(me, itemId).catch(() => []) : null]);
  const nameOf = (id) => list.find((u) => u.id === id)?.name || 'Alguien';
  const ratings = ratingsOf(itemId).map((r) => ({ ...r, name: nameOf(r.userId), me: r.userId === me.id }));
  const scores = ratings.map((r) => r.score);
  return {
    ratings: ratings.sort((a, b) => b.at.localeCompare(a.at)),
    average: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null,
    mine: db.ratings[itemId]?.[me.id]?.score ?? null,
    watched: seen || undefined,
    onWatchlist: !!db.watchlist[me.id]?.[itemId],
    recommendedToMe: db.recs.filter((r) => r.itemId === itemId && r.to === me.id && !r.dismissed)
      .map((r) => ({ id: r.id, from: { id: r.from, name: nameOf(r.from) }, note: r.note, at: r.at })),
  };
}

// ---------- control panel (admins only) ----------
// The machine: with --network host the container sees the NAS's own load and memory; the disk is the
// volume holding DATA_DIR (the NAS's data volume).
function system() {
  const out = { load: os.loadavg(), cpus: os.cpus().length, uptime: os.uptime(), memTotal: os.totalmem(), memAvailable: os.freemem() };
  try {
    const mi = fs.readFileSync('/proc/meminfo', 'utf8');
    const kb = (k) => Number(mi.match(new RegExp(String.raw`^${k}:\s+(\d+)`, 'm'))?.[1]) * 1024;
    if (kb('MemTotal')) out.memTotal = kb('MemTotal');
    if (kb('MemAvailable')) out.memAvailable = kb('MemAvailable');
  } catch {}
  try {
    const st = fs.statfsSync(DATA_DIR);
    out.disk = { total: st.blocks * st.bsize, free: st.bavail * st.bsize };
  } catch {}
  return out;
}

async function stats() {
  const list = await users().catch(() => []);
  const nameOf = (id) => list.find((u) => u.id === id)?.name || 'Alguien';
  const rated = Object.entries(db.ratings).map(([itemId, byUser]) => {
    const scores = Object.values(byUser).map((r) => r.score);
    return { itemId, count: scores.length, average: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 };
  });
  const recentRatings = Object.entries(db.ratings)
    .flatMap(([itemId, byUser]) => Object.entries(byUser).map(([userId, r]) => ({ itemId, user: nameOf(userId), score: r.score, at: r.at })))
    .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 15);
  const perUser = list.map((u) => ({
    name: u.name,
    ratings: Object.values(db.ratings).filter((r) => r[u.id]).length,
    sent: db.recs.filter((r) => r.from === u.id).length,
    received: db.recs.filter((r) => r.to === u.id).length,
    watchlist: Object.keys(db.watchlist[u.id] || {}).length,
  })).filter((u) => u.ratings || u.sent || u.received || u.watchlist);
  return {
    version: VERSION,
    system: system(),
    totals: {
      requests: db.requests.filter((r) => r.status === 'pending').length,
      ratings: rated.reduce((a, r) => a + r.count, 0),
      rated: rated.length,
      recommendations: db.recs.length,
      watchlist: Object.values(db.watchlist).reduce((a, w) => a + Object.keys(w).length, 0),
    },
    topRated: rated.sort((a, b) => (b.average - a.average) || (b.count - a.count)).slice(0, 12),
    recentRatings,
    recentRecommendations: [...db.recs].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 15)
      .map((r) => ({ itemId: r.itemId, from: nameOf(r.from), to: nameOf(r.to), note: r.note, at: r.at, dismissed: r.dismissed })),
    perUser,
  };
}

const routes = [
  ['GET', /^\/api\/users$/, async (me) => (await users()).map((u) => ({ ...u, me: u.id === me.id }))],

  // ?watched=0 answers at once; who has seen it comes apart from /watched (it asks Jellyfin about every user).
  ['GET', /^\/api\/items\/([^/]+)$/, (me, [itemId], _b, url) => itemInfo(me, itemId, url.searchParams.get('watched') !== '0')],
  ['GET', /^\/api\/items\/([^/]+)\/watched$/, (me, [itemId]) => watchedByOthers(me, itemId)],

  // My own settings: { hideWatched } = don't show me in "who else has seen it".
  ['GET', /^\/api\/me$/, (me) => ({ id: me.id, name: me.name, hideWatched: !!db.hidden[me.id] })],
  ['PUT', /^\/api\/me$/, (me, _m, body) => {
    if (typeof body.hideWatched !== 'boolean') throw Object.assign(new Error('Falta hideWatched'), { status: 400 });
    if (body.hideWatched) db.hidden[me.id] = true;
    else delete db.hidden[me.id];
    save();
    return { id: me.id, name: me.name, hideWatched: body.hideWatched };
  }],

  // Ratings and watched for many items at once (cards): { itemId: { average, count, mine } }.
  ['GET', /^\/api\/ratings$/, (me, _m, _b, url) => {
    const out = {};
    for (const id of (url.searchParams.get('ids') || '').split(',').filter((x) => ID.test(x)).slice(0, 200).map(normId)) {
      const r = ratingsOf(id);
      if (r.length) out[id] = { average: Math.round((r.reduce((a, b) => a + b.score, 0) / r.length) * 10) / 10, count: r.length, mine: db.ratings[id]?.[me.id]?.score ?? null };
    }
    return out;
  }],

  ['PUT', /^\/api\/items\/([^/]+)\/rating$/, (me, [itemId], body) => {
    const score = body.score == null ? null : Number(body.score);
    if (score !== null && !(Number.isInteger(score) && score >= 1 && score <= 5)) throw Object.assign(new Error('La puntuación va de 1 a 5'), { status: 400 });
    if (score === null) {
      if (db.ratings[itemId]) delete db.ratings[itemId][me.id];
      if (db.ratings[itemId] && !Object.keys(db.ratings[itemId]).length) delete db.ratings[itemId];
    } else {
      (db.ratings[itemId] ||= {})[me.id] = { score, at: new Date().toISOString() };
    }
    save();
    return itemInfo(me, itemId);
  }],

  ['PUT', /^\/api\/watchlist\/([^/]+)$/, (me, [itemId]) => {
    (db.watchlist[me.id] ||= {})[itemId] = new Date().toISOString();
    save();
    return { onWatchlist: true };
  }],

  ['DELETE', /^\/api\/watchlist\/([^/]+)$/, (me, [itemId]) => {
    if (db.watchlist[me.id]) delete db.watchlist[me.id][itemId];
    save();
    return { onWatchlist: false };
  }],

  ['POST', /^\/api\/items\/([^/]+)\/recommend$/, async (me, [itemId], body) => {
    const known = new Set((await users()).map((u) => u.id));
    const to = [...new Set((Array.isArray(body.to) ? body.to : []).map(normId))].filter((id) => known.has(id) && id !== me.id);
    if (!to.length) throw Object.assign(new Error('Elige a quién recomendársela'), { status: 400 });
    const note = String(body.note || '').trim().slice(0, 280);
    const at = new Date().toISOString();
    for (const uid of to) {
      // Recommending the same thing again to the same person just brings it back to the top.
      const old = db.recs.find((r) => r.itemId === itemId && r.from === me.id && r.to === uid);
      if (old) Object.assign(old, { note: note || old.note, at, dismissed: false });
      else db.recs.push({ id: crypto.randomUUID(), itemId, from: me.id, to: uid, note, at, dismissed: false });
    }
    if (db.recs.length > 5000) db.recs = db.recs.filter((r) => !r.dismissed).slice(-5000);
    save();
    return { sent: to.length };
  }],

  ['DELETE', /^\/api\/recommendations\/([^/]+)$/, (me, [recId]) => {
    const r = db.recs.find((x) => x.id === recId && x.to === me.id);
    if (!r) throw Object.assign(new Error('No existe'), { status: 404 });
    r.dismissed = true;
    save();
    return { ok: true };
  }],

  ['GET', /^\/api\/stats$/, (me) => {
    if (!me.admin) throw Object.assign(new Error('Solo para administradores'), { status: 403 });
    return stats();
  }],

  // Search TMDB for something to ask for: ?q=dune&kind=Movie|Series. Each result says whether it is
  // already on the server (itemId) or already requested.
  ['GET', /^\/api\/catalog$/, async (me, _m, _b, url) => {
    let q = String(url.searchParams.get('q') || '').trim().slice(0, 100);
    const kind = url.searchParams.get('kind') === 'Series' ? 'Series' : 'Movie';
    if (q.length < 2) return [];
    // "Dune 2021" or "Dune (2021)": the year narrows it down.
    let year;
    const m = q.match(/^(.+?)\s*\(?((?:19|20)\d{2})\)?$/);
    if (m) { q = m[1]; year = Number(m[2]); }
    const [found, lib, list] = await Promise.all([
      jfPost(`/Items/RemoteSearch/${kind}`, { SearchInfo: { Name: q, Year: year }, IncludeDisabledProviders: false }, API_KEY)
        .catch((e) => { throw Object.assign(new Error('Jellyfin no ha podido buscar ahora mismo'), { status: 502 }); }),
      library().catch(() => new Map()),
      users().catch(() => []),
    ]);
    const nameOf = (id) => list.find((u) => u.id === id)?.name || 'Alguien';
    return (Array.isArray(found) ? found : []).slice(0, 30).map((r) => {
      const providerIds = pickIds(r.ProviderIds);
      const hit = inLibrary(lib, kind, providerIds);
      const req = db.requests.find((x) => x.status !== 'declined' && sameTitle(x, kind, providerIds));
      return {
        kind, name: String(r.Name || '').slice(0, 200), year: r.ProductionYear || null, overview: String(r.Overview || '').slice(0, 600),
        poster: safeUrl(r.ImageUrl), providerIds, itemId: hit?.id || null, request: req ? requestOut(req, me, nameOf) : null,
      };
    }).filter((r) => r.name && Object.keys(r.providerIds).length);
  }],

  // Everyone's requests (it's a small group of friends): pending first, then the ones already here.
  ['GET', /^\/api\/requests$/, async (me) => {
    await settleRequests();
    const list = await users().catch(() => []);
    const nameOf = (id) => list.find((u) => u.id === id)?.name || 'Alguien';
    const order = { pending: 0, done: 1, declined: 2 };
    return [...db.requests]
      .sort((a, b) => (order[a.status] - order[b.status]) || String(b.doneAt || b.at).localeCompare(String(a.doneAt || a.at)))
      .map((r) => requestOut(r, me, nameOf));
  }],

  ['POST', /^\/api\/requests$/, async (me, _m, body) => {
    const kind = KINDS.has(body.kind) ? body.kind : null;
    const name = String(body.name || '').trim().slice(0, 200);
    const providerIds = pickIds(body.providerIds);
    if (!kind || !name || !Object.keys(providerIds).length) throw Object.assign(new Error('Elige un título de la búsqueda'), { status: 400 });
    const hit = inLibrary(await library().catch(() => new Map()), kind, providerIds);
    if (hit) throw Object.assign(new Error(`${hit.name} ya está en el servidor`), { status: 409, itemId: hit.id });
    const note = String(body.note || '').trim().slice(0, 280);
    const at = new Date().toISOString();
    let r = db.requests.find((x) => x.status === 'pending' && sameTitle(x, kind, providerIds));
    if (r) {
      // Already asked for: count me in.
      if (!askers(r).includes(me.id)) (r.also ||= []).push(me.id);
    } else {
      r = {
        id: crypto.randomUUID(), kind, name, year: Number(body.year) || null, providerIds, poster: safeUrl(body.poster),
        overview: String(body.overview || '').slice(0, 600), by: me.id, also: [], notes: [], status: 'pending', at, seen: {},
      };
      db.requests.push(r);
      if (db.requests.length > 2000) db.requests = db.requests.filter((x) => x.status === 'pending').concat(db.requests.filter((x) => x.status !== 'pending').slice(-1000));
    }
    if (note) (r.notes ||= []).push({ from: me.id, note, at });
    save();
    const list = await users().catch(() => []);
    return requestOut(r, me, (id) => list.find((u) => u.id === id)?.name || 'Alguien');
  }],

  // The administrator answers: declined (with a reason) or back to pending; done is automatic, but can be set by hand.
  ['PUT', /^\/api\/requests\/([^/]+)$/, async (me, [id], body) => {
    if (!me.admin) throw Object.assign(new Error('Solo el administrador puede responder peticiones'), { status: 403 });
    const r = db.requests.find((x) => x.id === id);
    if (!r) throw Object.assign(new Error('No existe'), { status: 404 });
    if (!['pending', 'declined', 'done'].includes(body.status)) throw Object.assign(new Error('Estado no válido'), { status: 400 });
    r.status = body.status;
    r.reply = String(body.reply || '').trim().slice(0, 280);
    if (body.status === 'done') r.doneAt = new Date().toISOString();
    r.seen = {};
    save();
    const list = await users().catch(() => []);
    return requestOut(r, me, (uid) => list.find((u) => u.id === uid)?.name || 'Alguien');
  }],

  // Taking a request back: whoever asked (the next one keeps it if others asked too), or the administrator.
  ['DELETE', /^\/api\/requests\/([^/]+)$/, (me, [id]) => {
    const i = db.requests.findIndex((x) => x.id === id);
    if (i < 0) throw Object.assign(new Error('No existe'), { status: 404 });
    const r = db.requests[i];
    if (!me.admin && !askers(r).includes(me.id)) throw Object.assign(new Error('Esa petición no es tuya'), { status: 403 });
    if (!me.admin && r.status !== 'pending') throw Object.assign(new Error('Esa petición ya está resuelta'), { status: 409 });
    const left = askers(r).filter((u) => u !== me.id);
    if (me.admin && !askers(r).includes(me.id)) db.requests.splice(i, 1);
    else if (left.length) { r.by = left[0]; r.also = left.slice(1); r.notes = (r.notes || []).filter((n) => n.from !== me.id); }
    else db.requests.splice(i, 1);
    save();
    return { ok: true };
  }],

  // "Ya está": the notice that a request arrived (or was turned down) has been shown.
  ['POST', /^\/api\/requests\/([^/]+)\/seen$/, (me, [id]) => {
    const r = db.requests.find((x) => x.id === id);
    if (r) { (r.seen ||= {})[me.id] = true; save(); }
    return { ok: true };
  }],

  // Home page: what friends recommended to me (newest first) and my own list.
  ['GET', /^\/api\/inbox$/, async (me) => {
    await settleRequests().catch(() => {});
    const list = await users().catch(() => []);
    const nameOf = (id) => list.find((u) => u.id === id)?.name || 'Alguien';
    const answered = db.requests.filter((r) => r.status !== 'pending' && askers(r).includes(me.id) && !r.seen?.[me.id]);
    return {
      // My requests that arrived or were turned down, not yet told; and, for the administrator, what's waiting.
      requestsAnswered: answered.map((r) => ({ id: r.id, name: r.name, kind: r.kind, status: r.status, itemId: r.itemId || null, reply: r.reply || '' })),
      requestsPending: me.admin ? db.requests.filter((r) => r.status === 'pending').map((r) => ({ id: r.id, name: r.name, at: r.at, by: nameOf(r.by) })) : [],
      recommendations: db.recs.filter((r) => r.to === me.id && !r.dismissed).sort((a, b) => b.at.localeCompare(a.at))
        .map((r) => ({ id: r.id, itemId: r.itemId, from: { id: r.from, name: nameOf(r.from) }, note: r.note, at: r.at })),
      watchlist: Object.entries(db.watchlist[me.id] || {}).sort((a, b) => b[1].localeCompare(a[1])).map(([itemId, at]) => ({ itemId, at })),
    };
  }],
];

const server = http.createServer(async (req, res) => {
  // Lumen runs from many origins (the web on GitHub Pages, the Windows app, the TV app). Access is by
  // token in a header, never by cookie, so allowing any origin gives nothing away.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'X-Jellyfin-Token, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, 'http://x');
  // Behind a reverse proxy at a sub-path (https://jellyfin.example.com/lumen-social/…) the prefix is dropped.
  const pathname = url.pathname.replace(/^.*?(?=\/api\/)/, '');
  if (pathname === '/api/ping') return send(res, 200, { app: 'lumen-social', version: VERSION, publicUrl: PUBLIC_URL || null });

  const route = routes.find(([m, re]) => m === req.method && re.test(pathname));
  if (!route) return send(res, 404, { error: 'No existe' });
  try {
    const token = req.headers['x-jellyfin-token'];
    if (!token) return send(res, 401, { error: 'Falta la sesión' });
    let me;
    try { me = await whoIs(String(token)); } catch (e) { return send(res, e.status === 502 ? 502 : 401, { error: e.status === 502 ? e.message : 'Sesión no válida' }); }
    const params = pathname.match(route[1]).slice(1).map(decodeURIComponent);
    if (params[0] && /items|watchlist/.test(pathname)) {
      if (!ID.test(params[0])) return send(res, 400, { error: 'Id no válido' });
      params[0] = normId(params[0]);
    }
    const body = ['PUT', 'POST'].includes(req.method) ? await readBody(req) : {};
    send(res, 200, await route[2](me, params, body, url));
  } catch (e) {
    if (!e.status) console.error(e);
    send(res, e.status || 500, { error: e.status ? e.message : 'Error interno', ...(e.itemId ? { itemId: e.itemId } : {}) });
  }
});

server.listen(PORT, () => console.log(`Lumen social ${VERSION} en el puerto ${PORT} · Jellyfin: ${JELLYFIN_URL} · datos: ${DATA_FILE}`));
