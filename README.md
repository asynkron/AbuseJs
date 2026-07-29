# abuse.js

A web game built on the art, levels and sounds of **Abuse** (Crack dot Com, 1995), with our own
game mechanics. Rendering is PixiJS v8 (WebGL/WebGPU); everything else is ours.

Current state: real Abuse levels load with their lighting, tile layers, objects, ambience, music and
tutorial text; the cop runs, jumps, climbs ramps, rides platforms, takes teleporters and walks
between levels through the original exit portals. It shoots, and the level shoots back — turrets
wake and track, ceiling ants drop on you, and both can kill you. The levels' own sensor-and-gate
wiring drives the doors and lifts.

```bash
npm install
npm run assets   # convert assets/original/**.spe -> public/assets  (~2s)
npm run dev      # http://localhost:5173
```

Controls: **arrows/WASD** move, **space** jump, **shift** run, **mouse** aims the torso,
**X** or **left mouse** fire, **down/S** or **E** to use a platform, teleporter or exit portal,
**V** toggles the CRT filter, **L** toggles level lighting. Everything is reachable from a trackpad —
no right button anywhere.
Sound starts muted — there is a volume slider top right.
Append a level id to the URL to load it, e.g. `#levels/level14` — any id in `public/assets/levels.json`.
It starts on `levels/level01`, not level00: **level00 is Abuse's training level and contains no
monsters at all**, so starting there makes a game with working enemies look completely inert.
`#levels/level00` still loads the tutorial.

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

## Mechanics

These are ours, not the original's — the original's live in a Lisp interpreter we do not have. What
we take from the shipped data is the *wiring*: which switch drives which door, where a platform's
travel ends, which frame a turret uses when aiming 30° up-left.

**Shooting.** Hitscan, one tracer per shot, `FIRE_DELAY 3` between rounds and a dry click at 7 when
the pool is empty. The muzzle is not the player's centre: it comes from the 24-entry
`small_fire_off` table in the original `src/cop.cpp`, so the tracer leaves the actual gun barrel
through a full rotation. A round does 5 damage — `do_damage 5` from `weapons.lsp` — and pickups
name their own amount (`MBULLET_ICON20` is twenty rounds).

**Turrets** (`SPRAY_GUN`, `TRACK_GUN`) sit dormant until you come within 260px, then play their
open animation, track you through their 24 aim frames, and after a 25-tick wind-up fire every 40
ticks for 6 damage. They close again with a 60px hysteresis margin so they do not flutter at the
edge of range.

**Ceiling ants** (`ANT_ROOF`) do what their state list says they should: `top_walk` along the
ceiling towards you, `fire_wait`/`ceil_fire` to shoot straight down, and `fall_start`/`falling`/
`landing` to come down and fight on the floor. They drop when the floor below is within 400px and
stay up and shoot when it is not, and being shot wakes one wherever it is. Contact costs 8 with a
45-tick cooldown.

**Floaters** (`WHO`) are the hovering robot in `art/rob2.spe` and the only creature the training
level contains. They bob on a patrol line, drift towards you when you come within 300px, play the
full nine-frame `turn_around` when they reverse, and `flinch_up` when hit.

**Deaths pop.** `EG_EXPLO`'s four-frame blast goes off over the middle of anything that dies, with
`P_EXPLODE_SND` behind it. Most characters have no `dieing` or `dead` state - `WHO` has neither -
so without this they simply blinked out of existence.

**Platforms and teleporters** read their endpoints out of the level: a platform's travel is the
`xacel`/`yacel` pair, its surface is the top of its own sprite, and `start_accel` is how far away
you can grab it. Riding one carries you continuously rather than in steps, and stepping off it
keeps the coyote timer alive so a jump off a moving lift works.

**The signal network** is the level's own. Every object carries an `aistate`, and `object_links`
wires sensors to gates to consumers; `Signals.ts` settles the network over four passes each tick and
then hands the result to the doors, lifts and force fields that read it. Links are stored 1-based
(`write_links` counts from 1) and a link can point either way — a door names its switch, but
level00's sensor names the platform it drives — so the index is built in both directions.

**Damage and death.** 100 health, 30 ticks of invulnerable blink after a hit, and a 120-tick death
animation before respawning at `START` with a full bar. `hurt()` refuses while the body is already
down, otherwise a turret that keeps firing at the corpse restarts the death timer forever and the
respawn never gets a tick to run in.

## CRT filter

`src/render/CrtFilter.ts` is a port of streetalien's `src/fx/crt.ts`. That one is a Canvas 2D
present pass — sliced barrel warp, additive ghost blits, a quarter-res bloom buffer, a pre-rendered
scanline canvas, gradient overlays — none of which survives a move to WebGL, so this is the same
chain of effects in one fragment shader, in the same order and with the same constants:

> barrel curvature → convergence ghosting → bloom → scanlines + aperture grille → rolling band →
> vignette → flicker → rounded tube mask

Costs ~0.07 ms/frame at 1920×1080. Toggle with **V**.

**The grid is locked to the game's pixel grid.** The rest of the pass is authored against a 960x540
buffer and scaled by `crtPixelScale`, but the scanlines and grille cannot be: a cycle that is not a
whole number of game pixels beats against them, and the lines crawl. What has to be whole is the
*cell* — one scanline, one grille stripe — not just the cycle, since a two-pixel cycle split three
ways still puts two of its edges two thirds of the way into a pixel. `crtGridPeriod` sizes the cell
in whole game pixels, which at every window size the game actually runs at comes out as exactly one:
a scanline every third row, grille stripes one pixel wide.

That only means anything if the pixels themselves hold still, so the scene offset is snapped to a
whole game pixel (the camera stays fractional, so the follow is still smooth) and sprite positions
are rounded the same way. Pixi's own `roundPixels` is not enough — it rounds to a *device* pixel,
and the world is drawn at an integer zoom, so a sprite can still land a fraction of a game pixel off
the grid the tiles sit on.

Measured on a rendered frame at zoom 2: grouping rows by their phase in the 6-device-pixel cycle
gives means of 70.3, 70.6, 72.1, 72.7, **45.4, 45.4** — the darkening falls on exactly two adjacent
device rows, one whole game pixel, at a fixed phase.

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

- **Only three enemies think.** Turrets, ceiling ants and floaters fight; everything else still
  spawns as scenery. Ground ants, the jugger, the trex and the flying enemies have all their art
  and states converted and no behaviour attached.
- **Nothing spawns.** level01 ships 13 `HIDDEN_ANT` and 10 `ANT_CRACK` - the markers the original
  used to pour ants into a room - and both are inert here.
- **Turret shots do not lead you.** They fire along the angle to where you are, so strafing beats
  them. And nothing an enemy fires can hit another enemy.
- **Enemies do not come back.** Kill one and the level is that much emptier until you reload it;
  there is no respawn or spawner logic.
- **One weapon.** The machine gun. Every ammo pickup tops up the same pool, and the grenade, rocket
  and plasma art sits unused.
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
