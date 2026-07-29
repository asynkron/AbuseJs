/**
 * Abuse's angle convention, in one place.
 *
 * The scripts work in whole degrees 0..359 measured counter-clockwise from due
 * right, on a screen whose y grows downward. So 90 is straight up, and
 * `(set_course angle speed)` yields `xvel = cos(a)*speed`, `yvel = -sin(a)*speed`.
 * `(atan2 dy dx)` is handed an already-flipped dy - `player_angle_suggestion`
 * passes `(- (y) (player_pointer_y) 16)`, which is how far the crosshair sits
 * *above* the chest (lisp/people.lsp).
 *
 * The original's lisp carries a fixed-point number type, so `(* (cos a) 17)`
 * reads out as 17*cos(a) in pixels and truncates when it lands in an integer
 * slot. Everything here stays in floats and truncates only where the original
 * visibly depends on it (the machine gun's integer speed ladder); sub-pixel
 * positions are harmless because the renderer rounds at draw time anyway.
 */

const DEGREES = Math.PI / 180

export interface Velocity {
  vx: number
  vy: number
}

export function cosDeg(angle: number): number {
  return Math.cos(angle * DEGREES)
}

export function sinDeg(angle: number): number {
  return Math.sin(angle * DEGREES)
}

/** Wraps to 0..359, the range every script assumes. */
export function normalizeAngle(angle: number): number {
  return ((angle % 360) + 360) % 360
}

/**
 * `(atan2 up right)` - note the first argument is measured upward, opposite to
 * screen y. Returns 0..359.
 */
export function atan2Deg(up: number, right: number): number {
  return normalizeAngle((Math.atan2(up, right) / DEGREES))
}

/** `(set_course angle speed)`. */
export function setCourse(angle: number, speed: number): Velocity {
  return { vx: cosDeg(angle) * speed, vy: -sinDeg(angle) * speed }
}

/**
 * `(set_frame_angle 0 359 angle)` - map a heading onto a state's frame list.
 * Frame 0 aims due right and the list runs counter-clockwise, which is the
 * same mapping Player.ts already uses for the torso's 24 aim frames.
 */
export function frameForAngle(angle: number, frameCount: number): number {
  if (frameCount <= 0) return 0
  return Math.round((normalizeAngle(angle) / 360) * frameCount) % frameCount
}

/**
 * The rocket's steering, from `rocket_ai` (lisp/weapons.lsp): work out the
 * clockwise distance to the wanted heading, turn by at most `maxTurn` degrees,
 * and by nothing at all inside `deadband` so it does not jitter on the spot.
 */
export function steerTowards(
  heading: number,
  wanted: number,
  maxTurn: number,
  deadband: number,
): number {
  const clockwise = wanted < heading ? heading - wanted : heading + (360 - wanted)
  const closest = clockwise > 180 ? 360 - clockwise : clockwise
  const step = closest > maxTurn ? maxTurn : closest < deadband ? 0 : closest
  return clockwise > 180 ? normalizeAngle(heading + step) : normalizeAngle(heading - step)
}

/**
 * `angle_diff` from lisp/weapons.lsp, warts and all - the disc frisbee is the
 * only caller.
 *
 * Inside 180 degrees it is the plain difference. Outside, it returns
 * `(a1 - a2) ± 180`, which is not the shortest arc: steering from 350 towards
 * 10 asks for +160 rather than +20, so the disc sweeps the long way round.
 * That spiralling is what the shipped weapon does, so it is kept rather than
 * corrected.
 */
export function angleDiff(from: number, to: number): number {
  if (Math.abs(to - from) < 180) return to - from
  return from < to ? from - to + 180 : from - to - 180
}

/** `(random n)` - 0..n-1. */
export function randomBelow(limit: number): number {
  return Math.floor(Math.random() * limit)
}
