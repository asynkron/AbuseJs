/**
 * The seam between the level logic and the rest of the game.
 *
 * Everything this subsystem needs from the world arrives through `LogicHost`,
 * and everything it produces leaves as a `LogicView`. It never reaches into
 * the world itself, so it can be wired up - or torn out - in one place.
 */

/**
 * The level-object fields the logic reads.
 *
 * Structurally a `LevelObjectData` from src/assets/types.ts, plus the per
 * object lisp variables. Levels reuse the physics slots as configuration:
 * a platform keeps its step count in `xacel`, a sensor its trigger box in
 * `xvel`/`yvel` and its release box in `xacel`/`yacel`.
 */
export interface LogicObjectData {
  type: string
  state: string
  x: number
  y: number
  direction: number
  hp: number
  aistate: number
  aitype: number
  xvel: number
  yvel: number
  xacel: number
  yacel: number
  /**
   * Per-object lisp variables - `delay_time`, `pulse_speed`, `reset_time`,
   * `unoffable` - out of the level file's `lvars` chunk. The name has to match
   * `LevelObjectData.lvars`, because the world hands its objects to LevelLogic
   * as they are: while this was called `vars` the whole logic layer silently
   * read `undefined` and every gate, delay and sensor ran on its fallback.
   */
  lvars?: Readonly<Record<string, number>>
}

/** The sounds this subsystem plays, by their name in lisp/sfx.lsp. */
export type LogicSound = 'SWISH' | 'SWITCH_SND' | 'PLAT_A_SND' | 'PLAT_D_SND' | 'SPRING_SOUND'

/**
 * A player, as the logic sees one.
 *
 * The original calls these focus objects and walks them with
 * `first_focus`/`next_focus`; `(bg)` is the one an object is currently acting
 * against.
 */
export interface LogicFocus {
  readonly x: number
  /** Feet, matching the engine's anchor. */
  readonly y: number
  readonly pressingAction: boolean
  /** `try_move` - shift by this much, stopping at the first solid tile. */
  tryMove(dx: number, dy: number): void
  /** `set_y` - place the feet, ignoring collision. Used when boarding a lift. */
  setFeetY(y: number): void
  /**
   * `(set_yvel (+ (yvel) n))` - a spring's shove, quoted in the original's
   * units per engine tick. The conversion belongs to whoever owns the physics,
   * not here: the logic reads what the level saved and passes it straight on.
   */
  boost(yvel: number): void
}

/** Size of one sprite frame, for the push boxes taken from the art. */
export interface PictureSize {
  width: number
  height: number
}

/**
 * What the logic asks of the world.
 *
 * The names are the original's engine primitives where there is one, because
 * that is what the citations in the behaviours refer to.
 */
export interface LogicHost {
  /** Every focus object - the players. */
  focuses(): readonly LogicFocus[]
  /** True when the character defines this animation state. */
  hasState(type: string, state: string): boolean
  /** Frames in one animation state; 0 when there is no such state. */
  frameCount(type: string, state: string): number
  /** `picture_width` / `picture_height` of one frame. */
  pictureSize(type: string, state: string, frame: number): PictureSize
  /** One of the character's `(abilities ...)`, e.g. `start_accel`. */
  ability(type: string, name: string): number | undefined
  /** `touching_bg` - the object's sprite overlaps this focus. */
  touching(index: number, focus: LogicFocus): boolean
  /** State `dead` or `blown_back_dead`, which is what a death sensor watches for. */
  isDefeated(index: number): boolean
  /** Volume is the original's 0..127 scale; the caller maps it to its own mixer. */
  playSound(sound: LogicSound, volume: number, x: number, y: number): void
  /** `platform_push` - move whatever rides this object along with it. */
  carryRiders(index: number, dx: number, dy: number): void
}

/** A logic-driven object, as the renderer and the collision pass see it. */
export interface LogicView {
  readonly index: number
  readonly type: string
  readonly x: number
  readonly y: number
  /** Animation state name - `stopped`, `running`, `walking`, `blocking`. */
  readonly state: string
  /** Frame within that state. */
  readonly frame: number
  /** The signal value other objects read. Non-zero means on. */
  readonly aistate: number
  /** True while this object stops movement. Only doors, steps and lifts ever do. */
  readonly solid: boolean
}
