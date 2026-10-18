# One & Done — Handouts and Built-in Adventures

**Status:** proposal, not implemented. It has two parts: handouts can ship on their own, and built-in adventures build on them.

## Background

- The DM's game page has three tabs: **Scenes**, **Players** and **Banks** (`client/dm-game.html`). There's nowhere to keep notes, read-aloud text, letters, maps or clues, and no way to show them to players.
- Scene templates live only in SQLite (`scene_templates`, `server/templates.js`). Heroes, monsters, NPCs, acts and items ship in git under `data/`, but scenes don't. A fresh install has an empty scene library, so nobody can jump straight into a game.

## Part 1: Handouts

### 1. What a handout is

A handout is a titled note with either **Markdown text**, **an image**, or both (an image with a caption). The DM prepares handouts and **reveals** them to players when the story reaches them.

### 2. The library and the game

This follows the same split as scenes:

| | Where | Like |
|---|---|---|
| **Handout library** | Shell storage, created and edited outside a game | Scene templates |
| **Handouts in a game** | `state.handouts`, a live copy | Scene instances in `state.scenes` |

A handout in game state:

```js
state.handouts.h_ab12 = {
  id, sourceId,          // library id it was copied from (or null)
  title,                 // ≤ 80 chars
  text,                  // Markdown, ≤ 20,000 chars (or null)
  image,                 // '/static/...' path (or null), like scene backgrounds
  revealedTo: 'none',    // 'none' | 'all' | [playerId, ...]
  dmNotes,               // ≤ 2,000 chars, never sent to players (or null)
};
state.handoutOrder = ['h_ab12', ...];
```

- **Caps:** at most 50 handouts per game, plus the text limits above, so state stays bounded. Images are referenced by path and never stored inline.
- **Images:** a new `handouts` asset folder (`ASSET_FOLDERS` in `server/assets.js`), uploaded on the Assets page like backgrounds and tokens.

### 3. Commands (`core/commands.js`)

| Command | Who | Effect |
|---|---|---|
| `handout.add { handoutId }` | DM | Copies a library handout into the game. It needs a new `deps.handouts.get(id)` lookup, prefetched by the cloud shell the way templates are. |
| `handout.create { title, text?, image? }` | DM | A one-off handout written mid-game. |
| `handout.update { id, ... }` | DM | Edits the game copy. The library is unchanged. |
| `handout.reveal { id, to: 'all' \| [playerIds] }` / `handout.hide { id }` | DM | Sharing. A reveal writes a feed row: "The DM shared *Letter from the Constable*". |
| `handout.remove { id }` | DM | Removes it from the game. |

**Projection:** `projectForPlayer` includes only the handouts revealed to that player, without `dmNotes` or `sourceId`. `projectForDm` includes all of them.

### 4. UI

- **DM:** a fourth tab, **Handouts**, next to Scenes, Players and Banks. It lists the game's handouts with a 👁 badge showing who can see each one, plus **Reveal to all**, **Reveal to…**, **Hide** and **Edit** buttons, and an **Add from library** picker like the scene picker.
- **Players:** a 📜 **Handouts** button that opens a reader. A newly revealed handout opens automatically once, or shows a toast with a "Read" button.
- **Library editor:** a Handouts page reached from the DM home page, like the scene editor. It has a title, a Markdown text area with live preview, an image picker from the `handouts` asset folder, and DM notes.

### 5. Markdown rendering

The client has no build step, so rendering has to be a small renderer we write (e.g. `client/js/markdown.js`) or a single vendored file with a pinned version.
- **Supported:** headings, bold, italics, lists, blockquotes, horizontal rules, line breaks, links (`http(s)` only, opening in a new tab), and images (`/static/...` paths only).
- **Safety:** raw HTML is never rendered. Text is escaped first and Markdown is applied to the escaped text, so a handout can't inject script into players' browsers.

## Part 2: Built-in content in git

### 1. Shipped scenes and handouts

New read-only content folders under `data/`, loaded by `server/content.js` (working rule 7: only that module reads `data/`):

```
data/scenes/<id>.json     # same shape as a scene template's data, plus name
data/handouts/<id>.json   # { title, text?, image?, dmNotes? } (or .md with front matter)
```

- Built-ins are listed in the library next to the user's own items and marked **Built-in**. They can't be edited or deleted in place; **Duplicate** makes an editable copy in SQLite.
- Built-in ids are namespaced (`builtin:outside-prison`), so they never collide with SQLite ids. `deps.templates.get` and `deps.handouts.get` look in both places.
- Their images must be in OSS `static/`, not account art, so the cloud can't lose them.

### 2. Adventures

An adventure is a ready-to-run game:

```js
// data/adventures/<id>.json
{
  "name": "The Blind Eye",
  "description": "A one-shot for 3–5 heroes, about 2 hours.",
  "scenes": [
    { "key": "tavern", "template": "builtin:taob-the-blind-eye-tavern", "next": ["docks", "hideout"] },
    { "key": "docks", "template": "builtin:the-docks" }
  ],
  "handouts": ["builtin:letter-from-the-constable"],
  "startScene": "tavern"
}
```

- **New game from adventure** on the DM home page creates a game with every scene and handout already added. If the [branching scene navigator](2026_10_17_004_BRANCHING_SCENE_NAVIGATOR.md) exists by then, the `next` links come from the adventure. The game is ready to share with a join link straight away.
- **Open question:** how the game gets built. One option is a single core command, `game.loadAdventure`, that takes the resolved adventure through `deps` and does it all in one atomic step. The other is a shell loop over `scene.add` and `handout.add`. The single command is safer (all or nothing), and a cloud shell only needs to prefetch the templates and handouts the adventure names.
- **Open question:** "show up automatically so players can jump right in". Is listing the adventures on the home page enough, or should a fresh install also create a demo game on first run? First-run creation is shell work and must be idempotent (create it only once, not on every start).

### 3. Data model implications

- Scene templates and handouts get a second source (files), which changes listing, lookups and the "is this image in use?" counts (`templates.imageRefs()`).
- The Data page could show the new folders read-only, or editable like the other `data/` categories. It's simplest to start read-only.
- For the cloud: built-ins ship with the OSS package (same for every account), and user-made templates and handouts are per-account. Lookups need a "built-in, then account" order.

## Tests and Acceptance Criteria

- Handouts: create, add, update, reveal (to all and to some), hide and remove. Caps and length limits are enforced.
- Projection: players see only what's revealed to them, never `dmNotes`.
- Markdown: raw HTML and `javascript:` links are escaped. Only allowed image paths render.
- Built-ins: they load from `data/`, can't be edited or deleted through the API, and duplicating one makes an editable copy.
- Adventures: creating a game from one adds every scene and handout, sets the links, and activates the start scene. A broken reference fails cleanly without a half-built game.
- `npm run test:stateless` passes.

## Core/shell impact
- Core: `state.handouts`, `state.handoutOrder`, the handout commands, the projection rules, a `deps.handouts` lookup, and possibly `game.loadAdventure`.
- Shell: handout library storage (SQLite table) and REST routes, built-in scenes, handouts and adventures read by `server/content.js`, a `handouts` asset folder, and "New game from adventure".
- Contract change: **yes**. There's a new `deps.handouts` lookup and new REST routes for the handout library and adventures, so update `docs/2026_10_16_001_CORE_SHELL_SPLIT.md` (Part 2 `deps`, and the route tables) when it's built.
