# One & Done — Branching Scene Navigator

Implemented as an incremental change. This replaces the proposal of the same name (`docs/proposals/2026_10_17_004_…`).

## Background

The DM's **Scenes** tab listed a game's scenes in the order they were added. A campaign with many scenes became a long, flat list. It was easy to click the wrong one, e.g. the treasure room when you meant the outside of the jail, and the list said nothing about where the party could go next.

## Goal

A light visual aid for the DM, not a flowchart. Each scene can list the scenes that come **next**, and while a scene is active the list makes its next scenes stand out.

- No exclusivity. Any scene can still be activated at any time; links never block anything.
- No chart drawing. It's the same list, with emphasis and grouping.
- DM-only. Players never see links.

## Part 1: Data and commands

**Links live on the game's scene instances:** `state.scenes[id].next` is an optional array of scene ids in the same game.
- Links are directed: A → B doesn't imply B → A.
- At most `MAX_SCENE_LINKS = 8` per scene (`core/state.js`, exported from `core/index.js`).
- A missing field means no links, so `upgradeState` is unchanged.

**Commands and projection:**

| Where | Change |
|---|---|
| `scene.setNext { sceneId, next: [ids] }` (DM) | Replaces the scene's links. It removes duplicates and self-links (keeping the order), rejects unknown ids (`Unknown scene`) and more than 8 links, and an empty list deletes the field. No feed row and no undo, like `scene.rename`. |
| `scene.remove` | Also removes the scene from every other scene's `next`. |
| `projectForPlayer` | Sends the active scene without `next`. |

## Part 2: The DM's Scenes tab (`renderScenes` in `client/js/dm.js`)

- **When the active scene has links,** the list is grouped:
  1. **Current:** the active scene.
  2. **Next:** its linked scenes, in link order, outlined in gold, with **Go →**.
  3. **Other scenes:** everything else in `sceneOrder`, dimmed (back to full on hover) and fully clickable.
- **Otherwise** it's one list, as before.
- **Each row** has a **⇢** button. It opens a checklist of the game's other scenes, with linked ones first in their order; **Save** sends `scene.setNext`.
- **A row with links** shows `→ Courtyard Ambush, The Docks` under its name.
- **The active scene** also shows `← from Training Yard`: the scenes that link to it, computed in the client.
- **Scene names** now sit on their own line above the buttons, so long names aren't cut off.

## Part 3: Adventures

Each scene in an adventure file can have `"next": ["<scene key>", …]`. `validateAdventure` rejects unknown keys and self-links, removes duplicates, and enforces the cap. `adventure.load` maps the keys to the new scene ids, so the game starts with its links set. Training Grounds links the yard to the courtyard. The format is in [ADVENTURES.md](ADVENTURES.md).

Scene templates stay link-free, because one template can be added to a game more than once.

## Tests

`test/scene-links.test.js` covers:
- `scene.setNext`: order, duplicates, self-links, replacing, clearing, unknown ids, the cap, and DM-only access
- link cleanup on `scene.remove`
- links never blocking activation
- the player projection
- adventure links, including validation errors
- the shipped Training Grounds link
- a JSON round-trip

## Core/shell impact
- Core: `scene.setNext`, `MAX_SCENE_LINKS`, link cleanup in `scene.remove`, `next` stripped in `projectForPlayer`, and adventure `next` in `validateAdventure` and `adventure.load`.
- Shell: none. The client changes are in `client/js/dm.js` and the CSS.
- Contract change: no. It's a new command and an optional state field, with no new `deps`.
