import type { Level } from '../Level'

/**
 * Line of sight against the tile grid.
 *
 * `can_see` and `see_dist` are engine calls in Abuse and are the backbone of
 * every creature here: the ant tests them twice before every shot, walks the
 * ceiling by them, and the jugger and the cleaner robot use them as ground and
 * look-ahead probes. collision.ts has boxes but no ray, so this is that ray.
 *
 * The last argument to `can_see` picks which object list to test, not whether
 * to test one at all - see SightBlocker below. Callers that have a blocker list
 * pass it; the pure probes (a cliff test, headroom) do not need one.
 */

/**
 * Sampling interval along a ray, in pixels.
 *
 * Invented. Two pixels is fine against 30x15 tiles - the thinnest solid span a
 * ramp column produces is a pixel tall, but a ray that grazes one that finely
 * was never going to be the deciding test - and it halves the cost of the
 * long sight lines the ants run to the player every tick.
 */
const STEP = 2

/**
 * The row a body's own sight lines have to leave from.
 *
 * An object's `y` is its feet, but collision.ts treats a body as occupying
 * `[y - height, y)` - the bottom edge is exclusive - so a body standing on a
 * floor comes to rest with `y` exactly equal to the floor's top. That row is
 * solid, and `isSolidAt` says so, which means a ray cast from `y` is blocked at
 * its own origin: the cleaner robot's look-ahead never cleared, so it never
 * took a step, and a grounded ant's feet-to-muzzle test never passed, so it
 * never fired. The last row the object actually occupies is one above.
 *
 * The original has no equivalent because its `y` is the feet row itself, with
 * the floor beginning at `y + 1`.
 */
export function eyeY(y: number): number {
  return y - 1
}

/** True when a single world point sits inside something solid. */
export function isSolidAt(level: Level, x: number, y: number): boolean {
  const cx = Math.floor(x / level.tileW)
  const cy = Math.floor(y / level.tileH)
  const span = level.spanInRange(cx, cy, x, x + 1)
  return span !== null && y >= span.top && y < span.bottom
}

/**
 * A blocking object's box, as `boundary_setback` sees it.
 *
 * `can_see(x1, y1, x2, y2, nil)` does *not* mean "tiles only". The last
 * argument picks which object list to test: non-nil gets
 * `all_boundary_setback` over every hurtable object, and nil gets
 * `boundary_setback` over `block_list` - the objects whose character sets
 * `can_block` (src/clisp.cpp:1777-1792, src/level.cpp:477-490). Every AI call
 * site passes nil, so all of them are still occluded by closed doors, lifts,
 * steps and hidden walls. Reading nil as "geometry only" let the ants and the
 * jugger see and shoot straight through a shut door.
 */
export interface SightBlocker {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

/** `can_see`: nothing solid between the two points. */
export function canSee(
  level: Level,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  blockers?: Iterable<SightBlocker>,
): boolean {
  const dx = x2 - x1
  const dy = y2 - y1
  const length = Math.hypot(dx, dy)
  const steps = Math.max(1, Math.ceil(length / STEP))

  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    if (isSolidAt(level, x1 + dx * t, y1 + dy * t)) return false
  }

  if (blockers) {
    for (const box of blockers) {
      if (segmentBlocked(x1, y1, x2, y2, box)) return false
    }
  }
  return true
}

/**
 * Does the segment touch the box? The slab test, so it costs the same whatever
 * the ray's length - the tile pass above is already the expensive half.
 */
export function segmentBlocked(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  box: SightBlocker,
): boolean {
  const dx = x2 - x1
  const dy = y2 - y1

  let near = 0
  let far = 1

  // One slab per axis; a zero-length component means the ray is parallel to it,
  // in which case it either starts inside the slab or misses the box entirely.
  for (const [origin, delta, lo, hi] of [
    [x1, dx, box.left, box.right],
    [y1, dy, box.top, box.bottom],
  ] as const) {
    if (delta === 0) {
      if (origin < lo || origin > hi) return false
      continue
    }
    let t0 = (lo - origin) / delta
    let t1 = (hi - origin) / delta
    if (t0 > t1) [t0, t1] = [t1, t0]
    near = Math.max(near, t0)
    far = Math.min(far, t1)
    if (near > far) return false
  }
  return true
}

/**
 * `see_dist`: the furthest point along the line that is still clear.
 *
 * The ant's jump to the roof uses it to clamp an upward move to whatever
 * headroom it actually has (aistate 12 in lisp/ant.lsp), and compares the
 * result against the point it asked for to tell "reached the ceiling" from
 * "still climbing".
 */
export function seeDist(
  level: Level,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): { x: number; y: number } {
  const dx = x2 - x1
  const dy = y2 - y1
  const length = Math.hypot(dx, dy)
  const steps = Math.max(1, Math.ceil(length / STEP))

  let last = { x: x1, y: y1 }
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const x = x1 + dx * t
    const y = y1 + dy * t
    if (isSolidAt(level, x, y)) return last
    last = { x, y }
  }
  return { x: x2, y: y2 }
}
