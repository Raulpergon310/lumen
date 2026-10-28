// Android TV: what the desktop sends to mpv goes to VLC here — 4K, HDR/Dolby Vision, odd formats and
// image subtitles. VLC draws straight to the screen with the hardware decoder and plays the original
// file (no work for the NAS); the WebView drops a third of the frames on 4K. Progress is synced with Jellyfin.
import { ctx } from './context.js';
import { store, log } from './store.js';
import { toast } from './ui.js';
import { playbackPlan } from './compat.js';
import { chooseSubtitle } from './subs.js';

const TICKS = 1e7;

export function hasVlc() {
  try { return !!window.LumenTV?.hasExternalPlayer?.(); } catch { return false; }
}

// 'remux' (only the audio converted by the server, cheap) stays in the app, which has "Saltar intro",
// next episode and the subtitle menu; VLC is for what the app can't show well.
function needsVlc(ms, plan) {
  const v = (ms.MediaStreams || []).find((s) => s.Type === 'Video');
  return plan.mode === 'mpv' || (v && (v.Width > 1920 || v.Height > 1080));
}

export async function startTvPlayback(item, opts) {
  const { probeInfo, forgetProbe } = await import('./mpv-player.js');
  let probe = null;
  let plan = { mode: 'direct' };
  try {
    probe = await probeInfo(item);
    forgetProbe(item.Id);
    const ms = probe?.MediaSources?.[0];
    const choice = chooseSubtitle(ms);
    if (ms && choice.index !== undefined) ms.DefaultSubtitleStreamIndex = choice.index;
    plan = playbackPlan(ms);
    if (ctx.launch?.cancelled) return null; // Back was pressed while the server was answering
    if (ms && store.get('player', 'auto') === 'auto' && hasVlc() && needsVlc(ms, plan)) {
      return await openVlc(item, ms, opts);
    }
  } catch (e) {
    log(`probe ${item.Id}: ${e.message}`);
  }
  if (ctx.launch?.cancelled) return null;
  const { openPlayer } = await import('./player.js');
  return openPlayer(item, { ...opts, plan, probe });
}

function openVlc(item, ms, { fromStart = false, startSec } = {}) {
  const api = ctx.api;
  const ud = item.UserData || {};
  let start = startSec ?? (fromStart || ud.Played ? 0 : (ud.PlaybackPositionTicks || 0) / TICKS);
  if (item.RunTimeTicks && start > item.RunTimeTicks / TICKS - 15) start = 0;

  const playSessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const url = api.buildUrl(`/Videos/${item.Id}/stream`, {
    static: true, MediaSourceId: ms.Id, PlaySessionId: playSessionId, DeviceId: api.deviceId, api_key: api.token,
  });
  // Subtitles inside the file VLC finds by itself; a separate subtitle file has to be handed over.
  const sub = (ms.MediaStreams || []).find((s) => s.Type === 'Subtitle' && s.Index === ms.DefaultSubtitleStreamIndex && s.IsExternal);
  const subUrl = sub ? api.buildUrl(`/Videos/${item.Id}/${ms.Id}/Subtitles/${sub.Index}/0/Stream.${sub.Codec === 'ass' ? 'ass' : 'srt'}`, { api_key: api.token }) : '';
  const title = item.Type === 'Episode' ? `${item.SeriesName} — ${item.Name}` : item.Name;

  const base = { ItemId: item.Id, MediaSourceId: ms.Id, PlaySessionId: playSessionId, PlayMethod: 'DirectPlay', CanSeek: true };
  api.report('start', { ...base, PositionTicks: Math.round(start * TICKS) });

  return new Promise((resolve) => {
    window.lumenTvExternalDone = (posMs, durMs, ok) => {
      window.lumenTvExternalDone = null;
      if (!ok) toast('No se pudo abrir VLC', 'error');
      // VLC reports -1/0 when it couldn't tell; then the saved position stays as it was.
      const ticks = posMs > 0 ? posMs * 1e4 : Math.round(start * TICKS);
      api.report('stop', { ...base, PositionTicks: ticks });
      resolve();
    };
    window.LumenTV.playExternal(url, title, Math.round(start * 1000), subUrl);
  });
}
