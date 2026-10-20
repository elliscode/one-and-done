import { GameError, MAX_SCENE_LINKS } from './state.js';

// Handouts: notes, letters, maps and clues the DM prepares and reveals to players. A handout has
// Markdown text, a cover image, or both. Limits keep game state bounded: every game copy travels
// with the DM's state on every change.
export const MAX_HANDOUTS = 40;
export const HANDOUT_TITLE_MAX = 80;
export const HANDOUT_TEXT_MAX = 8000;
export const HANDOUT_NOTES_MAX = 2000;
// A game handout can be tied to at most this many of the game's scenes (handout.setScenes).
export const MAX_HANDOUT_SCENES = 30;

const text = (v, max) => {
  const s = typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim() : '';
  if (s.length > max) throw new GameError(`Keep it under ${max.toLocaleString('en-US')} characters`);
  return s || null;
};

// Validates and normalizes handout data from the editor, a command or a built-in file.
export function normalizeHandout(input = {}) {
  const title = String(input.title ?? '').trim().slice(0, HANDOUT_TITLE_MAX) || 'Untitled handout';
  const image = typeof input.image === 'string' && input.image.startsWith('/static/') && !input.image.includes('..') ? input.image : null;
  const data = { text: text(input.text, HANDOUT_TEXT_MAX), image, dmNotes: text(input.dmNotes, HANDOUT_NOTES_MAX) };
  if (!data.text && !data.image) throw new GameError('A handout needs some text or an image');
  return { title, data };
}

// Structural check of a built-in adventure file. Whether its scenes and handouts exist is checked
// by whoever loads it (the shell when listing, adventure.load when running).
//   { name, description?, scenes: [{ key?, template, name?, next?: [key] }],
//     handouts?: [id | { id, scenes?: [key] }], startScene? }
// Handouts come back as [{ id, scenes? }]; scenes ties the handout to those scenes in the game.
export function validateAdventure(input) {
  const bad = (msg) => { throw new GameError(msg); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad('must be a JSON object');
  const name = String(input.name ?? '').trim().slice(0, 60);
  if (!name) bad('needs a "name"');
  const description = String(input.description ?? '').trim().slice(0, 500);
  if (!Array.isArray(input.scenes) || !input.scenes.length) bad('needs at least one entry in "scenes"');
  if (input.scenes.length > 30) bad('has more than 30 scenes');
  const keys = new Set();
  const scenes = input.scenes.map((s, i) => {
    if (!s || typeof s.template !== 'string' || !s.template) bad(`scenes[${i}] needs a "template" id`);
    const key = typeof s.key === 'string' && s.key ? s.key : `scene-${i + 1}`;
    if (keys.has(key)) bad(`scenes[${i}] repeats the key "${key}"`);
    keys.add(key);
    return { key, template: s.template, ...(s.name ? { name: String(s.name).trim().slice(0, 60) } : {}), next: s.next };
  });
  // Branching links (scene.setNext) between this adventure's scenes, by key. Checked once every
  // key is known, since a link can point at a later scene.
  for (const [i, s] of scenes.entries()) {
    const next = s.next ?? [];
    if (!Array.isArray(next) || next.some((k) => typeof k !== 'string')) bad(`scenes[${i}].next must be a list of scene keys`);
    for (const k of next) {
      if (!keys.has(k)) bad(`scenes[${i}].next names "${k}", which isn't one of the scene keys`);
      if (k === s.key) bad(`scenes[${i}].next can't link "${k}" to itself`);
    }
    const unique = [...new Set(next)];
    if (unique.length > MAX_SCENE_LINKS) bad(`scenes[${i}].next has more than ${MAX_SCENE_LINKS} links`);
    if (unique.length) s.next = unique;
    else delete s.next;
  }
  const rawHandouts = input.handouts ?? [];
  if (!Array.isArray(rawHandouts)) bad('"handouts" must be a list of handout ids');
  if (rawHandouts.length > MAX_HANDOUTS) bad(`has more than ${MAX_HANDOUTS} handouts`);
  const seen = new Set();
  const handouts = [];
  for (const [i, raw] of rawHandouts.entries()) {
    const entry = typeof raw === 'string' ? { id: raw } : raw;
    if (!entry || typeof entry.id !== 'string' || !entry.id) bad(`handouts[${i}] must be a handout id or { "id": …, "scenes": [scene keys] }`);
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const tied = entry.scenes ?? [];
    if (!Array.isArray(tied) || tied.some((k) => typeof k !== 'string')) bad(`handouts[${i}].scenes must be a list of scene keys`);
    for (const k of tied) if (!keys.has(k)) bad(`handouts[${i}].scenes names "${k}", which isn't one of the scene keys`);
    handouts.push(tied.length ? { id: entry.id, scenes: [...new Set(tied)] } : { id: entry.id });
  }
  const startScene = input.startScene ?? null;
  if (startScene !== null && !keys.has(startScene)) bad(`"startScene" must be one of the scene keys (${[...keys].join(', ')})`);
  return { name, description, scenes, handouts, startScene };
}
