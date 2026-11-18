// Pendientes: everything waiting to be watched in one place, Apple TV style. A full-screen hero shows
// one title (the newest on your list, or whichever card you point at / focus with the remote), and
// below it two rows: your "Tengo que verla" list and what friends have recommended to you, each card
// with a way to take it off. Needs the friends service.
import { h, toast, button } from '../ui.js';
import { ctx } from '../context.js';
import { icons } from '../icons.js';
import { posterCard, thumbCard, rowOf } from '../cards.js';
import { backdropSrc, logoSrc, progressOf } from '../media.js';
import { configured, waitForSocial, social } from '../social.js';
import { metaLine } from './home.js';

const boxsets = () => ctx.views?.find((v) => v.CollectionType === 'boxsets');
const n = (x, one, many) => `${x} ${x === 1 ? one : many}`;

export async function pendingView({ isStale }) {
  const body = h('div', { class: 'pending-body' });
  const page = h('div', { class: 'page pending' }, body);
  const waitingHead = (text) => body.replaceChildren(header(h('p', { class: 'friends-status' }, h('span', { class: 'mini-spinner' }), text)));
  waitingHead('Conectando con el servicio de amigos…');

  let cleanup = () => {};
  waitForSocial({ isStale, onWaiting: () => { if (!isStale()) waitingHead('Arrancando el servicio de amigos… en cuanto conteste aparece aquí tu lista.'); } })
    .then(async (url) => {
      if (isStale()) return;
      if (!url) {
        body.replaceChildren(header(h('p', { class: 'muted' }, configured()
          ? 'El servicio de amigos no contesta. Comprueba que está encendido en el servidor.'
          : 'Para tener una lista de pendientes hace falta el servicio de amigos junto a Jellyfin (Ajustes → Amigos).')));
        return;
      }
      const { loadPending } = await import('../friends.js');
      const data = await loadPending();
      if (!isStale()) cleanup = paint(body, data);
    })
    .catch((e) => { if (!isStale()) body.replaceChildren(header(h('p', { class: 'muted' }, e.message))); });

  return { node: page, cleanup: () => cleanup() };
}

// Title block for the states without a hero (loading, no service, empty list).
function header(...extra) {
  return h('div', { class: 'pending-plain' },
    boxsets() ? h('a', { class: 'eyebrow-link', href: `#/library/${boxsets().Id}` }, '‹ Colecciones') : null,
    h('h1', null, 'Pendientes'),
    extra);
}

function paint(body, { recs, list }) {
  // One entry per card: what's on your list, then what friends recommend (not repeated).
  const listIds = new Set(list.map((w) => w.item.Id));
  const entries = [
    ...list.map((w) => ({ kind: 'list', item: w.item })),
    ...recs.filter((r) => !listIds.has(r.item.Id)).map((r) => ({ kind: 'rec', item: r.item, from: r.from, notes: r.notes, ids: r.ids })),
  ];
  if (!entries.length) {
    body.replaceChildren(emptyPage());
    return () => {};
  }

  const hero = featureHero();
  const summary = h('span', { class: 'pending-summary' });
  const top = h('div', { class: 'pending-top' },
    boxsets() ? h('a', { class: 'eyebrow-link', href: `#/library/${boxsets().Id}` }, '‹ Colecciones') : null,
    h('h1', null, 'Pendientes'),
    summary);

  const remove = async (entry, card) => {
    if (entry.kind === 'list') {
      await social.watchlist(entry.item.Id, false);
      toast(`${entry.item.Name} ya no está en «Tengo que verla»`);
    } else {
      await Promise.all(entry.ids.map((id) => social.dismiss(id)));
      toast('Recomendación quitada');
    }
    entries.splice(entries.indexOf(entry), 1);
    card.remove();
    refresh();
    if (hero.current === entry && entries.length) hero.show(entries[0]);
  };

  const makeCard = (entry) => {
    const card = entry.kind === 'list' ? posterCard(entry.item) : thumbCard(entry.item);
    if (entry.kind === 'rec') {
      const sub = card.querySelector('.card-sub') || card.appendChild(h('div', { class: 'card-sub' }));
      sub.textContent = `De ${entry.from.join(', ')}`;
      if (entry.notes.length) card.append(h('div', { class: 'pending-note', title: entry.notes.map((x) => `${x.from}: «${x.note}»`).join('\n') }, `«${entry.notes[0].note}»`));
    }
    // Pointing at a card (or focusing it with the remote) brings it to the hero, as on Apple TV.
    let t;
    const feature = () => { clearTimeout(t); t = setTimeout(() => hero.show(entry), 260); };
    card.addEventListener('pointerenter', feature);
    card.addEventListener('focus', feature);
    card.addEventListener('pointerleave', () => clearTimeout(t));
    const label = entry.kind === 'list' ? 'Quitar de la lista' : 'Quitar la recomendación';
    const btn = h('button', {
      class: 'pending-remove', title: label, 'aria-label': label, html: icons.close,
      onclick: async (e) => {
        e.preventDefault();
        e.stopPropagation();
        btn.disabled = true;
        try { await remove(entry, card); } catch (err) { btn.disabled = false; toast(err.message, 'error'); }
      },
    });
    card.querySelector('.card-art')?.append(btn);
    return card;
  };

  const countPill = h('span', { class: 'pending-count' });
  const listRow = rowOf([h('span', { class: 'pending-icon', html: icons.bookmarkFill }), 'Tengo que verla', countPill],
    entries.filter((e) => e.kind === 'list').map(makeCard), { cls: 'pending-row' });
  const recRow = rowOf([h('span', { class: 'pending-icon', html: icons.send }), 'Te recomiendan tus amigos'],
    entries.filter((e) => e.kind === 'rec').map(makeCard), { kind: 'thumb', cls: 'pending-row' });
  const emptyList = h('div', { class: 'pending-empty glass' },
    h('span', { class: 'pending-empty-icon', html: icons.bookmark }),
    h('div', null,
      h('strong', null, 'Tu lista está vacía'),
      h('p', { class: 'muted' }, 'En la ficha de cualquier película o serie, pulsa el marcador para guardarla aquí. Lo que vayas viendo sale solo de la lista.')));

  function refresh() {
    const nl = entries.filter((e) => e.kind === 'list').length;
    const nr = entries.filter((e) => e.kind === 'rec').length;
    summary.textContent = [nl ? n(nl, 'guardada', 'guardadas') : '', nr ? n(nr, 'recomendación', 'recomendaciones') : ''].filter(Boolean).join('  ·  ');
    countPill.textContent = nl ? String(nl) : '';
    listRow.hidden = !nl;
    emptyList.hidden = !!nl;
    recRow.hidden = !nr;
    if (!entries.length) body.replaceChildren(emptyPage());
  }

  body.replaceChildren(
    h('div', { class: 'pending-stage' }, hero.node, top),
    h('div', { class: 'rows overlap pending-rows' }, listRow, emptyList, recRow));
  hero.show(entries[0]);
  refresh();
  return () => {};
}

// The big picture at the top: backdrop, logo (or title), what it is, and what you can do with it.
function featureHero() {
  const api = ctx.api;
  const width = Math.min(1920, Math.ceil((window.innerWidth * (window.devicePixelRatio || 1)) / 320) * 320);
  const layers = h('div', { class: 'pending-layers' });
  const content = h('div', { class: 'hero-content' });
  const node = h('section', { class: 'hero pending-hero' }, layers, h('div', { class: 'hero-shade' }), content);
  const self = { node, current: null, show };

  function show(entry) {
    if (!entry || self.current === entry) return;
    self.current = entry;
    const item = entry.item;

    // Cross-fade: the new backdrop fades in over the old one once it has loaded.
    const src = backdropSrc(api, item, width);
    const old = [...layers.children];
    if (src) {
      const img = h('img', { class: 'hero-bg', alt: '', decoding: 'async', src });
      const layer = h('div', { class: 'hero-layer' }, img);
      img.addEventListener('load', () => {
        if (self.current !== entry) return layer.remove();
        layer.classList.add('active');
        setTimeout(() => old.forEach((l) => l.remove()), 1200);
      });
      layers.append(layer);
    } else {
      old.forEach((l) => l.classList.remove('active'));
    }

    const logo = logoSrc(api, item);
    const pct = progressOf(item);
    const isList = entry.kind === 'list';
    const note = entry.notes?.[0];
    content.replaceChildren(h('div', { class: 'hero-text fade-in' },
      h('div', { class: 'pending-eyebrow' },
        h('span', { html: isList ? icons.bookmarkFill : icons.send }),
        isList ? 'En tu lista' : `Te la recomienda ${entry.from.join(' y ')}`),
      logo ? h('img', { class: 'hero-logo', src: logo, alt: item.Name }) : h('h2', { class: 'hero-title' }, item.Name),
      h('div', { class: 'hero-meta' }, metaLine(item)),
      note ? h('p', { class: 'pending-quote' }, `«${note.note}»`, h('span', null, ` — ${note.from}`)) : null,
      item.Overview ? h('p', { class: 'hero-overview' }, item.Overview) : null,
      h('div', { class: 'actions' },
        button(pct ? 'Reanudar' : 'Reproducir', { kind: 'primary', icon: 'play', onclick: () => ctx.play(item) }),
        button('Más información', { onclick: () => { location.hash = `#/item/${item.Id}`; } }))));
  }
  return self;
}

function emptyPage() {
  return h('div', { class: 'pending-empty-page fade-in' },
    boxsets() ? h('a', { class: 'eyebrow-link', href: `#/library/${boxsets().Id}` }, '‹ Colecciones') : null,
    h('div', { class: 'pending-empty-art', html: icons.bookmark }),
    h('h1', null, 'Nada pendiente'),
    h('p', { class: 'muted' }, 'Guarda aquí lo que quieras ver con el marcador de cada ficha. Cuando un amigo te recomiende algo, también aparecerá aquí.'),
    h('div', { class: 'actions' }, button('Ir al inicio', { kind: 'primary', onclick: () => { location.hash = '#/home'; } })));
}
