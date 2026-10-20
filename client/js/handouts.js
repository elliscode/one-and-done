import { h, fill, closeMenu } from './common.js';
import { renderMarkdown } from './markdown.js';

// Shared handout UI: rendering a handout, the reader modal, and the image picker used by the
// editors. A handout here is { id?, title, text, image }.

// The handout body: cover image (if any) above the rendered Markdown. Clicking any image opens it
// in a new tab, where the browser's own zoom and scrolling make text-heavy images readable.
export function handoutBody(ho) {
  const md = h('div.markdown');
  md.innerHTML = renderMarkdown(ho.text ?? '');
  const body = h('div.handout-body', {},
    ho.image ? h('img.handout-cover', { src: ho.image, alt: ho.title ?? '' }) : null,
    ho.text ? md : null);
  body.addEventListener('click', (e) => {
    if (e.target instanceof HTMLImageElement) window.open(e.target.src, '_blank', 'noopener');
  });
  return body;
}

// The DM's private notes on a handout, rendered as Markdown in a clearly marked box. Only the DM's
// pages call this; players never receive dmNotes.
export function dmNotesBox(notes) {
  if (!notes) return null;
  const md = h('div.markdown');
  md.innerHTML = renderMarkdown(notes);
  return h('div.dm-notes', {}, h('div.dm-notes-label', {}, '🔒 DM notes (players never see these)'), md);
}

// A reader for one or more handouts, with a list on the side when there are several.
//   forScene(ho)  true for handouts tied to the current scene: they're listed first under
//                 "📍 <sceneName>", and the rest go in a collapsible "Other handouts" group
//   showDmNotes   also show each handout's DM notes and whether it's revealed (DM screen only)
//   actions(ho)   extra buttons for the open handout (DM: Reveal / Hide)
//   status(ho)    a short line under the title (default on the DM screen: revealed or hidden)
// Returns { close, refresh(handouts) } so an open reader can follow state updates.
export function openReader(handouts, {
  startId = null, onRead = null, emptyText = 'Nothing here yet.', showDmNotes = false,
  forScene = () => false, sceneName = () => null, actions = null, status = null,
} = {}) {
  closeMenu();
  let list = handouts;
  const firstScene = () => list.find((ho) => forScene(ho));
  let current = startId ?? firstScene()?.id ?? list[0]?.id ?? null;
  let othersOpen = null; // null: decide from what's shown (collapsed while the scene has handouts)
  const side = h('div.reader-list');
  const page = h('div.reader-page');
  const card = h('div.modal.reader', { role: 'dialog', 'aria-modal': 'true' },
    h('div.reader-head', {}, h('div.modal-title.grow', {}, '📜 Handouts'), h('button.small', { onclick: () => close() }, 'Close')),
    h('div.reader-main', {}, side, page));
  const backdrop = h('div.modal-backdrop', { onclick: (e) => { if (e.target === backdrop) close(); } }, card);
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };

  const item = (ho) => h(`button.reader-item${ho.id === current ? '.active' : ''}`, {
    onclick: () => { current = ho.id; render(); },
  }, ho.title, showDmNotes && ho.revealed === false ? h('span.reader-hidden', { title: 'Hidden from players' }, ' (hidden)') : null);

  function render() {
    if (!list.some((ho) => ho.id === current)) current = firstScene()?.id ?? list[0]?.id ?? null;
    const scene = list.filter((ho) => forScene(ho));
    const others = list.filter((ho) => !forScene(ho));
    if (scene.length) {
      const open = othersOpen ?? others.some((ho) => ho.id === current);
      fill(side,
        h('div.reader-group', {}, `📍 ${sceneName() ?? 'This scene'}`), ...scene.map(item),
        others.length ? h('button.reader-group.reader-toggle', {
          'aria-expanded': String(open),
          onclick: () => { othersOpen = !open; render(); },
        }, `${open ? '▾' : '▸'} Other handouts (${others.length})`) : null,
        ...(open ? others.map(item) : []));
      side.classList.remove('hidden');
    } else {
      fill(side, ...list.map(item));
      side.classList.toggle('hidden', list.length < 2);
    }
    const ho = list.find((x) => x.id === current);
    if (ho) onRead?.(ho.id);
    const extra = ho && actions ? actions(ho) : null;
    fill(page, ...(ho ? [
      h('div.reader-title-row', {}, h('h2.reader-title.grow', {}, ho.title), extra),
      (() => {
        const line = status ? status(ho) : showDmNotes && typeof ho.revealed === 'boolean' ? (ho.revealed ? '👁 Revealed to players' : 'Hidden from players') : null;
        return line ? h('p.muted.reader-status', {}, line) : null;
      })(),
      handoutBody(ho),
      showDmNotes ? dmNotesBox(ho.dmNotes) : null,
    ] : [h('p.muted', {}, emptyText)]));
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
