// An actor's or director's page: photo, bio and everything of theirs in the library.
import { h, image } from '../ui.js';
import { ctx } from '../context.js';
import { posterCard } from '../cards.js';

export async function personView({ params: [id], isStale }) {
  const api = ctx.api;
  const [person, works] = await Promise.all([
    api.item(id),
    api.items({ PersonIds: id, Recursive: true, IncludeItemTypes: 'Movie,Series', SortBy: 'ProductionYear,SortName', SortOrder: 'Descending', Limit: 300 }),
  ]);
  if (isStale()) return null;

  const items = works.Items || [];
  const movies = items.filter((i) => i.Type === 'Movie');
  const series = items.filter((i) => i.Type === 'Series');
  const count = [movies.length && `${movies.length} película${movies.length > 1 ? 's' : ''}`, series.length && `${series.length} serie${series.length > 1 ? 's' : ''}`]
    .filter(Boolean).join(' · ');
  const photo = person.ImageTags?.Primary ? api.image(person.Id, 'Primary', { width: 400, tag: person.ImageTags.Primary }) : null;
  const group = (title, list) => list.length
    ? h('section', { class: 'search-group' }, h('h2', null, title), h('div', { class: 'grid' }, list.map(posterCard)))
    : null;

  return h('div', { class: 'page person-page' },
    h('header', { class: 'person-head' },
      image(photo, { cls: 'person-img big', placeholder: (person.Name || '?')[0] }),
      h('div', { class: 'person-info' },
        h('h1', null, person.Name),
        count ? h('div', { class: 'detail-meta' }, count) : null,
        person.Overview ? h('p', { class: 'overview person-bio' }, person.Overview) : null)),
    group('Películas', movies),
    group('Series', series),
    items.length ? null : h('p', { class: 'muted center' }, 'No hay nada suyo en tu biblioteca.'));
}

// A round photo + name that opens the person's page (cast rows, search results).
export function personCard(p, role) {
  const api = ctx.api;
  const tag = p.PrimaryImageTag || p.ImageTags?.Primary;
  return h('a', { class: 'person', href: `#/person/${p.Id}`, title: p.Name },
    image(tag ? api.image(p.Id, 'Primary', { width: 200, tag }) : null, { cls: 'person-img', placeholder: (p.Name || '?')[0] }),
    h('div', { class: 'person-name' }, p.Name),
    role ? h('div', { class: 'person-role' }, role) : null);
}
