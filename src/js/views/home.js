import { h, button, emptyState, fmtRuntime } from '../ui.js';
import { ctx } from '../context.js';
import { row } from '../cards.js';
import { backdropSrc, logoSrc, progressOf } from '../media.js';

const SHOWN_LIBS = new Set(['movies', 'tvshows', 'homevideos', 'mixed', 'boxsets', undefined, null]);

export async function homeView({ isStale }) {
  const api = ctx.api;
  const libs = ctx.views.filter((v) => SHOWN_LIBS.has(v.CollectionType));

  const [resume, nextUp, ...latest] = await Promise.allSettled([
    api.resume(),
    api.nextUp(),
    ...libs.map((v) => api.latest(v.Id)),
  ]);
  if (isStale()) return null;

  const val = (r) => (r.status === 'fulfilled' ? r.value : []);
  const resumeItems = val(resume);
  const resumeIds = new Set(resumeItems.map((i) => i.Id));
  const nextUpItems = val(nextUp).filter((i) => !resumeIds.has(i.Id));

  // Recommendations load after the page is on screen, so they never slow down opening the app.
  const forYou = h('div', { class: 'rec-slot' });
  const discover = h('div', { class: 'rec-slot' });
  const rows = [
    row('Seguir viendo', resumeItems, { kind: 'thumb' }),
    row('A continuación', nextUpItems, { kind: 'thumb' }),
    forYou,
    ...libs.map((v, i) => row(`Novedades en ${v.Name}`, val(latest[i]), { href: `#/library/${v.Id}` })),
    discover,
  ].filter(Boolean);
  loadRecommendations(libs, forYou, discover);

  const heroPool = [...libs.flatMap((_, i) => val(latest[i]).slice(0, 4))]
    .filter((i) => i.BackdropImageTags?.length && i.Type !== 'Episode');
  const heroItems = interleave(heroPool).slice(0, 6);

  if (!rows.length && !heroItems.length) {
    return emptyState('Tu biblioteca está vacía', 'Cuando añadas películas o series en Jellyfin aparecerán aquí.');
  }

  const hero = heroItems.length ? heroCarousel(heroItems) : null;
  return {
    node: h('div', { class: 'page home' }, hero?.node, h('div', { class: hero ? 'rows overlap' : 'rows top-pad' }, rows)),
    cleanup: hero?.cleanup,
  };
}

async function loadRecommendations(libs, forYou, discover) {
  const api = ctx.api;
  const movieLib = libs.find((v) => v.CollectionType === 'movies');
  const seriesLib = libs.find((v) => v.CollectionType === 'tvshows');
  const common = { Recursive: true, Fields: 'PrimaryImageAspectRatio', Limit: 20 };

  // "Porque viste…": rows built here instead of /Movies/Recommendations, which always starts from the
  // same last-watched titles and so showed the same rows every day.
  becauseYouWatched(api)
    .then((made) => { if (made.length) forYou.replaceWith(...made); else forYou.remove(); })
    .catch(() => forYou.remove());

  const lists = await Promise.allSettled([
    movieLib && api.items({ ...common, ParentId: movieLib.Id, IncludeItemTypes: 'Movie', Filters: 'IsUnplayed', SortBy: 'CommunityRating', SortOrder: 'Descending', MinCommunityRating: 7 }),
    seriesLib && api.items({ ...common, ParentId: seriesLib.Id, IncludeItemTypes: 'Series', Filters: 'IsUnplayed', SortBy: 'CommunityRating', SortOrder: 'Descending', MinCommunityRating: 7 }),
    api.items({ ...common, IncludeItemTypes: 'Movie,Series', Filters: 'IsUnplayed', SortBy: 'Random' }),
    api.items({ ...common, IncludeItemTypes: 'Movie,Series', Filters: 'IsFavorite', SortBy: 'Random' }),
  ]);
  const items = (r) => (r.status === 'fulfilled' && r.value ? r.value.Items : []);
  const made = [
    row('Películas muy valoradas que no has visto', items(lists[0]), movieLib ? { href: `#/library/${movieLib.Id}` } : {}),
    row('Series muy valoradas para empezar', items(lists[1]), seriesLib ? { href: `#/library/${seriesLib.Id}` } : {}),
    row('Para descubrir hoy', items(lists[2])),
    row('Tus favoritos', items(lists[3])),
  ].filter(Boolean);
  if (made.length) discover.replaceWith(...made);
  else discover.remove();
}

// Three random seeds (five tried, some have too few unwatched matches) among the last ~20 movies/series watched (plus, sometimes, a favourite), each
// giving a row of similar titles not yet watched, with no title repeated across rows. The pick is kept
// for 20 minutes so going back to Inicio doesn't reshuffle what was just on screen.
const SEED_MS = 20 * 60 * 1000;
let seedCache = null;

async function becauseYouWatched(api) {
  if (!seedCache || seedCache.api !== api || Date.now() - seedCache.at > SEED_MS) {
    seedCache = { api, at: Date.now(), rows: buildBecauseRows(api) };
    seedCache.rows.catch(() => { seedCache = null; });
  }
  return (await seedCache.rows).map(({ title, items }) => row(title, items));
}

async function buildBecauseRows(api) {
  const common = { Recursive: true, Limit: 30, SortBy: 'DatePlayed', SortOrder: 'Descending', Filters: 'IsPlayed' };
  const [movies, episodes, favs] = await Promise.allSettled([
    api.items({ ...common, IncludeItemTypes: 'Movie' }),
    api.items({ ...common, IncludeItemTypes: 'Episode', Limit: 80 }),
    api.items({ Recursive: true, IncludeItemTypes: 'Movie,Series', Filters: 'IsFavorite', Limit: 40 }),
  ]);
  const list = (r) => (r.status === 'fulfilled' && r.value ? r.value.Items || [] : []);

  // Recently watched titles (series once, from their episodes), newest first.
  const seen = new Map();
  const recent = [];
  const add = (id, name, when) => { if (id && !seen.has(id)) { seen.set(id, true); recent.push({ id, name, when }); } };
  for (const m of list(movies)) add(m.Id, m.Name, m.UserData?.LastPlayedDate || '');
  for (const e of list(episodes)) add(e.SeriesId, e.SeriesName, e.UserData?.LastPlayedDate || '');
  recent.sort((a, b) => String(b.when).localeCompare(String(a.when)));

  const seeds = shuffle(recent.slice(0, 20)).slice(0, 5).map((x) => ({ ...x, title: `Porque viste ${x.name}` }));
  const fav = shuffle(list(favs)).find((f) => !seeds.some((x) => x.id === f.Id));
  if (fav && Math.random() < 0.6) seeds.push({ id: fav.Id, name: fav.Name, title: `Porque te gustó ${fav.Name}` });

  const used = new Set(seeds.map((x) => x.id));
  const similar = await Promise.allSettled(seeds.map((x) => api.req(`/Items/${x.id}/Similar`, {
    query: { userId: api.userId, Limit: 30, Fields: 'PrimaryImageAspectRatio' },
  })));
  const rows = [];
  seeds.forEach((x, i) => {
    if (rows.length >= (fav ? 4 : 3)) return;
    const items = shuffle(list(similar[i]).filter((it) => !it.UserData?.Played && !used.has(it.Id))).slice(0, 16);
    if (items.length < 4) return;
    items.forEach((it) => used.add(it.Id));
    rows.push({ title: x.title, items });
  });
  return rows;
}

function shuffle(a) {
  const out = [...a];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function interleave(items) {
  const movies = items.filter((i) => i.Type === 'Movie');
  const other = items.filter((i) => i.Type !== 'Movie');
  const out = [];
  while (movies.length || other.length) {
    if (movies.length) out.push(movies.shift());
    if (other.length) out.push(other.shift());
  }
  return out;
}

function metaLine(item) {
  const parts = [];
  if (item.ProductionYear) parts.push(item.ProductionYear);
  if (item.Type === 'Series') parts.push('Serie');
  if (item.Genres?.length) parts.push(item.Genres.slice(0, 2).join(', '));
  if (item.RunTimeTicks && item.Type === 'Movie') parts.push(fmtRuntime(item.RunTimeTicks));
  if (item.OfficialRating) parts.push(item.OfficialRating);
  return parts.join('  ·  ');
}

function heroCarousel(items) {
  const api = ctx.api;
  let index = 0;
  let timer = null;

  // Backdrops load one at a time (current + next) at the size the window needs, so the server
  // isn't asked to resize six full-size images every time the home screen opens.
  const width = Math.min(1920, Math.ceil((window.innerWidth * (window.devicePixelRatio || 1)) / 320) * 320);
  const layers = items.map(() => h('div', { class: 'hero-layer' }, h('img', { class: 'hero-bg', alt: '', decoding: 'async' })));
  const ensure = (i) => {
    const img = layers[(i + items.length) % items.length].firstChild;
    if (!img.src) img.src = backdropSrc(api, items[(i + items.length) % items.length], width);
  };
  const content = h('div', { class: 'hero-content' });
  const dots = h('div', { class: 'hero-dots' }, items.map((_, i) => h('button', { 'aria-label': `Destacado ${i + 1}`, onclick: () => show(i, true) })));

  function show(i, manual) {
    index = (i + items.length) % items.length;
    ensure(index);
    ensure(index + 1);
    layers.forEach((l, j) => l.classList.toggle('active', j === index));
    [...dots.children].forEach((d, j) => d.classList.toggle('active', j === index));
    const item = items[index];
    const logo = logoSrc(api, item);
    const pct = progressOf(item);
    content.replaceChildren(h('div', { class: 'hero-text fade-in' },
      logo
        ? h('img', { class: 'hero-logo', src: logo, alt: item.Name })
        : h('h1', { class: 'hero-title' }, item.Name),
      h('div', { class: 'hero-meta' }, metaLine(item)),
      item.Overview ? h('p', { class: 'hero-overview' }, item.Overview) : null,
      h('div', { class: 'actions' },
        button(pct ? 'Reanudar' : 'Reproducir', { kind: 'primary', icon: 'play', onclick: () => ctx.play(item) }),
        button('Más información', { onclick: () => { location.hash = `#/item/${item.Id}`; } }))));
    if (manual) restart();
  }

  function restart() {
    clearInterval(timer);
    // Only while the hero is on screen: swapping a full-screen image nobody sees still costs a decode.
    timer = setInterval(() => { if (!document.hidden && window.scrollY < node.offsetHeight / 2) show(index + 1); }, 9000);
  }

  const node = h('section', { class: 'hero' }, layers, h('div', { class: 'hero-shade' }), content, items.length > 1 ? dots : null);
  show(0);
  restart();
  return { node, cleanup: () => clearInterval(timer) };
}
