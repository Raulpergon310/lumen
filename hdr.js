// Windows HDR on demand: before an HDR film starts in mpv, turn on "Use HDR" for the screen the app is
// on (if the screen supports it and it is off), and turn it off again when playback ends — only if
// Lumen turned it on. Uses the same Win32 display API as Settings > Display > HDR (through koffi).
let api = null;

function load() {
  if (api !== null) return api;
  api = false;
  if (process.platform !== 'win32') return api;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    api = {
      sizes: user32.func('long __stdcall GetDisplayConfigBufferSizes(uint32_t flags, _Out_ uint32_t *numPaths, _Out_ uint32_t *numModes)'),
      query: user32.func('long __stdcall QueryDisplayConfig(uint32_t flags, _Inout_ uint32_t *numPaths, void *paths, _Inout_ uint32_t *numModes, void *modes, void *topology)'),
      get: user32.func('long __stdcall DisplayConfigGetDeviceInfo(void *packet)'),
      set: user32.func('long __stdcall DisplayConfigSetDeviceInfo(void *packet)'),
    };
  } catch {
    api = false;
  }
  return api;
}

const PATH_SIZE = 72;
const MODE_SIZE = 64;
const QDC_ONLY_ACTIVE_PATHS = 2;
const GET_ADVANCED_COLOR_INFO = 9;
const SET_ADVANCED_COLOR_STATE = 10;
const GET_ADVANCED_COLOR_INFO_2 = 15; // Windows 11 24H2+
const SET_HDR_STATE = 16; // Windows 11 24H2+

function packet(type, size, t) {
  const b = Buffer.alloc(size);
  b.writeUInt32LE(type, 0);
  b.writeUInt32LE(size, 4);
  b.writeUInt32LE(t.adapterLow, 8);
  b.writeInt32LE(t.adapterHigh, 12);
  b.writeUInt32LE(t.id, 16);
  return b;
}

// Active screens with their desktop rectangle (physical pixels) and HDR state.
function screens() {
  const w = load();
  if (!w) return [];
  const np = [0];
  const nm = [0];
  if (w.sizes(QDC_ONLY_ACTIVE_PATHS, np, nm) !== 0) return [];
  const paths = Buffer.alloc(np[0] * PATH_SIZE);
  const modes = Buffer.alloc(nm[0] * MODE_SIZE);
  if (w.query(QDC_ONLY_ACTIVE_PATHS, np, paths, nm, modes, null) !== 0) return [];
  const out = [];
  for (let i = 0; i < np[0]; i++) {
    const o = i * PATH_SIZE;
    const t = { adapterLow: paths.readUInt32LE(o + 20), adapterHigh: paths.readInt32LE(o + 24), id: paths.readUInt32LE(o + 28) };
    let rect = null;
    const mi = paths.readUInt32LE(o + 12); // source mode index
    if (mi < nm[0] && modes.readUInt32LE(mi * MODE_SIZE) === 1) {
      const m = mi * MODE_SIZE;
      rect = { width: modes.readUInt32LE(m + 16), height: modes.readUInt32LE(m + 20), x: modes.readInt32LE(m + 28), y: modes.readInt32LE(m + 32) };
    }
    const info = { ...t, rect, supported: false, on: false, modern: false };
    const p2 = packet(GET_ADVANCED_COLOR_INFO_2, 36, t);
    if (w.get(p2) === 0) {
      const v = p2.readUInt32LE(20);
      info.modern = true;
      info.supported = !!(v & (1 << 4));
      info.on = !!(v & (1 << 5));
    } else {
      const p1 = packet(GET_ADVANCED_COLOR_INFO, 32, t);
      if (w.get(p1) === 0) {
        const v = p1.readUInt32LE(20);
        info.supported = !!(v & 1) && !(v & 8);
        info.on = !!(v & 2);
      }
    }
    out.push(info);
  }
  return out;
}

function setHdr(s, on) {
  const w = load();
  if (!w) return false;
  const p = s.modern ? packet(SET_HDR_STATE, 24, s) : packet(SET_ADVANCED_COLOR_STATE, 24, s);
  p.writeUInt32LE(on ? 1 : 0, 20);
  return w.set(p) === 0;
}

function pick(point) {
  const list = screens().filter((s) => s.supported);
  if (!point || list.length <= 1) return list[0] || null;
  return list.find((s) => s.rect && point.x >= s.rect.x && point.x < s.rect.x + s.rect.width && point.y >= s.rect.y && point.y < s.rect.y + s.rect.height) || list[0];
}

let turnedOn = null; // the screen Lumen switched to HDR, to switch back later

// point: the window centre in physical pixels. Resolves with what happened.
async function enable(point, log = () => {}) {
  const s = pick(point);
  if (!s) return { state: 'unsupported' };
  if (s.on) return { state: 'already-on' };
  if (!setHdr(s, true)) { log('hdr: no se pudo activar'); return { state: 'failed' }; }
  turnedOn = s;
  log('hdr: activado para la reproducción');
  // The screen takes a moment to switch mode; mpv must start after, so it sees an HDR output.
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (screens().some((x) => x.id === s.id && x.adapterLow === s.adapterLow && x.on)) break;
  }
  await new Promise((r) => setTimeout(r, 600));
  return { state: 'enabled' };
}

function restore(log = () => {}) {
  if (!turnedOn) return false;
  const s = turnedOn;
  turnedOn = null;
  const ok = setHdr(s, false);
  log(ok ? 'hdr: desactivado al terminar' : 'hdr: no se pudo desactivar');
  return ok;
}

module.exports = { screens, enable, restore };
