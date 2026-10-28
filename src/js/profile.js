// Builds a Jellyfin DeviceProfile from what this Chromium build can actually decode,
// so the server only transcodes what is really needed.
let cached = null;

function mse(type) {
  try { return window.MediaSource?.isTypeSupported(type) || false; } catch { return false; }
}

export function capabilities() {
  if (cached) return cached;
  const v = document.createElement('video');
  const can = (t) => v.canPlayType(t).replace('no', '') !== '';
  const hevc = mse('video/mp4; codecs="hvc1.1.6.L120.90"') || mse('video/mp4; codecs="hev1.1.6.L120.90"');
  const hevc10 = mse('video/mp4; codecs="hvc1.2.4.L120.90"') || mse('video/mp4; codecs="hev1.2.4.L120.90"');
  cached = {
    hevc,
    hevc10,
    av1: mse('video/mp4; codecs="av01.0.08M.08"'),
    vp9: mse('video/webm; codecs="vp9"'),
    mkv: can('video/x-matroska; codecs="avc1.640028, mp4a.40.2"') || can('video/x-matroska'),
    flac: mse('audio/mp4; codecs="flac"'),
    opus: mse('audio/mp4; codecs="opus"') || mse('audio/webm; codecs="opus"'),
    ac3: mse('audio/mp4; codecs="ac-3"'),
    eac3: mse('audio/mp4; codecs="ec-3"'),
  };
  return cached;
}

export function deviceProfile(maxBitrate) {
  const c = capabilities();
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

  return {
    Name: 'Lumen',
    MaxStreamingBitrate: maxBitrate || 200_000_000,
    MaxStaticBitrate: 200_000_000,
    MusicStreamingTranscodingBitrate: 384000,
    DirectPlayProfiles: directPlay,
    TranscodingProfiles: [
      {
        // fMP4 lets the server copy HEVC/AV1 video untouched and only convert the audio.
        Container: 'mp4',
        Type: 'Video',
        Protocol: 'hls',
        Context: 'Streaming',
        VideoCodec: ['h264', c.hevc && 'hevc', c.av1 && 'av1'].filter(Boolean).join(','),
        AudioCodec: ['aac', c.flac && 'flac', 'mp3'].filter(Boolean).join(','),
        MaxAudioChannels: '6',
        MinSegments: 1,
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
      { Format: 'pgssub', Method: 'Encode' },
      { Format: 'pgs', Method: 'Encode' },
      { Format: 'dvdsub', Method: 'Encode' },
      { Format: 'dvbsub', Method: 'Encode' },
    ],
    ResponseProfiles: [],
  };
}
