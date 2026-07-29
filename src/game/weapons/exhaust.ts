import type { MoteSink } from '../effects/motes'
import { randomBelow } from './angles'

/**
 * What comes out of the back of a rocket.
 *
 * The original's whole answer is one `SMALL_LIGHT_CLOUD` a tick at
 * `(set_fade_count 11)` (lisp/weapons.lsp rocket_ai), jittered three pixels
 * either way. That art is still spawned - see `trailSmoke` in behaviour.ts -
 * and everything here is invented on top of it: a jet of fire at the nozzle,
 * smoke that drifts and expands behind it, and for the firebomb a spray that
 * goes up rather than back, because a firebomb is a burning puddle and not a
 * jet.
 *
 * The angles are the engine's: 0 due right, 90 straight up (see angles.ts).
 * Everything is emitted per *sim* tick, which is the clock the motes run on.
 */

/** Where the jet starts, measured back along the heading. */
const NOZZLE_OFFSET = 5

const FIRE_HOT = 0xfff0a0
const FIRE_COOL = 0xff5000
const SMOKE_NEAR = 0x9a9a9a
const SMOKE_FAR = 0x3a3a3a

interface Moving {
  readonly x: number
  readonly y: number
  readonly heading: number
}

/** Two motes of flame straight out of the back, plus one of smoke behind it. */
export function rocketExhaust(motes: MoteSink, rocket: Moving, scale = 1): void {
  const back = (rocket.heading + 180) % 360
  const theta = (rocket.heading * Math.PI) / 180
  const x = rocket.x - Math.cos(theta) * NOZZLE_OFFSET
  const y = rocket.y + Math.sin(theta) * NOZZLE_OFFSET

  motes.burst(2, x, y, back, 22, 1.5 * scale, 1, {
    life: 5 + randomBelow(4),
    // Hot gas, so nothing pulls it down; the drag is what makes the jet stop
    // dead a few pixels out instead of streaming away behind.
    gravity: 0,
    drag: 0.82,
    colour: FIRE_HOT,
    fadeTo: FIRE_COOL,
    size: 2,
    sizeTo: 1,
    blend: 'add',
  })

  motes.burst(1, x, y, back, 35, 0.6, 0.4, {
    life: 45 + randomBelow(21),
    // Smoke rises.
    gravity: -0.01,
    drag: 0.94,
    colour: SMOKE_NEAR,
    fadeTo: SMOKE_FAR,
    size: 2,
    sizeTo: 7,
    alpha: 0.45 * scale,
    blend: 'normal',
  })
}

/** The disc: smoke only. It is thrown, not burning, so it has no flame. */
export function discExhaust(motes: MoteSink, disc: Moving): void {
  motes.burst(1, disc.x, disc.y, (disc.heading + 180) % 360, 30, 0.5, 0.3, {
    life: 25 + randomBelow(15),
    gravity: -0.01,
    drag: 0.95,
    colour: SMOKE_NEAR,
    fadeTo: SMOKE_FAR,
    size: 2,
    sizeTo: 5,
    alpha: 0.3,
    blend: 'normal',
  })
}

/**
 * The firebomb. `fb_draw` returns nil, so the bomb itself is never drawn at
 * all and the flames are the entire thing you see - which in the original is
 * one EXPLODE1 a tick. This sprays upward around vertical instead of backward,
 * and only smokes every fourth tick so a bomb that lives twenty ticks does not
 * bury the room.
 */
export function firebombFlames(motes: MoteSink, x: number, y: number, tick: number): void {
  motes.burst(3, x, y, 90, 60, 1.2, 0.6, {
    life: 6 + randomBelow(5),
    gravity: -0.02,
    drag: 0.9,
    colour: FIRE_HOT,
    fadeTo: FIRE_COOL,
    size: 2,
    sizeTo: 1,
    blend: 'add',
  })

  if (tick % 4 !== 0) return
  motes.burst(1, x, y, 90, 45, 0.7, 0.4, {
    life: 50 + randomBelow(25),
    gravity: -0.015,
    drag: 0.94,
    colour: SMOKE_NEAR,
    fadeTo: SMOKE_FAR,
    size: 3,
    sizeTo: 9,
    alpha: 0.4,
    blend: 'normal',
  })
}
