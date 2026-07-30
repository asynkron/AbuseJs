import type { Level } from '../Level'

/**
 * Line of sight against the tile grid.
 *
 * `can_see` and `see_dist` are engine calls in Abuse and are the backbone of
 * every creature here: the ant tests them twice before every shot, walks the
 * ceiling by them, and the jugger and the cleaner robot use them as ground and
 * look-ahead probes. collision.ts has boxes but no ray, so this is that ray.
 *
 * Neither call in the original considers objects when the last argument is
 * nil, and every call site in ant.lsp, flyer.lsp and jugger.lsp passes nil -
 * so this is geometry only.
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

/** `can_see`: nothing solid between the two points. */
export function canSee(level: Level, x1: number, y1: number, x2: number, y2: number): boolean {
  const dx = x2 - x1
  const dy = y2 - y1
  const length = Math.hypot(dx, dy)
  const steps = Math.max(1, Math.ceil(length / STEP))

  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    if (isSolidAt(level, x1 + dx * t, y1 + dy * t)) return false
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
