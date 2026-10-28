// Press-and-hold (or right-click) menu for posters and thumbnails.
import { h, toast } from './ui.js';
import { icons } from './icons.js';
import { ctx } from './context.js';
import { openImagePicker } from './images.js';

const HOLD_MS = 450;
let openMenu = null;

export function attachCardActions(el, item) {
  let holdTimer = null;
  let hoverTimer = null;
  let startPos = null;
  let held = false;

  el.setAttribute('draggable', 'false');
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    held = false;
    startPos = [e.clientX, e.clientY];
    el.classList.add('pressing');
    holdTimer = setTimeout(() => {
      held = true;
      el.classList.remove('pressing');
      showCardMenu(item, startPos);
    }, HOLD_MS);
  });
  const cancel = () => { clearTimeout(holdTimer); el.classList.remove('pressing'); };
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('pointermove', (e) => {
    if (startPos && Math.hypot(e.clientX - startPos[0], e.clientY - startPos[1]) > 8) cancel();
  });
  // A long press must not also open the item.
  el.addEventListener('click', (e) => {
    if (!held) return;
    held = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    cancel();
    showCardMenu(item, [e.clientX, e.clientY]);
  });

  // Fetch the details while the pointer rests on the card, so opening it is instant.
  el.addEventListener('pointerenter', () => {
    hoverTimer = setTimeout(() => {
      ctx.api?.item(item.Id).catch(() => {});
      // Resting on something playable also asks about the file, so its play button starts at once.
      if (['Movie', 'Episode'].includes(item.Type)) import('./mpv-player.js').then((m) => m.probeInfo(item)).catch(() => {});
    }, 350);
  });
  el.addEventListener('pointerleave', () => { clearTimeout(hoverTimer); cancel(); });
}

export function showCardMenu(item, [x, y]) {
  closeMenu();
  const api = ctx.api;
  const ud = item.UserData || (item.UserData = {});
  const inProgress = !ud.Played && ud.PlaybackPositionTicks > 0;
  const playable = ['Movie', 'Episode'].includes(item.Type);

  const run = (fn) => async () => {
    closeMenu();
    try {
      await fn();
      ctx.refresh();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const entry = (icon, label, onclick, cls = '') =>
    h('button', { class: `menu-item ${cls}`, html: `${icons[icon]}<span>${label}</span>`, onclick });

  const menu = h('div', { class: 'menu ctx-menu glass', role: 'menu', onclick: (e) => e.stopPropagation() },
    h('div', { class: 'menu-head' },
      h('div', { class: 'menu-name' }, item.Type === 'Episode' ? item.SeriesName : item.Name),
      item.Type === 'Episode' ? h('div', { class: 'menu-sub' }, item.Name) : null),
    playable ? entry('play', inProgress ? 'Reanudar' : 'Reproducir', () => { closeMenu(); ctx.play(item); }) : null,
    ud.Played
      ? entry('check', 'Marcar como no visto', run(async () => { await api.setPlayed(item.Id, false); toast('Marcado como no visto'); }))
      : entry('check', 'Marcar como visto', run(async () => { await api.setPlayed(item.Id, true); toast('Marcado como visto'); })),
    inProgress
      ? entry('close', 'Quitar de Seguir viendo', run(async () => { await api.clearResume(item.Id); toast('Quitado de Seguir viendo'); }))
      : null,
    entry(ud.IsFavorite ? 'heartFill' : 'heart', ud.IsFavorite ? 'Quitar de favoritos' : 'Añadir a favoritos',
      run(async () => { await api.setFavorite(item.Id, !ud.IsFavorite); })),
    entry('image', 'Cambiar póster', () => { closeMenu(); openImagePicker(item, { onChanged: () => ctx.refresh() }); }));

  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - r.height - 8))}px`;

  const onKey = (e) => { if (e.key === 'Escape') closeMenu(); };
  const onAway = () => closeMenu();
  setTimeout(() => {
    document.addEventListener('click', onAway);
    document.addEventListener('contextmenu', onAway);
  });
  document.addEventListener('keydown', onKey);
  window.addEventListener('scroll', onAway, { passive: true, once: true });
  openMenu = () => {
    menu.remove();
    document.removeEventListener('click', onAway);
    document.removeEventListener('contextmenu', onAway);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('scroll', onAway);
  };
}

function closeMenu() {
  openMenu?.();
  openMenu = null;
}
