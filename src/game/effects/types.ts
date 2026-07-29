/**
 * Shared vocabulary for the explosion and particle subsystem.
 *
 * Abuse has no particle system. Every explosion, puff of smoke and flying body
 * part is an ordinary game object with a one-shot animation whose ai function
 * returns nil when the animation runs out (lisp/explo.lsp). What follows is
 * that idea with the object bookkeeping stripped out: pools of short-lived
 * sprites, plus the composer functions the scripts call to arrange them.
 *
 * Nothing in here reaches into the world. Everything the subsystem needs from
 * the game arrives through the four interfaces below, so wiring it up is a
 * constructor call and nothing else.
 */

/**
 * An axis-aligned box in the engine's convention: `x` is the anchor column and
 * `y` is the feet. Deliberately the same shape as `Body` in collision.ts, so
 * `isBlocked` can be handed straight over without an adapter.
 */
export interface Box {
  x: number
  y: number
  halfWidth: number
  height: number
}

/** Level geometry, as much of it as flying debris needs to know about. */
export interface Terrain {
  /** True when the box overlaps something solid. */
  isBlocked(box: Box): boolean
}

/**
 * The original's `from` argument: whatever is credited with a piece of damage.
 * Kills are attributed to it, and `get_dead_part` reads its otype to choose
 * the flavour of gib the victim comes apart into (lisp/ant.lsp).
 */
export interface BlastSource {
  /** Character name of the object that dealt the damage, e.g. `ROCKET`. */
  readonly type: string
  /** Set when the player should be credited with the kill. */
  readonly fromPlayer?: boolean
}

/**
 * Anything `hurt_radius` can catch. The original walks every hurtable active
 * object, the player included - that is why standing next to your own grenade
 * costs you health, and why one hidden wall going off sets off its neighbours.
 */
export interface Hurtable {
  readonly x: number
  readonly y: number
  readonly height: number
  /**
   * Applies damage already scaled for distance, plus a knockback impulse in
   * pixels per engine tick.
   */
  hurt(amount: number, from: BlastSource | null, pushX: number, pushY: number): void
}

/** Just enough of AudioBank to play a sound by its lisp symbol. */
export interface SoundPlayer {
  playNamed(name: string, options: { volume?: number; x?: number; y?: number }): void
}

/**
 * The scripts pass volumes on a 0..127 scale - `(play_sound GRENADE_SND 127
 * (x) (y))` is full volume (lisp/explo.lsp do_explo). AudioBank works in
 * 0..1.
 */
export const FULL_VOLUME = 127

export function volume(lispVolume: number): number {
  return lispVolume / FULL_VOLUME
}
