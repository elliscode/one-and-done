# One & Done: working rules

The game engine in `core/` is shared with a future serverless (AWS Lambda + DynamoDB/S3) deployment in a separate private repo. Every feature must keep working when each command runs in a fresh process. The contract is in `docs/2026_10_16_001_CORE_SHELL_SPLIT.md`; read it before changing anything at the boundary.

## Where code goes

- **Game rules go in `core/`.** New commands are `def(...)` entries in `core/commands.js`. Projections are in `core/project.js`, and the pipeline is in `core/engine.js`.
- **`core/` is pure and synchronous.** No I/O, no `Date.now`, no timers, no `process`, no `Math.random`, no module-level `let`. Time comes from `ctx.now` and dice from `ctx.rng`. `test/core.test.js` enforces this.
- **`server/` is only the self-hosted shell:** SQLite, Socket.IO, HTTP routes, files, timers, presence.

## Rules for new features

1. **Inputs come through `deps`.** A command that needs a new lookup or setting gets it via `deps` and `ctx`, never through an import of a server module or a global. New settings go in `deps.settings`; they'll be per-account in the cloud.
2. **"Later" is data.** Anything that happens after a delay is a deadline stored in game state and exposed through `nextDeadline`. Never a `setTimeout` the feature depends on.
3. **Nothing important lives only in memory.** If it matters after a restart, it's in game state or a store. Presence and ping limits are the only in-memory exceptions, and both are deliberate.
4. **Keep game state bounded.** Any list that grows in state needs a cap. History belongs in the Game Feed, not in state. State must survive a JSON round-trip, so no `Map`, `Set`, `undefined` values or class instances.
5. **The wire contract is documented.** A new socket event, request or REST route goes through `client/js/transport.js` and `config.js` (`API_BASE`), and is added to the tables in the contract doc.
6. **No "every loaded game" logic.** A serverless shell has no loaded games. Anything that fans out across games needs its own design, e.g. `noteToLoadedGames`.
7. **No local disk outside `server/content.js`, `server/assets.js` and `server/settings.js`.**

## Tests

- Run both `npm test` and `npm run test:stateless`. The stateless run drops the in-memory game cache, so every command reloads its game from SQLite, the way Lambda will.
- To change state directly in a test, use `s.edit((state) => { ... })` from `test/helpers.js`. Mutating `s.state()` only works with the cache and fails in stateless mode.

## Specs

Feature specs go in `docs/` as `YYYY_MM_DD_NNN_SHORT_NAME.md`. Specs for features that haven't been built yet go in `docs/proposals/`; move them up to `docs/` once implemented. Each one includes:

```
## Core/shell impact
- Core: …
- Shell: …
- Contract change: yes/no (if yes, update docs/2026_10_16_001_CORE_SHELL_SPLIT.md)
```

## Repo conventions

- ESM, Node ≥ 22.13, built-in `node:sqlite`, Express 5, Socket.IO. No build step for the client.
- Role strength is a setting (1–5). The repo's default and the live server's value differ, so never assume 4.
