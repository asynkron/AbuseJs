import { HEALTH_POWER_CAP } from '../healing'
import type { PowerEffect } from '../types'

/**
 * HEALTH - lisp/people.lsp `give_player_health` and lisp/powerup.lsp
 * `health_power_ai`.
 *
 * The odd one out: the special button does nothing while it is held, because
 * there is no HEALTH_POWER branch in either `do_special_power` or
 * `undo_special_power`. The whole power is the raised ceiling, which every
 * subsequent heart then fills towards. Picking it up sets the power first and
 * only then calls `(give_player_health 100)`, so that top-up is already
 * measured against 200.
 *
 * This replaces our invented "one point every eight ticks while held" - the
 * original does not regenerate.
 */
export class HealthPower implements PowerEffect {
  readonly kind = 'health' as const
  readonly hudImage = 'art/misc.spe#b_check_image'
  readonly healthCap = HEALTH_POWER_CAP
}
