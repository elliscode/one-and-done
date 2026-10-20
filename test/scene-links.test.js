import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setup, ok, DM, ROOT, fixedSettings } from './helpers.js';
import { projectForPlayer } from '../core/project.js';
import { validateAdventure } from '../core/handouts.js';
import { MAX_SCENE_LINKS } from '../core/state.js';
import { openDb } from '../server/db.js';
import { loadContent } from '../server/content.js';
import { TemplateStore } from '../server/templates.js';
import { HandoutStore } from '../server/handouts.js';
import { GameService } from '../server/games/service.js';

function withScenes(n) {
  const s = setup();
  const ids = Array.from({ length: n }, () => ok(s.run(DM, { type: 'scene.add', templateId: s.tpl.id })).sceneId);
  return { ...s, ids };
}

test('scene.setNext stores links in order, without duplicates or self-links', () => {
  const s = withScenes(4);
  const [a, b, c, d] = s.ids;
  ok(s.run(DM, { type: 'scene.setNext', sceneId: a, next: [c, b, c, a] }));
  assert.deepEqual(s.state().scenes[a].next, [c, b]);
  ok(s.run(DM, { type: 'scene.setNext', sceneId: a, next: [d] }));
  assert.deepEqual(s.state().scenes[a].next, [d], 'the list is replaced, not merged');
  ok(s.run(DM, { type: 'scene.setNext', sceneId: a, next: [] }));
  assert.equal('next' in s.state().scenes[a], false, 'an empty list clears the field');
  // Links never restrict activation.
  ok(s.run(DM, { type: 'scene.setNext', sceneId: a, next: [b] }));
  ok(s.run(DM, { type: 'scene.activate', sceneId: a }));
  ok(s.run(DM, { type: 'scene.activate', sceneId: d }));
  assert.equal(s.state().activeSceneId, d);
});

test('scene.setNext is validated and DM-only', () => {
  const s = withScenes(MAX_SCENE_LINKS + 2);
  const [a, ...rest] = s.ids;
  assert.equal(s.run(DM, { type: 'scene.setNext', sceneId: 'nope', next: [] }).error, 'Unknown scene');
  assert.equal(s.run(DM, { type: 'scene.setNext', sceneId: a, next: ['nope'] }).error, 'Unknown scene');
  assert.match(s.run(DM, { type: 'scene.setNext', sceneId: a, next: 'x' }).error, /list/);
  assert.match(s.run(DM, { type: 'scene.setNext', sceneId: a, next: rest }).error, /at most 8/);
  ok(s.run(DM, { type: 'scene.setNext', sceneId: a, next: rest.slice(0, MAX_SCENE_LINKS) }));
  const p = s.join('Ana');
  assert.equal(s.run(p, { type: 'scene.setNext', sceneId: a, next: [] }).error, 'Not allowed');
});

test('removing a scene removes it from other scenes\' links', () => {
  const s = withScenes(3);
  const [a, b, c] = s.ids;
  ok(s.run(DM, { type: 'scene.setNext', sceneId: a, next: [b, c] }));
  ok(s.run(DM, { type: 'scene.setNext', sceneId: c, next: [b] }));
  ok(s.run(DM, { type: 'scene.remove', sceneId: b }));
  assert.deepEqual(s.state().scenes[a].next, [c]);
  assert.equal('next' in s.state().scenes[c], false);
  assert.deepEqual(JSON.parse(JSON.stringify(s.state())), s.state());
});

test('players never see the links', () => {
  const s = withScenes(2);
  const [a, b] = s.ids;
  const p = s.join('Ana');
  ok(s.run(DM, { type: 'scene.setNext', sceneId: a, next: [b] }));
  ok(s.run(DM, { type: 'scene.activate', sceneId: a }));
  const view = projectForPlayer(s.state(), p.playerId, () => 'online');
  assert.equal(view.scene.id, a);
  assert.equal('next' in view.scene, false);
  assert.deepEqual(s.state().scenes[a].next, [b], 'the projection does not touch the game state');
});

test('adventure files can declare links between their scenes', () => {
  const s = setup();
  const g = s.service.createGame('', { adventureId: 'builtin:fixture-quest' });
  const st = s.service.get(g.id).state;
  const [cave, hall] = st.sceneOrder;
  assert.deepEqual(st.scenes[cave].next, [hall]);
  assert.equal('next' in st.scenes[hall], false);

  const scenes = [{ key: 'a', template: 't' }, { key: 'b', template: 't', next: ['a', 'a'] }];
  assert.deepEqual(validateAdventure({ name: 'x', scenes }).scenes[1].next, ['a']);
  assert.throws(() => validateAdventure({ name: 'x', scenes: [{ key: 'a', template: 't', next: ['zzz'] }] }), /"zzz", which isn't one of the scene keys/);
  assert.throws(() => validateAdventure({ name: 'x', scenes: [{ key: 'a', template: 't', next: ['a'] }] }), /itself/);
  assert.throws(() => validateAdventure({ name: 'x', scenes: [{ key: 'a', template: 't', next: 'b' }] }), /list of scene keys/);
});

test('the shipped Training Grounds links the yard to the courtyard', () => {
  const real = loadContent(join(ROOT, 'data'));
  const db = openDb(':memory:');
  const service = new GameService({
    db, content: real, templates: new TemplateStore(db, { builtins: real }), handouts: new HandoutStore(db, { builtins: real }),
    adventures: { get: (id) => real.adventure(id) }, settings: fixedSettings(), now: () => 1_000_000,
  });
  const st = service.get(service.createGame('', { adventureId: 'builtin:training-grounds' }).id).state;
  const byName = Object.fromEntries(Object.values(st.scenes).map((sc) => [sc.name, sc]));
  assert.deepEqual(byName['Training Yard'].next, [byName['Courtyard Ambush'].id]);
  service.close();
  real.close();
});
