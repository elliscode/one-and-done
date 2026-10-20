import { newId } from './state.js';

const clampInt = (v, min, max, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
};

// Validates and normalizes scene template data coming from the editor.
export function normalizeTemplate(input = {}) {
  const name = String(input.name ?? '').trim().slice(0, 60) || 'Untitled scene';
  const g = input.grid ?? {};
  const grid = {
    cols: clampInt(g.cols, 1, 100, 20),
    rows: clampInt(g.rows, 1, 100, 14),
    cellSize: clampInt(g.cellSize, 16, 256, 64),
    offsetX: clampInt(g.offsetX, -2000, 2000, 0),
    offsetY: clampInt(g.offsetY, -2000, 2000, 0),
    color: /^#[0-9a-f]{3,8}$/i.test(g.color ?? '') ? g.color : '#ffffff',
    opacity: Math.max(0, Math.min(1, Number(g.opacity ?? 0.25))),
  };
  const inGrid = (o) => Number.isInteger(o.x) && Number.isInteger(o.y) && o.x >= 0 && o.y >= 0 && o.x < grid.cols && o.y < grid.rows;
  const background = typeof input.background === 'string' && input.background.startsWith('/static/') ? input.background : null;
  const bgScale = Math.max(0.1, Math.min(10, Number(input.bgScale) || 1));
  const entities = (Array.isArray(input.entities) ? input.entities : []).filter(inGrid).slice(0, 200)
    .filter((e) => (e.kind === 'npc' || e.kind === 'monster') && typeof e.defId === 'string')
    .map((e) => ({
      id: typeof e.id === 'string' ? e.id.slice(0, 20) : newId('t'),
      kind: e.kind, defId: e.defId, x: e.x, y: e.y,
      ...(e.name ? { name: String(e.name).slice(0, 40) } : {}),
      // Optional starting state (hand-written built-in scenes): an NPC that starts hostile, or a
      // creature that starts dead (e.g. a body to investigate).
      ...(e.kind === 'npc' && e.hostile === true ? { hostile: true } : {}),
      ...(e.dead === true ? { dead: true } : {}),
    }));
  const spawn = input.spawn && inGrid(input.spawn) ? { x: input.spawn.x, y: input.spawn.y } : null;
  return { name, data: { background, bgScale, grid, entities, spawn } };
}
