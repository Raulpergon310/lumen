import { h, button, toast } from '../ui.js';
import { icons, logo } from '../icons.js';
import { Api, findReachable, normalizeUrl } from '../api.js';
import { store } from '../store.js';

// Two steps: pick/add a server, then sign in.
export function connectView({ serverId, edit, deviceId, onDone }) {
  const root = h('div', { class: 'connect' });
  const saved = store.get('servers', []);
  const preset = saved.find((s) => s.id === serverId);

  if (preset && edit) serverStep(preset);
  else if (preset) loginStep(preset);
  else serverStep();
  return root;

  function shell(...children) {
    root.replaceChildren(
      h('div', { class: 'connect-bg' }),
      h('div', { class: 'glass-card connect-card' },
        h('div', { class: 'connect-brand', html: logo }),
        ...children));
  }

  function serverStep(prefill = {}) {
    // An invitation link (…/app/?server=https://…) brings the address, so friends only sign in.
    const invited = new URLSearchParams(location.search).get('server') || '';
    const main = h('input', { class: 'field', placeholder: 'http://192.168.1.50:8096', value: prefill.urls?.[0] || invited, spellcheck: 'false' });
    const alt = h('input', { class: 'field', placeholder: 'https://jellyfin.midominio.com (opcional)', value: prefill.urls?.[1] || '', spellcheck: 'false' });
    const err = h('p', { class: 'form-error' });
    const go = button('Continuar', { kind: 'primary', cls: 'wide' });

    const submit = async (e) => {
      e?.preventDefault();
      const urls = [normalizeUrl(main.value), normalizeUrl(alt.value)].filter(Boolean);
      if (!urls.length) { err.textContent = 'Escribe la dirección de tu servidor.'; return; }
      err.textContent = '';
      go.disabled = true;
      go.lastChild.textContent = 'Buscando servidor…';
      try {
        const { info } = await findReachable(urls, 7000);
        const existing = saved.find((s) => s.id === info.Id);
        loginStep({ ...(existing || {}), id: info.Id, name: info.ServerName, urls });
      } catch (ex) {
        err.textContent = `${ex.message}. Revisa la dirección y que el servidor esté encendido.`;
      } finally {
        go.disabled = false;
        go.lastChild.textContent = 'Continuar';
      }
    };

    const list = saved.length
      ? h('div', { class: 'server-list' },
        h('div', { class: 'label' }, 'Servidores guardados'),
        saved.map((s) => h('button', { class: 'server-item', onclick: () => loginStep(s) },
          h('span', { class: 'server-icon', html: icons.server }),
          h('span', { class: 'server-text' },
            h('span', { class: 'server-name' }, s.name),
            h('span', { class: 'server-url' }, s.userName ? `${s.userName} · ${s.urls[0]}` : s.urls[0])))))
      : null;

    shell(
      h('h1', null, saved.length ? 'Elige un servidor' : 'Conecta tu servidor'),
      list,
      h('form', { class: 'form', onsubmit: submit },
        h('label', { class: 'label' }, saved.length ? 'Añadir otro servidor' : 'Dirección del servidor'),
        main,
        h('label', { class: 'label' }, 'Dirección alternativa'),
        alt,
        h('p', { class: 'hint' }, 'Pon la de casa arriba y la de fuera abajo: la app usará la que responda.'),
        err,
        go));
    go.type = 'submit';
    main.focus();
  }

  async function loginStep(server) {
    const user = h('input', { class: 'field', placeholder: 'Usuario', value: server.userName || '', autocomplete: 'username', spellcheck: 'false' });
    const pass = h('input', { class: 'field', type: 'password', placeholder: 'Contraseña', autocomplete: 'current-password' });
    const err = h('p', { class: 'form-error' });
    const go = button('Entrar', { kind: 'primary', cls: 'wide' });
    go.type = 'submit';
    const users = h('div', { class: 'user-picks' });

    const submit = async (e) => {
      e?.preventDefault();
      if (!user.value.trim()) { err.textContent = 'Escribe tu usuario.'; return; }
      err.textContent = '';
      go.disabled = true;
      go.lastChild.textContent = 'Entrando…';
      try {
        const { url } = await findReachable(server.urls, 7000);
        const api = new Api({ url, deviceId });
        const r = await api.login(user.value.trim(), pass.value);
        onDone({ ...server, userId: r.User.Id, userName: r.User.Name, token: r.AccessToken });
      } catch (ex) {
        err.textContent = ex.status === 401 ? 'Usuario o contraseña incorrectos.' : ex.message;
        go.disabled = false;
        go.lastChild.textContent = 'Entrar';
      }
    };

    shell(
      h('div', { class: 'card-eyebrow' }, server.name),
      h('h1', null, 'Inicia sesión'),
      users,
      h('form', { class: 'form', onsubmit: submit }, user, pass, err, go),
      h('button', { class: 'link-btn', onclick: () => serverStep(server) }, 'Usar otro servidor'));
    (server.userName ? pass : user).focus();

    // Public users, shown as quick picks when the server allows it.
    try {
      const { url } = await findReachable(server.urls, 5000);
      const api = new Api({ url, deviceId });
      const list = await api.req('/Users/Public', { timeout: 5000 });
      if (!list?.length) return;
      users.replaceChildren(...list.slice(0, 6).map((u) => h('button', {
        class: 'user-pick',
        onclick: () => { user.value = u.Name; pass.focus(); if (!u.HasPassword) submit(); },
      },
      h('span', { class: 'avatar big' }, u.PrimaryImageTag
        ? h('img', { src: `${url}/Users/${u.Id}/Images/Primary?fillWidth=96&tag=${u.PrimaryImageTag}`, alt: '' })
        : u.Name[0].toUpperCase()),
      h('span', null, u.Name))));
    } catch (e) {
      if (e.status && e.status !== 404) toast(e.message);
    }
  }
}
