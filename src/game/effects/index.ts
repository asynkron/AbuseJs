import { Container } from 'pixi.js'

import type { GameAssets } from '../../assets/loader'
import type { LightSource } from '../../assets/types'
import { TickClock } from './clock'
import { DeathEffects } from './DeathEffects'
import { Explosions } from './Explosions'
import { ExplosionLights } from './lights'
import { Particles } from './Particles'
import type { Hurtable, SoundPlayer, Terrain } from './types'

export interface EffectsOptions {
  assets: GameAssets
  /** Level geometry, for the only things here that collide: the body parts. */
  terrain: Terrain
  audio: SoundPlayer
  /**
   * Everything a blast can catch, evaluated per call. `hurt_radius` hits every
   * hurtable object in range including the player, so this list has to include
   * the player too or half the original's behaviour goes missing.
   */
  targets: () => Iterable<Hurtable>
}

/**
 * The explosion and particle subsystem, assembled.
 *
 * Three pools and a clock. `explosions` holds the composer functions the
 * scripts call - `doExplo`, `turretDeath`, `hiddenWallBlast` and the rest;
 * `particles` holds the raw one-shot sprite actor and the smoke trails built
 * on it; `gibs` throws body parts. All of them are timed in original engine
 * ticks and stepped once every fourth sim tick (see clock.ts).
 *
 * Everything the subsystem draws lives in one container, because ten of the
 * eleven explosion characters and all twenty-four gib characters carry
 * `add_front`, which puts them in front of the actor list.
 */
export class EffectsSystem {
  readonly container = new Container()

  readonly particles: Particles
  readonly explosions: Explosions
  readonly gibs: DeathEffects

  private readonly clock = new TickClock()
  private readonly flashes = new ExplosionLights()

  constructor(options: EffectsOptions) {
    this.particles = new Particles(options.assets, this.clock)
    this.gibs = new DeathEffects(options.assets, options.terrain, this.clock)
    this.explosions = new Explosions(this.particles, this.flashes, options.audio, options.targets)
    this.container.addChild(this.particles.container, this.gibs.container)
  }

  /** Call once per sim tick, anywhere in the tick. */
  update(): void {
    if (!this.clock.step()) return
    this.particles.advance()
    this.gibs.advance()
    this.flashes.advance()
  }

  /** `alpha` is the loop's leftover fraction of a sim tick. */
  draw(alpha: number): void {
    this.particles.draw()
    this.gibs.draw(alpha)
  }

  /**
   * `(add_object EXP_LIGHT x y outer)` - the flash an explosion adds and takes
   * away again. The composers in `explosions` place their own; this is for
   * anything outside the subsystem that blows something up.
   */
  flash(x: number, y: number, outer?: number): void {
    this.flashes.add(x, y, outer)
  }

  /**
   * Dynamic lights to draw on top of the level's static ones. Empty most of
   * the time - check `hasLights` before merging so a quiet frame costs nothing.
   */
  get lights(): readonly LightSource[] {
    return this.flashes.lights
  }

  get hasLights(): boolean {
    return !this.flashes.isEmpty
  }

  /** Engine ticks since the level started, for anything wanting `(game_tick)`. */
  get tick(): number {
    return this.clock.ticks
  }

  /** On a level change: nothing here survives a reload. */
  clear(): void {
    this.particles.clear()
    this.gibs.clear()
    this.flashes.clear()
    this.clock.reset()
  }
}

export { SIM_TICKS_PER_TICK, TickClock } from './clock'
export { DeathEffects, gibFlavourFor } from './DeathEffects'
export type { GibFlavour, GibSet } from './DeathEffects'
export { Explosions } from './Explosions'
export { hurtRadius } from './hurtRadius'
export { EXPLOSION_LIGHT_RADIUS, ExplosionLights } from './lights'
export { Particles } from './Particles'
export { placeAnchored, placeMiddle, puffFrames } from './sprites'
export type { PuffKind } from './sprites'
export type { BlastSource, Box, Hurtable, SoundPlayer, Terrain } from './types'
