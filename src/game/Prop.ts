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
  /** What it started with, so damage can be shown as a fraction. */
  readonly maxHealth: number
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
    //
    // Anything at or below zero counts as not saved rather than as saved
    // health. Twenty objects across the fan-made add-on levels carry the same
    // junk value in that slot - 0x869F, which is -31073 read the way the
    // format's signed fields are read - and taking it at face value would put
    // a turret on negative health before it had done anything.
    this.health = (data.hp > 0 ? data.hp : 0) || assets.ability(data.type, 'start_hp') || 1
    this.maxHealth = this.health
  }

  advance(dt: number): void {
    if (!this.loops) return
    this.advanceAnimation(Prop.FPS * dt)
  }

  /**
   * Steps a multi-frame prop through its frames as it loses health.
   *
   * `hwall_damage` in the original's lisp/doors.lsp does exactly this -
   * `(set_current_frame (/ (* (total_frames) (- max_hp (hp))) max_hp))` - so
   * a hidden wall's three `sect` frames are progressive damage, not an idle
   * animation. Without it a wall looks untouched until the shot that breaks
   * it, and there is no sign you are getting anywhere.
   */
  private showDamage(): void {
    if (this.loops || this.frameCount < 2) return
    if (this.maxHealth <= 0) return
    const spent = this.maxHealth - this.health
    this.setFrame(Math.min(this.frameCount - 1, Math.floor((this.frameCount * spent) / this.maxHealth)))
  }

  /**
   * Counts the corpse down. Separate from `advance` because that runs from the
   * draw pass, which skips anything off screen - a body killed just before it
   * scrolled out of view would sit there forever waiting for a tick that only
   * arrives if you happen to look at it.
   */
  tickLifetime(): void {
    if (this.deathTimer > 0 && --this.deathTimer === 0) this.dead = true
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
   *
   * `fromCharacter` is the character name of whatever dealt the blow - the
   * `from` argument every damage call in the scripts carries. Scenery has no
   * use for it; the creatures in src/game/enemies override this and read it to
   * decide whether the shot came from one of their own.
   */
  damage(amount: number, _fromCharacter?: string): boolean {
    if (!this.hurtable || this.deathTimer > 0 || this.dead) return false

    this.health -= amount
    if (this.health > 0) {
      this.showDamage()
      return false
    }

    this.health = 0
    // `dieing` is the death throe, `dead` the corpse; most have one or neither.
    let hasCorpse = false
    for (const state of ['dieing', 'dead']) {
      if (this.assets.hasState(this.character, state)) {
        this.setState(state, true)
        hasCorpse = true
        break
      }
    }
    // With nothing to show there is no reason to linger: it would just sit on
    // whichever frame it happened to die on - a flinch, for anything that was
    // being shot at - until the timer ran out. The explosion is the feedback.
    this.deathTimer = hasCorpse ? Prop.DEATH_TICKS : 1
    return true
  }

  /**
   * Kills the object outright, whatever health it had left.
   *
   * `hwall_ai` returning nil is not damage - a wired hidden wall comes down
   * because its switch went on, and at that moment its `unactive_shield` would
   * refuse a shot. Returns false if it was already dying.
   */
  kill(): boolean {
    if (this.deathTimer > 0 || this.dead) return false
    this.health = 1
    return this.damage(1)
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
