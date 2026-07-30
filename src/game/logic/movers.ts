import { Behaviour } from './behaviour'
import type { LogicWorld } from './behaviour'
import type { LogicObject } from './object'
import { speed, TICK_SCALE } from '../enemies/tuning'

/**
 * The three objects that move other things about: PUSHER, SWITCH_MOVER and
 * DEATH_RESPAWNER.
 *
 * All three are `dev_draw` or near enough - you are not meant to see them, only
 * what they do - and all three were missing entirely, which is why 563
 * SWITCH_MOVERs never delivered anything and every PUSHER was scenery.
 */

/** `pusher_cons`: `(set_aistate 4)`, and `aistate` doubles as the push speed. */
const PUSHER_DEFAULT_SPEED = 4

/** `(set_fade_count 15)` on whatever a SWITCH_MOVER brings in. */
const MOVER_FADE = 15

/**
 * PUSHER - `pusher_ai` (lisp/general.lsp:5-14).
 *
 * While it is on and the player is touching it, it shoves them sideways by its
 * own `aistate` every tick, in the direction it faces. `try_move`, so a wall
 * still stops them - it is a conveyor, not a teleport.
 */
export class Pusher extends Behaviour {
  private readonly pushSpeed: number

  constructor(self: LogicObject, world: LogicWorld) {
    super(self, world)
    // The field is `("aistate" pusher_speed)`, so the level's saved aistate is
    // the speed. It is a velocity per engine tick like any other.
    this.pushSpeed = speed(self.data.aistate || PUSHER_DEFAULT_SPEED)
  }

  protected run(): void {
    if (!this.signals.isActivated(this.self.index)) return

    this.self.nextPicture()

    const focus = this.focus
    if (!focus) return
    if (!this.host.touching(this.self.index, focus)) return

    focus.tryMove(this.self.direction > 0 ? this.pushSpeed : -this.pushSpeed, 0)
  }
}

/**
 * SWITCH_MOVER - `switch_mover_ai` (lisp/switch.lsp:98-127).
 *
 * Link 0 is the trigger and link 1 is the thing it brings in. When the trigger
 * goes on, link 1 is moved to the mover's own position and faded up from
 * `fade_count 15`, and then the mover is done with.
 *
 * `xvel` picks which of two jobs it does. Zero means the one-shot above; any
 * other value means it never finishes - it drags link 1 onto itself every
 * single tick, which is how a level pins something to a moving mount.
 */
export class SwitchMover extends Behaviour {
  private fade = 0

  protected run(): void {
    const links = this.signals.linksOf(this.self.index)
    // `(if (> (total_objects) 1) ... nil)` - it needs both a trigger and a
    // subject, and returns nil (removing itself) without them.
    if (links.length < 2) return

    const [trigger, subject] = links

    if (this.self.aistate === 0) {
      if (!this.signals.isOn(trigger)) return

      this.world.moveObject(subject, this.self.x, this.self.y)

      if (this.self.data.xvel !== 0) return // the pinning job never advances

      this.fade = MOVER_FADE
      this.world.fadeObject(subject, this.fade)
      this.self.setAiState(1)
      return
    }

    // Counting the fade back down to zero, at the engine's rate.
    this.fadeCarry += TICK_SCALE
    if (this.fadeCarry < 1) return
    this.fadeCarry -= 1

    if (this.fade <= 0) return
    this.fade--
    this.world.fadeObject(subject, this.fade)
  }

  private fadeCarry = 0
}

/**
 * DEATH_RESPAWNER - `death_re_ai` (lisp/switch.lsp:266-274).
 *
 * Link 0 names the character to make; links 1 and up are the creatures it
 * watches. `dead_object` walks them from the last backwards, and the first one
 * it finds dead is unlinked and replaced by a fresh copy of link 0's type at
 * the dead one's position - so an encounter keeps refilling instead of running
 * dry.
 */
export class DeathRespawner extends Behaviour {
  protected run(): void {
    const links = this.signals.linksOf(this.self.index)
    if (links.length < 2) return

    // Backwards, and only the first corpse found per tick, exactly as the
    // recursion does.
    for (let i = links.length - 1; i >= 1; i--) {
      const watched = links[i]
      if (!this.host.isDefeated(watched)) continue

      const where = this.world.positionOf(watched)
      this.signals.unlink(this.self.index, watched)
      if (where) this.world.spawnLike(links[0], where.x, where.y)
      return
    }
  }
}
