// "Cambiar imágenes" sheet: pick a new poster, backdrop or logo from the metadata
// providers, or upload one from the PC.
import { h, button, spinner, toast } from './ui.js';
import { icons } from './icons.js';
import { ctx } from './context.js';

const TYPES = [
  ['Primary', 'Póster'],
  ['Backdrop', 'Fondo'],
  ['Logo', 'Logo'],
  ['Thumb', 'Miniatura'],
];

export function openImagePicker(item, { onChanged } = {}) {
  const api = ctx.api;
  let type = 'Primary';
  let changed = false;

  const grid = h('div', { class: 'img-grid' });
  const tabs = h('div', { class: 'pills' }, TYPES.map(([t, label]) => h('button', {
    class: `pill ${t === type ? 'active' : ''}`,
    onclick: (e) => {
      type = t;
      for (const p of tabs.children) p.classList.toggle('active', p === e.currentTarget);
      load();
    },
  }, label)));

  const fileInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', hidden: true });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      await api.uploadImage(item.Id, type, file);
      changed = true;
      toast('Imagen actualizada');
      close();
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  const sheet = h('div', { class: 'sheet-backdrop', onclick: (e) => { if (e.target === sheet) close(); } },
    h('div', { class: 'sheet glass' },
      h('div', { class: 'sheet-head' },
        h('div', null,
          h('div', { class: 'card-eyebrow' }, item.Name),
          h('h2', null, 'Cambiar imágenes')),
        h('div', { class: 'sheet-tools' },
          button('Subir desde el PC', { onclick: () => fileInput.click() }),
          h('button', { class: 'round-btn', title: 'Cerrar', html: icons.close, onclick: () => close() }))),
      tabs,
      grid,
      fileInput));

  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  document.body.append(sheet);
  load();

  function close() {
    document.removeEventListener('keydown', onKey);
    sheet.remove();
    if (changed) onChanged?.();
  }

  async function load() {
    const want = type;
    grid.className = `img-grid img-grid-${want.toLowerCase()}`;
    grid.replaceChildren(spinner());
    try {
      const images = await api.remoteImages(item.Id, want);
      if (want !== type) return;
      if (!images.length) {
        grid.replaceChildren(h('p', { class: 'muted center' }, 'Los proveedores de metadatos no tienen imágenes de este tipo. Puedes subir una desde el PC.'));
        return;
      }
      images.sort((a, b) => (preferSpanish(b) - preferSpanish(a)) || ((b.CommunityRating || 0) - (a.CommunityRating || 0)));
      grid.replaceChildren(...images.map((img) => choice(img, want)));
    } catch (e) {
      grid.replaceChildren(h('p', { class: 'muted center' },
        e.status === 403 ? 'Necesitas ser administrador en Jellyfin para cambiar imágenes.' : e.message));
    }
  }

  function choice(img, want) {
    const meta = [img.ProviderName, img.Width && img.Height ? `${img.Width}×${img.Height}` : '', img.Language ? img.Language.toUpperCase() : '']
      .filter(Boolean).join(' · ');
    const el = h('button', { class: 'img-choice', title: meta },
      h('div', { class: 'img-choice-art' }, h('img', { src: img.ThumbnailUrl || img.Url, loading: 'lazy', alt: '' })),
      h('div', { class: 'img-choice-meta' }, meta));
    el.addEventListener('click', async () => {
      if (el.classList.contains('busy')) return;
      el.classList.add('busy');
      try {
        await api.downloadRemoteImage(item.Id, want, img.Url);
        changed = true;
        toast('Imagen actualizada');
        close();
      } catch (e) {
        el.classList.remove('busy');
        toast(e.status === 403 ? 'Necesitas ser administrador en Jellyfin para cambiar imágenes.' : e.message, 'error');
      }
    });
    return el;
  }
}

function preferSpanish(img) {
  if (img.Language === 'es') return 2;
  if (!img.Language) return 1;
  return 0;
}
