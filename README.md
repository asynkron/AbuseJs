# abuse.js

A web game built on the art, levels and sounds of **Abuse** (Crack dot Com, 1995), with our own
game mechanics. Rendering is PixiJS v8 (WebGL/WebGPU); everything else is ours.

Current state: real Abuse levels load with their lighting, tile layers, objects, ambience and
tutorial text; the cop runs, jumps, climbs ramps and walks between levels through the original exit
portals. Combat, AI and weapons are deliberately not implemented — those are the mechanics this
project is writing itself. Everything the original shipped is converted and waiting for them.

```bash
npm install
npm run assets   # convert assets/original/**.spe -> public/assets  (~2s)
npm run dev      # http://localhost:5173
```

Controls: **arrows/WASD** move, **space** jump, **shift** run, **mouse** aims the torso,
**E** use an exit portal, **V** toggles the CRT filter, **L** toggles level lighting.
Sound starts muted — there is a volume slider top right.
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
| `tiles.json` + `tiles/*.png` | 1109 foreground (189 with ramp outlines) and 405 background tiles |
| `chars.json` + `chars/*.png` | 3849 sprite frames — 2309 plus 1540 baked colour variants — and 271 characters, one 2048² page |
| `images.json` + `images/*.png` | 442 loose images (HUD, fonts, title screens) |
| `levels.json` + `levels/*.json` | 125 levels: both tile grids, the typed object list, 5617 light sources |
| `sounds.json` + `sfx/*.wav` | 133 samples, 53 named, the 17-entry ambient table |
| `messages.json` | The 12 tutorial lines TRAIN_MSG markers show |
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
- **A tile is solid exactly when it carries a collision outline**, and that outline is a polygon,
  not a box — 189 tiles are ramps. The converter rasterises each into one solid span per pixel
  column.
- **Objects that carry art are not always visible.** Markers, logic gates and ambient sound
  emitters draw only in the editor, which the converter detects from their draw function.
- **Levels reuse physics fields as configuration.** AMBIENT_SOUND keeps its repeat delay in `xvel`,
  volume in `yvel`, spread in `xacel`; NEXT_LEVEL keeps its destination level number in `aistate`.
- **Tints are just palettes.** A colour variant is the same sprite indices decoded against a
  different 256-colour table, so variants are baked at conversion time and are exact.
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

## Lighting

Abuse is dark with pools of light, not evenly lit, and that comes from a static light list stored
in every level: an ambient floor (`minLight`, 35/63 in most levels) plus 58–151 light sources.

`src/render/LightLayer.ts` accumulates every visible light additively into an offscreen buffer that
starts at the ambient floor, then multiplies that buffer over the finished scene. The falloff is
ported from `calc_light_value` in the original `src/light.cpp`:

```
dx = |lx - px| << xshift          dy = |ly - py| << yshift
r  = dx + dy - min(dx, dy) / 2                    # octagonal, not circular
contribution = (outer - r) / (outer - inner) * 64
```

summed on top of `minLight` and clamped to 63. Two details worth keeping:

- **The distance metric is an octagon**, not a circle. That faceted edge is part of the look, so it
  is baked into the gradient texture rather than smoothed into a radial gradient.
- **`type` selects which quadrants the light covers** (full ellipse, halves, quadrants), which is
  how wall-mounted lamps throw directionally. `xshift`/`yshift` squash the reach by powers of two,
  so lights are ellipses.

Costs ~0.2 ms/frame. Toggle with **L** to see the difference.

One approximation: `inner_radius` is treated as 0, so a single normalised falloff texture serves
every light. It is 1 for 5152 of the 5617 lights (a ~1% error) and 10 for 49 of them. Type 9 — a
solid rectangle that overrides everything beneath it — occurs 3 times in 125 levels and is skipped.

## Music

`tools/hmi.ts` converts the 14 HMI tracks to standard MIDI, ported from
`src/sdlport/hmi.cpp`. HMI differs from MIDI in three ways that matter: offsets instead of chunk
headers, note-on events carrying a duration rather than a matching note-off (so note-offs are
queued and emitted at the right delta), and an undocumented `0xFE` event that gets skipped. Tempo
and division are fixed exactly as the engine writes them. All 14 convert: 21601 notes, zero parse
errors on read-back.

`tools/sf2.ts` then lifts the patches those tracks actually play out of the shipped
**Roland SC-55 soundfont** — resolving preset → preset zone → instrument → instrument zone → sample
and keeping only the generators that matter for straightforward playback. All 41 patches the music
uses resolve, giving 137 samples and 1.2MB of PCM instead of the full 3.1MB font.

`src/audio/MusicPlayer.ts` schedules the MIDI through WebAudio with the usual lookahead and plays
each note from its SC-55 sample, pitched by root key and tuning, honouring loop points and
release. If the soundfont fails to load it falls back to an oscillator synth so the music still
plays with substitute timbres.

Levels map to tracks by name (`levelNN` → `abuseNN`) and fall back to a stable hash. Everything
here obeys the mute gate — a muted page loads no music at all.

## Not done yet

- **Mechanics.** No combat, AI, weapons, damage or pickups — by design. Level objects are spawned
  and animated but inert; they are scenery for mechanics that do not exist yet.
- **Status bar contents.** The panel and health are real; weapon slots and ammo counts stay empty
  until there are weapons to hold.

- **18 addon levels reference tiles that were never shipped** — mostly `addon/claudio/*` and
  `addon/pong/*`, plus a dozen stray cells in `levels/frabs18` and `levels/frabs30`. `abuse.lsp`
  says as much: claudio's palettes "can only be used with the art files by other authors". Unknown
  tiles are skipped rather than drawn, so those levels load with holes. All 22 core
  `levels/levelNN` are clean.

### Things that turned out not to exist

- **Tile animation.** The `next` field is 0 on all 1109 foreground and 405 background tiles, and
  the engine never reads it. Animated lava, teleporters and screens are objects, not tiles.

## Licensing

Abuse's code and data were released into the public domain by Crack dot Com; the sound effects and
music are Bobby Prince's and are redistributable. See `assets/original/COPYING` and `AUTHORS`.
