import type { LightSource } from '../../assets/types'

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
 */

/** `(add_object EXP_LIGHT (x) (y) 100)` - lisp/explo.lsp do_explo. */
export const EXPLOSION_LIGHT_RADIUS = 100

/** state_time 0..3 keep the light; it goes on 4 - lisp/explo.lsp explo_light. */
const FLASH_TICKS = 5

interface Flash extends LightSource {
  remaining: number
}

export class ExplosionLights {
  private readonly flashes: Flash[] = []

  /**
   * Adds a light for five ticks. Hand `lights` to the light layer alongside
   * the level's static list.
   */
  add(x: number, y: number, outer = EXPLOSION_LIGHT_RADIUS): void {
    this.flashes.push({
      x,
      y,
      inner: 1,
      outer,
      type: 0,
      xshift: 0,
      yshift: 0,
      remaining: FLASH_TICKS,
    })
  }

  advance(): void {
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      if (--this.flashes[i].remaining <= 0) this.flashes.splice(i, 1)
    }
  }

  /** Live dynamic lights, for LightLayer to accumulate with the level's own. */
  get lights(): readonly LightSource[] {
    return this.flashes
  }

  get isEmpty(): boolean {
    return this.flashes.length === 0
  }

  clear(): void {
    this.flashes.length = 0
  }
}
