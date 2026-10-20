# Handoff: art the client points at but the repo doesn't have

**Type:** investigation and handoff. Nothing is fixed yet. Confirm the findings, decide, then make the change.

## Why this came up

While preparing the cloud deployment, every `/static/...` path the code refers to was checked against the files tracked in git. All the art used by `data/` definitions is there, but a few paths in the client point at files that aren't, so they 404. This affects the self-hosted server too; it isn't cloud-specific.

## Findings

### Broken references

| Path | Where it's used | What the user sees |
|---|---|---|
| `/static/images/chest.svg` | `<link rel="icon">` in all 7 pages: `client/index.html`, `login.html`, `play.html`, `dm-game.html`, `scene-editor.html`, `assets.html`, `data.html` | No tab icon (a 404 on every page load) |
| `/static/backgrounds/dungeon.svg` | `client/js/home.js:78`, the default background for **New scene** | A new scene starts with a missing background until one is picked |

### Harmless references, worth tidying

| Path | Where | Notes |
|---|---|---|
| `/static/tokens/fire-mage.svg`, `/static/images/ogre.svg`, `/static/tokens/walky-the-wize.svg` | `EXAMPLES` in `client/js/data.js` (the Data editor's example snippets) | Only example JSON; nothing loads them. But anyone who copies an example gets a "does not exist" warning. |
| `/static/images/ogre.svg`, `/static/images/dragon.svg`, `fire-mage.svg`, `walky-the-wize.svg` | `test/fixtures/data/...`, `test/monster-schema.test.js` | Fixture data. Tests don't check that images exist, so they pass. |
| `/static/images/crate.png` | `test/scenes.test.js` | Same: fixture only. |

### How it got this way

- These were **generated placeholder SVGs** (`scripts/gen-placeholders.js`, `npm run placeholders`). The generator writes a token for every definition, eight props into `static/images/` (`chest`, `barrel`, `rock`, `door`, `table`, `lever`, `pillar`, `bush`), and four backgrounds (`tavern`, `dungeon`, `forest`, `cave`).
- They were committed early on (`45da901`, `ffb9769`).
- Commit `16227ae` ("Initial commit of dne, now called one and done") deleted the placeholder SVGs when the real `.webp` art came in. That commit changed 313 files with 130 deletions. The client's references to `chest.svg` and `dungeon.svg` weren't updated.
- `static/images/` no longer exists at all, not even untracked in the local checkout.
- `README.md` still says "The included art is generated placeholder art (`npm run placeholders`)", which is no longer true.

## Questions to decide

1. **Favicon:** what should the tab icon be?
   - **a.** A real icon, for example a d20, a crossed-swords mark, or the chest redrawn. Commit it as `client/favicon.svg`, or keep it in `static/images/`.
   - **b.** Bring back only the generated `chest.svg` (`node scripts/gen-placeholders.js`, then commit just `static/images/chest.svg`).
2. **New-scene default background:**
   - **a.** No default: `background: null`. The editor already handles a scene with no background.
   - **b.** One of the real backgrounds, for example `/static/backgrounds/misc-training-ground.webp`.
   - **c.** Bring back the generated `dungeon.svg`.
3. **The placeholder generator:** keep it as an optional tool and fix the README wording, or delete it now that real art exists?
4. **Examples and fixtures:** point the `data.js` examples at real art, for example a `/static/tokens/monster_0NN.webp` that exists. Should fixtures stay as they are, since tests don't need real images?

## Suggested change (if no strong preference)

- **Favicon:** 1a. A small, hand-made `client/favicon.svg` served at `/favicon.svg`. Keeping it out of `static/` means it isn't "art" users can delete on the Assets page. Update all 7 `<link rel="icon">` tags.
- **New-scene background:** 2a, `null`. Then nothing depends on a particular image existing, and the cloud's per-account libraries can't break it.
- **Generator:** 3, keep it, but change the README line to: "Art in `static/` is real. `npm run placeholders` can generate simple SVG stand-ins for definitions that have no art."
- **Examples:** 4, use paths that exist. Leave the fixtures alone.

## Cloud impact

The cloud build (private repo) syncs this repo's `client/` and `static/` to S3, so it inherits whatever is fixed here.
- If the favicon moves to `client/favicon.svg`, the cloud needs no change: its CloudFront default behavior already serves any file in the site bucket.
- If the new-scene default stays an image, it must be a file under OSS `static/`, not account art.

No contract change (`docs/2026_10_16_001_CORE_SHELL_SPLIT.md` is unaffected).

## How to verify

```bash
# Every quoted /static/ path in client/ and data/ should be a tracked file:
for p in $(grep -rhoE "[\"']/static/[^\"']+[\"']" client data | tr -d "\"'" | sort -u); do
  git ls-files --error-unmatch "${p#/}" > /dev/null 2>&1 || echo "missing: $p"
done
```

Then run `npm test` and `npm run test:stateless`. Load `/` and check there's no 404 for the icon in the browser's network tab. Create a new scene from the home page and check it opens cleanly.

## Core/shell impact
- Core: none.
- Shell: none. These are client and static files only (and the README).
- Contract change: no.
