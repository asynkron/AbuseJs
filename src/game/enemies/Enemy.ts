import type { GameAssets } from '../../assets/loader'
import type { LevelObjectData } from '../../assets/types'
import { Prop } from '../Prop'
import { TICK_SCALE } from './tuning'
import type { EnemyContext, EnemyShot, EnemySound, PlayerView } from './types'

/**
 * What the AI is given to act on the world with. The host supplies the
 * `EnemyContext` half; the group adds the two things only it can do - put a
 * round in the air and put a new creature in the level.
 */
export interface Battlefield extends EnemyContext {
  fire(shot: EnemyShot): void
  spawn(enemy: Enemy): void
  /**
   * `find_object_in_area` narrowed to what the AI actually asks for: is there
   * another creature of this character standing in this box? Only the ants use
   * it, to keep from piling up on one another.
   */
  anyIn(character: string, x0: number, y0: number, x1: number, y1: number): boolean
}

/**
 * A creature with an AI.
 *
 * It is a Prop, so it draws, animates and takes damage exactly like every
 * other level object and slots into the same lists. What this adds is the
 * plumbing the Lisp AI functions assume underneath them: an animation cursor
 * that can say when a sequence has run out, a clock that resets when the state
 * does, the shove every large monster applies to the player, and the "am I
 * switched on" test that every dormant thing in Abuse begins with.
 *
 * The behaviour itself lives in `think`, one subclass per creature.
 */
export abstract class Enemy extends Prop {
  /**
   * Where the current animation has got to.
   *
   * Entity keeps its own frame index private and loops silently, but the
   * scripts lean on `next_picture` returning nil at the end of a sequence -
   * that is how an ant knows its landing animation has finished and how a
   * jugger knows to throw. Tracking a parallel cursor is the cheapest way to
   * get that answer without touching Entity.
   */
  private pictureIndex = 0

  /**
   * `(range x y)` - how far outside the view this creature still thinks.
   * `add_actives` only wakes objects whose position, grown by this, meets the
   * view grown by a quarter (src/level.cpp:216-257).
   */
  readonly range: readonly [number, number]

  /**
   * The original advanced `next_picture` once per 15Hz engine tick; we are
   * called at 60Hz with everything else rescaled by TICK_SCALE, so a frame
   * advances every 1/TICK_SCALE calls. This carries the fraction between
   * calls. Without it, every animation-paced behaviour - the jugger throwing
   * a grenade per walk cycle, the ant's fire_wait - ran 1.5x too fast even
   * relative to the port's own sped-up clock.
   */
  private animCarry = 0

  /** Whether the last `nextPicture` call actually stepped a frame on. */
  private advancedFrame = false

  /**
   * `state_time` - which is really `aistate_time`.
   *
   * The engine increments it once per tick and zeroes it only when `aistate`
   * changes (src/objects.cpp:431-433), and `set_aistate`/`go_state` zero it
   * explicitly (src/clisp.cpp:1099, :589). A plain `set_state` - an art change -
   * never touches it. Resetting it on art changes too made every timer that
   * outlives an animation restart spuriously: the flyer's rotor note skipped a
   * beat on each turn, because turning swaps its art but not its aistate.
   *
   * So this is reset by `resetStateTime`, which subclasses call where the
   * original calls `set_aistate`, and by nothing else.
   */
  protected stateTime = 0

  /** Set by `think` returning false: this creature is finished. */
  private finished = false

  constructor(
    assets: GameAssets,
    data: LevelObjectData,
    objectIndex: number,
    protected readonly world: Battlefield,
  ) {
    super(assets, data, objectIndex)

    this.range = assets.range(data.type)

    // Levels store direction as a byte, so left-facing objects arrive as 255
    // rather than -1. Prop reads it as a signed number and lands on 1 for
    // both, which points every left-facing monster the wrong way.
    this.direction = (data.direction << 24) >> 24 < 0 ? -1 : 1
  }

  /** One tick of AI. Returning false asks to be taken out of the world. */
  protected abstract think(player: PlayerView): boolean

  /** Runs a tick. False means the creature is gone. */
  update(player: PlayerView): boolean {
    // Render interpolation reads these; without the update a moving sprite is
    // drawn somewhere between its spawn point and now.
    this.prevX = this.x
    this.prevY = this.y

    if (this.isDead) return false
    if (this.isDying) return this.decay(player)

    this.stateTime++
    if (!this.think(player)) this.finished = true
    return !this.finished
  }

  /**
   * A corpse plays its death animation once and then goes.
   *
   * Prop would hold it for ninety ticks instead, which is right for scenery
   * and wrong for a monster: the ant's `dead` state is the `hidden` frame, so
   * that would be ninety ticks of nothing, and a flyer has no death state at
   * all. Only the jugger has anything to show, and its script removes it the
   * tick `jugdie` runs out (`(if (not (next_picture)) ... nil)`).
   */
  protected decay(_player: PlayerView): boolean {
    if (this.state !== 'dieing') return false
    return this.nextPicture()
  }

  get isFinished(): boolean {
    return this.finished
  }

  /* ---------------------------------------------------------------- */
  /* animation                                                         */
  /* ---------------------------------------------------------------- */

  override setState(state: string, restart = false): void {
    const previous = this.state
    super.setState(state, restart)
    if (this.state !== previous || restart) {
      this.pictureIndex = 0
      this.animCarry = 0
    }
  }

  /** `set_aistate` / `go_state`: the only thing that zeroes `state_time`. */
  protected resetStateTime(): void {
    this.stateTime = 0
  }

  /** Switches state only if the character actually has that animation. */
  protected trySetState(state: string, restart = false): void {
    if (this.assets.hasState(this.character, state)) this.setState(state, restart)
  }

  /**
   * `next_picture`: step one frame on, and report whether there was one. False
   * means the sequence just wrapped, which is how the scripts detect the end
   * of a one-shot animation.
   *
   * Called once per 60Hz tick but paced to the original's 15Hz clock (scaled):
   * a frame only actually advances every 1/TICK_SCALE calls, and the ticks in
   * between report "still going" without moving. Frame-triggered actions
   * should check `frameJustAdvanced` so a held frame does not re-fire them.
   */
  protected nextPicture(): boolean {
    const count = this.frameCount
    if (count <= 1) {
      this.advancedFrame = false
      return false
    }

    this.animCarry += TICK_SCALE
    if (this.animCarry < 1) {
      this.advancedFrame = false
      return true
    }
    this.animCarry -= 1

    this.advancedFrame = true
    this.advanceAnimation(1)
    this.pictureIndex = (this.pictureIndex + 1) % count
    return this.pictureIndex !== 0
  }

  /** Whether the last `nextPicture` call actually moved to a new frame. */
  protected get frameJustAdvanced(): boolean {
    return this.advancedFrame
  }

  /** `current_frame`. */
  protected get pictureAt(): number {
    return this.pictureIndex
  }

  /** `set_current_frame`. */
  protected setPicture(index: number): void {
    this.pictureIndex = this.frameCount > 0 ? index % this.frameCount : 0
    this.setFrame(this.pictureIndex)
  }

  /* ---------------------------------------------------------------- */
  /* the world                                                         */
  /* ---------------------------------------------------------------- */

  /** The objects this one is wired to - `(get_object n)` in the scripts. */
  protected get linkedObjects(): number[] {
    return this.world.level.links[this.objectIndex] ?? []
  }

  /**
   * `(activated)`: an unlinked creature is always on, a linked one waits for
   * its sensor, switch or gate to go non-zero.
   */
  protected get activated(): boolean {
    const links = this.linkedObjects
    if (links.length === 0) return true
    return this.world.isSignalOn(links[0])
  }

  /** `(distx)` and `(disty)` - absolute distances to the player. */
  protected distX(player: PlayerView): number {
    return Math.abs(player.x - this.x)
  }

  protected distY(player: PlayerView): number {
    return Math.abs(player.y - this.y)
  }

  /** `(toward)`: which way the player lies. */
  protected toward(player: PlayerView): 1 | -1 {
    return player.x < this.x ? -1 : 1
  }

  /** `(facing)` compared with `(toward)`, the test that triggers a turn. */
  protected facingPlayer(player: PlayerView): boolean {
    return this.direction === this.toward(player)
  }

  /**
   * Contact damage, applied at the engine's rate rather than ours.
   *
   * The original's frame damage lands once per 15Hz tick while the boxes
   * overlap. Calling it on every one of our ticks would be four times the
   * damage - which the old 30-tick invulnerability window was hiding.
   */
  protected touchDamage(amount: number): void {
    this.contactCarry += TICK_SCALE
    if (this.contactCarry < 1) return
    this.contactCarry -= 1
    this.world.hurtPlayer(amount)
  }

  private contactCarry = 0

  protected playSound(sound: EnemySound): void {
    this.world.playSound(sound, this.x, this.y)
  }

  /**
   * `push_char`: shoves the player sideways out of a large monster.
   *
   * lisp/common.lsp. It only acts when the player is at or above the
   * creature's feet and inside the box, and the shove grows with the overlap,
   * so the player is squeezed out of whichever side they are already on. It is
   * not damage and it is not a wall - monsters are not solid.
   */
  protected pushChar(player: PlayerView, xAmount: number, yAmount: number): void {
    if (player.y > this.y) return
    if (this.distY(player) >= yAmount) return
    if (this.distX(player) >= xAmount) return

    const amount =
      player.x > this.x ? xAmount - (player.x - this.x) : this.x - player.x - xAmount
    this.world.pushPlayer(amount)
  }

  /** Whether the player's box overlaps this creature's. */
  protected touching(player: PlayerView): boolean {
    if (Math.abs(player.x - this.x) > player.halfWidth + this.halfWidth) return false
    if (this.y < player.y - player.height) return false
    if (this.y - this.height > player.y) return false
    return true
  }
}
