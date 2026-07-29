import type { GameAssets } from '../assets/loader'
import type { LevelObjectData } from '../assets/types'
import type { Level } from './Level'
import { Prop } from './Prop'
import { moveAndCollide } from './collision'
import { accel, random, speed, TICK_SCALE } from './enemies/tuning'

/**
 * BOLDER - the spiked ball that hangs from the ceiling until you walk under it.
 *
 * Every number here is out of `bolder_ai` and `def_char BOLDER` in
 * lisp/duong.lsp, converted to the port's units (the original's are pixels per
 * 15Hz tick). The gate is the first thing the ai does:
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
const START_XVEL = speed(-4)
/** `(set_yvel (+ (yvel) 1))`, once per original tick. */
const GRAVITY = accel(1)
/** `(hurt_radius (x) (y) 19 30 (me) 15)` - radius, damage, knockback. */
const HURT_RADIUS = 19
const HURT_AMOUNT = 30
const HURT_PUSH = 15
/** Below this impact speed a bounce is silent - `(if (> (abs old_yv) 3) ...)`. */
const BOUNCE_SOUND_SPEED = speed(3)
/**
 * The bounce keeps a falling boulder's energy loss: yvel becomes `2 - old`
 * when it was falling faster than 1, else a clean reversal. Original units.
 */
const BOUNCE_LOSS = speed(2)
const BOUNCE_MIN = speed(1)
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

  /**
   * The original applied its contact `hurt_radius` once per 15Hz tick; we run
   * at 60Hz with rescaled velocities, so the equivalent is once per
   * 1/TICK_SCALE of our ticks. This carries the fraction.
   */
  private hurtCarry = 0

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

    // The render loop advances the sprite animation; this only moves it.
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
      this.vy = oldVy > BOUNCE_MIN ? BOUNCE_LOSS - oldVy : -oldVy
    } else if (result.hitWall) {
      this.vy = oldVy
      this.vx = -oldVx
    }

    this.hurtCarry += TICK_SCALE
    if (this.hurtCarry < 1) return { hurt: null, sound }
    this.hurtCarry -= 1

    return {
      hurt: { x: this.x, y: this.y, radius: HURT_RADIUS, amount: HURT_AMOUNT, push: HURT_PUSH },
      sound,
    }
  }
}

/* ------------------------------------------------------------------ */
/* the pieces                                                          */
/* ------------------------------------------------------------------ */

/**
 * SMALL_BOLDER - the five chunks a dying boulder comes apart into
 * (`small_rock_ai`, lisp/duong.lsp). Each falls, bounces off walls and the
 * ceiling, and explodes the first time it comes down on a floor:
 *
 *   (bounce_move T T T '(progn <explosion, hurt_radius 40 15> nil) T)
 */

/** The five launch velocities `bolder_ai` hands out, in original units. */
export const CHUNK_VELOCITIES: readonly (readonly [number, number])[] = [
  [-4, -8],
  [4, -9],
  [2, -5],
  [-3, -5],
  [-1, 2],
]

/** What a chunk's floor-burst does. */
export const CHUNK_BLAST = { radius: 40, damage: 15, push: 20 } as const

/** What a chunk asks of the world when it lands. */
export interface ChunkBurst {
  x: number
  y: number
}

export class SmallBoulder extends Prop {
  private done = false

  constructor(assets: GameAssets, x: number, y: number, vxOriginal: number, vyOriginal: number) {
    super(assets, {
      type: 'SMALL_BOLDER',
      state: 'stopped',
      x,
      y,
      direction: 1,
      hp: 0,
      aistate: 0,
      aitype: 0,
      xvel: 0,
      yvel: 0,
      xacel: 0,
      yacel: 0,
    })
    this.halfWidth = 5
    this.height = 8
    this.vx = speed(vxOriginal)
    this.vy = speed(vyOriginal)
  }

  get isSpent(): boolean {
    return this.done
  }

  /** One tick. Returns the burst when it just went off, null otherwise. */
  update(level: Level): ChunkBurst | null {
    if (this.done) return null

    this.vy += GRAVITY

    const oldVx = this.vx
    const oldVy = this.vy
    const result = moveAndCollide(level, this, this.vx, this.vy)

    if (result.onGround) {
      // Coming down on a floor is the end of it.
      this.done = true
      return { x: this.x, y: this.y }
    }
    if (result.hitCeiling) {
      this.vx = oldVx
      this.vy = oldVy > BOUNCE_MIN ? BOUNCE_LOSS - oldVy : -oldVy
    } else if (result.hitWall) {
      this.vy = oldVy
      this.vx = -oldVx
    }
    return null
  }
}

/** Where `bolder_ai` scatters its debris: `(+/- (x) (random 5))` etc. */
export function chunkSpawnJitter(): { dx: number; dy: number } {
  return { dx: random(5), dy: random(5) }
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
