import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS scene_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS handouts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  data TEXT NOT NULL,            -- JSON { text, image, dmNotes }
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  join_token TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- The Game Feed: chat messages and game events in one chronological table. The autoincrement id
-- is the stable, server-assigned ordering; clients never supply timestamps or order.
CREATE TABLE IF NOT EXISTS feed_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL,
  kind TEXT NOT NULL,            -- 'chat' | 'event'
  type TEXT NOT NULL,            -- chat, attack, ability, phase, ...
  text TEXT NOT NULL,            -- what players see ('' for DM-only events)
  dm_text TEXT,                  -- DM version when it differs (includes hidden HP)
  visibility TEXT NOT NULL,      -- 'all' | 'dm'
  color TEXT,
  name TEXT,                     -- chat sender name
  player_id TEXT,
  data TEXT,                     -- JSON with public-safe structured details
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS feed_game ON feed_events(game_id, id);
CREATE TABLE IF NOT EXISTS undo_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL,
  label TEXT NOT NULL,
  state TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS undo_game ON undo_snapshots(game_id, id);
`;

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const tableExists = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

// Schema migrations, tracked with PRAGMA user_version.
//   2: merge chat_messages + activity_events into feed_events (ordered by time, then source id).
function migrate(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version < 2) {
    transaction(db, () => {
      if (tableExists(db, 'chat_messages') && tableExists(db, 'activity_events')) {
        db.exec(`
          INSERT INTO feed_events (game_id, kind, type, text, dm_text, visibility, color, name, player_id, data, ts)
          SELECT game_id, kind, type, text, dm_text, visibility, color, name, player_id, NULL, ts FROM (
            SELECT game_id, 'event' AS kind, type, text, dm_text,
                   CASE WHEN text = '' THEN 'dm' ELSE 'all' END AS visibility, color, NULL AS name, NULL AS player_id, ts, id, 0 AS src
              FROM activity_events
            UNION ALL
            SELECT game_id, 'chat', 'chat', text, NULL, 'all', color, name, player_id, ts, id, 1
              FROM chat_messages
          ) ORDER BY ts, src, id;
          DROP TABLE chat_messages;
          DROP TABLE activity_events;
        `);
      }
      db.exec('PRAGMA user_version = 2');
    });
  }
}
