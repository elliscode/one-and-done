import { API_BASE } from './config.js';
import { $, h, fill, api, toast } from './common.js';

const me = await api('GET', '/api/me');
if (!me.dm) location.href = '/dm/login?next=/dm/data';

const LABELS = { characters: '🛡 Characters (heroes)', monsters: '👹 Monsters', npcs: '🧙 NPCs', acts: '✋ Acts', items: '🧪 Items' };
const SINGLE_FILES = { acts: 'acts.json', items: 'items.json' };
const EXAMPLES = {
  characters: [{
    id: 'fire-mage', name: 'Fire Mage', role: 'dps', image: '/static/tokens/token_156.webp', maxHp: 30, movement: 6, defense: 13,
    attacks: [{ id: 'fire-bolt', name: 'Fire Bolt', attack: '1d20+5', damage: '1d10+3', range: 8 }],
    abilities: [
      { id: 'healing-word', name: 'Healing Word', heal: '1d8+3', range: 6, description: 'Heal an ally (applies HP).' },
      { id: 'cunning-action', name: 'Cunning Action', grantsActions: 1, description: 'Extra action, once per phase.' },
      { id: 'track', name: 'Track', roll: '1d20+5', description: 'Narrative roll; the DM decides.' },
    ],
    inventory: ['rope', 'healing-potion'],
  }],
  monsters: [{
    id: 'ogre', name: 'Ogre', image: '/static/tokens/monster_007.webp', size: { w: 2, h: 2 }, maxHp: 59, defense: 11, movement: 5,
    attacks: [{ id: 'greatclub', name: 'Greatclub', attack: '1d20+6', damage: '2d8+4', range: 1 }],
  }],
  npcs: [{
    id: 'walky-the-wize', name: 'Walky the Wize', image: '/static/tokens/monster_033.webp', maxHp: 25, defense: 12, movement: 5, hostile: false,
    attacks: [{ id: 'staff-zap', name: 'Staff Zap', attack: '1d20+5', damage: '1d8+2', range: 6 }],
    inventory: ['walking-stick'],
  }],
  acts: [{ id: 'investigate', name: 'Investigate', roll: '1d20' }, { id: 'pull-lever', name: 'Pull Lever' }],
  items: [{
    id: 'healing-potion', name: 'Healing Potion', description: 'Drink it or give it to an adjacent ally: heals 25.',
    ability: { range: 1, effects: [{ type: 'heal', target: 'ally_or_self', heal: 25, range: 1 }] },
  }],
};
const NOTES = {
  characters: 'role: tank | dps | heal. Ability types: heal (targets an ally and applies HP), roll (narrative), grantsActions, free.',
  monsters: 'size is in grid squares (large images scale to it). Players never see monster HP.',
  npcs: 'hostile: true hides HP from players like a monster; omit or false for allies.',
  acts: 'Generic actions shown in every hero\'s Act menu. roll is optional.',
  items: 'Item catalog. Inventory entries match by id ("healing-potion") or name. ability is optional: with one, using the item asks for a target and the item is used up once it resolves. Item heals skip the Heal role bonus.',
};

let list = [];
let current = null; // { category, file }
let original = '';
const editor = h('textarea.json-editor', { spellcheck: false, disabled: true });
const messages = h('div.messages');

const dirty = () => current && editor.value !== original;
const updateDirty = () => { $('#dirty').textContent = dirty() ? '• unsaved changes' : ''; };
editor.addEventListener('input', updateDirty);
addEventListener('beforeunload', (e) => { if (dirty()) e.preventDefault(); });
editor.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end');
    updateDirty();
  }
});
addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); }
});

function showMessages({ ok, error, errors = [], warnings = [] }) {
  fill(messages,
    ok ? h('div.ok', {}, ok) : null,
    error ? h('div.err', {}, error) : null,
    ...errors.map((m) => h('div.err', {}, `✕ ${m}`)),
    ...warnings.map((m) => h('div.warn', {}, `⚠ ${m}`)));
}

async function loadList() {
  list = await api('GET', '/api/data');
  renderSidebar();
}

function renderSidebar() {
  const uploadInput = (category) => h('input', {
    type: 'file', accept: '.json,application/json', multiple: true, hidden: true,
    onchange: (e) => { uploadFiles(category, [...e.target.files]); e.target.value = ''; },
  });
  fill($('#files'), ...list.map(({ category, files }) => {
    const up = uploadInput(category);
    return h('div', {},
      h('div.section-title', {}, LABELS[category]),
      ...files.map((f) => h(`div.file-item${current?.category === category && current.file === f.name ? '.active' : ''}`, {
        onclick: () => open(category, f.name),
      }, h('span.name', {}, f.name), h('span.muted', {}, `${f.count}`))),
      files.length ? null : h('p.muted', {}, 'No files'),
      category === 'items' && !files.length ? h('button.small', { onclick: () => createSingle(category) }, `+ Create ${SINGLE_FILES[category]}`) : null,
      SINGLE_FILES[category] ? null : h('div.row', { style: { marginTop: '4px' } },
        h('button.small', { onclick: () => newFile(category) }, '+ New file'),
        h('button.small', { onclick: () => up.click() }, '⇪ Upload .json'), up));
  }));
}

async function open(category, file) {
  if (dirty() && !confirm('Discard unsaved changes?')) return;
  const { text } = await api('GET', `/api/data/${category}/${encodeURIComponent(file)}`);
  current = { category, file };
  original = text;
  editor.value = text;
  editor.disabled = false;
  $('#current-file').textContent = `${category}/${file}`;
  showMessages({});
  updateDirty();
  renderSidebar();
  renderMain();
}

async function putText(category, file, text, create = false) {
  const url = create ? `/api/data/${category}?name=${encodeURIComponent(file)}` : `/api/data/${category}/${encodeURIComponent(file)}`;
  const res = await fetch(`${API_BASE}${url}`, { method: create ? 'POST' : 'PUT', body: text, headers: { 'Content-Type': 'text/plain' }, credentials: 'include' });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function save() {
  if (!current) return;
  const text = editor.value;
  const r = await putText(current.category, current.file, text);
  if (!r.ok) {
    showMessages({ error: r.data.error ?? `Save failed (${r.status})`, errors: r.data.errors, warnings: r.data.warnings });
    toast('Not saved — see errors', 'error');
    return;
  }
  original = text.endsWith('\n') ? text : `${text}\n`;
  if (editor.value === text) editor.value = original;
  updateDirty();
  showMessages({ ok: '✓ Saved and live-reloaded. New spawns and hero picks use these definitions; tokens already in games keep their stats.', warnings: r.data.warnings });
  toast('Saved');
  loadList();
}

function format() {
  try {
    editor.value = `${JSON.stringify(JSON.parse(editor.value), null, 2)}\n`;
    updateDirty();
    showMessages({});
  } catch (e) {
    showMessages({ error: `Invalid JSON: ${e.message}` });
  }
}

function download() {
  const a = h('a', { href: URL.createObjectURL(new Blob([editor.value], { type: 'application/json' })), download: current.file });
  a.click();
  URL.revokeObjectURL(a.href);
}

async function remove() {
  if (!confirm(`Delete ${current.category}/${current.file}? Its definitions disappear from the banks and hero picker (live game tokens are kept).`)) return;
  try {
    await api('DELETE', `/api/data/${current.category}/${encodeURIComponent(current.file)}`);
  } catch (err) { return toast(err.message, 'error'); }
  toast('Deleted');
  current = null;
  original = '';
  editor.value = '';
  editor.disabled = true;
  $('#current-file').textContent = '';
  updateDirty();
  await loadList();
  renderMain();
}

function slugFile(name) {
  const base = String(name).trim().toLowerCase().replace(/\.json$/, '').replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
  return base ? `${base}.json` : null;
}

async function createSingle(category) {
  const file = SINGLE_FILES[category];
  const r = await putText(category, file, '[]\n', true);
  if (!r.ok) return toast(r.data.error ?? 'Could not create file', 'error');
  await loadList();
  open(category, file);
}

async function newFile(category) {
  const file = slugFile(prompt(`New ${category} file name (e.g. "undead")`) ?? '');
  if (!file) return;
  const r = await putText(category, file, '[]\n', true);
  if (!r.ok) return toast(r.data.error ?? 'Could not create file', 'error');
  await loadList();
  open(category, file);
}

async function uploadFiles(category, fileList) {
  for (const f of fileList) {
    const file = slugFile(f.name);
    if (!file) { toast(`Bad file name: ${f.name}`, 'error'); continue; }
    const text = await f.text();
    const exists = list.find((c) => c.category === category)?.files.some((x) => x.name === file);
    if (exists && !confirm(`${category}/${file} exists. Replace it?`)) continue;
    const r = await putText(category, file, text, !exists);
    if (!r.ok) {
      showMessages({ error: `${f.name}: ${r.data.error ?? 'upload failed'}`, errors: r.data.errors, warnings: r.data.warnings });
      toast(`${f.name} rejected — see errors`, 'error');
      continue;
    }
    toast(`Uploaded ${category}/${file}`);
    if (r.data.warnings?.length) showMessages({ ok: `✓ ${file} uploaded`, warnings: r.data.warnings });
  }
  await loadList();
}

function renderMain() {
  const cat = current?.category;
  fill($('#main'),
    current ? h('div.row', {},
      h('button.primary', { onclick: save, title: 'Ctrl/Cmd-S' }, 'Save'),
      h('button', { onclick: format }, 'Format'),
      h('button', { onclick: download }, 'Download'),
      cat !== 'acts' ? h('button.danger', { onclick: remove }, 'Delete file') : null,
      h('span.grow'),
      h('span.muted', { style: { fontSize: '12px' } }, NOTES[cat])) : h('p.muted', {}, 'Pick a file on the left, or create/upload one.'),
    messages,
    editor,
    cat ? h('details.example', {}, h('summary.muted', {}, `Example ${cat} definition`), h('pre', {}, JSON.stringify(EXAMPLES[cat], null, 2))) : null);
}

await loadList();
renderMain();
const first = list.find((c) => c.files.length);
if (first) open(first.category, first.files[0].name);
