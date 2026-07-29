import { Behaviour } from './behaviour'
import type { LogicWorld } from './behaviour'
import type { LogicObject } from './object'

/**
 * SPRING - lisp/general.lsp `spring_ai`. The up-arrow pads that throw the cop
 * out of a pit he cannot jump out of.
 *
 * The shove is added to whatever the player is already doing rather than
 * replacing it, so landing on one hard costs you height. `spring_cons` sets
 * yvel -15; the levels overwrite it through the `spring_yvel` field, and
 * level02's pair by the exit shaft save -50 each.
 */

const SPRING_VOLUME = 127

/** `spring_cons`, and the fallback for a level that saved 0. */
const DEFAULT_YVEL = -15

export class Spring extends Behaviour {
  /** `yvel` - the shove, in the original's units per engine tick. */
  private readonly strength: number

  constructor(self: LogicObject, world: LogicWorld) {
    super(self, world)
    this.strength = self.data.yvel || DEFAULT_YVEL
  }

  protected run(): void {
    if (!this.signals.isActivated(this.self.index)) return

    // aistate 1 is the four-frame flash. It is also the cooldown: the pad
    // cannot fire again until the animation has run out.
    if (this.self.aistate !== 0) {
      if (this.self.nextPicture()) return
      this.self.setAiState(0)
      this.self.setState('stopped')
      return
    }

    const focus = this.focus
    if (!focus || !this.host.touching(this.self.index, focus)) return

    this.host.playSound('SPRING_SOUND', SPRING_VOLUME, this.self.x, this.self.y)
    // The original follows the shove with `set_gravity 1`, which this port has
    // no equivalent for - the cop falls under gravity at all times, FLY
    // included - and the jump frame follows from being airborne with a rising
    // vy, so the boost is the whole of it.
    focus.boost(this.strength)
    this.self.setState('running')
    this.self.setAiState(1)
  }
}
