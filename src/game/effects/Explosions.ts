import { applyBlastGlow, type BlastSinks, type FlareSink } from './blastGlow'
import type { ExplosionLights } from './lights'
import type { MoteSink } from './motes'
import type { Particles } from './Particles'
import { hurtRadius } from './hurtRadius'
import { random } from './random'
import { volume, type BlastSource, type Hurtable, type SoundPlayer } from './types'

/**
 * The composer functions: everything the scripts call when something blows up.
 *
 * Three of these are the original's own reusable ones - `do_explo`,
 * `do_white_explo` and `do_small_explo` in lisp/explo.lsp. The rest are the
 * hand-authored clusters the scripts inline at each site, kept as named
 * methods here because the offsets and the staggering are the effect: a
 * turret's four fireballs at delays 0,1,2,3 are what makes it look like it
 * comes apart rather than pops.
 *
 * Every method takes a world position and does the whole thing - sprites,
 * light, sound and damage - so a caller is one line.
 *
 * `do_explo`, `do_white_explo`, `do_small_explo` and the projectile impacts
 * used to live here as well, and are gone: weapons/blasts.ts has its own copy
 * of each, those are the ones with callers, and the two are not
 * interchangeable. The copy here took a `from` and spent it on `hurt_radius`'s
 * *credit* argument; the weapons' copy takes an owner and spends it on the
 * *exclude* argument, which is what stops a grenade killing the hand that
 * threw it. Only `smallCluster` stayed, because the deaths below share it.
 *
 * The light and the particles over each of these come from `applyBlastGlow`,
 * one line per site. The original lights four of them and leaves the rest
 * dark - a JUGGER dies with nothing but a sound.
 */
export class Explosions {
  /**
   * The engine's "we are behind" flag. `do_explo`, the rocket trail and the
   * gib cull all drop cosmetic work when it is set. Our loop is fixed-step and
   * never reports being behind, so this stays false and the degraded paths
   * never run; it exists so the branches read the way the original does, and
   * so a dropped-frame counter can be wired to it later.
   */
  framePanic = false

  constructor(
    private readonly puffs: Particles,
    private readonly lights: ExplosionLights,
    private readonly motes: MoteSink,
    private readonly flares: FlareSink,
    private readonly audio: SoundPlayer,
    private readonly targets: () => Iterable<Hurtable>,
  ) {
    this.sinks = {
      lights: this.lights,
      motes: this.motes,
      puffs: this.puffs,
      flares: this.flares,
    }
  }

  /** The sinks `applyBlastGlow` writes to, bundled once. */
  private readonly sinks: BlastSinks

  // ---------------------------------------------------------------- generic

  /**
   * `do_explo` (lisp/explo.lsp): GRENADE_SND, two staggered EXPLODE1
   * fireballs, a light, and the blast itself - `hurt_radius` over `radius`
   * pixels for up to `amount`, push capped at 20. `from` is the object's
   * link 0 in the script, which the mines and bombs leave empty, so their
   * blasts hurt the player and monsters alike.
   */
  doExplo(x: number, y: number, radius: number, amount: number, from: BlastSource | null = null): void {
    this.audio.playNamed('GRENADE_SND', { volume: volume(127), x, y })
    this.puffs.spawn('EXPLODE1', x + random(10), y + random(10) - 20, 0)
    this.puffs.spawn('EXPLODE1', x - random(10), y - random(10) - 20, 2)
    applyBlastGlow(this.sinks, x, y, 'large', {})
    hurtRadius(this.targets(), x, y, radius, amount, from, 20)
  }

  /**
   * The four-sprite debris cluster: three EXPLODE3 and one EXPLODE2 inside a
   * 5px box, staggered 0,2,1,2. No sound and no light.
   *
   * This is the visible half of `do_small_explo`, which nothing in the shipped
   * scripts calls - but the same four lines are inlined by hand in
   * `strait_rocket_ai` (lisp/ant.lsp) and `guner_damage` (lisp/weapons.lsp),
   * which is presumably where the function came from.
   */
  smallCluster(x: number, y: number): void {
    this.puffs.spawn('EXPLODE3', x + random(5), y + random(5), 0)
    this.puffs.spawn('EXPLODE2', x + random(5), y + random(5), 2)
    this.puffs.spawn('EXPLODE3', x - random(5), y - random(5), 1)
    this.puffs.spawn('EXPLODE3', x - random(5), y - random(5), 2)
    applyBlastGlow(this.sinks, x, y, 'small')
  }

  // ------------------------------------------------------------------ walls

  /**
   * A small hidden wall going off: one fireball, HWALL_SND, and 60 damage over
   * 50px credited to the player (lisp/doors.lsp hwall_ai).
   *
   * Note the sprite goes at x+15 whatever the wall is facing while the blast
   * goes at x + 15*direction - an inconsistency in the original, kept.
   */
  hiddenWallBlast(x: number, y: number, direction: number, from: BlastSource | null): void {
    this.puffs.spawn('EXPLODE1', x + 15, y - 7, 0)
    this.audio.playNamed('HWALL_SND', { volume: volume(127), x, y })
    applyBlastGlow(this.sinks, x + 15, y - 7, 'medium')
    hurtRadius(this.targets(), x + 15 * direction, y - 7, 50, 60, from, 20)
  }

  /**
   * A 2x2 or larger hidden wall: three simultaneous fireballs, no staggering,
   * and 120 damage over 110px (lisp/doors.lsp big_wall_ai). Since the walls
   * have 25hp each, this is what takes a whole row out at once.
   */
  bigWallBlast(x: number, y: number, from: BlastSource | null): void {
    this.puffs.spawn('EXPLODE1', x - 15, y - 7, 0)
    this.puffs.spawn('EXPLODE1', x + 15, y - 22, 0)
    this.puffs.spawn('EXPLODE1', x + random(5), y + random(5) - 20, 0)
    this.audio.playNamed('HWALL_SND', { volume: volume(127), x, y })
    // The biggest thing in the game short of the boss: 120 damage over 110px,
    // and what comes off a wall is wall, so the debris is grey and it bounces.
    applyBlastGlow(this.sinks, x, y - 15, 'huge', {
      debrisColour: 0x6f6a60,
      debrisCollides: true,
    })
    hurtRadius(this.targets(), x, y - 15, 110, 120, from, 20)
  }

  // ---------------------------------------------------------------- machines

  /**
   * Sparks off a turret on every accepted hit, at the point the shot landed
   * rather than the turret's origin (lisp/weapons.lsp guner_damage).
   */
  turretHitSparks(hitX: number, hitY: number): void {
    this.smallCluster(hitX, hitY)
  }

  /**
   * The signature machine-comes-apart effect: four fireballs at delays 0,1,2,3
   * around the hit point, over BLOWN_UP (lisp/weapons.lsp guner_damage). Used
   * by SPRAY_GUN, TRACK_GUN and WALK_ROB.
   *
   * The sprites go at the hit point and the sound at the object's origin,
   * hence both positions. BLOWN_UP is literally the same wav as GRENADE_SND
   * (lisp/sfx.lsp:117).
   */
  turretDeath(hitX: number, hitY: number, originX: number, originY: number): void {
    this.audio.playNamed('BLOWN_UP', { volume: volume(127), x: originX, y: originY })
    this.puffs.spawn('EXPLODE1', hitX - random(10), hitY - random(25), 0)
    this.puffs.spawn('EXPLODE1', hitX + random(10), hitY + random(25), 1)
    this.puffs.spawn('EXPLODE1', hitX - random(10), hitY - random(10), 2)
    this.puffs.spawn('EXPLODE1', hitX + random(10), hitY + random(10), 3)
    // Two flashes rather than one, staged on the same beat as the sprites, so
    // the light comes apart with the machine instead of firing once at the
    // front of it. A turret sparks more than it burns, hence the metal debris
    // and the thinned embers.
    applyBlastGlow(this.sinks, hitX, hitY, 'large', {
      embers: 0.6,
      debrisColour: 0x8090a0,
    })
    applyBlastGlow({ ...this.sinks, motes: null, puffs: null }, hitX, hitY, 'small', { delay: 2 })
  }

  /**
   * JUGGER and ROB1 spark differently: one small_fire puff per hit, somewhere
   * in a 20x30 box above the feet (lisp/jugger.lsp explo_damage). EXPLODE6 is
   * used nowhere else.
   */
  robotHitPuff(x: number, y: number): void {
    this.puffs.spawn('EXPLODE6', x + 10 - random(20), y - random(30), 0)
  }

  /** The killing hit on JUGGER or ROB1 (lisp/jugger.lsp explo_damage). */
  robotBlownUp(x: number, y: number): void {
    this.audio.playNamed('BLOWN_UP', { volume: volume(127), x, y })
    // For ROB1 this is the opening of an eight-fireball sequence, but for
    // JUGGER it is the entire death - the original plays the sound and draws
    // nothing whatsoever, so one of the five biggest things on the level dies
    // invisibly in a dark room.
    applyBlastGlow(this.sinks, x, y - 20, 'large', {
      debrisColour: 0x8090a0,
    })
  }

  /**
   * ROB1's death: eight fireballs at fixed offsets over six ticks, spread
   * across a 45x30 box (lisp/jugger.lsp rob1_ai aistate 1). Nothing random
   * about it - the whole pattern is authored, and it is the clearest
   * demonstration in the game of what the spawn delay is for.
   */
  rob1Death(x: number, y: number): void {
    this.puffs.spawn('EXPLODE1', x + 5, y - 10, 0)
    this.puffs.spawn('EXPLODE1', x - 5, y - 15, 2)
    this.puffs.spawn('EXPLODE1', x + 10, y - 2, 1)
    this.puffs.spawn('EXPLODE1', x - 10, y - 20, 3)
    this.puffs.spawn('EXPLODE1', x + 20, y - 27, 4)
    this.puffs.spawn('EXPLODE1', x - 25, y - 30, 2)
    this.puffs.spawn('EXPLODE1', x + 20, y - 5, 4)
    this.puffs.spawn('EXPLODE1', x - 3, y - 1, 5)
    // No base flash: `robotBlownUp` fires one at the same instant and the two
    // callers run back to back. These are the secondaries, timed to the middle
    // and the end of the eight sprites.
    applyBlastGlow(this.sinks, x, y - 15, 'small', { delay: 2 })
    applyBlastGlow(this.sinks, x, y - 15, 'small', { delay: 4 })
  }

  /**
   * The flyer's death: three fireballs on the beat, delays 0, 2 and 4
   * (lisp/flyer.lsp flyer_ai). No sound of its own and no light.
   */
  flyerDeath(x: number, y: number): void {
    this.puffs.spawn('EXPLODE1', x + random(10), y + random(10) - 20, 0)
    this.puffs.spawn('EXPLODE1', x - random(10), y - random(10) - 20, 2)
    this.puffs.spawn('EXPLODE1', x, y - random(20) - 20, 4)
    // Extra smoke: a flyer has been trailing SMALL_DARK_CLOUD the whole way
    // down, so it is already burning when it comes apart.
    applyBlastGlow(this.sinks, x, y - 20, 'medium', { smoke: 2 })
  }

  // --------------------------------------------------------------- boulders

  /**
   * A chip off a boulder that has been shot: one debris burst somewhere above
   * it (lisp/duong.lsp bold_dam).
   */
  boulderChip(x: number, y: number): void {
    this.puffs.spawn('EXPLODE3', x + 10 - random(20), y - random(30), 0)
    applyBlastGlow(this.sinks, x, y - 15, 'chip', {
      tint: 0xffffff,
      embers: 0,
      debrisColour: 0x707068,
    })
  }

  /**
   * The boulder breaking apart: four staggered fireballs, P_EXPLODE_SND and a
   * light (lisp/duong.lsp bolder_ai). The five SMALL_BOLDER chunks it also
   * throws are real objects with their own physics and damage, so they belong
   * to the caller, not here.
   */
  boulderDeath(x: number, y: number): void {
    this.audio.playNamed('P_EXPLODE_SND', { volume: volume(127), x, y })
    this.puffs.spawn('EXPLODE1', x + random(5), y + random(5), 0)
    this.puffs.spawn('EXPLODE1', x + random(5), y + random(5), 2)
    this.puffs.spawn('EXPLODE1', x - random(5), y - random(5), 1)
    this.puffs.spawn('EXPLODE1', x - random(5), y - random(5), 2)
    // Rock does not burn: no embers at all, plenty of grey chunks, and a plain
    // white flash rather than the fire tint.
    applyBlastGlow(this.sinks, x, y, 'large', {
      tint: 0xffffff,
      embers: 0,
      debrisColour: 0x707068,
      debrisCollides: true,
    })
  }

  /**
   * A boulder chunk hitting the floor: two fireballs, a pop and 15 damage over
   * 40px (lisp/duong.lsp small_rock_ai).
   */
  smallBoulderLanding(x: number, y: number, from: BlastSource | null): void {
    this.puffs.spawn('EXPLODE1', x + random(10), y + random(5) - 10, 0)
    this.puffs.spawn('EXPLODE1', x - random(10), y - random(5) - 10, 2)
    this.audio.playNamed('P_EXPLODE_SND', { volume: volume(127), x, y })
    applyBlastGlow(this.sinks, x, y - 10, 'small', {
      tint: 0xffffff,
      embers: 0,
      debrisColour: 0x707068,
    })
    hurtRadius(this.targets(), x, y, 40, 15, from, 20)
  }

  // ------------------------------------------------------------------ boss

  /**
   * The boss ant's game-over cascade: two fireballs a tick for sixty ticks,
   * with the scatter growing out of the state timer, so the blast visibly
   * expands to about 120px either side before it ends (lisp/ant.lsp boss_ai
   * aistate 10). The only place in the game where the explosion count scales
   * with time.
   *
   * Call once per engine tick with the ticks spent in the state.
   */
  bossCascade(x: number, y: number, stateTime: number): void {
    if (stateTime % 8 === 0) this.audio.playNamed('GRENADE_SND', { volume: volume(127), x, y })
    this.puffs.spawn('EXPLODE1', x + random(stateTime * 2), y + random(stateTime), 0)
    this.puffs.spawn('EXPLODE1', x - random(stateTime * 2), y - random(stateTime), 0)
    // Every fourth tick, not every tick: sixty overlapping flashes is a flat
    // white screen. The embers scale with the timer the way the scatter does.
    if (stateTime % 4 === 0) {
      applyBlastGlow(this.sinks, x, y, 'small', {
        embers: 1 + stateTime / 20,
      })
    }
  }

  // ----------------------------------------------------------- environmental

  /**
   * A lava eruption's blast, fired at state_time 5 of the eruption
   * (lisp/duong.lsp lava_ai). LAVA_SND at volume 64 is the caller's - it is
   * the one sound in the game played at less than full volume, and it belongs
   * with the eruption rather than with the damage.
   */
  lavaEruption(x: number, y: number): void {
    hurtRadius(this.targets(), x, y, 20, 20, null, 10)
  }

  /**
   * The rolling boulder's damage aura, applied every tick while it moves
   * (lisp/duong.lsp bolder_ai). No sprite - the boulder itself is the effect.
   */
  boulderAura(x: number, y: number, from: BlastSource | null): void {
    hurtRadius(this.targets(), x, y, 19, 30, from, 15)
  }
}
