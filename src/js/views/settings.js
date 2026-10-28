import { h, button, toast } from '../ui.js';
import { ctx } from '../context.js';
import { store } from '../store.js';

export const QUALITIES = [
  [0, 'Automática (máxima)'],
  [60e6, '4K · 60 Mbps'],
  [20e6, '1080p · 20 Mbps'],
  [10e6, '1080p · 10 Mbps'],
  [6e6, '720p · 6 Mbps'],
  [3e6, '480p · 3 Mbps'],
];

function toggle(key, fallback, label, hint) {
  const input = h('input', { type: 'checkbox', checked: store.get(key, fallback) });
  input.addEventListener('change', () => store.set(key, input.checked));
  return h('label', { class: 'setting' },
    h('span', { class: 'setting-text' }, h('span', null, label), hint ? h('span', { class: 'hint' }, hint) : null),
    h('span', { class: 'switch' }, input, h('span', { class: 'switch-ui' })));
}

function select(key, fallback, label, options, hint) {
  const sel = h('select', { class: 'select', onchange: (e) => store.set(key, typeof fallback === 'number' ? Number(e.target.value) : e.target.value) },
    options.map(([v, l]) => h('option', { value: v, selected: store.get(key, fallback) === v }, l)));
  return h('label', { class: 'setting' },
    h('span', { class: 'setting-text' }, h('span', null, label), hint ? h('span', { class: 'hint' }, hint) : null),
    sel);
}

export function settingsView() {
  const servers = ctx.savedServers();
  const serverList = h('div', { class: 'setting-list' }, servers.map((s) => h('div', { class: 'setting' },
    h('span', { class: 'setting-text' },
      h('span', null, s.name + (s.id === ctx.server?.id ? '  (actual)' : '')),
      h('span', { class: 'hint' }, `${s.userName || 'sin sesión'} · ${s.urls.join(' · ')}`)),
    s.id === ctx.server?.id
      ? button('Editar direcciones', { onclick: () => ctx.showConnect({ serverId: s.id, edit: true }) })
      : button('Olvidar', {
        onclick: (e) => {
          store.set('servers', ctx.savedServers().filter((x) => x.id !== s.id));
          e.currentTarget.closest('.setting').remove();
          toast('Servidor eliminado');
        },
      }))));

  // Version and updates (desktop): the installed app updates itself from a folder on the NAS.
  const versionLine = h('p', { class: 'muted' }, `Conectado a ${ctx.server?.name} (Jellyfin ${ctx.server?.version || '?'}) en ${ctx.server?.url}`);
  const updates = h('div', { class: 'setting' });
  const up = window.lumenHost?.update;
  if (up) {
    const status = h('span', { class: 'hint' });
    const describe = (r, info) => ({
      portable: 'Esta es la versión portable: instala Lumen para recibir actualizaciones automáticas.',
      unreachable: `No encuentro la carpeta de actualizaciones (${r.dir}). ¿Está el NAS conectado?`,
      current: 'Tienes la última versión.',
      ready: `Lumen ${r.version} está lista: se instalará al cerrar la app.`,
      checking: 'Buscando…',
      error: `No se pudo actualizar: ${r.message}`,
    }[r.state] || '');
    const checkBtn = button('Buscar actualizaciones', {
      onclick: async () => {
        status.textContent = 'Buscando…';
        status.textContent = describe(await up.check());
      },
    });
    up.info().then((info) => {
      versionLine.textContent = `Lumen ${info.version} · ${versionLine.textContent}`;
      if (!info.installed) status.textContent = describe({ state: 'portable' });
      else if (info.ready) status.textContent = describe({ state: 'ready', version: info.ready });
      else status.textContent = `Se actualiza sola desde ${info.dir}.`;
    });
    updates.append(h('span', { class: 'setting-text' }, h('span', null, 'Actualizaciones'), status), checkBtn);
  }

  return h('div', { class: 'page settings' },
    h('h1', null, 'Ajustes'),
    h('section', { class: 'settings-group' },
      h('h2', null, 'Reproducción'),
      window.LumenTV ? select('player', 'auto', 'Reproductor', [['auto', 'Automático (recomendado)'], ['builtin', 'Siempre la app']], 'Automático: la app reproduce hasta 1080p (con saltar intro y siguiente episodio) y VLC se encarga del 4K, HDR y formatos raros.') : null,
      window.lumenHost ? select('player', 'auto', 'Reproductor', [['auto', 'Automático (recomendado)'], ['builtin', 'Siempre la app'], ['mpv', 'Siempre mpv']], 'Automático: la app reproduce lo compatible y mpv se encarga del HDR, Dolby Vision, DTS/TrueHD/Atmos y formatos raros.') : null,
      toggle('allowTranscode', false, 'Convertir en el servidor sin preguntar', 'Si está apagado, la app avisa cuando un archivo no se puede reproducir en directo.'),
      select('maxBitrate', 0, 'Calidad al convertir', QUALITIES, 'Solo se usa cuando el servidor convierte el vídeo.'),
      toggle('autoplayNext', true, 'Reproducir el siguiente episodio automáticamente'),
      toggle('autoSkipIntro', false, 'Saltar intros automáticamente', 'Requiere que el servidor tenga detectadas las intros.'),
    ),
    h('section', { class: 'settings-group' },
      h('h2', null, 'Servidores'),
      serverList),
    h('section', { class: 'settings-group' },
      h('h2', null, 'Acerca de'),
      versionLine,
      up ? updates : null));
}
