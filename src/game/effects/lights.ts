import type { RenderLight } from '../../assets/types'
import { SIM_TICKS_PER_TICK } from './clock'

/**
 * EXP_LIGHT: the flash of light an explosion adds and takes away again.
 *
 * `explo_light` (lisp/explo.lsp) is an invisible object with two states. State
 * 0 does `(link_light (add_light 0 (x) (y) 1 (aitype) 0 0))` and moves on;
 * state 1 waits until `(state_time)` passes 3, deletes the light and returns
 * nil. `go_state` resets state_time, so the light is alive for the tick it was
 * made on plus four more.
 *
 * The `add_light` argument order is (type, x, y, inner, outer, xshift,
 * yshift), which is exactly the LightSource record LightLayer already draws:
 * type 0 is the full ellipse and a shift of 0 means no squash. Every caller
 * asks for an outer radius of 100.
 *
 * Everything past that on-and-off behaviour is invented. The original's flash
 * appears at full strength and vanishes; a decay, a tint, a hold at peak and a
 * spawn delay are what turn eleven identical pops into eleven distinguishable
 * explosions. The defaults reproduce the original exactly, so a caller that
 * passes no options still gets `explo_light` as it stands.
 */

/** `(add_object EXP_LIGHT (x) (y) 100)` - lisp/explo.lsp do_explo. */
export const EXPLOSION_LIGHT_RADIUS = 100

/** state_time 0..3 keep the light; it goes on 4 - lisp/explo.lsp explo_light. */
const FLASH_TICKS = 5

/** How a flash behaves over its life. Invented - explo_light is on or off. */
export interface FlashOptions {
  /** Engine ticks alive. Default 5, which is what explo_light counts. */
  ticks?: number
  /** Contribution at full strength, 0..1. Default 1. */
  peak?: number
  /** Additive colour. Default white - the original has no coloured light. */
  tint?: number
  /** Engine ticks held at `peak` before the decay starts. Default 0. */
  hold?: number
  /**
   * Engine ticks before the flash appears at all - the same staging `exp_ai`'s
   * aitype gives the sprites, so a light can roll with a demolition instead of
   * firing once at the front of it (lisp/jugger.lsp rob1_ai).
   */
  delay?: number
}

/**
 * Lifetimes are counted in sim ticks, not engine ticks.
 *
 * The public API stays in engine ticks so the lisp constants are still written
 * as they stand, but a five-step decay at 15 Hz visibly staircases. Counting
 * those same five ticks as twenty sim ticks gives the falloff four times the
 * resolution for nothing, which is why `advance` runs on the 60 Hz tick rather
 * than from behind the subsystem's clock.
 */
interface Flash extends RenderLight {
  intensity: number
  tint: number
  /** Sim ticks lived. */
  age: number
  /** Sim ticks in total. */
  life: number
  /** Sim ticks at `peak` before the decay starts. */
  hold: number
  peak: number
  /** Sim ticks still to wait before this joins the live list. */
  delay: number
}

export class ExplosionLights {
  private readonly flashes: Flash[] = []
  /**
   * Delayed flashes, held back until their delay runs out. Kept apart because
   * `lights` hands its array straight to the renderer and must never yield a
   * flash that has not been born yet.
   */
  private readonly pending: Flash[] = []

  add(x: number, y: number, outer = EXPLOSION_LIGHT_RADIUS, options: FlashOptions = {}): void {
    const peak = options.peak ?? 1
    const flash: Flash = {
      x,
      y,
      inner: 1,
      outer,
      type: 0,
      xshift: 0,
      yshift: 0,
      tint: options.tint ?? 0xffffff,
      peak,
      intensity: peak,
      age: 0,
      life: (options.ticks ?? FLASH_TICKS) * SIM_TICKS_PER_TICK,
      hold: (options.hold ?? 0) * SIM_TICKS_PER_TICK,
      delay: (options.delay ?? 0) * SIM_TICKS_PER_TICK,
    }

    if (flash.delay > 0) this.pending.push(flash)
    else this.flashes.push(flash)
  }

  /** One sim tick. */
  advance(): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const flash = this.pending[i]
      if (--flash.delay > 0) continue
      this.pending.splice(i, 1)
      this.flashes.push(flash)
    }

    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const flash = this.flashes[i]
      if (++flash.age >= flash.life) {
        this.flashes.splice(i, 1)
        continue
      }
      // The radius stays put and only the strength falls off. An animated
      // radius makes the gradient's baked octagon crawl inward, which draws
      // the eye to the one part of a light that should go unnoticed.
      flash.intensity =
        flash.age < flash.hold
          ? flash.peak
          : flash.peak * (1 - (flash.age - flash.hold) / (flash.life - flash.hold))
    }
  }

  /** Live dynamic lights, for LightLayer to accumulate with the level's own. */
  get lights(): readonly RenderLight[] {
    return this.flashes
  }

  get isEmpty(): boolean {
    return this.flashes.length === 0 && this.pending.length === 0
  }

  clear(): void {
    this.flashes.length = 0
    this.pending.length = 0
  }
}
