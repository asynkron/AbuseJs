import { TICK_SCALE } from './enemies/tuning'
import type { GameAssets } from '../assets/loader'
import type { LevelObjectData } from '../assets/types'
import { Prop } from './Prop'

/**
 * TP_DOOR - the doorway that takes you somewhere else.
 *
 * Not a teleport pad and not a door in the `SWITCH_DOOR` sense. `tpd_ai` in
 * lisp/teleport.lsp gives it three jobs at once: it slides open when you come
 * near, it opens its partner at the same moment so you can see the far end
 * gaping, and it moves you across when you hold the action key inside it.
 *
 * It has no `can_block`, so standing in the opening is the point rather than
 * a mistake - which is exactly why nothing happening reads as a broken door.
 *
 * The key handling is the subtle part. `tpd_ai` does not debounce the action
 * key with a timer; it parks the player on the *destination* door:
 *
 *   (if (has_object player)
 *       (if (not (pressing_action_key)) (remove_object player))
 *     (if (and (< (distx) 20) ... (pressing_action_key))
 *         (progn (with_object (get_object 0) (link_object player))
 *                (move the player to the other door))))
 *
 * so the door you arrive at is holding you, and a door that holds you does
 * nothing at all until the key comes back up. Without that latch every tick
 * with the key down teleports again and the player ping-pongs between the two
 * ends, landing back where they started on any odd number of flips.
 */

/** Slides open inside this box, from `(and (< (distx) 100) (< (disty) 80))`. */
const OPEN_RANGE_X = 100
const OPEN_RANGE_Y = 80
/** ...and carries you across only inside this one. */
const USE_RANGE_X = 20
const USE_RANGE_Y = 30
/** TP_DOOR_INVIS's tighter box - `tpdi_ai` uses 15 and 20. */
const INVIS_USE_RANGE_X = 15
const INVIS_USE_RANGE_Y = 20
/** The five `door1..5` frames; `open_door` stops at frame 4. */
const OPEN_FRAME = 4
/**
 * Frames per tick the shutter runs at. `open_door` steps one frame per engine
 * tick, so this is that rate in ours - the same TICK_SCALE every other
 * animation in the port steps at. It was 0.5, picked from the mistaken idea
 * that 60Hz is twice 15Hz.
 */
const SLIDE_SPEED = TICK_SCALE

export class TeleportDoor extends Prop {
  /** The door this one is wired to, resolved after all of them are built. */
  partner: TeleportDoor | null = null

  private frame = 0
  private wasOpening = false

  /**
   * `(has_object player)` - this door is the one the player was last delivered
   * to, and it will not send them anywhere until the action key is released.
   */
  private holding = false

  /** TP_DOOR_INVIS has no shutter and a tighter mouth. */
  private readonly invisible: boolean

  constructor(assets: GameAssets, data: LevelObjectData, objectIndex: number) {
    super(assets, data, objectIndex)
    this.invisible = data.type === 'TP_DOOR_INVIS'
    this.setState('stopped', true)
    this.setFrame(0)
  }

  get isOpening(): boolean {
    return this.frame > 0
  }

  /** True while the player is inside the part that actually teleports. */
  covers(x: number, y: number): boolean {
    const rangeX = this.invisible ? INVIS_USE_RANGE_X : USE_RANGE_X
    const rangeY = this.invisible ? INVIS_USE_RANGE_Y : USE_RANGE_Y
    return Math.abs(x - this.x) < rangeX && Math.abs(y - this.y) < rangeY
  }

  /**
   * The key half of `tpd_ai`, run once per tick before anything asks whether
   * this door will teleport. Returns true when it is willing to.
   *
   * `pressing` is the action key's current state, not an edge: the latch is
   * what makes a held key harmless, exactly as the original's link does.
   */
  offer(pressing: boolean): boolean {
    if (this.holding) {
      // Still standing in the door that delivered them. Let go only when the
      // key comes up, and never send them back in the meantime.
      if (!pressing) this.holding = false
      return false
    }
    return pressing
  }

  /** Called on the door the player has just been moved to. */
  claim(): void {
    this.holding = true
  }

  /**
   * TP_DOOR_INVIS's draw_fun is `dev_draw`, so it is only ever visible in the
   * editor. Its `stopped` frame is the `clone_icon` placeholder, which would
   * otherwise be sitting in the level in plain sight.
   */
  override draw(alpha: number): void {
    if (this.invisible) {
      this.sprite.visible = false
      return
    }
    super.draw(alpha)
  }

  private inRange(x: number, y: number): boolean {
    return Math.abs(x - this.x) < OPEN_RANGE_X && Math.abs(y - this.y) < OPEN_RANGE_Y
  }

  /**
   * Runs the shutter. Returns the sound to play, if this is the tick it
   * starts moving - `open_door` and `close_door` each play theirs on the frame
   * the movement begins, not throughout.
   */
  update(playerX: number, playerY: number): 'DOOR_UP' | 'DOOR_DOWN' | null {
    // `tpdi_ai` has no shutter at all - TP_DOOR_INVIS is a bare doorway.
    if (this.invisible) return null

    // `other_door_opening`: a pair opens together, so walking up to one end
    // shows you the other. Without it you arrive through a shut door.
    const wants = this.inRange(playerX, playerY) || (this.partner?.inRange(playerX, playerY) ?? false)

    let sound: 'DOOR_UP' | 'DOOR_DOWN' | null = null
    if (wants) {
      if (this.frame === 0 && !this.wasOpening) sound = 'DOOR_UP'
      this.frame = Math.min(OPEN_FRAME, this.frame + SLIDE_SPEED)
    } else {
      if (this.frame >= OPEN_FRAME) sound = 'DOOR_DOWN'
      this.frame = Math.max(0, this.frame - SLIDE_SPEED)
    }
    this.wasOpening = wants

    this.setFrame(Math.round(this.frame))
    return sound
  }
}

/** Builds the teleport doors, visible and invisible, and pairs them up. */
export function buildTeleportDoors(
  assets: GameAssets,
  objects: LevelObjectData[],
  links: number[][],
  props: Prop[],
): TeleportDoor[] {
  const doors: TeleportDoor[] = []
  const byIndex = new Map<number, TeleportDoor>()

  objects.forEach((object, index) => {
    if (object.type !== 'TP_DOOR' && object.type !== 'TP_DOOR_INVIS') return
    if (!assets.character(object.type)) return

    const door = new TeleportDoor(assets, object, index)
    doors.push(door)
    byIndex.set(index, door)

    const existing = props.findIndex((p) => p.data === object)
    if (existing >= 0) props.splice(existing, 1)
  })

  // `(get_object 0)` is the first link, and the pairs point both ways.
  for (const door of doors) {
    const target = (links[door.objectIndex] ?? [])[0]
    door.partner = target === undefined ? null : (byIndex.get(target) ?? null)
  }

  return doors
}
