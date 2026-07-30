import { BASE_HEALTH_CAP } from '../healing'
import type { PowerEffect, PowerHost, PowerInput } from '../types'

/**
 * FLY - lisp/people.lsp `do_special_power` (FLY_POWER) and lisp/powerup.lsp
 * `fly_power_ai`.
 *
 * Gravity stays on. What the button does is push a fixed impulse into the
 * vertical velocity every tick, so holding it climbs, letting go falls, and
 * the balance between thrust and gravity is the hover. The first tick of a
 * hover also halves whatever downward speed had built up, which is what stops
 * a long fall from taking a second to arrest.
 *
 * Up presses harder. Down does nothing at all - there is no `ym > 0` branch,
 * so the README's "up and down steer" was our invention and is dropped here.
 */

/** `(set_yvel (- (yvel) 2))` every tick held. */
const THRUST = 2

/** `(if (< ym 0) (set_yvel (- (yvel) 1)))` - one more while up is held. */
const UP_THRUST = 1

/** `(if (> (yvel) 0) (set_yvel (/ (yvel) 2)))` - falling speed halved on contact with the button. */
const FALL_DAMPING = 2

/** Exhaust puff offset: `(+ (+ (x) (* (direction) -10)) (random 5))`, so it trails behind. */
const CLOUD_BEHIND = 10
/** The `(random 5)` jitter on both axes. */
const CLOUD_JITTER = 5

/** The leg state FLY forces every tick, whatever the mover had picked. */
const FLY_STATE = 'run_jump'

export type Random = () => number

export class FlyPower implements PowerEffect {
  readonly kind = 'fly' as const
  readonly hudImage = 'art/misc.spe#fly_image'
  readonly healthCap = BASE_HEALTH_CAP
  readonly legPrefix = 'fly_'

  constructor(private readonly random: Random = Math.random) {}

  hold(host: PowerHost, input: PowerInput): void {
    // CLOUD is one of the characters `def_explo` builds in lisp/explo.lsp,
    // which the converter cannot expand, so it is absent from chars.json and
    // the host has nothing to spawn yet. The puff is cosmetic; the thrust is
    // not, so the power still flies without it.
    host.spawnCloud?.(
      host.x + host.facing * -CLOUD_BEHIND + this.below(CLOUD_JITTER),
      host.y + this.below(CLOUD_JITTER),
    )

    // `the_game->play_sound(S_FLY_SND, 32, ...)` every tick FLY is held.
    host.playSound?.('FLY_SND')

    host.setLegState(FLY_STATE)
    // The original also clears yacel and re-asserts gravity 1 here; this engine
    // has no acceleration field and never turns gravity off, so both are moot.
    if (host.vy > 0) host.vy /= FALL_DAMPING
    host.vy -= THRUST
    if (input.ym < 0) host.vy -= UP_THRUST
  }

  /** `(random n)` - a whole number below n. */
  private below(n: number): number {
    return Math.floor(this.random() * n)
  }
}
