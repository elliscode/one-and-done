import { handlers } from './commands.js';
import { GameError, DM_COLOR } from './state.js';
import { ensurePlaced } from './placement.js';
import { stripMarkers } from './helpers.js';

// The pure game pipeline every shell (self-hosted server, cloud) wraps. Nothing here does I/O,
// reads the clock or keeps state between calls: the shell loads a game, calls these functions,
// then stores what they return and tells clients.
//
// deps (all synchronous):
//   content    { def(kind, id), act(id), item(inv) }   definition lookups
//   templates  { get(id) }                              scene template lookup (library + built-in)
//   handouts   { get(id) }                              handout library lookup (library + built-in)
//   adventures { get(id) }                              built-in adventure lookup
//   settings   { roleStrength }                         per-server / per-account settings
//   rng        (sides) => 1..sides                      dice
//   now        ms timestamp for this command

export const UNDO_LIMIT = 20;
export const HISTORY_LIMIT = 300;
export const CHAT_MAX = 500;
export const PING_LIMIT = 10; // pings per player per minute
export const PING_WINDOW_MS = 60_000;
export const PING_MAX_CELLS = 1000;

const allowed = (who, actor) =>
  who === actor.role || (who === 'any' && (actor.role === 'dm' || actor.role === 'player'));

// Runs one command. Never mutates `state`: the handler works on a copy, and a failed command
// returns { ok: false } with nothing to store.
// On success returns:
//   state      the new game state
//   result     the handler's return value (sent back to the caller)
//   feed       new Game Feed rows (without ids; the shell assigns ordering)
//   fx         throwaway visual effects for clients
//   undo       { label, snapshot } to push on the undo stack, or null
//   clearUndo  true when the undo stack must be emptied
export function applyCommand(state, actor, cmd, deps) {
  if (!cmd || typeof cmd.type !== 'string') return { ok: false, error: 'Bad command' };
  const h = handlers[cmd.type];
  if (!h) return { ok: false, error: `Unknown command ${cmd.type}` };
  if (!allowed(h.who, actor)) return { ok: false, error: 'Not allowed' };

  const next = structuredClone(state);
  const ctx = makeCtx(next, actor, cmd, deps);
  let result;
  try {
    if (actor.role === 'player' && !ctx.player) throw new GameError('You are not in this game');
    result = h.run(ctx);
    if (next.activeSceneId) ensurePlaced(next, next.activeSceneId);
  } catch (err) {
    if (err instanceof GameError) return { ok: false, error: err.message };
    throw err;
  }
  return {
    ok: true, result, state: next,
    feed: ctx.events.map((e) => ({ kind: 'event', ts: deps.now, ...e })),
    fx: ctx.fxs,
    undo: h.undoable ? { label: h.undoable, snapshot: state } : null,
    clearUndo: !!h.clearsUndo,
  };
}

function makeCtx(state, actor, cmd, deps) {
  const player = actor.role === 'player' ? state.players[actor.playerId] : null;
  const isDm = actor.role === 'dm';
  const ctx = {
    state, actor, cmd, player,
    content: deps.content, templates: deps.templates, handouts: deps.handouts, adventures: deps.adventures, settings: deps.settings, rng: deps.rng, now: deps.now,
    actorName: isDm ? 'DM' : player?.name ?? 'System',
    actorColor: isDm ? DM_COLOR : player?.color ?? null,
    events: [], fxs: [],
    log(type, text, opts = {}) {
      const color = opts.color ?? ctx.actorColor;
      const dmText = opts.dmText ?? null;
      const data = opts.data ?? null;
      ctx.events.push(opts.dmOnly
        ? { type, text: '', dmText: dmText ?? text, color, visibility: 'dm', data }
        : { type, text, dmText, color, visibility: 'all', data });
    },
    fx(f) { ctx.fxs.push(f); },
  };
  return ctx;
}

// Restores token/HP/turn state from the top undo entry ({ label, snapshot }). Player seats, scenes
// and combat phase are left alone; commands that change those clear the undo stack. The shell
// removes the entry from its stack on success.
export function applyUndo(state, actor, entry, now) {
  if (actor.role !== 'dm') return { ok: false, error: 'Not allowed' };
  if (!entry) return { ok: false, error: 'Nothing to undo' };
  const snap = entry.snapshot;
  const s = structuredClone(state);
  s.entities = structuredClone(snap.entities);
  s.turn = structuredClone(snap.turn);
  s.pendingChecks = structuredClone(snap.pendingChecks ?? []);
  s.zCounter = Math.max(s.zCounter, snap.zCounter);
  if (s.activeSceneId) ensurePlaced(s, s.activeSceneId);
  return {
    ok: true, state: s, result: { undone: entry.label },
    feed: [{ kind: 'event', ts: now, type: 'undo', text: `DM undid the last ${entry.label}`, dmText: null, color: DM_COLOR }],
  };
}

// A chat line. Returns { roll: cmd } when the text is a /roll (or /r) to dispatch as a command,
// { row } for a Game Feed chat row (without an id), or { error }.
export function applyChat(state, actor, text, now) {
  const msg = stripMarkers(String(text ?? '')).trim().slice(0, CHAT_MAX);
  if (!msg) return { error: 'Empty message' };
  const roll = msg.match(/^\/r(?:oll)?\s+(.+)$/i);
  if (roll) return { roll: { type: 'roll', expr: roll[1] } };
  let name, color, playerId = null;
  if (actor.role === 'dm') {
    name = 'DM';
    color = DM_COLOR;
  } else {
    const p = state.players[actor.playerId];
    if (!p) return { error: 'You are not in this game' };
    ({ name, color } = p);
    playerId = p.id;
  }
  return { row: { kind: 'chat', type: 'chat', text: msg, name, color, playerId, ts: now } };
}

// A map ping: a throwaway visual for everyone in the game. It never touches game state, the Game
// Feed or undo. Players get PING_LIMIT pings per minute; the 10th starts a one-minute mute from
// that ping. The DM is never limited. `limiter` is this player's record ({ times, mutedUntil },
// or undefined the first time); the shell stores the returned `limiter` (null for the DM).
// Returns { ping, limiter } or { error, limiter }.
export function checkPing(state, actor, pos, limiter, now) {
  const scene = state.scenes[state.activeSceneId];
  if (!scene) return { error: 'No active scene to ping', limiter };
  const x = Number(pos?.x), y = Number(pos?.y);
  // Positions are in grid cells and may fall outside the grid (the map image can be larger),
  // so only absurd values are refused.
  if (typeof pos?.x !== 'number' || typeof pos?.y !== 'number' || !(Math.abs(x) <= PING_MAX_CELLS) || !(Math.abs(y) <= PING_MAX_CELLS)) return { error: 'Bad ping', limiter };
  if (actor.role === 'dm') return { ping: { sceneId: scene.id, x, y, color: DM_COLOR }, limiter: null };
  const p = state.players[actor.playerId];
  if (!p) return { error: 'You are not in this game', limiter };
  const lim = { times: [...(limiter?.times ?? [])], mutedUntil: limiter?.mutedUntil ?? 0 };
  if (now < lim.mutedUntil) {
    return { error: `Ping limit reached (${PING_LIMIT} per minute). Try again in ${Math.ceil((lim.mutedUntil - now) / 1000)}s.`, limiter: lim };
  }
  lim.times = lim.times.filter((t) => now - t < PING_WINDOW_MS);
  lim.times.push(now);
  if (lim.times.length >= PING_LIMIT) {
    lim.mutedUntil = now + PING_WINDOW_MS;
    lim.times = [];
  }
  return { ping: { sceneId: scene.id, x, y, color: p.color }, limiter: lim };
}

// When the game next needs to act on its own (a combat phase timer running out), and the command
// to dispatch then as { role: 'system' }. null when nothing is scheduled.
export function nextDeadline(state) {
  const c = state.combat;
  if (!c.active || !c.phaseEndsAt) return null;
  return { at: c.phaseEndsAt, cmd: { type: 'combat.timerExpired', phaseEndsAt: c.phaseEndsAt } };
}
