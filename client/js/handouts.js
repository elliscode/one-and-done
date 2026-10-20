import { h, fill, closeMenu } from './common.js';
import { renderMarkdown } from './markdown.js';

// Shared handout UI: rendering a handout, the reader modal, a full-size image lightbox, and the
// image picker used by the editors. A handout here is { id?, title, text, image }.

// The handout body: cover image (if any) above the rendered Markdown. Clicking any image opens it
// full size.
export function handoutBody(ho) {
  const md = h('div.markdown');
  md.innerHTML = renderMarkdown(ho.text ?? '');
  const body = h('div.handout-body', {},
    ho.image ? h('img.handout-cover', { src: ho.image, alt: ho.title ?? '' }) : null,
    ho.text ? md : null);
  body.addEventListener('click', (e) => {
    if (e.target instanceof HTMLImageElement) lightbox(e.target.src, e.target.alt);
  });
  return body;
}

export function lightbox(src, alt = '') {
  const box = h('div.lightbox', { onclick: () => close(), title: 'Click to close' }, h('img', { src, alt }));
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  function close() {
    removeEventListener('keydown', onKey, true);
    box.remove();
  }
  document.body.append(box);
  addEventListener('keydown', onKey, true);
}

// A reader for one or more handouts, with a list on the side when there are several.
// Returns { close, refresh(handouts) } so an open reader can follow state updates.
export function openReader(handouts, { startId = null, onRead = null, emptyText = 'Nothing here yet.' } = {}) {
  closeMenu();
  let list = handouts;
  let current = startId ?? list[0]?.id ?? null;
  const side = h('div.reader-list');
  const page = h('div.reader-page');
  const card = h('div.modal.reader', { role: 'dialog', 'aria-modal': 'true' },
    h('div.reader-head', {}, h('div.modal-title.grow', {}, '📜 Handouts'), h('button.small', { onclick: () => close() }, 'Close')),
    h('div.reader-main', {}, side, page));
  const backdrop = h('div.modal-backdrop', { onclick: (e) => { if (e.target === backdrop) close(); } }, card);
  const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.lightbox')) { e.preventDefault(); close(); } };

  function render() {
    if (!list.some((ho) => ho.id === current)) current = list[0]?.id ?? null;
    side.classList.toggle('hidden', list.length < 2);
    fill(side, ...list.map((ho) => h(`button.reader-item${ho.id === current ? '.active' : ''}`, {
      onclick: () => { current = ho.id; render(); },
    }, ho.title)));
    const ho = list.find((x) => x.id === current);
    if (ho) onRead?.(ho.id);
    fill(page, ...(ho ? [h('h2.reader-title', {}, ho.title), handoutBody(ho)] : [h('p.muted', {}, emptyText)]));
  }
  function close() {
    removeEventListener('keydown', onKey, true);
    backdrop.remove();
  }
  document.body.append(backdrop);
  addEventListener('keydown', onKey, true);
  render();
  return {
    close,
    get open() { return backdrop.isConnected; },
    refresh(next) { list = next; render(); },
  };
}

// Image picker modal over the asset folders. assets = { folder: [paths] } from /api/assets.
export function pickImage(assets, { title = 'Pick an image', folders = ['handouts', 'images', 'backgrounds'] } = {}) {
  closeMenu();
  return new Promise((resolve) => {
    const done = (v) => {
      removeEventListener('keydown', onKey, true);
      backdrop.remove();
      resolve(v);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); } };
    const groups = folders.filter((f) => assets[f]?.length).map((f) => h('div', {},
      h('div.section-title', {}, f),
      h('div.image-grid', {}, ...assets[f].map((p) => h('button.image-choice', { title: p.split('/').pop(), onclick: () => done(p) },
        h('img', { src: p, alt: '', loading: 'lazy' }))))));
    const card = h('div.modal.picker', { role: 'dialog', 'aria-modal': 'true' },
      h('div.reader-head', {}, h('div.modal-title.grow', {}, title), h('button.small', { onclick: () => done(null) }, 'Cancel')),
      h('div.picker-body', {}, ...(groups.length ? groups : [h('p.muted', {}, 'No images yet.')])),
      h('p.muted', { style: { fontSize: '12px', margin: '8px 0 0' } }, 'Upload new images on the ', h('a', { href: '/dm/assets#handouts', target: '_blank' }, 'Assets page'), ' (Handouts folder).'));
    const backdrop = h('div.modal-backdrop', { onclick: (e) => { if (e.target === backdrop) done(null); } }, card);
    document.body.append(backdrop);
    addEventListener('keydown', onKey, true);
  });
}
