import { h, image, episodeLabel, fmtRuntime } from './ui.js';
import { icons } from './icons.js';
import { ctx } from './context.js';
import { posterSrc, thumbSrc, progressOf } from './media.js';
import { attachCardActions } from './cardmenu.js';

function progressBar(pct) {
  return h('div', { class: 'progress' }, h('div', { style: { width: `${Math.min(100, Math.max(2, pct))}%` } }));
}

function playedBadge(item) {
  const ud = item.UserData || {};
  if (ud.Played) return h('span', { class: 'badge-played', html: icons.check });
  if (item.Type === 'Series' && ud.UnplayedItemCount) return h('span', { class: 'badge-count' }, ud.UnplayedItemCount);
  return null;
}

function itemHref(item) {
  if (item.Type === 'Season' && item.SeriesId) return `#/item/${item.SeriesId}?season=${item.Id}`;
  if (item.CollectionType || item.Type === 'CollectionFolder' || item.Type === 'UserView') return `#/library/${item.Id}`;
  return `#/item/${item.Id}`;
}

export function posterCard(item) {
  const pct = progressOf(item);
  const sub = item.Type === 'Episode'
    ? episodeLabel(item)
    : item.ProductionYear || (item.Type === 'Season' ? item.SeriesName : '');
  const card = h('a', { class: 'card card-poster', href: itemHref(item), title: item.Name },
    h('div', { class: 'card-art' },
      image(posterSrc(ctx.api, item, 360), { placeholder: item.Name }),
      playedBadge(item),
      pct ? progressBar(pct) : null),
    h('div', { class: 'card-title' }, item.Type === 'Episode' ? item.SeriesName : item.Name),
    sub ? h('div', { class: 'card-sub' }, sub) : null);
  attachCardActions(card, item);
  return card;
}

export function thumbCard(item, { showPlay = true } = {}) {
  const pct = progressOf(item);
  const isEp = item.Type === 'Episode';
  let sub;
  if (isEp) sub = [episodeLabel(item), item.Name].filter(Boolean).join(' — ');
  else if (pct && item.RunTimeTicks) sub = `Quedan ${fmtRuntime(item.RunTimeTicks * (1 - pct / 100))}`;
  else sub = item.ProductionYear || '';

  const play = showPlay
    ? h('button', {
      class: 'card-play',
      title: 'Reproducir',
      html: icons.play,
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); ctx.play(item); },
    })
    : null;

  const card = h('a', { class: 'card card-thumb', href: itemHref(item), title: item.Name },
    h('div', { class: 'card-art' },
      image(thumbSrc(ctx.api, item, 640), { placeholder: isEp ? item.SeriesName : item.Name }),
      playedBadge(item),
      play,
      pct ? progressBar(pct) : null),
    h('div', { class: 'card-title' }, isEp ? item.SeriesName : item.Name),
    sub ? h('div', { class: 'card-sub' }, sub) : null);
  attachCardActions(card, item);
  return card;
}

export function row(title, items, { kind = 'poster', href } = {}) {
  if (!items?.length) return null;
  const make = kind === 'thumb' ? thumbCard : posterCard;
  const track = h('div', { class: `row-track row-${kind}` }, items.map((i) => make(i)));
  const scroll = (dir) => track.scrollBy({ left: dir * track.clientWidth * 0.85, behavior: 'smooth' });
  const prev = h('button', { class: 'row-arrow prev', 'aria-label': 'Anterior', html: icons.back, onclick: () => scroll(-1) });
  const next = h('button', { class: 'row-arrow next', 'aria-label': 'Siguiente', html: icons.next, onclick: () => scroll(1) });
  const update = () => {
    prev.classList.toggle('hidden', track.scrollLeft < 8);
    next.classList.toggle('hidden', track.scrollLeft + track.clientWidth >= track.scrollWidth - 8);
  };
  track.addEventListener('scroll', update, { passive: true });
  requestAnimationFrame(update);
  return h('section', { class: 'row' },
    h('div', { class: 'row-head' },
      h('h2', null, title),
      href ? h('a', { class: 'row-more', href }, 'Ver todo') : null),
    h('div', { class: 'row-body' }, prev, track, next));
}
