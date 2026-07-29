import { DEFAULT_DIFFICULTY, scaleHeal, type Difficulty } from './difficulty'

/**
 * `give_player_health` from lisp/people.lsp, which is the only way health ever
 * goes up in the original and the reason HEALTH_POWER lives in this directory
 * at all: the power's entire effect is the ceiling this function tops out at.
 */

/** Ceiling without a power - `start_hp` on DARNEL, and the 100 in `give_player_health`. */
export const BASE_HEALTH_CAP = 100

/** Ceiling while HEALTH_POWER is held - `(h_max (if (eq special_power HEALTH_POWER) 200 100))`. */
export const HEALTH_POWER_CAP = 200

/** The heart pickup's raw grant - `(give_player_health 20)` in lisp/powerup.lsp `hp_up`. */
export const HEART_HEAL = 20

/** POWER_HEALTH's own top-up, granted after the cap is already raised - lisp/powerup.lsp `health_power_ai`. */
export const POWER_HEALTH_GRANT = 100

export interface HealTarget {
  /** Current hit points. Written in place, as `add_hp` does. */
  hp: number
}

export interface HealOptions {
  readonly difficulty?: Difficulty
  /** Ceiling to heal towards; ask `Powers.healthCap` for it. */
  readonly cap?: number
}

export interface HealResult {
  /** Points actually added, after difficulty scaling and the cap. */
  readonly healed: number
  /**
   * How far to push the screen's blue tint: `(setq b_ramp (+ b_ramp (* h_amount 2)))`.
   * Note the original ramps by the scaled amount, not the amount added, so a
   * heal that only half fits still flashes at full strength.
   */
  readonly blueRamp: number
}

/**
 * Heals, or refuses.
 *
 * Refusing matters as much as healing: `hp_up` is `(and (touching_bg)
 * (give_player_health 20))`, so a player at full health walks over a heart and
 * leaves it lying there for later. Returning null is what makes that work.
 */
export function givePlayerHealth(
  target: HealTarget,
  amount: number,
  options: HealOptions = {},
): HealResult | null {
  const cap = options.cap ?? BASE_HEALTH_CAP
  const scaled = scaleHeal(amount, options.difficulty ?? DEFAULT_DIFFICULTY)

  // The original tests `(eq (hp) h_max)` exactly. Testing `>=` instead covers
  // the case it does not survive: drop HEALTH_POWER at 180 health and the cap
  // falls back to 100, at which point `add_hp (- h_max (hp))` would add -80.
  if (target.hp >= cap) return null

  const healed = Math.min(scaled, cap - target.hp)
  target.hp += healed
  return { healed, blueRamp: scaled * 2 }
}
