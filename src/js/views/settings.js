import { h, button, toast } from '../ui.js';
import { ctx } from '../context.js';
import { store } from '../store.js';

export const QUALITIES = [
  [0, 'Automática (1080p · 8 Mbps)'],
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

// New seasons (seasons.js): what the last check found, and a button to check now.
function seasonSetting() {
  const status = h('span', { class: 'hint' }, 'Las series con temporadas o episodios ya emitidos que aún no están en el servidor llevan un punto verde, y su ficha dice cuáles faltan. Se comprueba cada 12 horas.');
  const describe = (s, n) => (s
    ? `Última comprobación: ${s.series} series, ${s.checked} encontradas en TVmaze. ${s.seasons ?? n} con temporadas que faltan y ${s.episodes ?? 0} con episodios nuevos${n !== s.found ? ` (${s.found - n} ocultas)` : ''}.`
    : status.textContent);
  import('../seasons.js').then((m) => { const s = m.lastCheckSummary(); if (s) status.textContent = describe(s, s.found); });
  const btn = button('Comprobar ahora', {
    onclick: async () => {
      btn.disabled = true;
      status.textContent = 'Comprobando… (la primera vez puede tardar unos minutos: va serie a serie)';
      try {
        const m = await import('../seasons.js');
        const found = await m.newSeasons({ force: true });
        status.textContent = describe(m.lastCheckSummary(), found.length);
        if (found.length) toast(`${found.length} serie${found.length > 1 ? 's' : ''} con algo por descargar: llevan un punto verde`);
      } catch (e) {
        status.textContent = `No se pudo comprobar: ${e.message}`;
      } finally {
        btn.disabled = false;
      }
    },
  });
  return h('div', { class: 'setting' }, h('span', { class: 'setting-text' }, h('span', null, 'Temporadas y episodios que faltan'), status), btn);
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
      window.lumenHost ? toggle('autoHdr', true, 'Activar el HDR de Windows con las películas HDR', 'Lo enciende al empezar una película o serie HDR y lo vuelve a apagar al terminar (solo si lo encendió Lumen). Así el escritorio se ve como siempre.') : null,
      window.LumenTV ? null : toggle('softAudio', true, 'Decodificar el audio Dolby en la app', 'Con Dolby Digital (AC3 / E-AC3) se reproduce el archivo original y Lumen decodifica el sonido, sin que el servidor convierta nada: arranca y salta mucho más rápido. Apágalo si notas el sonido desincronizado.'),
      window.LumenTV ? null : select('audioMix', 'dialog', 'Sonido 5.1 en altavoces o auriculares', [['dialog', 'Voces claras (recomendado)'], ['night', 'Voces claras + modo noche'], ['standard', 'Mezcla estándar']], 'Cómo se reparte el 5.1 en dos altavoces. Voces claras sube los diálogos frente a la música y los efectos; el modo noche además acerca lo fuerte y lo flojo, para no andar subiendo y bajando el volumen.'),
      window.LumenTV ? null : select('sharpen', 0, 'Nitidez extra de la imagen', [[0, 'Normal (fiel al original)'], [0.25, 'Un poco más nítida'], [0.5, 'Más nítida']], 'Realza los bordes en el reproductor de la app. Puede hacer más visible el grano o los defectos de compresión.'),
      toggle('allowTranscode', false, 'Convertir en el servidor sin preguntar', 'Lumen siempre intenta primero el archivo original y luego la imagen original reempaquetada. Convertir la imagen es el último recurso: si está apagado, la app pregunta antes.'),
      select('maxBitrate', 0, 'Calidad al convertir', QUALITIES, 'Solo se usa cuando el servidor tiene que convertir la imagen. Más calidad = más carga para el NAS.'),
      toggle('autoplayNext', true, 'Reproducir el siguiente episodio automáticamente'),
      toggle('autoSkipIntro', false, 'Saltar intros automáticamente', 'Requiere que el servidor tenga detectadas las intros.'),
    ),
    h('section', { class: 'settings-group' },
      h('h2', null, 'Temporadas nuevas'),
      seasonSetting()),
    h('section', { class: 'settings-group' },
      h('h2', null, 'Servidores'),
      serverList),
    h('section', { class: 'settings-group' },
      h('h2', null, 'Acerca de'),
      versionLine,
      up ? updates : null));
}
