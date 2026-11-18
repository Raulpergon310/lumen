// Peticiones: ask for a film or series that isn't on the server. Search (TMDB, through the friends
// service and Jellyfin), pick it, add a note if you like, and the administrator sees it. When it
// arrives in the library the request is marked done by itself and whoever asked is told.
// Below the search, everyone's requests: waiting, already here, and turned down.
import { h, toast, button, image, spinner, debounce } from '../ui.js';
import { icons } from '../icons.js';
import { ctx } from '../context.js';
import { rowOf } from '../cards.js';
import { configured, waitForSocial, social } from '../social.js';

export async function requestsView({ query, isStale }) {
  let kind = query.kind === 'Series' ? 'Series' : 'Movie';
  const input = h('input', { class: 'search-input', placeholder: 'Busca la película o serie que quieres…', value: query.q || '', spellcheck: 'false' });
  const segs = h('div', { class: 'wv-segs' });
  const results = h('div', { class: 'req-results' });
  const lists = h('div', { class: 'req-lists' }, waiting('Conectando con el servicio de amigos…'));
  const head = h('div', { class: 'req-head' },
    h('a', { class: 'eyebrow-link', href: '#/pending' }, '‹ Pendientes'),
    h('h1', null, 'Pedir películas y series'),
    h('p', { class: 'muted' }, ctx.user?.Policy?.IsAdministrator
      ? 'Lo que tus amigos echan en falta en el servidor. Cuando lo añadas a la biblioteca, la petición se marca sola y se les avisa.'
      : 'Busca lo que falta en el servidor y pídelo. Cuando esté, te avisamos.'),
    h('div', { class: 'req-search' }, h('div', { class: 'search-box' }, h('span', { html: icons.search }), input), segs));

  const paintSegs = () => segs.replaceChildren(
    ...[['Movie', 'Películas'], ['Series', 'Series']].map(([k, label]) => h('button', {
      class: `wv-seg ${kind === k ? 'on' : ''}`,
      onclick: () => { kind = k; paintSegs(); run(); },
    }, label)));
  paintSegs();

  let seq = 0;
  const run = debounce(async () => {
    const q = input.value.trim();
    const my = ++seq;
    if (q.length < 2) { results.replaceChildren(); return; }
    results.replaceChildren(spinner());
    try {
      const found = await social.catalog(q, kind);
      if (my !== seq || isStale()) return;
      results.replaceChildren(found.length
        ? h('div', { class: 'grid req-grid' }, found.map((r) => resultCard(r, refreshLists)))
        : h('p', { class: 'muted center' }, `No se encuentra «${q}». Prueba con el título original o añade el año («Dune 2021»).`));
    } catch (e) {
      if (my === seq) results.replaceChildren(h('p', { class: 'muted center' }, e.offline ? 'El servicio de amigos no contesta.' : e.message));
    }
  }, 450);
  input.addEventListener('input', run);

  async function refreshLists() {
    try {
      const all = await social.requests();
      if (!isStale()) paintLists(lists, all, refreshLists);
    } catch (e) {
      if (!isStale()) lists.replaceChildren(h('p', { class: 'muted' }, e.message));
    }
  }

  waitForSocial({ isStale }).then((url) => {
    if (isStale()) return;
    if (!url) {
      lists.replaceChildren(h('p', { class: 'muted' }, configured()
        ? 'El servicio de amigos no contesta. Comprueba que está encendido en el servidor.'
        : 'Para pedir películas hace falta el servicio de amigos junto a Jellyfin (Ajustes → Amigos).'));
      return;
    }
    refreshLists();
    if (input.value.trim()) run();
  });
  requestAnimationFrame(() => { if (!window.LumenTV) input.focus(); });

  return h('div', { class: 'page requests' }, head, results, lists);
}

// A search result: its poster and what can be done with it (already here, already asked, ask).
function resultCard(r, onChange) {
  const action = h('div', { class: 'req-action' });
  const paint = () => {
    if (r.itemId) {
      action.replaceChildren(h('a', { class: 'btn btn-glass small', href: `#/item/${r.itemId}` }, h('span', { class: 'btn-icon', html: icons.check }), h('span', null, 'Ya está')));
    } else if (r.request?.status === 'pending') {
      action.replaceChildren(r.request.mine
        ? h('span', { class: 'req-state' }, h('span', { html: icons.check }), 'Ya la pediste')
        : button('Yo también', { cls: 'small', onclick: () => ask(r, { onDone: (req) => { r.request = req; paint(); onChange(); } }) }));
    } else {
      action.replaceChildren(button('Pedir', { kind: 'primary', cls: 'small', icon: 'send', onclick: () => ask(r, { onDone: (req) => { r.request = req; paint(); onChange(); } }) }));
    }
  };
  paint();
  const who = r.request?.status === 'pending' ? `Pedida por ${names(r.request)}` : r.year || '';
  return h('div', { class: 'card card-poster req-card' },
    h('div', { class: 'card-art' }, image(r.poster, { placeholder: r.name })),
    h('div', { class: 'card-title', title: r.name }, r.name),
    who ? h('div', { class: 'card-sub' }, who) : null,
    action);
}

// Sheet: the title, its synopsis, an optional note, and "Pedir".
function ask(r, { onDone }) {
  const note = h('textarea', { class: 'field friend-note', rows: 2, maxlength: 280, placeholder: 'Un mensaje (opcional): «En versión original, porfa»' });
  const send = button(r.request ? 'Yo también la quiero' : 'Pedir', { kind: 'primary', icon: 'send' });
  const sheet = h('div', { class: 'sheet-backdrop', onclick: (e) => { if (e.target === sheet) close(); } },
    h('div', { class: 'sheet glass sheet-narrow' },
      h('div', { class: 'sheet-head' },
        h('div', null, h('h2', null, r.name), h('p', { class: 'muted' }, [r.year, r.kind === 'Series' ? 'Serie' : 'Película'].filter(Boolean).join(' · '))),
        h('div', { class: 'sheet-tools' }, h('button', { class: 'round-btn', title: 'Cerrar', html: icons.close, onclick: () => close() }))),
      h('div', { class: 'sheet-body' },
        h('div', { class: 'req-sheet-info' },
          r.poster ? image(r.poster, { cls: 'req-sheet-poster', placeholder: r.name }) : null,
          r.overview ? h('p', { class: 'muted req-sheet-overview' }, r.overview) : null),
        r.request ? h('p', { class: 'muted small' }, `Ya la ha pedido ${names(r.request)}. Si la pides tú también, el administrador sabrá que sois más.`) : null,
        note,
        h('div', { class: 'actions' }, send))));
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  document.body.append(sheet);
  send.focus();

  function close() {
    document.removeEventListener('keydown', onKey, true);
    sheet.remove();
  }
  send.onclick = async () => {
    send.disabled = true;
    try {
      const req = await social.request({ kind: r.kind, name: r.name, year: r.year, providerIds: r.providerIds, poster: r.poster, overview: r.overview, note: note.value });
      toast(`Pedida: ${r.name}. Te avisaremos cuando esté.`);
      close();
      onDone(req);
    } catch (e) {
      toast(e.message, 'error');
      send.disabled = false;
    }
  };
}

const names = (req) => {
  const all = [req.by.name, ...req.also.map((a) => a.name)];
  return all.length > 2 ? `${all[0]} y ${all.length - 1} más` : all.join(' y ');
};

// Everyone's requests in rows, like the rest of the app.
function paintLists(box, all, refresh) {
  const pending = all.filter((r) => r.status === 'pending');
  const done = all.filter((r) => r.status === 'done').slice(0, 30);
  const declined = all.filter((r) => r.status === 'declined').slice(0, 20);
  if (!all.length) {
    box.replaceChildren(h('div', { class: 'pending-empty glass req-empty' },
      h('span', { class: 'pending-empty-icon', html: icons.send }),
      h('div', null, h('strong', null, 'Nadie ha pedido nada todavía'), h('p', { class: 'muted' }, 'Busca arriba lo que te falte y pídelo.'))));
    return;
  }
  box.replaceChildren(...[
    pending.length ? rowOf(['Pedidas', h('span', { class: 'pending-count' }, String(pending.length))], pending.map((r) => requestCard(r, refresh)), { cls: 'req-row' }) : null,
    done.length ? rowOf('Ya en el servidor', done.map((r) => requestCard(r, refresh)), { cls: 'req-row' }) : null,
    declined.length ? rowOf('No se van a añadir', declined.map((r) => requestCard(r, refresh)), { cls: 'req-row req-row-declined' }) : null,
  ].filter(Boolean));
}

function requestCard(r, refresh) {
  const done = r.status === 'done' && r.itemId;
  const art = h('div', { class: 'card-art' }, image(r.poster, { placeholder: r.name }),
    r.status === 'done' ? h('span', { class: 'badge-played', html: icons.check }) : null);
  const sub = r.status === 'declined'
    ? (r.reply ? `«${r.reply}»` : 'Rechazada')
    : r.status === 'done' ? `La pidió ${names(r)}` : `Pide ${names(r)}`;
  const tools = [];
  const act = (label, fn, cls = '') => h('button', { class: `req-tool ${cls}`, onclick: async (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.disabled = true;
    try { await fn(); refresh(); } catch (err) { toast(err.message, 'error'); e.currentTarget.disabled = false; }
  } }, label);
  if (r.status === 'pending' && r.canManage) {
    tools.push(act('Rechazar', async () => {
      const reply = await askReason(r);
      if (reply === null) return;
      await social.answerRequest(r.id, { status: 'declined', reply });
      toast('Petición rechazada');
    }));
  }
  if (r.canCancel) tools.push(act(r.mine && !r.canManage ? 'Ya no la quiero' : 'Quitar', async () => { await social.cancelRequest(r.id); toast('Petición quitada'); }, 'danger'));
  if (r.status === 'declined' && r.canManage) tools.push(act('Volver a pendiente', async () => { await social.answerRequest(r.id, { status: 'pending' }); }));
  if (r.status !== 'pending' && r.canManage) tools.push(act('Borrar', async () => { await social.cancelRequest(r.id); }, 'danger'));
  const notes = r.notes.length ? h('div', { class: 'pending-note', title: r.notes.map((n) => `${n.from}: «${n.note}»`).join('\n') }, `«${r.notes[0].note}»`) : null;
  const body = [art, h('div', { class: 'card-title' }, r.name), h('div', { class: 'card-sub' }, sub), notes, tools.length ? h('div', { class: 'req-tools' }, tools) : null];
  return done
    ? h('a', { class: 'card card-poster req-card', href: `#/item/${r.itemId}`, title: r.name }, body)
    : h('div', { class: 'card card-poster req-card', title: r.name, tabindex: '0' }, body);
}

// Sheet for the administrator: why it won't be added (optional). Resolves with the text, or null.
function askReason(r) {
  return new Promise((resolve) => {
    const reason = h('textarea', { class: 'field friend-note', rows: 2, maxlength: 280, placeholder: 'El motivo (opcional, lo verá quien la pidió): «No la encuentro en buena calidad»' });
    const ok = button('Rechazar la petición', { kind: 'primary' });
    const sheet = h('div', { class: 'sheet-backdrop', onclick: (e) => { if (e.target === sheet) close(null); } },
      h('div', { class: 'sheet glass sheet-narrow' },
        h('div', { class: 'sheet-head' },
          h('div', null, h('h2', null, 'Rechazar'), h('p', { class: 'muted' }, `${r.name} no se va a añadir.`)),
          h('div', { class: 'sheet-tools' }, h('button', { class: 'round-btn', title: 'Cerrar', html: icons.close, onclick: () => close(null) }))),
        h('div', { class: 'sheet-body' }, reason, h('div', { class: 'actions' }, ok))));
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
    function close(value) {
      document.removeEventListener('keydown', onKey, true);
      sheet.remove();
      resolve(value);
    }
    ok.onclick = () => close(reason.value.trim());
    document.addEventListener('keydown', onKey, true);
    document.body.append(sheet);
    reason.focus();
  });
}

function waiting(text) {
  return h('p', { class: 'friends-status' }, h('span', { class: 'mini-spinner' }), text);
}
