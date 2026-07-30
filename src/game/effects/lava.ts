import type { MoteSink } from './motes'
import { random } from './random'
import type { PuffKind } from './sprites'

/**
 * A lava surface simmering.
 *
 * Invented, all of it. `lava_ai` has exactly two visible events - the belch
 * (LAVA_SND, then a 20px `hurt_radius` five ticks later) and the tile's own
 * looping art - so a pool of it sits there as flat orange wallpaper that
 * happens to hurt. This gives the surface something to do between belches.
 *
 * Split by medium, the way `exhaust.ts` settled it: **motes are for small,
 * bright, moving things; anything that wants a shape is a sprite.** So the
 * bubbles and the spatter are motes, additive over the tile's own glow, and
 * the smoke is one of the original's own cloud sprites left to play out where
 * it was born. A grey mote at smoke size is a grey square.
 *
 * Rates are per sim tick and per lava object, which is what makes them look
 * small: a pool is a row of tiles, so a 1-in-14 bubble on each of eight tiles
 * is a bubble every other tick across the pool.
 */

/** Where a lava object's surface is, relative to its own anchor. */
export interface LavaSurface {
  readonly left: number
  readonly right: number
  readonly top: number
}

/** Bright enough to read against the tile, and it draws additively. */
const LAVA_HOT = 0xffb020
const LAVA_COOL = 0x902000
/** The spatter starts hotter still - it is the bit that catches the eye. */
const SPATTER_HOT = 0xffe070

/** 1-in-N per tick, per object. */
const BUBBLE_ODDS = 14
const SPATTER_ODDS = 110
const SMOKE_ODDS = 70

/** Bubbles swell as they surface, so they grow rather than shrink. */
const BUBBLE_SIZE = 1
const BUBBLE_SIZE_TO = 3

/** Straight up, in the engine's angles - see weapons/angles.ts. */
const UP = 90

/** A whole number in [0, n). */
const below = (n: number): number => random(n)

/**
 * One sim tick of one lava object. `puff` is optional so a caller without the
 * sprite pool still gets the motes.
 */
export function lavaSimmer(
  motes: MoteSink,
  surface: LavaSurface,
  puff?: (kind: PuffKind, x: number, y: number, fade: number) => void,
): void {
  const width = Math.max(1, surface.right - surface.left)
  const at = (): number => surface.left + below(width)

  // A bubble: rises slowly out of the surface, swelling, and is gone in under
  // a second. `gravity` below zero is the rise; the drag keeps it from
  // accelerating away.
  if (below(BUBBLE_ODDS) === 0) {
    motes.emit({
      x: at(),
      y: surface.top - below(2),
      vx: 0,
      vy: -0.15 - below(10) / 100,
      life: 14 + below(12),
      gravity: -0.01,
      drag: 0.97,
      colour: LAVA_HOT,
      fadeTo: LAVA_COOL,
      size: BUBBLE_SIZE,
      sizeTo: BUBBLE_SIZE_TO,
      alpha: 0.85,
      alphaTo: 0,
      blend: 'add',
    })
  }

  // A bubble bursting: a few specks thrown clear that arc back down. Positive
  // gravity, so they fall - that is what separates spatter from a bubble.
  if (below(SPATTER_ODDS) === 0) {
    motes.burst(2 + below(3), at(), surface.top, UP, 34, 1.4, 0.7, {
      life: 10 + below(8),
      gravity: 0.09,
      drag: 0.99,
      colour: SPATTER_HOT,
      fadeTo: LAVA_COOL,
      size: 2,
      sizeTo: 1,
      blend: 'add',
    })
  }

  // And the smoke off the top. `SMALL_DARK_CLOUD` is `smo2` from art/cloud.spe,
  // the same sheet the rocket trail draws from, at the fade the trail uses so
  // it sits over the glow rather than blotting it out.
  if (puff && below(SMOKE_ODDS) === 0) {
    puff('SMALL_DARK_CLOUD', at(), surface.top - below(4), 11)
  }
}
