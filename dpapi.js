// Windows DPAPI (CryptProtectData) through koffi: encrypts small secrets with the Windows user's own
// key. Unlike Electron's safeStorage it keeps no key in a file of its own (Chromium's "Local State",
// which is only written on a clean exit), so a crash or a forced close never makes saved data unreadable.
const ENTROPY = Buffer.from('Lumen-session', 'utf8');
const CRYPTPROTECT_UI_FORBIDDEN = 0x1;

let api = null;
function load() {
  if (api !== null) return api;
  api = false;
  if (process.platform !== 'win32') return api;
  try {
    const koffi = require('koffi');
    const crypt32 = koffi.load('crypt32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const BLOB = koffi.struct('LUMEN_DATA_BLOB', { cbData: 'uint32_t', pbData: 'void *' });
    const sig = (name) => `bool __stdcall ${name}(LUMEN_DATA_BLOB *dataIn, void *desc, LUMEN_DATA_BLOB *entropy, void *reserved, void *prompt, uint32_t flags, _Out_ LUMEN_DATA_BLOB *dataOut)`;
    api = {
      koffi,
      protect: crypt32.func(sig('CryptProtectData')),
      unprotect: crypt32.func(sig('CryptUnprotectData')),
      free: kernel32.func('void * __stdcall LocalFree(void *mem)'),
    };
  } catch {
    api = false;
  }
  return api;
}

function call(fn, input) {
  const w = load();
  if (!w) throw new Error('DPAPI no disponible');
  const out = {};
  const ok = w[fn]({ cbData: input.length, pbData: input }, null, { cbData: ENTROPY.length, pbData: ENTROPY }, null, null, CRYPTPROTECT_UI_FORBIDDEN, out);
  if (!ok) throw new Error(`${fn === 'protect' ? 'CryptProtectData' : 'CryptUnprotectData'} falló`);
  try {
    return Buffer.from(w.koffi.decode(out.pbData, 'uint8_t', out.cbData));
  } finally {
    w.free(out.pbData);
  }
}

const available = () => !!load();
const encrypt = (text) => call('protect', Buffer.from(String(text), 'utf8')).toString('base64');
const decrypt = (b64) => call('unprotect', Buffer.from(String(b64), 'base64')).toString('utf8');

module.exports = { available, encrypt, decrypt };
