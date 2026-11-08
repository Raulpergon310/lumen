// "Identificar" sheet: when Jellyfin matched a film or series to the wrong title (or to none), search
// the metadata providers (TMDB, IMDb…) by title, year or id and apply the right one. Jellyfin then
// downloads the new information and images itself. Needs an administrator account in Jellyfin.
import { h, button, spinner, toast } from './ui.js';
import { icons } from './icons.js';
import { ctx } from './context.js';

const KINDS = { Movie: 'Movie', Series: 'Series', BoxSet: 'BoxSet' };

export function canIdentify(item) {
  return !!KINDS[item.Type];
}

// "tt0903747" -> IMDb, "1396" -> TMDB, "tvdb:81189" -> TVDB.
function parseId(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (/^tt\d+$/i.test(t)) return { Imdb: t.toLowerCase() };
  const m = t.match(/^tvdb[:\s]*(\d+)$/i);
  if (m) return { Tvdb: m[1] };
  const tm = t.match(/(?:tmdb[:\s]*)?(\d+)$/i);
  if (tm) return { Tmdb: tm[1] };
  return null;
}

export async function openIdentify(base) {
  const api = ctx.api;
  // List cards don't carry the provider ids: ask for the full item.
  const item = base.ProviderIds ? base : await api.item(base.Id).catch(() => base);
  const kind = KINDS[item.Type];
  if (!kind) return;

  const name = h('input', { class: 'field', placeholder: 'Título', value: item.Name || '', spellcheck: 'false' });
  const year = h('input', { class: 'field id-year', placeholder: 'Año', inputmode: 'numeric', value: item.ProductionYear || '' });
  const id = h('input', { class: 'field', placeholder: 'ID de TMDB o IMDb (tt…), opcional', spellcheck: 'false' });
  const results = h('div', { class: 'img-grid id-grid' });
  const searchBtn = button('Buscar', { kind: 'primary', icon: 'search' });
  const form = h('form', { class: 'id-form', onsubmit: (e) => { e.preventDefault(); search(); } }, name, year, id, searchBtn);

  const ids = Object.entries(item.ProviderIds || {}).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(' · ');
  const sheet = h('div', { class: 'sheet-backdrop', onclick: (e) => { if (e.target === sheet) close(); } },
    h('div', { class: 'sheet glass' },
      h('div', { class: 'sheet-head' },
        h('div', null,
          h('div', { class: 'card-eyebrow' }, `${item.Name}${item.ProductionYear ? ` (${item.ProductionYear})` : ''}`),
          h('h2', null, 'Identificar'),
          h('p', { class: 'muted small' }, ids ? `Ahora: ${ids}` : 'Jellyfin no la tiene identificada.')),
        h('div', { class: 'sheet-tools' },
          h('button', { class: 'round-btn', title: 'Cerrar', html: icons.close, onclick: () => close() }))),
      h('div', { class: 'id-form-wrap' }, form),
      results));

  const onKey = (e) => { if (e.key === 'Escape' && !e.target.matches?.('input')) { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  document.body.append(sheet);
  search();

  function close() {
    document.removeEventListener('keydown', onKey, true);
    sheet.remove();
  }

  async function search() {
    const providerIds = parseId(id.value);
    if (id.value.trim() && !providerIds) { toast('Ese ID no se reconoce. Usa el número de TMDB o el de IMDb (tt…).', 'error'); return; }
    const y = parseInt(year.value, 10);
    results.replaceChildren(spinner());
    searchBtn.disabled = true;
    try {
      const list = await api.send(`/Items/RemoteSearch/${kind}`, {
        method: 'POST',
        timeout: 45000,
        body: {
          SearchInfo: { Name: name.value.trim(), Year: y > 1800 ? y : undefined, ProviderIds: providerIds || {} },
          ItemId: item.Id,
          IncludeDisabledProviders: true,
        },
      });
      if (!list?.length) {
        results.replaceChildren(h('p', { class: 'muted center' }, 'No se encontró nada. Prueba con el título original, sin año, o con el ID de TMDB/IMDb.'));
        return;
      }
      results.replaceChildren(...list.map(choice));
    } catch (e) {
      results.replaceChildren(h('p', { class: 'muted center' }, e.status === 403 ? 'Necesitas ser administrador en Jellyfin para identificar.' : e.message));
    } finally {
      searchBtn.disabled = false;
    }
  }

  function choice(r) {
    const pids = Object.entries(r.ProviderIds || {}).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(' · ');
    const meta = [r.ProductionYear, r.SearchProviderName].filter(Boolean).join(' · ');
    const el = h('button', { class: 'img-choice id-choice', title: [r.Name, meta, pids, r.Overview].filter(Boolean).join('\n') },
      h('div', { class: 'img-choice-art' }, r.ImageUrl ? h('img', { src: r.ImageUrl, loading: 'lazy', alt: '' }) : h('div', { class: 'img-ph' }, r.Name)),
      h('div', { class: 'id-name' }, r.Name),
      h('div', { class: 'img-choice-meta' }, meta),
      pids ? h('div', { class: 'img-choice-meta' }, pids) : null);
    el.addEventListener('click', () => apply(r, el));
    return el;
  }

  async function apply(r, el) {
    if (el.classList.contains('busy')) return;
    const label = `${r.Name}${r.ProductionYear ? ` (${r.ProductionYear})` : ''}`;
    // First press asks, second press applies (no browser dialogs: they don't work on the TV).
    if (!el.classList.contains('armed')) {
      results.querySelectorAll('.armed').forEach((x) => { x.classList.remove('armed'); x.querySelector('.id-confirm')?.remove(); });
      el.classList.add('armed');
      el.append(h('div', { class: 'id-confirm' }, 'Pulsa otra vez para aplicar'));
      return;
    }
    el.classList.add('busy');
    try {
      await api.send(`/Items/RemoteSearch/Apply/${item.Id}`, { method: 'POST', query: { ReplaceAllImages: true }, body: r, timeout: 60000 });
      toast(`Identificada como ${label}. Jellyfin está actualizando la información…`);
      close();
      // The server refreshes in the background: show the new data when it is there.
      for (const wait of [3000, 9000]) {
        setTimeout(() => { api.clearCache(); ctx.refresh({ quiet: true }); }, wait);
      }
    } catch (e) {
      el.classList.remove('busy');
      toast(e.status === 403 ? 'Necesitas ser administrador en Jellyfin para identificar.' : e.message, 'error');
    }
  }
}
