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

/**
 * OBJ_MOVER - `mover_ai` (lisp/common.lsp:59-82, compiled into C but kept in
 * the script as the readable copy).
 *
 * A waypoint on a conveyor for whole objects. Link 0 is the next waypoint and
 * link 1, when there is one, is the cargo. Each tick the countdown in `aistate`
 * drops by one and the cargo is placed along the straight line from this
 * waypoint to the next, at `aistate / frames` of the way back from the far end;
 * when the count runs out the cargo is handed to link 0, which restarts its own
 * countdown and takes over. A pair of movers pointing at each other therefore
 * walks its cargo back and forth forever, which is what the floating CONC_AIR
 * mines ride - they have no movement of their own at all, `air_mine_ai` only
 * animates them and waits to be touched.
 *
 * There are 445 of these across the shipped levels and none of them did
 * anything, so every mine, and everything else mounted on a mover chain, simply
 * hung in the air.
 */

/** `mover_cons`: `(set_aitype 20)` when the level saved no frame count. */
const MOVER_DEFAULT_FRAMES = 20

/** `(if (< (aistate) 2) ...)` - the count at which the cargo is handed over. */
const MOVER_HANDOFF = 2

export class Mover extends Behaviour {
  /** `aitype` - how many ticks the trip takes, in our ticks rather than the engine's. */
  private readonly frames: number
  /** The last point this mover put its cargo, for `platform_push`'s delta. */
  private placed: { x: number; y: number } | null = null

  constructor(self: LogicObject, world: LogicWorld) {
    super(self, world)
    this.frames = Mover.framesOf(self.data)

    // The level saves the countdown in engine ticks, so a mover that starts
    // part-way along its run has to be restated in ours or it would jump.
    const saved = self.data.aistate
    if (saved > 0) self.setAiState(Math.round(saved / TICK_SCALE))
  }

  /** `(aitype)`, stretched - also needed for the *next* mover on handoff. */
  private static framesOf(data: { aitype: number }): number {
    return Math.max(1, Math.round((data.aitype || MOVER_DEFAULT_FRAMES) / TICK_SCALE))
  }

  protected run(): void {
    // `(if (eq (total_objects) 2) ... nil)` - a waypoint with nothing to carry
    // is inert until a neighbour hands it something.
    const links = this.signals.linksOf(this.self.index)
    if (links.length !== 2) {
      this.placed = null
      return
    }

    const [dest, cargo] = links
    const target = this.world.positionOf(dest)
    if (!target) return

    if (this.self.aistate < MOVER_HANDOFF) {
      // `(with_object dest (progn (link_object mover) (set_aistate (aitype))))`
      // then `(remove_object mover)`: the next waypoint picks the cargo up and
      // starts its own clock, and this one lets go.
      const onwards = this.world.dataOf(dest)
      this.signals.link(dest, cargo)
      this.signals.setState(dest, onwards ? Mover.framesOf(onwards) : this.frames)
      this.signals.unlink(this.self.index, cargo)
      this.placed = null
      return
    }

    this.self.setAiState(this.self.aistate - 1)

    // `(- dest.x (/ (* (- dest.x self.x) aistate) aitype))`: the full count
    // leaves the cargo on this waypoint, zero would leave it on the next.
    const t = this.self.aistate / this.frames
    const x = target.x - (target.x - this.self.x) * t
    const y = target.y - (target.y - this.self.y) * t

    // `platform_push` before the move, so anything standing on the cargo goes
    // with it. The delta is measured against where this mover put the cargo
    // last tick rather than read back from it, since a mover owns its cargo
    // outright while it holds it.
    const from = this.placed ?? this.world.positionOf(cargo)
    if (from) this.host.carryRiders(cargo, x - from.x, y - from.y)

    this.world.moveObject(cargo, x, y)
    this.placed = { x, y }
  }
}
