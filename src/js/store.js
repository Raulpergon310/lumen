// Persistent settings: Electron config file when available, localStorage in a plain browser.
const host = window.lumenHost;
let cache = {};

export const store = {
  load() {
    try {
      cache = host ? host.getAll() || {} : JSON.parse(localStorage.getItem('lumen') || '{}');
    } catch {
      cache = {};
    }
    if (!cache.deviceId) this.set('deviceId', newId());
    return cache;
  },
  get(key, fallback) {
    return cache[key] ?? fallback;
  },
  set(key, value) {
    if (value === undefined) delete cache[key];
    else cache[key] = value;
    if (host) {
      host.set(key, value);
    } else {
      try { localStorage.setItem('lumen', JSON.stringify(cache)); } catch {}
    }
  },
};

export function log(msg) {
  if (host) host.log(msg);
  else if (window.LumenTV) window.LumenTV.log(String(msg));
  else console.warn('[lumen]', msg);
}

export function keepAwake(on) {
  host?.keepAwake(on);
  window.LumenTV?.keepAwake(!!on);
}

// crypto.randomUUID only exists on https pages; the Android TV app serves the UI over http.
function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = [...b].map((v) => v.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
