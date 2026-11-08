// "Subtítulos" sheet on the detail page: before pressing play, choose which subtitles to use (or none),
// or search the server's subtitle providers (OpenSubtitles plugin) in a language and download one.
import { h, button, spinner, toast } from './ui.js';
import { icons } from './icons.js';
import { ctx } from './context.js';
import { searchSubtitles, downloadSubtitle, pickSubtitle, pickedSubtitle, chooseSubtitle } from './subs.js';

const LANGS = [
  ['spa', 'Español'],
  ['eng', 'Inglés'],
  ['por', 'Portugués'],
  ['fre', 'Francés'],
  ['ger', 'Alemán'],
  ['ita', 'Italiano'],
  ['jpn', 'Japonés'],
];
const LANG_NAMES = { spa: 'Español', es: 'Español', eng: 'Inglés', en: 'Inglés', jpn: 'Japonés', ja: 'Japonés', fre: 'Francés', fra: 'Francés', ger: 'Alemán', deu: 'Alemán', ita: 'Italiano', por: 'Portugués' };

function streamLabel(s) {
  const lang = LANG_NAMES[(s.Language || '').toLowerCase()] || s.Language || '';
  const title = s.Title && !/^(track|pista)?\s*\d*$/i.test(s.Title) ? s.Title : '';
  const parts = [title || lang || `Pista ${s.Index}`];
  if (title && lang && !title.toLowerCase().includes(lang.toLowerCase())) parts.push(lang);
  const extra = [String(s.Codec || '').toUpperCase(), s.IsForced ? 'forzados' : '', s.IsExternal ? 'archivo aparte' : ''].filter(Boolean);
  return { main: parts.join(' · '), extra: extra.join(' · ') };
}

export async function openSubtitlePicker(item) {
  let lang = 'spa';
  let streams = [];
  const current = h('div', { class: 'sub-list' }, spinner());
  const results = h('div', { class: 'sub-list' });
  const tabs = h('div', { class: 'pills small' }, LANGS.map(([code, label]) => h('button', {
    class: `pill ${code === lang ? 'active' : ''}`,
    onclick: (e) => {
      lang = code;
      for (const p of tabs.children) p.classList.toggle('active', p === e.currentTarget);
      search();
    },
  }, label)));

  const sheet = h('div', { class: 'sheet-backdrop', onclick: (e) => { if (e.target === sheet) close(); } },
    h('div', { class: 'sheet glass sheet-narrow' },
      h('div', { class: 'sheet-head' },
        h('div', null,
          h('div', { class: 'card-eyebrow' }, item.Type === 'Episode' ? `${item.SeriesName} · ${item.Name}` : item.Name),
          h('h2', null, 'Subtítulos')),
        h('div', { class: 'sheet-tools' },
          button('Reproducir', { kind: 'primary', icon: 'play', onclick: () => { close(); ctx.play(item); } }),
          h('button', { class: 'round-btn', title: 'Cerrar', html: icons.close, onclick: () => close() }))),
      h('div', { class: 'sheet-body' },
        h('h3', { class: 'sub-head' }, 'Usar al reproducir'),
        current,
        h('h3', { class: 'sub-head' }, 'Buscar en internet'),
        tabs,
        results)));

  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  document.body.append(sheet);
  loadCurrent();
  search();

  function close() {
    document.removeEventListener('keydown', onKey, true);
    sheet.remove();
  }

  async function loadCurrent() {
    try {
      const m = await import('./mpv-player.js');
      const ms = await m.probeSource(item);
      streams = (ms?.MediaStreams || []).filter((s) => s.Type === 'Subtitle');
      renderCurrent(ms);
    } catch (e) {
      current.replaceChildren(h('p', { class: 'muted' }, e.message));
    }
  }

  function renderCurrent(ms) {
    const manual = pickedSubtitle(item.Id);
    const auto = ms ? chooseSubtitleIgnoringPick(ms) : undefined;
    const choose = (index, text) => {
      pickSubtitle(item.Id, index);
      renderCurrent(ms);
      toast(text);
    };
    const opt = (label, hint, selected, onclick) => h('button', { class: `sub-opt ${selected ? 'on' : ''}`, onclick },
      h('span', { class: 'sub-check', html: selected ? icons.check : '' }),
      h('span', { class: 'sub-text' }, h('span', null, label), hint ? h('span', { class: 'hint' }, hint) : null));
    const autoName = auto === -1 ? 'ninguno' : streams.find((s) => s.Index === auto) ? streamLabel(streams.find((s) => s.Index === auto)).main : 'los del servidor';
    current.replaceChildren(
      opt('Automático', `Ahora mismo: ${autoName}`, manual === undefined, () => choose(undefined, 'Subtítulos automáticos')),
      opt('Sin subtítulos', null, manual === -1, () => choose(-1, 'Se reproducirá sin subtítulos')),
      ...streams.map((s) => {
        const l = streamLabel(s);
        return opt(l.main, l.extra, manual === s.Index, () => choose(s.Index, `Subtítulos: ${l.main}`));
      }),
      ...(streams.length ? [] : [h('p', { class: 'muted small' }, 'Este archivo no trae subtítulos. Búscalos abajo.')]));
  }

  // The automatic choice as it would be without a manual pick (shown as a hint).
  function chooseSubtitleIgnoringPick(ms) {
    const manual = pickedSubtitle(item.Id);
    pickSubtitle(item.Id, undefined);
    const r = chooseSubtitle(ms).index ?? ms.DefaultSubtitleStreamIndex;
    if (manual !== undefined) pickSubtitle(item.Id, manual);
    return r;
  }

  async function search() {
    const want = lang;
    results.replaceChildren(spinner());
    let list;
    try {
      list = await searchSubtitles(item, want);
    } catch (e) {
      if (want !== lang) return;
      results.replaceChildren(h('p', { class: 'muted' }, e.status === 403
        ? 'Para buscar subtítulos hace falta un usuario administrador en Jellyfin.'
        : 'El servidor no tiene un buscador de subtítulos (instala el plugin OpenSubtitles en Jellyfin).'));
      return;
    }
    if (want !== lang) return;
    if (!list?.length) {
      results.replaceChildren(h('p', { class: 'muted' }, 'No se encontró nada en este idioma.'));
      return;
    }
    list.sort((a, b) => (b.IsHashMatch ? 1 : 0) - (a.IsHashMatch ? 1 : 0) || (b.DownloadCount || 0) - (a.DownloadCount || 0));
    results.replaceChildren(...list.slice(0, 40).map((r) => {
      const info = [
        r.ProviderName,
        r.Format ? String(r.Format).toUpperCase() : '',
        r.DownloadCount ? `${r.DownloadCount.toLocaleString('es-ES')} descargas` : '',
        r.CommunityRating ? `★ ${Number(r.CommunityRating).toFixed(1)}` : '',
        r.IsHashMatch ? 'coincide con tu archivo' : '',
        r.IsForced ? 'forzados' : '',
        r.HearingImpaired ? 'para sordos' : '',
      ].filter(Boolean).join(' · ');
      const btn = button('Descargar', { onclick: () => download(r, btn) });
      return h('div', { class: 'sub-result' },
        h('span', { class: 'sub-text' }, h('span', null, r.Name || r.Id), h('span', { class: 'hint' }, info), r.Comment ? h('span', { class: 'hint' }, r.Comment) : null),
        btn);
    }));
  }

  async function download(r, btn) {
    btn.disabled = true;
    btn.lastChild.textContent = 'Descargando…';
    try {
      const sub = await downloadSubtitle(item, r.Id);
      if (!sub) {
        toast('Descargado; el servidor tardará un poco en mostrarlo.');
        btn.lastChild.textContent = 'Descargado';
        return;
      }
      pickSubtitle(item.Id, sub.Index);
      btn.lastChild.textContent = 'Elegido';
      toast('Subtítulos descargados y elegidos para esta reproducción');
      await loadCurrent();
    } catch (e) {
      btn.disabled = false;
      btn.lastChild.textContent = 'Descargar';
      toast(e.status === 403 ? 'Hace falta un usuario administrador en Jellyfin.' : e.message, 'error');
    }
  }
}
