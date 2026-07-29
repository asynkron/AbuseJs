/**
 * Everything the projectiles need from the rest of the game, as one interface.
 *
 * Deliberately narrow: the subsystem owns movement, timing, damage numbers and
 * its own art, and asks the host only for the things that belong to the world -
 * who is hittable, how damage is applied, and how a sound gets played.
 */

import type { ProjectileLevel, ProjectileOwner, ProjectileTarget } from './bmove'

export interface ProjectileHost {
  /** Tile collision. `Level` satisfies `ProjectileLevel` as it stands. */
  readonly level: ProjectileLevel

  /**
   * Everything a shot can hit this tick, the player included. The original's
   * `bmove` hits whatever is in the way and only spares the shooter, which is
   * why an ant can catch another ant's fire.
   */
  targets(): readonly ProjectileTarget[]

  /** `do_damage(amount, victim, push_xvel, push_yvel)` - directed damage. */
  damage(target: ProjectileTarget, amount: number, pushX: number, pushY: number): void

  /**
   * `hurt_radius(x, y, radius, amount, exclude, max_push)`. The falloff curve
   * is not in the lisp - it is engine-side - so the host owns that choice.
   */
  hurtRadius(
    x: number,
    y: number,
    radius: number,
    amount: number,
    exclude: ProjectileOwner | null,
    maxPush: number,
  ): void

  /** `(play_sound NAME 127 (x) (y))`, by the lisp symbol. */
  playSound(name: string, x: number, y: number): void

  /**
   * The crosshair in world coordinates - `player_pointer_x` / `_y`. The disc
   * frisbee and the death ray steer by the live pointer, not by a stored
   * angle. Null when there is no local player to read it from.
   */
  pointer(): { x: number; y: number } | null

  /**
   * `(add_object EXP_LIGHT (x) (y) 100)` - a dynamic light of `outer` radius
   * for `ticks` ticks. Optional: without it explosions simply do not flash.
   */
  addLight?(x: number, y: number, outer: number, ticks: number): void

  /**
   * `(frame_panic)` - "frames are being dropped, skip the cosmetics". Every
   * smoke and light spawn in the original is guarded by it. Defaults to false.
   */
  frameSkip?(): boolean
}

export type { ProjectileLevel, ProjectileOwner, ProjectileTarget } from './bmove'
