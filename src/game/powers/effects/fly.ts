import { SIM_TICKS_PER_TICK } from '../../effects/clock'
import { playerAccel } from '../../enemies/tuning'
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

/**
 * `(set_yvel (- (yvel) 2))` every tick held.
 *
 * A change in velocity per tick is an acceleration, so it converts like
 * gravity does rather than like a speed - and it has to, because what flying
 * feels like is the balance between the two. Left raw it was 2 against
 * gravity's `playerAccel(1)` of 0.44, a net climb 3.5x what the original
 * builds, which is a cop who leaves the level through the ceiling.
 */
const THRUST = playerAccel(2)

/** `(if (< ym 0) (set_yvel (- (yvel) 1)))` - one more while up is held. */
const UP_THRUST = playerAccel(1)

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

  /** Counts sim ticks down to the engine tick the CLOUD is spawned on. */
  private puffCarry = 0

  constructor(private readonly random: Random = Math.random) {}

  hold(host: PowerHost, input: PowerInput): void {
    // `(add_object CLOUD ...)` once per *engine* tick. Ours runs four times as
    // often, and four times the smoke buries the cop in it.
    this.puffCarry -= 1
    if (this.puffCarry <= 0) {
      this.puffCarry = SIM_TICKS_PER_TICK
      host.spawnCloud?.(
        host.x + host.facing * -CLOUD_BEHIND + this.below(CLOUD_JITTER),
        host.y + this.below(CLOUD_JITTER),
      )
    }

    // The flame, every sim tick, because that is the clock the motes run on.
    host.spawnFlyFlame?.(host.x, host.y, host.facing)

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
