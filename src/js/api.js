// Minimal Jellyfin REST client. Every request has a timeout so a slow or
// unreachable server can never freeze the app.
const CLIENT = 'Lumen';
const VERSION = '1.0.0';
const DEVICE = window.lumenHost ? 'Windows PC' : window.LumenTV ? 'Android TV' : 'Navegador';

export const LIST_FIELDS = 'PrimaryImageAspectRatio,Overview,Genres';
const CACHE_MS = 2 * 60 * 1000;
const DETAIL_FIELDS = 'Overview,Genres,People,Studios,Taglines,MediaSources,MediaStreams,Chapters,ProviderIds,ChildCount';
const IMAGE_QUERY = { EnableImageTypes: 'Primary,Backdrop,Thumb,Logo', ImageTypeLimit: 1 };

export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

export function normalizeUrl(input) {
  let u = String(input || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  return u.replace(/\/+$/, '').replace(/\/web(\/.*)?$/i, '');
}

async function timedFetch(url, opts = {}, timeout = 15000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } catch (e) {
    throw new ApiError(e.name === 'AbortError' ? 'El servidor tardó demasiado en responder' : 'No se pudo conectar con el servidor', 0);
  } finally {
    clearTimeout(timer);
  }
}

export async function probeServer(url, timeout = 5000) {
  const r = await timedFetch(url + '/System/Info/Public', {}, timeout);
  if (!r.ok) throw new ApiError(`El servidor respondió ${r.status}`, r.status);
  const info = await r.json().catch(() => null);
  if (!info?.Id) throw new ApiError('Esa dirección no parece un servidor Jellyfin');
  return info;
}

// Tries every address at once and resolves with the first that answers.
export function findReachable(urls, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const list = urls.filter(Boolean);
    if (!list.length) return reject(new ApiError('No hay ninguna dirección configurada'));
    let pending = list.length;
    let firstError = null;
    for (const url of list) {
      probeServer(url, timeout).then(
        (info) => resolve({ url, info }),
        (err) => {
          firstError ??= err;
          if (--pending === 0) reject(firstError);
        },
      );
    }
  });
}

export class Api {
  constructor({ url, token = null, userId = null, deviceId }) {
    this.url = url;
    this.token = token;
    this.userId = userId;
    this.deviceId = deviceId;
    this.onUnauthorized = null;
    this.cache = new Map();
  }

  authHeader() {
    let h = `MediaBrowser Client="${CLIENT}", Device="${DEVICE}", DeviceId="${this.deviceId}", Version="${VERSION}"`;
    if (this.token) h += `, Token="${this.token}"`;
    return h;
  }

  buildUrl(path, query) {
    const u = new URL(this.url + path);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, Array.isArray(v) ? v.join(',') : v);
    }
    return u.toString();
  }

  // GETs are cached briefly (and shared while in flight) so going back to a page is instant
  // and the NAS isn't asked the same thing twice. Any change (POST/DELETE) empties the cache.
  async req(path, opts = {}) {
    const method = opts.method || 'GET';
    if (method !== 'GET') {
      this.clearCache();
      return this.send(path, opts);
    }
    const key = this.buildUrl(path, opts.query);
    const hit = this.cache.get(key);
    if (hit && !opts.fresh && Date.now() - hit.t < CACHE_MS) return hit.p;
    const p = this.send(path, opts);
    this.cache.set(key, { t: Date.now(), p });
    p.catch(() => { if (this.cache.get(key)?.p === p) this.cache.delete(key); });
    return p;
  }

  clearCache() {
    this.cache.clear();
  }

  invalidate(test) {
    for (const key of [...this.cache.keys()]) if (test(key)) this.cache.delete(key);
  }

  async send(path, { method = 'GET', query, body, timeout = 15000 } = {}) {
    const headers = { Authorization: this.authHeader() };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let r;
    try {
      r = await timedFetch(this.buildUrl(path, query), {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }, timeout);
    } catch (e) {
      this.onNetworkError?.(e);
      throw e;
    }
    if (r.status === 401) {
      this.onUnauthorized?.();
      throw new ApiError('La sesión ha caducado', 401);
    }
    if (!r.ok) throw new ApiError(`Error del servidor (${r.status})`, r.status);
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  }

  // Newer servers moved user endpoints; fall back to the legacy path on older ones.
  async reqAlt(paths, opts) {
    let last;
    for (const p of paths) {
      try {
        return await this.req(p, opts);
      } catch (e) {
        last = e;
        if (![400, 404, 405].includes(e.status)) throw e;
      }
    }
    throw last;
  }

  async login(username, password) {
    const r = await this.req('/Users/AuthenticateByName', {
      method: 'POST',
      body: { Username: username, Pw: password || '' },
    });
    this.token = r.AccessToken;
    this.userId = r.User.Id;
    return r;
  }

  logout() {
    return this.req('/Sessions/Logout', { method: 'POST', timeout: 4000 }).catch(() => {});
  }

  me() {
    return this.reqAlt(['/Users/Me', `/Users/${this.userId}`], { timeout: 8000 });
  }

  async views() {
    const r = await this.reqAlt(['/UserViews', `/Users/${this.userId}/Views`], { query: { userId: this.userId } });
    return r.Items || [];
  }

  async resume(limit = 20) {
    const r = await this.reqAlt(['/UserItems/Resume', `/Users/${this.userId}/Items/Resume`], {
      query: { userId: this.userId, Limit: limit, MediaTypes: 'Video', Fields: LIST_FIELDS, ...IMAGE_QUERY },
    });
    return r.Items || [];
  }

  async nextUp({ limit = 20, seriesId } = {}) {
    const r = await this.req('/Shows/NextUp', {
      query: { userId: this.userId, Limit: limit, SeriesId: seriesId, Fields: LIST_FIELDS, EnableRewatching: false, ...IMAGE_QUERY },
    });
    return r.Items || [];
  }

  async latest(parentId, limit = 24) {
    const r = await this.reqAlt(['/Items/Latest', `/Users/${this.userId}/Items/Latest`], {
      query: { userId: this.userId, ParentId: parentId, Limit: limit, Fields: LIST_FIELDS, GroupItems: true, ...IMAGE_QUERY },
    });
    return Array.isArray(r) ? r : r?.Items || [];
  }

  items(query) {
    return this.reqAlt(['/Items', `/Users/${this.userId}/Items`], {
      query: { userId: this.userId, Fields: LIST_FIELDS, ...IMAGE_QUERY, ...query },
    });
  }

  item(id) {
    return this.reqAlt([`/Items/${id}`, `/Users/${this.userId}/Items/${id}`], {
      query: { userId: this.userId, Fields: DETAIL_FIELDS },
    });
  }

  async seasons(seriesId) {
    const r = await this.req(`/Shows/${seriesId}/Seasons`, { query: { userId: this.userId, Fields: 'Overview', ...IMAGE_QUERY } });
    return r.Items || [];
  }

  async episodes(seriesId, seasonId) {
    const r = await this.req(`/Shows/${seriesId}/Episodes`, {
      query: { userId: this.userId, SeasonId: seasonId, Fields: 'Overview,PrimaryImageAspectRatio', ...IMAGE_QUERY },
    });
    return r.Items || [];
  }

  async nextEpisode(item) {
    if (item.Type !== 'Episode' || !item.SeriesId) return null;
    const r = await this.req(`/Shows/${item.SeriesId}/Episodes`, {
      query: { userId: this.userId, StartItemId: item.Id, Limit: 2, Fields: 'Overview', ...IMAGE_QUERY },
    });
    const next = (r.Items || [])[1];
    return next && next.Id !== item.Id ? next : null;
  }

  async similar(id) {
    const r = await this.req(`/Items/${id}/Similar`, { query: { userId: this.userId, Limit: 16, Fields: LIST_FIELDS, ...IMAGE_QUERY } });
    return r.Items || [];
  }

  setPlayed(id, played) {
    const method = played ? 'POST' : 'DELETE';
    return this.reqAlt([`/UserPlayedItems/${id}`, `/Users/${this.userId}/PlayedItems/${id}`], { method, query: { userId: this.userId } });
  }

  // Resetting the saved position is what takes an item out of "Seguir viendo".
  clearResume(id) {
    return this.reqAlt([`/UserItems/${id}/UserData`, `/Users/${this.userId}/Items/${id}/UserData`], {
      method: 'POST',
      query: { userId: this.userId },
      body: { PlaybackPositionTicks: 0 },
    });
  }

  setFavorite(id, fav) {
    const method = fav ? 'POST' : 'DELETE';
    return this.reqAlt([`/UserFavoriteItems/${id}`, `/Users/${this.userId}/FavoriteItems/${id}`], { method, query: { userId: this.userId } });
  }

  playbackInfo(id, body) {
    // Read-only despite being a POST, so it leaves the cache alone.
    return this.send(`/Items/${id}/PlaybackInfo`, { method: 'POST', query: { userId: this.userId }, body, timeout: 30000 });
  }

  report(kind, body) {
    const path = { start: '/Sessions/Playing', progress: '/Sessions/Playing/Progress', stop: '/Sessions/Playing/Stopped' }[kind];
    const p = this.send(path, { method: 'POST', body, timeout: 8000 }).catch(() => {});
    // Once the server has the final position, drop only what depends on it (Seguir viendo,
    // A continuación, that item) and let the page update itself; everything else stays cached.
    if (kind === 'stop') {
      p.then(() => {
        this.invalidate((url) => /Resume|NextUp|Latest|UserItems|UserData/i.test(url) || url.includes(body.ItemId));
        this.onDataChanged?.();
      });
    }
    return p;
  }

  stopEncoding(playSessionId) {
    return this.send('/Videos/ActiveEncodings', {
      method: 'DELETE',
      query: { deviceId: this.deviceId, playSessionId },
      timeout: 5000,
    }).catch(() => {});
  }

  async segments(id) {
    try {
      const r = await this.req(`/MediaSegments/${id}`, { timeout: 5000 });
      return r?.Items || [];
    } catch {
      return [];
    }
  }

  async remoteImages(id, type) {
    const r = await this.req(`/Items/${id}/RemoteImages`, {
      query: { type, includeAllLanguages: true, Limit: 120 },
      timeout: 30000,
    });
    return r?.Images || [];
  }

  downloadRemoteImage(id, type, imageUrl) {
    return this.req(`/Items/${id}/RemoteImages/Download`, { method: 'POST', query: { type, imageUrl }, timeout: 30000 });
  }

  // Jellyfin expects the image as a base64 body with the image's content type.
  async uploadImage(id, type, file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const r = await timedFetch(this.buildUrl(`/Items/${id}/Images/${type}`), {
      method: 'POST',
      headers: { Authorization: this.authHeader(), 'Content-Type': file.type || 'image/jpeg' },
      body: btoa(bin),
    }, 60000);
    this.clearCache();
    if (!r.ok) throw new ApiError(r.status === 403 ? 'Necesitas ser administrador en Jellyfin para cambiar imágenes.' : `Error del servidor (${r.status})`, r.status);
  }

  image(id, type = 'Primary', { width, tag, blur, quality = 85 } = {}) {
    // TV boxes decode and raster slowly: cards are asked at the pixels they really fill on a 1280-wide
    // page (posters ~230 px, thumbs ~430 px), backdrops at 1280, quality 80 — the same from the sofa.
    if (window.LumenTV) {
      if (width) width = width <= 720 ? Math.round(width * 2 / 3) : Math.min(width, 1280);
      quality = Math.min(quality, 80);
    }
    return this.buildUrl(`/Items/${id}/Images/${type}`, { fillWidth: width, quality, tag, blur });
  }

  userImage() {
    return this.buildUrl(`/Users/${this.userId}/Images/Primary`, { fillWidth: 64, quality: 90 });
  }

  abs(path) {
    return /^https?:/i.test(path) ? path : this.url + path;
  }
}
