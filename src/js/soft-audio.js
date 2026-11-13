// Sound for files whose picture the app plays as-is but whose audio Chromium can't decode (Dolby
// Digital / Dolby Digital Plus). The <video> plays the original file, silent; this reads the same
// file's audio track, decodes it here (WebAssembly) and plays it through Web Audio, following the
// video's clock. Nothing is converted on the server, so playback starts as fast as a direct play.
const AHEAD = 4; // seconds of sound kept scheduled ahead of the picture
const HARD_RESYNC = 0.25; // further off than this: start the sound again at the picture's position
const DEADBAND = 0.012;
const MAX_NUDGE = 0.02; // the picture's speed is nudged by at most 2 % to stay on the sound

let libs = null;
function loadLibs() {
  libs ||= (async () => {
    const mb = await import('mediabunny');
    const ac3 = await import('@mediabunny/ac3');
    ac3.registerAc3Decoder();
    return mb;
  })();
  libs.catch(() => { libs = null; });
  return libs;
}

export function softAudioSupported() {
  return typeof WebAssembly === 'object' && !!(window.AudioContext || window.webkitAudioContext)
    && typeof HTMLScriptElement.supports === 'function' && HTMLScriptElement.supports('importmap');
}

export class SoftAudio {
  // ordinal: position of the wanted track among the file's audio tracks (0 = first).
  constructor(video, { url, ordinal = 0, onError, log = () => {} }) {
    this.video = video;
    this.url = url;
    this.ordinal = ordinal;
    this.onError = onError;
    this.log = log;
    this.gen = 0;
    this.nodes = new Set();
    this.closed = false;
    this.ready = false;
    this.err = 0;
  }

  async start() {
    const mb = await loadLibs();
    if (this.closed) return;
    this.input = new mb.Input({
      // Kept out of the browser's cache: while the <video> is loading the same file, a second reader
      // going through the cache is refused ("Failed to fetch"). A hiccup is retried a few times.
      source: new mb.UrlSource(this.url, {
        maxCacheSize: 48 * 1024 * 1024,
        requestInit: { cache: 'no-store' },
        getRetryDelay: (attempts) => (attempts < 4 ? 250 * (attempts + 1) : null),
      }),
      formats: mb.ALL_FORMATS,
    });
    const tracks = await this.input.getAudioTracks();
    const track = tracks[this.ordinal] || tracks[0];
    if (!track) throw new Error('el archivo no tiene pista de audio');
    if (!(await track.canDecode())) throw new Error(`audio ${track.codec || 'desconocido'} no decodificable`);
    if (this.closed) return;
    this.sink = new mb.AudioBufferSink(track);

    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: 'playback', sampleRate: track.sampleRate || undefined });
    // Real surround when the output has the speakers for it; otherwise Web Audio mixes down to stereo.
    try {
      const max = this.ctx.destination.maxChannelCount;
      if (max >= 6 && track.numberOfChannels >= 6) this.ctx.destination.channelCount = Math.min(max, track.numberOfChannels);
    } catch {}
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);

    const v = this.video;
    const on = (ev, fn) => {
      v.addEventListener(ev, fn);
      (this.offs ||= []).push(() => v.removeEventListener(ev, fn));
    };
    on('playing', () => this.run());
    on('pause', () => this.halt());
    on('waiting', () => this.halt());
    on('seeking', () => this.halt());
    on('ended', () => this.halt());
    on('volumechange', () => this.applyVolume());
    this.applyVolume();
    this.ready = true;
    this.watch = setInterval(() => this.follow(), 250);
    if (!v.paused && v.readyState >= 3 && !v.seeking) this.run();
  }

  applyVolume() {
    const v = this.video;
    if (this.gain) this.gain.gain.value = v.muted ? 0 : v.volume;
  }

  // Where the sound is, in the file's time.
  audioPos() {
    return this.anchorMedia + (this.ctx.currentTime - this.anchorCtx);
  }

  latency() {
    return (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
  }

  halt() {
    this.gen++;
    this.running = false;
    for (const n of this.nodes) { try { n.stop(); } catch {} }
    this.nodes.clear();
    this.setRate(1);
  }

  async run() {
    if (!this.ready || this.closed) return;
    this.halt();
    const gen = this.gen;
    const v = this.video;
    try {
      if (this.ctx.state !== 'running') await this.ctx.resume();
      if (gen !== this.gen) return;
      // The picture keeps moving while the first sound is fetched and decoded, so the anchor ties
      // "now" on the audio clock to "now" on the picture; late buffers start part-way in.
      // A frame's own timing is exact; currentTime alone is off by a few tenths while playback starts.
      const frame = await nextFrame(v);
      if (gen !== this.gen) return;
      if (frame) {
        this.anchorCtx = this.ctx.currentTime + (frame.expectedDisplayTime - performance.now()) / 1000;
        this.anchorMedia = frame.mediaTime;
      } else {
        this.anchorCtx = this.ctx.currentTime;
        this.anchorMedia = v.currentTime;
      }
      this.err = 0;
      this.off = 0;
      this.running = true;
      for await (const { buffer, timestamp, duration } of this.sink.buffers(Math.max(0, v.currentTime - 0.1))) {
        if (gen !== this.gen) return;
        const when = this.anchorCtx + (timestamp - this.anchorMedia) - this.latency();
        const now = this.ctx.currentTime;
        if (when + duration > now) {
          const node = this.ctx.createBufferSource();
          node.buffer = buffer;
          node.connect(this.gain);
          node.onended = () => this.nodes.delete(node);
          if (when >= now) node.start(when);
          else node.start(now, now - when);
          this.nodes.add(node);
        }
        while (gen === this.gen && timestamp - this.audioPos() > AHEAD) await sleep(150);
      }
    } catch (e) {
      if (gen !== this.gen || this.closed) return;
      this.log(`soft audio: ${e.message}`);
      this.onError?.(e);
    }
  }

  // The picture runs on the system clock and the sound on the sound card's: they drift apart slowly.
  // The picture's speed is nudged imperceptibly to stay on the sound; a big gap restarts the sound.
  follow() {
    const v = this.video;
    if (!this.running || v.paused || v.seeking || v.readyState < 3) return;
    const raw = v.currentTime - this.audioPos();
    this.err = this.err * 0.8 + raw * 0.2;
    // Two readings in a row: a single odd one (the picture's clock hiccups when it starts) is ignored.
    this.off = Math.abs(raw) > HARD_RESYNC ? (this.off || 0) + 1 : 0;
    if (this.off >= 2) {
      this.off = 0;
      this.log(`soft audio: resincroniza (${raw.toFixed(3)} s)`);
      this.run();
      return;
    }
    const e = this.err;
    this.setRate(Math.abs(e) < DEADBAND ? 1 : 1 - Math.max(-MAX_NUDGE, Math.min(MAX_NUDGE, e * 0.5)));
  }

  setRate(r) {
    const v = this.video;
    if (Math.abs(v.playbackRate - r) > 0.0005) v.playbackRate = r;
  }

  // For checks from outside (tests, the log): how far the picture is from the sound, in seconds.
  drift() {
    return this.running ? this.video.currentTime - this.audioPos() : null;
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    this.halt();
    clearInterval(this.watch);
    for (const off of this.offs || []) off();
    try { this.input?.dispose(); } catch {}
    this.ctx?.close().catch(() => {});
  }
}

// The next picture frame's timing ({ mediaTime, expectedDisplayTime }), or null where the browser can't tell.
function nextFrame(video) {
  if (!video.requestVideoFrameCallback) return Promise.resolve(null);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 400);
    video.requestVideoFrameCallback((_now, meta) => { clearTimeout(t); resolve(meta); });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
