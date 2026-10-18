# One & Done

A small multiplayer virtual tabletop for running D&D-style one-shots with a human DM. Players pick a fixed hero, move on a shared grid, and act through the action ring (the "donut") around their token. The server handles dice, HP, movement, and combat phases. The DM has the final say on everything.

Production: `https://oneshot.elliscode.com` (Mac Mini + Caddy).

## Run locally

Requires Node 22.13+ (it uses the built-in `node:sqlite`; developed on Node 24).

```sh
npm install
cp .env.example .env      # set DM_PASSWORD; set SECURE_COOKIES=false for plain http://localhost
npm start                 # http://127.0.0.1:3000 (landing page; the DM app is at /dm)
npm test                  # unit + socket integration tests
npm run test:stateless    # the same tests with no in-memory game cache (serverless check)
```

`npm run dev` restarts the server when files change.

## How it works

- **Scenes** (DM home → Scenes) are reusable map templates. Each one has a background, an independent grid (columns, rows, cell size, offset), starting NPC/monster placements, and a player spawn square. The default spawn is the bottom-left square.
- **Games** are actual adventures. When you add a scene to a game, the game gets its own live copy (a *scene instance*). Moving or hurting things in a game never changes the template, and editing the template later never changes games that already use it.
- **Players** open the game link, enter a name, pick Tank / DPS / Heal, and then pick a hero. They can do all of this before the DM shows up. The browser remembers each seat as a `playerId` plus a server-issued secret, so refreshing or reconnecting puts the player back on the same hero. Name changes keep the seat, color, and hero. The **You** menu (their name chip, top-right) changes their name and color, and once they have a hero, renames the hero too. The new hero name shows on the token, in the party list and in the DM's Players tab. Releasing the hero resets the name. If the DM allows it, the You menu also has **Leave hero…**: after an "Are you sure?" prompt the hero leaves the game (any time, even mid-combat) and the player picks a hero again. The seat, name and color stay; the hero's HP, items and effects don't.
- **DM controls** (Games → Open):
  - *Scenes tab:* add scenes, switch the active scene, remove scenes.
  - *Players tab:* see presence, change colors, **Release** (frees the hero so the player picks again), a **Let players leave their hero** switch (per game, off by default, can be changed mid-game), **✕** (removes the seat; that browser can't rejoin as that player).
  - *Banks tab:* place NPCs and monsters, choosing *scene* scope (stays in this scene) or *game* scope (follows the party).
  - *Board:* drag any token to move it. Click a stack to see every token in it, including the ones underneath. Click a token to open the inspector: damage, heal, set HP, kill, revive, scope, hostility, inventory, attacks, extra actions.
  - *Map navigation (everyone, and the scene editor):* trackpad: two-finger scroll pans, pinch zooms toward your fingers. Mouse: the wheel zooms toward the cursor, right-drag (or middle-drag) pans. Touch: one finger on the empty map pans, two fingers pinch. The **+**, **−** and **Fit** buttons are still there. Gestures over the map never scroll or zoom the page.
  - *iPad / iPhone:* the layout fits the screen that's actually visible (CSS `100dvh`, falling back to `100vh` on old browsers), so Safari's tab bar and address bar never cover the chat box or map controls, and it resizes when they appear, disappear, or the device rotates.
  - *Pings:* press and hold anywhere on the map (empty squares or tokens) to ping it for everyone, in your color. Players get 10 pings a minute; the 10th mutes their pings for a minute. The DM's pings are gold and unlimited.
  - *Top bar:* start and end combat, switch phases, set the phase timer (off / 30 / 60 / 90 / 120 / custom), and **Undo**.
- **Combat:** the game alternates between PLAYER PHASE and DM PHASE. During the player phase, every player gets one action (attack, act, ability, or item) plus their movement, in any order. Abilities with `grantsActions` give extra actions. The timer runs on the server; when it expires, the server switches phases. Players can't attack outside combat. A player who moves to the wrong square can press **↶ Undo move** in the top bar (or Ctrl/Cmd+Z) to step back and get those squares back, until they take an action; any action, the DM moving them, or the phase ending locks the moves in.
- **Enemy actions:** monsters and hostile NPCs attack, act, and use abilities only during the DM PHASE. Each gets one action per DM phase by default (set `"actions": 2` in a definition for more); moving is free and separate. The server enforces this. The ⚡ badge on enemy tokens and the inspector show what's left. To override, use **+1 action**; the DM's Damage, HP, Kill, and Revive tools ignore the budget. **Friendly NPCs** work the same way on the party's side: one action per PLAYER PHASE by default (their `actions`), spent by the DM, with the same ⚡ badge and +1 action override; their movement is still free.
- **Who has gone:** in combat the DM's top bar shows **⏳ Party 4/6 done** (PLAYER PHASE: heroes and friendly NPCs) or **⏳ Enemies 2/5 done** (DM PHASE). A creature is done when it has no actions left; it turns into a green ✓ when everyone has gone. Hover to see who's left, or click it and pick a name to open that creature's inspector.
- **Role bonuses** (automatic, shown on the role tiles): **Tank** takes 1/n damage, **DPS** deals n× damage, and **Heal** heals for n×, capped at max HP. n is the **Role strength** setting (1–5, default 4) on the DM home page. It's stored in `data/settings.json`, and changes apply to every game on the next hit or heal. Setting 1 turns role bonuses off. They apply to every attack, ability, and multi, area, or chain strike, once per hit or heal. Monsters, NPCs, and the DM's tools never get them. The feed notes them, e.g. "HIT 32 (×4 DPS)" at strength 4. See `server/games/roles.js` and the order in [docs/ABILITIES.md](docs/ABILITIES.md).
- **Tanks:** heroes with `"role": "tank"` take 1/n of incoming damage from attacks and from the DM's Damage button, rounded down with a minimum of 1 (at the default 4: 8 → 2, 3 → 1). The log shows both numbers, e.g. "takes 2 damage (8, reduced by Tank)". Healing, Set HP, Kill, and status changes are exact. A downed tank dies when the *reduced* damage reaches their max HP.
- **HP:** at 0 HP a player character or NPC goes DOWN, and their only option is a d20 roll. If a DOWN character takes damage ≥ their max HP, they die. Monsters die at 0 HP. The DM can always revive or override.
- **Hidden info:** the server strips HP and stats for monsters and hostile NPCs from everything it sends to players, including activity log text. The DM sees everything.
- **Undo** covers moves, damage/heal/HP changes, attacks, spawns and removals, scope changes, items, acts, and abilities, up to the last 20. Structural actions (scene changes, hero selection or release, combat start, end, and phase changes) clear the undo history.
- **Game Feed:** chat and game events (attacks, abilities, phases, joins, and so on) appear in one chronological feed on the right. The server orders and stores it, so a reconnect or restart reloads the same history with no duplicates. DM-only rows are marked **DM** and never reach players. Every new entry scrolls the feed to the bottom. While you're scrolled up reading older entries, a **Scroll to bottom** button appears. `/roll 2d6+1` in chat makes a server roll.
- **Abilities** run through one server-side effect engine: attacks, multi-attacks (Flurry of Blows makes 4 independent strikes), areas, chains, heals, shields, redirects, marks, taunts, slows, teleports, totems, and DM checks. Abilities that deal damage are combat-only, like weapon attacks; everything else also works while exploring. Effects show as icons on tokens and persist across phases and restarts. Pending DM checks appear as **⚖** in the DM top bar. See [docs/ABILITIES.md](docs/ABILITIES.md).
- **Training Dummy** (Monster bank): a practice target that takes unlimited damage and never goes down or dies. Its token shows the running total (Σ). The DM can reset the counter or remove it.

## Content

To generate new heroes, monsters or NPCs with an LLM, use the JSON Schemas in `schemas/`. See [docs/CHARACTER_GENERATION.md](docs/CHARACTER_GENERATION.md), [docs/MONSTER_GENERATION.md](docs/MONSTER_GENERATION.md) and [docs/NPC_GENERATION.md](docs/NPC_GENERATION.md). Check the results with `npm run validate:characters`, `npm run validate:monsters` or `npm run validate:npcs`.

Manage content from the DM home page; no restart is needed:

- **🖼 Assets** (`/dm/assets`): upload (drag and drop, several at once), replace, or delete art in `static/backgrounds`, `static/tokens`, and `static/images`. Files are checked to be real PNG, JPG, GIF, WebP, or SVG images (max 15 MB). Names get cleaned up, so `Swamp Map.png` becomes `swamp-map.png`. Each card shows how many scenes or definitions use that file.
- **📜 Data** (`/dm/data`): edit, create, upload, download, or delete the definition JSON files. A save is checked against the rules below; if anything is invalid, nothing is written and you get a list of exact errors.

Changes go live immediately. Open DM and player pages refresh their banks, hero picker, and Act menu by themselves; the scene editor has a **↻ Refresh assets & data** button. Edits made directly on disk are picked up too; a bad edit is logged and the last good content stays loaded. Tokens already in a game keep the stats they were created with; new spawns and hero picks use the new definitions. Everything is written into the repo's `data/` and `static/` folders, so changes show up in `git status` and you can commit them.

| Path | What |
| --- | --- |
| `data/characters/*.json` | Heroes (`role`: `tank` / `dps` / `heal`) |
| `data/monsters/*.json`, `data/npcs/*.json` | Bank definitions (`size: {w,h}` for large creatures; NPC `hostile: true` hides their HP) |
| `data/acts.json` | Generic actions in the Act menu (optional `roll`) |
| `static/backgrounds`, `static/tokens`, `static/images` | Art, referenced as `/static/...` |

Definitions can also set `actions` (actions per combat phase, default 1), and `"immortal": true` for training dummies. Attack fields: `attack` (to-hit dice), `damage`, `range` (squares), and optional `damageType`. Abilities use the effect schema described in [docs/ABILITIES.md](docs/ABILITIES.md). Older `heal`/`roll`/`free`/`grantsActions` fields still load. Dice notation: `NdX±M` with d4/d6/d8/d10/d12/d20, and terms can be chained (`1d8+1d6+2`). A natural 20 is a crit (damage dice doubled). A natural 1 always misses.

To change art, replace the files in `static/`, upload new ones on the Assets page, or point definitions at other files.

## Link previews

Sharing a game link (`/g/<token>`) shows a preview with the game's title, "Join my game on One & Done!", and the active scene's map. The server writes the Open Graph and Twitter/X tags into the page HTML, so crawlers don't need to run JavaScript. It only exposes the game name and map image; no players or other game state.

- Set `PUBLIC_URL=https://oneshot.elliscode.com` in `.env` so image and page URLs are absolute HTTPS. Without it, the server uses the request's host and protocol, and Caddy's `X-Forwarded-Proto` is trusted.
- Use PNG, JPG, or WebP maps. Most crawlers can't show SVG, so an SVG background uses a same-named `.png`/`.jpg`/`.webp` next to it if one exists, and otherwise the fallback card at `static/og-default.png` (1200×630; replace it to rebrand). The fallback is also used when no scene is active.
- **Check it:** `curl -s https://oneshot.elliscode.com/g/<token> | grep -E 'og:|twitter:'`. For a real preview, use the [Facebook Sharing Debugger](https://developers.facebook.com/tools/debug/), [opengraph.xyz](https://www.opengraph.xyz/), or paste the link into Discord, Slack, or iMessage.
- **Caching:** platforms cache previews, sometimes for days. The image URL includes a version that changes when the active scene (or the image file) changes, so newly fetched previews pick up the new map. Links that were already shared keep their old preview until the platform rescrapes. Use the debugger's **Scrape Again**, or share the link with a throwaway query such as `?v=2` to force a fresh preview.

## Deploy

1. `npm install --omit=dev`, then create `.env` from `.env.example`. Use a strong `DM_PASSWORD`, a random `SESSION_SECRET`, `SECURE_COOKIES=true`, and `PUBLIC_URL=https://oneshot.elliscode.com`. Keep `HOST=127.0.0.1` when Caddy runs on the same machine.
2. Start the server: `npm start` (stop it with Ctrl-C; state is saved continuously, so stopping and restarting is safe mid-game).
3. Add the site block from `deploy/Caddyfile` to your Caddy config. It proxies `oneshot.elliscode.com` to `127.0.0.1:3000`; adjust the upstream if `HOST`/`PORT` differ. Caddy handles HTTPS and the WebSocket upgrade.

**Backups:** everything lives in `data/one-and-done.sqlite` (plus the `-wal`/`-shm` files while the server runs). To back up safely while it's running, use `sqlite3 data/one-and-done.sqlite ".backup backup.sqlite"`.

## Layout

```
core/             the game engine: pure, synchronous, no I/O (shared with other deployments)
  index.js        public API (package export "one-and-done/core")
  engine.js       command pipeline: applyCommand, applyUndo, applyChat, checkPing, nextDeadline
  commands.js     every game command (validation + rules)
  effects.js      ability effect engine: schema, handlers, targeting, phase lifecycle
  status.js       live effects on entities (timing, expiry, movement allowance)
  combat.js       phases, attack rolls, the shared damage/heal pipeline, down/death
  roles.js        role bonuses (strength comes from the shell's settings)
  helpers.js      shared validation helpers
  placement.js    spawn + placement of entities in scenes
  project.js      per-viewer state (hides enemy HP from players)
  state.js        state shape, upgrades and helpers
  content.js      definition validation
  templates.js    scene template normalization
  dice.js         dice parser/roller
server/           the self-hosted shell around core/
  index.js        HTTP routes, pages, startup
  sockets.js      /play and /dm Socket.IO namespaces
  auth.js         DM password + signed cookie
  db.js           SQLite schema
  settings.js     data/settings.json (role strength)
  preview.js      link-preview (Open Graph) metadata for /g/<token>
  assets.js       art uploads for the Assets page
  content.js      loads and watches data/ definitions
  templates.js    scene template store
  games/
    service.js    game cache, core engine → persist → broadcast, undo storage, timers, presence
client/           vanilla JS pages (home, editor, DM game, player)
  js/transport.js the live game connection (Socket.IO here; swappable per deployment)
  js/config.js    API/socket base URLs (empty when self-hosted)
test/             node:test suites
```

Every state change goes through `GameService.dispatch()`. The core engine (`applyCommand`) validates the command and applies it to a copy of the game state. The service then writes the new state, Game Feed rows, and undo snapshot in one SQLite transaction, and sends each connected client its own filtered view. A failed command changes nothing. `core/` never imports from `server/`, and a test enforces it; see `docs/2026_10_16_001_CORE_SHELL_SPLIT.md` for the contract.

## License

Source-available under the [PolyForm Noncommercial License 1.0.0](PolyForm-Noncommercial-1.0.0.md): free for personal and other noncommercial use. This project doesn't accept outside contributions.

Required Notice: Copyright (c) 2026 Daniel Townsend (https://www.elliscode.com)
