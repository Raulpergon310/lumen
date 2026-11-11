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
    plan = playbackPlan(ms, { external: store.get('player', 'auto') === 'auto' && hasVlc() });
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

  // Saved before VLC opens: if Android recreates the app while VLC plays (it does when VLC switches the
  // TV to 4K/HDR), the reloaded page still knows what was playing and reports where it stopped.
  const pending = {
    itemId: item.Id, mediaSourceId: ms.Id, playSessionId, start,
    runtime: (item.RunTimeTicks || 0) / TICKS, at: Date.now(), serverId: store.get('activeServer'),
  };
  store.set('vlcPending', pending);
  try { window.LumenTV.takeExternalResult?.(); } catch {} // drop any stale answer
  api.report('start', { ...reportBase(pending), PositionTicks: Math.round(start * TICKS) });

  return new Promise((resolve) => {
    vlcDone = resolve;
    window.LumenTV.playExternal(url, title, Math.round(start * 1000), subUrl);
  });
}

let vlcDone = null;

function reportBase(p) {
  return { ItemId: p.itemId, MediaSourceId: p.mediaSourceId, PlaySessionId: p.playSessionId, PlayMethod: 'DirectPlay', CanSeek: true };
}

// Where VLC stopped, in seconds. VLC reports -1/0 when it couldn't tell (some versions do that when the
// film ends): then, if it was open about as long as what was left, the film was finished; otherwise
// the saved position stays as it was.
function stoppedAt(p, posMs, durMs, wallMs) {
  if (posMs > 0) {
    const dur = durMs > 0 ? durMs / 1000 : p.runtime;
    // Stopped in the credits: count it as watched.
    if (dur && posMs / 1000 >= dur - Math.min(180, dur * 0.05)) return dur;
    return posMs / 1000;
  }
  const left = p.runtime - p.start;
  if (p.runtime && left > 0 && wallMs >= left * 1000 * 0.9) return p.runtime;
  return p.start;
}

// Called by the Android side when VLC answers, and on startup (the answer may have arrived while the
// page was being reloaded). Safe to call any time: does nothing without a pending VLC session.
export async function finishVlcSession() {
  const p = store.get('vlcPending');
  let raw = '';
  try { raw = window.LumenTV?.takeExternalResult?.() || ''; } catch {}
  if (!p) return;
  if (!raw) {
    // No answer yet (VLC still open, or it was left with Home): keep waiting, but not forever.
    if (Date.now() - p.at > 12 * 3600 * 1000) store.set('vlcPending', undefined);
    return;
  }
  const [posMs, durMs, ok, when] = raw.split(',').map(Number);
  store.set('vlcPending', undefined);
  const done = vlcDone;
  vlcDone = null;
  if (!ok) toast('No se pudo abrir VLC', 'error');
  const api = ctx.api;
  if (api && p.serverId === store.get('activeServer')) {
    const sec = ok ? stoppedAt(p, posMs, durMs, (when || Date.now()) - p.at) : p.start;
    log(`vlc stop ${p.itemId} pos=${posMs} dur=${durMs} -> ${Math.round(sec)}s`);
    await api.report('stop', { ...reportBase(p), PositionTicks: Math.round(sec * TICKS) });
  }
  done?.();
}

if (window.LumenTV) window.lumenTvExternalResult = () => { finishVlcSession(); };
