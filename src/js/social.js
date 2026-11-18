// Client for Lumen social (social/server.js), the small service next to Jellyfin that keeps what
// Jellyfin can't share between users: ratings, recommendations to friends and "tengo que verla".
// Optional: when no service answers, everything social simply doesn't show.
import { ctx } from './context.js';
import { store, log } from './store.js';

const PORT = 8097;

// AbortSignal.timeout is missing on older TV WebViews.
function timeoutSignal(ms) {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}
let found = null; // { api, url, at }; a null url is only trusted for a few seconds (the service may be starting)
let finding = null;
const RETRY_MS = 3000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Addresses we know the service has answered on (or was given): saved for this server, learnt from
// the service itself, or from an invitation link (?social=…).
function known() {
  const server = ctx.savedServers?.().find((s) => s.id === ctx.server?.id);
  return usable([...(server?.socialUrls || []), server?.socialUrl, new URLSearchParams(location.search).get('social')]);
}

// Where to look: the known addresses plus guesses next to Jellyfin: the default port at home (http),
// and from outside (https) the next port up (Jellyfin on :8443 → service on :8444) or the
// /lumen-social path of the same proxy.
function candidates() {
  const server = ctx.savedServers?.().find((s) => s.id === ctx.server?.id);
  const list = [...known()];
  try {
    for (const url of [ctx.api.url, ...(server?.urls || [])]) {
      const u = new URL(url);
      if (u.protocol === 'http:') list.push(`http://${u.hostname}:${PORT}`);
      else {
        if (u.port) list.push(`https://${u.hostname}:${Number(u.port) + 1}`);
        list.push(`${u.origin}/lumen-social`);
      }
    }
  } catch {}
  return usable(list);
}

// Every address is tried, http ones too even from the https web: Chrome lets an https page talk to
// http addresses on the home network (that is how it reaches Jellyfin at home), and one that the
// browser blocks simply doesn't answer while the others are tried at the same time.
function usable(list) {
  return [...new Set(list.filter(Boolean).map(normalize))];
}

export function normalize(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  return u.replace(/\/+$/, '').replace(/\/api$/, '');
}

export async function ping(url, timeout = 4000) {
  const r = await fetch(`${url}/api/ping`, { signal: timeoutSignal(timeout) });
  const j = await r.json();
  if (j?.app !== 'lumen-social') throw new Error('Esa dirección no es el servicio de Lumen');
  return j;
}

// Has the service ever answered for this server (or been given by hand)? Then, when it doesn't answer,
// it is most likely starting, and it's worth waiting for. Otherwise it's looked for once, quietly.
export const configured = () => !!ctx.api && known().length > 0;

// The service's address for the current server, or null. All known addresses are tried at once and
// the first that answers wins (home or away). Found once per session; "nobody answered" is asked
// again after a few seconds, because the service takes a while to start on the NAS.
export function socialUrl() {
  const api = ctx.api;
  if (!api) return Promise.resolve(null);
  if (found?.api === api && (found.url || Date.now() - found.at < RETRY_MS)) return Promise.resolve(found.url);
  if (finding?.api === api) return finding.p;
  const list = candidates();
  const p = new Promise((resolve) => {
    let pending = list.length;
    if (!pending) return resolve(null);
    for (const url of list) {
      ping(url).then((info) => {
        remember(url, info.publicUrl);
        resolve(url);
      }, () => { if (--pending === 0) resolve(null); });
    }
  }).then((url) => {
    found = { api, url, at: Date.now() };
    if (finding?.p === p) finding = null;
    return url;
  });
  finding = { api, p };
  return p;
}

// Waits for the service while it is starting: tries again every few seconds. onWaiting is called
// once, the first time it doesn't answer, so the page can say it's starting instead of "unavailable".
export async function waitForSocial({ onWaiting, isStale = () => false, maxMs = 180000 } = {}) {
  const start = Date.now();
  let told = false;
  for (;;) {
    const url = await socialUrl();
    if (url) return url;
    if (!configured() || isStale() || Date.now() - start > maxMs) return null;
    if (!told) { told = true; onWaiting?.(); }
    await sleep(RETRY_MS);
  }
}

function remember(...urls) {
  const id = ctx.server?.id;
  const list = ctx.savedServers?.() || [];
  const entry = list.find((s) => s.id === id);
  if (!entry) return;
  const known = [...new Set([...urls.filter(Boolean).map(normalize), ...(entry.socialUrls || []), entry.socialUrl].filter(Boolean))].slice(0, 4);
  if (JSON.stringify(known) === JSON.stringify(entry.socialUrls)) return;
  store.set('servers', list.map((s) => (s.id === id ? { ...s, socialUrls: known, socialUrl: undefined } : s)));
}

// Settings: set (or clear) the address by hand.
export async function setSocialUrl(url) {
  const id = ctx.server?.id;
  url = normalize(url);
  if (url) await ping(url, 6000);
  // A typed address goes first; clearing the field forgets them all (they'll be found again at home).
  store.set('servers', (ctx.savedServers?.() || []).map((s) => (s.id === id ? { ...s, socialUrl: undefined, socialUrls: url ? [url, ...(s.socialUrls || []).filter((x) => x !== url)] : undefined } : s)));
  found = null;
  finding = null;
  return url;
}

async function call(method, path, body) {
  const url = await waitForSocial({ maxMs: 90000 });
  if (!url) throw Object.assign(new Error('Sin servicio social'), { offline: true });
  let r;
  try {
    r = await fetch(url + path, {
      method,
      headers: { 'X-Jellyfin-Token': ctx.api.token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: timeoutSignal(10000),
    });
  } catch (e) {
    log(`social ${path}: ${e.message}`);
    throw new Error('No se pudo conectar con el servicio de amigos');
  }
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.error || `Error del servicio (${r.status})`);
  return j;
}

export const social = {
  available: () => socialUrl().then(Boolean),
  // Ratings and the rest, without "who has seen it" (slow: it asks Jellyfin about every user).
  item: (id) => call('GET', `/api/items/${id}?watched=0`),
  watched: (id) => call('GET', `/api/items/${id}/watched`),
  rate: (id, score) => call('PUT', `/api/items/${id}/rating`, { score }),
  watchlist: (id, on) => call(on ? 'PUT' : 'DELETE', `/api/watchlist/${id}`),
  recommend: (id, to, note) => call('POST', `/api/items/${id}/recommend`, { to, note }),
  dismiss: (recId) => call('DELETE', `/api/recommendations/${recId}`),
  users: () => call('GET', '/api/users'),
  inbox: () => call('GET', '/api/inbox'),
  stats: () => call('GET', '/api/stats'),
  me: () => call('GET', '/api/me'),
  // Requests for films and series that aren't on the server.
  catalog: (q, kind) => call('GET', `/api/catalog?q=${encodeURIComponent(q)}&kind=${kind}`),
  requests: () => call('GET', '/api/requests'),
  request: (body) => call('POST', '/api/requests', body),
  answerRequest: (id, body) => call('PUT', `/api/requests/${id}`, body),
  cancelRequest: (id) => call('DELETE', `/api/requests/${id}`),
  requestSeen: (id) => call('POST', `/api/requests/${id}/seen`),
  setHideWatched: (hide) => call('PUT', '/api/me', { hideWatched: !!hide }),
};
