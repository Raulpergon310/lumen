// Panel, "Lo que se ha visto": what every user has watched, read straight from Jellyfin (an admin can
// ask about anyone). Films or series, how many each user has seen, month by month, and the titles
// with who has seen each one. Clicking a user (or their bar) narrows everything to them.
import { h, image } from '../ui.js';
import { ctx } from '../context.js';
import { posterSrc } from '../media.js';

// One colour per user, in a fixed order (by name), the same in every chart. Past eight, "Otros".
const COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c', '#9085e9', '#e66767'];
const OTHER = '#8e8e93';
const MONTHS = 12;
const PAGE = 36;

export function watchedSection(users) {
  const box = h('div', { class: 'wv' }, h('p', { class: 'friends-status' }, h('span', { class: 'mini-spinner' }), 'Leyendo lo que ha visto cada uno…'));
  load(users).then((data) => mount(box, data)).catch((e) => {
    box.replaceChildren(h('p', { class: 'muted' }, `No se pudo leer: ${e.message}`));
  });
  return box;
}

async function load(users) {
  const api = ctx.api;
  const people = users.filter((u) => !u.Policy?.IsDisabled).sort((a, b) => a.Name.localeCompare(b.Name, 'es'));
  const ask = (u, type) => api.reqAlt(['/Items', `/Users/${u.Id}/Items`], {
    background: true, timeout: 30000,
    query: {
      userId: u.Id, Recursive: true, IncludeItemTypes: type, Filters: 'IsPlayed', Fields: 'UserData',
      SortBy: 'DatePlayed', SortOrder: 'Descending', EnableImageTypes: 'Primary', ImageTypeLimit: 1, EnableTotalRecordCount: false,
    },
  }).then((r) => r.Items || []).catch(() => []);
  const per = await Promise.all(people.map(async (u, i) => {
    const [movies, episodes] = await Promise.all([ask(u, 'Movie'), ask(u, 'Episode')]);
    return { id: u.Id, name: u.Name, imageTag: u.PrimaryImageTag, color: COLORS[i] || OTHER, movies, episodes };
  }));
  return per;
}

function mount(box, people) {
  const state = { kind: 'movies', user: null, shown: PAGE };
  const tip = tooltip();

  const render = () => {
    const data = shape(people, state.kind);
    const active = data.people.filter((p) => p.count);
    if (!active.length) {
      box.replaceChildren(toolbar(), h('p', { class: 'muted' }, state.kind === 'movies' ? 'Nadie ha terminado ninguna película todavía.' : 'Nadie ha visto ningún episodio todavía.'));
      return;
    }
    box.replaceChildren(
      toolbar(active),
      h('div', { class: 'wv-charts' },
        h('div', { class: 'panel-card' }, h('h3', null, state.kind === 'movies' ? 'Películas vistas por usuario' : 'Series por usuario'), byUser(active)),
        h('div', { class: 'panel-card' }, h('h3', null, state.kind === 'movies' ? 'Películas vistas, mes a mes' : 'Episodios vistos, mes a mes'), byMonth(data, active))),
      titles(data));
  };

  function toolbar(active = []) {
    const seg = (kind, label) => h('button', { class: `wv-seg ${state.kind === kind ? 'on' : ''}`, onclick: () => { state.kind = kind; state.shown = PAGE; render(); } }, label);
    const chip = (p) => h('button', {
      class: `wv-chip ${state.user === p?.id ? 'on' : ''}`,
      onclick: () => { state.user = p?.id || null; state.shown = PAGE; render(); },
    }, p ? h('span', { class: 'wv-dot', style: { background: p.color } }) : null, p ? p.name : 'Todos');
    return h('div', { class: 'wv-toolbar' },
      h('div', { class: 'wv-segs' }, seg('movies', 'Películas'), seg('series', 'Series')),
      active.length > 1 ? h('div', { class: 'wv-chips' }, chip(null), active.map(chip)) : null);
  }

  // Horizontal bars: one per user, longest first.
  function byUser(active) {
    const max = Math.max(...active.map((p) => p.count));
    const unit = state.kind === 'movies' ? ['película', 'películas'] : ['serie', 'series'];
    return h('div', { class: 'wv-bars' }, [...active].sort((a, b) => b.count - a.count).map((p) => {
      const row = h('button', {
        class: `wv-bar-row ${state.user && state.user !== p.id ? 'dim' : ''}`,
        onclick: () => { state.user = state.user === p.id ? null : p.id; state.shown = PAGE; render(); },
      },
      h('span', { class: 'wv-bar-name' }, p.name),
      h('span', { class: 'wv-bar-track' }, h('span', { class: 'wv-bar', style: { width: `${(p.count / max) * 100}%`, background: p.color } })),
      h('span', { class: 'wv-bar-value' }, p.count.toLocaleString('es-ES')));
      tip.on(row, () => [h('b', null, p.name), h('div', null, `${p.count.toLocaleString('es-ES')} ${p.count === 1 ? unit[0] : unit[1]}`),
        state.kind === 'series' ? h('div', { class: 'muted' }, `${p.episodes.toLocaleString('es-ES')} episodios`) : null,
        p.last ? h('div', { class: 'muted' }, `Lo último: ${p.last}`) : null]);
      return row;
    }));
  }

  // Stacked columns, the last twelve months, one colour per user.
  function byMonth(data, active) {
    const shownPeople = active.filter((p) => !state.user || p.id === state.user);
    const months = data.months;
    const totals = months.map((m) => shownPeople.reduce((a, p) => a + (m.by.get(p.id) || 0), 0));
    const max = Math.max(1, ...totals);
    const cols = months.map((m, i) => {
      const col = h('div', { class: 'wv-col' },
        h('div', { class: 'wv-plot' }, h('div', { class: 'wv-stack', style: { height: `${(totals[i] / max) * 100}%` } },
          shownPeople.filter((p) => m.by.get(p.id)).map((p) => h('span', { class: 'wv-seg-fill', style: { flexGrow: m.by.get(p.id), background: p.color } })))),
        h('div', { class: 'wv-col-label' }, m.short));
      tip.on(col, () => [h('b', null, m.long),
        totals[i] ? shownPeople.filter((p) => m.by.get(p.id)).map((p) => h('div', { class: 'wv-tip-row' }, h('span', { class: 'wv-dot', style: { background: p.color } }), p.name, h('span', { class: 'wv-tip-n' }, m.by.get(p.id)))) : h('div', { class: 'muted' }, 'Nada')]);
      return col;
    });
    return h('div', null,
      shownPeople.length > 1 ? h('div', { class: 'wv-legend' }, shownPeople.map((p) => h('span', null, h('span', { class: 'wv-dot', style: { background: p.color } }), p.name))) : null,
      h('div', { class: 'wv-cols-wrap' },
        h('div', { class: 'wv-max muted small' }, max.toLocaleString('es-ES')),
        h('div', { class: 'wv-cols' }, cols)),
      h('p', { class: 'muted small wv-note' }, 'Cuenta el mes en que se vio por última vez.'));
  }

  // Posters with who has seen each one.
  function titles(data) {
    const list = data.titles.filter((t) => !state.user || t.viewers.some((v) => v.id === state.user));
    const who = state.user ? people.find((p) => p.id === state.user) : null;
    const grid = h('div', { class: 'wv-grid' }, list.slice(0, state.shown).map((t) => {
      const card = h('a', { class: 'wv-title', href: `#/item/${t.id}` },
        image(t.poster, { cls: 'wv-poster', placeholder: t.name }),
        h('div', { class: 'wv-avatars' }, t.viewers.slice(0, 6).map((v) => avatar(v)), t.viewers.length > 6 ? h('span', { class: 'wv-more' }, `+${t.viewers.length - 6}`) : null),
        h('div', { class: 'wv-title-name' }, t.name));
      tip.on(card, () => [h('b', null, t.name), ...t.viewers.map((v) => h('div', { class: 'wv-tip-row' }, h('span', { class: 'wv-dot', style: { background: v.color } }), v.name,
        h('span', { class: 'wv-tip-n muted' }, [v.episodes ? `${v.episodes} ep. · ` : '', v.when].join(''))))]);
      return card;
    }));
    const more = list.length > state.shown
      ? h('button', { class: 'wv-chip wv-more-btn', onclick: () => { state.shown += PAGE * 2; render(); } }, `Ver más (${list.length - state.shown})`)
      : null;
    const heading = who
      ? `Lo que ha visto ${who.name} (${list.length})`
      : `Quién ha visto qué · ${data.kind === 'movies' ? 'las más vistas primero' : 'las más seguidas primero'}`;
    return h('div', { class: 'panel-card wv-titles' }, h('h3', null, heading), grid, more);
  }

  render();
}

// From each user's played items to what the charts need.
function shape(people, kind) {
  const now = new Date();
  const months = [];
  for (let i = MONTHS - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      key: `${d.getFullYear()}-${d.getMonth()}`, by: new Map(),
      short: d.toLocaleDateString('es-ES', { month: 'short' }).replace('.', ''),
      long: d.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' }),
    });
  }
  const monthOf = new Map(months.map((m) => [m.key, m]));
  const titles = new Map();
  const out = people.map((p) => {
    const items = kind === 'movies' ? p.movies : p.episodes;
    const seen = new Map(); // title id → { episodes, last }
    for (const it of items) {
      const when = it.UserData?.LastPlayedDate;
      if (when) {
        const d = new Date(when);
        const m = monthOf.get(`${d.getFullYear()}-${d.getMonth()}`);
        if (m) m.by.set(p.id, (m.by.get(p.id) || 0) + 1);
      }
      const id = kind === 'movies' ? it.Id : it.SeriesId;
      if (!id) continue;
      const s = seen.get(id) || { episodes: 0, last: '' };
      s.episodes++;
      if (when && when > s.last) s.last = when;
      seen.set(id, s);
      if (!titles.has(id)) {
        titles.set(id, {
          id, name: kind === 'movies' ? it.Name : it.SeriesName || it.Name, viewers: [], last: '',
          poster: kind === 'movies' ? posterSrc(ctx.api, it, 240) : it.SeriesPrimaryImageTag ? ctx.api.image(it.SeriesId, 'Primary', { width: 240, tag: it.SeriesPrimaryImageTag }) : null,
        });
      }
    }
    for (const [id, s] of seen) {
      const t = titles.get(id);
      t.viewers.push({ id: p.id, name: p.name, imageTag: p.imageTag, color: p.color, episodes: kind === 'series' ? s.episodes : 0, when: s.last ? ago(s.last) : '' });
      if (s.last > t.last) t.last = s.last;
    }
    const lastItem = items[0];
    return {
      ...p, count: seen.size, episodes: items.length,
      last: lastItem ? (kind === 'movies' ? lastItem.Name : `${lastItem.SeriesName || ''}`) : '',
    };
  });
  const list = [...titles.values()].sort((a, b) => (b.viewers.length - a.viewers.length) || b.last.localeCompare(a.last));
  return { kind, people: out, months, titles: list };
}

function avatar(v) {
  const style = { boxShadow: `0 0 0 2px ${v.color}` };
  return v.imageTag
    ? h('img', { class: 'wv-avatar', style, src: ctx.api.buildUrl(`/Users/${v.id}/Images/Primary`, { fillWidth: 48, quality: 90, tag: v.imageTag }), alt: v.name })
    : h('span', { class: 'wv-avatar letter', style }, v.name[0]?.toUpperCase() || '?');
}

// One floating box for every chart: follows the pointer over whatever has something to say.
function tooltip() {
  document.querySelector('.wv-tip')?.remove();
  const el = h('div', { class: 'wv-tip', role: 'tooltip' });
  document.body.append(el);
  const hide = () => { el.classList.remove('show'); };
  return {
    on(target, content) {
      target.addEventListener('pointerenter', () => {
        if (!el.isConnected) document.body.append(el);
        el.replaceChildren(...[content()].flat(2).filter(Boolean));
        el.classList.add('show');
      });
      target.addEventListener('pointermove', (e) => {
        const r = el.getBoundingClientRect();
        const x = Math.min(window.innerWidth - r.width - 8, e.clientX + 14);
        const y = e.clientY + 18 + r.height > window.innerHeight ? e.clientY - r.height - 12 : e.clientY + 18;
        el.style.transform = `translate(${Math.max(8, x)}px, ${y}px)`;
      });
      target.addEventListener('pointerleave', hide);
      target.addEventListener('click', hide);
    },
  };
}

function ago(date) {
  const s = Math.max(0, (Date.now() - new Date(date).getTime()) / 1000);
  if (s < 3600) return 'hace un rato';
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  if (s < 86400 * 30) return `hace ${Math.floor(s / 86400)} d`;
  return new Date(date).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
}
