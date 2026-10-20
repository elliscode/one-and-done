import { isValidDice } from './dice.js';
import {
  PLAYER_COLORS, MAX_SCENE_LINKS, fail, newId, randomToken, entityFromDef, entitiesInScene, isFriendly, makeItem, turnFor, areEnemies,
} from './state.js';
import { inBounds, ensurePlaced } from './placement.js';
import { normalizeHandout, MAX_HANDOUTS, MAX_HANDOUT_SCENES } from './handouts.js';
import { startCombat, advancePhase, endCombat, applyHeal, applyDamage, setHp, revive, kill, dealDamage, deathAt } from './combat.js';
import { addEffect, clearStatus, removeEffect, effectsOf, movementAllowance } from './status.js';
import { activateAbility, runAbility, strike, checkTaunt, resolveCheck, onPhaseTransition, STATUSES } from './effects.js';
import {
  str, int, outcome, hpTexts, statusSuffix, getEntity, onActiveScene, controlled, requireStatus, requirePlayerWindow,
  requireActionWindow, budgeted, checkAction, spendAction, rollOrFail, distanceBetween, frightenedBy,
} from './helpers.js';

// Handler options:
//   who:        'dm' | 'player' | 'any' (dm or player) | 'join' | 'system'
//   undoable:   snapshot state before running so the DM can undo it
//   clearsUndo: structural change after which older snapshots no longer make sense
export const handlers = {};
const def = (type, opts, run) => { handlers[type] = { ...opts, run }; };

// Training dummies and objects have no HP to set, heal or kill.
function requireMortal(e) {
  if (e.immortal) fail(`${e.name} is a training dummy and can't die — use Remove`);
  if (e.kind === 'object') fail(`${e.name} is an object and has no HP`);
}

// ---------- players & identity ----------

def('player.create', { who: 'join' }, (ctx) => {
  const name = str(ctx.cmd.name, 24, 'Name');
  const used = new Set(Object.values(ctx.state.players).map((p) => p.color));
  const color = PLAYER_COLORS.find((c) => !used.has(c));
  if (!color) fail('This game is full (10 players)');
  let id;
  do id = newId('p'); while (ctx.state.players[id]);
  const seatSecret = randomToken(16);
  ctx.state.players[id] = { id, name, color, seatSecret, characterId: null, entityId: null, joinedAt: ctx.now };
  ctx.log('join', `${name} joined the game`, { color });
  return { playerId: id, seatSecret };
});

def('player.setName', { who: 'player' }, (ctx) => {
  const name = str(ctx.cmd.name, 24, 'Name');
  const old = ctx.player.name;
  if (old === name) return;
  ctx.player.name = name;
  ctx.log('player', `${old} is now known as ${name}`);
});

// A player renames the hero they play (their own token only). Releasing the hero resets it.
def('player.renameCharacter', { who: 'player' }, (ctx) => {
  const e = ctx.state.entities[ctx.player.entityId];
  if (!e) fail('Pick a hero first');
  const name = str(ctx.cmd.name, 40, 'Character name');
  const old = e.name;
  if (old === name) return;
  e.name = name;
  ctx.log('character', `${ctx.player.name}'s ${old} is now known as ${name}`);
});

// A player gives up their hero and goes back to the hero picker, if the DM allows it in this game.
// Like the DM's Release: the token goes, the seat, name and color stay, and undo is cleared.
def('player.leaveCharacter', { who: 'player', clearsUndo: true }, (ctx) => {
  const p = ctx.player;
  if (!ctx.state.options?.playersCanLeave) fail("The DM hasn't allowed leaving heroes in this game");
  if (!p.characterId) fail("You don't have a hero");
  const name = ctx.state.entities[p.entityId]?.name ?? ctx.content.def('character', p.characterId)?.name ?? p.characterId;
  releaseCharacter(ctx, p);
  ctx.log('character', `${p.name} left ${name}`);
});

function setColor(ctx, player, color) {
  if (!PLAYER_COLORS.includes(color)) fail('Pick a color from the bank');
  const other = Object.values(ctx.state.players).find((p) => p.color === color && p.id !== player.id);
  if (other) fail(`${other.name} already has that color`);
  player.color = color;
}

def('player.setColor', { who: 'player' }, (ctx) => setColor(ctx, ctx.player, ctx.cmd.color));

def('player.selectCharacter', { who: 'player', clearsUndo: true }, (ctx) => {
  const p = ctx.player;
  if (p.characterId) fail('You already have a character');
  const chr = ctx.content.def('character', ctx.cmd.characterId);
  if (!chr) fail('Unknown character');
  const owner = Object.values(ctx.state.players).find((o) => o.characterId === chr.id);
  if (owner) fail(`${chr.name} has already been chosen by ${owner.name}`);
  const e = entityFromDef(chr, 'pc', { scope: 'game', ownerPlayerId: p.id, z: ++ctx.state.zCounter });
  ctx.state.entities[e.id] = e;
  p.characterId = chr.id;
  p.entityId = e.id;
  ctx.log('character', `${p.name} plays ${chr.name} (${String(chr.role).toUpperCase()})`);
});

function releaseCharacter(ctx, p) {
  if (p.entityId) {
    delete ctx.state.entities[p.entityId];
    delete ctx.state.turn[p.entityId];
  }
  p.characterId = null;
  p.entityId = null;
}

// "Goblin", "Goblin 2", ... so the DM can tell instances of the same definition apart.
function numberedName(ctx, def, kind) {
  const same = Object.values(ctx.state.entities).filter((o) => o.defId === def.id && o.kind === kind).length;
  return same ? `${def.name} ${same + 1}` : def.name;
}

function getPlayer(ctx, id) {
  const p = ctx.state.players[id];
  if (!p) fail('Unknown player');
  return p;
}

// Per-game switches. playersCanLeave: players may leave their hero from their ⚙ menu.
const GAME_OPTIONS = {
  playersCanLeave: { on: 'DM allowed players to leave their heroes', off: 'DM stopped players leaving their heroes' },
};
def('game.setOption', { who: 'dm' }, (ctx) => {
  const opt = GAME_OPTIONS[ctx.cmd.option];
  if (!opt) fail('Unknown game option');
  if (typeof ctx.cmd.value !== 'boolean') fail('Option value must be on or off');
  ctx.state.options ??= {};
  if (ctx.state.options[ctx.cmd.option] === ctx.cmd.value) return;
  ctx.state.options[ctx.cmd.option] = ctx.cmd.value;
  ctx.log('game', ctx.cmd.value ? opt.on : opt.off);
});

def('dm.resetPlayer', { who: 'dm', clearsUndo: true }, (ctx) => {
  const p = getPlayer(ctx, ctx.cmd.playerId);
  const had = p.characterId ? ctx.content.def('character', p.characterId)?.name ?? p.characterId : null;
  releaseCharacter(ctx, p);
  ctx.log('character', had ? `DM released ${had} from ${p.name}` : `DM reset ${p.name}`);
});

// Removes the seat entirely. The old browser's credentials stop working.
def('dm.removePlayer', { who: 'dm', clearsUndo: true }, (ctx) => {
  const p = getPlayer(ctx, ctx.cmd.playerId);
  releaseCharacter(ctx, p);
  delete ctx.state.players[p.id];
  ctx.log('player', `DM removed ${p.name} from the game`);
});

def('dm.setPlayerColor', { who: 'dm' }, (ctx) => setColor(ctx, getPlayer(ctx, ctx.cmd.playerId), ctx.cmd.color));

def('dm.renameGame', { who: 'dm' }, (ctx) => {
  ctx.state.name = str(ctx.cmd.name, 60, 'Name');
});

// ---------- scenes ----------

// Adds a live copy of a scene template to the game (scene.add, adventure.load). Returns the scene.
function addSceneFromTemplate(ctx, tpl, name = null) {
  const data = structuredClone(tpl.data);
  const sameName = Object.values(ctx.state.scenes).filter((s) => s.templateId === tpl.id).length;
  const id = newId('s');
  const base = name ?? tpl.name;
  const scene = {
    id,
    templateId: tpl.id,
    name: sameName ? `${base} (${sameName + 1})` : base,
    background: data.background ?? null,
    grid: data.grid,
    spawn: data.spawn ?? null,
  };
  ctx.state.scenes[id] = scene;
  ctx.state.sceneOrder.push(id);
  for (const placement of data.entities ?? []) {
    const d = ctx.content.def(placement.kind, placement.defId);
    if (!d) continue;
    const e = entityFromDef(d, placement.kind, {
      scope: 'scene', sceneId: id, z: ++ctx.state.zCounter, name: placement.name || numberedName(ctx, d, placement.kind),
    });
    if (inBounds(scene, placement.x, placement.y, e.size)) e.positions[id] = { x: placement.x, y: placement.y };
    if (placement.hostile && e.kind === 'npc') e.hostile = true;
    if (placement.dead && !e.immortal && e.kind !== 'object') kill(e);
    ctx.state.entities[e.id] = e;
  }
  ensurePlaced(ctx.state, id);
  return scene;
}

def('scene.add', { who: 'dm', clearsUndo: true }, (ctx) => {
  const tpl = ctx.templates.get(ctx.cmd.templateId);
  if (!tpl) fail('Unknown scene template');
  const scene = addSceneFromTemplate(ctx, tpl);
  ctx.log('scene', `DM added scene "${scene.name}"`, { dmOnly: true });
  return { sceneId: scene.id };
});

def('scene.remove', { who: 'dm', clearsUndo: true }, (ctx) => {
  const scene = ctx.state.scenes[ctx.cmd.sceneId];
  if (!scene) fail('Unknown scene');
  for (const e of Object.values(ctx.state.entities)) {
    if (e.scope === 'scene' && e.sceneId === scene.id) {
      delete ctx.state.entities[e.id];
      delete ctx.state.turn[e.id];
    } else {
      delete e.positions[scene.id];
    }
  }
  delete ctx.state.scenes[scene.id];
  ctx.state.sceneOrder = ctx.state.sceneOrder.filter((s) => s !== scene.id);
  for (const other of Object.values(ctx.state.scenes)) {
    if (!other.next) continue;
    other.next = other.next.filter((id) => id !== scene.id);
    if (!other.next.length) delete other.next;
  }
  for (const ho of Object.values(ctx.state.handouts)) {
    if (!ho.sceneIds) continue;
    ho.sceneIds = ho.sceneIds.filter((id) => id !== scene.id);
    if (!ho.sceneIds.length) delete ho.sceneIds;
  }
  if (ctx.state.activeSceneId === scene.id) ctx.state.activeSceneId = null;
  ctx.log('scene', `DM removed scene "${scene.name}"`, { dmOnly: true });
});

// Branching: which scenes come next after this one. A DM-only visual aid; links never restrict
// which scene can be activated. Directed, at most MAX_SCENE_LINKS, in the order given.

def('scene.setNext', { who: 'dm' }, (ctx) => {
  const scene = ctx.state.scenes[ctx.cmd.sceneId];
  if (!scene) fail('Unknown scene');
  if (!Array.isArray(ctx.cmd.next)) fail('next must be a list of scene ids');
  const next = [...new Set(ctx.cmd.next.map(String))].filter((id) => id !== scene.id);
  for (const id of next) if (!ctx.state.scenes[id]) fail('Unknown scene');
  if (next.length > MAX_SCENE_LINKS) fail(`A scene can link to at most ${MAX_SCENE_LINKS} next scenes`);
  if (next.length) scene.next = next;
  else delete scene.next;
});

def('scene.rename', { who: 'dm' }, (ctx) => {
  const scene = ctx.state.scenes[ctx.cmd.sceneId];
  if (!scene) fail('Unknown scene');
  scene.name = str(ctx.cmd.name, 60, 'Name');
});

def('scene.activate', { who: 'dm', clearsUndo: true }, (ctx) => {
  const id = ctx.cmd.sceneId ?? null;
  if (id !== null && !ctx.state.scenes[id]) fail('Unknown scene');
  if (ctx.state.activeSceneId === id) return;
  ctx.state.activeSceneId = id;
  if (id) {
    ensurePlaced(ctx.state, id);
    ctx.log('scene', `The party enters ${ctx.state.scenes[id].name}`);
  } else {
    ctx.log('scene', 'The DM cleared the active scene');
  }
});

// ---------- handouts ----------

function getHandout(ctx, id) {
  const ho = ctx.state.handouts[id];
  if (!ho) fail('Unknown handout');
  return ho;
}

// Copies normalized handout data into the game (hidden until the DM reveals it).
function addHandout(ctx, { title, data }, sourceId = null) {
  if (ctx.state.handoutOrder.length >= MAX_HANDOUTS) fail(`A game can hold at most ${MAX_HANDOUTS} handouts`);
  const id = newId('h');
  ctx.state.handouts[id] = { id, sourceId, title, ...data, revealed: false };
  ctx.state.handoutOrder.push(id);
  return ctx.state.handouts[id];
}

// Ties a game handout to some of the game's scenes, so the handout viewers group it under "This
// scene" while one of them is active. An empty list unties it. A grouping aid only: it doesn't
// reveal or hide anything.
function setHandoutScenes(ctx, ho, sceneIds) {
  if (!Array.isArray(sceneIds)) fail('sceneIds must be a list of scene ids');
  const ids = [...new Set(sceneIds.map(String))];
  for (const id of ids) if (!ctx.state.scenes[id]) fail('Unknown scene');
  if (ids.length > MAX_HANDOUT_SCENES) fail(`A handout can be tied to at most ${MAX_HANDOUT_SCENES} scenes`);
  if (ids.length) ho.sceneIds = ids;
  else delete ho.sceneIds;
}

function libraryHandout(ctx, id) {
  const ho = ctx.handouts?.get(id);
  if (!ho) fail('Unknown handout');
  return ho;
}

def('handout.add', { who: 'dm' }, (ctx) => {
  const src = libraryHandout(ctx, ctx.cmd.handoutId);
  const ho = addHandout(ctx, normalizeHandout({ title: src.title, ...src.data }), src.id);
  ctx.log('handout', '', { dmText: `DM added handout "${ho.title}"`, dmOnly: true });
  return { handoutId: ho.id };
});

def('handout.create', { who: 'dm' }, (ctx) => {
  const ho = addHandout(ctx, normalizeHandout(ctx.cmd));
  if (ctx.cmd.sceneIds !== undefined) setHandoutScenes(ctx, ho, ctx.cmd.sceneIds);
  ctx.log('handout', '', { dmText: `DM wrote handout "${ho.title}"`, dmOnly: true });
  return { handoutId: ho.id };
});

// Edits the game's copy; the library handout it came from is unchanged.
def('handout.update', { who: 'dm' }, (ctx) => {
  const ho = getHandout(ctx, ctx.cmd.handoutId);
  const pick = (k) => (ctx.cmd[k] !== undefined ? ctx.cmd[k] : ho[k]);
  const { title, data } = normalizeHandout({ title: pick('title'), text: pick('text'), image: pick('image'), dmNotes: pick('dmNotes') });
  Object.assign(ho, { title }, data);
});

def('handout.setScenes', { who: 'dm' }, (ctx) => {
  setHandoutScenes(ctx, getHandout(ctx, ctx.cmd.handoutId), ctx.cmd.sceneIds);
});

def('handout.reveal', { who: 'dm' }, (ctx) => {
  const ho = getHandout(ctx, ctx.cmd.handoutId);
  if (ho.revealed) return;
  ho.revealed = true;
  ctx.log('handout', `📜 The DM shared "${ho.title}"`, { data: { handoutId: ho.id } });
});

def('handout.hide', { who: 'dm' }, (ctx) => {
  const ho = getHandout(ctx, ctx.cmd.handoutId);
  if (!ho.revealed) return;
  ho.revealed = false;
  ctx.log('handout', '', { dmText: `DM hid handout "${ho.title}" from players`, dmOnly: true });
});

def('handout.remove', { who: 'dm' }, (ctx) => {
  const ho = getHandout(ctx, ctx.cmd.handoutId);
  delete ctx.state.handouts[ho.id];
  ctx.state.handoutOrder = ctx.state.handoutOrder.filter((h) => h !== ho.id);
  ctx.log('handout', '', { dmText: `DM removed handout "${ho.title}"`, dmOnly: true });
});

// ---------- adventures ----------

// Sets up a fresh game from a built-in adventure: every scene in order, every handout, then the
// start scene. Everything is resolved before anything changes, so a broken adventure fails whole.
def('adventure.load', { who: 'dm', clearsUndo: true }, (ctx) => {
  const adv = ctx.adventures?.get(ctx.cmd.adventureId);
  if (!adv) fail('Unknown adventure');
  if (ctx.state.sceneOrder.length || ctx.state.handoutOrder.length) fail('Adventures can only be loaded into an empty game');
  const scenes = adv.scenes.map((s) => {
    const tpl = ctx.templates.get(s.template);
    if (!tpl) fail(`This adventure needs the scene "${s.template}", which doesn't exist`);
    return { ...s, tpl };
  });
  const handouts = adv.handouts.map((entry) => {
    const ho = ctx.handouts?.get(entry.id);
    if (!ho) fail(`This adventure needs the handout "${entry.id}", which doesn't exist`);
    return { ho, scenes: entry.scenes ?? [], revealed: !!entry.revealed };
  });
  const ids = {};
  for (const s of scenes) ids[s.key] = addSceneFromTemplate(ctx, s.tpl, s.name ?? null).id;
  for (const s of scenes) {
    if (s.next?.length) ctx.state.scenes[ids[s.key]].next = s.next.map((key) => ids[key]);
  }
  for (const { ho, scenes: keys, revealed } of handouts) {
    const copy = addHandout(ctx, normalizeHandout({ title: ho.title, ...ho.data }), ho.id);
    if (keys.length) copy.sceneIds = keys.map((k) => ids[k]);
    // Revealed from the start: no "shared" feed row, since nobody has joined yet.
    if (revealed) copy.revealed = true;
  }
  const start = adv.startScene ? ids[adv.startScene] : ids[scenes[0].key];
  ctx.state.activeSceneId = start;
  ensurePlaced(ctx.state, start);
  ctx.log('scene', '', { dmText: `DM loaded the adventure "${adv.name}"`, dmOnly: true });
  ctx.log('scene', `The party enters ${ctx.state.scenes[start].name}`);
  return { sceneIds: Object.values(ids) };
});

// ---------- entities (DM) ----------

def('entity.spawn', { who: 'dm', undoable: 'spawn' }, (ctx) => {
  const { kind, defId } = ctx.cmd;
  if (kind !== 'npc' && kind !== 'monster') fail('Can only spawn NPCs or monsters');
  const d = ctx.content.def(kind, defId);
  if (!d) fail('Unknown definition');
  const scope = ctx.cmd.scope === 'game' ? 'game' : 'scene';
  const sceneId = ctx.cmd.sceneId ?? ctx.state.activeSceneId;
  if (scope === 'scene' && !ctx.state.scenes[sceneId]) fail('Pick a scene first');
  const e = entityFromDef(d, kind, { scope, sceneId: scope === 'scene' ? sceneId : null, z: ++ctx.state.zCounter });
  const scene = ctx.state.scenes[sceneId];
  if (scene && ctx.cmd.x !== undefined && inBounds(scene, ctx.cmd.x, ctx.cmd.y, e.size)) {
    e.positions[sceneId] = { x: ctx.cmd.x, y: ctx.cmd.y };
  }
  e.name = numberedName(ctx, d, kind);
  ctx.state.entities[e.id] = e;
  if (scene) ensurePlaced(ctx.state, sceneId);
  ctx.log('spawn', `${e.name} appears`, { dmText: `DM spawned ${e.name} (${scope} scope)` });
  return { entityId: e.id };
});

def('entity.remove', { who: 'dm', undoable: 'remove' }, (ctx) => {
  const e = getEntity(ctx, ctx.cmd.entityId);
  if (e.kind === 'pc') fail('Use Reset Player to release a player character');
  delete ctx.state.entities[e.id];
  delete ctx.state.turn[e.id];
  ctx.log('spawn', `${e.name} is gone`, { dmText: `DM removed ${e.name}` });
});

def('entity.setScope', { who: 'dm', undoable: 'scope change' }, (ctx) => {
  const e = getEntity(ctx, ctx.cmd.entityId);
  if (e.kind === 'pc') fail('Player characters always follow the party');
  const scope = ctx.cmd.scope;
  if (scope === e.scope) return;
  if (scope === 'game') {
    e.scope = 'game';
    e.sceneId = null;
  } else if (scope === 'scene') {
    const sceneId = ctx.cmd.sceneId ?? ctx.state.activeSceneId;
    if (!ctx.state.scenes[sceneId]) fail('Pick a scene to leave them in');
    e.scope = 'scene';
    e.sceneId = sceneId;
    ensurePlaced(ctx.state, sceneId);
  } else fail('Scope must be "scene" or "game"');
  ctx.log('scope', `DM made ${e.name} ${scope === 'game' ? 'follow the party (game scope)' : `stay in ${ctx.state.scenes[e.sceneId].name} (scene scope)`}`, { dmOnly: true });
});

def('entity.setHostile', { who: 'dm' }, (ctx) => {
  const e = getEntity(ctx, ctx.cmd.entityId);
  if (e.kind === 'pc') fail('Player characters are always friendly');
  e.hostile = !!ctx.cmd.hostile;
  ctx.log('entity', `DM marked ${e.name} as ${e.hostile ? 'hostile' : 'friendly'}`, { dmOnly: true });
});

def('entity.rename', { who: 'dm' }, (ctx) => {
  const e = getEntity(ctx, ctx.cmd.entityId);
  e.name = str(ctx.cmd.name, 40, 'Name');
});

def('entity.damage', { who: 'dm', undoable: 'damage' }, (ctx) => {
  const e = getEntity(ctx, ctx.cmd.entityId);
  const amount = int(ctx.cmd.amount, 'Damage', 0, 1_000_000);
  if (e.kind === 'object') fail(`${e.name} is an object and can't take damage`);
  const d = dealDamage(ctx, { target: e, raw: amount, color: ctx.actorColor });
  const notes = d.notes.length ? ` (${d.raw}, ${d.notes.join(', ')})` : '';
  const v = d.victim;
  const text = `${v.name} takes ${d.dealt} damage${notes}.${statusSuffix(v, d.change)}`;
  const t = hpTexts(v);
  ctx.log('damage', text + t.pub, { dmText: text + t.dm, data: { targetId: v.id, dealt: d.dealt } });
});

def('entity.heal', { who: 'dm', undoable: 'heal' }, (ctx) => {
  const e = getEntity(ctx, ctx.cmd.entityId);
  const amount = int(ctx.cmd.amount, 'Healing', 0, 10000);
  requireMortal(e);
  if (e.status === 'dead') fail(`${e.name} is dead — revive them first`);
  const change = applyHeal(e, amount);
  ctx.fx({ kind: 'heal', entityId: e.id, text: `+${change.healed}`, color: ctx.actorColor });
  const t = hpTexts(e);
  const text = `${e.name} is healed for ${change.healed}.${statusSuffix(e, change)}`;
  ctx.log('heal', text + t.pub, { dmText: text + t.dm });
});

// DM HP tools. Max HP is applied before HP, so one command can raise both ("20 / 20").
// HP above max or below the death line (-max HP; 0 for monsters) is refused rather than silently
// capped; blank fields are refused, never 0.
function applyHealth(ctx, e, { hp, maxHp }) {
  requireMortal(e);
  if (hp === undefined && maxHp === undefined) fail('Enter HP or max HP');
  const before = { hp: e.hp, maxHp: e.maxHp, status: e.status };
  if (maxHp !== undefined) {
    e.maxHp = int(maxHp, 'Max HP', 1, 100000);
    e.hp = Math.max(deathAt(e), Math.min(e.hp, e.maxHp));
  }
  if (hp !== undefined) {
    const value = int(hp, 'HP', -100000, 100000);
    if (value > e.maxHp) fail(`HP can't be more than max HP (${e.maxHp}) — raise max HP too`);
    if (value < deathAt(e)) fail(`HP can't go below ${deathAt(e)}${e.kind === 'monster' ? ' for a monster' : ` (−max HP)`}`);
    setHp(e, value);
  }
  const t = hpTexts(e);
  const suffix = statusSuffix(e, { before: before.status, after: e.status });
  const what = [maxHp !== undefined && e.maxHp !== before.maxHp ? 'max HP' : null, hp !== undefined ? 'HP' : null].filter(Boolean).join(' and ') || 'HP';
  ctx.log('hp', `DM adjusted ${e.name}.${suffix}${t.pub}`, { dmText: `DM set ${e.name} ${what}.${suffix}${t.dm}` });
}

def('entity.setHealth', { who: 'dm', undoable: 'set HP' }, (ctx) => {
  applyHealth(ctx, getEntity(ctx, ctx.cmd.entityId), { hp: ctx.cmd.hp, maxHp: ctx.cmd.maxHp });
});

def('entity.setHp', { who: 'dm', undoable: 'set HP' }, (ctx) => {
  applyHealth(ctx, getEntity(ctx, ctx.cmd.entityId), { hp: ctx.cmd.hp ?? null });
});

def('entity.setMaxHp', { who: 'dm', undoable: 'set max HP' }, (ctx) => {
  applyHealth(ctx, getEntity(ctx, ctx.cmd.entityId), { maxHp: ctx.cmd.maxHp ?? null });
});

def('entity.kill', { who: 'dm', undoable: 'kill' }, (ctx) => {
  const e = getEntity(ctx, ctx.cmd.entityId);
  requireMortal(e);
  kill(e);
  ctx.log('death', e.kind === 'monster' ? `${e.name} is slain!` : `${e.name} has DIED!`);
});

def('entity.revive', { who: 'dm', undoable: 'revive' }, (ctx) => {
  const e = getEntity(ctx, ctx.cmd.entityId);
  requireMortal(e);
  if (e.status === 'active') fail(`${e.name} is not down or dead`);
  revive(e);
  const t = hpTexts(e);
  ctx.log('revive', `${e.name} is revived!${t.pub}`, { dmText: `${e.name} is revived!${t.dm}` });
});

def('entity.setStatus', { who: 'dm', undoable: 'status override' }, (ctx) => {
  const e = getEntity(ctx, ctx.cmd.entityId);
  const status = ctx.cmd.status;
  if (!['active', 'down', 'dead'].includes(status)) fail('Unknown status');
  requireMortal(e);
  e.status = status;
  if (status === 'active') e.hp = Math.max(1, e.hp);
  else if (status === 'down') e.hp = Math.max(deathAt(e) + 1, Math.min(e.hp, 0));
  else e.hp = deathAt(e);
  ctx.log('hp', `DM set ${e.name} to ${status.toUpperCase()}`);
});

def('entity.grantAction', { who: 'dm' }, (ctx) => {
  const e = getEntity(ctx, ctx.cmd.entityId);
  turnFor(ctx.state, e.id).bonus += 1;
  ctx.log('action', `DM grants ${e.name} an extra action`);
});

// DM overrides for live effects and checks.
def('effect.remove', { who: 'dm', undoable: 'remove effect' }, (ctx) => {
  const e = getEntity(ctx, ctx.cmd.entityId);
  const fx = removeEffect(e, ctx.cmd.effectId);
  if (!fx) fail('That effect already ended');
  ctx.log('effect', `${fx.label} on ${e.name} ends`, { dmText: `DM removed ${fx.label} from ${e.name}` });
});

def('effect.addStatus', { who: 'dm', undoable: 'add status' }, (ctx) => {
  const e = getEntity(ctx, ctx.cmd.entityId);
  const st = STATUSES[ctx.cmd.status];
  if (!st) fail('Pick frightened, poisoned, snared, shaken or slowed');
  if (e.kind === 'object') fail('Objects have no statuses');
  // Frightened needs a source on the map (picked by the DM): it's what the creature can't approach.
  let src = null;
  if (ctx.cmd.status === 'frightened') {
    if (!ctx.cmd.sourceId) fail(`Choose who ${e.name} is frightened of`);
    src = getEntity(ctx, ctx.cmd.sourceId);
    if (src.id === e.id) fail("A creature can't be frightened of itself");
    if (src.kind === 'object') fail("Objects can't frighten anyone");
  }
  if (st.duration) clearStatus(e, ctx.cmd.status);
  addEffect(ctx.state, e, {
    type: st.movement ? 'modify_movement' : 'apply_status', status: ctx.cmd.status, label: st.label, icon: st.icon,
    source: src ? { entityId: src.id, name: src.name } : { entityId: null, name: 'DM' },
    params: src ? { sourceId: src.id } : st.movement ? { amount: st.movement } : {}, duration: st.duration ?? 'next_dm_phase',
  });
  ctx.log('effect', src ? `${e.name} is frightened of ${src.name}` : `${e.name} is ${st.label.toLowerCase()}`);
});

def('check.resolve', { who: 'dm', undoable: 'check' }, (ctx) => resolveCheck(ctx, ctx.cmd.checkId, !!ctx.cmd.success));

def('entity.resetDummy', { who: 'dm' }, (ctx) => {
  const e = getEntity(ctx, ctx.cmd.entityId);
  if (!e.immortal) fail('Only training dummies keep a damage counter');
  e.damageTaken = 0;
  e.hits = 0;
  ctx.log('dummy', `${e.name}'s damage counter was reset`);
});

def('item.add', { who: 'dm', undoable: 'add item' }, (ctx) => {
  const e = getEntity(ctx, ctx.cmd.entityId);
  const item = makeItem(str(ctx.cmd.name, 60, 'Item name'));
  e.inventory.push(item);
  ctx.log('item', `${e.name} received ${item.name}`, { dmOnly: !isFriendly(e) });
});

def('item.remove', { who: 'dm', undoable: 'remove item' }, (ctx) => {
  const e = getEntity(ctx, ctx.cmd.entityId);
  const idx = e.inventory.findIndex((i) => i.id === ctx.cmd.itemId);
  if (idx < 0) fail('Item not found');
  const [item] = e.inventory.splice(idx, 1);
  ctx.log('item', `DM removed ${item.name} from ${e.name}`, { dmOnly: true });
});

// ---------- gameplay (players and DM) ----------

def('move', { who: 'any', undoable: 'move' }, (ctx) => {
  const e = controlled(ctx, ctx.cmd.entityId);
  const scene = onActiveScene(ctx, e);
  const x = Number(ctx.cmd.x), y = Number(ctx.cmd.y);
  if (!inBounds(scene, x, y, e.size)) fail('You cannot move there');
  const from = e.positions[scene.id];
  const c = ctx.state.combat;
  // DM "force" moves skip every restriction (override). Otherwise players, and enemies moved by
  // the DM in combat, spend movement (after slows/snares) and respect frightened.
  const force = ctx.actor.role === 'dm' && ctx.cmd.force === true;
  if (ctx.actor.role === 'player') {
    requireStatus(e, 'move');
    requirePlayerWindow(ctx);
  }
  if (!force && from) {
    const paying = c.active && (ctx.actor.role === 'player' || !isFriendly(e));
    if (paying) {
      const dist = Math.max(Math.abs(x - from.x), Math.abs(y - from.y));
      const t = turnFor(ctx.state, e.id);
      const allowance = movementAllowance(e);
      if (t.moved + dist > allowance) {
        fail(`${ctx.actor.role === 'dm' ? `${e.name} has` : 'Not enough movement:'} ${Math.max(0, allowance - t.moved)} squares left${ctx.actor.role === 'dm' ? ' (Shift-drag to force)' : ''}`);
      }
      t.moved += dist;
      // Players can take this move back (move.undo) until they act.
      if (ctx.actor.role === 'player') (t.moves ??= []).push({ sceneId: scene.id, from: { ...from }, to: { x, y }, dist });
    }
    const src = frightenedBy(ctx, e, scene.id, x, y);
    if (src) fail(`${e.name} is frightened of ${src.name} and can't move closer${ctx.actor.role === 'dm' ? ' (Shift-drag to force)' : ''}`);
  }
  if (from && from.x === x && from.y === y) return;
  // The DM moving a hero locks in that hero's earlier moves (they can't be undone past it).
  if (ctx.actor.role === 'dm' && ctx.state.turn[e.id]) ctx.state.turn[e.id].moves = [];
  e.positions[scene.id] = { x, y };
  e.z = ++ctx.state.zCounter;
  ctx.log('move', `${e.name} ${force ? 'is moved' : 'moves'}`);
});

// A player takes back their latest move this phase and gets the squares back. Combat only;
// acting (spendAction) or the phase ending locks moves in. Refused if something else moved them.
def('move.undo', { who: 'player', undoable: 'undo move' }, (ctx) => {
  const e = controlled(ctx, ctx.cmd.entityId);
  const scene = onActiveScene(ctx, e);
  requireStatus(e, 'move');
  if (!ctx.state.combat.active) fail('Undo move only works in combat');
  requirePlayerWindow(ctx);
  const t = turnFor(ctx.state, e.id);
  const last = t.moves?.at(-1);
  if (!last) fail('Nothing to undo');
  const pos = e.positions[scene.id];
  // Safety net (DM moves and actions clear the history already): never jump from somewhere else.
  if (last.sceneId !== scene.id || !pos || pos.x !== last.to.x || pos.y !== last.to.y) {
    fail('You were moved since then, so that move can\'t be undone');
  }
  t.moves.pop();
  e.positions[scene.id] = { ...last.from };
  e.z = ++ctx.state.zCounter;
  t.moved = Math.max(0, t.moved - last.dist);
  ctx.log('move', `${e.name} takes back their move`);
});

def('attack', { who: 'any', undoable: 'attack' }, (ctx) => {
  const e = controlled(ctx, ctx.cmd.entityId);
  onActiveScene(ctx, e);
  const c = ctx.state.combat;
  if (!c.active) fail('Attacks are only available in combat');
  requireStatus(e, 'attack');
  requireActionWindow(ctx, e);
  checkAction(ctx, e);
  const attack = e.attacks.find((a) => a.id === ctx.cmd.attackId);
  if (!attack) fail('Unknown attack');
  const target = getEntity(ctx, ctx.cmd.targetId);
  if (target.id === e.id) fail('You cannot attack yourself');
  if (target.kind === 'object') fail(`${target.name} can't be attacked`);
  // Players can only attack the other side; the DM may still force friendly fire.
  if (ctx.actor.role === 'player' && !areEnemies(e, target)) fail(`${target.name} is not an enemy`);
  onActiveScene(ctx, target);
  if (target.status === 'dead') fail(`${target.name} is already dead`);
  const range = Number(attack.range) || 1;
  const dist = distanceBetween(ctx, e, target);
  if (dist > range) fail(`${target.name} is out of range (${dist} > ${range})`);
  checkTaunt(ctx, e, target);
  spendAction(ctx, e);

  const s = strike(ctx, { attacker: e, target, attack, color: ctx.actorColor });
  const head = `${e.name} uses ${attack.name} on ${target.name}: ${s.roll.text}`;
  const data = { strikes: [{ targetId: target.id, victimId: s.victim.id, hit: s.hit, crit: s.crit, dealt: s.dealt }] };
  if (!s.hit) {
    ctx.log('attack', `${head} — ${outcome('MISS')}`, { dmText: `${head} vs DEF ${s.roll.defense} — ${outcome('MISS')}`, data });
    return { hit: false };
  }
  const v = s.victim;
  const via = v !== target ? ` (${s.notes.find((n) => n.startsWith('intercepted')) ?? `hits ${v.name}`})` : '';
  const notes = s.notes.filter((n) => !n.startsWith('intercepted'));
  const tail = `${outcome(s.crit ? 'CRITICAL HIT' : 'HIT')} for ${s.dealt} (${s.dmg.text}${notes.length ? `, ${notes.join(', ')}` : ''})${via}.${s.suffix}`;
  const t = hpTexts(v);
  ctx.log('attack', `${head} — ${tail}${t.pub}`, { dmText: `${head} vs DEF ${s.roll.defense} — ${tail}${t.dm}`, data });
  return { hit: true, crit: s.crit, damage: s.dealt };
});

def('act', { who: 'any', undoable: 'act' }, (ctx) => {
  const e = controlled(ctx, ctx.cmd.entityId);
  onActiveScene(ctx, e);
  requireStatus(e, 'act');
  requireActionWindow(ctx, e);
  let name, roll;
  if (ctx.cmd.actId) {
    const a = ctx.content.act(ctx.cmd.actId);
    if (!a) fail('Unknown act');
    name = a.name;
    roll = a.roll;
  } else {
    name = str(ctx.cmd.text, 80, 'Action');
    roll = ctx.cmd.roll || null;
  }
  if (roll && !isValidDice(roll)) fail(`Invalid roll "${roll}"`);
  const target = ctx.cmd.targetId ? ctx.state.entities[ctx.cmd.targetId] : null;
  spendAction(ctx, e);
  const r = roll ? rollOrFail(roll, ctx) : null;
  const on = target ? ` on ${target.name}` : '';
  ctx.log('act', `${e.name}: ${name}${on}${r ? ` — rolls ${roll}: ${r.text}` : ''}`);
});

// All abilities (heroes, NPCs, monsters) run through the shared effect engine.
def('ability', { who: 'any', undoable: 'ability' }, (ctx) => activateAbility(ctx));

// Items with a catalog ability (data/items.json) run it with the picked target, and are only
// consumed once it resolves; any failure (range, target, actions) keeps the item. Other items are
// simply used up.
def('item.use', { who: 'player', undoable: 'use item' }, (ctx) => {
  const e = controlled(ctx, ctx.cmd.entityId);
  onActiveScene(ctx, e);
  requireStatus(e, 'use items');
  requirePlayerWindow(ctx);
  const idx = e.inventory.findIndex((i) => i.id === ctx.cmd.itemId);
  if (idx < 0) fail('Item not found');
  const catalog = ctx.content.item(e.inventory[idx]);
  if (catalog?.ability) {
    const item = e.inventory[idx];
    const result = runAbility(ctx, e, { ...catalog.ability, id: catalog.id, name: item.name }, { item });
    e.inventory.splice(e.inventory.indexOf(item), 1);
    return result;
  }
  spendAction(ctx, e);
  const [item] = e.inventory.splice(idx, 1);
  const target = ctx.cmd.targetId ? ctx.state.entities[ctx.cmd.targetId] : null;
  ctx.log('item', `${e.name} uses ${item.name}${target && target.id !== e.id ? ` on ${target.name}` : ''}`);
});

// Bleed-out roll bands, checked in order against a d20. Bleed is a fraction of max HP.
const DOWN_ROLL = [
  { max: 3, bleed: 0.25 },
  { max: 9, bleed: 0.10 },
  { max: 17, bleed: 0 },
  { max: 20, getUp: true },
];

// A downed character's only option: a d20 bleed-out roll. It can get them back up at 1 HP, hold
// them steady, or bleed HP toward -max HP (true death). The bleed skips tank reduction and shields.
def('downRoll', { who: 'player' }, (ctx) => {
  const e = controlled(ctx, ctx.cmd.entityId);
  if (e.status !== 'down') fail('Only downed characters make this roll');
  requirePlayerWindow(ctx);
  spendAction(ctx, e);
  const r = rollOrFail('1d20', ctx);
  const band = DOWN_ROLL.find((b) => r.total <= b.max);
  const head = `${e.name} (DOWN) rolls ${r.total} —`;
  let text;
  if (band.getUp) {
    const change = applyHeal(e, 1);
    ctx.fx({ kind: 'heal', entityId: e.id, text: `+${change.healed}`, color: ctx.actorColor });
    text = `${head} gets back up with 1 HP!`;
  } else if (band.bleed) {
    const amount = Math.max(1, Math.ceil(e.maxHp * band.bleed));
    const change = applyDamage(e, amount);
    ctx.fx({ kind: 'damage', entityId: e.id, text: `-${amount}`, color: ctx.actorColor });
    text = `${head} bleeds ${amount}.${statusSuffix(e, change)}`;
  } else {
    text = `${head} holds on.`;
  }
  const t = hpTexts(e);
  ctx.log('roll', text + t.pub, { dmText: text + t.dm });
});

def('roll', { who: 'any' }, (ctx) => {
  const expr = str(ctx.cmd.expr, 40, 'Dice');
  const r = rollOrFail(expr, ctx);
  const secret = ctx.actor.role === 'dm' && ctx.cmd.secret;
  ctx.log('roll', `${ctx.actorName} rolls ${r.expr}: ${r.text}`, secret ? { dmOnly: true } : {});
});

// ---------- combat ----------

def('combat.start', { who: 'dm', clearsUndo: true }, (ctx) => {
  if (ctx.state.combat.active) fail('Combat is already running');
  startCombat(ctx.state, ctx.now);
  ctx.log('combat', '⚔️ COMBAT BEGINS — PLAYER PHASE (round 1)');
  onPhaseTransition(ctx, 'start');
});

def('combat.end', { who: 'dm', clearsUndo: true }, (ctx) => {
  if (!ctx.state.combat.active) fail('Combat is not running');
  endCombat(ctx.state);
  ctx.log('combat', 'Combat ends');
  onPhaseTransition(ctx, 'end');
});

function logPhase(ctx, prefix = '') {
  const c = ctx.state.combat;
  ctx.log('phase', `${prefix}${c.phase === 'player' ? 'PLAYER PHASE' : 'DM PHASE'} (round ${c.round})`);
}

def('combat.advance', { who: 'dm', clearsUndo: true }, (ctx) => {
  if (!ctx.state.combat.active) fail('Combat is not running');
  advancePhase(ctx.state, ctx.now);
  logPhase(ctx);
  onPhaseTransition(ctx, 'advance');
});

def('combat.timerExpired', { who: 'system', clearsUndo: true }, (ctx) => {
  const c = ctx.state.combat;
  if (!c.active || !c.phaseEndsAt || c.phaseEndsAt !== ctx.cmd.phaseEndsAt) fail('stale timer');
  advancePhase(ctx.state, ctx.now);
  logPhase(ctx, "⏰ Time's up! ");
  onPhaseTransition(ctx, 'advance');
});

def('combat.setTimer', { who: 'dm' }, (ctx) => {
  const seconds = int(ctx.cmd.seconds, 'Timer', 0, 3600);
  const c = ctx.state.combat;
  c.timerSeconds = seconds;
  if (c.active) c.phaseEndsAt = seconds > 0 ? ctx.now + seconds * 1000 : null;
  c.pausedMs = null;
  ctx.log('combat', seconds ? `Phase timer set to ${seconds}s` : 'Phase timer off', { dmOnly: !c.active });
});

// A shell whose phase clock depends on the DM (the cloud shell, where the DM's browser drives it)
// stops the timer while the DM is away (disconnected, or idle for several rounds) and restarts it
// with the same time left when they're back. The self-hosted server keeps its own clock and never
// sends these.
def('combat.timerPause', { who: 'system' }, (ctx) => {
  const c = ctx.state.combat;
  if (!c.active || !c.phaseEndsAt) fail('No phase timer is running');
  c.pausedMs = Math.max(0, c.phaseEndsAt - ctx.now);
  c.phaseEndsAt = null;
  ctx.log('combat', '⏸ Timer paused — waiting for the DM');
});

def('combat.timerResume', { who: 'system' }, (ctx) => {
  const c = ctx.state.combat;
  if (!c.active || c.pausedMs == null) fail('The phase timer is not paused');
  c.phaseEndsAt = ctx.now + c.pausedMs;
  c.pausedMs = null;
  ctx.log('combat', '▶ The DM is back — timer resumed');
});

export { entitiesInScene };
