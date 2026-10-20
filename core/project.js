import { entitiesInScene, actionAllowance, isFriendly } from './state.js';
import { movementAllowance } from './status.js';
import { normalizeAbility, targetingOf, dealsDamage } from './effects.js';

// Abilities as the client needs them: canonical schema plus the server-computed targeting.
const abilitiesView = (list) => (list ?? []).map((a) => ({ ...normalizeAbility(a), targeting: targetingOf(a), combatOnly: dealsDamage(a) }));

// Labels and icons of live effects; magnitudes stay on the server.
const effectsView = (e) => (e.effects ?? []).map((fx) => ({ id: fx.id, icon: fx.icon, label: fx.label, status: fx.status, source: fx.source?.name ?? null }));

function allowances(state, e) {
  const t = state.turn[e.id];
  return { actions: actionAllowance(e, t), movement: movementAllowance(e) };
}

// heroName: the live name of the hero they play (players can rename it), shown on its token anyway.
function publicPlayer(p, presence, state) {
  return {
    id: p.id, name: p.name, color: p.color, characterId: p.characterId, entityId: p.entityId,
    heroName: state.entities[p.entityId]?.name ?? null, presence: presence(p.id),
  };
}

// Who has gone this phase, for the DM's counter. PLAYER PHASE: heroes and friendly NPCs; DM PHASE:
// monsters and hostile NPCs. A creature is done at 0 actions left. Dead creatures, objects,
// training dummies, downed NPCs/monsters (they can't act) and anyone with no actions are left out;
// downed heroes count, since their down roll is their action.
export function turnProgress(state) {
  const c = state.combat;
  if (!c.active || !state.activeSceneId) return null;
  const party = c.phase === 'player';
  const counted = [];
  for (const e of entitiesInScene(state, state.activeSceneId)) {
    if (e.kind === 'object' || e.immortal || e.status === 'dead') continue;
    if (party ? !(e.kind === 'pc' || (e.kind === 'npc' && isFriendly(e))) : isFriendly(e)) continue;
    if (e.status === 'down' && e.kind !== 'pc') continue;
    const t = state.turn[e.id];
    const allowance = actionAllowance(e, t);
    if (allowance <= 0) continue;
    counted.push({ id: e.id, name: e.name, kind: e.kind, left: Math.max(0, allowance - (t?.actions ?? 0)) });
  }
  const pending = counted.filter((x) => x.left > 0)
    .sort((a, b) => (a.kind === 'pc' ? 0 : 1) - (b.kind === 'pc' ? 0 : 1) || a.name.localeCompare(b.name))
    .map(({ id, name, left }) => ({ id, name, left }));
  return { side: party ? 'party' : 'enemies', done: counted.length - pending.length, total: counted.length, pending };
}

export function projectForDm(state, presence) {
  const { players, ...rest } = state;
  const view = structuredClone(rest);
  for (const e of Object.values(view.entities)) {
    e.abilities = abilitiesView(e.abilities);
    e.allowance = allowances(state, state.entities[e.id]);
  }
  view.pendingChecks ??= [];
  return {
    role: 'dm',
    ...view,
    players: Object.values(players).map((p) => publicPlayer(p, presence, state)),
    turnProgress: turnProgress(state),
  };
}

function entityView(e, sceneId, viewerPlayerId, state) {
  const v = {
    id: e.id, kind: e.kind, defId: e.defId, name: e.name, role: e.role, image: e.image, size: e.size,
    status: e.status, hostile: e.hostile, z: e.z, ownerPlayerId: e.ownerPlayerId, scope: e.scope,
    position: e.positions[sceneId] ?? null,
    effects: effectsView(e),
  };
  if (e.immortal) Object.assign(v, { immortal: true, damageTaken: e.damageTaken ?? 0, hits: e.hits ?? 0 });
  if (e.kind === 'object') Object.assign(v, { temporary: !!e.temporary, icon: e.icon ?? null });
  // Players only ever see PC HP: an NPC can turn hostile mid-scene, so its HP is never revealed.
  if (e.kind === 'pc') {
    v.hp = e.hp;
    v.maxHp = e.maxHp;
  }
  if (viewerPlayerId && e.ownerPlayerId === viewerPlayerId) {
    Object.assign(v, structuredClone({
      defense: e.defense, movement: e.movement, actionsPerPhase: e.actionsPerPhase ?? 1, attacks: e.attacks, inventory: e.inventory,
    }), { abilities: abilitiesView(e.abilities), allowance: allowances(state, e) });
  }
  return v;
}

// Player view: only the active scene, and no HP/stats for hostile creatures.
export function projectForPlayer(state, playerId, presence) {
  const me = state.players[playerId];
  const sceneId = state.activeSceneId;
  const scene = sceneId ? state.scenes[sceneId] : null;
  const taken = {};
  for (const p of Object.values(state.players)) if (p.characterId) taken[p.characterId] = p.id;
  return {
    role: 'player',
    game: { id: state.id, name: state.name },
    me: me ? publicPlayer(me, presence, state) : null,
    players: Object.values(state.players).map((p) => publicPlayer(p, presence, state)),
    takenCharacters: taken,
    options: { playersCanLeave: !!state.options?.playersCanLeave },
    combat: structuredClone(state.combat),
    turn: me?.entityId ? structuredClone(state.turn[me.entityId] ?? null) : null,
    // Without the DM's branching links (next), so players can't see where the party might go.
    scene: scene ? (({ next, ...pub }) => structuredClone(pub))(scene) : null,
    // Only handouts the DM has revealed, without DM notes or where they came from. forScene: tied
    // to the active scene (the other scene ids stay private, like scene links).
    handouts: (state.handoutOrder ?? []).map((id) => state.handouts[id]).filter((ho) => ho?.revealed)
      .map(({ id, title, text, image, sceneIds }) => ({ id, title, text, image, forScene: !!(sceneId && sceneIds?.includes(sceneId)) })),
    entities: scene ? entitiesInScene(state, sceneId).map((e) => entityView(e, sceneId, playerId, state)) : [],
  };
}

// What one viewer sees of a Game Feed row: DM-only rows are dropped for players, the DM gets the
// DM text (which may include hidden HP), and nothing private is otherwise attached.
export function feedForRole(row, role) {
  if (row.visibility === 'dm' && role !== 'dm') return null;
  const text = role === 'dm' && row.dmText ? row.dmText : row.text;
  if (!text) return null;
  const out = { id: row.id, ts: row.ts, kind: row.kind, type: row.type, text, color: row.color };
  if (row.kind === 'chat') Object.assign(out, { name: row.name, playerId: row.playerId });
  if (row.data) out.data = row.data;
  if (row.visibility === 'dm') out.dmOnly = true;
  return out;
}
