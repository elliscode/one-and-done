import { newId, fail } from '../core/state.js';
import { normalizeTemplate } from '../core/templates.js';
import { BUILTIN_PREFIX } from './content.js';

// Scene templates: the DM's own (SQLite) plus read-only built-ins shipped in data/scenes/.
export class TemplateStore {
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
    const own = this.db.prepare('SELECT id, name, data, updated_at FROM scene_templates ORDER BY name COLLATE NOCASE')
      .all().map((r) => ({ id: r.id, name: r.name, updatedAt: r.updated_at, background: JSON.parse(r.data).background }));
    const builtIn = (this.builtins?.scenes() ?? []).map((t) => ({ id: t.id, name: t.name, updatedAt: null, background: t.data.background, builtIn: true }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return [...own, ...builtIn];
  }

  get(id) {
    if (this.isBuiltIn(id)) return this.builtins?.scene(id) ?? null;
    const r = this.db.prepare('SELECT id, name, data, updated_at FROM scene_templates WHERE id = ?').get(String(id ?? ''));
    return r ? { id: r.id, name: r.name, data: JSON.parse(r.data), updatedAt: r.updated_at } : null;
  }

  // Counts how many templates reference each /static/... image (as a background).
  imageRefs() {
    const counts = new Map();
    const add = (path) => path && counts.set(path, (counts.get(path) ?? 0) + 1);
    for (const r of this.db.prepare('SELECT data FROM scene_templates').all()) {
      const d = JSON.parse(r.data);
      add(d.background);
    }
    for (const t of this.builtins?.scenes() ?? []) add(t.data.background);
    return counts;
  }

  create(input) {
    const { name, data } = normalizeTemplate(input);
    const id = newId('tpl');
    const t = this.now();
    this.db.prepare('INSERT INTO scene_templates (id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, name, JSON.stringify(data), t, t);
    return this.get(id);
  }

  update(id, input) {
    if (this.isBuiltIn(id)) fail("Built-in scenes can't be edited. Duplicate it first.");
    if (!this.get(id)) fail('Scene not found');
    const { name, data } = normalizeTemplate(input);
    this.db.prepare('UPDATE scene_templates SET name = ?, data = ?, updated_at = ? WHERE id = ?')
      .run(name, JSON.stringify(data), this.now(), id);
    return this.get(id);
  }

  delete(id) {
    if (this.isBuiltIn(id)) fail("Built-in scenes can't be deleted");
    return this.db.prepare('DELETE FROM scene_templates WHERE id = ?').run(id).changes > 0;
  }
}
