import type { GameAssets } from '../assets/loader'
import type { LevelObjectData } from '../assets/types'
import { Entity } from './Entity'

/**
 * A level object rendered from the original placement data - lava, doors,
 * teleporters, pickups, monsters standing where the level put them.
 *
 * Deliberately inert: it plays its animation and nothing else. Abuse's
 * behaviour lives in Lisp AI functions, and this project is writing its own
 * mechanics, so porting those would hand the design back to 1995. This is the
 * scenery those mechanics will eventually drive.
 */
export class Prop extends Entity {
  /** Animation rate in frames per second. */
  private static readonly FPS = 10
  /** How long a corpse lingers before being removed. */
  private static readonly DEATH_TICKS = 90

  /**
   * Whether this object cycles its frames on its own.
   *
   * Most do not. A door's frames are the positions it opens through and a
   * teleporter's are the spin it does once used - the original steps them from
   * the object's AI, not on a timer. Only fire, lava and water genuinely loop,
   * and the converter works out which from the scripts.
   */
  private readonly loops: boolean

  /** Can be shot, from the character's `(flags (hurtable T))`. */
  readonly hurtable: boolean
  /** Remaining health, from the character's `start_hp` ability. */
  health: number
  /** Counts down once killed, so the death frame is visible before removal. */
  private deathTimer = 0
  private dead = false

  constructor(
    assets: GameAssets,
    readonly data: LevelObjectData,
    /** Index in the level's object list, for looking up its links. */
    readonly objectIndex = -1,
  ) {
    super(assets, data.type)
    this.setPosition(data.x, data.y)
    this.direction = data.direction < 0 ? -1 : 1

    // Colour variants: ants and the like index a tint array with their aitype.
    this.tintIndex = assets.tintFor(data.type, data.aitype)

    // Levels record the state name each object was saved in; fall back when
    // that state no longer exists in the current scripts.
    const state = assets.hasState(data.type, data.state) ? data.state : assets.defaultState(data.type)
    this.setState(state, true)

    this.loops = assets.isIdleAnimated(data.type)
    this.hurtable = assets.hasFlag(data.type, 'hurtable')
    // Levels store a per-object hp; fall back to the character's own start_hp.
    this.health = data.hp || assets.ability(data.type, 'start_hp') || 1
  }

  advance(dt: number): void {
    if (this.deathTimer > 0 && --this.deathTimer === 0) this.dead = true
    if (!this.loops) return
    this.advanceAnimation(Prop.FPS * dt)
  }

  get isDead(): boolean {
    return this.dead
  }

  get isDying(): boolean {
    return this.deathTimer > 0
  }

  /** The box shots and the player test against, taken from the sprite. */
  get hitBox(): { left: number; top: number; right: number; bottom: number } {
    const frame = this.currentFrame
    const width = frame?.width ?? 16
    const height = frame?.height ?? 16
    const anchor = frame?.xcfg ?? width / 2
    const left = this.direction < 0 ? this.x - (width - anchor - 1) : this.x - anchor
    return { left, top: this.y - height + 1, right: left + width, bottom: this.y + 1 }
  }

  /**
   * Applies damage. Returns true if this killed it, which switches to the
   * death animation if the character has one and starts the removal timer.
   */
  damage(amount: number): boolean {
    if (!this.hurtable || this.deathTimer > 0 || this.dead) return false

    this.health -= amount
    if (this.health > 0) return false

    this.health = 0
    // `dieing` is the death throe, `dead` the corpse; most have one or neither.
    for (const state of ['dieing', 'dead']) {
      if (this.assets.hasState(this.character, state)) {
        this.setState(state, true)
        break
      }
    }
    this.deathTimer = Prop.DEATH_TICKS
    return true
  }
}

/** Objects worth putting in the world: known, drawable, not editor-only. */
export function spawnProps(assets: GameAssets, objects: LevelObjectData[]): Prop[] {
  const props: Prop[] = []
  objects.forEach((object, index) => {
    // Types absent from the scripts were deleted from the game after these
    // levels were saved; the original drops them on load too.
    if (!assets.character(object.type)) return
    if (assets.isEditorOnly(object.type)) return
    props.push(new Prop(assets, object, index))
  })
  return props
}
