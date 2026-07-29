import type { LevelObjectData } from '../assets/types'

/**
 * Ladders.
 *
 * `LADDER` draws with `dev_draw`, so the object is an invisible marker and the
 * rungs you see are ordinary tiles. The marker and the object it links to are
 * two opposite corners of a rectangle: `latter_check_area` in lisp/ladder.lsp
 * tests the player against both and, when inside, records how far below the
 * top they are. That distance is the whole interface - `climb_handler` in
 * people.lsp reads it and nothing else.
 *
 * Climbing is not physics. The cop moves 3px a tick under direct control with
 * gravity suspended, steps off at the top when within 32px of it, and leaves
 * sideways into a fall if there is headroom.
 */

/** Pixels per tick, up or down - `(set_y (+ (y) 3))` in climb_handler. */
export const CLIMB_SPEED = 3
/** Within this of the top, pressing up steps off instead of climbing. */
export const CLIMB_OFF_RANGE = 32
/** How far stepping off lifts the cop - `(set_y (- (y) 28))`. */
export const CLIMB_OFF_RISE = 28

export interface Ladder {
  /** The rectangle you can climb in, in world pixels. */
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
  /** Where the cop is pulled to while climbing - the midpoint of the corners. */
  readonly centreX: number
}

/**
 * How far the player is below the top of the ladder they are on, or null when
 * they are not on one. Null and zero are meaningfully different: zero means
 * standing exactly at the top, still holding on.
 */
export function climbDepth(ladders: readonly Ladder[], x: number, y: number): number | null {
  for (const ladder of ladders) {
    if (x < ladder.left || x > ladder.right) continue
    if (y < ladder.top || y > ladder.bottom) continue
    return y - ladder.top
  }
  return null
}

/** The ladder covering a point, for the horizontal pull. */
export function ladderAt(ladders: readonly Ladder[], x: number, y: number): Ladder | null {
  for (const ladder of ladders) {
    if (x < ladder.left || x > ladder.right) continue
    if (y < ladder.top || y > ladder.bottom) continue
    return ladder
  }
  return null
}

/**
 * Builds the climbable rectangles. A marker with no link describes no area and
 * is dropped - `latter_ai` does the same with `(> (total_objects) 0)`.
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
