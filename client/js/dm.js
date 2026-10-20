import { connect } from './transport.js';
import { $, fill, $$, h, api, toast, sendCmd, sendPing, sendChat, popupMenu, closeMenu, combatBar, copyText, PLAYER_COLORS, ROLE_LABELS } from './common.js';
import { Board } from './board.js';
import { GameFeed } from './panel.js';
import { startAbility, abilitySummary, distance } from './abilities.js';
import { createPredictor } from './predict.js';
import { openReader, pickImage } from './handouts.js';

const gameId = location.pathname.split('/').pop();
const me = await api('GET', '/api/me');
if (!me.dm) location.href = `/dm/login?next=${encodeURIComponent(location.pathname)}`;
let content = await api('GET', '/api/content');
let heroById = new Map(content.characters.map((c) => [c.id, c]));

let state = null; // what the screen shows: the server's state plus predictions for commands in flight
let serverState = null;
const predictor = createPredictor({ onChange: () => { if (serverState) { state = predictor.view(serverState); render(); } } });
let selectedId = null;
let mode = null; // {type:'place', kind, def, scope} | {type:'target'|'cell', label, range, origin, ...}
let spawnScope = 'scene';
let templates = [];
let library = []; // the handout library (for "Add from library")

const socket = connect('/dm', { gameId });
const send = (cmd) => sendCmd(socket, cmd);
const panel = new GameFeed($('#panel'), {
  onSend: (text) => sendChat(socket, text),
});
const bar = combatBar($('#combat-bar'));

socket.on('state', (s) => {
  serverState = s;
  predictor.onState();
  state = predictor.view(s);
  render();
});
socket.on('history', (hist) => panel.setHistory(hist));
socket.on('feed', (rows) => panel.add(rows));
socket.on('fx', (list) => { for (const f of list) board.showFx(f.entityId, f.text, f.color, f.kind); });
socket.on('ping', (p) => board.showPing(p));
// Definitions or art changed (Data/Assets pages): refresh the banks and hero names.
socket.on('contentChanged', async () => {
  content = await api('GET', '/api/content');
  heroById = new Map(content.characters.map((c) => [c.id, c]));
  memoKeys.banks = memoKeys.players = null;
  loadTemplates();
  loadLibrary();
  if (state) render();
});
socket.on('fatal', (msg) => { toast(msg, 'error'); setTimeout(() => { location.href = '/dm'; }, 1500); });
socket.on('connect_error', (err) => {
  if (err.message === 'unauthorized') location.href = `/dm/login?next=${encodeURIComponent(location.pathname)}`;
  else toast('Connection problem — retrying…', 'error');
});

// ---------- helpers ----------

const activeScene = () => (state.activeSceneId ? state.scenes[state.activeSceneId] : null);
const sceneEntities = () => Object.values(state.entities).filter((e) => e.scope === 'game' || e.sceneId === state.activeSceneId);
const playerOf = (e) => state.players.find((p) => p.id === e.ownerPlayerId);
const selected = () => (selectedId ? state.entities[selectedId] : null);

const isEnemy = (e) => e.kind === 'monster' || (e.kind === 'npc' && e.hostile);
// Server-computed allowances (include granted actions, action reductions, slows, snares).
const allowanceOf = (e) => e.allowance?.actions ?? (e.actionsPerPhase ?? 1);
// NPCs and monsters have a per-phase action budget the DM spends for them: enemies in the DM
// PHASE, friendly NPCs in the PLAYER PHASE (the server enforces the same rules).
const actsIn = (e) => (isEnemy(e) ? 'dm' : 'player');
// Actions an NPC or monster has left this phase, or null if no budget applies (heroes, objects).
function npcActionsLeft(e) {
  if (!state.combat.active || (e.kind !== 'npc' && e.kind !== 'monster')) return null;
  return Math.max(0, allowanceOf(e) - (state.turn[e.id]?.actions ?? 0));
}
// Token view of an entity for the board (positions on the active scene).
const view = (e) => (e ? { ...e, position: e.positions[state.activeSceneId] } : e);

function tokenFor(e) {
  const p = playerOf(e);
  return {
    id: e.id, kind: e.kind, name: e.name, image: e.image, size: e.size, position: e.positions[state.activeSceneId],
    z: e.z, hp: e.hp, maxHp: e.maxHp, status: e.status, icon: e.icon,
    immortal: e.immortal, damageTaken: e.damageTaken, hits: e.hits,
    effects: (e.effects ?? []).map((fx) => ({ icon: fx.icon, label: fx.label, source: fx.source?.name })),
    actionsLeft: state.combat.phase === actsIn(e) && e.status === 'active' && !e.immortal ? npcActionsLeft(e) : null,
    color: p ? p.color : e.kind === 'object' ? 'transparent' : e.kind === 'monster' || e.hostile ? '#8a2f2f' : '#d4af37',
  };
}

function setMode(m) {
  mode = m;
  closeMenu();
  renderBoard();
}
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { setMode(null); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.target.closest('input')) { e.preventDefault(); undo(); }
});

// ---------- board ----------

const board = new Board($('#board'), {
  // Press and hold to ping. Errors (the players' 10-per-minute limit) show as a toast.
  onPing: (p) => sendPing(socket, p),
  canDrag: () => !mode,
  // Shift-drag force-moves (skips movement budgets and frightened restrictions).
  // The dropped token shows on its new square at once (the server confirms or reverts it).
  onTokenDrop: (t, x, y, e) => {
    const sceneId = state.activeSceneId;
    predictor.run(() => send({ type: 'move', entityId: t.id, x, y, force: !!e?.shiftKey }), (s) => {
      s.entities[t.id].positions[sceneId] = { x, y };
    });
  },
  onCellClick: (cell, e) => {
    if (mode?.type === 'place') return place(cell, e);
    if (mode?.type === 'cell') { const m = mode; setMode(null); return m.onCell(cell); }
    if (mode) return;
    select(null);
  },
  onTokenClick: (t, e, stack) => {
    if (mode?.type === 'place') return place(board.cellAt(e.clientX, e.clientY), e);
    if (mode?.type === 'cell') { const m = mode; setMode(null); return m.onCell(board.cellAt(e.clientX, e.clientY)); }
    if (mode?.type === 'target') {
      const m = mode;
      const origin = view(state.entities[m.origin.id]) ?? m.origin;
      const candidates = stack.filter((s) => m.filter(s) && distance(origin, s) <= m.range);
      const pick = (target) => { setMode(null); m.onTarget(target); };
      if (candidates.length > 1) return popupMenu(e.clientX, e.clientY, 'Which target?', candidates.map((s) => ({ label: s.name, onClick: () => pick(s) })));
      if (!candidates[0]) return toast('Not a valid target (or out of range)', 'error');
      return pick(candidates[0]);
    }
    // Stack inspector: tokens underneath the top one are reachable here.
    if (stack.length > 1) {
      return popupMenu(e.clientX, e.clientY, `Stack (${stack.length}) — top first`, stack.map((s) => ({
        label: `${s.id === selectedId ? '● ' : ''}${s.name}`,
        sub: `${s.kind.toUpperCase()} · ${s.immortal ? `Σ ${s.damageTaken} dmg` : `${s.hp ?? '?'}/${s.maxHp ?? '?'} HP`}${s.status !== 'active' ? ` · ${s.status.toUpperCase()}` : ''}`,
        onClick: () => select(s.id),
      })));
    }
    select(t.id);
  },
});

function place(cell, e) {
  if (!cell) return;
  const m = mode;
  if (!e.shiftKey) setMode(null);
  send({ type: 'entity.spawn', kind: m.kind, defId: m.def.id, scope: m.scope, x: cell.x, y: cell.y })
    .then((r) => { if (r?.entityId) select(r.entityId); });
}

function select(id) {
  selectedId = id;
  renderBoard();
  memoKeys.inspector = null;
  renderInspector();
}

function cellsWithin(scene, origin, range) {
  const cells = [];
  const pos = origin.positions?.[scene.id] ?? origin.position;
  if (!pos) return cells;
  for (let y = 0; y < scene.grid.rows; y++) for (let x = 0; x < scene.grid.cols; x++) {
    const dx = Math.max(0, x - (pos.x + origin.size.w - 1), pos.x - x), dy = Math.max(0, y - (pos.y + origin.size.h - 1), pos.y - y);
    if (Math.max(dx, dy) <= range) cells.push({ x, y });
  }
  return cells;
}

function renderBoard() {
  const scene = activeScene();
  if (!scene) {
    board.showEmpty(Object.keys(state.scenes).length ? 'No active scene — pick one on the left (players are waiting).' : 'Add a scene from your library to get started.');
    return;
  }
  board.showEmpty('');
  board.setScene(scene);
  const v = { selectedId, showStacks: true };
  const tokens = sceneEntities().map(tokenFor);
  if (mode?.type === 'target') {
    const origin = view(state.entities[mode.origin.id]) ?? mode.origin;
    v.targetIds = new Set(tokens.filter((t) => mode.filter(t) && distance(origin, t) <= mode.range).map((t) => t.id));
    board.highlight(Number.isFinite(mode.range) ? cellsWithin(scene, origin, mode.range) : [], 'range');
  } else if (mode?.type === 'cell') {
    board.highlight(cellsWithin(scene, state.entities[mode.origin.id] ?? mode.origin, mode.range), 'move');
  } else board.highlight([]);
  board.setTokens(tokens, v);
  $('.mode-banner')?.remove();
  if (mode) {
    const label = mode.type === 'place' ? `Click the map to place ${mode.def.name} (${mode.scope} scope). Shift-click to place several.` : mode.label;
    $('#board').append(h('div.mode-banner', {}, label,
      mode.onDone ? h('button.small.primary', { onclick: () => { const m = mode; setMode(null); m.onDone(); } }, 'Done') : null,
      h('button.small', { onclick: () => setMode(null) }, 'Cancel (Esc)')));
  }
}

// ---------- top bar ----------

// "Who has gone" counter (computed by the server): party in the PLAYER PHASE, enemies in the DM
// PHASE. Click to list who still has actions, and click a name to open its inspector.
function turnsBadge() {
  const tp = state.turnProgress;
  if (!tp || !tp.total) return null;
  const label = tp.side === 'party' ? 'Party' : 'Enemies';
  const all = tp.done === tp.total;
  const left = tp.pending.map((p) => `${p.name} (${p.left} left)`).join(', ');
  return h(`button.turns-badge${all ? '.all-done' : ''}`, {
    title: all ? 'Everyone has gone' : `Still to go: ${left}`,
    onclick: (e) => popupMenu(e.clientX, e.clientY + 12, all ? 'Everyone has gone' : 'Still to go', all
      ? [{ label: 'Ready for the next phase', disabled: true }]
      : tp.pending.map((p) => ({ label: p.name, sub: `${p.left} action${p.left > 1 ? 's' : ''} left`, onClick: () => select(p.id) }))),
  }, `${all ? '✓' : '⏳'} ${label} ${tp.done}/${tp.total} done`);
}

function renderTop() {
  $('#game-name').textContent = state.name;
  bar.update(state.combat, state.serverNow);
  const c = state.combat;
  const timer = h('select', {
    title: 'Phase timer',
    onchange: async (e) => {
      let v = e.target.value;
      if (v === 'custom') {
        v = prompt('Seconds per phase (0 = off):', String(c.timerSeconds || 45));
        if (v === null) return renderTop();
      }
      send({ type: 'combat.setTimer', seconds: Number(v) });
    },
  }, ...[[0, '⏱ Off'], [30, '⏱ 30s'], [60, '⏱ 60s'], [90, '⏱ 90s'], [120, '⏱ 120s']].map(([v, l]) => h('option', { value: v, selected: c.timerSeconds === v }, l)),
  ![0, 30, 60, 90, 120].includes(c.timerSeconds) ? h('option', { value: c.timerSeconds, selected: true }, `⏱ ${c.timerSeconds}s`) : null,
  h('option', { value: 'custom' }, 'Custom…'));
  fill($('#combat-controls'), 
    timer,
    c.active
      ? h('button.gold', { onclick: () => send({ type: 'combat.advance' }) }, c.phase === 'player' ? '▶ DM Phase' : '▶ Player Phase')
      : h('button.primary', { onclick: () => send({ type: 'combat.start' }), disabled: !activeScene() }, '⚔️ Start combat'),
    c.active ? h('button.danger', { onclick: () => send({ type: 'combat.end' }) }, 'End combat') : null,
    turnsBadge(),
    state.pendingChecks?.length ? h('button.checks-badge', { onclick: (e) => checksMenu(e), title: 'Abilities waiting for your call' }, `⚖ ${state.pendingChecks.length} check${state.pendingChecks.length > 1 ? 's' : ''}`) : null,
  );
  const u = $('#undo');
  u.disabled = !state.undo;
  u.textContent = state.undo ? `↶ Undo ${state.undo}` : '↶ Undo';
}

$('#copy-link').addEventListener('click', () => copyText(`${location.origin}/g/${state.joinToken}`));
$('#undo').addEventListener('click', undo);
$('#game-name').addEventListener('dblclick', () => {
  const name = prompt('Game name', state.name);
  if (name) send({ type: 'dm.renameGame', name });
});
// Pending DM checks (e.g. Intimidating Roar): the DM decides success or failure.
function checksMenu(e) {
  const items = [];
  for (const chk of state.pendingChecks) {
    items.push({ heading: `${chk.casterName} — ${chk.abilityName} vs ${chk.subjectName}: rolled ${chk.total} (${chk.roll})` });
    items.push({ label: '✓ Success', onClick: () => send({ type: 'check.resolve', checkId: chk.id, success: true }) });
    items.push({ label: '✗ Failure', onClick: () => send({ type: 'check.resolve', checkId: chk.id, success: false }) });
  }
  popupMenu(e.clientX - 200, e.clientY + 16, 'Your call', items);
}

function undo() {
  if (state?.undo) send({ type: 'undo' }).then((r) => r && toast(`Undid ${r.undone}`));
}

// ---------- sidebar ----------

for (const b of $$('.side-tabs button')) {
  b.addEventListener('click', () => {
    for (const o of $$('.side-tabs button')) o.classList.toggle('active', o === b);
    for (const t of ['scenes', 'players', 'banks', 'handouts']) $(`#tab-${t}`).classList.toggle('hidden', t !== b.dataset.tab);
    if (b.dataset.tab === 'scenes') loadTemplates();
    if (b.dataset.tab === 'handouts') loadLibrary();
  });
}

async function loadTemplates() {
  templates = await api('GET', '/api/scenes');
  if (state) renderScenes();
}

async function loadLibrary() {
  library = await api('GET', '/api/handouts');
  if (state) renderHandouts();
}

// ---------- handouts ----------

const gameHandouts = () => state.handoutOrder.map((id) => state.handouts[id]).filter(Boolean);
const tiedToActive = (ho) => !!state.activeSceneId && !!ho.sceneIds?.includes(state.activeSceneId);
let reader = null;

// The DM's handout viewer: the active scene's handouts first, DM notes, and Reveal / Hide.
function openHandouts(startId = null) {
  reader = openReader(gameHandouts(), {
    startId, showDmNotes: true,
    forScene: tiedToActive,
    sceneName: () => activeScene()?.name ?? null,
    emptyText: 'No handouts in this game yet. Add some from the Handouts tab.',
    actions: (ho) => (ho.revealed
      ? h('button.small', { onclick: () => send({ type: 'handout.hide', handoutId: ho.id }) }, 'Hide')
      : h('button.small.primary', { onclick: () => send({ type: 'handout.reveal', handoutId: ho.id }) }, 'Reveal to players')),
  });
}
$('#handouts-top').addEventListener('click', () => openHandouts());

// Checklist of the game's scenes; Save ties the handout to the ticked ones (handout.setScenes).
function editHandoutScenes(e, ho) {
  if (!state.sceneOrder.length) return toast('Add a scene to this game first');
  const boxes = state.sceneOrder.map((sid) => ({ sid, box: h('input', { type: 'checkbox', checked: !!ho.sceneIds?.includes(sid) }) }));
  popupMenu(e.clientX, e.clientY + 12, 'Show with scenes', [
    { heading: `"${ho.title}" is grouped under these scenes in the handout viewers` },
    ...boxes.map(({ sid, box }) => ({ node: h('label.next-choice', {}, box, ' ', state.scenes[sid].name) })),
    {
      node: h('div.row.next-actions', {},
        h('button.small', { onclick: () => closeMenu() }, 'Cancel'),
        h('button.small.primary', {
          onclick: () => {
            closeMenu();
            send({ type: 'handout.setScenes', handoutId: ho.id, sceneIds: boxes.filter((b) => b.box.checked).map((b) => b.sid) });
          },
        }, 'Save')),
    },
  ]);
}

function renderHandouts() {
  const list = gameHandouts();
  if (reader?.open) reader.refresh(list);
  const pick = h('select.grow', {}, ...library.map((ho) => h('option', { value: ho.id }, `${ho.title}${ho.builtIn ? ' (built-in)' : ''}`)));
  const row = (ho) => h(`div.scene-item.handout-item${ho.revealed ? '.active' : ''}`, {},
    h('span.name', { title: ho.revealed ? 'Players can read this' : 'Hidden from players' }, `${ho.revealed ? '👁 ' : ''}${ho.title}`),
    ho.revealed
      ? h('button.small', { title: 'Hide from players', onclick: () => send({ type: 'handout.hide', handoutId: ho.id }) }, 'Hide')
      : h('button.small.primary', { title: 'Show to every player', onclick: () => send({ type: 'handout.reveal', handoutId: ho.id }) }, 'Reveal'),
    h('button.small', { title: 'Read it as players see it, plus your DM notes', onclick: () => openHandouts(ho.id) }, '👁'),
    h('button.small', { title: 'Show with scenes…', onclick: (e) => editHandoutScenes(e, ho) }, '📍'),
    h('button.small', { title: 'Edit this game\'s copy', onclick: () => editHandout(ho) }, '✎'),
    h('button.small.danger', {
      title: 'Remove from game',
      onclick: () => confirm(`Remove "${ho.title}" from this game? The library copy is kept.`) && send({ type: 'handout.remove', handoutId: ho.id }),
    }, '✕'),
    ho.sceneIds?.length ? h('div.handout-scenes', {}, `📍 ${ho.sceneIds.map((sid) => state.scenes[sid]?.name ?? '?').join(', ')}`) : null);
  const here = list.filter(tiedToActive);
  const rest = list.filter((ho) => !tiedToActive(ho));
  fill($('#tab-handouts'),
    ...(here.length ? [h('div.section-title', {}, `📍 ${activeScene().name}`), ...here.map(row)] : []),
    h('div.section-title', {}, here.length ? 'Other handouts' : 'Handouts in this game'),
    ...(rest.length ? rest.map(row) : [h('p.muted', {}, list.length ? 'None.' : 'No handouts yet.')]),
    h('div.section-title', {}, 'Add from library'),
    library.length
      ? h('div.row', {}, pick, h('button.primary.small', { onclick: () => send({ type: 'handout.add', handoutId: pick.value }) }, 'Add'))
      : h('p.muted', {}, 'Your handout library is empty. ', h('a', { href: '/dm#handouts' }, 'Write a handout'), ' first.'),
    h('button.small', { style: { marginTop: '8px' }, onclick: () => editHandout(null) }, '+ Quick note'),
    h('p.muted', { style: { fontSize: '12px' } }, 'Each added handout is this game\'s own copy. Players see only what you reveal, never DM notes.'));
}

let assetPaths = null;
// Edit a game's handout (or write a new one when ho is null) in a small form.
async function editHandout(ho) {
  closeMenu();
  let image = ho?.image ?? null;
  const title = h('input', { value: ho?.title ?? '', maxLength: 80, placeholder: 'Title' });
  const text = h('textarea', { rows: 10, placeholder: 'Markdown text' });
  text.value = ho?.text ?? '';
  const notes = h('textarea', { rows: 3, placeholder: 'Secrets, reminders, when to reveal it…' });
  notes.value = ho?.dmNotes ?? '';
  const cover = h('div.row');
  const drawCover = () => fill(cover,
    image ? h('img.cover-thumb', { src: image, alt: '' }) : h('span.muted', {}, 'No cover image'),
    h('button.small', {
      onclick: async () => {
        assetPaths ??= await api('GET', '/api/assets');
        const p = await pickImage(assetPaths, { title: 'Cover image' });
        if (p) { image = p; drawCover(); }
      },
    }, image ? 'Change' : 'Pick image'),
    image ? h('button.small', { onclick: () => { image = null; drawCover(); } }, 'Remove') : null);
  drawCover();
  // A new quick note is tied to the scene you're in by default.
  const tie = !ho && activeScene() ? h('input', { type: 'checkbox', checked: true }) : null;
  const close = () => backdrop.remove();
  const save = async () => {
    const fields = { title: title.value, text: text.value, image, dmNotes: notes.value };
    if (tie) fields.sceneIds = tie.checked ? [state.activeSceneId] : [];
    const r = await send(ho ? { type: 'handout.update', handoutId: ho.id, ...fields } : { type: 'handout.create', ...fields });
    if (r) close();
  };
  const card = h('div.modal.handout-form', { role: 'dialog', 'aria-modal': 'true' },
    h('div.modal-title', {}, ho ? 'Edit handout' : 'Quick note'),
    title, h('div.section-title', {}, 'Cover image'), cover, h('div.section-title', {}, 'Text'), text,
    h('div.section-title', {}, 'DM notes (never shown to players)'), notes,
    tie ? h('label.next-choice', {}, tie, ` Show with ${activeScene().name}`) : null,
    h('div.modal-actions', {}, h('button.small', { onclick: close }, 'Cancel'), h('button.small.primary', { onclick: save }, 'Save')));
  const backdrop = h('div.modal-backdrop', { onclick: (e) => { if (e.target === backdrop) close(); } }, card);
  document.body.append(backdrop);
  title.focus();
}

// Scenes: with an active scene that has branching links, the list is grouped as Current / Next /
// Other scenes so the likely next stops stand out. Links are a visual aid only: every scene can
// still be activated.
function renderScenes() {
  const root = $('#tab-scenes');
  const pick = h('select.grow', {}, ...templates.map((t) => h('option', { value: t.id }, t.name)));
  const nameOf = (id) => state.scenes[id]?.name ?? '?';
  const activeId = state.activeSceneId;
  const nextIds = (activeId && state.scenes[activeId]?.next) || [];
  const cameFrom = activeId ? state.sceneOrder.filter((sid) => state.scenes[sid].next?.includes(activeId)) : [];

  const row = (sid, kind = '') => {
    const s = state.scenes[sid];
    const active = sid === activeId;
    const count = Object.values(state.entities).filter((e) => e.scope === 'scene' && e.sceneId === sid).length;
    const links = [
      s.next?.length ? `→ ${s.next.map(nameOf).join(', ')}` : null,
      active && cameFrom.length ? `← from ${cameFrom.map(nameOf).join(', ')}` : null,
    ].filter(Boolean);
    return h(`div.scene-item${active ? '.active' : ''}${kind ? `.${kind}` : ''}`, {},
      h('span.name', { title: s.name }, `${active ? '▶ ' : ''}${s.name}`),
      h('span.muted', { title: 'Scene-scoped creatures' }, `${count}🐾`),
      active ? null : h('button.small.primary', { onclick: () => send({ type: 'scene.activate', sceneId: sid }) }, kind === 'next' ? 'Go →' : 'Go'),
      h('button.small', { title: 'Next scenes… (which scenes this one leads to)', onclick: (e) => editNext(e, sid) }, '⇢'),
      h('button.small', {
        title: 'Rename', onclick: () => { const n = prompt('Scene name', s.name); if (n) send({ type: 'scene.rename', sceneId: sid, name: n }); },
      }, '✎'),
      h('button.small.danger', {
        title: 'Remove from game',
        onclick: () => confirm(`Remove "${s.name}" from this game? Its scene-scoped creatures go with it. The template is kept.`) && send({ type: 'scene.remove', sceneId: sid }),
      }, '✕'),
      links.length ? h('div.scene-links', {}, ...links.map((l) => h('div', {}, l))) : null);
  };

  let list;
  if (!state.sceneOrder.length) {
    list = [h('div.section-title', {}, 'Scenes in this game'), h('p.muted', {}, 'No scenes yet.')];
  } else if (nextIds.length) {
    const others = state.sceneOrder.filter((sid) => sid !== activeId && !nextIds.includes(sid));
    list = [
      h('div.section-title', {}, 'Current'), row(activeId),
      h('div.section-title', {}, 'Next'), ...nextIds.map((sid) => row(sid, 'next')),
      ...(others.length ? [h('div.section-title', {}, 'Other scenes'), ...others.map((sid) => row(sid, 'dim'))] : []),
    ];
  } else {
    list = [h('div.section-title', {}, 'Scenes in this game'), ...state.sceneOrder.map((sid) => row(sid))];
  }

  fill(root,
    ...list,
    activeId ? h('button.small', { onclick: () => send({ type: 'scene.activate', sceneId: null }) }, 'Clear active scene') : null,
    h('div.section-title', {}, 'Add from library'),
    templates.length
      ? h('div.row', {}, pick, h('button.primary.small', { onclick: () => send({ type: 'scene.add', templateId: pick.value }) }, 'Add'))
      : h('p.muted', {}, 'Your scene library is empty. ', h('a', { href: '/#scenes' }, 'Build a scene'), ' first.'),
    h('p.muted', { style: { fontSize: '12px' } }, 'Each added scene is an independent live copy. Map layout is edited in Scenes, not here. Use ⇢ to mark which scenes come next; they stand out while that scene is active.'),
  );
}

// Checklist of the game's other scenes; Save replaces this scene's links (scene.setNext).
// Already-linked scenes keep their order; newly ticked ones are added after them.
function editNext(e, sid) {
  const s = state.scenes[sid];
  const current = s.next ?? [];
  const others = [...current, ...state.sceneOrder.filter((id) => id !== sid && !current.includes(id))];
  if (!others.length) return toast('Add another scene to this game first');
  const boxes = others.map((id) => ({ id, box: h('input', { type: 'checkbox', checked: current.includes(id) }) }));
  const items = [
    { heading: `After "${s.name}" the party may go to…` },
    ...boxes.map(({ id, box }) => ({ node: h('label.next-choice', {}, box, ' ', state.scenes[id].name) })),
    {
      node: h('div.row.next-actions', {},
        h('button.small', { onclick: () => closeMenu() }, 'Cancel'),
        h('button.small.primary', {
          onclick: () => {
            closeMenu();
            send({ type: 'scene.setNext', sceneId: sid, next: boxes.filter((b) => b.box.checked).map((b) => b.id) });
          },
        }, 'Save')),
    },
  ];
  popupMenu(e.clientX, e.clientY + 12, 'Next scenes', items);
}

function renderPlayers() {
  const root = $('#tab-players');
  // Per-game switch (game.setOption): players may leave their hero from their ⚙ menu.
  const canLeave = h('input', { type: 'checkbox', checked: !!state.options?.playersCanLeave });
  canLeave.addEventListener('change', () => send({ type: 'game.setOption', option: 'playersCanLeave', value: canLeave.checked }));
  fill(root,
    h('label.option-row', { title: 'Players can pick a different hero from their ⚙ menu (they confirm first). You can change this any time.' },
      canLeave, h('span', {}, 'Let players leave their hero')),
    h('div.section-title', {}, `Players (${state.players.length}/10)`),
    ...(state.players.length ? state.players.map((p) => {
      const hero = p.characterId ? heroById.get(p.characterId) : null;
      return h('div.player-item', {},
        h(`span.presence.${p.presence}`, { title: p.presence }),
        h('button.swatch', {
          style: { background: p.color, width: '18px', height: '18px' }, title: 'Change color',
          onclick: (e) => popupMenu(e.clientX, e.clientY, `${p.name}'s color`, [{
            node: h('div.swatches', {}, ...PLAYER_COLORS.map((c) => h('button.swatch', {
              style: { background: c }, disabled: state.players.some((o) => o.color === c && o.id !== p.id),
              onclick: () => { send({ type: 'dm.setPlayerColor', playerId: p.id, color: c }); closeMenu(); },
            }))),
          }]),
        }),
        h('span.name', {}, h('b', { style: { color: p.color } }, p.name), h('br'), h('span.muted', {}, hero ? `${p.heroName ?? hero.name} (${ROLE_LABELS[hero.role]})` : 'choosing a hero…')),
        p.entityId ? h('button.small', { title: 'Select token', onclick: () => select(p.entityId) }, '◎') : null,
        h('button.small', {
          title: 'Reset Player / Release Character',
          disabled: !p.characterId,
          onclick: () => confirm(`Release ${p.heroName ?? hero?.name} from ${p.name}? They will pick a hero again.`) && send({ type: 'dm.resetPlayer', playerId: p.id }),
        }, 'Release'),
        h('button.small.danger', {
          title: 'Remove this seat (the old browser cannot rejoin as this player)',
          onclick: () => confirm(`Remove ${p.name} from the game?`) && send({ type: 'dm.removePlayer', playerId: p.id }),
        }, '✕'));
    }) : [h('p.muted', {}, 'Nobody has joined yet. Share the player link.')]),
    h('button.small', { onclick: () => copyText(`${location.origin}/g/${state.joinToken}`) }, '🔗 Copy player link'),
  );
}

function renderBanks() {
  const root = $('#tab-banks');
  const scopeBtn = (s, label) => h(`button.small${spawnScope === s ? '.active' : ''}`, { onclick: () => { spawnScope = s; renderBanks(); } }, label);
  const bank = (kind, defs) => defs.map((d) => h('div.bank-item', {},
    d.image ? h('img', { src: d.image, alt: '' }) : null,
    h('span.name', {}, d.name, h('br'), h('span.muted', {}, `${d.immortal ? '∞ HP (training dummy)' : `${d.maxHp} HP`} · DEF ${d.defense}${d.size ? ` · ${d.size.w}×${d.size.h}` : ''}`)),
    h('button.small.primary', {
      disabled: !activeScene(),
      onclick: () => setMode({ type: 'place', kind, def: d, scope: spawnScope }),
    }, 'Place')));
  const live = activeScene() ? sceneEntities().filter((e) => e.kind !== 'pc') : [];
  fill(root, 
    h('div.section-title', {}, 'Spawn scope'),
    h('div.row', {}, scopeBtn('scene', '📍 Scene (stays here)'), scopeBtn('game', '🧭 Game (follows party)')),
    h('div.section-title', {}, 'NPC bank'), ...bank('npc', content.npcs),
    h('div.section-title', {}, 'Monster bank'), ...bank('monster', content.monsters),
    h('div.section-title', {}, 'Live in this scene'),
    ...(live.length ? live.map((e) => h('div.bank-item', { style: { cursor: 'pointer' }, onclick: () => select(e.id) },
      h('span.name', {}, e.name, ' ', h('span.muted', {}, `${e.immortal ? `Σ ${e.damageTaken}` : e.kind === 'object' ? e.icon ?? '' : `${e.hp}/${e.maxHp}`} ${e.scope === 'game' ? '🧭' : '📍'}${e.status !== 'active' ? ` ${e.status}` : ''}${npcActionsLeft(e) !== null ? ` ⚡${npcActionsLeft(e)}` : ''}`)))) : [h('p.muted', {}, 'None')]),
  );
}

// ---------- inspector ----------

// Half-typed inspector values survive re-renders (state updates rebuild the panel). A draft is
// dropped once the underlying value changes elsewhere (e.g. the monster takes damage or is killed).
const drafts = new Map(); // `${entityId}:${field}` -> { value, base }
function draftInput(entityId, field, value, attrs = {}) {
  const key = `${entityId}:${field}`;
  const d = drafts.get(key);
  if (d && d.base !== value) drafts.delete(key);
  const input = h('input', { type: 'number', ...attrs, value: drafts.get(key)?.value ?? value });
  input.addEventListener('input', () => drafts.set(key, { value: input.value, base: value }));
  return input;
}
const clearDrafts = (entityId, ...fields) => { for (const f of fields) drafts.delete(`${entityId}:${f}`); };

// One shared hover card for ability descriptions. It's fixed-positioned so the scrolling sidebar
// can't clip it, and hidden on every inspector render since the hovered row may be replaced.
const abTip = h('div.ab-tip.hidden');
document.body.append(abTip);
const hideAbTip = () => abTip.classList.add('hidden');

function abilityLabel(ab) {
  const name = h('span.ab-name', {}, ab.name);
  if (ab.description) {
    name.classList.add('has-tip');
    name.addEventListener('mouseenter', () => {
      fill(abTip, h('strong', {}, ab.name), h('div', {}, ab.description));
      abTip.classList.remove('hidden');
      const r = name.getBoundingClientRect();
      const left = Math.min(r.left, innerWidth - abTip.offsetWidth - 8);
      const below = r.bottom + 4 + abTip.offsetHeight <= innerHeight;
      abTip.style.left = `${Math.max(8, left)}px`;
      abTip.style.top = `${below ? r.bottom + 4 : r.top - 4 - abTip.offsetHeight}px`;
    });
    name.addEventListener('mouseleave', hideAbTip);
  }
  return h('span', {}, name, ' ', h('span.muted', {}, abilitySummary(ab)));
}

function renderInspector() {
  hideAbTip();
  const root = $('#inspector');
  const e = selected();
  if (!e || !(e.scope === 'game' || e.sceneId === state.activeSceneId)) {
    root.classList.add('hidden');
    return;
  }
  root.classList.remove('hidden');
  const id = e.id;
  const mortal = !e.immortal && e.kind !== 'object';
  const amount = draftInput(e.id, 'amount', 5, { min: 0 });
  const hpInput = draftInput(e.id, 'hp', e.hp, { min: e.kind === 'monster' ? 0 : -e.maxHp });
  const maxInput = draftInput(e.id, 'max', e.maxHp, { min: 1 });
  // One Set for both fields: the server applies max HP first, so "20 / 20" works in one click.
  // Raw strings are sent so a blank box is rejected instead of becoming 0.
  const setHealth = () => {
    const cmd = { type: 'entity.setHealth', entityId: id };
    if (maxInput.value !== String(e.maxHp)) cmd.maxHp = maxInput.value;
    if (hpInput.value !== String(e.hp) || cmd.maxHp === undefined) cmd.hp = hpInput.value;
    send(cmd).then((r) => { if (r) { clearDrafts(id, 'hp', 'max'); memoKeys.inspector = null; renderInspector(); } });
  };
  for (const input of [hpInput, maxInput]) input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') setHealth(); });
  const itemInput = h('input.grow', { placeholder: 'Add item…', maxLength: 60 });
  const statusPick = h('select', {}, h('option', { value: '' }, 'Add status…'), ...['frightened', 'poisoned', 'snared', 'shaken', 'slowed'].map((st) => h('option', { value: st }, st)));
  statusPick.addEventListener('change', () => {
    const status = statusPick.value;
    if (!status) return;
    if (status !== 'frightened') return send({ type: 'effect.addStatus', entityId: id, status });
    // Frightened needs a source: pick any creature on the map.
    statusPick.value = '';
    setMode({
      type: 'target', label: `Choose who ${e.name} is frightened of`, range: Infinity, origin: e,
      filter: (t) => t.id !== id && t.kind !== 'object',
      onTarget: (t) => send({ type: 'effect.addStatus', entityId: id, status, sourceId: t.id }),
    });
  });
  const owner = playerOf(e);
  const c = state.combat;
  const turn = state.turn[id];
  const actionBlock = () => (!c.active ? null : e.status !== 'active' ? `${e.name} is ${e.status}`
    : isEnemy(e) && c.phase !== 'dm' ? 'Enemies act during the DM PHASE'
      : e.kind === 'npc' && !isEnemy(e) && c.phase !== 'player' ? 'Friendly NPCs act during the PLAYER PHASE'
        : npcActionsLeft(e) === 0 ? 'No actions left — use +1 action to override' : null);
  const stats = e.immortal
    ? `🎯 Training dummy · 🛡 DEF ${e.defense} · Σ ${e.damageTaken ?? 0} damage over ${e.hits ?? 0} hits`
    : e.kind === 'object' ? `${e.icon ?? ''} Temporary object` : `❤ ${e.hp}/${e.maxHp} · 🛡 DEF ${e.defense} · 👣 ${e.allowance?.movement ?? e.movement}`;
  fill(root,
    h('h3', {}, e.name, h('button.small', { title: 'Rename', onclick: () => { const n = prompt('Name', e.name); if (n) send({ type: 'entity.rename', entityId: id, name: n }); } }, '✎'),
      h('span.grow'), h('button.small', { onclick: () => select(null), title: 'Close' }, '✕')),
    h('div.row', {},
      h('span.tag', {}, e.kind === 'pc' ? 'player' : e.immortal ? 'training dummy' : e.kind),
      h('span.tag', {}, e.scope === 'game' ? 'game scope' : 'scene scope'),
      h('span.tag', { style: { color: e.status === 'active' ? 'var(--good)' : 'var(--bad)' } }, e.status),
      e.kind === 'npc' || e.kind === 'monster' ? h('span.tag', {}, e.hostile ? 'hostile' : 'friendly') : null,
      owner ? h('span.tag', { style: { color: owner.color } }, owner.name) : null),
    h('p', {}, stats,
      c.active && (turn || npcActionsLeft(e) !== null) && !e.immortal ? h('span.muted', {}, ` · actions ${turn?.actions ?? 0}/${allowanceOf(e)}, moved ${turn?.moved ?? 0}`) : null),
    c.active && npcActionsLeft(e) !== null && !e.immortal && e.status === 'active' ? h('p.muted', { style: { fontSize: '12px', margin: '0 0 6px' } },
      c.phase !== actsIn(e) ? (isEnemy(e) ? 'Enemies act during the DM PHASE.' : 'Friendly NPCs act during the PLAYER PHASE.')
        : `⚡ ${npcActionsLeft(e)} action(s) left this ${isEnemy(e) ? 'DM' : 'PLAYER'} PHASE.${isEnemy(e) ? ' Shift-drag to force-move.' : ''}`) : null,
    e.kind !== 'object' ? h('div.row', {}, amount,
      h('button.small.danger', { onclick: () => send({ type: 'entity.damage', entityId: id, amount: amount.value }) }, '− Damage'),
      mortal ? h('button.small', { onclick: () => send({ type: 'entity.heal', entityId: id, amount: amount.value }) }, '+ Heal') : null,
      e.immortal ? h('button.small', { onclick: () => send({ type: 'entity.resetDummy', entityId: id }) }, 'Reset counter') : null) : null,
    mortal ? h('div.row', { style: { marginTop: '6px' } },
      h('label.inline', {}, 'HP', hpInput), h('span.muted', {}, '/'), h('label.inline', {}, 'Max', maxInput),
      h('button.small', { onclick: setHealth, title: 'Applies max HP first, then HP (Enter works too)' }, 'Set')) : null,
    mortal ? h('div.row', { style: { marginTop: '6px' } },
      e.status !== 'active' ? h('button.small.primary', { onclick: () => send({ type: 'entity.revive', entityId: id }) }, '✚ Revive') : null,
      e.status !== 'dead' ? h('button.small.danger', { onclick: () => send({ type: 'entity.kill', entityId: id }) }, '☠ Kill') : null,
      e.status === 'active' && e.kind !== 'monster' ? h('button.small', { onclick: () => send({ type: 'entity.setStatus', entityId: id, status: 'down' }) }, 'Set DOWN') : null,
      c.active ? h('button.small', { onclick: () => send({ type: 'entity.grantAction', entityId: id }) }, '+1 action') : null) : null,
    e.kind === 'npc' || e.kind === 'monster' ? h('div.row', { style: { marginTop: '6px' } },
      e.scope === 'scene'
        ? h('button.small', { onclick: () => send({ type: 'entity.setScope', entityId: id, scope: 'game' }), title: 'Promote: follows the party between scenes' }, '🧭 Make game-scoped')
        : h('button.small', { onclick: () => send({ type: 'entity.setScope', entityId: id, scope: 'scene' }), title: 'Demote: stays in this scene' }, '📍 Leave in this scene'),
      e.kind === 'npc' ? h('button.small', { onclick: () => send({ type: 'entity.setHostile', entityId: id, hostile: !e.hostile }) }, e.hostile ? 'Mark friendly' : 'Mark hostile') : null) : null,
    e.kind !== 'object' ? h('div.section-title', {}, 'Effects') : null,
    e.kind !== 'object' ? h('div.effect-list', {},
      ...(e.effects?.length ? e.effects.map((fx) => h('div.effect-item', {}, h('span', {}, fx.icon), h('span.grow', {}, fx.label, fx.source?.name ? h('span.muted', {}, ` · ${fx.source.name}`) : null),
        h('button.small', { title: 'Remove effect', onclick: () => send({ type: 'effect.remove', entityId: id, effectId: fx.id }) }, '✕'))) : [h('span.muted', {}, 'None')]),
      statusPick) : null,
    e.attacks.length ? h('div.section-title', {}, c.active ? 'Attack (DM)' : 'Attacks (combat only)') : null,
    ...e.attacks.map((a) => h('div.inv-item', {},
      h('span', {}, a.name, ' ', h('span.muted', {}, `${a.attack} / ${a.damage} · r${a.range ?? 1}`)),
      e.kind !== 'pc' ? (() => {
        const why = !c.active ? 'Combat only' : actionBlock();
        return h('button.small', {
          disabled: !!why, title: why ?? 'Pick a target',
          onclick: () => setMode({
            type: 'target', label: `${e.name} — ${a.name}: pick a target`, range: Number(a.range) || 1, origin: e,
            filter: (t) => t.id !== e.id && t.kind !== 'object' && t.status !== 'dead',
            onTarget: (t) => send({ type: 'attack', entityId: e.id, attackId: a.id, targetId: t.id }),
          }),
        }, 'Use');
      })() : null)),
    e.kind !== 'pc' && e.abilities?.length ? h('div.section-title', {}, 'Abilities (DM)') : null,
    ...(e.kind !== 'pc' ? e.abilities ?? [] : []).map((ab) => h('div.inv-item', {},
      abilityLabel(ab),
      h('button.small', {
        disabled: (ab.combatOnly && !c.active) || !!actionBlock(),
        title: (ab.combatOnly && !c.active ? 'Combat only' : actionBlock()) ?? 'Use',
        onclick: () => startAbility({ caster: view(e), ab, entities: () => sceneEntities().map(view), setMode, send, toast: null }),
      }, 'Use'))),
    e.kind === 'pc' && e.abilities?.length ? h('div.section-title', {}, 'Abilities') : null,
    ...(e.kind === 'pc' ? e.abilities ?? [] : []).map((ab) => h('div.inv-item', {}, abilityLabel(ab))),
    e.kind !== 'object' ? h('div.section-title', {}, 'Inventory') : null,
    ...(e.kind === 'object' ? [] : e.inventory.length ? e.inventory.map((it) => h('div.inv-item', {}, it.name,
      h('button.small', { title: 'Remove', onclick: () => send({ type: 'item.remove', entityId: id, itemId: it.id }) }, '✕'))) : [h('p.muted', {}, 'Empty')]),
    e.kind !== 'object' ? h('form.row', {
      style: { marginTop: '6px' },
      onsubmit: (ev) => { ev.preventDefault(); if (itemInput.value.trim()) send({ type: 'item.add', entityId: id, name: itemInput.value }); },
    }, itemInput, h('button.small', { type: 'submit' }, 'Add')) : null,
    h('div.row', { style: { marginTop: '12px' } },
      e.kind !== 'pc'
        ? h('button.small.danger', { onclick: () => confirm(`Remove ${e.name}?`) && send({ type: 'entity.remove', entityId: id }).then(() => select(null)) }, 'Remove from game')
        : h('button.small', { onclick: () => confirm(`Release ${e.name} from ${owner?.name}?`) && send({ type: 'dm.resetPlayer', playerId: e.ownerPlayerId }) }, 'Reset player / release character')),
  );
}

// Re-render a section only when its inputs change, so half-typed values survive unrelated updates.
const memoKeys = {};
function memo(name, key, fn) {
  const k = JSON.stringify(key);
  if (memoKeys[name] === k) return;
  memoKeys[name] = k;
  fn();
}

function render() {
  if (selectedId && !state.entities[selectedId]) selectedId = null;
  if ((mode?.type === 'target' || mode?.type === 'cell') && !state.entities[mode.origin?.id]) mode = null;
  const ents = Object.values(state.entities);
  renderTop();
  memo('scenes', [state.scenes, state.sceneOrder, state.activeSceneId, templates, ents.map((e) => [e.scope, e.sceneId])], renderScenes);
  memo('players', [state.players, state.options], renderPlayers);
  memo('handouts', [state.handouts, state.handoutOrder, library, state.activeSceneId, state.sceneOrder.map((sid) => state.scenes[sid].name)], renderHandouts);
  memo('banks', [spawnScope, state.activeSceneId, state.combat, state.turn, ents.filter((e) => e.kind !== 'pc').map((e) => [e.id, e.name, e.hp, e.status, e.scope, e.sceneId, e.damageTaken])], renderBanks);
  renderBoard();
  const sel = selected();
  memo('inspector', [selectedId, sel, state.combat, state.turn[selectedId], sel && playerOf(sel), state.activeSceneId], renderInspector);
}

loadTemplates();
loadLibrary();
