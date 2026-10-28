// Decides how a file plays:
//  - 'direct': the app plays the original file as-is.
//  - 'remux':  the app plays it with the original video; the server only converts the audio
//              (Dolby Digital/DTS/TrueHD or a second audio track) — light work, no quality loss in the picture.
//  - 'mpv':    the picture itself isn't right in the app (HDR, Dolby Vision, 10-bit H.264, odd formats).
import { capabilities } from './profile.js';

const APP_AUDIO = new Set(['aac', 'mp3', 'opus', 'flac', 'vorbis']);
const IMAGE_SUBS = /^(pgssub|pgs|dvdsub|dvbsub|vobsub|hdmv_pgs_subtitle|dvd_subtitle)$/i;

export function playbackPlan(ms) {
  if (!ms) return { mode: 'direct' };
  const c = capabilities();
  const streams = ms.MediaStreams || [];
  const video = streams.find((s) => s.Type === 'Video');
  const audios = streams.filter((s) => s.Type === 'Audio');

  const containers = String(ms.Container || '').toLowerCase().split(',');
  const containerOk = containers.some((x) => ['mp4', 'm4v', 'mov', 'webm'].includes(x) || (['mkv', 'matroska'].includes(x) && c.mkv));
  if (!containerOk) return { mode: 'mpv', reason: `formato ${ms.Container}` };

  if (video) {
    const range = `${video.VideoRangeType || ''} ${video.VideoRange || ''}`;
    if (/DOVI/i.test(range)) return { mode: 'mpv', reason: 'Dolby Vision' };
    if (/HDR|HLG/i.test(range)) return { mode: 'mpv', reason: 'HDR' };
    const codec = (video.Codec || '').toLowerCase();
    const bits = video.BitDepth || 8;
    const ok = (codec === 'h264' && bits <= 8)
      || (codec === 'hevc' && (bits <= 8 ? c.hevc : c.hevc10))
      || (codec === 'av1' && c.av1)
      || (codec === 'vp9' && c.vp9)
      || codec === 'vp8';
    if (!ok) return { mode: 'mpv', reason: `vídeo ${codec.toUpperCase()}${bits > 8 ? ` ${bits} bits` : ''}` };
  }

  const sub = streams.find((s) => s.Type === 'Subtitle' && s.Index === ms.DefaultSubtitleStreamIndex);
  if (sub && IMAGE_SUBS.test(sub.Codec || '')) return { mode: 'mpv', reason: 'subtítulos de imagen' };

  const audioIndex = ms.DefaultAudioStreamIndex ?? audios[0]?.Index;
  const audio = audios.find((a) => a.Index === audioIndex) || audios[0];
  if (audio) {
    const codec = (audio.Codec || '').toLowerCase();
    const appAudio = APP_AUDIO.has(codec) || (codec === 'ac3' && c.ac3) || (codec === 'eac3' && c.eac3);
    if (!appAudio) return { mode: 'remux', reason: `audio ${codec.toUpperCase()}` };
    // The app can't pick a different audio track inside the original file.
    if (audios.length > 1 && audio !== audios[0]) return { mode: 'remux', reason: 'pista de audio' };
  }
  return { mode: 'direct' };
}

// Server conversions that keep the original picture (only audio is touched) are always fine.
const AUDIO_ONLY = /^(Audio\w+|ContainerNotSupported)$/;
export function onlyAudioConverted(transcodingUrl) {
  const raw = new URLSearchParams((transcodingUrl || '').split('?')[1] || '').get('TranscodeReasons') || '';
  const reasons = raw.split(',').filter(Boolean);
  return reasons.length > 0 && reasons.every((r) => AUDIO_ONLY.test(r));
}
