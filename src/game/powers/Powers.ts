import { createPowerEffect, type Random } from './effects'
import { BASE_HEALTH_CAP } from './healing'
import { legStateFor } from './legStates'
import {
  PLAIN_VISUALS,
  type PowerEffect,
  type PowerHost,
  type PowerInput,
  type PowerKind,
  type PowerVisuals,
} from './types'

/**
 * The cop's special-power slot: at most one power, held indefinitely, spent by
 * holding a button.
 *
 * `cop_mover` in lisp/people.lsp runs this before the movement step -
 * `(if (equal (bit-and but 1) 1) (do_special_power ...) (undo_special_power ...))`
 * and only then `(player_move xm ym but)`. The order is what makes FAST work
 * at all, since FAST's whole implementation is an extra movement step taken
 * before the tick's own.
 *
 * Lifetime is the surprise: `special_power` is set on pickup, overwritten by
 * the next pickup, and cleared only by `restart_player`, i.e. by dying. There
 * is no timer. The one duration in either file - `(user_fun SET_FAST_TIME 360)`
 * in lisp/powerup.lsp - is commented out in the shipped scripts, so our
 * 360-tick charge was restoring a line the game never ran.
 */
export interface PowersOptions {
  /** Injected so a replay or a test can drive FLY's exhaust jitter. */
  readonly random?: Random
  /** Asset-side `hasState`, for falling back when a `fast_`/`fly_` variant is missing. */
  readonly hasLegState?: (state: string) => boolean
}

export class Powers {
  private effect: PowerEffect | null = null
  private holding = false

  constructor(
    private readonly host: PowerHost,
    private readonly options: PowersOptions = {},
  ) {}

  /** Which power is in hand, or null. */
  get kind(): PowerKind | null {
    return this.effect?.kind ?? null
  }

  /** True on ticks the special button is down with a power to spend. */
  get active(): boolean {
    return this.holding && this.effect !== null
  }

  /** The ceiling `givePlayerHealth` should heal towards - 200 under HEALTH. */
  get healthCap(): number {
    return this.effect?.healthCap ?? BASE_HEALTH_CAP
  }

  /**
   * How hidden the cop is, 0..1. Only SNEAKY moves it off zero; enemy sight
   * checks are the intended reader.
   */
  get concealment(): number {
    return this.effect?.concealment?.() ?? 0
  }

  /** How the cop and his HUD corner should be painted this tick. */
  get visuals(): PowerVisuals {
    const effect = this.effect
    if (!effect) return PLAIN_VISUALS
    return effect.visuals?.(this.host) ?? { ...PLAIN_VISUALS, hudImage: effect.hudImage }
  }

  /**
   * Takes a power on, discarding whatever was held. Only one at a time and the
   * newest wins - every POWER_* pickup simply assigns `special_power`.
   */
  give(kind: PowerKind): void {
    this.effect = createPowerEffect(kind, this.options.random)
    this.holding = false
  }

  /**
   * Drops the power. `restart_player` does this on death, along with clearing
   * the compass and the screen tint, and nothing else in the scripts does it
   * at all.
   */
  clear(): void {
    this.effect = null
    this.holding = false
  }

  /**
   * Runs the power for one tick. Call this before the movement step and only
   * while the cop is alive - `cop_mover`'s death branch returns before it ever
   * reaches `do_special_power`, so a corpse cannot fly.
   */
  update(input: PowerInput): void {
    const effect = this.effect
    if (!effect) {
      this.holding = false
      return
    }

    this.holding = input.special
    if (input.special) effect.hold?.(this.host, input)
    else effect.release?.()
  }

  /**
   * Picks the leg animation for a base state, swapping in the `fast_` or
   * `fly_` set while the power is running. Held but not pressed keeps the
   * plain legs, which is how the powered sets read as the power being used.
   */
  legState(base: string): string {
    if (!this.active) return base
    return legStateFor(base, this.effect?.legPrefix, this.options.hasLegState)
  }
}
