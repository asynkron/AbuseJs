import { POWER_HEALTH_GRANT } from './healing'
import type { PowerKind } from './types'

/**
 * The four POWER_* objects the levels scatter - lisp/powerup.lsp.
 *
 * All four have the same shape: a single-frame sprite from `art/misc.spe` with
 * an activation box of 20x20, whose entire AI is "if the player is touching me,
 * set `special_power` and delete myself". None of them plays a sound. Only two
 * do anything beyond setting the variable, and both of those are here as data
 * rather than as a branch at the call site.
 */
export interface PowerPickup {
  readonly kind: PowerKind
  /**
   * Colour to flood the whole viewport with on pickup, or null.
   * `fast_ai` alone calls `(make_view_solid (find_rgb 255 255 255))`.
   */
  readonly flash: number | null
  /**
   * Health handed over after the power is set - `health_power_ai` calls
   * `(give_player_health 100)` second, so the grant is measured against the
   * 200 ceiling the power has just raised. Scaled by difficulty like any heal,
   * which on the default hard makes it 50.
   */
  readonly grant: number
}

export const POWER_PICKUPS: Readonly<Record<string, PowerPickup>> = {
  POWER_FAST: { kind: 'fast', flash: 0xffffff, grant: 0 },
  POWER_FLY: { kind: 'fly', flash: null, grant: 0 },
  POWER_SNEAKY: { kind: 'sneaky', flash: null, grant: 0 },
  POWER_HEALTH: { kind: 'health', flash: null, grant: POWER_HEALTH_GRANT },
}

/** Resolves a level object's type name; null for anything that is not a power. */
export function powerPickup(type: string): PowerPickup | null {
  return POWER_PICKUPS[type] ?? null
}
