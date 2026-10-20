# Built-in scenes, handouts and adventures

One & Done ships read-only library content in git, so a fresh install has something to play. Each item is one JSON file, written by hand:

| Folder | One file is | Shows up in |
|---|---|---|
| `data/scenes/` | a scene template | DM home → Scenes, and every game's "Add from library" |
| `data/handouts/` | a handout | DM home → Handouts, and every game's Handouts tab |
| `data/adventures/` | a ready-to-run game | DM home → Games → "New game from adventure" |

**Ids.** An item's id is `builtin:` plus its file name without `.json`. For example, `data/scenes/training-yard.json` is `builtin:training-yard`. File names use lowercase letters, digits, `-` and `_`.

**Read-only.** Built-ins can't be edited or deleted in the app. **Duplicate** makes an editable copy in your own library. To change a built-in, edit its file and commit it. The running server picks up the change within a few seconds.

**Art.** Images must be files in `static/` that are committed to git (`/static/backgrounds/…`, `/static/handouts/…`), not uploads that exist only on one server.

## Scene: `data/scenes/<id>.json`

The same shape the scene editor saves:

```json
{
  "name": "Training Yard",
  "background": "/static/backgrounds/misc-training-ground.webp",
  "bgScale": 1,
  "grid": { "cols": 24, "rows": 16, "cellSize": 64, "offsetX": 0, "offsetY": 0, "color": "#ffffff", "opacity": 0.25 },
  "spawn": { "x": 12, "y": 12 },
  "entities": [
    { "kind": "monster", "defId": "training-dummy", "x": 10, "y": 8, "name": "Straw Dummy" }
  ]
}
```

- `grid.cols` and `grid.rows` (1–100) and `cellSize` (16–256 px) should match the background, scaled by `bgScale`.
- `spawn` is where heroes appear. Without it, they appear in the bottom-left corner.
- `entities` are monsters (`"kind": "monster"`) or NPCs (`"kind": "npc"`), with `defId` set to a definition id from `data/monsters/` or `data/npcs/`. `name` is optional. Squares are 0-based from the top-left. An unknown `defId` is a warning, and that creature is skipped.
- Two optional flags set a creature's starting state:
  - `"hostile": true` makes an NPC start hostile, e.g. guards hunting the party. Monsters are already hostile.
  - `"dead": true` makes a creature start dead, e.g. a body to investigate.

  The scene editor keeps these flags but can't set them, so add them by hand.
- Tip: the easiest way to get the grid and positions right is to build the scene in the scene editor, then copy its values into the file.

## Handout: `data/handouts/<id>.json`

```json
{
  "title": "Notice Board: Bounty",
  "image": "/static/handouts/bounty-poster.webp",
  "text": "## REWARD: 50 GOLD\n\nBandits have been seen in the **old courtyard**…",
  "dmNotes": "Reveal when the party is done training."
}
```

| Field | Limit | Notes |
|---|---|---|
| `title` | 80 characters | Defaults to "Untitled handout" |
| `image` | a `/static/...` path | Optional cover image, shown above the text. Players can click it (or any inline image) to open it in a new tab. |
| `text` | 8,000 characters | Optional Markdown (see below). In JSON, line breaks are `\n`. |
| `dmNotes` | 2,000 characters | Optional. Never sent to players. |

A handout needs `text`, `image`, or both.

**Markdown** supports `#` to `####` headings, `**bold**`, `*italic*`, `` `code` ``, `-` and `1.` lists, `>` quotes, `---` rules, `[links](https://…)` (http and https only) and `![images](/static/…)` (only `/static/` paths). Raw HTML is shown as plain text, never rendered.

## Adventure: `data/adventures/<id>.json`

```json
{
  "name": "Training Grounds",
  "description": "A short tutorial one-shot…",
  "scenes": [
    { "key": "yard", "template": "builtin:training-yard", "next": ["courtyard"] },
    { "key": "courtyard", "template": "builtin:courtyard-ambush", "name": "The Old Courtyard" }
  ],
  "handouts": [
    { "id": "builtin:welcome-to-one-and-done", "scenes": ["yard"] },
    "builtin:notice-board-bounty"
  ],
  "startScene": "yard"
}
```

- `name` (60 characters) is also the new game's default name. `description` (500 characters) is shown on the DM home page.
- `scenes` (1–30) are added in this order. `template` must be a built-in scene id. `key` is a short label used by `startScene` (default `scene-1`, `scene-2`, …). `name` optionally renames the scene in this game.
- `next` (optional, up to 8) lists the keys of the scenes that can follow this one. In the game, the DM's Scenes tab highlights them while this scene is active (see the branching scene navigator). Links are one-way, so add a link back if the party can return. A link to an unknown key, or to the scene itself, is an error.
- `handouts` (up to 40) are built-in handout ids. They start hidden, and the DM reveals them during play. To tie a handout to scenes, write `{ "id": "builtin:…", "scenes": ["<scene key>", …] }` instead of the plain id. While one of those scenes is active, the DM's and players' handout viewers list it first, under the scene's name. Tying doesn't reveal anything by itself. Add `"revealed": true` to a handout entry to make it visible to players as soon as the game starts, e.g. `{ "id": "builtin:…", "scenes": ["yard"], "revealed": true }`.
- `startScene` is the key of the scene that's active when the game starts (default: the first scene).
- An adventure that points at a scene or handout that doesn't exist is hidden from the list, with a warning in the server log.

## Checking your work

1. Start the server (`npm run dev`). Invalid JSON or a bad field is an error that names the file: at startup the server refuses to start, and while it's running the change is rejected and the last good content stays loaded. Missing references are logged as warnings.
2. On the DM home page, check that the adventure is listed, then create a game from it. Open each scene to check the art, grid and creature positions, and reveal each handout to see what players will see.
3. `npm test` loads the shipped content too (`test/adventures.test.js`), so a broken built-in fails the build.
