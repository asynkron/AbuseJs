import type { ExplosionLights } from './lights'
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
    private readonly audio: SoundPlayer,
    private readonly targets: () => Iterable<Hurtable>,
  ) {}

  // ---------------------------------------------------------------- generic

  /**
   * `do_explo` (lisp/explo.lsp): two orange fireballs staggered by two ticks,
   * a 100px light and a damage sphere. Grenades use 40/36, rockets 40/50, the
   * air mine 40/25, bombs 40 over their jump_yvel.
   */
  doExplo(x: number, y: number, radius: number, amount: number, from: BlastSource | null): void {
    this.audio.playNamed('GRENADE_SND', { volume: volume(127), x, y })
    this.puffs.spawn('EXPLODE1', x + random(10), y + random(10) - 20, 0)
    if (!this.framePanic) {
      this.puffs.spawn('EXPLODE1', x - random(10), y - random(10) - 20, 2)
      this.lights.add(x, y)
    }
    hurtRadius(this.targets(), x, y, radius, amount, from, 20)
  }

  /**
   * `do_white_explo` (lisp/explo.lsp): the same shape with one white blast in
   * place of the two orange ones, and no second sprite at all. Only the disc
   * frisbee uses it, at 40/45 - the only use of EXPLODE8 in the game.
   */
  doWhiteExplo(x: number, y: number, radius: number, amount: number, from: BlastSource | null): void {
    this.audio.playNamed('GRENADE_SND', { volume: volume(127), x, y })
    this.puffs.spawn('EXPLODE8', x + random(10), y + random(10) - 20, 0)
    if (!this.framePanic) this.lights.add(x, y)
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
  }

  /** `do_small_explo` in full - the cluster plus its damage sphere. Unused by the original. */
  doSmallExplo(x: number, y: number, radius: number, amount: number, from: BlastSource | null): void {
    this.smallCluster(x, y)
    hurtRadius(this.targets(), x, y, radius, amount, from, 20)
  }

  // ------------------------------------------------------------- projectiles

  /**
   * The firebomb, every tick of its twenty: one fireball low and to the rear,
   * and 40 damage over 60px to everything in range (lisp/weapons.lsp
   * firebomb_ai). The bomb object itself is invisible - `fb_draw` returns nil
   * - so this is the entire thing you see.
   *
   * Call it once per engine tick while the bomb lives; it is the most damaging
   * thing in the game by a wide margin, and that is not an accident of the
   * port.
   */
  firebombTick(x: number, y: number, from: BlastSource | null): void {
    this.puffs.spawn('EXPLODE1', x - random(5), y + random(20), 0)
    hurtRadius(this.targets(), x, y, 60, 40, from, 10)
  }

  /** Plasma gun hitting terrain: one b4 burst (lisp/guns.lsp fire_object case 4). */
  plasmaTerrainImpact(x: number, y: number): void {
    this.puffs.spawn('EXPLODE5', x - random(5), y - random(5), 0)
  }

  /** Plasma gun hitting something alive. The 10 damage is the caller's to apply. */
  plasmaObjectImpact(x: number, y: number): void {
    this.puffs.spawn('EXPLODE3', x - random(5), y - random(5), 0)
  }

  /**
   * The enemy rocket hitting a wall: EG_EXPLO's four-frame flash
   * (lisp/ant.lsp strait_rocket_ai). No sound.
   *
   * EG_EXPLO also declares a `blocking` state, which is unreachable - its only
   * caller passes nil block_flags. A latent bug in the original, left alone.
   */
  enemyRocketTerrainImpact(x: number, y: number): void {
    this.puffs.spawn('EG_EXPLO', x, y, 0)
  }

  /**
   * The enemy rocket hitting something: the debris cluster, and a small blast
   * twenty pixels *below* the impact - 25px for 15, credited to nobody, and no
   * sound on this path (lisp/ant.lsp strait_rocket_ai).
   */
  enemyRocketObjectImpact(x: number, y: number): void {
    this.smallCluster(x, y)
    hurtRadius(this.targets(), x, y + 20, 25, 15, null, 10)
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
  }

  /**
   * The flyer's death: three fireballs on the beat, delays 0, 2 and 4
   * (lisp/flyer.lsp flyer_ai). No sound of its own and no light.
   */
  flyerDeath(x: number, y: number): void {
    this.puffs.spawn('EXPLODE1', x + random(10), y + random(10) - 20, 0)
    this.puffs.spawn('EXPLODE1', x - random(10), y - random(10) - 20, 2)
    this.puffs.spawn('EXPLODE1', x, y - random(20) - 20, 4)
  }

  // --------------------------------------------------------------- boulders

  /**
   * A chip off a boulder that has been shot: one debris burst somewhere above
   * it (lisp/duong.lsp bold_dam).
   */
  boulderChip(x: number, y: number): void {
    this.puffs.spawn('EXPLODE3', x + 10 - random(20), y - random(30), 0)
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
    this.lights.add(x, y)
  }

  /**
   * A boulder chunk hitting the floor: two fireballs, a pop and 15 damage over
   * 40px (lisp/duong.lsp small_rock_ai).
   */
  smallBoulderLanding(x: number, y: number, from: BlastSource | null): void {
    this.puffs.spawn('EXPLODE1', x + random(10), y + random(5) - 10, 0)
    this.puffs.spawn('EXPLODE1', x - random(10), y - random(5) - 10, 2)
    this.audio.playNamed('P_EXPLODE_SND', { volume: volume(127), x, y })
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
