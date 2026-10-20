# One & Done — Core / Shell Split

This is the contract between the game engine in `core/` and any shell that runs it: today the self-hosted server in `server/`, later the cloud service. Read it before building a new shell or changing the boundary.

## Background

One & Done ships two ways:
- **Self-hosted** (this repo): one Node process with SQLite, Socket.IO and in-memory timers.
- **Cloud** (a separate, private repo): AWS Lambda, API Gateway WebSockets, DynamoDB and S3/CloudFront.

The cloud repo depends on this one as a pinned package and imports `one-and-done/core`. Game rules are written once, in `core/`. Each shell only does I/O: storage, transport, timers, auth and presence.

## Part 1: What lives where

| Concern | Core (`core/`) | Shell (`server/` here) |
|---|---|---|
| Commands, rules, effects, combat, dice | ✓ | |
| Projections per viewer (`projectForDm`, `projectForPlayer`, `feedForRole`) | ✓ | |
| State shape and upgrades (`createGameState`, `upgradeState`) | ✓ | Runs `upgradeState` on every load |
| Undo: when to snapshot, what a restore copies | ✓ | Stores the stack (at most `UNDO_LIMIT`) |
| Game Feed rows | Builds rows without ids | Assigns ordering ids, stores them, serves history (`HISTORY_LIMIT`) |
| Combat phase timer | `nextDeadline(state)` | Wakes up at `at` and dispatches `cmd` as `{ role: 'system' }` |
| Ping rate limit | The rule (`checkPing`) over a limiter record | Stores the record per game and player |
| Content | Validation (`validateDefs`, `findItem`, `itemView`) | Loading, watching, editing files |
| Scene templates | `normalizeTemplate` | Storage (the DM's own, plus built-ins from `data/scenes/`) |
| Handouts | `normalizeHandout`, game copies in `state.handouts`, what players see | Library storage (the DM's own, plus built-ins from `data/handouts/`) |
| Built-in adventures | `validateAdventure`, `adventure.load` | Loading `data/adventures/`; `POST /api/games { adventureId }` creates the game, then dispatches `adventure.load` (deleting the game if it fails) |
| Settings (role strength) | Read from `deps.settings` | Storage; passes the current value on every call |
| Auth, accounts, game listing, join-token lookup | | ✓ |
| Presence (online / reconnecting / offline) | | ✓, passed into projections as `presenceOf(playerId)` |
| Assets (art uploads) | | ✓ |

**Rules for `core/`, enforced by `test/core.test.js`:**
- It imports only its own modules and `node:crypto` (for ids and seat secrets).
- No `Date.now`, `new Date`, timers, `process`, `Math.random`, or module-level `let` state.
- Everything is synchronous.

`npm run test:stateless` runs the whole suite with `GameService`'s in-memory cache turned off (`stateless: true`), so every command reloads its game from storage, as a serverless shell does.

## Part 2: The API (`core/index.js`)

### `deps`, passed to every command

| Field | Shape | Notes |
|---|---|---|
| `content` | `{ def(kind, id), act(id), item(inv) }` | Synchronous lookups. A cloud shell loads content before calling. |
| `templates` | `{ get(id) }` | Synchronous. A cloud shell prefetches the template a `scene.add` command names (`cmd.templateId`). Ids starting `builtin:` are the built-ins shipped in `data/scenes/`, the same for every account. |
| `handouts` | `{ get(id) }` → `{ id, title, data: { text, image, dmNotes } }` | Optional; `handout.add` and `adventure.load` fail cleanly without it. A cloud shell prefetches the handout `handout.add` names (`cmd.handoutId`). `builtin:` ids come from `data/handouts/`. |
| `adventures` | `{ get(id) }` → `validateAdventure` output plus `id` | Optional; only `adventure.load` uses it. For `adventure.load` a cloud shell prefetches the adventure (`cmd.adventureId`) and every template and handout it lists. |
| `settings` | `{ roleStrength }` | Required. A missing or invalid value throws instead of defaulting. |
| `rng` | `(sides) => 1..sides` | Dice. |
| `now` | number (ms) | The time of this command. |

### Functions

```js
applyCommand(state, actor, cmd, deps)
  → { ok: false, error }
  | { ok: true, state, result, feed, fx, undo: { label, snapshot } | null, clearUndo }
```
- Never mutates `state`. On success, store the returned `state`.
- If `undo` is set, push `{ label, snapshot }`. If `clearUndo` is true, empty the stack first.
- Persist `feed`, then send `fx` to clients.
- `actor` is `{ role: 'dm' }`, `{ role: 'player', playerId }`, `{ role: 'join' }` (only for `player.create`) or `{ role: 'system' }` (timers).
- The `undo` command is not handled here; use `applyUndo`.

```js
applyUndo(state, actor, entry, now)   // entry = top of the undo stack, or null
  → { ok: false, error } | { ok: true, state, result, feed }
```
On success, store `state`, pop the entry, and persist `feed`.

```js
applyChat(state, actor, text, now)
  → { error } | { roll: cmd } | { row }
```
`roll` means the text was `/roll …` or `/r …`: dispatch it as a command. `row` is a chat row to store.

```js
checkPing(state, actor, pos, limiter, now)
  → { ping, limiter } | { error, limiter }
```
Store `limiter` per game and player (it's `null` for the DM). Send `ping` to everyone who has joined, plus the DM. Pings are never stored.

```js
nextDeadline(state) → { at, cmd } | null
```
At time `at`, dispatch `cmd` as `{ role: 'system' }`. Call it again after every successful command and replace any pending wake-up. A stale wake-up is harmless: `combat.timerExpired` checks `phaseEndsAt`.

**Pausing the phase timer (optional for a shell).** A shell whose clock depends on the DM can dispatch these as `{ role: 'system' }`:
- `combat.timerPause` while the DM is away: the game's last DM connection dropped, or the DM has been idle for several rounds. It stores the time left in `combat.pausedMs`, clears `phaseEndsAt` (so `nextDeadline` returns null) and logs "Timer paused — waiting for the DM".
- `combat.timerResume` when the DM is back. It sets `phaseEndsAt = now + pausedMs` and logs "The DM is back — timer resumed".

Both fail harmlessly when there's nothing to pause or resume. Starting, advancing or ending combat, and `combat.setTimer`, all clear a pause. The self-hosted server keeps its own clock and doesn't send them.

**Also exported:** `projectForDm(state, presenceOf)`, `projectForPlayer(state, playerId, presenceOf)`, `feedForRole(row, role)`, `createGameState`, `upgradeState`, `GameError`, `DM_COLOR`, `newId`, `randomToken`, the role-strength helpers, content validation, `normalizeTemplate`, the dice functions, and the limit constants.

## Part 3: The client contract

The browser code in `client/` is shared. Two files are per-deployment:
- **`client/js/config.js`:** `API_BASE` (prefix for `/api/...`) and `SOCKET_URL`. Both are empty when self-hosted.
  - `/api/...` requests use `credentials: 'include'`, so a deployment can put the API on another origin and still send its cookie.
  - The player page fetches `/api/content/public?joinToken=<token>`, so a multi-account deployment knows whose content the game uses. Self-hosted ignores the query string.
  - The DM handout library mirrors scene templates: `GET/POST /api/handouts` and `GET/PUT/DELETE /api/handouts/:id`. The list items are `{ id, title, image, hasText, updatedAt, builtIn? }`. `PUT` and `DELETE` on a `builtin:` id return 400.
  - `GET /api/adventures` returns `[{ id, name, description, scenes, handouts }]` (scene and handout counts). `GET /api/adventures/:id/handouts` returns that adventure's handouts in full: `[{ id, title, text, image, dmNotes, scenes: [scene names] }]`, for the DM to read before creating a game. `POST /api/games` also accepts `{ adventureId }`.
  - The asset folders are `backgrounds`, `tokens`, `images` and `handouts`.
- **`client/js/transport.js`:** `connect(namespace, auth)` returns `{ on(event, fn), request(event, payload, { timeoutMs }) → Promise, setAuth(auth) }`.

| Namespace | `auth` | Client → server requests (reply) | Server → client events |
|---|---|---|---|
| `/dm` | `{ gameId }` + DM cookie | `cmd`, `chat`, `ping` → `{ ok, error?, result? }` | `state`, `history`, `feed`, `fx`, `ping`, `contentChanged`, `fatal`, `connect_error` (an `Error` whose message is `'unauthorized'` → go to login) |
| `/play` | `{ joinToken, playerId?, seatSecret? }` | `join` → `{ ok, playerId, seatSecret }`, and `cmd`, `chat`, `ping` | The same as `/dm`, plus `seatInvalid` |

**Page paths.** A shell must serve these pages, because the client links between them with absolute paths. Every page loads `/css/…`, `/js/…` and `/favicon.svg` from the root.

| Path | Page | Notes |
|---|---|---|
| `/` | landing | `client/landing.html` self-hosted; a deployment may serve its own |
| `/dm` | `index.html` | DM home (games, scenes, settings) |
| `/dm/login` | `login.html` | `?next=` is where to go after login (default `/dm`) |
| `/dm/games/:id` | `dm-game.html` | |
| `/dm/scenes/:id` | `scene-editor.html` | |
| `/dm/handouts/:id` | `handout-editor.html` | Ids may be `builtin:…` (opens read-only) |
| `/dm/assets`, `/dm/data` | `assets.html`, `data.html` | |
| `/g/:token` | `play.html` | Player page, with link-preview tags |

The pre-`/dm` paths (`/login`, `/games/:id`, `/scenes/:id`, `/assets`, `/data`) should redirect to their `/dm/…` equivalents, keeping the query string.

A shell must keep these event names and payloads. `server/sockets.js` is the reference implementation.

## Part 4: Notes for the cloud shell

- **State size:** a game state is one JSON document and can exceed DynamoDB's 400 KB item limit. Store state and undo snapshots in S3, with a small DynamoDB item holding the pointer and a `version`.
- **Concurrency:** load the game, `applyCommand`, then do a conditional write on `version`. On conflict, reload and run it again. `applyCommand` is pure, so a retry is safe.
- **Fan-out:** after a change, send each connection its own projection (`projectForDm` or `projectForPlayer`), plus `feedForRole` rows for its role. Players still on the join screen get `state` but no feed.
- **Timers:** use a one-shot EventBridge Scheduler entry per game at `nextDeadline().at`, or check deadlines lazily on the next request. Either works, since stale wake-ups are ignored.
- **Settings:** per account. Pass the account's `roleStrength` in `deps.settings`.

## Part 5: Changing the boundary

- A change to anything in Part 2 or Part 3 is a contract change. Tag a new version of this repo, and update the cloud shell before bumping its pinned version.
- Adding a new command needs no shell changes, unless it needs a new kind of lookup in `deps`.
