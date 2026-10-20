import { newId, fail } from '../core/state.js';
import { normalizeHandout } from '../core/handouts.js';
import { BUILTIN_PREFIX } from './content.js';

// The handout library: the DM's own (SQLite) plus read-only built-ins shipped in data/handouts/.
// Games hold their own copies (state.handouts), so editing here never changes a running game.
export class HandoutStore {
  // builtins: the content store (server/content.js), or null for none.
  constructor(db, { now = Date.now, builtins = null } = {}) {
    this.db = db;
    this.now = now;
    this.builtins = builtins;
  }

  isBuiltIn(id) {
    return String(id ?? '').startsWith(BUILTIN_PREFIX);
  }

  list() {
    const view = (id, title, data, extra) => ({ id, title, image: data.image, hasText: !!data.text, ...extra });
    const own = this.db.prepare('SELECT id, title, data, updated_at FROM handouts ORDER BY title COLLATE NOCASE')
      .all().map((r) => view(r.id, r.title, JSON.parse(r.data), { updatedAt: r.updated_at }));
    const builtIn = (this.builtins?.handouts() ?? []).map((ho) => view(ho.id, ho.title, ho.data, { updatedAt: null, builtIn: true }))
      .sort((a, b) => a.title.localeCompare(b.title));
    return [...own, ...builtIn];
  }

  get(id) {
    if (this.isBuiltIn(id)) return this.builtins?.handout(id) ?? null;
    const r = this.db.prepare('SELECT id, title, data, updated_at FROM handouts WHERE id = ?').get(String(id ?? ''));
    return r ? { id: r.id, title: r.title, data: JSON.parse(r.data), updatedAt: r.updated_at } : null;
  }

  // Counts how many library handouts use each /static/... image as their cover.
  imageRefs() {
    const counts = new Map();
    const add = (path) => path && counts.set(path, (counts.get(path) ?? 0) + 1);
    for (const r of this.db.prepare('SELECT data FROM handouts').all()) add(JSON.parse(r.data).image);
    for (const ho of this.builtins?.handouts() ?? []) add(ho.data.image);
    return counts;
  }

  create(input) {
    const { title, data } = normalizeHandout(input);
    const id = newId('ho');
    const t = this.now();
    this.db.prepare('INSERT INTO handouts (id, title, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, title, JSON.stringify(data), t, t);
    return this.get(id);
  }

  update(id, input) {
    if (this.isBuiltIn(id)) fail("Built-in handouts can't be edited. Duplicate it first.");
    if (!this.get(id)) fail('Handout not found');
    const { title, data } = normalizeHandout(input);
    this.db.prepare('UPDATE handouts SET title = ?, data = ?, updated_at = ? WHERE id = ?')
      .run(title, JSON.stringify(data), this.now(), id);
    return this.get(id);
  }

  delete(id) {
    if (this.isBuiltIn(id)) fail("Built-in handouts can't be deleted");
    return this.db.prepare('DELETE FROM handouts WHERE id = ?').run(id).changes > 0;
  }
}
