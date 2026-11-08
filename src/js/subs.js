// Spanish subtitles: when the audio isn't Spanish, pick Spanish subtitles (Castellano first);
// when it is, only forced Spanish subtitles (signs, foreign lines). If the file has none,
// ask the server's subtitle providers (e.g. OpenSubtitles) for one.
import { ctx } from './context.js';
import { toast } from './ui.js';
import { log, store } from './store.js';

const text = (s) => `${s.Title || ''} ${s.DisplayTitle || ''}`;
const IMAGE = /^(pgssub|pgs|dvdsub|dvbsub|vobsub|hdmv_pgs_subtitle|dvd_subtitle)$/i;

export function isSpanish(s) {
  return /^(spa|es|esp|es-[a-z]+)$/i.test(s.Language || '') || /espa[ñn]ol|castellano|spanish|latino/i.test(text(s));
}

function isForced(s) {
  return s.IsForced || /forz|forced/i.test(text(s));
}

function rank(s) {
  const t = text(s);
  let score = 0;
  if (/castellano|espa[ñn]a|es-es|\(es\)|european/i.test(t)) score += 3;
  if (/latino|latam|lat\b|mexic|es-419/i.test(t)) score -= 2;
  if (/sdh|\bcc\b|hearing|sordos/i.test(t)) score -= 1;
  if (!IMAGE.test(s.Codec || '')) score += 1; // text subtitles look sharper and work everywhere
  if (s.IsDefault) score += 0.5;
  return score;
}

const best = (list) => [...list].sort((a, b) => rank(b) - rank(a))[0];

// Returns { index, missing }: index is the subtitle stream to use (-1 = none, undefined = keep the
// server's choice); missing means the audio isn't Spanish and no Spanish subtitles exist.
// Subtitles picked by hand before pressing play ("Subtítulos" on the detail page), per item.
// -1 = none. They win over the automatic choice for every player.
const picked = new Map();
export function pickSubtitle(itemId, index) {
  if (index === undefined) picked.delete(itemId);
  else picked.set(itemId, index);
}
export function pickedSubtitle(itemId) {
  return picked.get(itemId);
}

export function chooseSubtitle(ms, audioIndex) {
  const streams = ms?.MediaStreams || [];
  const manual = ms && picked.get(ms.Id);
  if (manual === -1 || (manual !== undefined && streams.some((s) => s.Type === 'Subtitle' && s.Index === manual))) {
    return { index: manual, missing: false };
  }
  const audios = streams.filter((s) => s.Type === 'Audio');
  const audio = audios.find((a) => a.Index === (audioIndex ?? ms?.DefaultAudioStreamIndex)) || audios[0];
  if (!audio || !audio.Language || /^und$/i.test(audio.Language)) return { index: undefined, missing: false };
  const spanish = streams.filter((s) => s.Type === 'Subtitle' && isSpanish(s));
  if (isSpanish(audio)) {
    const forced = spanish.filter(isForced);
    return { index: forced.length ? best(forced).Index : -1, missing: false };
  }
  const full = spanish.filter((s) => !isForced(s));
  const pick = best(full.length ? full : spanish);
  return pick ? { index: pick.Index, missing: false } : { index: undefined, missing: true };
}

// Asks the server to find and download Spanish subtitles. Resolves with the new subtitle stream, or null.
// Each search asks OpenSubtitles and, when one is downloaded, makes the server re-read the file:
// an item where nothing was found isn't searched again automatically for a week.
const searching = new Set();
const MISS_MS = 7 * 24 * 3600 * 1000;
function recentlyMissed(id) {
  const t = store.get('subsMissed', {})[id];
  return t && Date.now() - t < MISS_MS;
}
function rememberMiss(id) {
  const now = Date.now();
  const list = Object.fromEntries(Object.entries(store.get('subsMissed', {})).filter(([, t]) => now - t < MISS_MS));
  list[id] = now;
  store.set('subsMissed', list);
}

export async function fetchSpanishSubtitles(item) {
  if (searching.has(item.Id) || recentlyMissed(item.Id)) return null;
  searching.add(item.Id);
  const api = ctx.api;
  try {
    toast('No hay subtítulos en español; buscándolos…');
    let results;
    try {
      results = await api.send(`/Items/${item.Id}/RemoteSearch/Subtitles/spa`, { timeout: 30000 });
    } catch (e) {
      rememberMiss(item.Id);
      toast(e.status === 403 ? 'Para descargar subtítulos hace falta un usuario administrador en Jellyfin.' : 'El servidor no tiene un buscador de subtítulos (instala el plugin OpenSubtitles en Jellyfin).', 'error');
      return null;
    }
    if (!results?.length) {
      rememberMiss(item.Id);
      toast('No se encontraron subtítulos en español para este vídeo.');
      return null;
    }
    const pick = [...results].sort((a, b) => (score(b) - score(a)))[0];
    const sub = await downloadSubtitle(item, pick.Id, isSpanish);
    if (sub) toast('Subtítulos en español añadidos');
    else toast('Se descargaron subtítulos pero el servidor aún no los muestra; estarán la próxima vez.');
    return sub;
  } catch (e) {
    log(`subs search: ${e.message}`);
    return null;
  } finally {
    searching.delete(item.Id);
  }
}

// Results from the server's subtitle providers (OpenSubtitles plugin) for one language (ISO 639-2).
export function searchSubtitles(item, lang) {
  return ctx.api.send(`/Items/${item.Id}/RemoteSearch/Subtitles/${lang}`, { timeout: 30000 });
}

// Downloads one result; the server saves the file next to the video and rescans the item. Waits for
// the new subtitle stream to show up and resolves with it (or null if it takes too long).
export async function downloadSubtitle(item, resultId, match = () => true) {
  const api = ctx.api;
  const streamsOf = (x) => x?.MediaStreams || x?.MediaSources?.[0]?.MediaStreams || [];
  const fetchItem = () => api.send(`/Items/${item.Id}`, { query: { userId: api.userId, Fields: 'MediaStreams,MediaSources' } }).catch(() => null);
  const before = new Set(streamsOf(await fetchItem()).filter((s) => s.Type === 'Subtitle' && s.IsExternal).map((s) => `${s.Index}|${s.Path || s.DisplayTitle}`));
  await api.send(`/Items/${item.Id}/RemoteSearch/Subtitles/${encodeURIComponent(resultId)}`, { method: 'POST', timeout: 60000 });
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const subs = streamsOf(await fetchItem()).filter((s) => s.Type === 'Subtitle' && s.IsExternal);
    const sub = subs.find((s) => !before.has(`${s.Index}|${s.Path || s.DisplayTitle}`) && match(s))
      || (i > 3 && subs.find((s) => match(s)));
    if (sub) {
      api.clearCache();
      await import('./mpv-player.js').then((m) => m.forgetProbe(item.Id)).catch(() => {});
      return sub;
    }
  }
  return null;
}

function score(r) {
  return (r.DownloadCount || 0) / 1000 + (r.CommunityRating || 0) + (/castellano|espa[ñn]a/i.test(`${r.Name} ${r.Comment || ''}`) ? 5 : 0) + (r.IsHashMatch ? 3 : 0);
}
