import { randomBytes } from 'node:crypto';

// Ten accessible, mutually distinct player colors (tuned for a dark UI). Red is left out on
// purpose: enemies are drawn in red. Keep in sync with PLAYER_COLORS in client/js/common.js.
export const PLAYER_COLORS = [
  '#3cb44b', // green
  '#4363d8', // blue
  '#f58231', // orange
  '#911eb4', // purple
  '#42d4f4', // cyan
  '#f032e6', // magenta
  '#bfef45', // lime
  '#fabed4', // pink
  '#ffe119', // yellow
  '#469990', // teal
];
export const DM_COLOR = '#d4af37';

// Brings a saved game up to date with the current rules. Players whose color is no longer in the
// bank (red, removed) get the first free one; games from before game options or handouts get the
// defaults.
// Returns true if anything changed.
export function upgradeState(state) {
  let changed = false;
  if (state.options?.playersCanLeave === undefined) {
    state.options = { ...state.options, playersCanLeave: false };
    changed = true;
  }
  if (!state.handouts || !state.handoutOrder) {
    state.handouts ??= {};
    state.handoutOrder ??= [];
    changed = true;
  }
  if (state.combat && state.combat.pausedMs === undefined) {
    state.combat.pausedMs = null;
    changed = true;
  }
  const players = Object.values(state.players ?? {});
  for (const p of players) {
    if (PLAYER_COLORS.includes(p.color)) continue;
    const used = new Set(players.map((o) => o.color));
    const free = PLAYER_COLORS.find((c) => !used.has(c));
    if (!free) continue;
    p.color = free;
    changed = true;
  }
  return changed;
}

export class GameError extends Error {}
export const fail = (msg) => { throw new GameError(msg); };

export const newId = (prefix) => `${prefix}_${randomBytes(4).toString('hex')}`;
export const randomToken = (bytes = 16, encoding = 'hex') => randomBytes(bytes).toString(encoding);

export function createGameState({ id, name, joinToken }) {
  return {
    id,
    name,
    joinToken,
    players: {},
    scenes: {},
    sceneOrder: [],
    activeSceneId: null,
    entities: {},
    zCounter: 0,
    combat: { active: false, phase: null, round: 0, timerSeconds: 0, phaseEndsAt: null, pausedMs: null },
    turn: {},
    // Handouts copied into this game (core/handouts.js), in the DM's list order.
    handouts: {},
    handoutOrder: [],
    // Per-game switches the DM can flip mid-game (game.setOption).
    options: { playersCanLeave: false },
  };
}

// Entities that are on the board of a given scene instance.
export function entitiesInScene(state, sceneId) {
  return Object.values(state.entities).filter((e) => e.scope === 'game' || e.sceneId === sceneId);
}

export function isFriendly(entity) {
  return entity.kind === 'pc' || (entity.kind === 'npc' && !entity.hostile);
}

// Sides for targeting: the party (PCs and friendly NPCs) versus foes (monsters, hostile NPCs).
// Objects (barriers, totems) belong to no side and are never targets.
export function sideOf(e) {
  if (!e || e.kind === 'object') return null;
  return isFriendly(e) ? 'party' : 'foe';
}
export const areEnemies = (a, b) => !!sideOf(a) && !!sideOf(b) && sideOf(a) !== sideOf(b);
export const areAllies = (a, b) => !!sideOf(a) && sideOf(a) === sideOf(b);

// Chebyshev distance between two rectangular footprints (0 = overlapping/adjacent cells share space).
export function footprintDistance(a, sa, b, sb) {
  const dx = Math.max(0, b.x - (a.x + sa.w - 1), a.x - (b.x + sb.w - 1));
  const dy = Math.max(0, b.y - (a.y + sa.h - 1), a.y - (b.y + sb.h - 1));
  return Math.max(dx, dy);
}

export function prettyItemName(id) {
  return String(id).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// defId links the entry to the item catalog (data/items.json) when it came from a definition id.
export function makeItem(name, defId = null) {
  return { id: newId('i'), name: String(name).trim().slice(0, 60), ...(defId ? { defId } : {}) };
}

// Builds a live entity instance from a bank/character definition. The definition is
// deep-copied so instance changes never touch the reusable definition.
export function entityFromDef(def, kind, extra = {}) {
  // Training dummies (immortal) have no HP at all: damage is recorded, never subtracted.
  const immortal = def.immortal === true;
  const maxHp = immortal ? null : Math.max(1, Number(def.maxHp) || 10);
  return {
    id: newId('e'),
    kind,
    defId: def.id,
    name: def.name,
    role: def.role ?? null,
    image: def.image ?? null,
    size: { w: def.size?.w ?? 1, h: def.size?.h ?? 1 },
    maxHp,
    hp: maxHp,
    defense: Number.isFinite(def.defense) ? def.defense : 10,
    movement: Number.isFinite(def.movement) ? def.movement : 6,
    attacks: structuredClone(def.attacks ?? []),
    abilities: structuredClone(def.abilities ?? []),
    inventory: (def.inventory ?? []).map((i) => (typeof i === 'string' ? makeItem(prettyItemName(i), i) : makeItem(i.name, i.id))),
    // Actions per combat phase (movement is separate). Definitions may set "actions".
    actionsPerPhase: Number.isInteger(def.actions) && def.actions >= 0 ? def.actions : 1,
    ...(immortal ? { immortal: true, damageTaken: 0, hits: 0 } : {}),
    effects: [],
    status: 'active',
    hostile: kind === 'monster' ? def.hostile !== false : kind === 'npc' ? !!def.hostile : false,
    scope: 'scene',
    sceneId: null,
    positions: {},
    z: 0,
    ownerPlayerId: null,
    ...extra,
  };
}

// Actions available this phase: the entity's allowance plus any granted extras.
export function actionAllowance(entity, turn) {
  const reduced = (entity.effects ?? []).filter((fx) => fx.type === 'reduce_actions').reduce((s, fx) => s + (fx.params.amount ?? 1), 0);
  return Math.max(0, (entity.actionsPerPhase ?? 1) + (turn?.bonus ?? 0) - reduced);
}

export function turnFor(state, entityId) {
  // moves: this phase's undoable player moves (cleared by any action); see move.undo.
  state.turn[entityId] ??= { actions: 0, bonus: 0, moved: 0, abilitiesUsed: [], moves: [] };
  return state.turn[entityId];
}
