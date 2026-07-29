import { Behaviour, distanceX, distanceY } from './behaviour'
import type { LogicWorld } from './behaviour'
import type { LogicObject } from './object'

/**
 * Signal-driven doors - lisp/doors.lsp `general_sdoor_ai`, shared by
 * SWITCH_DOOR (`sdoor_ai`, push on) and the two trap doors
 * (lisp/duong.lsp `strap_door_ai`, push off).
 */

/** SWISH is the one sound in this subsystem that is not played at 127. */
const SWISH_VOLUME = 70

/**
 * The door's four phases. The original numbers them 0..3 in `aistate`, which
 * is what the level saves and what anything reading the door sees.
 *
 * The sprite states read backwards from their names: `stopped` is the closed
 * frame (door0006, tdor0001) and `blocking` is the fully open one (door0001,
 * tdor0007); `running` opens and `walking` closes.
 */
type DoorPhase = 'closed' | 'opening' | 'open' | 'closing'

const DOOR_AISTATE: Record<DoorPhase, number> = { closed: 0, opening: 1, open: 2, closing: 3 }
const DOOR_PHASE: Record<number, DoorPhase> = { 0: 'closed', 1: 'opening', 2: 'open', 3: 'closing' }

export class SlidingDoor extends Behaviour {
  constructor(
    self: LogicObject,
    world: LogicWorld,
    /**
     * SWITCH_DOOR shoves an overlapping player sideways out of the doorway
     * every tick it is closed; the trap doors pass nil for this and never
     * touch the player.
     */
    private readonly pushesPlayer: boolean,
  ) {
    super(self, world)
  }

  /**
   * Doors block until they are all the way open.
   *
   * The original leaves this to `can_block` and the frame's own shape, which
   * cannot be reproduced here: all six SWITCH_DOOR frames are 24x60 and the
   * shutter retracts into transparent pixels, so a box test cannot tell open
   * from closed. The phase can.
   */
  override get solid(): boolean {
    return DOOR_PHASE[this.self.aistate] !== 'open'
  }

  protected run(): void {
    // Every arm of the original sits inside `(if (> (total_objects) 0) ...)`,
    // so a door with no links does nothing at all - it does not even push.
    const driver = this.signals.driverOf(this.self.index)
    if (driver === undefined) return
    const wantsOpen = this.signals.isOn(driver)

    switch (DOOR_PHASE[this.self.aistate]) {
      case 'closed':
        if (wantsOpen) {
          this.self.setState('running')
          this.host.playSound('SWISH', SWISH_VOLUME, this.self.x, this.self.y)
          this.goState(DOOR_AISTATE.opening)
          return
        }
        this.self.setState('stopped')
        if (this.pushesPlayer) this.pushPlayerClear()
        return

      case 'opening':
        if (this.self.nextPicture()) return
        this.self.setState('blocking')
        // set_aistate, not go_state: re-entering here would start closing on
        // the same tick if the driver had already dropped.
        this.self.setAiState(DOOR_AISTATE.open)
        return

      case 'open':
        if (wantsOpen) return
        this.self.setState('walking')
        this.host.playSound('SWISH', SWISH_VOLUME, this.self.x, this.self.y)
        this.goState(DOOR_AISTATE.closing)
        return

      case 'closing':
        if (this.self.nextPicture()) return
        this.self.setState('stopped')
        this.self.setAiState(DOOR_AISTATE.closed)
    }
  }

  /**
   * `push_char` from lisp/common.lsp, with the door's own box:
   * `(push_char (+ (picture_width) 8) (picture_height))`, i.e. 32 by 60 for
   * the 24x60 door frame.
   *
   * It shoves a player standing in the doorway out to exactly `xamount`
   * clearance, picking whichever side they are already nearer, rather than
   * relying on collision to keep them out of a closing door.
   */
  private pushPlayerClear(): void {
    const focus = this.focus
    if (!focus) return

    const picture = this.self.picture
    const xamount = picture.width + 8
    const yamount = picture.height

    if (focus.y > this.self.y) return
    if (distanceY(this.self, focus) >= yamount) return
    if (distanceX(this.self, focus) >= xamount) return

    const push = pushAmount(this.self.x, focus.x, xamount)
    focus.tryMove(push, 0)
  }
}

/** How far to shove a focus to reach `clearance` from `originX`, signed. */
function pushAmount(originX: number, focusX: number, clearance: number): number {
  return focusX > originX ? clearance - (focusX - originX) : originX - focusX - clearance
}

/**
 * STEP - lisp/ladder.lsp `step_ai`. Three instances, each wired to a switch.
 *
 * Inverted logic: unwired, or with its driver on, it shows the solid `step`
 * frame; when the signal goes off it shows `step_gone`. The original marks
 * both frames `can_block` and lets the frame shape decide, which our tile-box
 * collision cannot do, so `step_gone` simply does not block.
 */
export class DisappearingStep extends Behaviour {
  override get solid(): boolean {
    return this.self.state === 'stopped'
  }

  protected run(): void {
    const driver = this.signals.driverOf(this.self.index)
    const present = driver === undefined || this.signals.isOn(driver)
    this.self.setState(present ? 'stopped' : 'running')
  }
}
