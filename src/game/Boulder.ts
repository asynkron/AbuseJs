import type { GameAssets } from '../assets/loader'
import type { LevelObjectData } from '../assets/types'
import type { Level } from './Level'
import { Prop } from './Prop'
import { moveAndCollide } from './collision'

/**
 * BOLDER - the spiked ball that hangs from the ceiling until you walk under it.
 *
 * Every number here is out of `bolder_ai` and `def_char BOLDER` in
 * lisp/duong.lsp. The gate is the first thing the ai does:
 *
 *   (if (or (eq (total_objects) 0)
 *           (not (eq (with_object (get_object 0) (aistate)) 0)))
 *
 * so a boulder with no link runs immediately and a linked one waits for its
 * object's `aistate` to go non-zero. In level01 all four link to a SENSOR
 * sitting between them and the floor: it is a trap, and walking under it is
 * what springs it.
 */

/** `bolder_cons` - it starts rolling left the moment it is released. */
const START_XVEL = -4
/** `(set_yvel (+ (yvel) 1))`, once per tick. */
const GRAVITY = 1
/** `(hurt_radius (x) (y) 19 30 (me) 15)` - radius, damage, knockback. */
const HURT_RADIUS = 19
const HURT_AMOUNT = 30
const HURT_PUSH = 15
/** Below this impact speed a bounce is silent - `(if (> (abs old_yv) 3) ...)`. */
const BOUNCE_SOUND_SPEED = 3
/** `(abilities (start_hp 40))`. */
export const BOULDER_HP = 40

/** What a boulder wants the world to do for it this tick. */
export interface BoulderEvents {
  /** It is rolling and everything within HURT_RADIUS takes HURT_AMOUNT. */
  hurt: { x: number; y: number; radius: number; amount: number; push: number } | null
  /** It landed hard enough to be heard. */
  sound: 'SBALL_SND' | null
}

const NOTHING: BoulderEvents = { hurt: null, sound: null }

export class Boulder extends Prop {
  /** Still hanging. `can_block` makes it scenery until then. */
  private released = false

  constructor(
    assets: GameAssets,
    data: LevelObjectData,
    objectIndex: number,
    private readonly level: Level,
    /** Its trigger, or null when nothing links it and it runs at once. */
    readonly triggerIndex: number | null,
  ) {
    super(assets, data, objectIndex)
    this.halfWidth = 15
    this.height = 30
  }

  get isReleased(): boolean {
    return this.released
  }

  /** `isTriggerOn` answers `(with_object (get_object 0) (aistate))` being non-zero. */
  update(isTriggerOn: (index: number) => boolean): BoulderEvents {
    if (!this.released) {
      if (this.triggerIndex !== null && !isTriggerOn(this.triggerIndex)) return NOTHING
      this.released = true
      // `bolder_cons` sets these; the constructor runs on spawn in the
      // original, but nothing reads them until the ai gate opens.
      this.vx = START_XVEL
      this.vy = 0
    }

    this.advance(1 / 60)
    this.vy += GRAVITY

    const oldVx = this.vx
    const oldVy = this.vy
    const result = moveAndCollide(this.level, this, this.vx, this.vy)

    let sound: BoulderEvents['sound'] = null
    if (result.onGround || result.hitCeiling) {
      if (Math.abs(oldVy) > BOUNCE_SOUND_SPEED) sound = 'SBALL_SND'
      this.vx = oldVx
      // `(if (> old_yv 1) (set_yvel (- 2 old_yv)) (set_yvel (- 0 old_yv)))` -
      // a falling boulder loses two units on the bounce, a rising one simply
      // reverses.
      this.vy = oldVy > 1 ? 2 - oldVy : -oldVy
    } else if (result.hitWall) {
      this.vy = oldVy
      this.vx = -oldVx
    }

    return {
      hurt: { x: this.x, y: this.y, radius: HURT_RADIUS, amount: HURT_AMOUNT, push: HURT_PUSH },
      sound,
    }
  }
}

/**
 * Builds the boulders, taking them out of the prop list. A boulder is
 * `can_block` while it hangs, so the caller keeps it as a blocker until
 * `isReleased`.
 */
export function buildBoulders(
  assets: GameAssets,
  objects: LevelObjectData[],
  links: number[][],
  props: Prop[],
  level: Level,
): Boulder[] {
  const boulders: Boulder[] = []

  objects.forEach((object, index) => {
    if (object.type !== 'BOLDER') return
    if (!assets.character(object.type)) return

    const trigger = (links[index] ?? [])[0]
    boulders.push(new Boulder(assets, object, index, level, trigger ?? null))

    const existing = props.findIndex((p) => p.data === object)
    if (existing >= 0) props.splice(existing, 1)
  })

  return boulders
}
