import type { BlastSource, Hurtable } from './types'

/**
 * `(hurt_radius x y radius amount from max_push)`.
 *
 * This one is a C++ engine call rather than lisp, so the shipped scripts only
 * tell us the shape of it: a centre, a radius, a maximum damage, whoever to
 * credit, and a cap on the knockback. It catches every hurtable object in
 * range including the player, which is what makes standing next to your own
 * grenade a mistake and what drives the hidden-wall chain reaction - one wall
 * does 60 over 50px and its neighbours only have 25hp (lisp/doors.lsp).
 *
 * Assumption, flagged as such: damage falls off linearly to nothing at the
 * radius and is measured to the object's mid-height. The call sites imply a
 * falloff - a 110px blast doing a flat 120 would clear a screen - but the
 * curve itself is not recoverable from the data.
 *
 * Invented: the knockback is the same linear falloff applied to `max_push`,
 * directed away from the centre. The original caps it at `max_push` and
 * nothing else about it is knowable.
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
  for (const target of targets) {
    const dx = target.x - x
    const dy = target.y - target.height / 2 - y
    const distance = Math.hypot(dx, dy)
    if (distance >= radius) continue

    const falloff = 1 - distance / radius
    const damage = Math.round(amount * falloff)
    if (damage <= 0) continue

    const push = maxPush * falloff
    // A blast going off inside someone has no direction to throw them in.
    // Invented: send them straight up, which is what a grenade under the feet
    // looks like it ought to do.
    const scale = distance > 0 ? push / distance : 0
    const pushX = dx * scale
    const pushY = distance > 0 ? dy * scale : -push

    target.hurt(damage, from, pushX, pushY)
  }
}
