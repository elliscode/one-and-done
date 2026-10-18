# One & Done — Pronoun Picker

**Status:** proposal, not implemented.

## Background

The Game Feed always refers to creatures by full name, and players and heroes have no pronouns. A line that mentions the same hero twice repeats the full name:

> Barnaby Beerbelly used Swift Takedown. Barnaby Beerbelly did 5 damage against Ghost.

With pronouns set, it could read:

> Barnaby Beerbelly used Swift Takedown. He did 5 damage against Ghost.

## Goal

- Players can optionally set pronouns for **themselves** and for **the hero they play**.
- The default for both is **no pronouns**: full names everywhere, exactly as today.
- When pronouns are set, they're shown next to the name, and feed text uses them in place of a repeated name.

## Part 1: Data

### 1. Pronoun sets (`core/pronouns.js`, new)

A fixed table, so grammar is always correct:

| Key | Subject | Object | Possessive | Reflexive | Plural verbs |
|---|---|---|---|---|---|
| `he` | he | him | his | himself | no |
| `she` | she | her | her | herself | no |
| `they` | they | them | their | themself | yes ("they are") |
| `it` | it | it | its | itself | no |

- No pronouns is stored as `null` (the default), never as a table entry.
- The label shown in the UI is "he/him", "she/her", "they/them" or "it/its".
- **Open question:** custom pronouns (neopronouns, or sets like "she/they"). Supporting them needs the player to fill in all five forms. It could be added later as a `custom` key with the forms stored on the player, capped in length.

### 2. Where they're stored

| Whose | Field | Notes |
|---|---|---|
| Player | `state.players[id].pronouns` | `null` or a key. Kept across hero changes, like name and color. |
| Hero | `state.entities[id].pronouns` (PCs only) | `null` or a key. Reset to `null` when the hero is released or left, like the hero name (`player.renameCharacter`). |

Both are tiny scalars, so state stays bounded. `upgradeState` doesn't need to change anything: a missing field means `null`.

### 3. Commands (`core/commands.js`)

| Command | Who | Effect |
|---|---|---|
| `player.setPronouns { pronouns }` | Player | Sets their own pronouns. `null` clears them. |
| `player.setHeroPronouns { pronouns }` | Player | Sets the pronouns of the hero they play. Fails if they don't have one. |
| `dm.setPronouns { playerId?, entityId?, pronouns }` | DM | Optional, for fixing things on a player's behalf, matching `dm.setPlayerColor`. |

Values must be `null` or a key in the table. No feed row, the same as a color change.

## Part 2: Where pronouns appear

### 1. Labels

Wherever a player or hero name is shown, an optional suffix is added when pronouns are set:
- the player roster and the "You" chip (`play.js`)
- the DM's Players tab
- the hero card and the token tooltip (DM and player)

The format is `Barnaby Beerbelly (he/him)`. Tokens on the board don't get the suffix, to keep them uncluttered.

### 2. Feed text

**Rule:** the first mention of a creature in a feed row is always its full name. Later mentions of the **same** creature in that row use its pronoun if it has one, and the full name if it doesn't.

That needs a small helper the text builders use, instead of `e.name` for later mentions:

```js
// core/pronouns.js
refer(e, form)     // → "he" / "him" / "his" / "himself", or e.name when there are no pronouns
be(e)              // → "is" / "are" (they/them takes plural verbs), so "they are snared"
```

**Existing lines are mostly single-clause** (`Barnaby uses Swift Takedown on Ghost: HIT 5`), so most rows mention a creature only once and wouldn't change. Places that do repeat a name, or that already hardcode a pronoun:
- self-targeting results, e.g. a self-heal listed after the ability name ("… heals himself +8")
- messages like "`X` is taunted by `Y` and must attack them" (`core/effects.js`). Today "them" is hardcoded for whoever `Y` is.
- "`X` left `hero`" and "`X`'s `hero` is now known as …" (`core/commands.js`)

Part of the build is to sweep every `ctx.log` and `fail(...)` text in `core/` and decide, line by line, where the helper applies. The visible change you described ("He did 5 damage…") also needs the ability line split into two sentences. That's a feed-style change, and it's worth deciding separately.

Feed rows are text stored when the command runs, so changing pronouns later doesn't rewrite history.

### 3. Monsters and NPCs

Out of scope: they keep full names. Definitions could gain an optional `pronouns` field later, using the same table.

## Part 3: The ⚙ "You" menu (`settingsMenu` in `client/js/play.js`)

Two new rows, under the existing Name and Hero sections:

- **Your pronouns:** a dropdown with *None (use name)*, he/him, she/her, they/them and it/its. Sends `player.setPronouns`.
- **Hero pronouns:** the same dropdown, shown only when the player has a hero. Sends `player.setHeroPronouns`.

*None* is selected by default for both.

## Tests and Acceptance Criteria

- Players default to `null` and so do heroes, and the default output matches today's text exactly. Existing feed tests stay unchanged.
- Set and clear for both commands. Unknown keys are rejected, and `player.setHeroPronouns` fails without a hero.
- Releasing or leaving a hero resets its pronouns, and the player's own pronouns survive.
- `refer` and `be` return the correct form for every key, and the name when there are none.
- At least one real feed line with a second mention: name only with no pronouns, the pronoun once set, and "they are" agreement for they/them.
- `npm run test:stateless` passes.

## Core/shell impact
- Core: new `core/pronouns.js`, three commands, pronoun fields on players and PC entities, the `refer`/`be` helpers in feed text, and the fields passed through the projections.
- Shell: none. The client changes are in `client/js/play.js`, `client/js/dm.js` and the token tooltip.
- Contract change: no. These are new commands and state fields only.
