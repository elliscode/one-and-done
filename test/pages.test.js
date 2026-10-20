import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../server/index.js';
import { FIXTURE_DATA } from './helpers.js';

test('pages: landing at /, the DM app under /dm, old paths redirect with their query string', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'one-and-done-pages-'));
  cpSync(FIXTURE_DATA, dir, { recursive: true });
  const server = createServer({ dbFile: ':memory:', password: 'pw', contentDir: dir });
  await new Promise((r) => server.httpServer.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  const get = (path) => fetch(`${base}${path}`, { redirect: 'manual' });
  try {
    const landing = await get('/');
    assert.equal(landing.status, 200);
    assert.match(await landing.text(), /href="\/dm"/);

    for (const [path, marker] of [
      ['/dm', 'js/home.js'], ['/dm/', 'js/home.js'], ['/dm/login', 'js/login.js'], ['/dm/games/g_1', 'js/dm.js'],
      ['/dm/scenes/tpl_1', 'js/editor.js'], ['/dm/assets', 'js/assets.js'], ['/dm/data', 'js/data.js'],
      ['/dm/handouts/ho_1', 'js/handout-editor.js'],
    ]) {
      const r = await get(path);
      assert.equal(r.status, 200, path);
      assert.ok((await r.text()).includes(marker), `${path} serves the page with ${marker}`);
    }

    for (const [from, to] of [
      ['/login?next=%2Fdm%2Fdata', '/dm/login?next=%2Fdm%2Fdata'], ['/login', '/dm/login'],
      ['/games/g_1', '/dm/games/g_1'], ['/scenes/tpl_1', '/dm/scenes/tpl_1'], ['/assets', '/dm/assets'], ['/data', '/dm/data'],
    ]) {
      const r = await get(from);
      assert.equal(r.status, 301, from);
      assert.equal(r.headers.get('location'), to, from);
    }
  } finally {
    await server.close();
  }
});
