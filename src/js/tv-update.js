// Android TV: a newer release on GitHub is offered with a banner; "Actualizar" downloads the APK and
// Android asks to confirm the install (MainActivity / ApkUpdater do the native part).
import { h, button } from './ui.js';
import { BUILD } from './build-info.js';
import { log } from './store.js';

function newer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

export async function checkTvUpdate() {
  const tv = window.LumenTV;
  if (!tv?.installUpdate || !BUILD.repo) return;
  try {
    const r = await fetch(`https://api.github.com/repos/${BUILD.repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) return;
    const rel = await r.json();
    const version = String(rel.tag_name).replace(/^v/, '');
    const apk = (rel.assets || []).find((a) => a.name === 'Lumen-tv.apk');
    const current = tv.appVersion?.() || BUILD.version;
    if (!apk || !newer(version, current)) return;
    offer(version, apk.browser_download_url);
  } catch (e) {
    log(`update: ${e.message}`);
  }
}

function offer(version, url) {
  const status = h('div', { class: 'muted small' }, 'Se descarga e instala en un momento.');
  const go = button('Actualizar', { kind: 'primary', onclick: () => { go.disabled = true; tv().installUpdate(url); } });
  const later = h('button', { class: 'icon-btn', title: 'Más tarde', html: '&times;', onclick: () => banner.remove() });
  const banner = h('div', { class: 'update-banner glass' },
    h('div', null, h('strong', null, `Lumen ${version} disponible`), status), go, later);
  document.body.append(banner);
  go.focus(); // with the remote, the offer must be one OK away

  window.lumenTvUpdate = (state) => {
    const [kind, ...rest] = String(state).split(' ');
    if (kind === 'downloading') status.textContent = `Descargando… ${rest[0]} %`;
    else if (kind === 'confirm') status.textContent = 'Confirma la instalación en la pantalla de Android.';
    else if (kind === 'permission') { status.textContent = 'Permite a Lumen instalar apps, vuelve y pulsa Actualizar otra vez.'; go.disabled = false; }
    else if (kind === 'error') { status.textContent = `No se pudo actualizar: ${rest.join(' ')}`; go.disabled = false; }
  };
}

const tv = () => window.LumenTV;
