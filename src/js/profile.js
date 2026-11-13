// Builds a Jellyfin DeviceProfile from what this Chromium build can actually decode,
// so the server only transcodes what is really needed.
import { store } from './store.js';

let cached = null;

// Without a real conversion bitrate the server would re-encode at ~200 Mbps and full 4K: far too much
// for the NAS. Conversions are 1080p at this bitrate unless the user picks another quality.
export const CONVERT_BITRATE = 8_000_000;
const DIRECT_BITRATE = 200_000_000;

function mse(type) {
  try { return window.MediaSource?.isTypeSupported(type) || false; } catch { return false; }
}

export function capabilities() {
  if (!cached) {
    const v = document.createElement('video');
    const can = (t) => v.canPlayType(t).replace('no', '') !== '';
    const hevc = mse('video/mp4; codecs="hvc1.1.6.L120.90"') || mse('video/mp4; codecs="hev1.1.6.L120.90"');
    const hevc10 = mse('video/mp4; codecs="hvc1.2.4.L120.90"') || mse('video/mp4; codecs="hev1.2.4.L120.90"');
    cached = {
      hevc,
      hevc10,
      av1: mse('video/mp4; codecs="av01.0.08M.08"'),
      vp9: mse('video/webm; codecs="vp9"'),
      mkvNative: can('video/x-matroska; codecs="avc1.640028, mp4a.40.2"') || can('video/x-matroska'),
      flac: mse('audio/mp4; codecs="flac"'),
      opus: mse('audio/mp4; codecs="opus"') || mse('audio/webm; codecs="opus"'),
      ac3: mse('audio/mp4; codecs="ac-3"'),
      eac3: mse('audio/mp4; codecs="ec-3"'),
    };
  }
  // Browsers often play MKV even though they say they can't (it is the same format as WebM). Outside the
  // TV app, an MKV is tried as-is once; whether that worked is remembered for this device (learnMkv).
  const learned = store.get('mkvDirect');
  cached.mkv = cached.mkvNative || (learned ?? !window.LumenTV) === true;
  return cached;
}

export function learnMkv(ok) {
  if (cached?.mkvNative || store.get('mkvDirect') === ok) return;
  store.set('mkvDirect', ok);
}

// convert: the profile for a real video conversion (capped bitrate, image subtitles burned in).
// Otherwise the server is told the bitrate doesn't matter, so it never re-encodes just to save bandwidth.
export function deviceProfile({ convert = false, maxBitrate } = {}) {
  const c = capabilities();
  const bitrate = convert ? maxBitrate || CONVERT_BITRATE : DIRECT_BITRATE;
  const mp4Video = ['h264', c.hevc && 'hevc', c.av1 && 'av1', c.vp9 && 'vp9'].filter(Boolean).join(',');
  const audio = ['aac', 'mp3', c.opus && 'opus', c.flac && 'flac', c.ac3 && 'ac3', c.eac3 && 'eac3', 'vorbis']
    .filter(Boolean).join(',');

  const directPlay = [
    { Container: 'mp4,m4v,mov', Type: 'Video', VideoCodec: mp4Video, AudioCodec: audio },
    { Container: 'webm', Type: 'Video', VideoCodec: ['vp8', 'vp9', c.av1 && 'av1'].filter(Boolean).join(','), AudioCodec: 'vorbis,opus' },
  ];
  if (c.mkv) directPlay.push({ Container: 'mkv', Type: 'Video', VideoCodec: mp4Video, AudioCodec: audio });

  const codecProfiles = [
    {
      Type: 'Video',
      Codec: 'h264',
      Conditions: [
        { Condition: 'LessThanEqual', Property: 'VideoBitDepth', Value: '8', IsRequired: false },
        { Condition: 'EqualsAny', Property: 'VideoProfile', Value: 'high|main|baseline|constrained baseline', IsRequired: false },
      ],
    },
  ];
  if (c.hevc && !c.hevc10) {
    codecProfiles.push({
      Type: 'Video',
      Codec: 'hevc',
      Conditions: [{ Condition: 'LessThanEqual', Property: 'VideoBitDepth', Value: '8', IsRequired: false }],
    });
  }

  // Image subtitles can only be shown by burning them into the picture (a full conversion), so they
  // are only offered that way when converting is allowed.
  const imageSubs = convert ? ['pgssub', 'pgs', 'dvdsub', 'dvbsub'].map((Format) => ({ Format, Method: 'Encode' })) : [];

  return {
    Name: 'Lumen',
    MaxStreamingBitrate: bitrate,
    MaxStaticBitrate: DIRECT_BITRATE,
    MusicStreamingTranscodingBitrate: 384000,
    DirectPlayProfiles: directPlay,
    TranscodingProfiles: [
      {
        // fMP4 lets the server copy HEVC/AV1 video untouched and only touch the audio when the app
        // can't decode it (Dolby Digital is copied too where the browser plays it, e.g. Edge or Safari).
        Container: 'mp4',
        Type: 'Video',
        Protocol: 'hls',
        Context: 'Streaming',
        VideoCodec: ['h264', c.hevc && 'hevc', c.av1 && 'av1'].filter(Boolean).join(','),
        AudioCodec: ['aac', c.eac3 && 'eac3', c.ac3 && 'ac3', c.flac && 'flac', 'mp3'].filter(Boolean).join(','),
        MaxAudioChannels: '6',
        MinSegments: 1,
        // Repackaging (picture copied): one segment per keyframe. With Jellyfin's default of 6 s, a
        // stream started mid-file (resume, seek) is cut at other points than its playlist says, a few
        // seconds more off with every segment: playback then jumps ahead or falls behind by itself.
        // Short segments also reach the screen sooner. A real conversion keeps the server's default.
        ...(convert ? {} : { SegmentLength: 1 }),
        BreakOnNonKeyFrames: true,
        CopyTimestamps: false,
      },
    ],
    ContainerProfiles: [],
    CodecProfiles: codecProfiles,
    SubtitleProfiles: [
      { Format: 'vtt', Method: 'External' },
      { Format: 'ass', Method: 'External' },
      { Format: 'ssa', Method: 'External' },
      ...imageSubs,
    ],
    ResponseProfiles: [],
  };
}
