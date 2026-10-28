import { h, spinner, debounce } from '../ui.js';
import { icons } from '../icons.js';
import { ctx } from '../context.js';
import { posterCard, thumbCard } from '../cards.js';
import { personCard } from './person.js';

let lastTerm = '';

export async function searchView() {
  const input = h('input', { class: 'search-input', placeholder: 'Películas, series, actores, directores…', value: lastTerm, spellcheck: 'false' });
  const results = h('div', { class: 'search-results' });
  let seq = 0;

  const run = debounce(async () => {
    const term = input.value.trim();
    lastTerm = term;
    const my = ++seq;
    if (term.length < 2) { results.replaceChildren(); return; }
    results.replaceChildren(spinner());
    try {
      // Titles and people (actors, directors…) at the same time.
      const [r, people] = await Promise.all([
        ctx.api.items({
          SearchTerm: term,
          IncludeItemTypes: 'Movie,Series,Episode,BoxSet',
          Recursive: true,
          Limit: 60,
        }),
        ctx.api.req('/Persons', { query: { searchTerm: term, userId: ctx.api.userId, limit: 14, enableImages: true } }).catch(() => null),
      ]);
      if (my !== seq) return;
      const items = r.Items || [];
      const persons = people?.Items || [];
      const group = (title, list, card, cls = 'grid') => list.length
        ? h('section', { class: 'search-group' }, h('h2', null, title), h('div', { class: cls }, list.map((i) => card(i))))
        : null;
      const sections = [
        persons.length ? h('section', { class: 'search-group' }, h('h2', null, 'Personas'), h('div', { class: 'person-grid' }, persons.map((p) => personCard(p)))) : null,
        group('Películas', items.filter((i) => i.Type === 'Movie'), posterCard),
        group('Series', items.filter((i) => i.Type === 'Series'), posterCard),
        group('Colecciones', items.filter((i) => i.Type === 'BoxSet'), posterCard),
        group('Episodios', items.filter((i) => i.Type === 'Episode'), (i) => thumbCard(i), 'grid grid-thumb'),
      ].filter(Boolean);
      results.replaceChildren(...(sections.length ? sections : [h('p', { class: 'muted center' }, `Sin resultados para “${term}”`)]));
    } catch (e) {
      if (my === seq) results.replaceChildren(h('p', { class: 'muted center' }, e.message));
    }
  }, 300);

  input.addEventListener('input', run);
  requestAnimationFrame(() => input.focus());
  if (lastTerm) run();

  return h('div', { class: 'page search' },
    h('div', { class: 'search-box' }, h('span', { html: icons.search }), input),
    results);
}
