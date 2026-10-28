import { h, spinner, emptyState } from '../ui.js';
import { ctx } from '../context.js';
import { store } from '../store.js';
import { posterCard, row } from '../cards.js';

const PAGE = 60;
const SORTS = [
  ['SortName', 'Ascending', 'Título'],
  ['DateCreated', 'Descending', 'Añadido recientemente'],
  ['PremiereDate,ProductionYear', 'Descending', 'Año de estreno'],
  ['CommunityRating', 'Descending', 'Valoración'],
  ['Random', 'Ascending', 'Aleatorio'],
];
const FILTERS = [
  ['', 'Todo'],
  ['IsUnplayed', 'Sin ver'],
  ['IsResumable', 'A medias'],
  ['IsFavorite', 'Favoritos'],
];

// Genres people usually look for first; the rest follow alphabetically.
const GENRE_ORDER = ['Acción', 'Aventura', 'Comedia', 'Drama', 'Ciencia ficción', 'Suspense', 'Thriller', 'Terror', 'Animación', 'Crimen', 'Fantasía', 'Romance', 'Misterio', 'Familia', 'Documental', 'Bélica', 'Historia', 'Música', 'Western'];

export async function libraryView({ params: [id], query = {} }) {
  const view = ctx.views.find((v) => v.Id === id) || await ctx.api.item(id);
  const type = { movies: 'Movie', tvshows: 'Series', boxsets: 'BoxSet' }[view.CollectionType];
  if (query.view === 'categories' && type) return categoriesView(id, view, type);
  const genre = query.genre;
  const prefKey = genre ? `${id}:${genre}` : id;
  const prefs = store.get('libraryPrefs', {})[prefKey] || {};
  let sort = prefs.sort ?? 1;
  let filter = prefs.filter ?? '';

  const grid = h('div', { class: 'grid' });
  const holder = h('div', null, grid);
  const sentinel = h('div', { class: 'sentinel' });
  const count = h('span', { class: 'lib-count' });
  let start = 0;
  let total = Infinity;
  let loading = false;
  let generation = 0;

  const savePrefs = () => {
    const all = store.get('libraryPrefs', {});
    all[prefKey] = { sort, filter };
    store.set('libraryPrefs', all);
  };

  async function loadMore() {
    if (loading || start >= total) return;
    loading = true;
    const gen = generation;
    sentinel.replaceChildren(spinner());
    try {
      const [sortBy, order] = SORTS[sort];
      const r = await ctx.api.items({
        ParentId: id,
        IncludeItemTypes: type,
        Recursive: !!type,
        SortBy: sortBy,
        SortOrder: order,
        Filters: filter || undefined,
        StartIndex: start,
        Limit: PAGE,
        EnableTotalRecordCount: true,
        GenreIds: genre,
        Fields: 'PrimaryImageAspectRatio', // the grid only needs artwork, not overviews
      });
      if (gen !== generation) return;
      total = r.TotalRecordCount ?? (r.Items.length < PAGE ? start + r.Items.length : Infinity);
      start += r.Items.length;
      count.textContent = isFinite(total) ? `${total} ${total === 1 ? 'título' : 'títulos'}` : '';
      grid.append(...r.Items.map(posterCard));
      if (!grid.children.length) holder.replaceChildren(emptyState('Nada por aquí', 'Prueba con otro filtro.'));
    } catch (e) {
      sentinel.replaceChildren(h('p', { class: 'muted' }, e.message));
      loading = false;
      return;
    } finally {
      if (gen === generation) loading = false;
    }
    sentinel.replaceChildren();
    // Keep filling while the sentinel is still on screen.
    if (start < total && sentinel.getBoundingClientRect().top < window.innerHeight + 800) loadMore();
  }

  function reset() {
    generation++;
    loading = false;
    start = 0;
    total = Infinity;
    grid.replaceChildren();
    holder.replaceChildren(grid);
    savePrefs();
    loadMore();
  }

  const sortSelect = h('select', { class: 'select', onchange: (e) => { sort = Number(e.target.value); reset(); } },
    SORTS.map(([, , label], i) => h('option', { value: i, selected: i === sort }, label)));
  const filterPills = h('div', { class: 'pills small' }, FILTERS.map(([value, label]) =>
    h('button', {
      class: `pill ${value === filter ? 'active' : ''}`,
      onclick: (e) => {
        filter = value;
        for (const p of filterPills.children) p.classList.toggle('active', p === e.currentTarget);
        reset();
      },
    }, label)));

  const page = h('div', { class: 'page library' },
    type && !genre ? libTabs(id, 'all') : null,
    h('div', { class: 'lib-head' },
      h('div', null,
        genre ? h('a', { class: 'eyebrow-link', href: `#/library/${id}?view=categories` }, `‹ ${view.Name} · Categorías`) : null,
        h('h1', null, genre ? query.name || 'Categoría' : view.Name), count),
      h('div', { class: 'lib-tools' }, filterPills, sortSelect)),
    holder,
    sentinel);

  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) loadMore();
  }, { rootMargin: '800px' });
  io.observe(sentinel);
  loadMore();

  return { node: page, cleanup: () => io.disconnect() };
}

function libTabs(id, active) {
  return h('div', { class: 'lib-tabs pills' },
    h('a', { class: `pill ${active === 'all' ? 'active' : ''}`, href: `#/library/${id}` }, 'Todo'),
    h('a', { class: `pill ${active === 'categories' ? 'active' : ''}`, href: `#/library/${id}?view=categories` }, 'Categorías'));
}

// One row per genre; each row only asks the server for its titles when it scrolls into view.
async function categoriesView(id, view, type) {
  const api = ctx.api;
  const r = await api.req('/Genres', { query: { ParentId: id, IncludeItemTypes: type, Recursive: true, userId: api.userId, SortBy: 'SortName' } });
  const genres = (r?.Items || []).sort((a, b) => {
    const ia = GENRE_ORDER.indexOf(a.Name);
    const ib = GENRE_ORDER.indexOf(b.Name);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.Name.localeCompare(b.Name, 'es');
  });

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      e.target.__load();
    }
  }, { rootMargin: '600px' });

  const slots = genres.map((g) => {
    const slot = h('div', { class: 'genre-slot' }, h('div', { class: 'row-head' }, h('h2', null, g.Name)), h('div', { class: 'row-skeleton' }));
    slot.__load = async () => {
      try {
        const res = await api.items({
          ParentId: id, IncludeItemTypes: type, Recursive: true, GenreIds: g.Id,
          SortBy: 'CommunityRating,SortName', SortOrder: 'Descending', Limit: 24, Fields: 'PrimaryImageAspectRatio',
        });
        const href = `#/library/${id}?genre=${g.Id}&name=${encodeURIComponent(g.Name)}`;
        const rr = row(g.Name, res.Items, { href });
        if (rr) slot.replaceWith(rr);
        else slot.remove();
      } catch {
        slot.remove();
      }
    };
    io.observe(slot);
    return slot;
  });

  const node = h('div', { class: 'page library categories' },
    libTabs(id, 'categories'),
    h('div', { class: 'lib-head' }, h('div', null, h('h1', null, view.Name), h('span', { class: 'lib-count' }, `${genres.length} categorías`))),
    slots.length ? slots : h('p', { class: 'muted center' }, 'Esta biblioteca no tiene géneros.'));
  return { node, cleanup: () => io.disconnect() };
}