// Picks the right artwork for an item, falling back to its series/parent.
export function posterSrc(api, item, width = 320) {
  if (item.Type === 'Episode' && item.SeriesId && item.SeriesPrimaryImageTag) {
    return api.image(item.SeriesId, 'Primary', { width, tag: item.SeriesPrimaryImageTag });
  }
  if (item.ImageTags?.Primary) return api.image(item.Id, 'Primary', { width, tag: item.ImageTags.Primary });
  if (item.SeriesId && item.SeriesPrimaryImageTag) {
    return api.image(item.SeriesId, 'Primary', { width, tag: item.SeriesPrimaryImageTag });
  }
  return null;
}

export function thumbSrc(api, item, width = 560) {
  if (item.Type === 'Episode' && item.ImageTags?.Primary) {
    return api.image(item.Id, 'Primary', { width, tag: item.ImageTags.Primary });
  }
  if (item.ImageTags?.Thumb) return api.image(item.Id, 'Thumb', { width, tag: item.ImageTags.Thumb });
  if (item.BackdropImageTags?.length) return api.image(item.Id, 'Backdrop', { width, tag: item.BackdropImageTags[0] });
  if (item.ParentThumbItemId && item.ParentThumbImageTag) {
    return api.image(item.ParentThumbItemId, 'Thumb', { width, tag: item.ParentThumbImageTag });
  }
  if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.length) {
    return api.image(item.ParentBackdropItemId, 'Backdrop', { width, tag: item.ParentBackdropImageTags[0] });
  }
  return null;
}

export function backdropSrc(api, item, width = 1920) {
  if (item.BackdropImageTags?.length) return api.image(item.Id, 'Backdrop', { width, tag: item.BackdropImageTags[0] });
  if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.length) {
    return api.image(item.ParentBackdropItemId, 'Backdrop', { width, tag: item.ParentBackdropImageTags[0] });
  }
  return null;
}

export function logoSrc(api, item, width = 640) {
  if (item.ImageTags?.Logo) return api.image(item.Id, 'Logo', { width, tag: item.ImageTags.Logo, quality: 100 });
  if (item.ParentLogoItemId && item.ParentLogoImageTag) {
    return api.image(item.ParentLogoItemId, 'Logo', { width, tag: item.ParentLogoImageTag, quality: 100 });
  }
  return null;
}

export function progressOf(item) {
  const ud = item.UserData || {};
  if (ud.PlayedPercentage > 0 && ud.PlayedPercentage < 100) return ud.PlayedPercentage;
  if (ud.PlaybackPositionTicks && item.RunTimeTicks) return (ud.PlaybackPositionTicks / item.RunTimeTicks) * 100;
  return 0;
}

// Badges like 4K / HDR / 5.1 from the first media source.
export function techBadges(item) {
  const streams = item.MediaStreams || item.MediaSources?.[0]?.MediaStreams || [];
  const video = streams.find((s) => s.Type === 'Video');
  const audio = streams.filter((s) => s.Type === 'Audio');
  const out = [];
  if (video) {
    const w = video.Width || 0;
    if (w >= 3200) out.push('4K');
    else if (w >= 1800) out.push('HD');
    else if (w >= 1200) out.push('720p');
    else if (w) out.push('SD');
    const range = video.VideoRangeType || video.VideoRange || '';
    if (/DOVI/i.test(range)) out.push('Dolby Vision');
    else if (/HDR10Plus/i.test(range)) out.push('HDR10+');
    else if (/HDR|HLG/i.test(range)) out.push('HDR');
  }
  const maxCh = Math.max(0, ...audio.map((a) => a.Channels || 0));
  if (maxCh >= 8) out.push('7.1');
  else if (maxCh >= 6) out.push('5.1');
  if (audio.some((a) => /atmos/i.test(a.DisplayTitle || '') || /atmos/i.test(a.Profile || ''))) out.push('Atmos');
  if (streams.some((s) => s.Type === 'Subtitle')) out.push('CC');
  return out;
}
