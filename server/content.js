import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync, existsSync, writeFileSync, renameSync, unlinkSync, watch, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CATEGORIES, FOLDER_CATEGORIES, SINGLE_FILES, FILE_RE, validateDefs, findItem, itemView } from '../core/content.js';
import { publicRoles } from '../core/roles.js';
import { normalizeTemplate } from '../core/templates.js';
import { normalizeHandout, validateAdventure } from '../core/handouts.js';

// Read-only built-in library content shipped in git: scene templates, handouts and adventures.
// Each file holds one item; its id is "builtin:<file name without .json>".
export const BUILTIN_FOLDERS = ['scenes', 'handouts', 'adventures'];
export const BUILTIN_PREFIX = 'builtin:';

export class ContentError extends Error {
  constructor(message, { errors = [], warnings = [], status = 400 } = {}) {
    super(message);
    this.errors = errors;
    this.warnings = warnings;
    this.status = status;
  }
}

// Reloadable content store. The object identity never changes, so everything holding a reference
// (GameService, routes) sees new definitions after reload(). Emits 'change' when content changes.
export function loadContent(dir, { staticDir = null, watchFiles = false, pollMs = 2000 } = {}) {
  const store = new EventEmitter();
  let data = null;
  let snapshot = '';
  const watchers = [];
  let pollTimer = null;
  const imageExists = staticDir ? (p) => existsSync(join(staticDir, p.slice('/static/'.length))) : null;

  const folder = (category) => join(dir, category);
  const checkCategory = (category) => {
    if (!CATEGORIES.includes(category)) throw new ContentError(`Unknown category "${category}"`, { status: 404 });
  };
  const checkFile = (category, file) => {
    checkCategory(category);
    if (SINGLE_FILES[category] ? file !== SINGLE_FILES[category] : !FILE_RE.test(String(file))) {
      throw new ContentError('File names must look like "my-monsters.json" (lowercase letters, digits, - and _)');
    }
  };
  const pathOf = (category, file) => (SINGLE_FILES[category] ? join(dir, SINGLE_FILES[category]) : join(folder(category), file));

  function fileNames(category) {
    if (SINGLE_FILES[category]) return existsSync(join(dir, SINGLE_FILES[category])) ? [SINGLE_FILES[category]] : [];
    const d = folder(category);
    return existsSync(d) ? readdirSync(d).filter((f) => FILE_RE.test(f)).sort() : [];
  }

  // Reads one category from disk, with `override` = { file, text } substituted (or removed when text is null).
  function readCategory(category, override) {
    const errors = [];
    const files = [];
    const names = new Set(fileNames(category));
    if (override) names.add(override.file);
    for (const file of [...names].sort()) {
      let text;
      if (override?.file === file) {
        if (override.text === null) continue;
        text = override.text;
      } else {
        text = readFileSync(pathOf(category, file), 'utf8');
      }
      try {
        const parsed = JSON.parse(text);
        files.push({ file, defs: Array.isArray(parsed) || SINGLE_FILES[category] ? parsed : [parsed] });
      } catch (e) {
        errors.push(`${category}/${file}: invalid JSON — ${e.message}`);
      }
    }
    const v = validateDefs(category, files, { imageExists });
    return { files, errors: [...errors, ...v.errors], warnings: v.warnings };
  }

  function builtinFiles(kind) {
    const d = folder(kind);
    return existsSync(d) ? readdirSync(d).filter((f) => FILE_RE.test(f)).sort() : [];
  }

  // Loads every built-in. Bad files are errors (like bad definitions); an adventure that points at
  // a missing built-in is a warning and is left out, as is a scene creature with an unknown def.
  function readBuiltins(lists) {
    const errors = [];
    const warnings = [];
    const out = { scenes: new Map(), handouts: new Map(), adventures: new Map() };
    const parse = {
      scenes: (json, id) => { const { name, data } = normalizeTemplate(json); return { id, name, data, builtIn: true }; },
      handouts: (json, id) => { const { title, data } = normalizeHandout(json); return { id, title, data, builtIn: true }; },
      adventures: (json, id) => ({ id, ...validateAdventure(json), builtIn: true }),
    };
    for (const kind of BUILTIN_FOLDERS) {
      for (const file of builtinFiles(kind)) {
        const id = `${BUILTIN_PREFIX}${file.slice(0, -'.json'.length)}`;
        try {
          out[kind].set(id, parse[kind](JSON.parse(readFileSync(join(folder(kind), file), 'utf8')), id));
        } catch (e) {
          errors.push(`${kind}/${file}: ${e instanceof SyntaxError ? 'invalid JSON — ' : ''}${e.message}`);
        }
      }
    }
    const known = { monster: new Set(lists.monsters.map((d) => d.id)), npc: new Set(lists.npcs.map((d) => d.id)) };
    for (const sc of out.scenes.values()) {
      for (const e of sc.data.entities) {
        if (!known[e.kind]?.has(e.defId)) warnings.push(`scenes/${sc.id.slice(BUILTIN_PREFIX.length)}.json: unknown ${e.kind} "${e.defId}" (skipped when added)`);
      }
    }
    for (const adv of [...out.adventures.values()]) {
      const missing = [
        ...adv.scenes.map((s) => s.template).filter((t) => !out.scenes.has(t)),
        ...adv.handouts.filter((h) => !out.handouts.has(h)),
      ];
      if (missing.length) {
        warnings.push(`adventures/${adv.id.slice(BUILTIN_PREFIX.length)}.json: missing ${missing.join(', ')} — adventure hidden`);
        out.adventures.delete(adv.id);
      }
    }
    return { builtins: out, errors, warnings };
  }

  function build(override) {
    const result = { errors: [], warnings: [], lists: {}, perFile: {} };
    for (const category of CATEGORIES) {
      const r = readCategory(category, override?.category === category ? override : null);
      result.errors.push(...r.errors);
      result.warnings.push(...r.warnings);
      result.lists[category] = r.files.flatMap((f) => (Array.isArray(f.defs) ? f.defs : []));
      result.perFile[category] = r.files.map((f) => ({ name: f.file, count: Array.isArray(f.defs) ? f.defs.length : 0 }));
    }
    const b = readBuiltins(result.lists);
    result.builtins = b.builtins;
    result.errors.push(...b.errors);
    result.warnings.push(...b.warnings);
    return result;
  }

  function apply(r) {
    const index = (list) => new Map(list.map((d) => [d.id, d]));
    data = {
      characters: r.lists.characters, monsters: r.lists.monsters, npcs: r.lists.npcs, acts: r.lists.acts,
      items: r.lists.items, itemViews: r.lists.items.map(itemView),
      maps: { character: index(r.lists.characters), monster: index(r.lists.monsters), npc: index(r.lists.npcs) },
      builtins: r.builtins,
    };
    const snap = JSON.stringify([r.lists, ...BUILTIN_FOLDERS.map((k) => [...r.builtins[k].values()])]);
    const changed = snap !== snapshot;
    snapshot = snap;
    return changed;
  }

  Object.defineProperties(store, Object.getOwnPropertyDescriptors({
    get characters() { return data.characters; },
    get monsters() { return data.monsters; },
    get npcs() { return data.npcs; },
    get acts() { return data.acts; },
    def(kind, id) { return data.maps[kind]?.get(id) ?? null; },
    get items() { return data.items; },
    act(id) { return data.acts.find((a) => a.id === id) ?? null; },
    // The catalog entry for an inventory entry: by its defId, else by name (live tokens and
    // DM-added items carry only a name, e.g. "Healing Potion").
    item(inv) { return findItem(data.items, inv); },
    publicContent(roleStrength) { return { characters: data.characters, acts: data.acts, items: data.itemViews, roles: publicRoles(roleStrength) }; },
    // Built-in library content (read-only; edited in git).
    scene(id) { return data.builtins.scenes.get(id) ?? null; },
    scenes() { return [...data.builtins.scenes.values()]; },
    handout(id) { return data.builtins.handouts.get(id) ?? null; },
    handouts() { return [...data.builtins.handouts.values()]; },
    adventure(id) { return data.builtins.adventures.get(id) ?? null; },
    adventures() { return [...data.builtins.adventures.values()]; },
    dmContent() { return { characters: data.characters, monsters: data.monsters, npcs: data.npcs, acts: data.acts, items: data.itemViews }; },

    // Re-reads everything. Invalid content is rejected and the last good content stays loaded.
    reload() {
      const r = build();
      if (r.errors.length) return { ok: false, errors: r.errors, warnings: r.warnings };
      if (apply(r)) store.emit('change');
      return { ok: true, errors: [], warnings: r.warnings };
    },

    listFiles() {
      const r = build();
      return CATEGORIES.map((category) => ({ category, files: r.perFile[category] }));
    },

    readFile(category, file) {
      checkFile(category, file);
      const p = pathOf(category, file);
      if (!existsSync(p)) throw new ContentError('File not found', { status: 404 });
      return readFileSync(p, 'utf8');
    },

    // Validates the whole category with this file's new text before touching the disk.
    writeFile(category, file, text, { create = false } = {}) {
      checkFile(category, file);
      const p = pathOf(category, file);
      if (create && existsSync(p)) throw new ContentError(`${file} already exists`, { status: 409 });
      if (typeof text !== 'string' || text.length > 2_000_000) throw new ContentError('File content missing or too large');
      const r = build({ category, file, text });
      if (r.errors.length) throw new ContentError('Validation failed — nothing was saved', { errors: r.errors, warnings: r.warnings });
      mkdirSync(SINGLE_FILES[category] ? dir : folder(category), { recursive: true });
      const tmp = `${p}.${process.pid}.tmp`;
      writeFileSync(tmp, text.endsWith('\n') ? text : `${text}\n`);
      renameSync(tmp, p);
      if (apply(r)) store.emit('change');
      return { warnings: r.warnings };
    },

    deleteFile(category, file) {
      checkFile(category, file);
      if (category === 'acts') throw new ContentError('acts.json cannot be deleted (edit it instead)');
      const p = pathOf(category, file);
      if (!existsSync(p)) throw new ContentError('File not found', { status: 404 });
      const r = build({ category, file, text: null });
      if (r.errors.length) throw new ContentError('Deleting this file would leave invalid content', { errors: r.errors });
      unlinkSync(p);
      if (apply(r)) store.emit('change');
    },

    close() {
      for (const w of watchers) w.close();
      watchers.length = 0;
      clearInterval(pollTimer);
    },
  }));

  const initial = build();
  if (initial.errors.length) throw new Error(`Invalid content in ${dir}:\n  ${initial.errors.join('\n  ')}`);
  apply(initial);
  if (initial.warnings.length) console.warn(`${initial.warnings.length} content warning(s), e.g. ${initial.warnings[0]} — see the Data page`);

  // Pick up edits made directly on disk (debounced; editors often write several events).
  if (watchFiles) {
    let timer = null;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const r = store.reload();
        if (!r.ok) console.error(`content reload rejected (keeping previous content):\n  ${r.errors.join('\n  ')}`);
      }, 300);
      timer.unref?.();
    };
    const tryWatch = (path, filter) => {
      try {
        if (!existsSync(path)) return;
        watchers.push(watch(path, (ev, name) => { if (!filter || filter(String(name ?? ''))) schedule(); }));
      } catch (e) {
        console.warn(`cannot watch ${path}: ${e.message}`);
      }
    };
    for (const c of [...FOLDER_CATEGORIES, ...BUILTIN_FOLDERS]) tryWatch(folder(c), (n) => n.endsWith('.json'));
    tryWatch(dir, (n) => Object.values(SINGLE_FILES).includes(n));
    // fs.watch can miss events (notably on macOS right after a watch starts), so also compare a
    // cheap signature of the content files every few seconds.
    const stamp = (path, label) => {
      try { const st = statSync(path); return `${label}:${st.mtimeMs}:${st.size}`; } catch { return label; }
    };
    const signature = () => [
      ...CATEGORIES.flatMap((c) => fileNames(c).map((f) => stamp(pathOf(c, f), `${c}/${f}`))),
      ...BUILTIN_FOLDERS.flatMap((k) => builtinFiles(k).map((f) => stamp(join(folder(k), f), `${k}/${f}`))),
    ].join('|');
    let last = signature();
    pollTimer = setInterval(() => {
      const now = signature();
      if (now !== last) { last = now; schedule(); }
    }, pollMs);
    pollTimer.unref?.();
  }
  return store;
}
