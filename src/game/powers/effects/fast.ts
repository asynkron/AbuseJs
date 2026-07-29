import { BASE_HEALTH_CAP } from '../healing'
import { drawsTorso } from '../legStates'
import { PLAIN_VISUALS, type Ghost, type PowerEffect, type PowerHost, type PowerInput, type PowerVisuals } from '../types'

/**
 * FAST - lisp/people.lsp `do_special_power` / `undo_special_power` (FAST_POWER)
 * and `draw_fast`.
 *
 * The trick is that it is not a speed multiplier: while the button is down the
 * cop runs a complete second movement step before the tick's own, so
 * everything - acceleration, top speed, collision, animation - happens twice.
 * Separately it burns an extra tick off the weapon cooldown, which halves the
 * fire rate of every weapon rather than any one of them.
 *
 * There is no charge and no expiry. `fast_ai` in lisp/powerup.lsp has
 * `(user_fun SET_FAST_TIME 360)` sitting next to the pickup, commented out, so
 * the shipped game hands you FAST until you die.
 */

/** Extra ticks knocked off `fire_delay1` per tick held - `do_special_power`. */
const COOLDOWN_BURN = 1

/**
 * A fresh jump made while FAST is held gets `yvel += yvel / 3` - and yvel is
 * negative going up, so it rises a third higher.
 */
const JUMP_BOOST_DIVISOR = 3

/**
 * Transparency of the two trailing ghosts, out of 16 - `(draw_transparent 5 16)`
 * at the newer position and `(draw_transparent 10 16)` at the older one. The
 * argument is how much of the background shows through, which is why the older
 * ghost carries the larger number.
 */
const GHOST_TRANSPARENCY = { newer: 5 / 16, older: 10 / 16 }

/** Torso pin: `y = legs.y + 29 - legs.picture_height` - lisp/people.lsp `draw_fast`. */
const TORSO_BASELINE = 29

interface Point {
  x: number
  y: number
}

export class FastPower implements PowerEffect {
  readonly kind = 'fast' as const
  readonly hudImage = 'art/misc.spe#fast_image'
  readonly healthCap = BASE_HEALTH_CAP
  readonly legPrefix = 'fast_'

  /** `used_special_power`, which FAST treats as a plain flag. */
  private running = false
  /** `last1_x/last1_y` - where the cop stood before the extra step. */
  private older: Point = { x: 0, y: 0 }
  /** `last2_x/last2_y` - where he stood after it. */
  private newer: Point = { x: 0, y: 0 }

  hold(host: PowerHost, input: PowerInput): void {
    this.running = true
    this.older = { x: host.x, y: host.y }
    host.coolWeapon?.(COOLDOWN_BURN)

    // Captured before the extra step, because that is the step that starts the
    // jump: the boost only applies on the tick the cop leaves the ground.
    const restingVy = host.vy
    const step = (): void => host.step(input)
    if (host.withClimbPreserved) host.withClimbPreserved(step)
    else step()

    if (input.ym < 0 && restingVy === 0 && host.vy < 0) {
      host.vy += host.vy / JUMP_BOOST_DIVISOR
    }

    this.newer = { x: host.x, y: host.y }
  }

  release(): void {
    this.running = false
  }

  visuals(host: PowerHost): PowerVisuals {
    if (!this.running) return { ...PLAIN_VISUALS, hudImage: this.hudImage }

    // Blit order is the original's: newer ghost first, older over it.
    const ghosts: Ghost[] = [
      this.ghost(this.newer, GHOST_TRANSPARENCY.newer, host),
      this.ghost(this.older, GHOST_TRANSPARENCY.older, host),
    ]
    return { body: { mode: 'solid' }, ghosts, hudImage: this.hudImage }
  }

  private ghost(at: Point, transparency: number, host: PowerHost): Ghost {
    // `draw_fast` pins the ghost torso with the same offset as the live one but
    // without top_draw's 2px nudge, so the trail sits square behind the legs.
    const torso = drawsTorso(host.legState)
      ? { x: at.x, y: at.y + TORSO_BASELINE - host.legHeight }
      : null
    return { x: at.x, y: at.y, alpha: 1 - transparency, torso }
  }
}
