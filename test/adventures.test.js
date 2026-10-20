import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setup, ok, DM, ROOT, FIXTURE_DATA, content, fixedSettings } from './helpers.js';
import { openDb } from '../server/db.js';
import { loadContent } from '../server/content.js';
import { TemplateStore } from '../server/templates.js';
import { HandoutStore } from '../server/handouts.js';
import { GameService } from '../server/games/service.js';
import { validateAdventure } from '../core/handouts.js';

test('built-ins load from data/ with builtin: ids and show up in the libraries', () => {
  const s = setup();
  assert.deepEqual(content.scenes().map((t) => t.id).sort(), ['builtin:fixture-cave', 'builtin:fixture-hall']);
  assert.equal(s.templates.get('builtin:fixture-cave').name, 'Fixture Cave');
  assert.ok(s.templates.list().some((t) => t.id === 'builtin:fixture-hall' && t.builtIn));
  assert.ok(s.handouts.list().some((h) => h.id === 'builtin:fixture-map' && h.builtIn && h.image === '/static/handouts/map.webp'));
  assert.equal(content.adventure('builtin:fixture-quest').name, 'Fixture Quest');
  // Built-in images count as "in use" on the Assets page.
  assert.equal(s.templates.imageRefs().get('/static/backgrounds/hall.webp'), 1);
  assert.equal(s.handouts.imageRefs().get('/static/handouts/map.webp'), 1);
});

test('built-ins are read-only; duplicating makes an editable copy', () => {
  const s = setup();
  assert.throws(() => s.templates.update('builtin:fixture-cave', { name: 'x' }), /can't be edited/);
  assert.throws(() => s.templates.delete('builtin:fixture-cave'), /can't be deleted/);
  assert.throws(() => s.handouts.update('builtin:fixture-letter', { title: 'x', text: 'y' }), /can't be edited/);
  assert.throws(() => s.handouts.delete('builtin:fixture-letter'), /can't be deleted/);
  const src = s.handouts.get('builtin:fixture-letter');
  const copy = s.handouts.create({ ...src.data, title: `${src.title} copy` });
  assert.ok(!copy.id.startsWith('builtin:'));
  assert.equal(s.handouts.update(copy.id, { title: 'Mine', text: 'edited' }).title, 'Mine');
});

test('a game made from an adventure has its scenes, handouts and start scene', () => {
  const s = setup();
  const g = s.service.createGame('', { adventureId: 'builtin:fixture-quest' });
  assert.equal(g.name, 'Fixture Quest');
  const st = s.service.get(g.id).state;
  assert.deepEqual(st.sceneOrder.map((id) => st.scenes[id].name), ['Fixture Cave', 'Great Hall']);
  assert.equal(st.scenes[st.activeSceneId].name, 'Great Hall');
  assert.deepEqual(st.handoutOrder.map((id) => st.handouts[id].title), ['Fixture Letter', 'Fixture Map']);
  assert.ok(st.handoutOrder.every((id) => st.handouts[id].revealed === false));
  assert.equal(st.handouts[st.handoutOrder[0]].sourceId, 'builtin:fixture-letter');
  const rats = Object.values(st.entities).filter((e) => e.defId === 'rat');
  assert.equal(rats.length, 1, 'the scene template creatures come along');
  const feed = s.service.history(g.id, 'player').feed.map((f) => f.text);
  assert.ok(feed.includes('The party enters Great Hall'));
  assert.equal(s.service.listGames().find((x) => x.id === g.id).handouts, 2);
});

test('adventure.load only runs on an empty game and fails whole on a missing piece', () => {
  const s = setup();
  ok(s.run(DM, { type: 'handout.create', title: 'Note', text: 'x' }));
  assert.match(s.run(DM, { type: 'adventure.load', adventureId: 'builtin:fixture-quest' }).error, /empty game/);
  assert.equal(s.run(DM, { type: 'adventure.load', adventureId: 'builtin:nope' }).error, 'Unknown adventure');
  const a = s.join('Ana');
  assert.equal(s.run(a, { type: 'adventure.load', adventureId: 'builtin:fixture-quest' }).error, 'Not allowed');

  // A lookup that hands back an adventure whose handout is gone: nothing is added.
  const before = s.service.listGames().length;
  const adv = { ...content.adventure('builtin:fixture-quest'), handouts: ['builtin:missing'] };
  s.service.adventures = { get: (id) => (id === 'broken' ? adv : null) };
  const g = s.service.createGame('Fresh');
  assert.match(s.service.dispatch(g.id, DM, { type: 'adventure.load', adventureId: 'broken' }).error, /needs the handout "builtin:missing"/);
  assert.deepEqual(s.service.get(g.id).state.sceneOrder, []);
  // Through createGame, the half-made game is deleted again.
  assert.throws(() => s.service.createGame('', { adventureId: 'broken' }), /needs the handout/);
  assert.throws(() => s.service.createGame('', { adventureId: 'nope' }), /Unknown adventure/);
  assert.equal(s.service.listGames().length, before + 1, 'only "Fresh" was kept');
});

test('adventure files are checked; one with missing pieces is hidden with a warning', () => {
  assert.throws(() => validateAdventure({ name: 'x', scenes: [] }), /at least one/);
  assert.throws(() => validateAdventure({ name: 'x', scenes: [{ key: 'a', template: 't' }], startScene: 'b' }), /startScene/);
  assert.throws(() => validateAdventure({ scenes: [{ template: 't' }] }), /name/);
  assert.equal(validateAdventure({ name: 'x', scenes: [{ template: 't' }] }).scenes[0].key, 'scene-1');

  const dir = mkdtempSync(join(tmpdir(), 'one-and-done-adv-'));
  try {
    cpSync(FIXTURE_DATA, dir, { recursive: true });
    writeFileSync(join(dir, 'adventures', 'lost.json'), JSON.stringify({ name: 'Lost', scenes: [{ template: 'builtin:gone' }] }));
    const warn = console.warn;
    console.warn = () => {};
    let c;
    try { c = loadContent(dir); } finally { console.warn = warn; }
    assert.equal(c.adventure('builtin:lost'), null);
    assert.ok(c.adventure('builtin:fixture-quest'));
    writeFileSync(join(dir, 'handouts', 'bad.json'), '{ "title": "No body" }');
    const r = c.reload();
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.startsWith('handouts/bad.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the shipped Training Grounds adventure loads and runs', () => {
  const real = loadContent(join(ROOT, 'data'));
  const db = openDb(':memory:');
  const templates = new TemplateStore(db, { builtins: real });
  const handouts = new HandoutStore(db, { builtins: real });
  const service = new GameService({
    db, content: real, templates, handouts, adventures: { get: (id) => real.adventure(id) }, settings: fixedSettings(), now: () => 1_000_000,
  });
  const g = service.createGame('', { adventureId: 'builtin:training-grounds' });
  const st = service.get(g.id).state;
  assert.equal(st.sceneOrder.length, 2);
  assert.equal(st.scenes[st.activeSceneId].name, 'Training Yard');
  assert.equal(st.handoutOrder.length, 2);
  const placed = Object.values(st.entities).filter((e) => e.positions[e.sceneId]);
  assert.equal(placed.length, 7, 'every starter creature exists and is on its map');
  service.close();
  real.close();
});
