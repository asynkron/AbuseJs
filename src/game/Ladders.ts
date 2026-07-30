import { speed } from './enemies/tuning'
import type { LevelObjectData } from '../assets/types'

/**
 * Ladders, as `lisp/ladder.lsp` describes them.
 *
 * `LADDER` draws with `dev_draw`, so the object is an invisible marker and the
 * rungs you see are ordinary tiles. They come in pairs: the marker carrying a
 * link is the top-left corner and the `LADDER` it points at - which has no
 * link of its own - is the bottom-right.
 *
 * `latter_check_area` is a plain point-in-rectangle test on the player's
 * anchor, with no tolerance of any kind:
 *
 *   (<= (x) player.x)      (<= (y) player.y)
 *   (>= other.x player.x)  (>= other.y player.y)
 *
 * What keeps you from drifting out of a 22px-wide shaft is not slack in that
 * test - it is that a climbing cop is pulled onto the centre line every tick,
 * `(set_x (/ (+ (x) (other x)) 2))`. Widening the test instead, which is what
 * was tried here first, only papers over a missing pull and then strands you
 * somewhere else.
 */

/** Pixels per tick, up or down - `(set_y (+ (y) 3))` in climb_handler. */
export const CLIMB_SPEED = speed(3)
/** Within this of the top, pressing up steps off - `(if (< yd 32) ...)`. */
export const CLIMB_OFF_RANGE = 32
/** How far stepping off lifts the cop - `(set_y (- (y) 28))`. */
export const CLIMB_OFF_RISE = 28
/** Pixels of climb per frame of the ten-frame `4lad` cycle. */
export const CLIMB_FRAME_PITCH = 6
/** `(and (> ym 0) (< yd 10))` - close enough to the top to step on from above. */
export const CLIMB_ON_RANGE = 10
/** `(and (< ym 0) (> yd 8))` - how far below the top reaching up works. */
export const CLIMB_GRAB_MIN = 8
/** `(try_move (x) (y) 0 -20 3)` - headroom needed to step off sideways. */
export const CLIMB_STEP_OFF_RISE = 20
/**
 * The original also pans the view by 4px a frame through both transitions
 * (`pan_y` in climb_on_handler / climb_off_handler), to absorb the 28px step the
 * cop takes onto and off the ladder. There is nothing to do here: this camera
 * has a dead zone and exponential smoothing, which is what that pan is for.
 */

export interface Ladder {
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
  /** `(/ (+ (x) (other x)) 2)` - where a climbing cop is held. */
  readonly centreX: number
}

/** The ladder the point is inside, or null. */
export function ladderAt(ladders: readonly Ladder[], x: number, y: number): Ladder | null {
  for (const ladder of ladders) {
    if (x < ladder.left || x > ladder.right) continue
    if (y < ladder.top || y > ladder.bottom) continue
    return ladder
  }
  return null
}

/**
 * How far below the top of its ladder the point is, or null when it is on
 * none.
 *
 * The original keeps this in `in_climbing_area` and reads 0 as "not on a
 * ladder" - `(if (eq in_climbing_area 0) ...normal movement...)`. Standing
 * exactly level with the top marker therefore leaves the ladder, which is its
 * own quirk and is kept rather than smoothed over.
 */
export function climbDepth(ladders: readonly Ladder[], x: number, y: number): number | null {
  const ladder = ladderAt(ladders, x, y)
  if (!ladder) return null
  const depth = y - ladder.top
  return depth === 0 ? null : depth
}

/**
 * Builds the climbable rectangles. A marker with no link is the far corner of
 * another one's rectangle rather than a ladder of its own, and `latter_ai`
 * skips it the same way with `(> (total_objects) 0)`.
 */
export function buildLadders(objects: LevelObjectData[], links: number[][]): Ladder[] {
  const ladders: Ladder[] = []

  objects.forEach((object, index) => {
    if (object.type !== 'LADDER') return
    const target = (links[index] ?? [])[0]
    if (target === undefined) return

    const other = objects[target]
    if (!other) return

    ladders.push({
      left: Math.min(object.x, other.x),
      right: Math.max(object.x, other.x),
      top: Math.min(object.y, other.y),
      bottom: Math.max(object.y, other.y),
      centreX: (object.x + other.x) / 2,
    })
  })

  return ladders
}
