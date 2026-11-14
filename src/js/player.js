import { ctx } from './context.js';
import { h, fmtTime, fmtEndsAt, episodeLabel, toast, image } from './ui.js';
import { icons } from './icons.js';
import { store, keepAwake, log } from './store.js';
import { deviceProfile, capabilities, learnMkv, learnHevc, hevcOnTrust, probeCapabilities, CONVERT_BITRATE } from './profile.js';
import { thumbSrc } from './media.js';
import { playbackPlan, onlyAudioConverted, keepsOriginalPicture, transcodeReasonList, IMAGE_SUBS } from './compat.js';
import { chooseSubtitle } from './subs.js';
import { mpvAvailable, openMpv, probeSource } from './mpv-player.js';
import { IS_TV } from './tv.js';
import { SoftAudio } from './soft-audio.js';

const TICKS = 1e7;
const JASSUB_BASE = new URL('../vendor/jassub/', import.meta.url).href;
const FONT_MIME = /font|truetype|opentype|ttf|otf|woff/i;

let current = null;

window.lumenHost?.win.onFullscreen((on) => {
  if (current?.fsBtn) current.fsBtn.innerHTML = on ? icons.exitFullscreen : icons.fullscreen;
});

export async function openPlayer(item, opts = {}) {
  if (current) await current.close({ refresh: false });
  const player = new Player();
  current = player;
  ctx.player = player;
  try {
    await player.load(item, opts);
  } catch (e) {
    log(`player load: ${e.stack || e.message}`);
    // The server wants to re-encode the picture (e.g. its remote bitrate cap): mpv plays the original instead.
    if (e instanceof NeedsTranscodeError && store.get('player', 'auto') === 'auto' && await mpvAvailable()) {
      await player.close({ refresh: false });
      openMpv(item, opts);
      return;
    }
    player.fail(e.message || String(e));
  }
}

class Player {
  constructor() {
    this.closed = false;
    this.hls = null;
    this.jassub = null;
    this.method = null;
    this.playSessionId = null;
    this.retries = { net: 0, media: 0 };
    this.segments = [];
    this.next = null;
    this.upNextDismissed = false;
    this.skippedSegments = new Set();
    this.build();
    keepAwake(true);
    document.body.classList.add('playing');
    // Real window fullscreen, so Windows' minimize/maximize/close buttons don't sit over the video.
    window.lumenHost?.win.player(true);
  }

  // ---------- DOM ----------
  build() {
    const v = (this.video = h('video', { class: 'p-video', preload: 'auto' }));
    v.volume = store.get('volume', 1);
    v.muted = store.get('muted', false);
    applySharpen(v);

    this.subLayer = h('div', { class: 'p-subs' });
    this.spinnerEl = h('div', { class: 'p-spinner' }, h('div', { class: 'spinner' }));
    this.titleEl = h('div', { class: 'p-title' });
    this.modeEl = h('div', { class: 'p-mode' });
    this.timeEl = h('span', { class: 'p-time' }, '0:00');
    this.durEl = h('span', { class: 'p-time dim' }, '0:00');
    this.endsEl = h('span', { class: 'p-ends' });

    this.prog = h('div', { class: 'p-prog' });
    this.buf = h('div', { class: 'p-buf' });
    this.knob = h('div', { class: 'p-knob' });
    this.hoverTime = h('div', { class: 'p-hover-time' });
    this.markers = h('div', { class: 'p-markers' });
    this.track = h('div', { class: 'p-track' }, this.buf, this.markers, this.prog, this.knob);
    this.seek = h('div', { class: 'p-seek' }, this.track, this.hoverTime);

    this.playBtn = h('button', { class: 'p-btn big', title: 'Reproducir/Pausa (Espacio)', html: icons.pause, onclick: () => this.togglePlay() });
    this.muteBtn = h('button', { class: 'p-btn', title: 'Silenciar (M)', onclick: () => this.setMuted(!v.muted) });
    this.volSlider = h('input', { class: 'p-vol', type: 'range', min: 0, max: 1, step: 0.01, value: v.volume });
    this.volSlider.addEventListener('input', () => this.setVolume(Number(this.volSlider.value)));
    this.fsBtn = h('button', { class: 'p-btn', title: 'Pantalla completa (F)', html: icons.fullscreen, onclick: () => this.toggleFullscreen() });
    this.nextBtn = h('button', { class: 'p-btn', title: 'Siguiente episodio (N)', html: icons.skipNext, hidden: true, onclick: () => this.playNext() });
    this.tracksBtn = h('button', { class: 'p-btn', title: 'Audio y subtítulos', html: icons.subtitles, onclick: (e) => { e.stopPropagation(); this.toggleMenu(); } });

    this.menu = h('div', { class: 'p-menu glass', hidden: true, onclick: (e) => e.stopPropagation() });
    this.skipBtn = h('button', { class: 'p-skip', hidden: true });
    this.upNext = h('div', { class: 'p-upnext glass', hidden: true });
    this.errorEl = h('div', { class: 'p-error', hidden: true });
    this.flash = h('div', { class: 'p-flash' });

    this.controls = h('div', { class: 'p-controls' },
      h('div', { class: 'p-top' },
        h('button', { class: 'p-btn', title: 'Volver (Esc)', html: icons.back, onclick: () => this.close() }),
        this.titleEl,
        this.modeEl),
      h('div', { class: 'p-bottom' },
        this.seek,
        h('div', { class: 'p-row' },
          h('div', { class: 'p-group' },
            this.playBtn,
            h('button', { class: 'p-btn', title: 'Atrás 10 s (←)', html: icons.rewind, onclick: () => this.seekBy(-10) }),
            h('button', { class: 'p-btn', title: 'Adelante 30 s (→)', html: icons.forward, onclick: () => this.seekBy(30) }),
            h('div', { class: 'p-times' }, this.timeEl, h('span', { class: 'dim' }, ' / '), this.durEl),
            this.endsEl),
          h('div', { class: 'p-group' },
            this.nextBtn,
            this.tracksBtn,
            IS_TV ? null : h('div', { class: 'p-volume' }, this.muteBtn, this.volSlider),
            IS_TV ? null : this.fsBtn))));

    this.el = h('div', { class: 'player' }, v, this.subLayer, this.spinnerEl, this.flash, this.controls, this.skipBtn, this.upNext, this.menu, this.errorEl);
    document.getElementById('player-root').replaceChildren(this.el);
    this.updateVolumeUi();
    this.bind();
  }

  bind() {
    const v = this.video;
    const on = (el, ev, fn, opts) => {
      el.addEventListener(ev, fn, opts);
      (this.unbinders ||= []).push(() => el.removeEventListener(ev, fn, opts));
    };

    on(v, 'timeupdate', () => this.onTime());
    on(v, 'progress', () => this.updateBuffer());
    on(v, 'play', () => { this.playBtn.innerHTML = icons.pause; this.report('progress'); this.poke(); });
    on(v, 'pause', () => { this.playBtn.innerHTML = icons.play; this.report('progress'); this.showControls(true); });
    on(v, 'waiting', () => this.setLoading(true));
    on(v, 'playing', () => { this.setLoading(false); this.retries.media = 0; });
    on(v, 'canplay', () => this.setLoading(false));
    on(v, 'volumechange', () => this.updateVolumeUi());
    on(v, 'ended', () => this.onEnded());
    on(v, 'error', () => this.onVideoError());
    on(v, 'click', () => { if (!this.menu.hidden) this.toggleMenu(false); else this.togglePlay(); });
    on(v, 'dblclick', () => this.toggleFullscreen());

    // Only real pointer moves count: Chromium also fires mousemove when what is under a still pointer
    // changes (the clock ticking), and a pointer resting where the bars appear mustn't pin them.
    let lastPointer = '';
    on(this.el, 'mousemove', (e) => {
      const at = `${e.screenX},${e.screenY}`;
      const first = !lastPointer;
      if (at === lastPointer) return;
      lastPointer = at;
      if (first) return; // sent when the player appears under a still pointer, not a real move
      this.hovering = !!e.target.closest('.p-bottom, .p-top');
      this.poke();
    });
    on(this.el, 'mouseleave', () => { this.hovering = false; this.hideSoon(600); });
    on(this.controls, 'mouseout', () => { this.hovering = false; });
    on(document, 'keydown', (e) => this.onKey(e), true);
    on(document, 'click', () => this.toggleMenu(false));
    on(document, 'fullscreenchange', () => {
      this.fsBtn.innerHTML = document.fullscreenElement ? icons.exitFullscreen : icons.fullscreen;
    });

    // Seek bar: hover preview + drag.
    const ratioAt = (e) => {
      const r = this.track.getBoundingClientRect();
      return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    };
    on(this.seek, 'pointermove', (e) => {
      const ratio = ratioAt(e);
      this.hoverTime.textContent = fmtTime(ratio * this.duration());
      this.hoverTime.style.left = `${ratio * 100}%`;
      if (this.dragging) this.paintProgress(ratio);
    });
    on(this.seek, 'pointerdown', (e) => {
      this.dragging = true;
      this.seek.setPointerCapture(e.pointerId);
      this.seek.classList.add('dragging');
      this.paintProgress(ratioAt(e));
    });
    on(this.seek, 'pointerup', (e) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.seek.classList.remove('dragging');
      this.seekTo(ratioAt(e) * this.duration());
    });

    if ('mediaSession' in navigator) {
      const ms = navigator.mediaSession;
      ms.setActionHandler('play', () => v.play());
      ms.setActionHandler('pause', () => v.pause());
      ms.setActionHandler('seekbackward', () => this.seekBy(-10));
      ms.setActionHandler('seekforward', () => this.seekBy(30));
      ms.setActionHandler('nexttrack', () => this.playNext());
    }
  }

  // ---------- loading ----------
  async load(item, { fromStart = false, startSec, forceTranscode = false, plan, probe } = {}) {
    this.item = item;
    this.knownPlan = plan;
    this.knownInfo = probe;
    this.forceTranscode = forceTranscode;
    this.fellBack = false;
    this.upNextDismissed = false;
    this.skippedSegments.clear();
    this.renderTitle();
    this.setLoading(true);

    const ud = item.UserData || {};
    let start = startSec ?? (fromStart || ud.Played ? 0 : (ud.PlaybackPositionTicks || 0) / TICKS);
    if (item.RunTimeTicks && start > item.RunTimeTicks / TICKS - 15) start = 0;

    this.mediaSourceId = undefined;
    this.audioIndex = undefined;
    this.subIndex = undefined;
    await this.startStream({ startSec: start, forceTranscode });

    ctx.api.segments(item.Id).then((s) => { this.segments = s; this.paintMarkers(); });
    ctx.api.nextEpisode(item).then((n) => {
      this.next = n;
      this.nextBtn.hidden = !n;
    }).catch(() => {});

    if ('mediaSession' in navigator) {
      const art = thumbSrc(ctx.api, item, 512);
      navigator.mediaSession.metadata = new MediaMetadata({
        title: item.Name,
        artist: item.SeriesName || '',
        artwork: art ? [{ src: art, sizes: '512x288', type: 'image/jpeg' }] : [],
      });
    }
  }

  // The order is always: 1) the original file as-is; 2) the original picture repackaged by the server
  // (only the container and, if needed, the audio change — cheap for the NAS); 3) only then, and only with
  // the user's OK, a real conversion of the picture, capped at 1080p so the NAS can keep up.
  async startStream({ startSec = 0, audioIndex, subIndex, forceTranscode = this.forceTranscode, noDirect = false }) {
    const api = ctx.api;
    this.hideError();
    this.setLoading(true);
    await this.teardownStream();
    if (this.closed) return;

    await probeCapabilities();
    if (this.closed) return;

    const convertOk = forceTranscode || store.get('allowTranscode', false);
    const convertBitrate = store.get('maxBitrate', 0) || CONVERT_BITRATE;
    const allowDirect = !forceTranscode && !noDirect && store.get('preferDirectPlay', true);

    let asked = null;
    const request = async (direct, audio, sub, convert = false) => {
      asked = { direct, audio, sub, convert };
      const res = await api.playbackInfo(this.item.Id, {
        UserId: api.userId,
        DeviceProfile: deviceProfile({ convert, maxBitrate: convertBitrate }),
        // The bitrate only matters for a real conversion: with it set, the server would re-encode a
        // file the app can play as-is just to make it smaller.
        MaxStreamingBitrate: convert ? convertBitrate : 200_000_000,
        AudioStreamIndex: audio,
        SubtitleStreamIndex: sub,
        MediaSourceId: this.mediaSourceId,
        EnableDirectPlay: direct,
        // Server-side work always comes back as an HLS address (TranscodingUrl); whether it copies the
        // picture or re-encodes it is read from its reasons below.
        EnableDirectStream: false,
        EnableTranscoding: true,
        AllowVideoStreamCopy: !convert || !forceTranscode,
        AllowAudioStreamCopy: true,
        AutoOpenLiveStream: true,
        IsPlayback: true,
      });
      if (res.ErrorCode) throw new Error(playbackError(res.ErrorCode));
      if (!res.MediaSources?.[0]) throw new Error('El servidor no devolvió ninguna fuente de vídeo.');
      return res;
    };

    // When the caller already knows only the audio needs converting, skip the direct-play round trip.
    const known = this.knownPlan;
    const knownInfo = this.knownInfo;
    this.knownPlan = null;
    this.knownInfo = null;
    const firstDirect = allowDirect && known?.mode !== 'remux';
    // A file the app plays as-is can start from the answer the detail page already fetched.
    const reuse = firstDirect && known?.mode === 'direct' && knownInfo?.MediaSources?.[0] && audioIndex == null && subIndex == null;
    // Our own codec check decides (it ignores e.g. the server's remote bitrate cap). Files whose audio the
    // app can't decode (Dolby Digital, DTS…) or that use another audio track keep the original video and
    // only get their audio converted by the server.
    const tracksFor = (src, quiet) => {
      const audio = audioIndex ?? src.DefaultAudioStreamIndex;
      const sub = subIndex ?? chooseSubtitle(src, audio).index ?? src.DefaultSubtitleStreamIndex ?? -1;
      // Image subtitles (PGS, DVD) would force the server to redraw the whole picture: without the OK to
      // convert, a text version in the same language is used, or none.
      return { audio, sub, shownSub: convertOk ? sub : textSubtitleFor(src, sub, quiet) };
    };

    let info;
    if (reuse) info = knownInfo;
    else if (!firstDirect && knownInfo?.MediaSources?.[0]) {
      // Known to need the server and the file's tracks are already known: ask once, for the right
      // tracks, instead of asking blind and then again (each question costs the NAS time).
      const pre = tracksFor(knownInfo.MediaSources[0], true);
      info = await request(false, pre.audio, pre.shownSub);
    } else info = await request(firstDirect, audioIndex, subIndex);
    let ms = info.MediaSources[0];

    const { audio: wantedAudio, sub: chosenSub, shownSub: wantedSub } = tracksFor(ms, false);
    const plan = playbackPlan({ ...ms, DefaultAudioStreamIndex: wantedAudio, DefaultSubtitleStreamIndex: wantedSub }, { external: false });
    const direct = allowDirect && plan.mode === 'direct';
    if (!direct && (reuse || asked.direct || asked.audio !== wantedAudio || asked.sub !== wantedSub)) {
      info = await request(false, wantedAudio, wantedSub);
      ms = info.MediaSources[0];
    }
    // Jellyfin burns in forced image subtitles even when asked for none, which means re-encoding the
    // whole picture. Without the OK to convert, that part of the request is dropped.
    if (!direct && !convertOk && /SubtitleMethod=Encode/i.test(ms.TranscodingUrl || '')) {
      ms = { ...ms, TranscodingUrl: dropBurnIn(ms.TranscodingUrl) };
    }
    if (this.closed) return;

    let converting = false;
    let streamUrl = null;
    if (!direct) {
      if (!ms.TranscodingUrl) throw new Error('El servidor no ofrece ninguna forma de enviar este vídeo.');
      // Repackaging keeps the original picture: always fine. Play only the variant that copies it, never
      // the H.264 re-encode Jellyfin lists next to it (the player would switch to it silently).
      const keepsPicture = !forceTranscode && keepsOriginalPicture(ms.TranscodingUrl);
      if (keepsPicture) streamUrl = await copyVariant(api.abs(ms.TranscodingUrl));
      if (!streamUrl) {
        if (!convertOk) {
          throw new NeedsTranscodeError(transcodeReasons(keepsPicture ? 'VideoCodecNotSupported' : ms.TranscodingUrl, plan));
        }
        info = await request(false, wantedAudio, chosenSub, true);
        ms = info.MediaSources[0];
        if (!ms.TranscodingUrl) throw new Error('El servidor no puede convertir este vídeo.');
        streamUrl = capResolution(api.abs(ms.TranscodingUrl));
        converting = true;
      }
    }
    if (this.closed) return;

    this.info = info;
    this.ms = ms;
    this.mediaSourceId = ms.Id;
    this.playSessionId = info.PlaySessionId;
    this.audioIndex = wantedAudio;
    this.subIndex = converting ? chosenSub : wantedSub;
    this.burnedSub = converting && /SubtitleMethod=Encode/i.test(ms.TranscodingUrl || '');
    this.converting = converting;
    this.streamUrl = streamUrl;

    const v = this.video;
    if (direct) {
      this.method = 'DirectPlay';
      const url = api.buildUrl(`/Videos/${this.item.Id}/stream`, {
        static: true,
        mediaSourceId: ms.Id,
        deviceId: api.deviceId,
        api_key: api.token,
        Tag: ms.ETag,
        PlaySessionId: this.playSessionId,
      });
      const triesMkv = /mkv|matroska/i.test(ms.Container || '') && !capabilities().mkvNative;
      // HEVC the browser said it can't decode, played on trust (profile.js): its first real frame decides.
      const pic = (ms.MediaStreams || []).find((s) => s.Type === 'Video');
      const hevcBits = /hevc|h265/i.test(pic?.Codec || '') && hevcOnTrust(pic.BitDepth || 8) ? pic.BitDepth || 8 : 0;
      this.triesHevc = hevcBits;
      v.addEventListener('loadedmetadata', () => {
        if (startSec > 0 && Math.abs(v.currentTime - startSec) > 1) v.currentTime = startSec;
        if (triesMkv && v.videoWidth > 0) learnMkv(true);
      }, { once: true });
      if (pic) this.watchPicture(hevcBits);
      this.triesMkv = triesMkv;
      // "#t=": the file is opened straight at the resume point instead of at 0 and then moved.
      v.src = startSec > 0 ? `${url}#t=${startSec.toFixed(2)}` : url;
      this.armDirectPlayWatchdog();
      if (plan.softAudio) this.startSoftAudio(url, ms, wantedAudio);
    } else {
      this.method = converting ? 'Transcode' : 'DirectStream';
      if (/\.m3u8/i.test(streamUrl) && window.Hls?.isSupported()) this.attachHls(streamUrl, startSec);
      else {
        v.addEventListener('loadedmetadata', () => { if (startSec > 0) v.currentTime = startSec; }, { once: true });
        v.src = streamUrl;
      }
    }

    v.play().catch(() => {});
    this.applySubtitle();
    this.report('start');
    clearInterval(this.reportTimer);
    this.reportTimer = setInterval(() => this.report('progress'), 10000);
    this.renderMode();
    log(`play ${this.item.Id} via ${this.method}`);
  }

  attachHls(url, startSec) {
    const Hls = window.Hls;
    const hls = new Hls({
      startPosition: startSec,
      // Modest buffer and few, spaced-out retries: a struggling NAS shouldn't get hammered.
      // TV boxes have little RAM: a 4K stream at 30 s ahead + 30 s behind is >80 MB of buffers.
      maxBufferLength: IS_TV ? 20 : 30,
      maxMaxBufferLength: IS_TV ? 30 : 60,
      backBufferLength: IS_TV ? 10 : 30,
      manifestLoadingTimeOut: 30000,
      fragLoadingTimeOut: 60000,
      fragLoadingMaxRetry: 3,
      fragLoadingRetryDelay: 2000,
      levelLoadingTimeOut: 30000,
      levelLoadingMaxRetry: 2,
      manifestLoadingMaxRetry: 1,
    });
    // Jellyfin lists an H.264 re-encode next to the variant that copies the original HEVC/AV1 picture.
    // Stay on the copy when this device can decode it: re-encoding 4K live is beyond the NAS. (Normally
    // only the copy reaches here — see copyVariant — but this also covers a master playlist.)
    hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
      const canPlay = (l) => !l.videoCodec || window.MediaSource?.isTypeSupported(`video/mp4; codecs="${l.videoCodec}"`);
      const isCopy = (l) => !/AllowVideoStreamCopy=false/i.test(String(l.url ?? l.uri ?? ''));
      const copy = data.levels.findIndex((l) => isCopy(l) && canPlay(l));
      if (copy >= 0 && data.levels.length > 1) {
        hls.startLevel = copy;
        hls.currentLevel = copy; // manual: both variants report the same bitrate, ABR must not swap back
      }
    });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && this.retries.net++ < 2) {
        setTimeout(() => hls.startLoad(), 3000 * this.retries.net);
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && this.retries.media++ < 2) {
        hls.recoverMediaError();
      } else {
        log(`hls fatal: ${data.type} ${data.details}`);
        this.fail('Se perdió la conexión con el servidor durante la reproducción.');
      }
    });
    // If playback sits just before a small gap in the buffer, hop over it instead of spinning forever.
    let stuckSince = 0;
    this.stallTimer = setInterval(() => {
      const v = this.video;
      if (v.paused || v.readyState >= 3) { stuckSince = 0; return; }
      stuckSince ||= Date.now();
      if (Date.now() - stuckSince < 5000) return;
      for (let i = 0; i < v.buffered.length; i++) {
        const s = v.buffered.start(i);
        if (s > v.currentTime && s - v.currentTime < 3) {
          log(`hls: salto de hueco ${v.currentTime.toFixed(1)} -> ${s.toFixed(1)}`);
          v.currentTime = s + 0.05;
          stuckSince = 0;
          return;
        }
      }
    }, 1000);
    hls.loadSource(url);
    hls.attachMedia(this.video);
    this.hls = hls;
  }

  // The picture plays from the original file; its Dolby sound is decoded here (soft-audio.js). If that
  // fails, the next best thing takes over at the same spot (mpv on Windows, else the server's audio).
  startSoftAudio(url, ms, audioIndex) {
    const audios = (ms.MediaStreams || []).filter((s) => s.Type === 'Audio' && !s.IsExternal);
    const ordinal = Math.max(0, audios.findIndex((a) => a.Index === audioIndex));
    const failed = (e) => {
      if (this.soft !== soft || this.closed) return;
      log(`soft audio falló: ${e?.message || e}`);
      this.fallbackToTranscode({ keepMkv: true });
    };
    // Its own address (the server ignores the extra word): with the very same one as the <video>,
    // Chromium refuses the second reader while the first is still loading.
    const audioUrl = `${url}${url.includes('?') ? '&' : '?'}lumenAudio=1`;
    const mix = store.get('audioMix', 'dialog');
    const soft = (this.soft = new SoftAudio(this.video, { url: audioUrl, ordinal, mix, log, onError: failed }));
    soft.start().catch(failed);
  }

  // Some files claim to be playable but never start; fall back to the server repackaging them.
  // A slow connection isn't a reason: once the picture is known (metadata with a size), it's just loading.
  armDirectPlayWatchdog() {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      const v = this.video;
      if (this.method === 'DirectPlay' && !this.closed && (v.readyState < 1 || (v.readyState < 2 && !v.videoWidth))) {
        log('direct play stalled, using server stream');
        this.fallbackToTranscode();
      }
    }, 15000);
  }

  // A file the browser opens but whose picture it can't decode plays with sound and a black screen
  // (Chrome drops the video track, Edge without the HEVC extension the same): no frame ever arrives.
  // That counts as a failed direct play. When HEVC was played on trust, its result is remembered.
  watchPicture(hevcBits) {
    const v = this.video;
    const token = (this.picToken = Symbol('pic'));
    const live = () => token === this.picToken && !this.closed && this.method === 'DirectPlay';
    const noPicture = (why) => {
      if (!live()) return;
      log(`direct play sin imagen (${why})`);
      this.fallbackToTranscode();
    };
    const gotPicture = () => {
      if (!live()) return;
      clearTimeout(this.pictureTimer);
      this.picToken = null;
      if (hevcBits) {
        learnHevc(hevcBits, true);
        log(`HEVC ${hevcBits} bits se reproduce en directo en este navegador`);
      }
    };
    v.addEventListener('loadeddata', () => {
      if (!live()) return;
      if (!v.videoWidth) return noPicture('pista de vídeo descartada');
      if (typeof v.requestVideoFrameCallback === 'function') v.requestVideoFrameCallback(gotPicture);
      else gotPicture();
    }, { once: true });
    // Playing for a while with no frame shown: the decoder refused the picture.
    v.addEventListener('playing', () => {
      if (!live()) return;
      clearTimeout(this.pictureTimer);
      this.pictureTimer = setTimeout(() => {
        if (live() && !v.paused && (!v.videoWidth || v.getVideoPlaybackQuality?.().totalVideoFrames === 0)) noPicture('ningún fotograma');
      }, 8000);
    }, { once: true });
  }

  onVideoError() {
    if (this.hls || this.closed || !this.video.getAttribute('src')) return;
    const err = this.video.error;
    log(`video error ${err?.code} ${err?.message}`);
    if (this.method === 'DirectPlay') this.fallbackToTranscode();
    else this.fail('No se pudo reproducir el vídeo.');
  }

  // The original file didn't start. Next best thing: the same picture repackaged by the server (light
  // work for the NAS). A real conversion only comes after that, and only with the user's OK.
  async fallbackToTranscode({ keepMkv = false } = {}) {
    if (this.fellBack) return;
    this.fellBack = true;
    const at = this.video.currentTime || 0;
    // This device doesn't play it as-is: don't try it again. HEVC played on trust is the likelier culprit
    // (browsers play MKV far more often than they admit), so then only that is remembered.
    if (this.triesHevc) learnHevc(this.triesHevc, false);
    else if (this.triesMkv && !keepMkv) learnMkv(false);
    // In automatic mode a file the app can't handle moves to mpv at the same spot.
    if (store.get('player', 'auto') === 'auto' && await mpvAvailable()) {
      const item = this.item;
      toast('Este archivo va mejor en mpv; abriéndolo ahí.');
      await this.close({ refresh: false });
      openMpv(item, { startSec: at });
      return;
    }
    this.startStream({ startSec: at, audioIndex: this.audioIndex, subIndex: this.subIndex, noDirect: true })
      .catch((e) => this.fail(e.message));
  }

  async teardownStream() {
    clearTimeout(this.watchdog);
    clearTimeout(this.pictureTimer);
    this.picToken = null;
    this.triesHevc = 0;
    clearInterval(this.stallTimer);
    this.clearClientSubs();
    if (this.soft) {
      this.soft.destroy();
      this.soft = null;
    }
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    const v = this.video;
    if (v.getAttribute('src')) {
      v.removeAttribute('src');
      v.load();
    }
    if (this.playSessionId && this.method && this.method !== 'DirectPlay') {
      ctx.api.stopEncoding(this.playSessionId);
    }
    this.retries = { net: 0, media: 0 };
  }

  // ---------- subtitles ----------
  subtitleStreams() {
    return (this.ms?.MediaStreams || []).filter((s) => s.Type === 'Subtitle');
  }

  applySubtitle() {
    this.clearClientSubs();
    const s = this.subtitleStreams().find((x) => x.Index === this.subIndex);
    if (!s || s.DeliveryMethod !== 'External' || !s.DeliveryUrl) return;
    const url = ctx.api.abs(s.DeliveryUrl);
    if (/^(ass|ssa)$/i.test(s.Codec || '')) this.startAss(url);
    else this.startText(url);
  }

  async startAss(url) {
    const token = (this.subToken = Symbol('sub'));
    try {
      const { default: JASSUB } = await import(JASSUB_BASE + 'jassub.es.js');
      if (token !== this.subToken) return;
      const fonts = (this.ms.MediaAttachments || [])
        .filter((a) => a.DeliveryUrl && FONT_MIME.test(`${a.MimeType} ${a.Codec} ${a.FileName}`))
        .map((a) => ctx.api.abs(a.DeliveryUrl));
      this.jassub = new JASSUB({
        video: this.video,
        subUrl: url,
        workerUrl: JASSUB_BASE + 'jassub-worker.js',
        wasmUrl: JASSUB_BASE + 'jassub-worker.wasm',
        legacyWasmUrl: JASSUB_BASE + 'jassub-worker.wasm.js',
        modernWasmUrl: JASSUB_BASE + 'jassub-worker-modern.wasm',
        availableFonts: { 'liberation sans': JASSUB_BASE + 'default.woff2' },
        fallbackFont: 'liberation sans',
        fonts,
      });
    } catch (e) {
      log(`jassub: ${e.message}`);
      toast('No se pudieron mostrar esos subtítulos con estilo; se intentan como texto.');
      this.startText(url.replace(/Stream\.(ass|ssa)/i, 'Stream.vtt'));
    }
  }

  async startText(url) {
    const token = (this.subToken = Symbol('sub'));
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      if (token !== this.subToken) return;
      const blobUrl = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }));
      const trackEl = h('track', { kind: 'subtitles', src: blobUrl, default: true });
      this.video.append(trackEl);
      const tt = trackEl.track;
      tt.mode = 'hidden';
      tt.addEventListener('cuechange', () => {
        const cues = [...(tt.activeCues || [])];
        this.subLayer.replaceChildren(...cues.map((c) => h('div', { class: 'p-cue' }, c.getCueAsHTML ? c.getCueAsHTML() : c.text)));
      });
      this.textTrack = { el: trackEl, blobUrl };
    } catch (e) {
      log(`subs: ${e.message}`);
      toast('No se pudieron cargar los subtítulos.', 'error');
    }
  }

  clearClientSubs() {
    this.subToken = null;
    if (this.jassub) {
      try { this.jassub.destroy(); } catch {}
      this.jassub = null;
    }
    if (this.textTrack) {
      this.textTrack.el.remove();
      URL.revokeObjectURL(this.textTrack.blobUrl);
      this.textTrack = null;
    }
    this.subLayer.replaceChildren();
  }

  selectSubtitle(index) {
    this.toggleMenu(false);
    if (index === this.subIndex) return;
    const s = this.subtitleStreams().find((x) => x.Index === index);
    if (s && IMAGE_SUBS.test(s.Codec || '') && !this.converting && !store.get('allowTranscode', false)) {
      toast('Esos subtítulos son imágenes: para verlos el servidor tendría que convertir el vídeo. Elige unos de texto o activa «Convertir en el servidor sin preguntar» en Ajustes.');
      return;
    }
    const needsServer = (s && s.DeliveryMethod !== 'External') || this.burnedSub;
    if (needsServer) {
      this.restartAt({ subIndex: index });
    } else {
      this.subIndex = index;
      this.applySubtitle();
      this.report('progress');
    }
  }

  // A subtitle downloaded after playback began: the server serves it as WebVTT (or ASS as-is).
  addSubtitle(sub) {
    if (!this.ms) return;
    const ass = /^(ass|ssa)$/i.test(sub.Codec || '');
    const stream = {
      ...sub,
      DeliveryMethod: 'External',
      DeliveryUrl: `/Videos/${this.item.Id}/${this.ms.Id}/Subtitles/${sub.Index}/0/Stream.${ass ? 'ass' : 'vtt'}?api_key=${ctx.api.token}`,
    };
    this.ms.MediaStreams = [...this.ms.MediaStreams.filter((s) => s.Index !== sub.Index), stream];
    this.subIndex = sub.Index;
    this.applySubtitle();
  }

  selectAudio(index) {
    this.toggleMenu(false);
    if (index === this.audioIndex) return;
    this.restartAt({ audioIndex: index });
  }

  restartAt(changes) {
    const at = this.video.currentTime || 0;
    this.startStream({
      startSec: at,
      audioIndex: changes.audioIndex ?? this.audioIndex,
      subIndex: changes.subIndex ?? this.subIndex,
    }).catch((e) => this.fail(e.message));
  }

  toggleMenu(force) {
    const open = force ?? this.menu.hidden;
    if (!open) { this.menu.hidden = true; return; }
    const streams = this.ms?.MediaStreams || [];
    const audios = streams.filter((s) => s.Type === 'Audio');
    const subs = this.subtitleStreams();
    const opt = (label, sub, active, onclick) => h('button', { class: `p-opt ${active ? 'active' : ''}`, onclick },
      h('span', { class: 'p-opt-check', html: active ? icons.check : '' }),
      h('span', { class: 'p-opt-text' }, h('span', null, label), sub ? h('span', { class: 'p-opt-sub' }, sub) : null));

    this.menu.replaceChildren(
      h('div', { class: 'p-menu-col' },
        h('div', { class: 'p-menu-head' }, 'Audio'),
        audios.length
          ? audios.map((a) => opt(trackName(a), audioDetail(a), a.Index === this.audioIndex, () => this.selectAudio(a.Index)))
          : h('div', { class: 'p-opt-empty' }, 'Una sola pista')),
      h('div', { class: 'p-menu-col' },
        h('div', { class: 'p-menu-head' }, 'Subtítulos'),
        opt('Desactivados', null, this.subIndex === -1 || this.subIndex == null, () => this.selectSubtitle(-1)),
        subs.map((s) => opt(trackName(s), subDetail(s), s.Index === this.subIndex, () => this.selectSubtitle(s.Index)))));
    this.menu.hidden = false;
    this.showControls(true);
    if (IS_TV) (this.menu.querySelector('.p-opt.active') || this.menu.querySelector('button'))?.focus();
  }

  // ---------- transport ----------
  duration() {
    const d = this.video.duration;
    if (isFinite(d) && d > 0) return d;
    return (this.item?.RunTimeTicks || 0) / TICKS;
  }

  togglePlay() {
    const v = this.video;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
    this.flashIcon(v.paused ? icons.pause : icons.play);
  }

  seekTo(sec) {
    const d = this.duration();
    this.video.currentTime = Math.max(0, Math.min(d ? d - 0.5 : sec, sec));
    this.poke();
  }

  seekBy(delta) {
    this.seekTo((this.video.currentTime || 0) + delta);
    this.flashIcon(delta < 0 ? icons.rewind : icons.forward);
  }

  setVolume(vol) {
    this.video.volume = Math.max(0, Math.min(1, vol));
    if (this.video.volume > 0 && this.video.muted) this.video.muted = false;
    store.set('volume', this.video.volume);
  }

  setMuted(m) {
    this.video.muted = m;
    store.set('muted', m);
  }

  updateVolumeUi() {
    const v = this.video;
    const silent = v.muted || v.volume === 0;
    this.muteBtn.innerHTML = silent ? icons.mute : icons.volume;
    this.volSlider.value = v.muted ? 0 : v.volume;
    this.volSlider.style.setProperty('--fill', `${(v.muted ? 0 : v.volume) * 100}%`);
  }

  toggleFullscreen() {
    if (window.lumenHost) { window.lumenHost.win.fullscreen(); return; }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else this.el.requestFullscreen().catch(() => {});
  }

  onKey(e) {
    if (this.closed || e.target.matches?.('input[type=text], input:not([type]), textarea')) return;
    if (IS_TV && this.onTvKey(e)) return;
    const handled = {
      ' ': () => this.togglePlay(),
      k: () => this.togglePlay(),
      ArrowLeft: () => this.seekBy(-10),
      ArrowRight: () => this.seekBy(30),
      ArrowUp: () => this.setVolume(this.video.volume + 0.05),
      ArrowDown: () => this.setVolume(this.video.volume - 0.05),
      f: () => this.toggleFullscreen(),
      m: () => this.setMuted(!this.video.muted),
      n: () => this.next && this.playNext(),
      s: () => this.skipBtn.hidden || this.skipBtn.click(),
      MediaPlayPause: () => this.togglePlay(),
      MediaPlay: () => this.video.play(),
      MediaPause: () => this.video.pause(),
      MediaRewind: () => this.seekBy(-10),
      MediaFastForward: () => this.seekBy(30),
      MediaTrackNext: () => this.next && this.playNext(),
      Escape: () => {
        if (!this.menu.hidden) { this.toggleMenu(false); if (IS_TV) this.tracksBtn.focus(); }
        else if (document.fullscreenElement) document.exitFullscreen();
        else this.close();
      },
    }[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (!handled) return;
    e.preventDefault();
    e.stopPropagation();
    handled();
    this.poke();
  }

  // Remote control: with the controls hidden, Left/Right seek and OK pauses; Up/Down bring up the
  // controls, which are then moved through like the rest of the app (tv.js). Returns true when the
  // key belongs to tv.js or was handled here.
  onTvKey(e) {
    const inUi = this.el.contains(document.activeElement) && document.activeElement !== this.video
      && this.el.classList.contains('show-ui');
    const nav = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.key);
    if (inUi && nav) { this.poke(); return true; }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      this.showControls();
      this.hideSoon(5000);
      (this.skipBtn.hidden ? this.playBtn : this.skipBtn).focus();
      return true;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (!this.skipBtn.hidden) this.skipBtn.click();
      else this.togglePlay();
      this.poke();
      return true;
    }
    return false;
  }

  // ---------- UI updates ----------
  onTime() {
    const t = this.video.currentTime;
    const d = this.duration();
    if (!this.dragging) this.paintProgress(d ? t / d : 0);
    this.timeEl.textContent = fmtTime(t);
    this.durEl.textContent = fmtTime(d);
    this.endsEl.textContent = d ? fmtEndsAt(d - t) : '';
    this.checkSegments(t, d);
  }

  paintProgress(ratio) {
    const pct = `${ratio * 100}%`;
    this.prog.style.width = pct;
    this.knob.style.left = pct;
  }

  updateBuffer() {
    const v = this.video;
    const d = this.duration();
    if (!d || !v.buffered.length) return;
    let end = 0;
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) <= v.currentTime + 1) end = Math.max(end, v.buffered.end(i));
    }
    this.buf.style.width = `${(end / d) * 100}%`;
  }

  paintMarkers() {
    const d = (this.item?.RunTimeTicks || 0) / TICKS;
    if (!d) return;
    this.markers.replaceChildren(...this.segments
      .filter((s) => ['Intro', 'Outro', 'Recap'].includes(s.Type))
      .map((s) => h('div', {
        class: 'p-marker',
        style: { left: `${(s.StartTicks / TICKS / d) * 100}%`, width: `${((s.EndTicks - s.StartTicks) / TICKS / d) * 100}%` },
      })));
  }

  checkSegments(t, d) {
    const seg = this.segments.find((s) => ['Intro', 'Recap', 'Preview'].includes(s.Type)
      && t >= s.StartTicks / TICKS && t < s.EndTicks / TICKS - 1);
    if (seg) {
      const end = seg.EndTicks / TICKS;
      if (store.get('autoSkipIntro', false) && !this.skippedSegments.has(seg)) {
        this.skippedSegments.add(seg);
        this.seekTo(end);
        toast(seg.Type === 'Intro' ? 'Intro saltada' : 'Resumen saltado');
      } else {
        this.skipBtn.textContent = { Intro: 'Saltar intro', Recap: 'Saltar resumen', Preview: 'Saltar avance' }[seg.Type];
        this.skipBtn.onclick = () => { this.seekTo(end); this.skipBtn.hidden = true; };
        this.skipBtn.hidden = false;
      }
    } else {
      this.skipBtn.hidden = true;
    }

    if (!this.next || this.upNextDismissed || !d) return;
    const outro = this.segments.find((s) => s.Type === 'Outro');
    const inCredits = outro ? t >= outro.StartTicks / TICKS : (d > 300 && d - t <= 35);
    if (inCredits && this.upNext.hidden) this.showUpNext();
    else if (!inCredits && !this.upNext.hidden && !this.countdown) this.upNext.hidden = true;
  }

  showUpNext(countdownSec) {
    const n = this.next;
    const label = h('span', null, 'Reproducir ahora');
    this.upNext.replaceChildren(
      image(thumbSrc(ctx.api, n, 480), { cls: 'p-upnext-art', placeholder: n.Name }),
      h('div', { class: 'p-upnext-info' },
        h('div', { class: 'p-upnext-eyebrow' }, 'Siguiente episodio'),
        h('div', { class: 'p-upnext-title' }, `${episodeLabel(n)}  ${n.Name}`),
        h('div', { class: 'p-upnext-actions' },
          h('button', { class: 'btn btn-primary small', onclick: () => this.playNext() }, h('span', { class: 'btn-icon', html: icons.play }), label),
          h('button', { class: 'btn btn-glass small', onclick: () => this.dismissUpNext() }, 'Ocultar'))));
    this.upNext.hidden = false;
    if (countdownSec) {
      let left = countdownSec;
      label.textContent = `Siguiente en ${left}`;
      clearInterval(this.countdown);
      this.countdown = setInterval(() => {
        left -= 1;
        label.textContent = `Siguiente en ${left}`;
        if (left <= 0) this.playNext();
      }, 1000);
    }
  }

  dismissUpNext() {
    this.upNextDismissed = true;
    this.upNext.hidden = true;
    clearInterval(this.countdown);
    this.countdown = null;
    if (this.video.ended) this.close();
  }

  onEnded() {
    this.report('progress');
    if (this.next && store.get('autoplayNext', true) && !this.upNextDismissed) {
      this.showControls(true);
      this.showUpNext(8);
    } else {
      this.close();
    }
  }

  async playNext() {
    const n = this.next;
    if (!n) return;
    clearInterval(this.countdown);
    this.countdown = null;
    this.upNext.hidden = true;
    await this.reportStopped();
    if (store.get('player', 'auto') === 'auto' && await mpvAvailable()) {
      const plan = playbackPlan(await probeSource(n).catch(() => null));
      if (plan.mode === 'mpv') {
        await this.close({ refresh: false });
        openMpv(n, { fromStart: true });
        return;
      }
    }
    this.next = null;
    this.nextBtn.hidden = true;
    this.segments = [];
    this.markers.replaceChildren();
    try {
      await this.load(n, { fromStart: true });
    } catch (e) {
      this.fail(e.message);
    }
  }

  renderTitle() {
    const i = this.item;
    const isEp = i.Type === 'Episode';
    this.titleEl.replaceChildren(...[
      h('div', { class: 'p-title-main' }, isEp ? i.SeriesName : i.Name),
      isEp ? h('div', { class: 'p-title-sub' }, [episodeLabel(i), i.Name].filter(Boolean).join('  ·  ')) : null].filter(Boolean));
    document.title = isEp ? `${i.SeriesName} · ${i.Name}` : i.Name;
  }

  // Shows how this file is reaching the screen: as-is, original picture with converted audio, or converted.
  renderMode() {
    const ms = this.ms || {};
    const streams = ms.MediaStreams || [];
    const v = streams.find((s) => s.Type === 'Video');
    const a = streams.find((s) => s.Index === this.audioIndex) || streams.find((s) => s.Type === 'Audio');
    const res = v?.Height ? `${v.Height >= 2000 ? '4K' : `${v.Height}p`}` : '';
    const videoTxt = v ? [String(v.Codec || '').toUpperCase(), res].filter(Boolean).join(' ') : '';
    const ch = a?.Channels ? ({ 1: 'mono', 2: 'estéreo', 6: '5.1', 8: '7.1' }[a.Channels] || `${a.Channels} canales`) : '';
    const audioTxt = a ? [String(a.Codec || '').toUpperCase(), ch].filter(Boolean).join(' ') : '';
    const target = (new URLSearchParams((ms.TranscodingUrl || '').split('?')[1] || '').get('AudioCodec') || 'aac').split(',')[0].toUpperCase();

    let kind;
    let label;
    let detail;
    if (this.method === 'DirectPlay') {
      kind = 'direct';
      label = 'Reproducción directa';
      detail = `Archivo original · ${[videoTxt, audioTxt].filter(Boolean).join(' · ')}${this.soft ? ' (sonido decodificado en la app)' : ''}`;
    } else if (this.method === 'DirectStream' && !transcodeReasonList(ms.TranscodingUrl).some((r) => /^Audio/.test(r))) {
      kind = 'direct';
      label = 'Directo · reempaquetado';
      detail = `Imagen y sonido originales · ${[videoTxt, audioTxt].filter(Boolean).join(' · ')}`;
    } else if (this.method === 'DirectStream' || onlyAudioConverted(ms.TranscodingUrl)) {
      kind = 'audio';
      label = 'Imagen directa · audio convertido';
      detail = `Imagen original ${videoTxt} · audio ${audioTxt} → ${target}`;
    } else {
      kind = 'convert';
      label = 'Convertido en el servidor';
      const q = new URLSearchParams((this.streamUrl || '').split('?')[1] || '');
      const why = [...new Set(transcodeReasonList(ms.TranscodingUrl).map((r) => REASONS[r]).filter(Boolean))].join(', ');
      detail = [`Máx. ${q.get('MaxHeight') || 1080}p`, why && `motivo: ${why}`].filter(Boolean).join(' · ');
    }
    this.modeEl.className = `p-mode p-mode-${kind}`;
    this.modeEl.title = detail;
    this.modeEl.replaceChildren(h('span', { class: 'p-mode-dot' }), h('span', { class: 'p-mode-label' }, label), h('span', { class: 'p-mode-detail' }, detail));
  }

  setLoading(on) {
    this.spinnerEl.classList.toggle('show', on);
  }

  flashIcon(svg) {
    this.flash.innerHTML = svg;
    this.flash.classList.remove('go');
    void this.flash.offsetWidth;
    this.flash.classList.add('go');
  }

  poke() {
    this.showControls();
    this.hideSoon(3000);
  }

  showControls(sticky = false) {
    this.el.classList.add('show-ui');
    if (sticky) clearTimeout(this.hideTimer);
  }

  hideSoon(ms) {
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (this.video.paused || this.hovering || this.dragging || !this.menu.hidden) return;
      this.el.classList.remove('show-ui');
      // Hidden controls give the arrows back to seeking.
      if (IS_TV && this.el.contains(document.activeElement)) document.activeElement.blur();
    }, ms);
  }

  fail(message, _opts) {
    if (this.closed) return;
    this.setLoading(false);
    this.showControls(true);
    const at = this.video.currentTime || (this.item?.UserData?.PlaybackPositionTicks || 0) / TICKS;
    this.errorEl.replaceChildren(h('div', { class: 'glass-card' },
      h('h2', null, 'No se puede reproducir'),
      h('p', { class: 'muted' }, message),
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-primary', onclick: () => this.startStream({ startSec: at, audioIndex: this.audioIndex, subIndex: this.subIndex }).catch((e) => this.fail(e.message)) }, 'Reintentar'),
        h('button', { class: 'btn btn-glass', onclick: () => this.startStream({ startSec: at, audioIndex: this.audioIndex, subIndex: this.subIndex, forceTranscode: true }).then(() => { this.forceTranscode = true; }).catch((e) => this.fail(e.message)) }, 'Convertir en el servidor'),
        h('button', { class: 'btn btn-glass', onclick: () => this.close() }, 'Salir'))));
    this.errorEl.hidden = false;
    if (IS_TV) this.errorEl.querySelector('button')?.focus();
    mpvAvailable().then((ok) => {
      if (!ok || this.closed) return;
      const item = this.item;
      this.errorEl.querySelector('.actions').prepend(h('button', {
        class: 'btn btn-primary',
        onclick: async () => { await this.close({ refresh: false }); openMpv(item, { startSec: at }); },
      }, 'Abrir en mpv'));
    });
  }

  hideError() {
    this.errorEl.hidden = true;
  }

  // ---------- reporting ----------
  reportBody() {
    const v = this.video;
    return {
      ItemId: this.item.Id,
      MediaSourceId: this.mediaSourceId,
      PlaySessionId: this.playSessionId,
      PositionTicks: Math.floor((v.currentTime || 0) * TICKS),
      IsPaused: v.paused,
      IsMuted: v.muted,
      VolumeLevel: Math.round(v.volume * 100),
      PlayMethod: this.method,
      AudioStreamIndex: this.audioIndex,
      SubtitleStreamIndex: this.subIndex,
      CanSeek: true,
    };
  }

  report(kind) {
    if (!this.playSessionId || !ctx.api || this.closed) return;
    ctx.api.report(kind, this.reportBody());
  }

  async reportStopped() {
    if (!this.playSessionId || !ctx.api) return;
    clearInterval(this.reportTimer);
    await ctx.api.report('stop', this.reportBody());
  }

  async close({ refresh = true } = {}) {
    if (this.closed) return;
    // The final position is captured now and sent in the background: the menu shows up at once.
    const stopped = this.reportStopped();
    this.closed = true;
    clearInterval(this.reportTimer);
    clearInterval(this.countdown);
    clearTimeout(this.hideTimer);
    for (const off of this.unbinders || []) off();
    this.teardownStream();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    this.el.remove();
    document.body.classList.remove('playing');
    document.title = 'Lumen';
    keepAwake(false);
    window.lumenHost?.win.player(false);
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
    if (current === this) {
      current = null;
      ctx.player = null;
    }
    if (refresh) ctx.refresh({ quiet: true });
    await stopped;
  }
}

function trackName(s) {
  const lang = s.Language && s.Language !== 'und' ? languageName(s.Language) : '';
  return s.Title && !/^(track|pista)?\s*\d*$/i.test(s.Title) ? s.Title : lang || `Pista ${s.Index}`;
}

function audioDetail(s) {
  const ch = s.Channels ? { 1: 'Mono', 2: 'Estéreo', 6: '5.1', 8: '7.1' }[s.Channels] || `${s.Channels} canales` : '';
  return [s.Language && s.Title ? languageName(s.Language) : '', (s.Codec || '').toUpperCase(), ch, s.IsDefault ? 'Predeterminada' : '']
    .filter(Boolean).join(' · ');
}

function subDetail(s) {
  return [s.Language && s.Title ? languageName(s.Language) : '', (s.Codec || '').toUpperCase(), s.IsForced ? 'Forzados' : '', s.IsExternal ? 'Externo' : '']
    .filter(Boolean).join(' · ');
}

const langNames = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(['es'], { type: 'language' }) : null;
const ISO3 = { spa: 'es', eng: 'en', jpn: 'ja', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', ita: 'it', por: 'pt', chi: 'zh', zho: 'zh', kor: 'ko', rus: 'ru', cat: 'ca', glg: 'gl', baq: 'eu', eus: 'eu', dut: 'nl', nld: 'nl', ara: 'ar', pol: 'pl', swe: 'sv', nor: 'no', dan: 'da', fin: 'fi', tur: 'tr', hin: 'hi', tha: 'th', vie: 'vi', ind: 'id', may: 'ms', msa: 'ms', heb: 'he', gre: 'el', ell: 'el', cze: 'cs', ces: 'cs', hun: 'hu', rum: 'ro', ron: 'ro', ukr: 'uk' };

function languageName(code) {
  const c = String(code).toLowerCase();
  if (c === 'und') return 'Desconocido';
  try {
    const name = langNames?.of(ISO3[c] || c);
    return name ? name[0].toUpperCase() + name.slice(1) : code;
  } catch {
    return code;
  }
}

class NeedsTranscodeError extends Error {}

// Optional extra sharpness (Ajustes): a light unsharp pass over the scaled picture. Off by default —
// measured on a 2880x1620 panel, the plain scaling is already as crisp as mpv's — and free of
// dropped frames when on. Not on the TV (slow GPU).
function applySharpen(video) {
  const a = IS_TV ? 0 : Number(store.get('sharpen', 0)) || 0;
  if (!a) return;
  let svg = document.getElementById('lumen-sharp-svg');
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'lumen-sharp-svg';
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.position = 'absolute';
    document.body.append(svg);
  }
  svg.innerHTML = `<filter id="lumen-sharp" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feConvolveMatrix order="3" preserveAlpha="true" kernelMatrix="0 ${-a} 0 ${-a} ${1 + 4 * a} ${-a} 0 ${-a} 0"/></filter>`;
  video.style.filter = 'url(#lumen-sharp)';
}

// A text subtitle to use instead of an image one (same language, same forced-ness if possible), or -1.
function textSubtitleFor(ms, index, quiet = false) {
  const subs = (ms.MediaStreams || []).filter((s) => s.Type === 'Subtitle');
  const s = subs.find((x) => x.Index === index);
  if (!s || !IMAGE_SUBS.test(s.Codec || '')) return index;
  const text = subs.filter((x) => !IMAGE_SUBS.test(x.Codec || '') && (x.Language || '') === (s.Language || ''));
  const alt = text.find((x) => !!x.IsForced === !!s.IsForced) || (s.IsForced ? null : text[0]);
  if (alt) return alt.Index;
  if (!quiet) toast('Los subtítulos de este archivo son imágenes y para verlos habría que convertir el vídeo: se reproduce sin ellos.');
  return -1;
}

// From the HLS master playlist the server offers, the variant that copies the original picture (never
// the H.264 re-encode next to it), if this device can decode it. Null when there is none.
async function copyVariant(masterUrl) {
  let text;
  try {
    const r = await fetch(masterUrl);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    text = await r.text();
  } catch (e) {
    log(`master playlist: ${e.message}`);
    return masterUrl; // let the player read it; the level picker still prefers the copy
  }
  if (!/#EXT-X-STREAM-INF/i.test(text)) return masterUrl; // already a single stream
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const inf = lines[i].match(/^#EXT-X-STREAM-INF:(.*)$/i);
    if (!inf) continue;
    const uri = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
    if (!uri || /AllowVideoStreamCopy=false/i.test(uri)) continue;
    const video = (inf[1].match(/CODECS="([^"]*)"/i)?.[1] || '').split(',').map((c) => c.trim())
      .find((c) => /^(avc|hvc|hev|av01|vp09|dvh|dvav)/i.test(c));
    if (video && !canDecode(video)) continue;
    return new URL(uri, masterUrl).href;
  }
  return null;
}

function canDecode(codec) {
  const type = `video/mp4; codecs="${codec}"`;
  try {
    if (window.MediaSource?.isTypeSupported(type)) return true;
  } catch {}
  return document.createElement('video').canPlayType(type) !== '';
}

function dropBurnIn(url) {
  const [path, query = ''] = url.split('?');
  const q = new URLSearchParams(query);
  for (const k of [...q.keys()]) if (/^Subtitle(StreamIndex|Method|Codec)$/i.test(k)) q.delete(k);
  const reasons = (q.get('TranscodeReasons') || '').split(',').filter((r) => r && r !== 'SubtitleCodecNotSupported');
  if (reasons.length) q.set('TranscodeReasons', reasons.join(','));
  else q.delete('TranscodeReasons');
  return `${path}?${q}`;
}

// A real conversion never goes above 1080p unless the user chose 4K quality: the NAS can't re-encode 4K.
function capResolution(url) {
  if (/[?&]MaxWidth=/i.test(url)) return url;
  const fourK = (store.get('maxBitrate', 0) || 0) >= 40e6;
  return `${url}${url.includes('?') ? '&' : '?'}MaxWidth=${fourK ? 3840 : 1920}&MaxHeight=${fourK ? 2160 : 1080}`;
}

const REASONS = {
  ContainerNotSupported: 'el formato del archivo',
  VideoCodecNotSupported: 'el códec de vídeo',
  VideoProfileNotSupported: 'el perfil de vídeo',
  VideoLevelNotSupported: 'el nivel del vídeo',
  VideoBitDepthNotSupported: 'la profundidad de color (10 bits)',
  VideoRangeTypeNotSupported: 'el HDR / Dolby Vision',
  AudioCodecNotSupported: 'el audio (DTS, TrueHD, AC3…)',
  AudioChannelsOutOfRange: 'los canales de audio',
  SubtitleCodecNotSupported: 'los subtítulos de imagen',
  ContainerBitrateExceedsLimit: 'el límite de calidad del servidor',
  VideoBitrateNotSupported: 'el límite de calidad del servidor',
};

// urlOrReason: the server's TranscodingUrl, or a single reason name.
function transcodeReasons(urlOrReason, plan) {
  const list = /^[A-Za-z]+$/.test(urlOrReason || '') ? [urlOrReason] : transcodeReasonList(urlOrReason);
  const parts = [...new Set(list.map((r) => REASONS[r]).filter(Boolean))];
  const why = plan?.videoUnsupported ? ` por ${plan.reason}` : parts.length ? ` por ${parts.join(', ')}` : '';
  const fix = window.lumenHost
    ? 'Con mpv (Ajustes → Reproductor) se reproduce sin convertir.'
    : window.LumenTV
      ? 'Con VLC instalado en la tele se reproduce sin convertir.'
      : browserFix(plan);
  return `Este equipo no puede reproducir este archivo en directo${why}, y convertirlo carga mucho el servidor. ${fix}`;
}

// In a plain browser, HEVC depends on the browser and on this computer's graphics: say what to change.
function browserFix(plan) {
  const ua = navigator.userAgent;
  const hevc = /HEVC/i.test(plan?.reason || '');
  if (!hevc) return 'Prueba a abrir Lumen en Chrome o Edge, o usa la app de Windows, que lo reproduce todo sin convertir.';
  if (/Edg\//.test(ua)) {
    return 'A Edge le falta la extensión gratuita «Extensiones de vídeo HEVC del fabricante del dispositivo» de Microsoft Store. Instálala y reinicia Edge, o abre Lumen en Chrome, que lo reproduce sin ella.';
  }
  if (/Firefox\//.test(ua)) return 'Firefox apenas reproduce HEVC: abre Lumen en Chrome o Edge, o usa la app de Windows.';
  if (/Chrome\//.test(ua)) {
    return 'Chrome reproduce HEVC con la tarjeta gráfica: activa «Usar aceleración gráfica cuando esté disponible» en chrome://settings/system, reinicia Chrome y pulsa Reintentar. Si la gráfica es antigua, usa la app de Windows.';
  }
  return 'Prueba a abrir Lumen en Chrome o Edge, o usa la app de Windows, que lo reproduce todo sin convertir.';
}

function playbackError(code) {
  return {
    NotAllowed: 'Tu usuario no tiene permiso para reproducir este contenido.',
    NoCompatibleStream: 'El servidor no encontró una forma compatible de enviar este vídeo.',
    RateLimitExceeded: 'Se ha superado el límite de reproducción del servidor.',
  }[code] || `Error del servidor: ${code}`;
}
