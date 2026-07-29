import { Container } from 'pixi.js'

import type { GameAssets } from '../../assets/loader'
import type { RenderLight } from '../../assets/types'
import { Blood } from './Blood'
import { TickClock } from './clock'
import { DeathEffects } from './DeathEffects'
import { Explosions } from './Explosions'
import { ExplosionLights, type FlashOptions } from './lights'
import { Motes, type MoteSink } from './motes'
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
 * Almost everything the subsystem draws lives in one container, because ten of
 * the eleven explosion characters and all twenty-four gib characters carry
 * `add_front`, which puts them in front of the actor list. Inside it the order
 * is smoke and debris, then the authored fireball art, then the embers and the
 * spray: the motes frame the sprites rather than burying them.
 *
 * `decals` is the exception, and the reason is the same rule read the other
 * way. Blood on a floor is underneath everything standing on it, so the marks
 * are handed out separately for the world to place below the actors. Sitting
 * inside the world's own tree is also what gets them darkened by the lighting
 * pass, which is most of why they look like part of the level.
 */
export class EffectsSystem {
  readonly container = new Container()

  readonly particles: Particles
  readonly explosions: Explosions
  readonly gibs: DeathEffects
  readonly motes: Motes
  readonly blood: Blood

  /**
   * What the weapons spawn effects through: the authored fireball art and the
   * moving particles behind one handle, so `weapons/` needs a reference to
   * exactly one thing out of here.
   */
  readonly bursts: {
    spawn: Particles['spawn']
    motes: MoteSink
  }

  private readonly clock = new TickClock()
  private readonly flashes = new ExplosionLights()

  constructor(options: EffectsOptions) {
    this.motes = new Motes(options.terrain)
    this.blood = new Blood(options.terrain)
    this.particles = new Particles(options.assets, this.clock)
    this.gibs = new DeathEffects(options.assets, options.terrain, this.clock, this.blood)
    this.explosions = new Explosions(
      this.particles,
      this.flashes,
      this.motes,
      options.audio,
      options.targets,
    )
    this.bursts = {
      spawn: (kind, x, y, delay, fade) => this.particles.spawn(kind, x, y, delay, fade),
      motes: this.motes,
    }
    this.container.addChild(
      this.motes.behind,
      this.particles.container,
      this.gibs.container,
      this.motes.front,
      this.blood.spray,
    )
  }

  /** The blood marks, for the world to place under the actors. */
  get decals(): Container {
    return this.blood.decals
  }

  /** Call once per sim tick, anywhere in the tick. */
  update(): void {
    // Outside the clock, on the 60 Hz tick: the flashes decay rather than
    // simply expiring, and five steps of falloff staircases where twenty is
    // smooth. Everything below transcribes a lisp duration and stays at 15 Hz.
    this.flashes.advance()
    this.motes.advance()
    this.blood.advance()

    if (!this.clock.step()) return
    this.particles.advance()
    this.gibs.advance()
    this.blood.dry()
  }

  /** `alpha` is the loop's leftover fraction of a sim tick. */
  draw(alpha: number): void {
    this.particles.draw()
    this.gibs.draw(alpha)
    this.motes.draw()
    this.blood.draw(alpha)
  }

  /**
   * `(add_object EXP_LIGHT x y outer)` - the flash an explosion adds and takes
   * away again. The composers in `explosions` place their own; this is for
   * anything outside the subsystem that blows something up.
   */
  flash(x: number, y: number, outer?: number, options?: FlashOptions): void {
    this.flashes.add(x, y, outer, options)
  }

  /** Dynamic lights to draw on top of the level's static ones. */
  get lights(): readonly RenderLight[] {
    return this.flashes.lights
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
    this.motes.clear()
    this.blood.clear()
    this.clock.reset()
  }
}

export { applyBlastGlow } from './blastGlow'
export type { BlastGlow, BlastSize } from './blastGlow'
export { Blood } from './Blood'
export { SIM_TICKS_PER_TICK, TickClock } from './clock'
export { DeathEffects, gibFlavourFor } from './DeathEffects'
export type { GibFlavour, GibSet } from './DeathEffects'
export { Explosions } from './Explosions'
export { bloodFor } from './gore'
export type { BloodProfile } from './gore'
export { hurtRadius } from './hurtRadius'
export { EXPLOSION_LIGHT_RADIUS, ExplosionLights } from './lights'
export type { FlashOptions } from './lights'
export { Motes } from './motes'
export type { MoteSink, MoteSpec, MoteTemplate } from './motes'
export { Particles } from './Particles'
export { placeAnchored, placeMiddle, puffFrames } from './sprites'
export type { PuffKind } from './sprites'
export type { BlastSource, Box, Hurtable, SoundPlayer, Terrain } from './types'
