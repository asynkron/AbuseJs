import type { BlastSource, Hurtable } from './types'

/**
 * `(hurt_radius x y radius amount from max_push)`, out of the engine rather
 * than the scripts - `level::hurt_radius`, src/level.cpp:3011.
 *
 * It catches every hurtable object in range including the player, which is what
 * makes standing next to your own grenade a mistake and what drives the
 * hidden-wall chain reaction - one wall does 60 over 50px and its neighbours
 * only have 25hp (lisp/doors.lsp).
 *
 * The distance is not Euclidean. The engine measures an octagonal
 * approximation, `cx + cy - min(cx, cy) / 2`, to *both* the object's feet and
 * the top of its picture and keeps whichever is nearer, so a tall thing is
 * caught by a blast level with either end of it. Damage then falls off
 * linearly, `(r - d) * m / r`. Measuring to the mid-height in a straight line,
 * as this used to, cost tall targets - the player above all - a good deal of
 * blast damage they take in the original.
 *
 * The knockback is per-axis rather than along the line to the centre:
 * `px = (r - cx) * max_push / r` and `py = (r - cy1) * max_push / r`, each
 * signed by which side of the centre the object is on, and the y term measured
 * to the feet whichever end the damage came from.
 */
export function hurtRadius(
  targets: Iterable<Hurtable>,
  x: number,
  y: number,
  radius: number,
  amount: number,
  from: BlastSource | null,
  maxPush: number,
): void {
  // `if (r<1) return` - the engine's own guard against dividing by zero.
  if (radius < 1) return

  for (const target of targets) {
    const feetY = target.y
    const headY = target.y - target.height

    const cx = Math.abs(target.x - x)
    const cyFeet = Math.abs(feetY - y)
    const cyHead = Math.abs(headY - y)

    const distance = Math.min(octagonal(cx, cyFeet), octagonal(cx, cyHead))
    if (distance >= radius) continue

    const damage = Math.round(((radius - distance) * amount) / radius)
    if (damage <= 0) continue

    let pushX = ((radius - cx) * maxPush) / radius
    let pushY = ((radius - cyFeet) * maxPush) / radius
    if (target.x < x) pushX = -pushX
    if (feetY < y) pushY = -pushY

    target.hurt(damage, from, pushX, pushY)
  }
}

/**
 * The engine's octagonal distance: the L1 distance less half the smaller leg,
 * halved with an integer shift.
 */
function octagonal(cx: number, cy: number): number {
  return cx + cy - (Math.trunc(Math.min(cx, cy)) >> 1)
}
