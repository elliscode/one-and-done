import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPredictor, squaresBetween } from '../client/js/predict.js';

const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
const moveTo = (x, y, movedAtSend, dist) => (s) => {
  s.entities[0].position = { x, y };
  s.turn.moved = Math.max(s.turn.moved, movedAtSend + dist);
};
const base = () => ({ entities: [{ id: 'e1', position: { x: 0, y: 0 } }], turn: { moved: 0 } });

test('a prediction shows at once and goes when the confirming state arrives before the reply', async () => {
  let changes = 0;
  const p = createPredictor({ onChange: () => changes++ });
  const server = base();
  assert.equal(p.view(server), server, 'no copy when nothing is pending');
  const reply = deferred();
  const done = p.run(() => reply.promise, moveTo(3, 1, 0, 3));
  assert.deepEqual(p.view(server).entities[0].position, { x: 3, y: 1 });
  assert.equal(p.view(server).turn.moved, 3);
  assert.deepEqual(server.entities[0].position, { x: 0, y: 0 }, 'the server state is never mutated');

  // The server's state (with the move) arrives, then the reply. No double-counting meanwhile.
  const after = { entities: [{ id: 'e1', position: { x: 3, y: 1 } }], turn: { moved: 3 } };
  p.onState();
  assert.equal(p.view(after).turn.moved, 3);
  reply.resolve(true);
  assert.equal(await done, true);
  assert.equal(p.size, 0);
  assert.equal(p.view(after), after);
  assert.ok(changes >= 2);
});

test('a reply before any state keeps the prediction until the next state', async () => {
  const p = createPredictor();
  const done = p.run(async () => ({ ok: 1 }), moveTo(2, 2, 0, 2));
  await done;
  assert.equal(p.size, 1);
  p.onState();
  assert.equal(p.size, 0);
});

test('a failed command reverts immediately', async () => {
  const p = createPredictor();
  const server = base();
  assert.equal(await p.run(async () => null, moveTo(5, 5, 0, 5)), null);
  assert.equal(p.size, 0);
  assert.deepEqual(p.view(server).entities[0].position, { x: 0, y: 0 });
  await assert.rejects(p.run(async () => { throw new Error('timeout'); }, moveTo(1, 1, 0, 1)), /timeout/);
  assert.equal(p.size, 0);
});

test('a settled prediction with no state is dropped after the timeout', async () => {
  const p = createPredictor({ settleTimeoutMs: 20 });
  await p.run(async () => true, moveTo(1, 0, 0, 1));
  assert.equal(p.size, 1);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(p.size, 0);
});

test('a prediction that throws on a changed state is skipped', () => {
  const p = createPredictor();
  p.run(() => new Promise(() => {}), (s) => { s.entities.find((e) => e.id === 'gone').position = { x: 1, y: 1 }; });
  const server = base();
  assert.deepEqual(p.view(server), server);
});

test('squaresBetween matches core movement cost', () => {
  assert.equal(squaresBetween({ x: 0, y: 0 }, { x: 3, y: 1 }), 3);
  assert.equal(squaresBetween({ x: 4, y: 4 }, { x: 2, y: 7 }), 3);
});
