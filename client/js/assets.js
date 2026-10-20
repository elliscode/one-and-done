import { API_BASE } from './config.js';
import { $, h, fill, api, toast, copyText } from './common.js';

const me = await api('GET', '/api/me');
if (!me.dm) location.href = '/dm/login?next=/dm/assets';

const FOLDERS = [
  { id: 'backgrounds', label: '🗺 Backgrounds' },
  { id: 'tokens', label: '◉ Tokens' },
  { id: 'images', label: '🖼 Images' },
  { id: 'handouts', label: '📜 Handouts' },
];
let folder = FOLDERS.some((f) => f.id === location.hash.slice(1)) ? location.hash.slice(1) : 'backgrounds';
let files = {};

const kb = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

async function load() {
  files = await api('GET', '/api/assets/files');
  render();
}

function render() {
  fill($('#folders'), ...FOLDERS.map((f) => h(`button${f.id === folder ? '.active' : ''}`, {
    onclick: () => { folder = f.id; history.replaceState(null, '', `#${f.id}`); render(); },
  }, f.label, ' ', h('span.count', {}, `(${files[f.id]?.length ?? 0})`))));
  const list = files[folder] ?? [];
  fill($('#grid'), list.length ? null : h('div.empty-note', { style: { gridColumn: '1 / -1' } }, 'Nothing here yet — drop some images above.'),
    ...list.map((a) => h('div.asset-card', {},
      h('a.preview', { href: `${a.path}?v=${Math.round(a.mtime)}`, target: '_blank', title: 'Open full size' },
        h('img', { src: `${a.path}?v=${Math.round(a.mtime)}`, alt: a.name, loading: 'lazy' })),
      h('div.meta', {},
        h('div.fname', {}, a.name),
        h('div.muted', {}, `${kb(a.size)}${a.usedBy ? ` · used ${a.usedBy}×` : ''}`),
        h('div.row', {},
          h('button.small', { title: 'Copy path for JSON definitions', onclick: () => copyText(a.path) }, 'Copy path'),
          h('button.small.danger', {
            onclick: async () => {
              const warn = a.usedBy ? `\n\nIt is used by ${a.usedBy} scene template(s)/definition(s); those will show a missing image.` : '';
              if (!confirm(`Delete ${a.name}?${warn}`)) return;
              await api('DELETE', `/api/assets/${folder}/${encodeURIComponent(a.name)}`);
              toast(`Deleted ${a.name}`);
              load();
            },
          }, 'Delete'))))));
}

async function upload(fileList) {
  const status = $('#upload-status');
  const target = folder;
  for (const file of fileList) {
    const line = status.appendChild(h('div', {}, `⏳ ${file.name}…`));
    const send = (overwrite) => fetch(`${API_BASE}/api/assets/${target}?name=${encodeURIComponent(file.name)}${overwrite ? '&overwrite=1' : ''}`, {
      method: 'POST', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' },
    });
    try {
      let res = await send(false);
      if (res.status === 409 && confirm(`${file.name} already exists in ${target}. Replace it?`)) res = await send(true);
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) { line.className = 'muted'; line.textContent = `↷ ${file.name} — skipped (already exists)`; continue; }
      if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
      line.className = 'ok';
      line.textContent = `✓ ${data.path}${data.replaced ? ' (replaced)' : ''}`;
    } catch (err) {
      line.className = 'err';
      line.textContent = `✕ ${file.name} — ${err.message}`;
    }
  }
  load();
}

const dz = $('#dropzone');
$('#file-input').addEventListener('change', (e) => { upload([...e.target.files]); e.target.value = ''; });
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('over'));
dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); upload([...e.dataTransfer.files]); });
// Dropping anywhere on the page counts too.
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => { if (!dz.contains(e.target)) { e.preventDefault(); upload([...e.dataTransfer.files]); } });

load();
