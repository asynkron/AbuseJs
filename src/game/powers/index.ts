/**
 * The cop's four special powers, as composable per-tick effects.
 *
 * Read `Powers.ts` first: it is the only thing the rest of the game needs to
 * hold. The effects in `effects/` are one file each and know nothing about the
 * player class, the level or Pixi - they are handed a `PowerHost` and either
 * push velocity into it, take an extra movement step with it, or describe how
 * it should be drawn.
 *
 * Everything here follows lisp/people.lsp and lisp/powerup.lsp. Two of the
 * original's findings are worth knowing before reading the code, because both
 * contradict what this port did before:
 *
 * - Powers never expire. `special_power` is cleared by `restart_player` and by
 *   nothing else, so a power lasts until you die.
 * - HEALTH does not regenerate. It raises the health ceiling from 100 to 200
 *   and grants one top-up on pickup; that is the entire power.
 */

export { Powers, type PowersOptions } from './Powers'
export {
  DEFAULT_DIFFICULTY,
  scaleDamage,
  scaleHeal,
  type Difficulty,
} from './difficulty'
export {
  BASE_HEALTH_CAP,
  HEALTH_POWER_CAP,
  HEART_HEAL,
  POWER_HEALTH_GRANT,
  givePlayerHealth,
  type HealOptions,
  type HealResult,
  type HealTarget,
} from './healing'
export { drawsTorso, legStateFor } from './legStates'
export { POWER_PICKUPS, powerPickup, type PowerPickup } from './pickups'
export {
  PLAIN_VISUALS,
  axis,
  type Axis,
  type BodyDraw,
  type Facing,
  type Ghost,
  type PowerEffect,
  type PowerHost,
  type PowerInput,
  type PowerKind,
  type PowerVisuals,
} from './types'
export { createPowerEffect, type Random } from './effects'
