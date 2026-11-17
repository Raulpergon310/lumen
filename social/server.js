// Lumen social: a tiny service that lives next to Jellyfin and keeps what Jellyfin can't share between
// users: star ratings, recommendations to friends and a "tengo que verla" list. It also answers who
// else has watched an item, using an admin API key that never leaves the server.
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

const VERSION = '1.1.0';
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
let db = { ratings: {}, watchlist: {}, recs: [] };
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
  fs.writeFileSync(DATA_FILE, JSON.stringify(db));
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

const sessions = new Map();
function whoIs(token) {
  return cached(sessions, token, 10 * 60 * 1000, async () => {
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

function ratingsOf(itemId) {
  return Object.entries(db.ratings[itemId] || {}).map(([userId, r]) => ({ userId, score: r.score, at: r.at }));
}

async function itemInfo(me, itemId, withWatched = true) {
  const [list, seen] = await Promise.all([users().catch(() => []), withWatched ? watched(itemId).catch(() => []) : null]);
  const nameOf = (id) => list.find((u) => u.id === id)?.name || 'Alguien';
  const ratings = ratingsOf(itemId).map((r) => ({ ...r, name: nameOf(r.userId), me: r.userId === me.id }));
  const scores = ratings.map((r) => r.score);
  return {
    ratings: ratings.sort((a, b) => b.at.localeCompare(a.at)),
    average: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null,
    mine: db.ratings[itemId]?.[me.id]?.score ?? null,
    watched: seen ? seen.filter((u) => u.id !== me.id) : undefined,
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
    const kb = (k) => Number(mi.match(new RegExp(`^${k}:\s+(\d+)`, 'm'))?.[1]) * 1024;
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
  ['GET', /^\/api\/items\/([^/]+)\/watched$/, async (me, [itemId]) => (await watched(itemId)).filter((u) => u.id !== me.id)],

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

  // Home page: what friends recommended to me (newest first) and my own list.
  ['GET', /^\/api\/inbox$/, async (me) => {
    const list = await users().catch(() => []);
    const nameOf = (id) => list.find((u) => u.id === id)?.name || 'Alguien';
    return {
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
    send(res, e.status || 500, { error: e.status ? e.message : 'Error interno' });
  }
});

server.listen(PORT, () => console.log(`Lumen social ${VERSION} en el puerto ${PORT} · Jellyfin: ${JELLYFIN_URL} · datos: ${DATA_FILE}`));
