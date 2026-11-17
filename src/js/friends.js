// Detail page, the "friends" part: your star rating and everyone else's, who else has seen it,
// "tengo que verla", recommending it to a friend and the recommendations you've received.
// Needs the Lumen social service (social.js); without it only "who has seen it" shows, and only
// to administrators (Jellyfin doesn't let anyone else read other users' data).
import { h, button, toast, spinner } from './ui.js';
import { icons } from './icons.js';
import { ctx } from './context.js';
import { social, configured, waitForSocial } from './social.js';

export function socialSection(item, header, isStale) {
  const full = item.Type === 'Movie' || item.Type === 'Series';
  if (!configured()) return adminFallback(item, header, isStale);

  // The stars show straight away (greyed) so the page doesn't jump when the service answers.
  const box = h('div', { class: 'friends' });
  const state = { info: null, watched: null, waiting: false };
  const repaint = () => paint(item, box, state, full);
  header.querySelector('.actions')?.after(box);
  repaint();

  waitForSocial({ isStale, onWaiting: () => { state.waiting = true; if (!isStale()) repaint(); } }).then((url) => {
    if (isStale()) return;
    if (!url) { box.remove(); return adminFallback(item, header, isStale); }
    state.waiting = false;
    // Ratings answer at once; "who has seen it" asks Jellyfin about every user, so it comes apart.
    social.item(item.Id).then((info) => {
      if (isStale()) return;
      state.info = info;
      if (Array.isArray(info.watched) && !state.watched) state.watched = info.watched;
      if (full) addButtons(item, header, info);
      repaint();
    }).catch((e) => {
      if (isStale()) return;
      state.error = e.message;
      repaint();
    });
    social.watched(item.Id).then((list) => {
      if (isStale()) return;
      state.watched = list;
      repaint();
    }).catch(() => {}); // an older service has no /watched: it came with the ratings
  });
}

// No service: the old way, for admins only.
function adminFallback(item, header, isStale) {
  if (ctx.user?.Policy && !ctx.user.Policy.IsAdministrator) return;
  ctx.api.watchedBy(item.Id).then((users) => {
    if (users.length && !isStale()) header.querySelector('.actions')?.after(h('div', { class: 'friends' }, watchedLine(item, users)));
  }).catch(() => {});
}

function paint(item, box, state, full) {
  const { info, watched } = state;
  let status = null;
  if (state.error) status = h('div', { class: 'friends-status' }, state.error);
  else if (!info && state.waiting) status = h('div', { class: 'friends-status' }, h('span', { class: 'mini-spinner' }), 'Arrancando el servicio de amigos…');
  // replaceChildren would print a null as the text "null".
  box.replaceChildren(...[
    ...(info?.recommendedToMe || []).map((r) => recommendedNote(r, box)),
    full ? (info ? ratingLine(item, box, state) : pendingStars()) : null,
    status,
    watched?.length ? watchedLine(item, watched) : null,
  ].filter(Boolean));
}

function pendingStars() {
  return h('div', { class: 'friends-rating pending', 'aria-busy': 'true' },
    h('span', { class: 'friends-label' }, 'Puntúala'),
    h('span', { class: 'stars' }, [1, 2, 3, 4, 5].map(() => h('span', { class: 'star' }, h('span', { class: 'star-shape' })))));
}

// "Tengo que verla" and "Recomendar", next to the other round buttons.
function addButtons(item, header, info) {
  const actions = header.querySelector('.actions');
  if (!actions) return;
  let on = info.onWatchlist;
  const listBtn = h('button', { class: `round-btn ${on ? 'on' : ''}`, title: 'Tengo que verla', html: on ? icons.bookmarkFill : icons.bookmark });
  const paintList = () => {
    listBtn.classList.toggle('on', on);
    listBtn.innerHTML = on ? icons.bookmarkFill : icons.bookmark;
    listBtn.title = on ? 'En tu lista «Tengo que verla» (pulsa para quitarla)' : 'Tengo que verla';
  };
  paintList();
  listBtn.onclick = async () => {
    on = !on;
    paintList();
    try {
      await social.watchlist(item.Id, on);
      toast(on ? 'Añadida a «Tengo que verla»' : 'Quitada de «Tengo que verla»');
    } catch (e) {
      on = !on;
      paintList();
      toast(e.message, 'error');
    }
  };
  const recBtn = h('button', { class: 'round-btn', title: 'Recomendar a un amigo', html: icons.send, onclick: () => openRecommend(item) });
  // Right after the played/favourite hearts, before the editing tools.
  const fav = actions.querySelector('.round-btn[title="Favorito"]');
  if (fav) fav.after(listBtn, recBtn);
  else actions.append(listBtn, recBtn);
}

function recommendedNote(rec, box) {
  const note = h('div', { class: 'friends-rec' },
    h('span', { class: 'friends-rec-icon', html: icons.send }),
    h('span', null, h('strong', null, rec.from.name), ' te la recomienda', rec.note ? h('span', { class: 'friends-quote' }, `«${rec.note}»`) : null),
    h('button', {
      class: 'icon-btn small', title: 'Quitar el aviso', html: icons.close,
      onclick: async () => {
        note.remove();
        social.dismiss(rec.id).catch((e) => toast(e.message, 'error'));
      },
    }));
  return note;
}

function ratingLine(item, box, state) {
  const info = state.info;
  const others = info.ratings.filter((r) => !r.me);
  const stars = h('span', { class: 'stars', role: 'radiogroup', 'aria-label': 'Tu puntuación' });
  let mine = info.mine;
  // While the pointer is over them, the stars up to it turn to polished metal.
  const paintStars = (n, hot = false) => [...stars.children].forEach((s, i) => {
    s.classList.toggle('on', i < n);
    s.classList.toggle('hot', hot && i < n);
  });
  for (let n = 1; n <= 5; n++) {
    stars.append(h('button', {
      class: 'star', title: `${n} estrella${n > 1 ? 's' : ''}${n === mine ? ' (pulsa otra vez para quitarla)' : ''}`,
      style: `--i:${n - 1}`,
      onmouseenter: () => paintStars(n, true),
      onfocus: () => paintStars(n, true),
      onblur: () => paintStars(mine || 0),
      onmouseleave: () => paintStars(mine || 0),
      onclick: async () => {
        const next = n === mine ? null : n;
        try {
          const fresh = await social.rate(item.Id, next);
          toast(next ? `Le has puesto ${next} estrella${next > 1 ? 's' : ''}` : 'Puntuación quitada');
          state.info = fresh;
          if (Array.isArray(fresh.watched)) state.watched = fresh.watched;
          paint(item, box, state, true);
        } catch (e) {
          toast(e.message, 'error');
        }
      },
    }, h('span', { class: 'star-shape' })));
  }
  paintStars(mine || 0);

  const avg = info.average != null
    ? h('span', { class: 'friends-avg', title: 'Media de todos' },
      h('span', { html: icons.star }), info.average.toLocaleString('es-ES'), h('span', { class: 'muted' }, ` · ${info.ratings.length} nota${info.ratings.length > 1 ? 's' : ''}`))
    : null;
  return h('div', { class: 'friends-rating' },
    h('span', { class: 'friends-label' }, mine ? 'Tu nota' : 'Puntúala'),
    stars,
    avg,
    others.length ? h('span', { class: 'friends-scores' }, others.slice(0, 8).map((r) => h('span', { class: 'friends-score', title: `${r.name}: ${r.score} de 5` }, r.name, h('b', null, ` ${r.score}`), h('span', { html: icons.star })))) : null);
}

export function watchedLine(item, users) {
  const api = ctx.api;
  const series = item.Type === 'Series';
  const label = (u) => (u.played ? u.name : `${u.name} (${series ? 'a medias' : `${u.pct}%`})`);
  const seen = users.filter((u) => u.played).map(label);
  const watching = users.filter((u) => !u.played).map(label);
  const list = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} y ${names.at(-1)}` : names[0]);
  const verb = (one, many, n) => (n > 1 ? many : one);
  const parts = [];
  if (seen.length) parts.push(`${series ? verb('La ha terminado', 'La han terminado', seen.length) : verb('La ha visto', 'La han visto', seen.length)}: ${list(seen)}`);
  if (watching.length) parts.push(`${verb('La está viendo', 'La están viendo', watching.length)}: ${list(watching)}`);
  return h('div', { class: 'watched-note' },
    h('span', { class: 'watched-avatars' }, users.slice(0, 5).map((u) => avatar(api, u))),
    h('span', null, parts.join('  ·  ')));
}

function avatar(api, u) {
  return u.imageTag
    ? h('img', { class: 'watched-avatar', src: api.buildUrl(`/Users/${u.id}/Images/Primary`, { fillWidth: 48, quality: 90, tag: u.imageTag }), alt: '', title: u.name })
    : h('span', { class: 'watched-avatar letter', title: u.name }, u.name[0]?.toUpperCase() || '?');
}

// Sheet: pick friends (and an optional note) and send.
export async function openRecommend(item) {
  const chosen = new Set();
  const list = h('div', { class: 'friend-list' }, spinner());
  const note = h('textarea', { class: 'field friend-note', rows: 2, maxlength: 280, placeholder: 'Un mensaje (opcional): «Te va a encantar, la del final…»' });
  const send = button('Enviar recomendación', { kind: 'primary', icon: 'send' });
  send.disabled = true;

  const sheet = h('div', { class: 'sheet-backdrop', onclick: (e) => { if (e.target === sheet) close(); } },
    h('div', { class: 'sheet glass sheet-narrow' },
      h('div', { class: 'sheet-head' },
        h('div', null, h('h2', null, 'Recomendar'), h('p', { class: 'muted' }, `¿A quién le dices que vea ${item.Name}?`)),
        h('div', { class: 'sheet-tools' }, h('button', { class: 'round-btn', title: 'Cerrar', html: icons.close, onclick: () => close() }))),
      h('div', { class: 'sheet-body' }, list, note, h('div', { class: 'actions' }, send))));
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  document.body.append(sheet);

  function close() {
    document.removeEventListener('keydown', onKey, true);
    sheet.remove();
  }

  send.onclick = async () => {
    send.disabled = true;
    try {
      const r = await social.recommend(item.Id, [...chosen], note.value);
      toast(r.sent > 1 ? `Recomendada a ${r.sent} amigos` : 'Recomendación enviada');
      close();
    } catch (e) {
      toast(e.message, 'error');
      send.disabled = false;
    }
  };

  try {
    const users = (await social.users()).filter((u) => !u.me);
    if (!users.length) {
      list.replaceChildren(h('p', { class: 'muted' }, 'No hay más usuarios en este servidor.'));
      return;
    }
    list.replaceChildren(...users.map((u) => {
      const b = h('button', { class: 'friend', onclick: () => {
        if (chosen.has(u.id)) chosen.delete(u.id); else chosen.add(u.id);
        b.classList.toggle('on', chosen.has(u.id));
        send.disabled = !chosen.size;
      } }, avatar(ctx.api, u), h('span', null, u.name), h('span', { class: 'friend-check', html: icons.check }));
      return b;
    }));
    list.querySelector('.friend')?.focus();
  } catch (e) {
    list.replaceChildren(h('p', { class: 'muted' }, e.message));
  }
}

// Inicio: "Te recomiendan tus amigos" and "Tengo que verla". Titles you've already watched drop off
// both lists by themselves (and are cleared on the service).
export async function friendsRows(row) {
  const inbox = await social.inbox();
  const ids = [...new Set([...inbox.recommendations.map((r) => r.itemId), ...inbox.watchlist.map((w) => w.itemId)])];
  if (!ids.length) return [];
  const r = await ctx.api.items({ Ids: ids.join(','), Recursive: true });
  const byId = new Map((r.Items || []).map((i) => [i.Id.replace(/-/g, '').toLowerCase(), i]));
  const played = (id) => byId.get(id)?.UserData?.Played;

  const recs = [];
  const fromOf = new Map();
  for (const rec of inbox.recommendations) {
    if (played(rec.itemId)) { social.dismiss(rec.id).catch(() => {}); continue; }
    const it = byId.get(rec.itemId);
    if (!it) continue;
    if (!fromOf.has(it.Id)) { fromOf.set(it.Id, []); recs.push(it); }
    fromOf.get(it.Id).push(rec.from.name);
  }
  const list = [];
  for (const w of inbox.watchlist) {
    if (played(w.itemId)) { social.watchlist(w.itemId, false).catch(() => {}); continue; }
    const it = byId.get(w.itemId);
    if (it) list.push(it);
  }

  const recRow = row('Te recomiendan tus amigos', recs);
  // Under each poster, who recommended it instead of the year.
  recRow?.querySelectorAll('.row-track > .card').forEach((card, i) => {
    const names = fromOf.get(recs[i].Id);
    const sub = card.querySelector('.card-sub') || card.appendChild(h('div', { class: 'card-sub' }));
    sub.textContent = `De ${names.length > 2 ? `${names[0]} y ${names.length - 1} más` : names.join(' y ')}`;
  });
  return [recRow, row('Tengo que verla', list)].filter(Boolean);
}

// On opening the app: one notice for recommendations that arrived since last time.
export async function notifyRecommendations() {
  const key = `recsSeen:${ctx.server?.id}`;
  const { store } = await import('./store.js');
  const seenAt = store.get(key, '');
  const inbox = await social.inbox();
  const fresh = inbox.recommendations.filter((r) => r.at > seenAt);
  if (inbox.recommendations[0]) store.set(key, inbox.recommendations[0].at);
  if (!fresh.length || !seenAt && fresh.length > 3) return;
  const r = await ctx.api.items({ Ids: fresh.map((x) => x.itemId).join(','), Recursive: true }).catch(() => ({ Items: [] }));
  const nameOf = (id) => (r.Items || []).find((i) => i.Id.replace(/-/g, '').toLowerCase() === id)?.Name;
  const first = fresh.find((x) => nameOf(x.itemId));
  if (!first) return;
  toast(fresh.length === 1
    ? `${first.from.name} te recomienda ver ${nameOf(first.itemId)}`
    : `Tienes ${fresh.length} recomendaciones nuevas, como ${nameOf(first.itemId)} de ${first.from.name}. Están en Inicio.`);
}
