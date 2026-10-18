import { $, $$, h, api, toast, copyText } from './common.js';

const me = await api('GET', '/api/me');
if (!me.dm) location.href = '/dm/login';

const joinUrl = (token) => `${location.origin}/g/${token}`;

function showTab(name) {
  for (const b of $$('.tabs button')) b.classList.toggle('active', b.dataset.tab === name);
  $('#tab-games').classList.toggle('hidden', name !== 'games');
  $('#tab-scenes').classList.toggle('hidden', name !== 'scenes');
  history.replaceState(null, '', `#${name}`);
  if (name === 'games') loadGames(); else loadScenes();
}
for (const b of $$('.tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));

async function loadGames() {
  const games = await api('GET', '/api/games');
  const list = $('#games');
  list.replaceChildren();
  if (!games.length) list.append(h('div.empty-note', {}, 'No games yet. Create one above, then share the player link.'));
  for (const g of games) {
    const bits = [`${g.players} player${g.players === 1 ? '' : 's'}`, `${g.scenes} scene${g.scenes === 1 ? '' : 's'}`];
    if (g.activeScene) bits.push(`▶ ${g.activeScene}`);
    if (g.combat) bits.push('⚔️ in combat');
    list.append(h('div.list-item', {},
      h('div.grow', {}, h('div.name', {}, g.name), h('div.muted', {}, bits.join(' · '))),
      h('button.small', { onclick: () => copyText(joinUrl(g.joinToken)) }, '🔗 Copy player link'),
      h('a.btn.primary', { href: `/dm/games/${g.id}` }, 'Open'),
      h('button.small.danger', {
        onclick: async () => {
          if (!confirm(`Delete "${g.name}"? Its players, chat and live state will be lost. Scene templates are kept.`)) return;
          await api('DELETE', `/api/games/${g.id}`);
          toast('Game deleted');
          loadGames();
        },
      }, 'Delete')));
  }
}

async function loadScenes() {
  const scenes = await api('GET', '/api/scenes');
  const list = $('#scenes');
  list.replaceChildren();
  if (!scenes.length) list.append(h('div.empty-note', {}, 'No scenes yet. Build your first map template.'));
  for (const s of scenes) {
    list.append(h('div.list-item', {},
      s.background ? h('img.thumb', { src: s.background, alt: '' }) : h('div.thumb'),
      h('div.grow', {}, h('div.name', {}, s.name), h('div.muted', {}, `Edited ${new Date(s.updatedAt).toLocaleString()}`)),
      h('a.btn.primary', { href: `/dm/scenes/${s.id}` }, 'Edit'),
      h('button.small', {
        onclick: async () => {
          const full = await api('GET', `/api/scenes/${s.id}`);
          await api('POST', '/api/scenes', { ...full.data, name: `${full.name} copy` });
          loadScenes();
        },
      }, 'Duplicate'),
      h('button.small.danger', {
        onclick: async () => {
          if (!confirm(`Delete scene template "${s.name}"? Games that already use it keep their copies.`)) return;
          await api('DELETE', `/api/scenes/${s.id}`);
          loadScenes();
        },
      }, 'Delete')));
  }
}

$('#new-game').addEventListener('submit', async (e) => {
  e.preventDefault();
  const g = await api('POST', '/api/games', { name: $('#new-game-name').value });
  $('#new-game-name').value = '';
  toast(`Created "${g.name}"`);
  loadGames();
});

$('#new-scene').addEventListener('click', async () => {
  const s = await api('POST', '/api/scenes', {
    name: 'New scene', background: null, grid: { cols: 20, rows: 14, cellSize: 64 },
  });
  location.href = `/dm/scenes/${s.id}`;
});

$('#logout').addEventListener('click', async () => {
  await api('POST', '/api/logout');
  location.href = '/dm/login';
});

// Global role strength (presets 1–5).
async function loadSettings() {
  const s = await api('GET', '/api/settings');
  const sel = $('#role-strength');
  sel.replaceChildren(...s.options.map((o) => h('option', { value: o.value, selected: o.value === s.roleStrength }, o.label)));
}
$('#role-strength').addEventListener('change', async (e) => {
  try {
    const s = await api('PUT', '/api/settings', { roleStrength: Number(e.target.value) });
    toast(`Role strength set to ${s.roleStrength}`);
  } catch (err) {
    toast(err.message, 'error');
    loadSettings();
  }
});
loadSettings();

showTab(location.hash === '#scenes' ? 'scenes' : 'games');
