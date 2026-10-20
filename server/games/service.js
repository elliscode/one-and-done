import { EventEmitter } from 'node:events';
import { randomBytes, randomInt } from 'node:crypto';
import { transaction } from '../db.js';
import { DM_COLOR, newId, createGameState, upgradeState, GameError } from '../../core/state.js';
import { feedForRole } from '../../core/project.js';
import { applyCommand, applyUndo, applyChat, checkPing, nextDeadline, UNDO_LIMIT, HISTORY_LIMIT } from '../../core/engine.js';

// The self-hosted shell around the core engine (core/engine.js). Owns all live games in memory.
// Every state change goes through dispatch(): the engine validates and applies the command, then
// this persists state, Game Feed events and undo snapshot in one SQLite transaction and notifies
// listeners. Timers, presence and ping limits live here; the rules live in core/.
export class GameService extends EventEmitter {
  // stateless: never keep games in memory between calls, so every command reloads the game from
  // SQLite, as a serverless shell must. Used by `npm run test:stateless` to catch features that only
  // work because of the in-memory cache.
  // handouts / adventures: { get(id) } lookups (optional; commands that need them fail cleanly).
  constructor({ db, content, templates, handouts = null, adventures = null, settings, now = Date.now, rng, graceMs = 60_000, stateless = false }) {
    super();
    if (typeof settings?.get !== 'function') throw new Error('GameService needs a settings store ({ get() → { roleStrength } })');
    this.settings = settings;
    this.db = db;
    this.content = content;
    this.templates = templates;
    this.handouts = handouts;
    this.adventures = adventures;
    this.now = now;
    this.rng = rng ?? ((sides) => randomInt(1, sides + 1));
    this.graceMs = graceMs;
    this.stateless = stateless;
    this.games = new Map(); // in-memory cache of loaded games (always empty when stateless)
    this.opened = new Set(); // ids of games loaded by this process ("open" games)
    this.timers = new Map();
    this.presence = new Map(); // gameId -> Map(playerId -> { sockets:Set, lastSeen })
    this.graceTimers = new Set();
    this.pingLimits = new Map(); // "gameId:playerId" -> { times: [ms], mutedUntil: ms }
  }

  // ---------- game lifecycle ----------

  listGames() {
    return this.db.prepare('SELECT id, name, join_token, state, created_at, updated_at FROM games ORDER BY updated_at DESC')
      .all().map((r) => {
        const s = this.games.get(r.id)?.state ?? JSON.parse(r.state);
        return {
          id: r.id, name: s.name, joinToken: r.join_token, createdAt: r.created_at, updatedAt: r.updated_at,
          players: Object.keys(s.players).length,
          scenes: s.sceneOrder.length,
          handouts: s.handoutOrder?.length ?? 0,
          activeScene: s.activeSceneId ? s.scenes[s.activeSceneId]?.name : null,
          combat: s.combat.active,
        };
      });
  }

  // With adventureId, the new game is set up from that built-in adventure (adventure.load). If that
  // fails the game is deleted again, so a broken adventure never leaves a half-built game.
  createGame(name, { adventureId = null } = {}) {
    const adv = adventureId ? this.adventures?.get(adventureId) : null;
    if (adventureId && !adv) throw new GameError('Unknown adventure');
    const clean = String(name ?? '').trim().slice(0, 60) || adv?.name || 'Untitled one-shot';
    const id = newId('g');
    const joinToken = randomBytes(9).toString('base64url');
    const state = createGameState({ id, name: clean, joinToken });
    const t = this.now();
    this.db.prepare('INSERT INTO games (id, name, join_token, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, clean, joinToken, JSON.stringify(state), t, t);
    if (adv) {
      const r = this.dispatch(id, { role: 'dm' }, { type: 'adventure.load', adventureId });
      if (!r.ok) {
        this.deleteGame(id);
        throw new GameError(r.error);
      }
    }
    return { id, joinToken, name: clean };
  }

  deleteGame(id) {
    const changes = transaction(this.db, () => {
      for (const table of ['feed_events', 'undo_snapshots']) {
        this.db.prepare(`DELETE FROM ${table} WHERE game_id = ?`).run(id);
      }
      return this.db.prepare('DELETE FROM games WHERE id = ?').run(id).changes;
    });
    this.clearTimer(id);
    this.games.delete(id);
    this.opened.delete(id);
    this.presence.delete(id);
    if (changes) this.emit('change', id, { deleted: true });
    return changes > 0;
  }

  get(id) {
    if (typeof id !== 'string') return null;
    let game = this.games.get(id);
    if (game) return game;
    const row = this.db.prepare('SELECT state FROM games WHERE id = ?').get(id);
    if (!row) return null;
    game = { id, state: JSON.parse(row.state) };
    if (upgradeState(game.state)) this.persist(game, []);
    if (!this.stateless) this.games.set(id, game);
    this.opened.add(id);
    this.syncTimer(game);
    return game;
  }

  getByToken(token) {
    if (typeof token !== 'string') return null;
    const row = this.db.prepare('SELECT id FROM games WHERE join_token = ?').get(token);
    return row ? this.get(row.id) : null;
  }

  // Load every game with a running combat timer so expired phases advance after a restart.
  restoreAll() {
    for (const { id } of this.db.prepare('SELECT id FROM games').all()) this.get(id);
  }

  close() {
    for (const t of this.timers.values()) clearTimeout(t);
    for (const t of this.graceTimers) clearTimeout(t);
    this.timers.clear();
    this.graceTimers.clear();
  }

  // ---------- commands ----------

  dispatch(gameId, actor, cmd) {
    const game = this.get(gameId);
    if (!game) return { ok: false, error: 'Game not found' };
    if (cmd?.type === 'undo') return this.undo(game, actor);
    const r = applyCommand(game.state, actor, cmd, this.deps());
    if (!r.ok) return { ok: false, error: r.error };
    game.state = r.state;
    const rows = this.persist(game, r.feed, {
      undo: r.undo ? { label: r.undo.label, state: r.undo.snapshot } : null,
      clearUndo: r.clearUndo,
    });
    this.syncTimer(game);
    this.emit('change', game.id, { feed: rows, fx: r.fx });
    return { ok: true, result: r.result };
  }

  deps() {
    return {
      content: this.content, templates: this.templates, handouts: this.handouts, adventures: this.adventures,
      settings: this.settings.get(), rng: this.rng, now: this.now(),
    };
  }

  persist(game, events, { undo = null, clearUndo = false } = {}) {
    const t = this.now();
    return transaction(this.db, () => {
      this.db.prepare('UPDATE games SET state = ?, name = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(game.state), game.state.name, t, game.id);
      const rows = events.map((e) => this.insertFeed(game.id, { kind: 'event', ts: t, ...e }));
      if (clearUndo) this.db.prepare('DELETE FROM undo_snapshots WHERE game_id = ?').run(game.id);
      if (undo) {
        this.db.prepare('INSERT INTO undo_snapshots (game_id, label, state, ts) VALUES (?, ?, ?, ?)')
          .run(game.id, undo.label, JSON.stringify(undo.state), t);
        this.db.prepare(`DELETE FROM undo_snapshots WHERE game_id = ? AND id NOT IN
          (SELECT id FROM undo_snapshots WHERE game_id = ? ORDER BY id DESC LIMIT ${UNDO_LIMIT})`).run(game.id, game.id);
      }
      return rows;
    });
  }

  // Appends one Game Feed row and returns it (internal shape; see feedForRole for what viewers get).
  insertFeed(gameId, e) {
    const row = {
      kind: e.kind, type: e.type, text: e.text ?? '', dmText: e.dmText ?? null, visibility: e.visibility ?? 'all',
      color: e.color ?? null, name: e.name ?? null, playerId: e.playerId ?? null, data: e.data ?? null, ts: e.ts ?? this.now(),
    };
    const r = this.db.prepare(`INSERT INTO feed_events (game_id, kind, type, text, dm_text, visibility, color, name, player_id, data, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(gameId, row.kind, row.type, row.text, row.dmText, row.visibility, row.color,
      row.name, row.playerId, row.data ? JSON.stringify(row.data) : null, row.ts);
    return { id: Number(r.lastInsertRowid), ...row };
  }

  // A DM-only Game Feed note in every game this process has opened (e.g. a settings change).
  noteToLoadedGames(text) {
    for (const id of this.opened) {
      const row = this.insertFeed(id, { kind: 'event', type: 'settings', text: '', dmText: text, visibility: 'dm', color: DM_COLOR });
      this.emit('change', id, { feed: [row] });
    }
  }

  undoInfo(gameId) {
    const r = this.db.prepare('SELECT label FROM undo_snapshots WHERE game_id = ? ORDER BY id DESC LIMIT 1').get(gameId);
    return r ? r.label : null;
  }

  // Undo the last undoable action (rules in core/engine.js applyUndo).
  undo(game, actor) {
    const row = actor.role === 'dm'
      ? this.db.prepare('SELECT id, label, state FROM undo_snapshots WHERE game_id = ? ORDER BY id DESC LIMIT 1').get(game.id)
      : null;
    const r = applyUndo(game.state, actor, row && { label: row.label, snapshot: JSON.parse(row.state) }, this.now());
    if (!r.ok) return r;
    game.state = r.state;
    this.db.prepare('DELETE FROM undo_snapshots WHERE id = ?').run(row.id);
    const rows = this.persist(game, r.feed);
    this.emit('change', game.id, { feed: rows, fx: [] });
    return { ok: true, result: r.result };
  }

  // ---------- combat timer ----------

  clearTimer(id) {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
  }

  syncTimer(game) {
    this.clearTimer(game.id);
    const d = nextDeadline(game.state);
    if (!d) return;
    this.timers.set(game.id, setTimeout(() => {
      this.timers.delete(game.id);
      this.dispatch(game.id, { role: 'system' }, d.cmd);
    }, Math.max(0, d.at - this.now())));
  }

  // ---------- chat & history ----------

  chat(gameId, actor, text) {
    const game = this.get(gameId);
    if (!game) return { ok: false, error: 'Game not found' };
    const r = applyChat(game.state, actor, text, this.now());
    if (r.error) return { ok: false, error: r.error };
    if (r.roll) return this.dispatch(gameId, actor, r.roll);
    const row = this.insertFeed(gameId, r.row);
    this.emit('change', gameId, { feed: [row] });
    return { ok: true };
  }

  // A map ping (rules in core/engine.js checkPing). Limits live in memory only.
  ping(gameId, actor, pos) {
    const game = this.get(gameId);
    if (!game) return { ok: false, error: 'Game not found' };
    const key = actor.role === 'dm' ? null : `${gameId}:${actor.playerId}`;
    const r = checkPing(game.state, actor, pos, key ? this.pingLimits.get(key) : null, this.now());
    if (key && r.limiter) this.pingLimits.set(key, r.limiter);
    if (r.error) return { ok: false, error: r.error };
    this.emit('ping', gameId, r.ping);
    return { ok: true };
  }

  // The most recent Game Feed rows, oldest first, filtered for the viewer's role.
  // `since` (ms) limits the feed to rows from that time on: players only see what happened after
  // they joined, so the DM's setup and testing stay private.
  history(gameId, role, { since = null } = {}) {
    const rows = this.db.prepare(`SELECT * FROM (SELECT id, kind, type, text, dm_text AS dmText, visibility, color, name,
      player_id AS playerId, data, ts FROM feed_events WHERE game_id = ? AND ts >= ? ORDER BY id DESC LIMIT ${HISTORY_LIMIT}) ORDER BY id`).all(gameId, since ?? 0);
    const feed = rows.map((r) => feedForRole({ ...r, data: r.data ? JSON.parse(r.data) : null }, role)).filter(Boolean);
    return { feed };
  }

  // ---------- presence (not persisted) ----------

  presenceOf(gameId) {
    const map = this.presence.get(gameId);
    return (playerId) => {
      const p = map?.get(playerId);
      if (!p) return 'offline';
      if (p.sockets.size) return 'online';
      return this.now() - p.lastSeen < this.graceMs ? 'reconnecting' : 'offline';
    };
  }

  connect(gameId, playerId, socketId) {
    if (!this.presence.has(gameId)) this.presence.set(gameId, new Map());
    const map = this.presence.get(gameId);
    if (!map.has(playerId)) map.set(playerId, { sockets: new Set(), lastSeen: this.now() });
    map.get(playerId).sockets.add(socketId);
    this.emit('change', gameId, { presence: true });
  }

  disconnect(gameId, playerId, socketId) {
    const p = this.presence.get(gameId)?.get(playerId);
    if (!p) return;
    p.sockets.delete(socketId);
    p.lastSeen = this.now();
    this.emit('change', gameId, { presence: true });
    if (!p.sockets.size) {
      const t = setTimeout(() => {
        this.graceTimers.delete(t);
        this.emit('change', gameId, { presence: true });
      }, this.graceMs + 50);
      t.unref?.();
      this.graceTimers.add(t);
    }
  }
}
