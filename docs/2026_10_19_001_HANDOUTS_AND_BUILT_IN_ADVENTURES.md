# One & Done — Handouts and Built-in Adventures

Implemented as an incremental change. This replaces the proposal of the same name (`docs/proposals/2026_10_17_006_…`). The file formats for hand-written content are in [ADVENTURES.md](ADVENTURES.md).

## Background

- The DM had nowhere to keep notes, read-aloud text, letters, maps or clues, and no way to show them to players.
- Scene templates lived only in SQLite, so a fresh install had an empty library and nobody could jump straight into a game.

## Decisions

| Question | Decision |
|---|---|
| Who sees a revealed handout | **Everyone.** A handout is either hidden or shown to all players. There's no per-player reveal. |
| Images | An optional **cover image** per handout, plus any number of **inline images** in the Markdown. An image-only handout is fine. |
| How built-ins get into git | **Written by hand** as JSON files under `data/`. There's no export button. |
| First-run experience | Adventures are **listed** on the DM home page ("New game from adventure"). No game is created automatically. |
| Starter content | A small **Training Grounds** tutorial adventure. |
| Branching scene links | Not included. They're still a separate proposal. The adventure format ignores unknown fields, so `next` can be added later. |

## Part 1: Handouts

### 1. Library and game copies

| | Where | Like |
|---|---|---|
| Handout library | SQLite `handouts` table (`server/handouts.js`), plus built-ins from `data/handouts/` | Scene templates |
| Handouts in a game | `state.handouts` + `state.handoutOrder`, the game's own copies | Scene instances |

A game copy: `{ id, sourceId, title, text, image, dmNotes, revealed }`.

**Limits** (`core/handouts.js`):
- Title: 80 characters.
- Text: 8,000 characters.
- DM notes: 2,000 characters.
- At most 40 handouts per game (`MAX_HANDOUTS`). The DM's state carries every handout on every change, so this keeps the worst case at about 320 KB.

`image` must be a `/static/...` path. `normalizeHandout` validates every source: the editor, commands and built-in files.

### 2. Commands (all DM-only)

| Command | Effect |
|---|---|
| `handout.add { handoutId }` | Copies a library handout in, hidden. Needs `deps.handouts.get`. |
| `handout.create { title, text?, image?, dmNotes? }` | A one-off handout written mid-game ("Quick note"). |
| `handout.update { handoutId, …fields }` | Edits the game copy; the library is unchanged. |
| `handout.reveal` / `handout.hide { handoutId }` | Reveal writes a public feed row, `📜 The DM shared "Title"`. Hide writes a DM-only note. |
| `handout.remove { handoutId }` | Removes the game copy. |

Undo doesn't touch handouts, since `applyUndo` restores tokens, turns and checks only.

### 3. Projection

`projectForPlayer` adds `handouts: [{ id, title, text, image }]`: revealed ones only, in the DM's order, and never `dmNotes` or `sourceId`. `projectForDm` already sends the whole state.

### 4. UI

- **DM home → 📜 Handouts tab:** the library, with Edit (View for built-ins), Duplicate and Delete.
- **Handout editor (`/dm/handouts/:id`):**
  - title, Markdown text with a live "What players see" preview, and DM notes
  - a cover-image picker, and **Insert image**, which adds `![](/static/…)` at the cursor
  - both pickers show the `handouts`, `images` and `backgrounds` folders
  - built-ins open read-only, with **Duplicate to edit**
- **DM game → Handouts side tab:** each handout has Reveal/Hide, 👁 (read it as players see it), ✎ (edit the game copy) and ✕. Below the list are **Add from library** and **+ Quick note**.
- **Player:**
  - A **📜 Handouts** button appears in the top bar once something is shared, showing "(N new)" while there's anything unread.
  - Newly shared handouts pop a toast with **Read**.
  - The reader lists the shared handouts and renders each one. Clicking an image opens it in a new tab, so text-heavy images can be zoomed and scrolled with the browser's own controls.
  - Read/unread is a per-browser localStorage convenience, not game state.
- **Assets page:** a new **📜 Handouts** folder (`static/handouts`).

### 5. Markdown (`client/js/markdown.js`)

A small renderer we wrote, because the client has no build step. It's pure, so the tests import it.
- **Safety:** it escapes everything first, then applies Markdown, so raw HTML is never rendered.
- **Links:** http and https only, opening in a new tab.
- **Images:** `/static/` paths only.

### 6. Tying handouts to scenes (added 2026-10-20)

A game handout can be tied to some of the game's scenes (`sceneIds`, at most `MAX_HANDOUT_SCENES` = 30). It's a grouping aid: tying never reveals or hides anything.

- **Setting ties:**
  - `handout.setScenes { handoutId, sceneIds }` (DM) replaces the ties. Unknown ids are rejected, duplicates are removed, and an empty list unties the handout.
  - `handout.create` also accepts `sceneIds`. The DM's **+ Quick note** ties to the active scene by default.
  - `scene.remove` unties the removed scene.
- **Players:** `projectForPlayer` sends each revealed handout with `forScene: true/false` (tied to the active scene or not), never the scene ids themselves.
- **Viewers:**
  - The DM top bar has a **📜 Handouts** button. The DM's viewer and the player's 📜 reader list the active scene's handouts first, under "📍 *scene name*". The rest go under a collapsible **Other handouts** group, collapsed while the scene has handouts.
  - The DM's viewer also shows Reveal/Hide and the DM notes.
- **DM Handouts tab:** it's grouped the same way. Each row has a **📍** button (a checklist of the game's scenes) and a `📍 Training Yard, …` line.
- **Adventure files:** a handout entry can be `{ "id": …, "scenes": [scene keys] }`. Training Grounds ties the welcome handout to the yard, and the bounty to the yard and the courtyard.

## Part 2: Built-in content

### 1. Files

`server/content.js` reads `data/scenes/`, `data/handouts/` and `data/adventures/` (one item per file, id `builtin:<file stem>`).
- Scenes go through `normalizeTemplate`, handouts through `normalizeHandout`, and adventures through `validateAdventure`.
- **Errors:** bad JSON or a bad field is an error, like a bad definition.
- **Warnings:** an adventure with a missing scene or handout is hidden, and so is a scene creature with an unknown def.
- The folders are watched like the definition folders.

`TemplateStore` and `HandoutStore` merge in the built-ins (flagged `builtIn: true`) and refuse to edit or delete them. Built-in images count towards asset usage.

### 2. Adventures

An adventure lists its scenes (in order, with optional renames), its handouts, and a start scene.
- **`adventure.load { adventureId }`** (DM, `clearsUndo`):
  - only runs on a game with no scenes and no handouts
  - resolves every template and handout **before** changing anything, so a broken adventure fails whole
  - then adds the scenes and handouts and activates the start scene
  - shares `addSceneFromTemplate` with `scene.add`
- **`POST /api/games { adventureId }`:** creates the game and dispatches `adventure.load`. If that fails, the game is deleted again. The name defaults to the adventure's name.

### 3. Starter adventure: Training Grounds

- `data/scenes/training-yard.json`: two training dummies, spawn by the south stairs.
- `data/scenes/courtyard-ambush.json`: two bandit rogues and three giant rats, spawn at the south gate.
- `data/handouts/welcome-to-one-and-done.json`: how to play (the hero ring, phases, ⚙ settings).
- `data/handouts/notice-board-bounty.json`: the quest hook, with a cover image.
- `data/adventures/training-grounds.json`: starts in the training yard.

## Tests

- **`test/handouts.test.js`:** copy semantics, the reveal/hide projection, feed rows, DM-only access, validation and the cap, `upgradeState`, and a JSON round-trip.
- **`test/adventures.test.js`:** built-in loading and read-only stores, loading an adventure (order, renames, start scene, handouts), all-or-nothing failure and game clean-up, hidden adventures with missing pieces, and the shipped Training Grounds running end to end.
- **`test/markdown.test.js`:** escaping, allowed links and images, and the syntax.
- **`test/pages.test.js`:** `/dm/handouts/:id`.

## Core/shell impact
- Core: `core/handouts.js`, `state.handouts` and `state.handoutOrder` (with `upgradeState`), the handout commands, `adventure.load`, the player projection, and the `deps.handouts` and `deps.adventures` lookups.
- Shell: the `handouts` table and store, built-in folders in `server/content.js`, built-in-aware `TemplateStore`, `/api/handouts` and `/api/adventures`, `POST /api/games { adventureId }`, the `handouts` asset folder, and the `/dm/handouts/:id` page.
- Contract change: **yes**. There are new `deps` lookups and a new page, so `docs/2026_10_16_001_CORE_SHELL_SPLIT.md` is updated.
