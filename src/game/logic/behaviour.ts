import type { LogicObject } from './object'
import type { SignalNetwork } from './signals'
import type { LogicFocus, LogicHost } from './types'

/** What a behaviour is allowed to see of the level around it. */
export interface LogicWorld {
  readonly signals: SignalNetwork
  readonly host: LogicHost
  /** Live position of any object, whether or not the logic drives it. */
  positionOf(index: number): { x: number; y: number } | undefined
  /** `(with_object o (progn (set_x ..) (set_y ..)))` - put an object somewhere. */
  moveObject(index: number, x: number, y: number): void
  /**
   * `set_fade_count` - 0 is solid and 15 is nearly gone, the same scale the
   * teleporters and SNEAKY use.
   */
  fadeObject(index: number, fade: number): void
  /**
   * `(add_object (with_object (get_object 0) (otype)) x y)` - a fresh copy of
   * another object's character, at a position.
   */
  spawnLike(index: number, x: number, y: number): void
  /** `(get_light n)` - which lights this object owns. */
  lightsOf(index: number): readonly number[]
  /** `set_light_x` / `set_light_y`. */
  moveLight(light: number, x: number, y: number): void
  /**
   * `get_light_value` / `set_light_value`: the object's own light's `r2`, or the
   * level's ambient when it owns none (lisp/light.lsp:16-24).
   */
  lightValue(index: number): number
  setLightValue(index: number, value: number): void
}

/**
 * A `go_state` chain runs inside one tick, so the guard only has to be longer
 * than the longest chain in the game: platform_ai's 0 -> 2 -> 3. Ours, purely
 * so a mistake in a behaviour cannot hang the frame.
 */
const MAX_REENTRIES = 8

/**
 * One object's ai function.
 *
 * The original runs every object's ai once per tick in level order, and
 * `go_state` re-enters the same function immediately with a new aistate. Both
 * are reproduced here: `tick` is the once-per-tick entry point, `run` is the
 * ai function, and calling `goState` from inside `run` makes it run again
 * before the tick ends.
 */
export abstract class Behaviour {
  private reenter = false

  constructor(
    protected readonly self: LogicObject,
    protected readonly world: LogicWorld,
  ) {}

  protected get signals(): SignalNetwork {
    return this.world.signals
  }

  protected get host(): LogicHost {
    return this.world.host
  }

  tick(): void {
    const before = this.self.aistate

    for (let pass = 0; pass < MAX_REENTRIES; pass++) {
      this.reenter = false
      this.run()
      if (!this.reenter) break
    }

    // The engine clocks state_time after the ai has run, and only while the
    // aistate came out of the tick unchanged (src/objects.cpp, the
    // keep_ai_info block). So the tick an object changes state reads zero.
    this.self.stateTime = this.self.aistate === before ? this.self.stateTime + 1 : 0
  }

  protected abstract run(): void

  /** `go_state` - set the signal, restart the clock, run the ai again now. */
  protected goState(value: number): void {
    this.self.setAiState(value)
    this.reenter = true
  }

  /**
   * `(bg)` - the player an object acts against. The engine hands each object
   * one; nearest is our stand-in, and with one player it is the same thing.
   */
  protected get focus(): LogicFocus | undefined {
    let best: LogicFocus | undefined
    let bestDistance = Infinity
    for (const focus of this.host.focuses()) {
      const distance = Math.abs(focus.x - this.self.x) + Math.abs(focus.y - this.self.y)
      if (distance >= bestDistance) continue
      best = focus
      bestDistance = distance
    }
    return best
  }

  /** True while this object stops movement. Doors, steps and lifts override. */
  get solid(): boolean {
    return false
  }
}

/** `distx` / `disty` - the engine's axis distances to a focus. */
export function distanceX(object: LogicObject, focus: LogicFocus): number {
  return Math.abs(focus.x - object.x)
}

export function distanceY(object: LogicObject, focus: LogicFocus): number {
  return Math.abs(focus.y - object.y)
}
