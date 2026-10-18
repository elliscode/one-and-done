# Cloud prerequisites: cross-origin API, per-game public content, timer pause

The cloud shell (private repo) needs three small changes here before it can run the shared client and core.

## 1. Cross-origin API requests

The cloud serves the API from `api.<domain>` while pages come from `<domain>`. `api()` in `client/js/common.js` and the Data editor's `fetch` in `client/js/data.js` now send `credentials: 'include'` so the login cookie goes along. Same-origin requests behave exactly as before.

## 2. Public content per game

In the cloud, content depends on the account that owns the game, and players have no cookie. The player page now fetches `/api/content/public?joinToken=<token>`. The self-hosted server ignores the query string.

## 3. Pausing the phase timer when the DM drops

The cloud has no server-side timers: the DM's browser tells the server when a phase runs out. While no DM is connected, nothing would advance the phase, so the cloud stops the timer instead. It also stops it when the DM's tab is open but nobody has touched it for 4 full rounds, so forgotten tabs don't cycle phases forever. Players see "Timer paused — waiting for the DM".

- **New system commands:**
  - `combat.timerPause` keeps the time left in `combat.pausedMs` and clears `phaseEndsAt`.
  - `combat.timerResume` sets `phaseEndsAt = now + pausedMs`. 10 seconds left when the DM drops means 10 seconds left when they're back.
- Starting, advancing or ending combat, and `combat.setTimer`, clear a pause.
- `upgradeState` adds `pausedMs: null` to older games.
- The combat bar shows `⏸ Timer paused — waiting for the DM` while `pausedMs` is set.

The self-hosted server keeps its own clock and never sends these commands.

## Core/shell impact
- Core: two new `system` commands, the `combat.pausedMs` field, and an `upgradeState` step.
- Shell: none for self-hosted. The cloud shell dispatches the new commands when the last DM connection closes and when a DM's connection opens.
- Contract change: yes. `docs/2026_10_16_001_CORE_SHELL_SPLIT.md` is updated (Part 2 for the timer pause, Part 3 for the client requests).
