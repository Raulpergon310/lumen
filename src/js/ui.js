import { icons } from './icons.js';

// Tiny element builder: h('div', { class: 'x', onclick: fn }, child, [children]).
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : String(c));
  }
}

export function iconButton(icon, label, onclick, cls = '') {
  return h('button', { class: `icon-btn ${cls}`, title: label, 'aria-label': label, onclick, html: icons[icon] });
}

export function button(label, { icon, kind = 'glass', onclick, cls = '' } = {}) {
  return h('button', { class: `btn btn-${kind} ${cls}`, onclick },
    icon ? h('span', { class: 'btn-icon', html: icons[icon] }) : null,
    h('span', null, label));
}

// Lazy image that fades in, with a text placeholder when it is missing or fails.
export function image(src, { cls = '', alt = '', placeholder = '' } = {}) {
  const wrap = h('div', { class: `img ${cls}` });
  const ph = h('div', { class: 'img-ph' }, placeholder);
  wrap.append(ph);
  if (src) {
    const img = h('img', { src, alt, loading: 'lazy', decoding: 'async', draggable: 'false' });
    img.addEventListener('load', () => { wrap.classList.add('loaded'); });
    img.addEventListener('error', () => img.remove());
    wrap.append(img);
  }
  return wrap;
}

export function toast(message, kind = 'info') {
  const root = document.getElementById('toasts');
  const el = h('div', { class: `toast toast-${kind}` }, message);
  root.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 400);
  }, kind === 'error' ? 5000 : 3000);
}

export function spinner() {
  return h('div', { class: 'center-fill' }, h('div', { class: 'spinner' }));
}

export function emptyState(title, text, action) {
  return h('div', { class: 'empty' }, h('h2', null, title), text ? h('p', null, text) : null, action || null);
}

export function fmtRuntime(ticks) {
  if (!ticks) return '';
  const min = Math.round(ticks / 6e8);
  const hrs = Math.floor(min / 60);
  return hrs ? `${hrs} h ${min % 60} min` : `${min} min`;
}

export function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = String(sec % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

export function fmtEndsAt(remainingSec) {
  const d = new Date(Date.now() + remainingSec * 1000);
  return `Termina a las ${d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;
}

export function episodeLabel(item) {
  if (item.Type !== 'Episode') return '';
  const s = item.ParentIndexNumber;
  const e = item.IndexNumber;
  if (s == null && e == null) return '';
  if (s === 0) return `Especial${e != null ? ' ' + e : ''}`;
  return `T${s ?? '?'} · E${e ?? '?'}`;
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
