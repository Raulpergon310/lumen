// Spanish subtitles: when the audio isn't Spanish, pick Spanish subtitles (Castellano first);
// when it is, only forced Spanish subtitles (signs, foreign lines). If the file has none,
// ask the server's subtitle providers (e.g. OpenSubtitles) for one.
import { ctx } from './context.js';
import { toast } from './ui.js';
import { log } from './store.js';

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
export function chooseSubtitle(ms, audioIndex) {
  const streams = ms?.MediaStreams || [];
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
const searching = new Set();
export async function fetchSpanishSubtitles(item) {
  if (searching.has(item.Id)) return null;
  searching.add(item.Id);
  const api = ctx.api;
  try {
    toast('No hay subtítulos en español; buscándolos…');
    let results;
    try {
      results = await api.send(`/Items/${item.Id}/RemoteSearch/Subtitles/spa`, { timeout: 30000 });
    } catch (e) {
      toast(e.status === 403 ? 'Para descargar subtítulos hace falta un usuario administrador en Jellyfin.' : 'El servidor no tiene un buscador de subtítulos (instala el plugin OpenSubtitles en Jellyfin).', 'error');
      return null;
    }
    if (!results?.length) {
      toast('No se encontraron subtítulos en español para este vídeo.');
      return null;
    }
    const pick = [...results].sort((a, b) => (score(b) - score(a)))[0];
    await api.send(`/Items/${item.Id}/RemoteSearch/Subtitles/${encodeURIComponent(pick.Id)}`, { method: 'POST', timeout: 60000 });
    // The server saves the file and rescans the item; wait for the new stream to show up.
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const fresh = await api.send(`/Items/${item.Id}`, { query: { userId: api.userId, Fields: 'MediaStreams,MediaSources' } }).catch(() => null);
      const sub = (fresh?.MediaStreams || fresh?.MediaSources?.[0]?.MediaStreams || []).find((s) => s.Type === 'Subtitle' && s.IsExternal && isSpanish(s));
      if (sub) {
        api.clearCache();
        toast('Subtítulos en español añadidos');
        return sub;
      }
    }
    toast('Se descargaron subtítulos pero el servidor aún no los muestra; estarán la próxima vez.');
    return null;
  } catch (e) {
    log(`subs search: ${e.message}`);
    return null;
  } finally {
    searching.delete(item.Id);
  }
}

function score(r) {
  return (r.DownloadCount || 0) / 1000 + (r.CommunityRating || 0) + (/castellano|espa[ñn]a/i.test(`${r.Name} ${r.Comment || ''}`) ? 5 : 0) + (r.IsHashMatch ? 3 : 0);
}
