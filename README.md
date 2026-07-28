# abuse.js

A web game built on the art, levels and sounds of **Abuse** (Crack dot Com, 1995), with our own
game mechanics. Rendering is PixiJS v8 (WebGL/WebGPU); everything else is ours.

Current state: a real Abuse level loads, renders with parallax and foreground overlays, and the
cop can be walked and jumped around it. Combat, AI and weapons are not implemented yet — but the
asset pipeline already converts every monster, weapon, tileset and sound effect, so that work is
pure gameplay code.

```bash
npm install
npm run assets   # convert assets/original/**.spe -> public/assets  (~2s)
npm run dev      # http://localhost:5173
```

Controls: **arrows/WASD** move, **space** jump, **shift** run, **mouse** aims the torso,
**V** toggles the CRT filter.
Append a level id to the URL to load it, e.g. `#levels/level14` — any id in `public/assets/levels.json`.

## Layout

```
assets/original/     Abuse data files, verbatim from apancik/Abuse_2025  (committed, 27MB)
tools/               Node-side converter (run via `npm run assets`)
  spec.ts            SPEC container + record readers - the only place byte offsets live
  lisp.ts            s-expression reader; mines animations out of the .lsp game scripts
  atlas.ts           shelf/grid bin packing + PNG output
  convert.ts         CLI entry point
public/assets/       Generated PNG atlases + JSON  (gitignored, rebuild with `npm run assets`)
src/
  assets/            manifest types + runtime loader
  core/              fixed-timestep loop, input, follow camera
  render/            pooled, culled tile layers + the CRT filter
  game/              level, collision, entities, player, world
```

## Asset pipeline

`npm run assets` produces, from 283 `.spe` files and 133 `.wav`s:

| Output | Contents |
| --- | --- |
| `tiles.json` + `tiles/*.png` | 1109 foreground and 405 background tiles in grid atlases |
| `chars.json` + `chars/*.png` | 2309 sprite frames and 271 character animation sets, one 2048² page |
| `images.json` + `images/*.png` | 442 loose images (HUD, fonts, title screens) |
| `levels.json` + `levels/*.json` | 125 levels: both tile grids plus the typed object list |
| `sfx/*.wav` + `sfx.json` | 133 sound effects (8-bit mono 11 kHz PCM, plays as-is) |
| `palette.json` | The 256-colour palette plus 25 tint tables |

## Format notes

These were derived from the original C++ sources and verified against the shipped data. Details
live next to the code that uses them; the highlights:

- **SPEC container** — `"SPEC1.0\0"`, `u16` entry count, then `{u8 type, u8 nameLen, name, u8 flags,
  u32 size, u32 offset}`. The modern port ignores the legacy link flag, so we do too.
- **Images** are `u16 w, u16 h` followed by `w*h` palette indices. Index 0 is transparent for
  foreground tiles and sprites, opaque for background tiles.
- **Tile ids are the entry names parsed as integers**, not positions — so tile numbering is global
  and load order does not matter. The file list comes from `(load_tiles ...)` in the Lisp scripts.
- **Foreground tiles are 30×15**, background 60×30. A tile is solid exactly when it carries a
  collision outline; we currently collide against that outline's bounding box, so slopes behave as
  blocks. The raw outlines ship in `tiles.json` for doing them properly later.
- **Level cells** are `u16`: `& 0x3fff` tile id, `& 0x4000` "draw after entities" (the overlay layer
  that puts pillars in front of the player), `& 0x8000` has-been-seen.
- **Objects are self-describing** — a level stores the type and state *names* that were in use when
  it was saved, so spawn points and monster placements survive without a hardcoded id table.
- **Sprites anchor from the feet**: blit at `x - xcfg`, `y - height + 1`, mirrored from the opposite
  edge when facing left.
- **Animations are not in the art files.** They are `def_char` forms in the `.lsp` scripts, using
  `seq`/`rep`/`app` over frame names. Some — including the player's aiming torso — are only produced
  by helper functions, so the reader expands those templates too.
- **The player is two sprites**: legs from `art/cop.spe` and a torso from `art/coptop.spe` with 24
  aim frames, pinned at `bottom.y + 29 - bottomHeight` and nudged 4px when facing left.

## CRT filter

`src/render/CrtFilter.ts` is a port of streetalien's `src/fx/crt.ts`. That one is a Canvas 2D
present pass — sliced barrel warp, additive ghost blits, a quarter-res bloom buffer, a pre-rendered
scanline canvas, gradient overlays — none of which survives a move to WebGL, so this is the same
chain of effects in one fragment shader, in the same order and with the same constants:

> barrel curvature → convergence ghosting → bloom → scanlines + aperture grille → rolling band →
> vignette → flicker → rounded tube mask

Costs ~0.07 ms/frame at 1920×1080. Toggle with **V**.

Two deliberate differences from the original:

- Its "crush to half res" step is dropped — this game already renders at an integer zoom with
  nearest-neighbour sampling, so the pixels are chunky before the CRT sees them.
- Its constants are authored against a 960×540 buffer; `crtPixelScale()` converts one of those units
  into device pixels so the scanline pitch and tube radius stay the same apparent size at any window
  size.

The additive passes (0.24 ghosting + 0.32 bloom) lift the blacks noticeably on Abuse's dark art.
That is what the original does, so rather than change its constants there are **brightness and
contrast sliders in the top right** that trim the result. Both default to `1.2`. They are applied
last and outside the intensity mix, so they also correct the raw image with the CRT toggled off,
and they persist in `localStorage`. `new CrtFilter({ intensity })` dials the whole pass back
instead.

## Not done yet

- **Lighting.** Abuse dims the scene with a per-level light list and an ambient level; we render
  unlit, which is why everything is brighter than the original. The light entries are decoded but
  unused.
- **Slopes** collide as their bounding box (see above).
- **Tints** — palette remaps for enemy colour variants — are exported but not applied.
- **Music** (`.hmi`) is copied but not converted.
- Tile animation (`next`) and per-frame root motion (`advance`) are exported but not driven.

## Licensing

Abuse's code and data were released into the public domain by Crack dot Com; the sound effects and
music are Bobby Prince's and are redistributable. See `assets/original/COPYING` and `AUTHORS`.
