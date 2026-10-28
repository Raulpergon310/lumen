// Plays the original file in mpv (always direct play): HDR / Dolby Vision tone mapping,
// every audio codec (Atmos, TrueHD, DTS…), styled anime subtitles. Progress is synced with Jellyfin.
import { ctx } from './context.js';
import { h, button, episodeLabel } from './ui.js';
import { store, log, keepAwake } from './store.js';
import { backdropSrc, logoSrc, thumbSrc } from './media.js';
import { deviceProfile } from './profile.js';
import { chooseSubtitle, fetchSpanishSubtitles } from './subs.js';

const TICKS = 1e7;
const host = window.lumenHost;
const TEXT_SUBS = /^(srt|subrip|ass|ssa|vtt|webvtt|sub|smi|ttml|mov_text)$/i;

// Tell the server this client can play anything as-is.
const UNIVERSAL_PROFILE = {
  Name: 'Lumen (mpv)',
  MaxStreamingBitrate: 1_000_000_000,
  MaxStaticBitrate: 1_000_000_000,
  DirectPlayProfiles: [{ Type: 'Video' }, { Type: 'Audio' }],
  TranscodingProfiles: [],
  ContainerProfiles: [],
  CodecProfiles: [],
  SubtitleProfiles: ['srt', 'subrip', 'ass', 'ssa', 'vtt', 'pgssub', 'pgs', 'dvdsub', 'dvbsub', 'sub', 'smi', 'ttml']
    .flatMap((Format) => [{ Format, Method: 'Embed' }, { Format, Method: 'External' }]),
};

let available = null;
export async function mpvAvailable() {
  if (available === null) available = !!host?.mpv && (await host.mpv.available().catch(() => false));
  return available;
}

// The file's real streams plus the user's default audio/subtitle choice, without starting playback.
// Cached for a few minutes: the detail page asks ahead of time so pressing play is instant, and for
// files the app plays as-is the built-in player reuses this answer instead of asking again.
const probes = new Map();
const PROBE_MS = 3 * 60 * 1000;

export function probeInfo(item) {
  const api = ctx.api;
  const hit = probes.get(item.Id);
  if (hit && hit.api === api && Date.now() - hit.t < PROBE_MS) return hit.p;
  const p = api.playbackInfo(item.Id, {
    UserId: api.userId,
    DeviceProfile: deviceProfile(store.get('maxBitrate', 0) || undefined),
    MaxStreamingBitrate: 200_000_000,
    EnableDirectPlay: true,
    EnableDirectStream: false,
    EnableTranscoding: false,
    IsPlayback: false,
  });
  probes.set(item.Id, { t: Date.now(), p, api });
  p.catch(() => probes.delete(item.Id));
  return p;
}

export async function probeSource(item) {
  const info = await probeInfo(item);
  return info?.MediaSources?.[0] || null;
}

// Wake the NAS disk and pull the file's header and index (MKV keeps it at the end) into its cache
// while the user is still looking at the detail page, so pressing play starts without a cold read.
const warmed = new Set();
export async function warmFile(item) {
  if (warmed.has(item.Id)) return;
  warmed.add(item.Id);
  const api = ctx.api;
  const url = api.buildUrl(`/Videos/${item.Id}/stream`, { static: true, api_key: api.token });
  for (const range of ['bytes=0-1048575', 'bytes=-1048576']) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 15000);
      const r = await fetch(url, { headers: { Range: range }, signal: ctl.signal });
      await r.arrayBuffer();
      clearTimeout(t);
    } catch {}
  }
}

export function addSubtitleToSession(item, sub) {
  session?.addSub(item, sub);
}

export function forgetProbe(id) {
  probes.delete(id);
}

let session = null;

// Called when the app window closes: tell the server where playback stopped, then close mpv.
export async function stopMpvForExit() {
  if (!session) return;
  if (session.loaded) await session.report('stop');
  await host.mpv.stop();
}

export async function openMpv(item, opts = {}) {
  if (!session) session = new MpvSession();
  try {
    await session.play(item, opts);
  } catch (e) {
    log(`mpv play: ${e.stack || e.message}`);
    session.warn(e.message, item);
  }
}

class MpvSession {
  constructor() {
    this.running = false;
    this.off = host.mpv.onEvent((e) => this.onEvent(e));
    this.overlay = h('div', { class: 'mpv-overlay' });
    document.getElementById('player-root').replaceChildren(this.overlay);
    keepAwake(true);
  }

  async play(item, { fromStart = false, startSec, probe } = {}) {
    const api = ctx.api;
    this.item = item;
    this.loaded = false;
    this.stopping = false;
    this.pos = 0;
    this.duration = (item.RunTimeTicks || 0) / TICKS;
    this.segments = [];
    this.next = null;
    this.nextAnnounced = false;
    this.skipped = new Set();
    this.lastHint = 0;
    this.skipLabel = null;
    this.renderOverlay('Abriendo…');

    const ud = item.UserData || {};
    let start = startSec ?? (fromStart || ud.Played ? 0 : (ud.PlaybackPositionTicks || 0) / TICKS);
    if (this.duration && start > this.duration - 15) start = 0;

    // The answer fetched ahead of time (detail page / hover) already has everything mpv needs.
    const info = probe?.MediaSources?.[0] ? probe : await api.playbackInfo(item.Id, {
      UserId: api.userId,
      DeviceProfile: UNIVERSAL_PROFILE,
      MaxStreamingBitrate: 1_000_000_000,
      StartTimeTicks: Math.floor(start * TICKS),
      EnableDirectPlay: true,
      EnableDirectStream: false,
      EnableTranscoding: false,
      AutoOpenLiveStream: true,
      IsPlayback: true,
    });
    if (info.ErrorCode) throw new Error(playbackError(info.ErrorCode));
    const ms = info.MediaSources?.[0];
    if (!ms) throw new Error('El servidor no devolvió el archivo de vídeo.');
    this.ms = ms;
    this.playSessionId = info.PlaySessionId;
    this.audioIndex = ms.DefaultAudioStreamIndex;
    const subChoice = chooseSubtitle(ms, this.audioIndex);
    this.subIndex = subChoice.index ?? ms.DefaultSubtitleStreamIndex ?? -1;
    if (subChoice.missing) fetchSpanishSubtitles(item).then((sub) => sub && this.addSub(item, sub));

    const url = api.buildUrl(`/Videos/${item.Id}/stream`, {
      static: true,
      mediaSourceId: ms.Id,
      deviceId: api.deviceId,
      api_key: api.token,
      PlaySessionId: this.playSessionId,
      Tag: ms.ETag,
    });

    const externalSubs = this.externalSubs();
    const isEp = item.Type === 'Episode';
    const title = isEp ? `${item.SeriesName} · ${episodeLabel(item)} · ${item.Name}` : item.Name;
    const opts = {
      start: start > 0 ? start.toFixed(2) : undefined,
      'force-media-title': title,
      aid: this.mpvTrackId('Audio', this.audioIndex),
      sid: this.mpvTrackId('Subtitle', this.subIndex),
      alang: langPref(ctx.user?.Configuration?.AudioLanguagePreference, 'spa,es,jpn,ja,eng,en'),
      slang: langPref(ctx.user?.Configuration?.SubtitleLanguagePreference, 'spa,es,eng,en'),
      'sub-files': externalSubs.map((s) => s.url).join(';') || undefined,
    };

    this.ui({
      title: isEp ? item.SeriesName : item.Name,
      subtitle: isEp ? `${episodeLabel(item)} · ${item.Name}` : '',
      modeDetail: describeSource(ms, this.audioIndex),
      hasNext: false,
      skip: null,
      upNext: null,
      segments: [],
      loading: true,
    }, true);

    if (this.running) {
      await host.mpv.command(['loadfile', url, 'replace', -1, encodeOpts(opts)]);
    } else {
      const args = Object.entries(opts).filter(([, v]) => v !== undefined).map(([k, v]) => `--${k}=${v}`);
      this.running = true;
      await host.mpv.start(['--idle=yes', ...args, '--', url], { embed: store.get('mpvEmbedded', true) });
    }

    api.segments(item.Id).then((s) => {
      this.segments = s;
      this.ui({ segments: s.filter((x) => ['Intro', 'Outro', 'Recap'].includes(x.Type)).map((x) => ({ start: x.StartTicks / TICKS, end: x.EndTicks / TICKS })) });
    });
    api.nextEpisode(item).then((n) => { this.next = n; this.ui({ hasNext: !!n }); }).catch(() => {});
    log(`mpv play ${item.Id}`);
  }

  externalSubs() {
    const api = ctx.api;
    return (this.ms.MediaStreams || [])
      .filter((s) => s.Type === 'Subtitle' && s.IsExternal && TEXT_SUBS.test(s.Codec || ''))
      .map((s) => ({
        stream: s,
        url: api.abs(s.DeliveryUrl || `/Videos/${this.item.Id}/${this.ms.Id}/Subtitles/${s.Index}/0/Stream.${s.Codec}?api_key=${api.token}`),
      }));
  }

  // Jellyfin stream index -> mpv track id (embedded tracks in file order, external subs after them).
  mpvTrackId(type, index) {
    if (index == null || index < 0) return type === 'Subtitle' ? 'no' : 'auto';
    const streams = this.ms.MediaStreams || [];
    const target = streams.find((s) => s.Index === index && s.Type === type);
    if (!target) return 'auto';
    const embedded = streams.filter((s) => s.Type === type && !s.IsExternal);
    if (!target.IsExternal) return String(embedded.indexOf(target) + 1);
    const ext = this.externalSubs().map((x) => x.stream);
    const i = ext.indexOf(target);
    return i >= 0 ? String(embedded.length + i + 1) : 'auto';
  }

  onEvent(e) {
    switch (e.event) {
      case 'file-loaded':
        this.loaded = true;
        this.renderOverlay('Reproduciendo');
        this.ui({ loading: false });
        this.report('start');
        clearInterval(this.timer);
        this.timer = setInterval(() => this.report('progress'), 10000);
        break;
      case 'property-change':
        if (e.name === 'time-pos' && typeof e.data === 'number') this.onTime(e.data);
        else if (e.name === 'duration' && e.data) this.duration = e.data;
        else if (e.name === 'pause') { this.paused = !!e.data; if (this.loaded) this.report('progress'); }
        else if (e.name === 'volume') this.volume = e.data;
        else if (e.name === 'mute') this.muted = !!e.data;
        break;
      case 'client-message':
        if (e.args?.[0] === 'lumen-skip') this.skipCurrent(true);
        if (e.args?.[0] === 'lumen-next') this.playNext();
        break;
      case 'end-file':
        if (e.reason === 'eof') this.onEnded();
        else if (e.reason === 'error') { this.failed = e.file_error || 'error'; host.mpv.stop(); }
        break;
      case 'stopping':
        this.stopping = true;
        this.leave();
        break;
      case 'process-exit':
        this.onExit(e);
        break;
      case 'overlay-ready':
        this.ui(this.uiState, true);
        break;
      default:
    }
  }

  onTime(t) {
    this.pos = t;
    const seg = this.currentSegment(t);
    if (seg) {
      if (store.get('autoSkipIntro', false) && !this.skipped.has(seg)) {
        this.skipCurrent(false);
      } else {
        this.setSkip({ Intro: 'Saltar intro', Recap: 'Saltar resumen', Preview: 'Saltar avance' }[seg.Type]);
      }
    } else {
      this.setSkip(null);
    }
    if (this.next && !this.nextAnnounced && this.duration > 300) {
      const outro = this.segments.find((s) => s.Type === 'Outro');
      const inCredits = outro ? t >= outro.StartTicks / TICKS : this.duration - t <= 35;
      if (inCredits) {
        this.nextAnnounced = true;
        this.ui({ upNext: { title: `${episodeLabel(this.next)}  ${this.next.Name}`, art: thumbSrc(ctx.api, this.next, 480) } });
      }
    }
  }

  currentSegment(t) {
    return this.segments.find((s) => ['Intro', 'Recap', 'Preview'].includes(s.Type)
      && t >= s.StartTicks / TICKS && t < s.EndTicks / TICKS - 1);
  }

  skipCurrent(manual) {
    const seg = this.currentSegment(this.pos);
    if (!seg) return;
    this.skipped.add(seg);
    host.mpv.command(['set_property', 'time-pos', seg.EndTicks / TICKS]);
    this.osd(manual ? 'Saltado' : 'Intro saltada automáticamente', 1500);
  }

  osd(text, ms) {
    host.mpv.command(['show-text', text, ms]);
  }

  // State for the controls drawn over the embedded video (kept so a reloaded overlay can catch up).
  ui(patch, replace = false) {
    this.uiState = replace ? { ...patch } : { ...this.uiState, ...patch };
    host.overlay?.send(replace ? this.uiState : patch);
  }

  // A subtitle downloaded after playback began: load it into mpv and switch to it.
  addSub(item, sub) {
    if (!this.running || this.item?.Id !== item.Id) return;
    const api = ctx.api;
    const url = api.abs(sub.DeliveryUrl || `/Videos/${item.Id}/${this.ms.Id}/Subtitles/${sub.Index}/0/Stream.${sub.Codec || 'srt'}?api_key=${api.token}`);
    host.mpv.command(['sub-add', url, 'select', 'Español', 'spa']);
    this.subIndex = sub.Index;
  }

  setSkip(label) {
    if (label === this.skipLabel) return;
    this.skipLabel = label;
    this.ui({ skip: label });
  }

  async onEnded() {
    this.pos = this.duration || this.pos;
    if (this.next && store.get('autoplayNext', true)) {
      await this.playNext();
    } else {
      host.mpv.stop();
    }
  }

  async playNext() {
    const n = this.next;
    if (!n) return;
    await this.report('stop');
    clearInterval(this.timer);
    try {
      await this.play(n, { fromStart: true });
    } catch (e) {
      this.warn(e.message, n);
      host.mpv.stop();
    }
  }

  async onExit(e) {
    if (this.left) return;
    clearInterval(this.timer);
    this.running = false;
    if (!this.loaded && !this.stopping) {
      const reason = this.failed || (e.error ? `mpv no se pudo abrir (${e.error})` : 'mpv se cerró sin poder abrir el archivo');
      this.warn(`No se pudo reproducir el archivo original: ${reason}.`, this.item);
      return;
    }
    this.leave();
  }

  // Back to the menu straight away; the server hears about the stop in the background.
  leave() {
    if (this.left) return;
    this.left = true;
    clearInterval(this.timer);
    this.running = false;
    if (this.loaded) this.report('stop');
    this.dispose();
    ctx.refresh({ quiet: true });
  }

  reportBody() {
    return {
      ItemId: this.item.Id,
      MediaSourceId: this.ms?.Id,
      PlaySessionId: this.playSessionId,
      PositionTicks: Math.floor((this.pos || 0) * TICKS),
      IsPaused: !!this.paused,
      IsMuted: !!this.muted,
      VolumeLevel: Math.round(this.volume ?? 100),
      PlayMethod: 'DirectPlay',
      AudioStreamIndex: this.audioIndex,
      SubtitleStreamIndex: this.subIndex,
      CanSeek: true,
    };
  }

  report(kind) {
    if (!this.playSessionId || !ctx.api) return Promise.resolve();
    return ctx.api.report(kind, this.reportBody());
  }

  renderOverlay(status) {
    const api = ctx.api;
    const item = this.item;
    const bg = backdropSrc(api, item, 1920);
    const logo = logoSrc(api, item);
    this.overlay.replaceChildren(
      bg ? h('img', { class: 'mpv-bg', src: bg, alt: '' }) : null,
      h('div', { class: 'mpv-shade' }),
      h('div', { class: 'mpv-info' },
        h('div', { class: 'card-eyebrow' }, status),
        h('div', { class: 'p-mode p-mode-direct inline' }, h('span', { class: 'p-mode-dot' }), h('span', { class: 'p-mode-label' }, 'Reproducción directa'), h('span', { class: 'p-mode-detail' }, 'Archivo original, sin convertir')),
        logo ? h('img', { class: 'detail-logo', src: logo, alt: item.Name }) : h('h1', { class: 'detail-title' }, item.SeriesName || item.Name),
        item.Type === 'Episode' ? h('p', { class: 'muted' }, `${episodeLabel(item)} · ${item.Name}`) : null,
        h('p', { class: 'muted small' }, 'Espacio pausa, ←/→ salta, A cambia audio, C subtítulos, S salta la intro, N siguiente, Esc sale.'),
        h('div', { class: 'actions' }, button('Detener', { kind: 'primary', onclick: () => host.mpv.stop() }))));
  }

  warn(message, item) {
    this.running = false;
    this.overlay.replaceChildren(h('div', { class: 'p-error' }, h('div', { class: 'glass-card' },
      h('h2', null, 'No se puede reproducir en directo'),
      h('p', { class: 'muted' }, message),
      h('p', { class: 'muted small' }, 'Puedes pedir al servidor que lo convierta (más carga para el servidor y algo menos de calidad).'),
      h('div', { class: 'actions' },
        button('Convertir en el servidor', {
          kind: 'primary',
          onclick: async () => {
            this.dispose();
            const { openPlayer } = await import('./player.js');
            openPlayer(item, { forceTranscode: true });
          },
        }),
        button('Cerrar', { onclick: () => { this.dispose(); ctx.refresh(); } })))));
  }

  dispose() {
    clearInterval(this.timer);
    this.off?.();
    this.overlay.remove();
    keepAwake(false);
    if (session === this) session = null;
  }
}

// mpv loadfile options: values are length-prefixed so titles with commas survive.
// "Archivo original · HEVC 4K HDR10 · TrueHD 7.1"
function describeSource(ms, audioIndex) {
  const streams = ms.MediaStreams || [];
  const v = streams.find((s) => s.Type === 'Video');
  const a = streams.find((s) => s.Type === 'Audio' && s.Index === audioIndex) || streams.find((s) => s.Type === 'Audio');
  const rt = v?.VideoRangeType || '';
  const range = /DOVI/i.test(rt) ? 'Dolby Vision' : /HDR10Plus/i.test(rt) ? 'HDR10+' : rt && rt !== 'SDR' ? rt : '';
  const res = v?.Height ? (v.Height >= 2000 ? '4K' : `${v.Height}p`) : '';
  const ch = a?.Channels ? ({ 1: 'mono', 2: 'estéreo', 6: '5.1', 8: '7.1' }[a.Channels] || `${a.Channels} canales`) : '';
  const atmos = /atmos/i.test(`${a?.DisplayTitle || ''} ${a?.Profile || ''}`) ? 'Atmos' : '';
  const video = v ? [String(v.Codec || '').toUpperCase(), res, range].filter(Boolean).join(' ') : '';
  const audio = a ? [String(a.Codec || '').toUpperCase(), ch, atmos].filter(Boolean).join(' ') : '';
  return ['Archivo original', video, audio].filter(Boolean).join(' · ');
}

function encodeOpts(opts) {
  return Object.entries(opts)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=%${new TextEncoder().encode(String(v)).length}%${v}`)
    .join(',');
}

function langPref(pref, fallback) {
  return pref ? `${pref},${fallback}` : fallback;
}

function playbackError(code) {
  return {
    NotAllowed: 'Tu usuario no tiene permiso para reproducir este contenido.',
    NoCompatibleStream: 'El servidor no encontró una forma de enviar este vídeo.',
    RateLimitExceeded: 'Se ha superado el límite de reproducción del servidor.',
  }[code] || `Error del servidor: ${code}`;
}
