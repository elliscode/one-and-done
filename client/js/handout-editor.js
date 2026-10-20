import { $, h, fill, api, toast } from './common.js';
import { handoutBody, pickImage } from './handouts.js';

const TEXT_MAX = 8000;
const NOTES_MAX = 2000;

const me = await api('GET', '/api/me');
const id = decodeURIComponent(location.pathname.split('/').pop());
if (!me.dm) location.href = `/dm/login?next=${encodeURIComponent(location.pathname)}`;
const [ho, assets] = await Promise.all([api('GET', `/api/handouts/${encodeURIComponent(id)}`), api('GET', '/api/assets')]);

const builtIn = !!ho.builtIn;
let image = ho.data.image ?? null;
let dirty = false;

$('#title').value = ho.title;
$('#text').value = ho.data.text ?? '';
$('#notes').value = ho.data.dmNotes ?? '';
for (const el of [$('#title'), $('#text'), $('#notes')]) {
  el.readOnly = builtIn;
  el.addEventListener('input', () => { markDirty(); render(); });
}
$('#save').classList.toggle('hidden', builtIn);
$('#insert-image').classList.toggle('hidden', builtIn);
$('#builtin-note').classList.toggle('hidden', !builtIn);

function markDirty() {
  dirty = true;
  $('#dirty').textContent = '• unsaved changes';
}
addEventListener('beforeunload', (e) => { if (dirty) e.preventDefault(); });

function render() {
  fill($('#cover'),
    image ? h('img.cover-thumb', { src: image, alt: '' }) : h('span.muted', {}, 'None'),
    builtIn ? null : h('button.small', {
      onclick: async () => {
        const p = await pickImage(assets, { title: 'Cover image' });
        if (p) { image = p; markDirty(); render(); }
      },
    }, image ? 'Change' : 'Pick image'),
    image && !builtIn ? h('button.small', { onclick: () => { image = null; markDirty(); render(); } }, 'Remove') : null);
  const text = $('#text').value;
  $('#count').textContent = `${text.length.toLocaleString()} / ${TEXT_MAX.toLocaleString()} characters`;
  $('#count').classList.toggle('over', text.length > TEXT_MAX || $('#notes').value.length > NOTES_MAX);
  const title = $('#title').value.trim() || 'Untitled handout';
  fill($('#preview'), h('h2.reader-title', {}, title),
    text.trim() || image ? handoutBody({ title, text, image }) : h('p.muted', {}, 'Add some text or a cover image.'));
}

$('#insert-image').addEventListener('click', async () => {
  const p = await pickImage(assets, { title: 'Insert an image' });
  if (!p) return;
  const ta = $('#text');
  const at = ta.selectionStart ?? ta.value.length;
  const before = ta.value.slice(0, at);
  const snippet = `${before && !before.endsWith('\n') ? '\n\n' : ''}![](${p})\n`;
  ta.value = before + snippet + ta.value.slice(ta.selectionEnd ?? at);
  ta.focus();
  ta.selectionStart = ta.selectionEnd = at + snippet.length;
  markDirty();
  render();
});

$('#save').addEventListener('click', async () => {
  try {
    const saved = await api('PUT', `/api/handouts/${encodeURIComponent(id)}`, {
      title: $('#title').value, text: $('#text').value, image, dmNotes: $('#notes').value,
    });
    $('#title').value = saved.title;
    dirty = false;
    $('#dirty').textContent = '';
    toast('Handout saved');
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('#duplicate').addEventListener('click', async () => {
  const copy = await api('POST', '/api/handouts', { ...ho.data, title: `${ho.title} copy` });
  location.href = `/dm/handouts/${copy.id}`;
});

render();
