import { GameError } from './state.js';

// Handouts: notes, letters, maps and clues the DM prepares and reveals to players. A handout has
// Markdown text, a cover image, or both. Limits keep game state bounded: every game copy travels
// with the DM's state on every change.
export const MAX_HANDOUTS = 40;
export const HANDOUT_TITLE_MAX = 80;
export const HANDOUT_TEXT_MAX = 8000;
export const HANDOUT_NOTES_MAX = 2000;

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
//   { name, description?, scenes: [{ key?, template, name? }], handouts?: [id], startScene? }
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
    return { key, template: s.template, ...(s.name ? { name: String(s.name).trim().slice(0, 60) } : {}) };
  });
  const handouts = input.handouts ?? [];
  if (!Array.isArray(handouts) || handouts.some((h) => typeof h !== 'string' || !h)) bad('"handouts" must be a list of handout ids');
  if (handouts.length > MAX_HANDOUTS) bad(`has more than ${MAX_HANDOUTS} handouts`);
  const startScene = input.startScene ?? null;
  if (startScene !== null && !keys.has(startScene)) bad(`"startScene" must be one of the scene keys (${[...keys].join(', ')})`);
  return { name, description, scenes, handouts: [...new Set(handouts)], startScene };
}
