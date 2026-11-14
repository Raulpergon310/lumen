// Decides how a file plays:
//  - 'direct': the app plays the original file as-is.
//  - 'remux':  the app plays it with the original video; the server only repackages it and, if needed,
//              converts the audio (Dolby Digital/DTS/TrueHD or a second audio track) — light work, the
//              picture is untouched.
//  - 'mpv':    the picture itself isn't right in the app (HDR, Dolby Vision, 10-bit H.264, odd formats).
//              With an external player (mpv on Windows, VLC on the TV) it goes there as-is; without one
//              (a plain browser) only what the browser truly can't decode ends up here.
import { capabilities } from './profile.js';
import { store } from './store.js';
import { softAudioSupported } from './soft-audio.js';

const APP_AUDIO = new Set(['aac', 'mp3', 'opus', 'flac', 'vorbis']);
// Audio the app decodes by itself (soft-audio.js) while the picture plays from the original file.
const SOFT_AUDIO = new Set(['ac3', 'eac3']);
// Not on the TV: its WebView doesn't play MKV as-is and the box's CPU is slow.
const softAudioOk = () => !window.LumenTV && store.get('softAudio', true) && softAudioSupported();
export const IMAGE_SUBS = /^(pgssub|pgs|dvdsub|dvbsub|vobsub|hdmv_pgs_subtitle|dvd_subtitle)$/i;

// external: an mpv/VLC is there to take what the app doesn't show at its best (HDR tone mapping, image
// subtitles). Without one, a picture the browser can decode is played as-is anyway: a browser shows HDR10
// (and Dolby Vision with an HDR10 base layer) fine, and that beats asking the NAS to convert it.
export function playbackPlan(ms, { external = true } = {}) {
  if (!ms) return { mode: 'direct' };
  const c = capabilities();
  const streams = ms.MediaStreams || [];
  const video = streams.find((s) => s.Type === 'Video');
  const audios = streams.filter((s) => s.Type === 'Audio');

  let mode = 'direct';
  let reason;
  const containers = String(ms.Container || '').toLowerCase().split(',');
  const containerOk = containers.some((x) => ['mp4', 'm4v', 'mov', 'webm'].includes(x) || (['mkv', 'matroska'].includes(x) && c.mkv));
  if (!containerOk) {
    // The server can repackage the original picture into a format the app plays (cheap, no quality loss).
    if (external) return { mode: 'mpv', reason: `formato ${ms.Container}` };
    mode = 'remux';
    reason = `formato ${ms.Container}`;
  }

  if (video) {
    const range = `${video.VideoRangeType || ''} ${video.VideoRange || ''}`;
    // Dolby Vision without an HDR10/SDR base layer (profile 5) shows wrong colours anywhere but mpv/VLC.
    const dvOnly = /DOVI/i.test(range) && !/DOVIWith/i.test(range) && !video.DvBlSignalCompatibilityId;
    if (external && /DOVI/i.test(range)) return { mode: 'mpv', reason: 'Dolby Vision' };
    if (external && /HDR|HLG/i.test(range)) return { mode: 'mpv', reason: 'HDR' };
    const codec = (video.Codec || '').toLowerCase();
    const bits = video.BitDepth || 8;
    const ok = (codec === 'h264' && bits <= 8)
      || (codec === 'hevc' && (bits <= 8 ? c.hevcDirect : c.hevc10Direct))
      || (codec === 'av1' && c.av1)
      || (codec === 'vp9' && c.vp9)
      || codec === 'vp8';
    if (!ok) return { mode: 'mpv', reason: `vídeo ${codec.toUpperCase()}${bits > 8 ? ` ${bits} bits` : ''}`, videoUnsupported: true };
    if (dvOnly) return { mode: 'mpv', reason: 'Dolby Vision sin capa HDR10', videoUnsupported: true };
  }

  const sub = streams.find((s) => s.Type === 'Subtitle' && s.Index === ms.DefaultSubtitleStreamIndex);
  if (external && sub && IMAGE_SUBS.test(sub.Codec || '')) return { mode: 'mpv', reason: 'subtítulos de imagen' };

  const audioIndex = ms.DefaultAudioStreamIndex ?? audios[0]?.Index;
  const audio = audios.find((a) => a.Index === audioIndex) || audios[0];
  if (audio && mode === 'direct') {
    const codec = (audio.Codec || '').toLowerCase();
    const plays = (a) => {
      const x = (a.Codec || '').toLowerCase();
      return APP_AUDIO.has(x) || (x === 'ac3' && c.ac3) || (x === 'eac3' && c.eac3);
    };
    const appAudio = plays(audio);
    if (!appAudio) {
      // Dolby Digital (Plus): the original file plays as-is and the app decodes its sound, so the
      // server converts nothing. Not when the file also has a track the <video> would play by itself
      // (it would sound on top), nor for a separate audio file.
      if (SOFT_AUDIO.has(codec) && !audio.IsExternal && !audios.some(plays) && softAudioOk()) {
        return { mode: 'direct', softAudio: true, reason: `audio ${codec.toUpperCase()}` };
      }
      return { mode: 'remux', reason: `audio ${codec.toUpperCase()}` };
    }
    // The app can't pick a different audio track inside the original file.
    if (audios.length > 1 && audio !== audios[0]) return { mode: 'remux', reason: 'pista de audio' };
  }
  return { mode, reason };
}

// Server conversions that keep the original picture (only the container or the audio change) are always fine.
const NO_VIDEO_WORK = /^(Audio\w+|ContainerNotSupported)$/;
export function onlyAudioConverted(transcodingUrl) {
  const reasons = transcodeReasonList(transcodingUrl);
  return reasons.length > 0 && reasons.every((r) => NO_VIDEO_WORK.test(r));
}

// True when the server's answer copies the original picture (no reason touches the video): it may only
// repackage it, or switch audio track, or convert the audio.
export function keepsOriginalPicture(transcodingUrl) {
  return transcodeReasonList(transcodingUrl).every((r) => NO_VIDEO_WORK.test(r));
}

export function transcodeReasonList(transcodingUrl) {
  const raw = new URLSearchParams((transcodingUrl || '').split('?')[1] || '').get('TranscodeReasons') || '';
  return raw.split(',').filter(Boolean);
}
