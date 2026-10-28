import { h } from './ui.js';
import { icons, logo } from './icons.js';
import { ctx } from './context.js';

const HIDDEN_TYPES = new Set(['music', 'books', 'photos', 'playlists', 'livetv', 'musicvideos']);
let outsideClick = null;

export function renderNav(nav) {
  const libs = ctx.views.filter((v) => !HIDDEN_TYPES.has(v.CollectionType));
  const userName = ctx.user?.Name || '';

  const menu = h('div', { class: 'menu glass', hidden: true },
    h('div', { class: 'menu-head' },
      h('div', { class: 'menu-name' }, userName),
      h('div', { class: 'menu-sub' }, ctx.server?.name || '')),
    h('a', { class: 'menu-item', href: '#/settings', html: `${icons.settings}<span>Ajustes</span>` }),
    h('button', { class: 'menu-item', html: `${icons.server}<span>Cambiar de servidor</span>`, onclick: () => ctx.showConnect({ serverId: ctx.server?.id }) }),
    h('button', { class: 'menu-item danger', html: `${icons.logout}<span>Cerrar sesión</span>`, onclick: () => ctx.signOut() }));

  const avatar = h('button', { class: 'avatar', title: userName, 'aria-label': 'Cuenta' },
    ctx.user?.PrimaryImageTag
      ? h('img', { src: ctx.api.userImage(), alt: '' })
      : (userName[0] || '?').toUpperCase());

  avatar.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });
  outsideClick?.abort();
  outsideClick = new AbortController();
  document.addEventListener('click', () => { menu.hidden = true; }, { signal: outsideClick.signal });

  nav.replaceChildren(
    h('a', { class: 'brand', href: '#/home', title: 'Inicio', html: logo }),
    h('nav', { class: 'tabs' },
      h('a', { href: '#/home', dataset: { path: '/home' } }, 'Inicio'),
      libs.map((v) => h('a', { href: `#/library/${v.Id}`, dataset: { path: `/library/${v.Id}` } }, v.Name))),
    h('div', { class: 'nav-right' },
      h('a', { class: 'icon-btn', href: '#/search', title: 'Buscar', dataset: { path: '/search' }, html: icons.search }),
      h('div', { class: 'avatar-wrap' }, avatar, menu)),
  );
}

export function updateNav(nav, path) {
  for (const a of nav.querySelectorAll('[data-path]')) {
    a.classList.toggle('active', a.dataset.path === path);
  }
}
