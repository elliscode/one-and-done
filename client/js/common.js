import { API_BASE } from './config.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Tiny element builder: h('button.primary', { onclick }, 'Text', child)
export function h(spec, attrs = {}, ...children) {
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') {
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, val);
        else el.style[prop] = val;
      }
    }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

// replaceChildren that skips null/false (for conditional children).
export function fill(el, ...children) {
  el.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

let toastBox;
export function toast(msg, kind = 'info') {
  toastBox ??= document.body.appendChild(h('div.toasts'));
  const t = toastBox.appendChild(h(`div.toast.${kind}`, {}, msg));
  setTimeout(() => t.classList.add('out'), 3200);
  setTimeout(() => t.remove(), 3700);
}

export async function api(method, url, body) {
  const res = await fetch(`${API_BASE}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'include',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.includes('/login')) {
    location.href = `/dm/login?next=${encodeURIComponent(location.pathname)}`;
    throw new Error('Login required');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Sends a command over the game connection (client/js/transport.js); shows a toast on failure.
// Resolves to the result (or null).
export async function sendCmd(conn, cmd, { quiet = false } = {}) {
  let res;
  try { res = await conn.request('cmd', cmd); } catch { toast('Server did not respond', 'error'); return null; }
  if (!res.ok) { if (!quiet) toast(res.error, 'error'); return null; }
  return res.result ?? true;
}

// Sends a ping over the game connection; shows a toast on failure.
export function sendPing(conn, p) {
  conn.request('ping', p).then((r) => { if (!r.ok) toast(r.error, 'error'); }, () => toast('Server did not respond', 'error'));
}

// Sends a chat line; resolves once the server answers (or gives up).
export function sendChat(conn, text) {
  return conn.request('chat', text).catch(() => null).then((res) => { if (!res?.ok) toast(res?.error ?? 'Failed', 'error'); });
}

export const ROLE_LABELS = { tank: 'Tank', dps: 'DPS', heal: 'Heal' };
export const ROLE_ICONS = { tank: '🛡️', dps: '⚔️', heal: '✚' };
// Same list as the server (core/state.js). No red: that's the enemy color.
export const PLAYER_COLORS = ['#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#ffe119', '#469990'];
export const DM_COLOR = '#d4af37';

// Phase banner + authoritative countdown. Call update() with each state.
export function combatBar(el) {
  let combat = null, offset = 0;
  const render = () => {
    if (!combat?.active) {
      el.className = 'combat-bar idle';
      el.textContent = 'Exploring — no combat';
      return;
    }
    const phase = combat.phase === 'player' ? 'PLAYER PHASE' : 'DM PHASE';
    let timer = '', urgent = false;
    if (combat.pausedMs != null) {
      timer = ' · ⏸ Timer paused — waiting for the DM';
    } else if (combat.phaseEndsAt) {
      const left = Math.max(0, Math.ceil((combat.phaseEndsAt - (Date.now() + offset)) / 1000));
      timer = ` · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      urgent = left <= 10;
    }
    el.className = `combat-bar ${combat.phase}${urgent ? ' urgent' : ''}`;
    el.textContent = `⚔️ ${phase} · Round ${combat.round}${timer}`;
  };
  setInterval(render, 250);
  return {
    update(c, serverNow) {
      combat = c;
      if (serverNow) offset = serverNow - Date.now();
      render();
    },
  };
}

export function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => toast('Copied!'));
  const ta = document.body.appendChild(h('textarea', { value: text }));
  ta.select();
  document.execCommand('copy');
  ta.remove();
  toast('Copied!');
}

// Floating menu anchored at a screen point. Items: {label, sub, disabled, onClick} or {heading}.
let openMenu = null;
export function popupMenu(x, y, title, items, { className = '' } = {}) {
  closeMenu();
  const menu = h(`div.popup-menu${className ? '.' + className : ''}`);
  if (title) menu.append(h('div.popup-title', {}, title));
  for (const it of items) {
    if (it.heading) { menu.append(h('div.popup-heading', {}, it.heading)); continue; }
    if (it.node) { menu.append(it.node); continue; }
    menu.append(h('button.popup-item', {
      disabled: !!it.disabled,
      title: it.title,
      onclick: (e) => { e.stopPropagation(); if (!it.keepOpen) closeMenu(); it.onClick?.(); },
    }, h('span.popup-label', {}, it.label), it.sub ? h('span.popup-sub', {}, it.sub) : null));
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
  openMenu = menu;
  setTimeout(() => document.addEventListener('pointerdown', outside, true));
  return menu;
}
function outside(e) {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
}
// A small "Are you sure?" dialog in the app's style. Resolves true on confirm (button or Enter),
// false on Cancel, Esc or a click outside the card.
export function confirmModal({ title, body, confirm = 'OK', danger = false }) {
  closeMenu();
  return new Promise((resolve) => {
    const done = (answer) => {
      removeEventListener('keydown', onKey, true);
      backdrop.remove();
      resolve(answer);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(true); }
    };
    const ok = h(`button.small${danger ? '.danger' : '.primary'}`, { onclick: () => done(true) }, confirm);
    const card = h('div.modal', { role: 'dialog', 'aria-modal': 'true' },
      h('div.modal-title', {}, title),
      body ? h('p.modal-body', {}, body) : null,
      h('div.modal-actions', {}, h('button.small', { onclick: () => done(false) }, 'Cancel'), ok));
    const backdrop = h('div.modal-backdrop', { onclick: (e) => { if (e.target === backdrop) done(false); } }, card);
    document.body.append(backdrop);
    addEventListener('keydown', onKey, true);
    ok.focus();
  });
}

export function closeMenu() {
  openMenu?.remove();
  openMenu = null;
  document.removeEventListener('pointerdown', outside, true);
}
