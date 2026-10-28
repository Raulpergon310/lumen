import { h, button, image, fmtRuntime, episodeLabel, toast, spinner } from '../ui.js';
import { icons } from '../icons.js';
import { ctx } from '../context.js';
import { row, posterCard } from '../cards.js';
import { backdropSrc, logoSrc, thumbSrc, progressOf, techBadges } from '../media.js';
import { openImagePicker } from '../images.js';
import { attachCardActions } from '../cardmenu.js';
import { personCard } from './person.js';

export async function itemView({ params: [id], query, isStale }) {
  const api = ctx.api;
  const item = await api.item(id);
  if (isStale()) return null;

  if (item.Type === 'Season' && item.SeriesId) {
    location.replace(`#/item/${item.SeriesId}?season=${item.Id}`);
    return null;
  }
  if (item.IsFolder && !['Series', 'Season'].includes(item.Type)) {
    return folderView(item, isStale);
  }

  const backdrop = backdropSrc(api, item, 1920);
  const page = h('div', { class: 'page detail' },
    h('div', { class: 'detail-backdrop' },
      backdrop ? h('img', { src: backdrop, alt: '', decoding: 'async' }) : null,
      h('div', { class: 'detail-shade' }),
      h('div', { class: 'detail-dim' })));

  const header = h('section', { class: 'detail-head' });
  page.append(header);
  renderHeader(header, item);

  if (item.Type === 'Series') {
    page.append(await seriesSection(item, query.season));
    if (isStale()) return null;
  }

  const cast = (item.People || []).filter((p) => ['Actor', 'GuestStar'].includes(p.Type)).slice(0, 20);
  if (cast.length) page.append(castRow(cast));

  // Secondary content loads after the page is already on screen.
  if (item.Type !== 'Episode') {
    const slot = h('div');
    page.append(slot);
    api.similar(item.Id).then((similar) => {
      const r = row('También te puede gustar', similar);
      if (r) slot.replaceWith(r);
    }).catch(() => {});
  }
  // Ask the server about the file now, so pressing play starts straight away.
  if (item.Type === 'Movie' || item.Type === 'Episode') import('../mpv-player.js').then((m) => { m.probeSource(item); m.warmFile(item); }).catch(() => {});

  // Darken and blur the backdrop as the page scrolls so text below the fold stays readable.
  const dim = page.querySelector('.detail-dim');
  const onScroll = () => { dim.style.opacity = Math.min(1, window.scrollY / (window.innerHeight * 0.5)); };
  window.addEventListener('scroll', onScroll, { passive: true });
  return { node: page, cleanup: () => window.removeEventListener('scroll', onScroll) };
}

function renderHeader(header, item) {
  const api = ctx.api;
  const isEp = item.Type === 'Episode';
  const logo = logoSrc(api, item);
  const ud = item.UserData || {};
  const pct = progressOf(item);

  const meta = [];
  if (isEp) meta.push(episodeLabel(item));
  if (item.ProductionYear) meta.push(item.ProductionYear);
  if (item.RunTimeTicks && item.Type !== 'Series') meta.push(fmtRuntime(item.RunTimeTicks));
  if (item.Type === 'Series' && item.ChildCount) meta.push(`${item.ChildCount} temporada${item.ChildCount > 1 ? 's' : ''}`);
  if (item.OfficialRating) meta.push(item.OfficialRating);

  const rating = item.CommunityRating
    ? h('span', { class: 'rating' }, h('span', { html: icons.star }), item.CommunityRating.toFixed(1))
    : null;

  const actions = h('div', { class: 'actions' });
  const playLabel = pct ? `Reanudar · quedan ${fmtRuntime(item.RunTimeTicks * (1 - pct / 100))}` : 'Reproducir';

  if (item.Type === 'Series') {
    const playBtn = button('Reproducir', { kind: 'primary', icon: 'play' });
    playBtn.disabled = true;
    actions.append(playBtn);
    seriesPlayTarget(item).then((ep) => {
      if (!ep) return;
      import('../mpv-player.js').then((m) => { m.probeSource(ep); m.warmFile(ep); }).catch(() => {});
      playBtn.disabled = false;
      const resumed = progressOf(ep) > 0;
      playBtn.lastChild.textContent = `${resumed ? 'Continuar' : 'Reproducir'} ${episodeLabel(ep)}`;
      playBtn.onclick = () => ctx.play(ep);
    });
  } else {
    actions.append(button(playLabel, { kind: 'primary', icon: 'play', onclick: () => ctx.play(item) }));
    if (pct) actions.append(button('Desde el principio', { onclick: () => ctx.play(item, { fromStart: true }) }));
  }

  const playedBtn = h('button', { class: `round-btn ${ud.Played ? 'on' : ''}`, title: 'Marcar como visto', html: icons.check });
  playedBtn.onclick = async () => {
    const next = !playedBtn.classList.contains('on');
    playedBtn.classList.toggle('on', next);
    try {
      await api.setPlayed(item.Id, next);
      toast(next ? 'Marcado como visto' : 'Marcado como no visto');
    } catch (e) {
      playedBtn.classList.toggle('on', !next);
      toast(e.message, 'error');
    }
  };
  const favBtn = h('button', { class: `round-btn ${ud.IsFavorite ? 'on' : ''}`, title: 'Favorito', html: ud.IsFavorite ? icons.heartFill : icons.heart });
  favBtn.onclick = async () => {
    const next = !favBtn.classList.contains('on');
    favBtn.classList.toggle('on', next);
    favBtn.innerHTML = next ? icons.heartFill : icons.heart;
    try {
      await api.setFavorite(item.Id, next);
    } catch (e) {
      favBtn.classList.toggle('on', !next);
      favBtn.innerHTML = !next ? icons.heartFill : icons.heart;
      toast(e.message, 'error');
    }
  };
  const imagesBtn = h('button', { class: 'round-btn', title: 'Cambiar póster e imágenes', html: icons.image, onclick: () => openImagePicker(item, { onChanged: () => ctx.refresh() }) });
  actions.append(playedBtn, favBtn, imagesBtn);
  if (isEp && item.SeriesId) {
    actions.append(button('Ver serie', { onclick: () => { location.hash = `#/item/${item.SeriesId}?season=${item.SeasonId || ''}`; } }));
  }

  const directors = (item.People || []).filter((p) => p.Type === 'Director').slice(0, 2);
  const directorLinks = directors.flatMap((p, i) => [i ? ', ' : null, h('a', { class: 'fact-link', href: `#/person/${p.Id}` }, p.Name)]).filter(Boolean);
  const facts = [
    item.Genres?.length ? ['Géneros', item.Genres.slice(0, 4).join(', ')] : null,
    directors.length ? ['Dirección', directorLinks] : null,
    item.Studios?.length ? ['Estudio', item.Studios.slice(0, 2).map((s) => s.Name).join(', ')] : null,
  ].filter(Boolean);

  header.replaceChildren(h('div', { class: 'detail-info' },
    isEp && item.SeriesName ? h('a', { class: 'eyebrow-link', href: `#/item/${item.SeriesId}` }, item.SeriesName) : null,
    logo && !isEp
      ? h('img', { class: 'detail-logo', src: logo, alt: item.Name })
      : h('h1', { class: 'detail-title' }, item.Name),
    h('div', { class: 'detail-meta' }, meta.join('  ·  '), rating),
    h('div', { class: 'chips' }, techBadges(item).map((b) => h('span', { class: 'chip' }, b))),
    item.Taglines?.[0] ? h('p', { class: 'tagline' }, item.Taglines[0]) : null,
    item.Overview ? h('p', { class: 'overview' }, item.Overview) : null,
    actions,
    facts.length ? h('dl', { class: 'facts' }, facts.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])) : null));
}

async function seriesPlayTarget(series) {
  const api = ctx.api;
  try {
    const [next] = await api.nextUp({ seriesId: series.Id, limit: 1 });
    if (next) return next;
    const seasons = await api.seasons(series.Id);
    const first = seasons.find((s) => s.IndexNumber > 0) || seasons[0];
    if (!first) return null;
    const eps = await api.episodes(series.Id, first.Id);
    return eps[0] || null;
  } catch {
    return null;
  }
}

async function seriesSection(series, wantedSeason) {
  const api = ctx.api;
  const seasons = await api.seasons(series.Id);
  const wrap = h('section', { class: 'seasons' });
  if (!seasons.length) return wrap;

  let current = seasons.find((s) => s.Id === wantedSeason);
  if (!current) {
    const [next] = await api.nextUp({ seriesId: series.Id, limit: 1 }).catch(() => []);
    current = seasons.find((s) => s.Id === next?.SeasonId) || seasons.find((s) => s.IndexNumber > 0) || seasons[0];
  }

  const pills = h('div', { class: 'pills' });
  const list = h('div', { class: 'episodes' });
  const seasonBtn = h('button', { class: 'btn btn-glass small season-played' });
  const paintSeasonBtn = () => {
    const played = !!current.UserData?.Played;
    seasonBtn.replaceChildren(h('span', { class: 'btn-icon', html: icons.check }), h('span', null, played ? 'Marcar temporada como no vista' : 'Marcar temporada como vista'));
  };
  seasonBtn.onclick = async () => {
    const season = current;
    const next = !season.UserData?.Played;
    seasonBtn.disabled = true;
    try {
      await api.setPlayed(season.Id, next);
      season.UserData = { ...season.UserData, Played: next };
      toast(next ? `${season.Name}: vista` : `${season.Name}: no vista`);
      if (current === season) load(season);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      seasonBtn.disabled = false;
    }
  };

  const load = async (season) => {
    current = season;
    paintSeasonBtn();
    for (const p of pills.children) p.classList.toggle('active', p.dataset.id === season.Id);
    list.replaceChildren(spinner());
    try {
      const eps = await api.episodes(series.Id, season.Id);
      if (current !== season) return;
      list.replaceChildren(...eps.map(episodeCard));
      const target = eps.find((e) => progressOf(e) > 0) || eps.find((e) => !e.UserData?.Played);
      const idx = target ? eps.indexOf(target) : 0;
      if (idx > 0) requestAnimationFrame(() => list.children[idx]?.scrollIntoView({ inline: 'start', block: 'nearest' }));
    } catch (e) {
      list.replaceChildren(h('p', { class: 'muted' }, e.message));
    }
  };

  for (const s of seasons) {
    pills.append(h('button', { class: 'pill', dataset: { id: s.Id }, onclick: () => load(s) }, s.Name));
  }
  load(current);
  wrap.append(h('div', { class: 'season-bar' }, pills, seasonBtn), list);
  return wrap;
}

function episodeCard(ep) {
  const api = ctx.api;
  const pct = progressOf(ep);
  const card = h('div', { class: 'episode', tabindex: '0', onclick: () => ctx.play(ep), onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); ctx.play(ep); } } },
    h('div', { class: 'card-art' },
      image(thumbSrc(api, ep, 640), { placeholder: ep.Name }),
      ep.UserData?.Played ? h('span', { class: 'badge-played', html: icons.check }) : null,
      h('span', { class: 'card-play static', html: icons.play }),
      pct ? h('div', { class: 'progress' }, h('div', { style: { width: `${pct}%` } })) : null),
    h('div', { class: 'episode-num' }, `${ep.IndexNumber != null ? 'Episodio ' + ep.IndexNumber : ''}${ep.RunTimeTicks ? '  ·  ' + fmtRuntime(ep.RunTimeTicks) : ''}`),
    h('div', { class: 'episode-title' }, ep.Name),
    ep.Overview ? h('p', { class: 'episode-overview' }, ep.Overview) : null);
  attachCardActions(card, ep);
  return card;
}

function castRow(people) {
  const api = ctx.api;
  return h('section', { class: 'row cast' },
    h('div', { class: 'row-head' }, h('h2', null, 'Reparto')),
    h('div', { class: 'row-track' }, people.map((p) => personCard(p, p.Role))));
}

async function folderView(item, isStale) {
  const r = await ctx.api.items({ ParentId: item.Id, SortBy: 'SortName', Limit: 300 });
  if (isStale()) return null;
  return h('div', { class: 'page library' },
    h('div', { class: 'lib-head' }, h('h1', null, item.Name)),
    h('div', { class: 'grid' }, (r.Items || []).map(posterCard)));
}
