import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, ok, DM } from './helpers.js';
import { projectForPlayer, projectForDm } from '../core/project.js';
import { upgradeState } from '../core/state.js';
import { normalizeHandout, MAX_HANDOUTS, HANDOUT_TEXT_MAX } from '../core/handouts.js';

const presence = () => 'online';
const playerView = (s, actor) => projectForPlayer(s.state(), actor.playerId, presence);

test('a library handout is copied into the game, hidden until revealed', () => {
  const s = setup();
  const lib = s.handouts.create({ title: 'Ransom note', text: 'Bring **100 gold**.', dmNotes: 'From the baron' });
  const id = ok(s.run(DM, { type: 'handout.add', handoutId: lib.id })).handoutId;
  const ho = s.state().handouts[id];
  assert.deepEqual(ho, { id, sourceId: lib.id, title: 'Ransom note', text: 'Bring **100 gold**.', image: null, dmNotes: 'From the baron', revealed: false });
  assert.deepEqual(s.state().handoutOrder, [id]);
  // Editing the game copy leaves the library alone, and the other way round.
  ok(s.run(DM, { type: 'handout.update', handoutId: id, title: 'Ransom note (torn)' }));
  s.handouts.update(lib.id, { title: 'Changed', text: 'New' });
  assert.equal(s.state().handouts[id].title, 'Ransom note (torn)');
  assert.equal(s.state().handouts[id].text, 'Bring **100 gold**.');
  assert.equal(s.handouts.get(lib.id).title, 'Changed');
});

test('players see only revealed handouts, never DM notes or the source', () => {
  const s = setup();
  const a = s.join('Ana');
  const shown = ok(s.run(DM, { type: 'handout.create', title: 'Map', image: '/static/handouts/map.webp', dmNotes: 'secret' })).handoutId;
  ok(s.run(DM, { type: 'handout.create', title: 'Hidden', text: 'not yet' }));
  assert.deepEqual(playerView(s, a).handouts, []);
  ok(s.run(DM, { type: 'handout.reveal', handoutId: shown }));
  assert.deepEqual(playerView(s, a).handouts, [{ id: shown, title: 'Map', text: null, image: '/static/handouts/map.webp', forScene: false }]);
  // The DM sees everything, including notes.
  const dm = projectForDm(s.state(), presence);
  assert.equal(Object.keys(dm.handouts).length, 2);
  assert.equal(dm.handouts[shown].dmNotes, 'secret');
  ok(s.run(DM, { type: 'handout.hide', handoutId: shown }));
  assert.deepEqual(playerView(s, a).handouts, []);
});

test('revealing writes a public feed row; adding, hiding and removing are DM-only notes', () => {
  const s = setup();
  const id = ok(s.run(DM, { type: 'handout.create', title: 'Clue', text: 'A bloody glove' })).handoutId;
  ok(s.run(DM, { type: 'handout.reveal', handoutId: id }));
  ok(s.run(DM, { type: 'handout.reveal', handoutId: id })); // already shown: no second row
  ok(s.run(DM, { type: 'handout.hide', handoutId: id }));
  ok(s.run(DM, { type: 'handout.remove', handoutId: id }));
  const player = s.service.history(s.game.id, 'player').feed.map((f) => f.text);
  assert.deepEqual(player.filter((t) => t.includes('Clue')), ['📜 The DM shared "Clue"']);
  const dm = s.service.history(s.game.id, 'dm').feed.map((f) => f.text).filter((t) => t.includes('Clue'));
  assert.equal(dm.length, 4);
  assert.deepEqual(s.state().handouts, {});
  assert.deepEqual(s.state().handoutOrder, []);
});

test('only the DM can manage handouts', () => {
  const s = setup();
  const a = s.join('Ana');
  const id = ok(s.run(DM, { type: 'handout.create', title: 'Note', text: 'hi' })).handoutId;
  for (const cmd of [
    { type: 'handout.create', title: 'x', text: 'y' }, { type: 'handout.reveal', handoutId: id },
    { type: 'handout.update', handoutId: id, title: 'z' }, { type: 'handout.remove', handoutId: id },
  ]) {
    assert.equal(s.run(a, cmd).error, 'Not allowed', cmd.type);
  }
});

test('handouts are validated and capped', () => {
  const s = setup();
  assert.match(s.run(DM, { type: 'handout.create', title: 'Empty' }).error, /needs some text or an image/);
  assert.match(s.run(DM, { type: 'handout.create', title: 'Long', text: 'x'.repeat(HANDOUT_TEXT_MAX + 1) }).error, /under 8,000/);
  assert.equal(s.run(DM, { type: 'handout.add', handoutId: 'nope' }).error, 'Unknown handout');
  assert.equal(s.run(DM, { type: 'handout.reveal', handoutId: 'nope' }).error, 'Unknown handout');
  // Images must be /static paths; anything else is dropped.
  assert.equal(normalizeHandout({ text: 'a', image: 'https://evil.example/x.png' }).data.image, null);
  assert.equal(normalizeHandout({ text: 'a', image: '/static/../secret' }).data.image, null);
  assert.equal(normalizeHandout({ text: 'a' }).title, 'Untitled handout');
  s.edit((st) => {
    for (let i = 0; i < MAX_HANDOUTS; i++) {
      st.handouts[`h_${i}`] = { id: `h_${i}`, sourceId: null, title: `${i}`, text: 'x', image: null, dmNotes: null, revealed: false };
      st.handoutOrder.push(`h_${i}`);
    }
  });
  assert.match(s.run(DM, { type: 'handout.create', title: 'One more', text: 'x' }).error, /at most 40 handouts/);
});

test('games from before handouts get empty handout lists on load', () => {
  const old = { players: {}, options: { playersCanLeave: false }, combat: { pausedMs: null } };
  assert.equal(upgradeState(old), true);
  assert.deepEqual(old.handouts, {});
  assert.deepEqual(old.handoutOrder, []);
  assert.equal(upgradeState(old), false);
});

test('game state with handouts survives a JSON round-trip', () => {
  const s = setup();
  ok(s.run(DM, { type: 'handout.create', title: 'Note', text: 'hi' }));
  assert.deepEqual(JSON.parse(JSON.stringify(s.state())), s.state());
});

test('handouts can be tied to scenes; players only learn whether it is the current one', () => {
  const s = setup();
  const a = s.join('Ana');
  const cave = ok(s.run(DM, { type: 'scene.add', templateId: s.tpl.id })).sceneId;
  const forest = ok(s.run(DM, { type: 'scene.add', templateId: s.tpl2.id })).sceneId;
  const id = ok(s.run(DM, { type: 'handout.create', title: 'Cave map', text: 'x', sceneIds: [cave] })).handoutId;
  assert.deepEqual(s.state().handouts[id].sceneIds, [cave]);
  ok(s.run(DM, { type: 'handout.setScenes', handoutId: id, sceneIds: [cave, forest, cave] }));
  assert.deepEqual(s.state().handouts[id].sceneIds, [cave, forest]);
  assert.equal(s.run(DM, { type: 'handout.setScenes', handoutId: id, sceneIds: ['nope'] }).error, 'Unknown scene');
  assert.equal(s.run(a, { type: 'handout.setScenes', handoutId: id, sceneIds: [] }).error, 'Not allowed');

  ok(s.run(DM, { type: 'handout.reveal', handoutId: id }));
  ok(s.run(DM, { type: 'handout.setScenes', handoutId: id, sceneIds: [cave] }));
  ok(s.run(DM, { type: 'scene.activate', sceneId: forest }));
  assert.equal(playerView(s, a).handouts[0].forScene, false);
  ok(s.run(DM, { type: 'scene.activate', sceneId: cave }));
  const seen = playerView(s, a).handouts[0];
  assert.equal(seen.forScene, true);
  assert.equal('sceneIds' in seen, false, 'scene ids stay private');

  // Removing the scene unties it; an empty list clears the field.
  ok(s.run(DM, { type: 'scene.remove', sceneId: cave }));
  assert.equal('sceneIds' in s.state().handouts[id], false);
  ok(s.run(DM, { type: 'handout.setScenes', handoutId: id, sceneIds: [forest] }));
  ok(s.run(DM, { type: 'handout.setScenes', handoutId: id, sceneIds: [] }));
  assert.equal('sceneIds' in s.state().handouts[id], false);
});
