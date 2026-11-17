// Pendientes: everything waiting to be watched in one place. Your "Tengo que verla" list and what
// friends have recommended to you, with a way to take things off. Needs the friends service.
import { h, toast } from '../ui.js';
import { ctx } from '../context.js';
import { icons } from '../icons.js';
import { posterCard } from '../cards.js';
import { configured, waitForSocial, social } from '../social.js';

const boxsets = () => ctx.views?.find((v) => v.CollectionType === 'boxsets');

export async function pendingView({ isStale }) {
  const body = h('div', { class: 'pending-body' }, waiting('Conectando con el servicio de amigos…'));
  const page = h('div', { class: 'page pending' },
    h('div', { class: 'pending-head' },
      boxsets() ? h('a', { class: 'eyebrow-link', href: `#/library/${boxsets().Id}` }, '‹ Colecciones') : null,
      h('h1', null, 'Pendientes'),
      h('p', { class: 'muted' }, 'Lo que tienes guardado para ver y lo que te recomiendan tus amigos.')),
    body);

  waitForSocial({ isStale, onWaiting: () => { if (!isStale()) body.replaceChildren(waiting('Arrancando el servicio de amigos… en cuanto conteste aparece aquí tu lista.')); } })
    .then(async (url) => {
      if (isStale()) return;
      if (!url) {
        body.replaceChildren(empty(configured()
          ? 'El servicio de amigos no contesta. Comprueba que está encendido en el servidor.'
          : 'Para tener una lista de pendientes hace falta el servicio de amigos junto a Jellyfin (Ajustes → Amigos).'));
        return;
      }
      const { loadPending } = await import('../friends.js');
      const data = await loadPending();
      if (!isStale()) paint(body, data);
    })
    .catch((e) => { if (!isStale()) body.replaceChildren(empty(e.message)); });

  return page;
}

function paint(body, { recs, list }) {
  const count = h('span', { class: 'pending-count' });
  const grid = h('div', { class: 'grid pending-grid' }, list.map((w) => withRemove(posterCard(w.item), 'Quitar de la lista', async (card) => {
    await social.watchlist(w.item.Id, false);
    toast(`${w.item.Name} ya no está en «Tengo que verla»`);
    card.remove();
    refresh();
  })));
  const recGrid = h('div', { class: 'grid pending-grid' }, recs.map((r) => {
    const card = posterCard(r.item);
    const sub = card.querySelector('.card-sub') || card.appendChild(h('div', { class: 'card-sub' }));
    sub.textContent = `De ${r.from.join(', ')}`;
    if (r.notes.length) card.append(h('div', { class: 'pending-note', title: r.notes.map((n) => `${n.from}: «${n.note}»`).join('\n') }, `«${r.notes[0].note}»`));
    return withRemove(card, 'Quitar la recomendación', async (c) => {
      await Promise.all(r.ids.map((id) => social.dismiss(id)));
      toast('Recomendación quitada');
      c.remove();
      refresh();
    });
  }));
  const listSection = h('section', { class: 'pending-section' },
    h('h2', null, h('span', { class: 'pending-icon', html: icons.bookmarkFill }), 'Tengo que verla', count), grid);
  const recSection = h('section', { class: 'pending-section' },
    h('h2', null, h('span', { class: 'pending-icon', html: icons.send }), 'Te recomiendan tus amigos'), recGrid);

  function refresh() {
    count.textContent = grid.children.length ? String(grid.children.length) : '';
    if (!grid.children.length) grid.replaceWith(emptyNote(grid));
    if (!recGrid.children.length) recSection.remove();
  }
  body.replaceChildren(...[listSection, recs.length ? recSection : null].filter(Boolean));
  refresh();
}

function emptyNote(grid) {
  const el = h('div', { class: 'pending-empty' },
    h('span', { class: 'pending-empty-icon', html: icons.bookmark }),
    h('div', null,
      h('strong', null, 'Tu lista está vacía'),
      h('p', { class: 'muted' }, 'En la ficha de cualquier película o serie, pulsa el marcador para guardarla aquí. Lo que vayas viendo sale solo de la lista.')));
  return el;
}

// A small round × over the poster, shown on hover (always on touch screens).
function withRemove(card, label, action) {
  const btn = h('button', {
    class: 'pending-remove', title: label, 'aria-label': label, html: icons.close,
    onclick: async (e) => {
      e.preventDefault();
      e.stopPropagation();
      btn.disabled = true;
      try { await action(card); } catch (err) { btn.disabled = false; toast(err.message, 'error'); }
    },
  });
  card.querySelector('.card-art')?.append(btn);
  return card;
}

function waiting(text) {
  return h('p', { class: 'friends-status' }, h('span', { class: 'mini-spinner' }), text);
}

function empty(text) {
  return h('p', { class: 'muted' }, text);
}
