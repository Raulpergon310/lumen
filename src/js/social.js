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
let found = null; // { api, url } | { api, url: null }
let finding = null;

// Where to look: the address saved for this server, one from an invitation link (?social=…),
// and the Jellyfin machine itself on the default port (http servers only: an https page can't
// talk to a plain http service).
function candidates() {
  const server = ctx.savedServers?.().find((s) => s.id === ctx.server?.id);
  const list = [server?.socialUrl, new URLSearchParams(location.search).get('social')];
  try {
    const u = new URL(ctx.api.url);
    if (u.protocol === 'http:') list.push(`http://${u.hostname}:${PORT}`);
    for (const alt of server?.urls || []) {
      const a = new URL(alt);
      if (a.protocol === 'http:') list.push(`http://${a.hostname}:${PORT}`);
    }
  } catch {}
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

// The service's address for the current server, or null. Looked up once per session.
export function socialUrl() {
  const api = ctx.api;
  if (!api) return Promise.resolve(null);
  if (found?.api === api) return Promise.resolve(found.url);
  if (finding?.api === api) return finding.p;
  const p = (async () => {
    for (const url of candidates()) {
      try {
        await ping(url);
        remember(url);
        found = { api, url };
        return url;
      } catch {}
    }
    found = { api, url: null };
    return null;
  })();
  finding = { api, p };
  return p;
}

function remember(url) {
  const id = ctx.server?.id;
  const list = ctx.savedServers?.() || [];
  if (!id || list.find((s) => s.id === id)?.socialUrl === url) return;
  store.set('servers', list.map((s) => (s.id === id ? { ...s, socialUrl: url } : s)));
}

// Settings: set (or clear) the address by hand.
export async function setSocialUrl(url) {
  const id = ctx.server?.id;
  url = normalize(url);
  if (url) await ping(url, 6000);
  store.set('servers', (ctx.savedServers?.() || []).map((s) => (s.id === id ? { ...s, socialUrl: url || undefined } : s)));
  found = null;
  finding = null;
  return url;
}

async function call(method, path, body) {
  const url = await socialUrl();
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
  item: (id) => call('GET', `/api/items/${id}`),
  rate: (id, score) => call('PUT', `/api/items/${id}/rating`, { score }),
  watchlist: (id, on) => call(on ? 'PUT' : 'DELETE', `/api/watchlist/${id}`),
  recommend: (id, to, note) => call('POST', `/api/items/${id}/recommend`, { to, note }),
  dismiss: (recId) => call('DELETE', `/api/recommendations/${recId}`),
  users: () => call('GET', '/api/users'),
  inbox: () => call('GET', '/api/inbox'),
  stats: () => call('GET', '/api/stats'),
};
