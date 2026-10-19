# Client prediction for moves and actions

On a slow connection (the cloud deployment's round trip is a few hundred milliseconds), a dropped token snapped back to its old square until the server's new state arrived, and action buttons stayed enabled after use. Self-hosted, the round trip is too short to notice.

The client now shows what it already knows a command will do while the command is in flight. The server stays authoritative.

## What's predicted

| Command | Predicted | Not predicted |
|---|---|---|
| A player's move (drag or click-to-move) | The token on its new square; in combat, `turn.moved` | — |
| A player's attack, act, item use, ability (in combat) | `turn.actions` spent (the ability's `actionCost`), `abilitiesUsed`, and `turn.moves` cleared (acting locks in moves) | Hits, damage, healing, effects: anything that needs dice or hidden info |
| The DM's token drag | The token on its new square | Enemy movement budgets |

A move is only predicted when the client can tell it's legal: it's the player's own hero, it's their window, the move stays on the grid, and in combat it's within the movement left. It's charged like core's `move` (Chebyshev distance). Other moves wait for the server as before.

## How it works

`client/js/predict.js` (`createPredictor`) keeps the predictions for commands in flight. Pages keep the server's state as `serverState`, and render `state = predictor.view(serverState)`.
- **A rejected command** (an error reply or a timeout) drops its prediction at once, reverting the screen alongside the usual error toast.
- **A successful command** drops its prediction once a state push newer than the send has arrived. Both shells push a command's state before replying, so this usually happens at the reply. If no state comes, the prediction goes after 3 seconds.
- **Predictions are idempotent.** They set absolute values computed at send time (`moved = max(moved, movedAtSend + dist)`), so applying one on top of a state that already includes the change does nothing.

## Core/shell impact
- Core: none.
- Shell: none. This is client-only (`predict.js`, `play.js`, `dm.js`), with tests in `test/predict.test.js`.
- Contract change: no.
