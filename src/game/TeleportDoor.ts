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
 * The original never says a word about the key either.
 */

/** Slides open inside this box, from `(and (< (distx) 100) (< (disty) 80))`. */
const OPEN_RANGE_X = 100
const OPEN_RANGE_Y = 80
/** ...and carries you across only inside this one. */
const USE_RANGE_X = 20
const USE_RANGE_Y = 30
/** The five `door1..5` frames; `open_door` stops at frame 4. */
const OPEN_FRAME = 4
/** Frames per tick the shutter runs at. Not in the lisp - `open_door` steps
 * one frame per call and the engine calls it every tick, which at 60Hz is
 * twice the original's rate, so it is halved here. */
const SLIDE_SPEED = 0.5

export class TeleportDoor extends Prop {
  /** The door this one is wired to, resolved after all of them are built. */
  partner: TeleportDoor | null = null

  private frame = 0
  private wasOpening = false

  constructor(assets: GameAssets, data: LevelObjectData, objectIndex: number) {
    super(assets, data, objectIndex)
    this.setState('stopped', true)
    this.setFrame(0)
  }

  get isOpening(): boolean {
    return this.frame > 0
  }

  /** True while the player is inside the part that actually teleports. */
  covers(x: number, y: number): boolean {
    return Math.abs(x - this.x) < USE_RANGE_X && Math.abs(y - this.y) < USE_RANGE_Y
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

/** Builds the teleport doors and pairs them up from the level's links. */
export function buildTeleportDoors(
  assets: GameAssets,
  objects: LevelObjectData[],
  links: number[][],
  props: Prop[],
): TeleportDoor[] {
  const doors: TeleportDoor[] = []
  const byIndex = new Map<number, TeleportDoor>()

  objects.forEach((object, index) => {
    if (object.type !== 'TP_DOOR') return
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
