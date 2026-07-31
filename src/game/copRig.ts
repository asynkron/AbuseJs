/**
 * How the cop's two halves are put together, and where his gun points.
 *
 * The cop is drawn as legs from art/cop.spe with a torso from art/coptop.spe
 * sitting on them, and the join is fussier than it looks: a baseline, a
 * shoulder that shifts when he turns, a torso that is never mirrored, and 24
 * aim frames chosen by searching rather than by dividing. Every one of those
 * has been a bug at some point.
 *
 * It lives apart from Player because it is only numbers and arithmetic - no
 * renderer, no world. Anything that needs to assemble a cop can have it,
 * including tools outside the game, and there is then one copy of the rules
 * rather than one per caller waiting to drift.
 */
import { atan2Deg } from './weapons/angles'

/** The character whose 24 frames the torso is drawn from by default. */
export const TOP_CHARACTER = 'MGUN_TOP'

/**
 * Where the torso sits: `o->y = bot->y + 29 - bot->height` (src/cop.cpp,
 * top_draw). Measured from the legs' *anchor*, so a crouch that shortens the
 * legs drops the torso with it.
 */
export const TOP_BASELINE = 29

/**
 * The shoulder the gun hangs off is 4px further along when the cop faces left.
 *
 * Two separate functions apply it and both restore it afterwards, which makes
 * them easy to mistake for each other: `top_ai` shifts the *legs'* x across the
 * aim maths and puts it back before `o->x=q->x` (src/cop.cpp:155 and :186), so
 * that one really is angles only. `top_draw` then shifts the *torso's* own x
 * across the draw (src/cop.cpp:762-764), so it applies to the sprite as well.
 * Reading only the first leaves the torso 4px to the left of the legs whenever
 * he faces that way.
 */
export const TOP_SHOULDER_NUDGE = 4

/**
 * Where the gun's muzzle sits for each of the torso's 24 aim frames, as
 * (x, right) / (y, up) offsets from the player's anchor.
 *
 * Straight from `small_fire_off` in src/cop.cpp - "x & y offset from character
 * to end of gun". Without it, shots leave from the player's feet instead of
 * the barrel.
 */
export const MUZZLE_OFFSETS: readonly (readonly [number, number])[] = [
  [17, 20], [17, 23], [17, 28], [15, 33], [11, 39], [7, 43],
  [-3, 44], [-10, 42], [-16, 39], [-20, 34], [-20, 28], [-20, 25],
  [-19, 20], [-19, 16], [-16, 14], [-14, 11], [-11, 9], [-7, 8],
  [-3, 8], [2, 8], [6, 9], [10, 10], [14, 13], [16, 15],
]

/**
 * The pivot the aim frames are measured from - `int iy=f[1], ix=f[6*2]` in
 * src/cop.cpp:163, which is frame 0's y and frame *6*'s x. Not a centre, just
 * the two numbers the original happens to pick.
 */
export const AIM_PIVOT_X = MUZZLE_OFFSETS[6][0]
export const AIM_PIVOT_Y = MUZZLE_OFFSETS[0][1]

/**
 * The heading each aim frame inherently points, from its own muzzle offset.
 *
 * This is what makes the frame choice non-uniform: the 24 offsets are not
 * evenly spaced around the pivot, so dividing the aim angle by 24 picks a
 * different frame than the original's nearest-angle search does over most of
 * the circle (src/cop.cpp:166-176).
 */
export const AIM_FRAME_ANGLES: readonly number[] = MUZZLE_OFFSETS.map(([x, y]) =>
  atan2Deg(y - AIM_PIVOT_Y, x - AIM_PIVOT_X),
)

/**
 * `angle_diff` from src/cop.cpp:126 - the shortest way round between two
 * headings, 0..180. Not the same function as the `angleDiff` in
 * weapons/angles.ts, which reproduces the frisbee's deliberately broken one.
 */
export function shortestArc(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

/**
 * The aim frame pointing nearest a heading - the search at src/cop.cpp:166-176.
 *
 * The index is not mirrored for a left-facing cop: the 24 offsets already sweep
 * the whole circle, from +17 on the right round to -20 on the left, so there is
 * nothing to mirror. The torso is not flipped when it is drawn either, and the
 * two go together - flipping one without the other is what made aiming left
 * read correctly until he turned to walk that way, then invert.
 */
export function aimFrameForAngle(wanted: number): number {
  let best = 0
  let bestDiff = Infinity
  for (let i = 0; i < AIM_FRAME_ANGLES.length; i++) {
    const diff = shortestArc(AIM_FRAME_ANGLES[i], wanted)
    if (diff < bestDiff) {
      bestDiff = diff
      best = i
    }
  }
  return best
}
