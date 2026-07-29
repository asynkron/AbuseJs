# abuse.js

A web game built on the art, levels and sounds of **Abuse** (Crack dot Com, 1995), with our own
game mechanics. Rendering is PixiJS v8 (WebGL/WebGPU); everything else is ours.

**Play it: [asynkron.github.io/AbuseJs](https://asynkron.github.io/AbuseJs/)**

Current state: real Abuse levels load with their lighting, tile layers, objects, ambience, music and
tutorial text; the cop runs, jumps, climbs ramps, rides platforms, takes teleporters and walks
between levels through the original exit portals. It shoots, and the level shoots back — ants,
flyers, juggers, cleaner robots and the boss all think, ant cracks pour more of them into a room,
and everything fires the original's own eight projectiles. The levels' sensor-and-gate wiring drives
the doors and lifts, and the four special powers do what the scripts say they do.

```bash
npm install
npm run assets   # convert assets/original/**.spe -> public/assets  (~2s)
npm run dev      # http://localhost:5173
```

It opens on a title screen. The wording is the original's own, out of `lisp/english.lsp` — "Start New
Game", "Load Saved Game", and the four difficulties it calls **Wimp, Easy, Normal and Extreme**,
which are the lisp's `easy`, `medium`, `hard` and `extreme`. Abuse ships set to `hard`, so its
"Normal" really is the default and the two below it are concessions. The setting scales incoming
damage and healing (`bottom_damage` and `give_player_health` in `lisp/people.lsp`): on Extreme a
10-point hit lands as 30 and a 10-point pickup heals 2.

The screen also earns its keep: browsers will not start an AudioContext without a gesture, so the
game needed a first click anyway. A deep link like `#levels/level14` skips it.

Controls: **arrows/WASD** move, **space** jump, **shift** run, **mouse** aims the torso,
**X** or **left mouse** fire, **1**–**8** or **Q** pick a weapon, **C** or **right mouse** holds
a special power, **down/S** or **E** to use a platform, teleporter or exit portal,
**V** toggles the CRT filter, **L** toggles level lighting. Everything is reachable from a trackpad —
no right button anywhere.
Sound starts muted — there is a volume slider top right.
Progress is saved at the consoles the levels place, and reloading picks up where you left off.
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

Behaviour now comes from the shipped `.lsp` scripts rather than from invention: the AI functions,
the weapon table, the explosion clusters and the gate wiring are all read out of
`assets/original/lisp` and cited where they land. The player's *feel* — acceleration, jump arc,
coyote time, weapon selection — is still ours, and says so.

**Eight weapons.** The status bar has eight slots, the art ships eight lit/dim icon pairs, every
weapon has its own 24-frame torso in `art/coptop.spe`, and the levels scatter ammo for all of them.
The slot an ammo icon fills comes from `weapon_icon_ai`'s own table and the amount from the icon's
`start_hp`, which is how the firebomb (3) and the plasma rifle (4) end up the right way round.
Picking up ammo for something you were not carrying is also how you get the weapon.

They are real projectiles, not tracers. A grenade arcs and detonates on its first blocked move; a
rocket accelerates to 14 and homes on whatever the ±160px search locked onto, and can be shot out of
the air because `ROCKET` is `(hurtable T)` with 4hp; the firebomb skids along the floor spewing 40
damage over 60px every tick it burns; the disc steers towards the crosshair the long way round,
because `angle_diff` is not a shortest-arc calculation and that spiral is what the shipped weapon
does. Only the plasma bolt and the light sabre resolve at the muzzle, which is what the originals do
too. Out of ammo the machine gun does not stop, it labours — 3 ticks with, 7 without, which is what
"collect ammo to increase firing speed" in the tutorial means. The other seven simply are not there
to fire, and none of them fires at all when the muzzle is inside a wall.

Everything shares one target list, the cop included. That is what `bmove` does — it hits whatever is
in the way and spares only the shooter — so enemy fire hits other enemies, and standing next to your
own grenade costs you health.

**1–8** pick a slot and **Q** steps through what you are carrying, skipping empty ones. The original
says "use the CTRL & INS keys", which is undiscoverable on a laptop. Not the scroll wheel: one
two-finger swipe on a trackpad emits a burst of wheel events, so the weapon flickered through every
slot the moment you moved your hand, and a trackpad's deltas cannot be reliably told from a real
wheel's.

The muzzle is not the player's centre: it comes from the 24-entry `small_fire_off` table in the
original `src/cop.cpp`, so a shot leaves the actual gun barrel through a full rotation.

**Special powers**, held on **C** or the right mouse button — "hold down the right mouse button to
use special powers", as the tutorial puts it. The levels place four (`POWER_FAST`, `POWER_FLY`,
`POWER_SNEAKY`, `POWER_HEALTH`). They never expire: `special_power` is cleared by `restart_player`
and by nothing else, and the one duration in either script — `(user_fun SET_FAST_TIME 360)` — is
commented out in the shipped game, so the charge bar this port used to draw was restoring a line
that never ran.

FAST is not a multiplier: while the button is down the cop takes a complete second movement step
before the tick's own, so collision and animation happen twice, and it burns an extra tick off the
weapon cooldown as well. FLY leaves gravity on and pushes −2 into the vertical velocity every tick
(−3 with up held) — the hover is the balance between the two, and letting go is how you descend.
HEALTH raises the ceiling from 100 to 200 and grants one top-up; it does not regenerate. SNEAKY
fades the cop out and stops anything noticing him, though it does not call off a fight already under
way. FAST and FLY also swap in DARNEL's own `fast_*` and `fly_*` animation sets, which hide the
aiming torso — `top_draw_state` does not list them.

**The creatures think.** Ants walk the ceiling, shoot straight down, drop and fight on the floor;
`ANT_CRACK` pours more of them into a room; flyers, juggers, cleaner robots and the two-form boss
all run their own scripts. A shooter's `aitype` *is* its weapon — the same number picks its tint,
its health and the round it fires — so an AI shoots by handing its aitype to the same `fire_object`
the cop uses.

**Deaths are authored, not generic.** Nothing in the original puts one stock explosion over
everything that dies. A turret throws four fireballs at delays 0,1,2,3 over `BLOWN_UP`; a flyer
throws three on the beat; ROB1 gets eight at fixed offsets across six ticks; a boulder gets four and
a light. An ant gets no explosion at all — it comes apart into five body parts that tumble, bounce
and settle on the floor, flaming or electric depending on what killed it (`get_dead_part` reads the
otype of the killing shot). All of it plays at the engine's rate, one animation frame per tick,
which is a quarter of the simulation's.

**Exits announce themselves.** The levels put no TRAIN_MSG on their `NEXT_LEVEL` portals — the
original expects you to recognise one on sight — so it was possible to walk past the end of a level
without knowing it was there. Come within 46px and it says which level it goes to; stand on it and
it says to press down. level00 has five, and the one that finishes the tutorial is at (2655, 1431),
at the bottom right past the last sign.

**The save console** is `RESTART_POSITION` — the same marker a fresh level spawns you at, which is
why using one is literally moving where you restart. Its `stopped` state is the six-frame idle
flicker and `running` is `console_on`, so the art already had an activated look to switch to. Press
down at one and the level id, your position, health, every magazine and the power you are holding go
to `localStorage`; dying returns you there instead of to `START`, and so does reloading the page.

**Platforms and teleporters** read their endpoints out of the level. A lift's two links *are* its
endpoints and an optional third is its enable switch; `xacel` is how many interpolation steps the
trip takes, so a lower number is a faster lift. `platform_ai` boards you with `(set_y (- (y)
start_accel))` — 22px above the anchor for the small platform, whose picture is only 15 tall — so
the deck is the top of the sprite but the band that counts as standing on it is `start_accel` either
way. Riding carries you continuously rather than in steps, and stepping off keeps the coyote timer
alive so a jump off a moving lift works.

**Hidden walls chain.** A wall is not one object — level01 has 102 blocks of 25hp each — and the
thing that makes a room open from one shot is in the original's own lisp. A dying wall calls
`hurt_radius` on itself: 110px for 120 damage from `big_wall_ai`, 50px for 60 from `hwall_ai`
(lisp/doors.lsp). Against 25hp blocks that is lethal several times over, so the neighbours die and
their blasts kill *their* neighbours. One shot measured into level01 takes twenty-five blocks with
it. There is no special case for any of this: the walls are in the same target list as everything
else, which is also why the blast catches whatever is standing in it.

They also crack as you shoot them: `hwall_damage` sets the frame from the health fraction, so the
three `sect` frames are progressive damage rather than an idle animation.

**Force fields.** The blue "FF" glyphs were the editor's marker leaking into the game: `ff_draw`
opens with `(if (edit_mode) (draw))`, so `FORCE_FIELD`'s only sprite is never meant to reach the
screen. What you should see is four scattered vertical lines from the object down to the floor, in
the four colour pairs and widths `ascatter_line` is called with. `ff_ai` finds that floor with
`(try_move 0 (+ (y) 200))`, plays FF_SND every fourth tick and shoves the player out with
`(ff_push (first_focus) 35)`. All three in level01 are wired to their own switch, so they are off
until something turns them on — the gate is `(activated)`, which is true for a field nothing wires
and follows the switch for one that is.

**Doors block.** `SWITCH_DOOR` and the trap doors carry `can_block` and a four-state set: `stopped`
is shut, `running` runs the shutter open, `walking` runs the same frames back. Collision is
tile-based and a door is an object, so until they were given a collision pass of their own a closed
door was a picture you strolled through — as were the hidden walls, of which level01 has over eighty.
Anything solid that is not a tile now pushes the player out along whichever axis needs the least
movement, resolved after the tile pass; doors and hidden walls are thin slabs in corridors, so the
shallow axis is always the right one. A lip within 8px of the player's feet is stepped onto instead —
the same tolerance the tile collision uses, and needed for the same reason, since hidden walls sit
flush in floors and being shoved sideways off one feels like catching on nothing.

The list of solid objects is not `can_block`: that flag is on more than sixty characters, including
every platform, both turrets, the T_REX and `NEXT_LEVEL`. In the original it means "this *can*
block", with the blocking driven from lisp state, so reading it as "is solid" walls off exit portals
and anything else you are meant to stand on.

A door wired to a switch does what the network says. An unwired one opens for whoever walks up to it.

**Ladders.** `LADDER` draws with `dev_draw`, so the object is an invisible marker and the rungs you
see are ordinary tiles. The marker and the object it links to are two opposite corners of a
rectangle; `latter_check_area` in lisp/ladder.lsp tests the player against both and records how far
below the top they are, which is the only thing `climb_handler` in people.lsp ever reads. Climbing
is not physics — 3px a tick under direct control with no gravity, stepping off at the top within
32px of it, and leaving sideways into a fall. level01 has none; level02 has eighteen.

**Teleport doors** (`TP_DOOR`) are neither a pad nor a `SWITCH_DOOR`. `tpd_ai` in
lisp/teleport.lsp gives them three jobs: slide open when you come near, open the *partner* at the
same moment so you can see the far end gaping, and carry you across while the action key is held.
They carry no `can_block`, so standing in the opening is the point — which is exactly why nothing
happening reads as a broken door. The original never mentions the key, so this one prompts.

**The signal network** is the level's own. Every object carries an `aistate`, and `object_links`
wires sensors to gates to consumers. The seventeen types that drive it — the six switches, the six
gates, the sensors, the doors, the step and the three lifts — each run their real ai function once
per tick in level order, which is why a chain of delay gates advances one link per tick instead of
settling instantly. Links are stored 1-based (`write_links` counts from 1) and a link can point
either way — a door names its switch, but level00's sensor names the platform it drives — so the
index is built in both directions.

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

**The grid is locked to the game's pixel grid, and rides the curvature.** The rest of the pass is
authored against a 960x540 buffer and scaled by `crtPixelScale`, but the scanlines and grille cannot
be: a cycle that is not a whole number of game pixels beats against them and the lines crawl.
`crtGridPeriod` makes one cycle one game pixel — one scanline per source row, one shadow-mask triad
per source pixel, which is what a tube does. A cycle is three cells and so needs three device pixels
to draw at all; below zoom 3 it grows to the next whole number of game pixels that fits, coarser
than ideal but still locked.

The grid is measured in the *warped* frame, not the flat one. Everything on the glass — mask, beam,
rolling band — sits on the curved surface, and a dead-straight grid over a picture that bends reads
as wrong immediately.

That only means anything if the pixels hold still, so the scene offset snaps to a whole game pixel
(the camera stays fractional, so the follow is still smooth) and sprite positions round the same
way. Pixi's own `roundPixels` is not enough — it rounds to a *device* pixel, and the world is drawn
at an integer zoom, so a sprite can still land a fraction of a game pixel off the grid the tiles sit
on.

Measured on a rendered frame at zoom 3, rows grouped by their phase in the 3-device-pixel cycle:
53.5, 53.4, **24.2** at the centre — one row in three darkened, 75% modulation. At the left and
right edges that collapses to 2% and 7%, which is the curvature doing its job: the grid is no longer
at a constant phase in *screen* space because it is riding the warp with the picture.

Two deliberate differences from the original:

- Its "crush to half res" step is dropped — this game already renders at an integer zoom with
  nearest-neighbour sampling, so the pixels are chunky before the CRT sees them.
- Its constants are authored against a 960×540 buffer; `crtPixelScale()` converts one of those units
  into device pixels so the scanline pitch and tube radius stay the same apparent size at any window
  size.

The additive passes (0.24 ghosting + 0.32 bloom) lift the blacks noticeably on Abuse's dark art.
That is what the original does, so rather than change its constants there are **brightness,
contrast and glow sliders in the top right**. Glow scales both additive passes together — they are
the same physical thing, light from one part of the tube landing on another, and separating them
only gives two sliders that have to be kept in agreement. 1 is the authored amount; 0 leaves the
picture sharp. The brightness and contrast trims that trim the result. Both default to `1.2`. They are applied
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

- **Editor-only art can still leak through.** `FORCE_FIELD` was drawing its marker because the
  converter's editor-only detection looks for a bare `(draw)`, and `ff_draw` guards it with
  `(if (edit_mode) ...)` instead. Other characters may do the same.
- **The `lvars` chunk is not read.** `tools/convert.ts` skips it, so every per-object setting the
  levels keep there falls back to the scripts' constructor default: `create_total`, `hide_flag`,
  `stationary`, the jugger's throw velocity, the flyer's burst configuration, `delay_time`,
  `pulse_speed`, `reset_time`, `unoffable`. Two visible consequences — every jugger walks, since 21
  of the 52 should be turrets and nothing distinguishes them, and `GATE_DELAY` uses the commonest
  shipped value rather than its own. Both subsystems take the real values through a seam the moment
  the converter emits them.
- **`def_explo` is not expanded.** It builds eleven characters through `eval`, so `tools/lisp.ts`
  never sees a literal `def_char` and none of them reach `chars.json`; the same goes for the 24 gib
  characters. Their catalogues are spelled out by hand in `src/game/effects/sprites.ts` and
  `DeathEffects.ts` against frames that are all present in the atlas. Teaching the extractor to
  expand the form would let both tables be deleted.
- **A weapon kill does not colour its gibs.** `get_dead_part` picks flaming or electric parts from
  the otype of the killing shot, but the projectile host's damage call has no room for a source, so
  everything a weapon kills comes apart into the plain set. Blasts that go through the effects
  subsystem directly — the hidden walls — do carry it.
- **Enemies do not come back.** Kill one and the level is that much emptier until you reload it;
  there is no respawn logic beyond `ANT_CRACK`.
- **The full-screen tints are missing.** `tint_palette` and `make_view_solid` — the red damage ramp,
  the mine's flash, POWER_FAST's white flash — are present-pass effects and belong in the CRT
  filter. SNEAKY's "predator" refraction is drawn as a very low alpha for the same reason.
- **Thirteen level-logic behaviours are still out.** Bombs, mines, lava, teleport pads, TP_DOORs,
  ladders, springs, pushers, lightning, dimmers, movers, holders and `DEATH_RESPAWNER` have no
  implementation; the seventeen switch/gate/door/lift types do.
- **18 addon levels reference tiles that were never shipped** — mostly `addon/claudio/*` and
  `addon/pong/*`, plus a dozen stray cells in `levels/frabs18` and `levels/frabs30`. `abuse.lsp`
  says as much: claudio's palettes "can only be used with the art files by other authors". Unknown
  tiles are skipped rather than drawn, so those levels load with holes. All 22 core
  `levels/levelNN` are clean.

### Things that turned out not to exist

- **Tile animation.** The `next` field is 0 on all 1109 foreground and 405 background tiles, and
  the engine never reads it. Animated lava, teleporters and screens are objects, not tiles.

## Deploying

`.github/workflows/pages.yml` builds the site on every push to `main` and publishes it to GitHub
Pages. The generated assets are gitignored, so CI runs `npm run assets` against `assets/original/`
rather than committing the output — the repo holds Abuse's shipped data, not a derivative of it.
23MB and 313 files come out the other end.

`vite.config.ts` sets `base: './'` rather than `/AbuseJs/`, so the same build works at a domain root
and under a project path. Every asset fetch in the app is already relative to the document.

## Licensing

Abuse's code and data were released into the public domain by Crack dot Com; the sound effects and
music are Bobby Prince's and are redistributable. See `assets/original/COPYING` and `AUTHORS`.
