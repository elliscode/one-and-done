import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server as SocketServer } from 'socket.io';
import { openDb } from './db.js';
import { loadContent, ContentError } from './content.js';
import { createAssetStore, AssetError, MAX_ASSET_BYTES } from './assets.js';
import { createAuth, DM_COOKIE } from './auth.js';
import { TemplateStore } from './templates.js';
import { HandoutStore } from './handouts.js';
import { GameService } from './games/service.js';
import { GameError } from '../core/state.js';
import { attachSockets } from './sockets.js';
import { previewMeta, renderPlayPage } from './preview.js';
import { loadSettings, SettingsError } from './settings.js';
import { ROLE_STRENGTHS, describeStrength } from '../core/roles.js';
import { readFileSync, existsSync, renameSync } from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DB = join(ROOT, 'data', 'one-and-done.sqlite');
// The database's name before the app was renamed to One & Done.
const LEGACY_DB = join(ROOT, 'data', 'd-and-e.sqlite');

// Moves a pre-rename database (and its WAL files) to the new default name on first start. Only the
// default location is touched; an explicit DB_FILE is used as given.
export function adoptLegacyDb(file, { defaultFile = DEFAULT_DB, legacyFile = LEGACY_DB } = {}) {
  if (file !== defaultFile || existsSync(file) || !existsSync(legacyFile)) return false;
  for (const ext of ['', '-wal', '-shm']) if (existsSync(legacyFile + ext)) renameSync(legacyFile + ext, file + ext);
  console.log(`Moved ${legacyFile} to ${file}`);
  return true;
}

export function createServer({
  dbFile = DEFAULT_DB,
  contentDir = join(ROOT, 'data'),
  staticDir = join(ROOT, 'static'),
  clientDir = join(ROOT, 'client'),
  password,
  secret,
  graceMs = 60_000,
  secureCookies = false,
  watchContent = false,
  publicUrl = null,
} = {}) {
  adoptLegacyDb(dbFile);
  const db = openDb(dbFile);
  const settings = loadSettings(contentDir);
  const content = loadContent(contentDir, { staticDir, watchFiles: watchContent });
  const assets = createAssetStore(staticDir);
  const auth = createAuth({ password, secret });
  const templates = new TemplateStore(db, { builtins: content });
  const handouts = new HandoutStore(db, { builtins: content });
  const adventures = { get: (id) => content.adventure(id) };
  const service = new GameService({ db, content, templates, handouts, adventures, settings, graceMs });
  service.restoreAll();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '1mb' }));

  const requireDm = (req, res, next) => (auth.isDmCookieHeader(req.headers.cookie) ? next() : res.status(401).json({ error: 'DM login required' }));
  const handle = (fn) => (req, res) => {
    try {
      const out = fn(req, res);
      if (out !== undefined) res.json(out);
    } catch (err) {
      if (err instanceof GameError) return res.status(400).json({ error: err.message });
      if (err instanceof ContentError) return res.status(err.status).json({ error: err.message, errors: err.errors, warnings: err.warnings });
      if (err instanceof AssetError) return res.status(err.status).json({ error: err.message });
      if (err instanceof SettingsError) return res.status(400).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  };

  // ---- auth ----
  app.post('/api/login', async (req, res) => {
    if (!auth.checkPassword(req.body?.password)) {
      await new Promise((r) => setTimeout(r, 600));
      return res.status(401).json({ error: 'Wrong password' });
    }
    res.cookie(DM_COOKIE, auth.issueToken(), {
      httpOnly: true, sameSite: 'lax', secure: secureCookies, maxAge: auth.cookieMaxAgeMs, path: '/',
    });
    res.json({ ok: true });
  });
  app.post('/api/logout', (req, res) => {
    res.clearCookie(DM_COOKIE, { path: '/' });
    res.json({ ok: true });
  });
  app.get('/api/me', (req, res) => res.json({ dm: auth.isDmCookieHeader(req.headers.cookie) }));

  // ---- content ----
  app.get('/api/content/public', (req, res) => res.json(content.publicContent(settings.get().roleStrength)));
  app.get('/api/content', requireDm, (req, res) => res.json(content.dmContent()));

  // ---- assets (static art) ----
  const assetUsage = () => {
    const counts = templates.imageRefs();
    for (const [path, n] of handouts.imageRefs()) counts.set(path, (counts.get(path) ?? 0) + n);
    for (const d of [...content.characters, ...content.monsters, ...content.npcs]) {
      if (d.image) counts.set(d.image, (counts.get(d.image) ?? 0) + 1);
    }
    return (path) => counts.get(path) ?? 0;
  };
  // Plain path lists (used by the scene editor palettes).
  app.get('/api/assets', requireDm, handle(() => assets.paths()));
  app.get('/api/assets/files', requireDm, handle(() => assets.list(assetUsage())));
  app.post('/api/assets/:folder', requireDm, express.raw({ type: () => true, limit: MAX_ASSET_BYTES }), handle((req) => {
    const r = assets.save(req.params.folder, req.query.name, req.body, { overwrite: req.query.overwrite === '1' });
    notifyContent();
    return r;
  }));
  app.delete('/api/assets/:folder/:name', requireDm, handle((req) => {
    assets.remove(req.params.folder, req.params.name);
    notifyContent();
    return { ok: true };
  }));

  // ---- global settings ----
  const settingsView = () => ({
    ...settings.get(),
    options: ROLE_STRENGTHS.map((n) => ({ value: n, label: `${n} — ${describeStrength(n)}` })),
  });
  app.get('/api/settings', requireDm, handle(() => settingsView()));
  app.put('/api/settings', requireDm, handle((req) => {
    if (req.body?.roleStrength !== undefined) settings.setRoleStrength(req.body.roleStrength);
    return settingsView();
  }));

  // ---- data (definition JSON files) ----
  const textBody = express.text({ type: () => true, limit: '2mb' });
  app.get('/api/data', requireDm, handle(() => content.listFiles()));
  app.get('/api/data/:category/:file', requireDm, handle((req) => ({ text: content.readFile(req.params.category, req.params.file) })));
  app.put('/api/data/:category/:file', requireDm, textBody, handle((req) => ({ ok: true, ...content.writeFile(req.params.category, req.params.file, req.body) })));
  app.post('/api/data/:category', requireDm, textBody, handle((req) => {
    const text = typeof req.body === 'string' && req.body.trim() ? req.body : '[]';
    return { ok: true, ...content.writeFile(req.params.category, req.query.name, text, { create: true }) };
  }));
  app.delete('/api/data/:category/:file', requireDm, handle((req) => {
    content.deleteFile(req.params.category, req.params.file);
    return { ok: true };
  }));

  // ---- scene templates ----
  app.get('/api/scenes', requireDm, handle(() => templates.list()));
  app.post('/api/scenes', requireDm, handle((req) => templates.create(req.body)));
  app.get('/api/scenes/:id', requireDm, (req, res) => {
    const t = templates.get(req.params.id);
    if (t) res.json(t);
    else res.status(404).json({ error: 'Scene not found' });
  });
  app.put('/api/scenes/:id', requireDm, handle((req) => templates.update(req.params.id, req.body)));
  app.delete('/api/scenes/:id', requireDm, handle((req) => ({ ok: templates.delete(req.params.id) })));

  // ---- handout library ----
  app.get('/api/handouts', requireDm, handle(() => handouts.list()));
  app.post('/api/handouts', requireDm, handle((req) => handouts.create(req.body)));
  app.get('/api/handouts/:id', requireDm, (req, res) => {
    const ho = handouts.get(req.params.id);
    if (ho) res.json(ho);
    else res.status(404).json({ error: 'Handout not found' });
  });
  app.put('/api/handouts/:id', requireDm, handle((req) => handouts.update(req.params.id, req.body)));
  app.delete('/api/handouts/:id', requireDm, handle((req) => ({ ok: handouts.delete(req.params.id) })));

  // ---- built-in adventures ----
  app.get('/api/adventures', requireDm, handle(() => content.adventures()
    .map(({ id, name, description, scenes, handouts: hs }) => ({ id, name, description, scenes: scenes.length, handouts: hs.length }))
    .sort((a, b) => a.name.localeCompare(b.name))));

  // ---- games ----
  app.get('/api/games', requireDm, handle(() => service.listGames()));
  app.post('/api/games', requireDm, handle((req) => service.createGame(req.body?.name, { adventureId: req.body?.adventureId ?? null })));
  app.delete('/api/games/:id', requireDm, handle((req) => ({ ok: service.deleteGame(req.params.id) })));

  // ---- pages ----
  // The DM app lives under /dm; / is a landing page. Old paths redirect (keeping the query
  // string, e.g. ?next=) so bookmarks keep working.
  const page = (file) => (req, res) => res.sendFile(join(clientDir, file));
  const moved = (to) => (req, res) => {
    const q = req.originalUrl.indexOf('?');
    res.redirect(301, to(req) + (q >= 0 ? req.originalUrl.slice(q) : ''));
  };
  app.get('/', page('landing.html'));
  app.get('/dm', page('index.html'));
  app.get('/dm/login', page('login.html'));
  app.get('/dm/scenes/:id', page('scene-editor.html'));
  app.get('/dm/handouts/:id', page('handout-editor.html'));
  app.get('/dm/games/:id', page('dm-game.html'));
  app.get('/dm/assets', page('assets.html'));
  app.get('/dm/data', page('data.html'));
  app.get('/login', moved(() => '/dm/login'));
  app.get('/scenes/:id', moved((req) => `/dm/scenes/${encodeURIComponent(req.params.id)}`));
  app.get('/games/:id', moved((req) => `/dm/games/${encodeURIComponent(req.params.id)}`));
  app.get('/assets', moved(() => '/dm/assets'));
  app.get('/data', moved(() => '/dm/data'));
  // Player page, with per-game link-preview metadata rendered into the HTML for crawlers.
  app.get('/g/:token', (req, res) => {
    const base = (publicUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    const game = service.getByToken(req.params.token);
    const html = renderPlayPage(readFileSync(join(clientDir, 'play.html'), 'utf8'), previewMeta({ game, base, staticDir }));
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(html);
  });
  // No caching so replaced uploads show up immediately (ETags still avoid re-downloads). The CSP
  // keeps an uploaded SVG from running scripts if someone opens it directly.
  app.use('/static', (req, res, next) => {
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  }, express.static(staticDir, { maxAge: 0 }));
  app.use(express.static(clientDir, { index: false }));

  const httpServer = createHttpServer(app);
  const io = new SocketServer(httpServer, { serveClient: true });
  attachSockets(io, { service, auth });

  // Tell every open page that definitions or art changed so it can refetch.
  let notifyTimer = null;
  function notifyContent() {
    clearTimeout(notifyTimer);
    notifyTimer = setTimeout(() => {
      io.of('/play').emit('contentChanged');
      io.of('/dm').emit('contentChanged');
    }, 50);
  }
  content.on('change', notifyContent);
  // Role strength applies on the next hit/heal everywhere; tell open pages and note it for DMs.
  settings.on('change', ({ before, after }) => {
    notifyContent();
    service.noteToLoadedGames(`Role strength changed from ${before} to ${after}: ${describeStrength(after)}`);
  });

  return {
    app, httpServer, io, service, db, content, settings,
    close() {
      service.close();
      content.close();
      clearTimeout(notifyTimer);
      return new Promise((r) => io.close(() => { db.close(); r(); }));
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const password = process.env.DM_PASSWORD;
  if (!password) {
    console.error('DM_PASSWORD is not set. Copy .env.example to .env and set it.');
    process.exit(1);
  }
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '127.0.0.1';
  const server = createServer({
    dbFile: process.env.DB_FILE || undefined,
    password,
    secret: process.env.SESSION_SECRET,
    graceMs: Number(process.env.RECONNECT_GRACE_MS) || 60_000,
    secureCookies: process.env.SECURE_COOKIES === 'true',
    watchContent: true,
    publicUrl: process.env.PUBLIC_URL || null,
  });
  server.httpServer.listen(port, host, () => console.log(`One & Done listening on http://${host}:${port}`));
  const shutdown = () => server.close().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
