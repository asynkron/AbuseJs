import { TICK_SCALE } from '../../enemies/tuning'
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

/**
 * `if (o->lvars[used_special_power]<15) o->lvars[used_special_power]++`
 * (src/cop.cpp:494) - one step per 15Hz tick, capped at 15. It is a rate, so
 * here it climbs TICK_SCALE per 60Hz tick instead of a whole step: fading in
 * took a quarter of a second rather than the original's second.
 */
const RAMP_MAX = 15

/** `draw_predator` takes over at the top of the ramp (src/cop.cpp:889). */
const PREDATOR_AT = RAMP_MAX

/** The scale `draw_transparent count 16` divides by. */
const TRANS_SCALE = 16

export class SneakyPower implements PowerEffect {
  readonly kind = 'sneaky' as const
  readonly hudImage = 'art/misc.spe#sneaky_image'
  readonly healthCap = BASE_HEALTH_CAP

  private ramp = 0

  hold(): void {
    if (this.ramp < RAMP_MAX) this.ramp = Math.min(RAMP_MAX, this.ramp + TICK_SCALE)
  }

  release(): void {
    if (this.ramp > 0) this.ramp = Math.max(0, this.ramp - TICK_SCALE)
  }

  visuals(): PowerVisuals {
    if (this.ramp === 0) return { body: { mode: 'solid' }, ghosts: [], hudImage: this.hudImage }
    if (this.ramp >= PREDATOR_AT) return { body: { mode: 'predator' }, ghosts: [], hudImage: this.hudImage }
    // `(draw_transparent count 16)`: the argument is how much of the background
    // shows through, so the sprite's own alpha is what is left of it.
    return {
      body: { mode: 'transparent', alpha: 1 - this.ramp / TRANS_SCALE },
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
