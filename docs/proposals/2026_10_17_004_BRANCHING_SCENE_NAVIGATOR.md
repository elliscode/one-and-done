# One & Done — Branching Scene Navigator

**Status:** proposal, not implemented.

## Background

The DM's **Scenes** tab (`renderScenes` in `client/js/dm.js`) lists a game's scenes in the order they were added (`state.sceneOrder`). Each has a **Go** button. A campaign with many scenes becomes a long, flat list. It's easy to click the wrong one, e.g. the treasure room when you meant the outside of the jail, and the list says nothing about where the party can go next.

## Goal

A light visual aid for the DM, not a flowchart. Each scene can list the scenes that come **next**. When a scene is active, the list makes its next scenes stand out, so the likely choices are easy to see and to click.

- No exclusivity. Any scene can still be activated at any time, and links never block anything.
- No chart drawing. It's the same list, with emphasis and grouping.
- DM-only. Players never see links.

## Part 1: Data

### 1. Links live on the game's scenes

Each scene instance in `state.scenes` gets an optional `next` array of scene ids in the same game:

```js
state.scenes.s_ab12 = { id, templateId, name, background, grid, spawn, next: ['s_cd34', 's_ef56'] };
```

- Links are directed. "A → B" doesn't imply "B → A", so a loop back needs its own link.
- **Cap:** at most 8 links per scene (a `MAX_SCENE_LINKS` constant in core). It keeps state bounded and the list readable.
- Ids are unique within the array, and a scene can't link to itself.
- `upgradeState` doesn't need to add `[]`: a missing `next` means "no links".

### 2. Commands (`core/commands.js`)

| Command | Who | Effect |
|---|---|---|
| `scene.setNext { sceneId, next: [ids] }` | DM | Replaces the scene's links. It checks that each id exists, removes duplicates and self-links, and enforces the cap. |

One "set the whole list" command is simpler than separate link and unlink commands, and it's idempotent.

- `scene.remove` also strips the removed id from every other scene's `next`.
- No feed row. This is DM bookkeeping, like `scene.rename`.
- No undo, matching the other scene commands.

### 3. Projection

`projectForPlayer` currently sends `structuredClone(scene)` for the active scene (`core/project.js`). It must drop `next`, so players can't see where the party might go. `projectForDm` sends it as is.

## Part 2: The DM's Scenes tab

When a scene is active, the list is grouped:

1. **Current:** the active scene (already highlighted).
2. **Next:** the active scene's `next` scenes, each with a gold outline and a **Go →** button, in the order they were linked.
3. **Other scenes:** everything else, in `sceneOrder`, slightly dimmed but fully clickable.

With no active scene, or when the active scene has no links, the list is unchanged.

**Editing links:** each scene row gets a small **Next…** button. It opens a checklist of the game's other scenes and sends `scene.setNext` when the DM saves. Rows also show a compact `→ Outside the Prison, The Docks` line, so the DM can see a scene's links without opening it.

**Optional extra:** a "Came from" hint on scenes that link *to* the active scene, which helps when backtracking. It's computed in the client from the other scenes' `next`, so it needs no state.

## Part 3: Templates and built-in adventures (later)

Links point at scene *instances*, so they exist only inside a game. If [Handouts and built-in adventures](2026_10_17_006_HANDOUTS_AND_BUILT_IN_ADVENTURES.md) lands, an adventure file can declare links between its scenes, and the game it creates starts with `next` already set. Scene templates themselves stay link-free, because one template can be added to a game more than once.

## Tests and Acceptance Criteria

- `scene.setNext` stores links, rejects unknown ids, removes duplicates and self-links, and enforces `MAX_SCENE_LINKS`. Only the DM can send it.
- `scene.remove` removes the scene from every other scene's `next`.
- `projectForPlayer` never includes `next`.
- State survives a JSON round-trip, and every test passes under `npm run test:stateless`.
- Manual check: link A → B and A → C. Activate A: B and C appear under **Next**, and everything else is dimmed but clickable. Activate an unlinked scene: the list looks the way it does today.

## Core/shell impact
- Core: new `scene.setNext` command, `MAX_SCENE_LINKS`, link cleanup in `scene.remove`, and `next` stripped in `projectForPlayer`.
- Shell: none. The client changes are in `client/js/dm.js` and the CSS.
- Contract change: no. A new command needs no shell change.
