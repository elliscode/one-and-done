import { connect } from './transport.js';
import { API_BASE } from './config.js';
import { $, fill, h, toast, sendCmd, sendPing, sendChat, popupMenu, closeMenu, confirmModal, combatBar, ROLE_LABELS, ROLE_ICONS, PLAYER_COLORS } from './common.js';
import { Board } from './board.js';
import { GameFeed } from './panel.js';
import { startAbility, abilitySummary, distance, sideOf } from './abilities.js';
import { createPredictor, squaresBetween } from './predict.js';
import { openReader } from './handouts.js';

const token = decodeURIComponent(location.pathname.split('/').pop());
const SEAT_KEY = `one-and-done:seat:${token}`;
const NAME_KEY = 'one-and-done:name';

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
// Seats and names saved before the app was renamed used a "dne:" prefix; carry them over once.
for (const [oldKey, newKey] of [[`dne:seat:${token}`, SEAT_KEY], ['dne:name', NAME_KEY]]) {
  const old = store.get(oldKey);
  if (old !== null && store.get(newKey) === null) store.set(newKey, old);
  store.del(oldKey);
}

// The join token tells a multi-account deployment whose content this game uses (self-hosted ignores it).
const publicContentUrl = `${API_BASE}/api/content/public?joinToken=${encodeURIComponent(token)}`;
let content = await fetch(publicContentUrl).then((r) => r.json());
let heroById = new Map(content.characters.map((c) => [c.id, c]));

let seat = store.get(SEAT_KEY);
let state = null; // what the screen shows: the server's state plus predictions for commands in flight
let serverState = null;
const predictor = createPredictor({ onChange: () => { if (serverState) { state = predictor.view(serverState); render(); } } });
let pickedRole = null;
let mode = null; // null | {type:'move'} | {type:'target', ...}
let fatal = null;

const socket = connect('/play', { joinToken: token, playerId: seat?.playerId, seatSecret: seat?.seatSecret });
const panel = new GameFeed($('#panel'), {
  onSend: (text) => sendChat(socket, text),
});
const bar = combatBar($('#combat-bar'));

socket.on('state', (s) => {
  serverState = s;
  predictor.onState();
  state = predictor.view(s);
  render();
  updateHandouts();
});
socket.on('history', (hist) => panel.setHistory(hist));
socket.on('feed', (rows) => panel.add(rows));
socket.on('fx', (list) => { for (const f of list) board.showFx(f.entityId, f.text, f.color, f.kind); });
socket.on('ping', (p) => board.showPing(p));
socket.on('seatInvalid', () => {
  store.del(SEAT_KEY);
  seat = null;
  socket.setAuth({ joinToken: token });
  toast('Your seat was reset by the DM. Please join again.');
});
socket.on('fatal', (msg) => { fatal = msg; render(); });
// The DM edited heroes/acts or art: refetch so the hero picker and Act menu stay current.
socket.on('contentChanged', async () => {
  content = await fetch(publicContentUrl).then((r) => r.json());
  heroById = new Map(content.characters.map((c) => [c.id, c]));
  render();
});
socket.on('connect_error', () => toast('Connection problem — retrying…', 'error'));

// ---------- handouts ----------

// Which shared handouts this browser has opened (a per-viewer convenience; losing it only resets
// the unread count). Ids of handouts no longer shared are dropped, so the list stays small.
const READ_KEY = `one-and-done:read:${token}`;
let readIds = new Set(store.get(READ_KEY) ?? []);
let knownHandouts = null; // ids shared at the last update, to spot newly shared ones
let reader = null;

function markRead(id) {
  if (readIds.has(id)) return;
  readIds.add(id);
  const live = new Set((state?.handouts ?? []).map((ho) => ho.id));
  readIds = new Set([...readIds].filter((x) => live.has(x)));
  store.set(READ_KEY, [...readIds]);
  updateHandoutsButton();
}

function openHandouts(startId = null) {
  reader = openReader(state?.handouts ?? [], {
    startId, onRead: markRead, emptyText: 'The DM hasn\'t shared anything yet.',
    forScene: (ho) => ho.forScene, sceneName: () => state?.scene?.name ?? null,
  });
}

function updateHandoutsButton() {
  const list = state?.handouts ?? [];
  const unread = list.filter((ho) => !readIds.has(ho.id)).length;
  const btn = $('#handouts-btn');
  btn.classList.toggle('hidden', !list.length);
  btn.classList.toggle('unread', unread > 0);
  btn.textContent = unread ? `📜 Handouts (${unread} new)` : '📜 Handouts';
}

function updateHandouts() {
  const list = state?.handouts ?? [];
  if (knownHandouts) {
    for (const ho of list) {
      if (knownHandouts.has(ho.id) || readIds.has(ho.id)) continue;
      toast(h('span', {}, `📜 The DM shared "${ho.title}" `, h('button.small', { onclick: () => openHandouts(ho.id) }, 'Read')));
    }
  }
  knownHandouts = new Set(list.map((ho) => ho.id));
  if (reader?.open) reader.refresh(list);
  updateHandoutsButton();
}
$('#handouts-btn').addEventListener('click', () => openHandouts());

const send = (cmd) => sendCmd(socket, cmd);
// Sends a command, showing `apply`'s predicted result until the server answers (see predict.js).
const predicted = (cmd, apply) => (apply ? predictor.run(() => send(cmd), apply) : send(cmd));

const blankTurn = () => ({ actions: 0, bonus: 0, moved: 0, abilitiesUsed: [], moves: [] });

// A move the client can tell is legal (our hero, our window, on the grid, enough movement) shows at
// once: the token on its new square and the squares spent. Anything else waits for the server.
function movePrediction(me, x, y) {
  const g = state.scene?.grid;
  if (!me?.position || !g || me.status !== 'active') return null;
  const a = availability();
  const dist = squaresBetween(me.position, { x, y });
  const fits = Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x + me.size.w <= g.cols && y + me.size.h <= g.rows;
  if (!fits || a.dmPhase || (a.c.active && dist > a.moveLeft)) return null;
  const movedAtSend = a.t.moved ?? 0;
  const paying = a.c.active;
  return (s) => {
    const e = s.entities.find((x2) => x2.id === me.id);
    e.position = { x, y };
    if (paying) {
      s.turn ??= blankTurn();
      s.turn.moved = Math.max(s.turn.moved ?? 0, movedAtSend + dist);
    }
  };
}

// An action spent in combat (attack, act, item, ability): the buttons grey out at once. Outside
// combat nothing is spent, so there's nothing to predict.
function actionPrediction({ cost = 1, abilityId = null } = {}) {
  const a = availability();
  if (!a.c.active) return null;
  const actionsAtSend = a.t.actions ?? 0;
  const usedAtSend = (a.t.abilitiesUsed ?? []).filter((x) => x === abilityId).length;
  return (s) => {
    s.turn ??= blankTurn();
    s.turn.moves = []; // acting locks in this phase's moves
    if (cost > 0) s.turn.actions = Math.max(s.turn.actions ?? 0, actionsAtSend + cost);
    if (abilityId) {
      const used = (s.turn.abilitiesUsed ??= []);
      if (used.filter((x) => x === abilityId).length <= usedAtSend) used.push(abilityId);
    }
  };
}

function moveMe(x, y) {
  const me = myEntity();
  return predicted({ type: 'move', entityId: me.id, x, y }, movePrediction(me, x, y));
}

// ---------- board ----------

const board = new Board($('#board'), {
  // Press and hold to ping. Errors (the players' 10-per-minute limit) show as a toast.
  onPing: (p) => sendPing(socket, p),
  canDrag: (t) => t.id === myEntity()?.id && !mode,
  onTokenDrop: (t, x, y) => moveMe(x, y),
  onTokenClick: (t, e, stack) => onTokenClick(t, e, stack),
  onCellClick: (cell) => onCellClick(cell),
});

function myEntity() {
  return state?.entities.find((e) => e.id === state.me?.entityId) ?? null;
}

const playerColor = (pid) => state.players.find((p) => p.id === pid)?.color;
const dist = (a, sa, b, sb) => {
  const dx = Math.max(0, b.x - (a.x + sa.w - 1), a.x - (b.x + sb.w - 1));
  const dy = Math.max(0, b.y - (a.y + sa.h - 1), a.y - (b.y + sb.h - 1));
  return Math.max(dx, dy);
};

function availability() {
  const me = myEntity();
  const c = state.combat;
  const t = state.turn ?? { actions: 0, bonus: 0, moved: 0, abilitiesUsed: [] };
  // Allowances come from the server (they include granted actions, slows, snares...).
  const allowance = me.allowance ?? { actions: (me.actionsPerPhase ?? 1) + (t.bonus ?? 0), movement: me.movement };
  const actionsLeft = Math.max(0, allowance.actions - t.actions);
  const actionLeft = !c.active || actionsLeft > 0;
  const dmPhase = c.active && c.phase !== 'player';
  const moveLeft = c.active ? Math.max(0, allowance.movement - t.moved) : Infinity;
  return { me, c, t, allowance, actionLeft, actionsLeft, dmPhase, moveLeft, canAct: me.status === 'active' && !dmPhase && actionLeft };
}

// The item catalog entry for an inventory entry: by defId, else by name (mirrors findItem() on
// the server).
function itemDef(it) {
  const name = String(it.name ?? '').trim().toLowerCase();
  const items = content.items ?? [];
  return (it.defId && items.find((d) => d.id === it.defId)) || items.find((d) => d.name.trim().toLowerCase() === name) || null;
}

function cellsWithin(origin, size, range) {
  const g = state.scene.grid, out = [];
  for (let y = 0; y < g.rows; y++) for (let x = 0; x < g.cols; x++) {
    if (dist(origin, size, { x, y }, { w: 1, h: 1 }) <= range) out.push({ x, y });
  }
  return out;
}

function renderBoard() {
  const me = myEntity();
  board.setScene(state.scene);
  const tokens = state.entities.map((e) => ({ ...e, color: e.kind === 'pc' ? playerColor(e.ownerPlayerId) : e.hostile ? '#8a2f2f' : '#d4af37' }));
  const view = { myId: me?.id, showStacks: true };
  if (me && !mode) {
    const a = availability();
    const disabled = new Set();
    if (!a.c.active || !a.canAct) disabled.add('attack');
    if (a.dmPhase || a.moveLeft === 0) disabled.add('move');
    if (!a.canAct) { disabled.add('inventory'); disabled.add('act'); }
    view.donut = { forId: me.id, disabled, onSegment, onRoll: () => send({ type: 'downRoll', entityId: me.id }) };
  }
  if (mode?.type === 'target') {
    const origin = mode.origin ? state.entities.find((e) => e.id === mode.origin.id) ?? mode.origin : me;
    view.targetIds = new Set(state.entities.filter((e) => mode.filter(e) && e.status !== 'dead' && distance(origin, e) <= mode.range).map((e) => e.id));
    board.highlight(cellsWithin(origin.position, origin.size, mode.range), 'range');
  } else if (mode?.type === 'cell') {
    board.highlight(cellsWithin(me.position, me.size, mode.range), 'move');
  } else if (mode?.type === 'move') {
    const a = availability();
    board.highlight(a.c.active ? cellsWithin(me.position, me.size, a.moveLeft) : [], 'move');
  } else {
    board.highlight([]);
  }
  board.setTokens(tokens, view);
  renderModeBanner();
}

function renderModeBanner() {
  $('.mode-banner')?.remove();
  if (!mode) return;
  $('#board').append(h('div.mode-banner', {}, mode.label,
    mode.onDone ? h('button.small.primary', { onclick: () => { const m = mode; cancelMode(); m.onDone(); } }, 'Done') : null,
    h('button.small', { onclick: cancelMode }, 'Cancel (Esc)')));
}

function setMode(m) {
  mode = m;
  closeMenu();
  renderBoard();
}
function cancelMode() { setMode(null); }
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') cancelMode();
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.target.closest('input, textarea') && canUndoMove()) { e.preventDefault(); undoMove(); }
});

// Undo move: take back this phase's last move (and its squares) until you act. Server-checked.
function canUndoMove() {
  const me = myEntity();
  return !!(me && me.status === 'active' && state.combat?.active && state.combat.phase === 'player' && state.turn?.moves?.length);
}
function undoMove() {
  const me = myEntity();
  if (me) send({ type: 'move.undo', entityId: me.id });
}
$('#undo-move').addEventListener('click', undoMove);

function onCellClick(cell) {
  const me = myEntity();
  if (mode?.type === 'move') {
    // A move we can predict takes effect now, so leave move mode now too.
    if (movePrediction(me, cell.x, cell.y)) {
      cancelMode();
      moveMe(cell.x, cell.y);
    } else {
      moveMe(cell.x, cell.y).then((ok) => { if (ok) cancelMode(); });
    }
  }
  if (mode?.type === 'cell') {
    const m = mode;
    cancelMode();
    m.onCell(cell);
  }
}

function onTokenClick(t, e, stack) {
  if (mode?.type === 'target') {
    const target = stack.find((s) => mode.filter(s) && s.status !== 'dead') ?? t;
    const origin = mode.origin ?? myEntity();
    if (!mode.filter(target) || target.status === 'dead') return toast('Not a valid target', 'error');
    if (distance(state.entities.find((x) => x.id === origin.id) ?? origin, target) > mode.range) return toast(`${target.name} is out of range`, 'error');
    const m = mode;
    cancelMode();
    m.onTarget(target);
    return;
  }
  if (mode?.type === 'move' || mode?.type === 'cell') return onCellClick(board.cellAt(e.clientX, e.clientY));
  if (stack.length > 1) {
    popupMenu(e.clientX, e.clientY, 'Here', stack.map((s) => ({ label: s.name, sub: s.status !== 'active' ? s.status.toUpperCase() : s.kind === 'pc' ? 'hero' : '' })));
  }
}

const isFoe = (me) => (e) => !!sideOf(e) && sideOf(e) !== sideOf(me);

function onSegment(seg, t, e) {
  const a = availability();
  const at = board.screenPoint(t.id);
  const why = a.me.status !== 'active' ? `${a.me.name} is ${a.me.status}` : a.dmPhase ? 'Wait for the PLAYER PHASE' : !a.actionLeft ? 'Action already used this phase' : null;
  if (seg === 'move') {
    if (a.dmPhase) return toast('Wait for the PLAYER PHASE', 'error');
    if (a.moveLeft === 0) return toast('No movement left this phase', 'error');
    return setMode({ type: 'move', label: a.c.active ? `Move up to ${a.moveLeft} squares — click a square` : 'Click a square to move (or drag your token)' });
  }
  if (seg === 'attack') {
    const note = !a.c.active ? 'Attacks unlock when combat begins' : why;
    popupMenu(at.x + 60, at.y - 60, note ? `Attack — ${note}` : 'Attack', a.me.attacks.map((atk) => ({
      label: atk.name,
      sub: `${atk.attack} to hit · ${atk.damage} dmg · range ${atk.range ?? 1}`,
      disabled: !!note,
      onClick: () => setMode({
        type: 'target', label: `${atk.name}: choose a target`, range: Number(atk.range) || 1, filter: isFoe(a.me),
        onTarget: (target) => predicted({ type: 'attack', entityId: a.me.id, attackId: atk.id, targetId: target.id }, actionPrediction()),
      }),
    })));
    return;
  }
  if (seg === 'inventory') {
    const items = a.me.inventory.map((it) => {
      const def = itemDef(it);
      const cost = a.c.active ? 'costs your action' : '';
      // Items with an ability (Healing Potion) ask for a target first; cancelling keeps the item.
      if (def?.ability) {
        const ab = { ...def.ability, id: it.id, name: it.name };
        return {
          label: it.name, sub: [def.description, abilitySummary(ab), cost].filter(Boolean).join(' — '), disabled: !!why,
          onClick: () => startAbility({ caster: a.me, ab, entities: () => state.entities, setMode, send: (cmd) => predicted({ ...cmd, type: 'item.use', itemId: it.id }, actionPrediction({ cost: ab.actionCost ?? 1 })), toast: null }),
        };
      }
      return {
        label: it.name, sub: [def?.description, cost ? `Use (${cost})` : 'Use'].filter(Boolean).join(' — '), disabled: !!why,
        onClick: () => predicted({ type: 'item.use', entityId: a.me.id, itemId: it.id }, actionPrediction()),
      };
    });
    popupMenu(at.x + 60, at.y + 20, why ? `Inventory — ${why}` : 'Inventory', items.length ? items : [{ label: 'Empty', disabled: true }]);
    return;
  }
  if (seg === 'act') {
    const items = [];
    if (a.me.abilities.length) items.push({ heading: 'Abilities' });
    for (const ab of a.me.abilities) {
      const free = ab.actionCost === 0;
      const used = (a.t.abilitiesUsed ?? []).filter((x) => x === ab.id).length;
      const capped = a.c.active && ab.usesPerPhase && used >= ab.usesPerPhase;
      const needsCombat = ab.combatOnly && !a.c.active;
      const blocked = a.me.status !== 'active' || a.dmPhase || (!free && !a.actionLeft) || capped || needsCombat;
      items.push({
        label: ab.name,
        sub: [needsCombat ? 'combat only' : '', abilitySummary(ab), capped ? 'used this phase' : '', ab.description].filter(Boolean).join(' — '),
        disabled: blocked,
        onClick: () => startAbility({ caster: a.me, ab, entities: () => state.entities, setMode, send: (cmd) => predicted(cmd, actionPrediction({ cost: ab.actionCost ?? 1, abilityId: ab.id })), toast: null }),
      });
    }
    items.push({ heading: 'Actions' });
    for (const act of content.acts) {
      items.push({ label: act.name, sub: act.roll ? `roll ${act.roll}` : '', disabled: !!why, onClick: () => predicted({ type: 'act', entityId: a.me.id, actId: act.id }, actionPrediction()) });
    }
    const input = h('input', { placeholder: 'Something else… (e.g. Pull the rope)', maxLength: 80 });
    const roll = h('select', {}, ...['', '1d20', '1d12', '1d10', '1d8', '1d6', '1d4'].map((r) => h('option', { value: r }, r || 'no roll')));
    const form = h('form', {
      onsubmit: (ev) => {
        ev.preventDefault();
        if (!input.value.trim()) return;
        predicted({ type: 'act', entityId: a.me.id, text: input.value, roll: roll.value || null }, actionPrediction());
        closeMenu();
      },
    }, input, roll, h('button.small.primary', { type: 'submit', disabled: !!why }, 'Do it'));
    items.push({ heading: 'Custom' }, { node: form });
    popupMenu(at.x - 340, at.y - 80, why ? `Act — ${why}` : 'Act', items);
  }
}

// ---------- screens ----------

function showFlow(...nodes) {
  $('#game').classList.add('hidden');
  const flow = $('#flow');
  flow.classList.remove('hidden');
  fill(flow, ...nodes);
}

function nameScreen() {
  const remembered = store.get(NAME_KEY);
  const input = h('input.big-input', { placeholder: 'Your name', maxLength: 24, value: remembered ?? '', autofocus: true });
  const join = (name) => {
    name = String(name ?? '').trim();
    if (!name) return toast('Enter a name', 'error');
    socket.request('join', { name }).catch(() => null).then((res) => {
      if (!res?.ok) return toast(res?.error ?? 'Could not join', 'error');
      seat = { playerId: res.playerId, seatSecret: res.seatSecret };
      store.set(SEAT_KEY, seat);
      store.set(NAME_KEY, name);
      socket.setAuth({ joinToken: token, ...seat });
    });
  };
  showFlow(
    h('h1', {}, state?.game?.name ?? 'One & Done'),
    h('h2', {}, "What's your name?"),
    remembered ? h('p', {}, h('button.gold', { onclick: () => join(remembered) }, `Continue as ${remembered}`)) : null,
    h('form', { onsubmit: (e) => { e.preventDefault(); join(input.value); } },
      input, h('p', {}, h('button.primary', { type: 'submit' }, remembered ? 'Use this name' : 'Join'))));
  setTimeout(() => input.focus());
}

function roleScreen() {
  const taken = state.takenCharacters;
  showFlow(
    h('h1', {}, `Welcome, ${state.me.name}`),
    h('h2', {}, 'Choose a role'),
    h('div.role-grid', {}, ...['tank', 'dps', 'heal'].map((r) => {
      const heroes = content.characters.filter((c) => c.role === r);
      const free = heroes.filter((c) => !taken[c.id]).length;
      return h('div.role-card', { onclick: () => { pickedRole = r; render(); } },
        h('div.icon', {}, ROLE_ICONS[r]), h('h2', {}, ROLE_LABELS[r]),
        content.roles?.[r]?.blurb ? h('div.role-bonus', {}, content.roles[r].blurb) : null,
        h('div.muted', {}, `${free} of ${heroes.length} heroes available`));
    })));
}

function heroScreen() {
  const taken = state.takenCharacters;
  const who = (pid) => state.players.find((p) => p.id === pid)?.name ?? 'someone';
  showFlow(
    h('div.row', {}, h('button', { onclick: () => { pickedRole = null; render(); } }, '← Roles'), h('h1.grow', {}, `Choose your ${ROLE_LABELS[pickedRole]}`)),
    h('div.hero-grid', {}, ...content.characters.filter((c) => c.role === pickedRole).map((c) => {
      const takenBy = taken[c.id];
      return h(`div.hero-card${takenBy ? '.taken' : ''}`, {
        onclick: () => { if (!takenBy) send({ type: 'player.selectCharacter', characterId: c.id }); },
      },
      h('img.portrait', { src: c.image, alt: '' }),
      h('h3', {}, c.name),
      content.roles?.[c.role]?.blurb ? h('div.role-bonus', { title: 'Automatic role bonus' }, content.roles[c.role].blurb) : null,
      h('div.stats', {}, h('span', {}, '❤ ', h('b', {}, c.maxHp)), h('span', {}, '🛡 ', h('b', {}, c.defense)), h('span', {}, '👣 ', h('b', {}, c.movement))),
      h('div.section-title', {}, 'Attacks'),
      h('ul', {}, ...c.attacks.map((a) => h('li', {}, `${a.name} — ${a.damage}, range ${a.range ?? 1}`))),
      c.abilities?.length ? h('div.section-title', {}, 'Abilities') : null,
      c.abilities?.length ? h('ul', {}, ...c.abilities.map((a) => h('li', {}, a.name + (a.description ? ` — ${a.description}` : '')))) : null,
      takenBy ? h('div.muted', { style: { textAlign: 'center' } }, `Taken by ${who(takenBy)}`) : h('button.primary', {}, 'Play this hero'));
    })));
}

function waitingScreen() {
  const hero = heroById.get(state.me.characterId);
  showFlow(
    h('div.waiting', {}, h('span.spinner', {}, '⏳'), 'Waiting for DM to set active scene'),
    h('p.muted', {}, `You are playing ${state.me.heroName ?? hero?.name ?? state.me.characterId}. Hang tight!`),
    h('p', {}, meChip()));
}

function meChip() {
  const me = state.me;
  return h('span.me-chip', { onclick: (e) => settingsMenu(e) }, h('span.dot', { style: { background: me.color } }), me.name, ' ⚙');
}

// The other players, right-aligned against your own chip. Chips that don't fit run off the left
// edge behind a fade; the roster card (hover the chips) lists everyone.
function partyList() {
  const chips = state.players.filter((p) => p.id !== state.me.id).map((p) =>
    h(`span.party-chip${p.presence !== 'online' ? '.away' : ''}`, {}, h('span.dot', { style: { background: p.color } }), p.name));
  const list = h('span.party-list', {}, h('span.party-track', {}, ...chips));
  list.addEventListener('mouseenter', () => showRoster(list));
  list.addEventListener('mouseleave', hideRoster);
  // Touch screens have no hover: a tap toggles the card.
  list.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') (roster.open ? hideRoster() : showRoster(list)); });
  return list;
}

function markClipped() {
  const list = $('#party-list');
  list?.classList.toggle('clipped', list.firstChild.scrollWidth > list.clientWidth);
}
addEventListener('resize', markClipped);

// One shared roster card, fixed-positioned so the top bar's clipping can't cut it off.
const roster = { el: h('div.roster-tip.hidden'), open: false };
document.body.append(roster.el);

function showRoster(el) {
  const me = state.me;
  const players = [me, ...state.players.filter((p) => p.id !== me.id)].map((p) => state.players.find((x) => x.id === p.id) ?? p);
  fill(roster.el, ...players.map((p) => {
    const away = p.presence && p.presence !== 'online';
    return h(`div.roster-row${away ? '.away' : ''}`, {},
      h('span.dot', { style: { background: p.color } }),
      h('span', {}, p.name, p.id === me.id ? h('span.muted', {}, ' (you)') : null),
      h('span.muted', {}, p.heroName ?? heroById.get(p.characterId)?.name ?? 'choosing a hero', away ? ` · ${p.presence}` : ''));
  }));
  roster.open = true;
  roster.el.classList.remove('hidden');
  const r = el.getBoundingClientRect();
  roster.el.style.top = `${r.bottom + 6}px`;
  roster.el.style.left = `${Math.max(8, Math.min(r.right - roster.el.offsetWidth, innerWidth - roster.el.offsetWidth - 8))}px`;
}

function hideRoster() {
  roster.open = false;
  roster.el.classList.add('hidden');
}
// Close on a tap elsewhere, or if the mouse is no longer over the chips (a re-render can swap the
// hovered element out without a mouseleave).
for (const type of ['pointerdown', 'mousemove']) {
  addEventListener(type, (e) => { if (roster.open && !e.target.closest?.('.party-list')) hideRoster(); });
}

function settingsMenu(e) {
  hideRoster();
  const me = state.me;
  const used = new Map(state.players.filter((p) => p.id !== me.id).map((p) => [p.color, p.name]));
  const nameInput = h('input', { value: me.name, maxLength: 24 });
  const form = h('form', {
    onsubmit: async (ev) => {
      ev.preventDefault();
      if (await send({ type: 'player.setName', name: nameInput.value })) {
        store.set(NAME_KEY, nameInput.value.trim());
        closeMenu();
      }
    },
  }, nameInput, h('button.small.primary', { type: 'submit' }, 'Rename'));
  // The hero you play (only once you have one). Releasing the hero resets its name.
  const heroInput = h('input', { value: me.heroName ?? '', maxLength: 40 });
  const heroForm = me.entityId ? h('form', {
    onsubmit: async (ev) => {
      ev.preventDefault();
      if (await send({ type: 'player.renameCharacter', name: heroInput.value })) closeMenu();
    },
  }, heroInput, h('button.small.primary', { type: 'submit' }, 'Rename')) : null;
  // Leaving the hero (only when the DM allows it in this game): confirm, then back to the picker.
  const leave = me.entityId && state.options?.playersCanLeave ? h('button.small.danger', {
    onclick: async () => {
      const hero = me.heroName ?? 'your hero';
      const ok = await confirmModal({
        title: `Leave ${hero}?`,
        body: `Your hero leaves the game and you'll pick a hero again. Its HP, items and effects are lost; picking it again starts fresh. Your name and color stay.${state.combat?.active ? ' Your token leaves the fight right away.' : ''}`,
        confirm: 'Leave hero', danger: true,
      });
      if (!ok) return;
      cancelMode();
      send({ type: 'player.leaveCharacter' });
    },
  }, 'Leave hero…') : null;
  const swatches = h('div.swatches', {}, ...PLAYER_COLORS.map((c) => h(`button.swatch${c === me.color ? '.current' : ''}`, {
    style: { background: c }, disabled: used.has(c), title: used.has(c) ? `Taken by ${used.get(c)}` : 'Pick this color',
    onclick: () => send({ type: 'player.setColor', color: c }).then(() => closeMenu()),
  })));
  popupMenu(e.clientX - 150, e.clientY + 16, 'You', [{ heading: 'Name' }, { node: form },
    ...(heroForm ? [{ heading: 'Character' }, { node: heroForm }] : []), ...(leave ? [{ node: leave }] : []), { heading: 'Color' }, { node: swatches }]);
}

function gameScreen() {
  $('#flow').classList.add('hidden');
  $('#game').classList.remove('hidden');
  $('#game-name').textContent = state.game.name;
  $('#me-chip').replaceWith(Object.assign(meChip(), { id: 'me-chip' }));
  $('#party-list').replaceWith(Object.assign(partyList(), { id: 'party-list' }));
  requestAnimationFrame(markClipped);
  // The chips were just replaced: keep an open card attached (and up to date) on the new ones.
  if (roster.open) showRoster($('#party-list'));
  bar.update(state.combat, state.serverNow);
  const me = myEntity();
  const info = $('#turn-info');
  if (me && state.combat.active) {
    const a = availability();
    info.textContent = me.status !== 'active' ? me.status.toUpperCase()
      : `Actions: ${a.actionsLeft}/${a.allowance.actions} · Move: ${a.moveLeft}/${a.allowance.movement}`;
  } else info.textContent = me?.status && me.status !== 'active' ? me.status.toUpperCase() : '';
  $('#undo-move').classList.toggle('hidden', !canUndoMove());
  // Cancel a pending mode if it no longer makes sense (e.g. phase changed).
  if (mode && (!me || me.status !== 'active' || (state.combat.active && state.combat.phase !== 'player'))) mode = null;
  renderBoard();
}

let lastScreen = null;
function render() {
  if (fatal) return showFlow(h('h1', {}, 'One & Done'), h('h2', {}, fatal));
  if (!state) return;
  const screen = !state.me ? 'name' : !state.me.characterId ? `pick:${pickedRole}` : !state.scene ? 'wait' : 'game';
  const same = screen === lastScreen;
  lastScreen = screen;
  // Don't wipe what the player is typing when unrelated state arrives.
  if (screen === 'name') return same ? undefined : nameScreen();
  if (!state.me.characterId) {
    if (!pickedRole) return roleScreen();
    return heroScreen();
  }
  pickedRole = null;
  if (!state.scene) return waitingScreen();
  gameScreen();
}
