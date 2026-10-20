import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.js';
import { loadContent } from '../server/content.js';
import { DEFAULT_ROLE_STRENGTH } from '../core/roles.js';
import { TemplateStore } from '../server/templates.js';
import { HandoutStore } from '../server/handouts.js';
import { GameService } from '../server/games/service.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Tests use a fixed copy of the starter content so live edits to data/ (via the Data page) can't break them.
export const FIXTURE_DATA = join(ROOT, 'test', 'fixtures', 'data');
export const content = loadContent(FIXTURE_DATA);

// rng that returns queued values, then falls back to `fallback` (default: max roll).
export function scriptedRng(fallback = (s) => s) {
  const queue = [];
  const rng = (sides) => (queue.length ? queue.shift() : fallback(sides));
  rng.push = (...v) => queue.push(...v);
  return rng;
}

// A settings store with a fixed role strength (production reads data/settings.json).
export const fixedSettings = (roleStrength = DEFAULT_ROLE_STRENGTH) => ({ get: () => ({ roleStrength }) });

// ONE_AND_DONE_STATELESS=1 (npm run test:stateless) runs every test without the in-memory game cache.
const STATELESS = process.env.ONE_AND_DONE_STATELESS === '1';

export function makeService({ dbFile = ':memory:', now, rng, settings = fixedSettings() } = {}) {
  const db = openDb(dbFile);
  const templates = new TemplateStore(db, { builtins: content });
  const handouts = new HandoutStore(db, { builtins: content });
  const adventures = { get: (id) => content.adventure(id) };
  const clock = { t: 1_000_000 };
  rng ??= scriptedRng();
  const service = new GameService({
    db, content, templates, handouts, adventures, settings, rng, now: now ?? (() => clock.t), stateless: STATELESS,
  });
  return { db, templates, handouts, service, clock, rng };
}

export const DM = { role: 'dm' };

export function ok(r) {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.result;
}

export function setup(opts) {
  const ctx = makeService(opts);
  const { service, templates } = ctx;
  const game = service.createGame('Test');
  const tpl = templates.create({
    name: 'Cave', grid: { cols: 10, rows: 8 },
    entities: [{ kind: 'monster', defId: 'rat', x: 5, y: 5 }],
  });
  const tpl2 = templates.create({ name: 'Forest', grid: { cols: 12, rows: 12 }, spawn: { x: 3, y: 3 } });
  const join = (name) => {
    const r = ok(service.dispatch(game.id, { role: 'join' }, { type: 'player.create', name }));
    return { role: 'player', playerId: r.playerId, seatSecret: r.seatSecret };
  };
  const state = () => service.get(game.id).state;
  const run = (actor, cmd) => service.dispatch(game.id, actor, cmd);
  // Changes the game state directly (test setup no command can express) and saves it. Mutating
  // state() alone only works with the in-memory cache; this also works in stateless mode.
  const edit = (fn) => {
    const g = service.get(game.id);
    const out = fn(g.state);
    service.persist(g, []);
    return out;
  };
  return { ...ctx, game, tpl, tpl2, join, state, run, edit };
}
