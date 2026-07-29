import type { MoteSink } from '../effects/motes'
import { randomBelow } from './angles'

/**
 * The flame out of the back of a rocket.
 *
 * Only the flame. The smoke is the original's own - one `SMALL_LIGHT_CLOUD` a
 * tick at `(set_fade_count 11)` (lisp/weapons.lsp rocket_ai), spawned by
 * `trailSmoke` in behaviour.ts - and it stays that way. Motes did the smoke
 * here to begin with, and a mote is a flat square of one colour: right for a
 * two-pixel ember, and a large grey block at any size worth calling smoke.
 * The division that came out of it is worth stating plainly, because it
 * applies to the blasts too: **motes are for small, bright, moving things;
 * anything that wants a shape is a sprite.**
 *
 * The angles are the engine's: 0 due right, 90 straight up (see angles.ts).
 * Everything is emitted per *sim* tick, which is the clock the motes run on.
 */

/** Where the jet starts, measured back along the heading. */
const NOZZLE_OFFSET = 5

/** Amber rather than near-white: these draw additively. See blastGlow.ts. */
const FIRE_HOT = 0xffc040
const FIRE_COOL = 0x901000

interface Moving {
  readonly x: number
  readonly y: number
  readonly heading: number
}

/** Two motes of flame straight out of the back. */
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
}

/**
 * The firebomb. `fb_draw` returns nil, so the bomb itself is never drawn at
 * all and the flames are the entire thing you see - which in the original is
 * one EXPLODE1 a tick. This sprays upward around vertical instead of backward,
 * because a firebomb is a burning puddle and not a jet.
 */
export function firebombFlames(motes: MoteSink, x: number, y: number): void {
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
}
