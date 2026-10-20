import { $, $$, h, api, toast, copyText } from './common.js';
import { openReader } from './handouts.js';

const me = await api('GET', '/api/me');
if (!me.dm) location.href = '/dm/login';

const joinUrl = (token) => `${location.origin}/g/${token}`;

const TABS = { games: () => { loadGames(); loadAdventures(); }, scenes: () => loadScenes(), handouts: () => loadHandouts() };

function showTab(name) {
  for (const b of $$('.tabs button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const t of Object.keys(TABS)) $(`#tab-${t}`).classList.toggle('hidden', name !== t);
  history.replaceState(null, '', `#${name}`);
  TABS[name]();
}

const builtInTag = () => h('span.tag.builtin', { title: 'Ships with One & Done (edited in git). Duplicate it to make your own copy.' }, 'Built-in');

// Built-in adventures: a ready-to-run game (scenes and handouts already added).
async function loadAdventures() {
  const advs = await api('GET', '/api/adventures');
  const bar = $('#adventures');
  if (!advs.length) return bar.replaceChildren();
  const pick = h('select', {}, ...advs.map((a) => h('option', { value: a.id }, a.name)));
  const about = h('span.muted.grow');
  const describe = () => {
    const a = advs.find((x) => x.id === pick.value);
    about.textContent = a ? `${a.description ? `${a.description} · ` : ''}${a.scenes} scene${a.scenes === 1 ? '' : 's'}, ${a.handouts} handout${a.handouts === 1 ? '' : 's'}` : '';
  };
  pick.addEventListener('change', describe);
  describe();
  bar.replaceChildren(
    h('span.adventure-label', {}, '📖 New game from adventure'), pick, about,
    h('button', {
      title: 'Read this adventure\'s handouts, with DM notes',
      onclick: async () => {
        const a = advs.find((x) => x.id === pick.value);
        try {
          const list = await api('GET', `/api/adventures/${encodeURIComponent(pick.value)}/handouts`);
          openReader(list, {
            showDmNotes: true,
            emptyText: `${a?.name ?? 'This adventure'} has no handouts.`,
            status: (ho) => (ho.scenes.length ? `📍 ${ho.scenes.join(', ')}` : 'Not tied to a scene'),
          });
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    }, '📜 Handouts'),
    h('button.primary', {
      onclick: async () => {
        try {
          const g = await api('POST', '/api/games', { adventureId: pick.value });
          toast(`Created "${g.name}"`);
          loadGames();
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    }, 'Create'));
}
for (const b of $$('.tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));

async function loadGames() {
  const games = await api('GET', '/api/games');
  const list = $('#games');
  list.replaceChildren();
  if (!games.length) list.append(h('div.empty-note', {}, 'No games yet. Create one above, then share the player link.'));
  for (const g of games) {
    const bits = [`${g.players} player${g.players === 1 ? '' : 's'}`, `${g.scenes} scene${g.scenes === 1 ? '' : 's'}`];
    if (g.handouts) bits.push(`${g.handouts} handout${g.handouts === 1 ? '' : 's'}`);
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
      h('div.grow', {}, h('div.name', {}, s.name, s.builtIn ? builtInTag() : null),
        h('div.muted', {}, s.builtIn ? 'Ships with One & Done' : `Edited ${new Date(s.updatedAt).toLocaleString()}`)),
      s.builtIn ? null : h('a.btn.primary', { href: `/dm/scenes/${s.id}` }, 'Edit'),
      h('button.small', {
        onclick: async () => {
          const full = await api('GET', `/api/scenes/${s.id}`);
          await api('POST', '/api/scenes', { ...full.data, name: `${full.name} copy` });
          loadScenes();
        },
      }, 'Duplicate'),
      s.builtIn ? null : h('button.small.danger', {
        onclick: async () => {
          if (!confirm(`Delete scene template "${s.name}"? Games that already use it keep their copies.`)) return;
          await api('DELETE', `/api/scenes/${s.id}`);
          loadScenes();
        },
      }, 'Delete')));
  }
}

async function loadHandouts() {
  const list = $('#handouts');
  const items = await api('GET', '/api/handouts');
  list.replaceChildren();
  if (!items.length) list.append(h('div.empty-note', {}, 'No handouts yet. Write a letter, a clue or a map for your players.'));
  for (const ho of items) {
    list.append(h('div.list-item', {},
      ho.image ? h('img.thumb', { src: ho.image, alt: '' }) : h('div.thumb.text-thumb', {}, '📜'),
      h('div.grow', {}, h('div.name', {}, ho.title, ho.builtIn ? builtInTag() : null),
        h('div.muted', {}, [ho.image ? 'Image' : null, ho.hasText ? 'Text' : null].filter(Boolean).join(' + '),
          ho.builtIn ? ' · Ships with One & Done' : ` · Edited ${new Date(ho.updatedAt).toLocaleString()}`)),
      h('a.btn.primary', { href: `/dm/handouts/${encodeURIComponent(ho.id)}` }, ho.builtIn ? 'View' : 'Edit'),
      h('button.small', {
        onclick: async () => {
          const full = await api('GET', `/api/handouts/${encodeURIComponent(ho.id)}`);
          await api('POST', '/api/handouts', { ...full.data, title: `${full.title} copy` });
          loadHandouts();
        },
      }, 'Duplicate'),
      ho.builtIn ? null : h('button.small.danger', {
        onclick: async () => {
          if (!confirm(`Delete handout "${ho.title}"? Games that already have it keep their copies.`)) return;
          await api('DELETE', `/api/handouts/${ho.id}`);
          loadHandouts();
        },
      }, 'Delete')));
  }
}

$('#new-handout').addEventListener('click', async () => {
  const ho = await api('POST', '/api/handouts', { title: 'New handout', text: 'Write your handout here.' });
  location.href = `/dm/handouts/${ho.id}`;
});

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

showTab(TABS[location.hash.slice(1)] ? location.hash.slice(1) : 'games');
