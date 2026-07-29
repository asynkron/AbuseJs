import type { SignalNetwork } from './signals'
import type { LogicHost, LogicObjectData, PictureSize } from './types'

/**
 * One object's mutable runtime state, as the engine keeps it: where it is,
 * which animation it shows and how far through, its signal value and how long
 * that value has been set.
 *
 * `aistate` lives in the shared network rather than here, because every other
 * object in the level can read it.
 */
export class LogicObject {
  x: number
  y: number
  /** 1 facing right, -1 facing left. Only the hidden-wall blasts use it. */
  readonly direction: 1 | -1

  /** Animation state name, the engine's `state`. */
  state: string
  /** Frame within that state, the engine's `current_frame`. */
  frame = 0
  /** `state_time` - the saved `aistate_time`, reset by `set_aistate`. */
  stateTime = 0

  constructor(
    readonly index: number,
    readonly data: LogicObjectData,
    private readonly signals: SignalNetwork,
    private readonly host: LogicHost,
  ) {
    this.x = data.x
    this.y = data.y
    this.direction = data.direction < 0 ? -1 : 1
    // Levels record the state name an object was saved in; characters change,
    // so fall back to the one every def_char has.
    this.state = host.hasState(data.type, data.state) ? data.state : 'stopped'
  }

  get type(): string {
    return this.data.type
  }

  get aistate(): number {
    return this.signals.stateOf(this.index)
  }

  /**
   * `set_aistate` - change the signal and restart the state clock. It does
   * *not* re-enter the ai function; several behaviours rely on that to avoid
   * looping, which is why `goState` is a separate thing.
   */
  setAiState(value: number): void {
    this.signals.setState(this.index, value)
    this.stateTime = 0
  }

  /**
   * `set_state` - switch animation and restart it at frame 0. A character
   * without that sequence falls back to `stopped`, which is what the engine
   * does rather than refusing (src/objects.cpp, game_object::set_state).
   */
  setState(state: string): void {
    this.state = this.host.hasState(this.type, state) ? state : 'stopped'
    this.frame = 0
  }

  /**
   * `next_picture` - advance one frame, returning false on the tick the
   * animation ran off the end, where it also wraps back to frame 0
   * (src/objects.cpp game_object::next_picture, src/seq.h sequence::next_frame).
   * That false is what makes `(if (next_picture) T (progn ...))` mean "keep
   * animating, and do this once when the animation ends".
   */
  nextPicture(): boolean {
    const total = this.host.frameCount(this.type, this.state)
    if (total === 0) return false
    if (this.frame + 1 < total) {
      this.frame++
      return true
    }
    this.frame = 0
    return false
  }

  get picture(): PictureSize {
    return this.host.pictureSize(this.type, this.state, this.frame)
  }

  /**
   * A per-object lisp variable from the level's `lvars` chunk.
   *
   * tools/convert.ts does not read that chunk yet, so in practice every one of
   * these resolves to its fallback. Each call site says where its fallback
   * comes from and whether it is the original's or ours.
   */
  variable(name: string, fallback: number): number {
    const value = this.data.vars?.[name]
    return value === undefined ? fallback : value
  }
}
