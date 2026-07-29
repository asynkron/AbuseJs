import { BASE_HEALTH_CAP } from '../healing'
import type { PowerEffect, PowerVisuals } from '../types'

/**
 * SNEAKY - lisp/people.lsp `do_special_power` / `undo_special_power`
 * (SNEAKY_POWER) and `sneaky_draw`.
 *
 * `used_special_power` is a counter here rather than a flag: it climbs one per
 * tick while the button is held and falls one per tick while it is not, so the
 * cop takes just over a quarter of a second to fade out and the same to come
 * back. At the top of the ramp he stops being transparent and becomes the
 * Predator-style refraction instead.
 *
 * Nothing in the lisp tells enemies to ignore a sneaking player - the blinding
 * is in the C++ - so `concealment` is a hook of our own for the sight checks,
 * defined as the same ramp the drawing uses.
 */

/** `(if (<= used_special_power 15) ...)` - the ramp tops out at 16. */
const RAMP_MAX = 16

/** `(if (> count 15) (draw_predator) ...)` - only the very top is the refraction. */
const PREDATOR_AT = RAMP_MAX

export class SneakyPower implements PowerEffect {
  readonly kind = 'sneaky' as const
  readonly hudImage = 'art/misc.spe#sneaky_image'
  readonly healthCap = BASE_HEALTH_CAP

  private ramp = 0

  hold(): void {
    if (this.ramp < RAMP_MAX) this.ramp++
  }

  release(): void {
    if (this.ramp > 0) this.ramp--
  }

  visuals(): PowerVisuals {
    if (this.ramp === 0) return { body: { mode: 'solid' }, ghosts: [], hudImage: this.hudImage }
    if (this.ramp >= PREDATOR_AT) return { body: { mode: 'predator' }, ghosts: [], hudImage: this.hudImage }
    // `(draw_transparent count 16)`: the argument is how much of the background
    // shows through, so the sprite's own alpha is what is left of it.
    return {
      body: { mode: 'transparent', alpha: 1 - this.ramp / RAMP_MAX },
      ghosts: [],
      hudImage: this.hudImage,
    }
  }

  /**
   * 0 while fully visible, 1 once the fade is complete.
   *
   * Invented, since the original's AI blinding is not in the scripts. Tying it
   * to the same ramp means a half-faded cop is half as noticeable, which at
   * least makes the fade mean something rather than being decoration around a
   * boolean.
   */
  concealment(): number {
    return this.ramp / RAMP_MAX
  }
}
