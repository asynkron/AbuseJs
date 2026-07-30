import type { GameAssets } from '../../assets/loader'
import type { LevelObjectData } from '../../assets/types'
import { isGrounded } from '../collision'
import { Enemy, type Battlefield } from './Enemy'
import {
  moveCharacter,
  noFallMove,
  probeMove,
  roofAbove,
  tryMove,
  willFallIfJump,
  type MoveAbilities,
} from './motion'
import { canSee, eyeY, seeDist } from './raycast'
import { DIFFICULTY, GRAVITY, accel, oneIn, random, speed, ticks } from './tuning'
import type { EnemyOverrides, PlayerView } from './types'
import { aimAngle, ammoFor, shotFrom } from './weapons'

/**
 * ANT_ROOF - the whole ant.
 *
 * There is no separate ground ant in Abuse: one character hangs from the
 * ceiling, drops, runs, pounces, dodges, jumps back up to the roof and shoots
 * from either surface, and the "ground ant" is this one in aistate 2. Levels
 * save it in eight different aistates, so any of those is a legal starting
 * pose (lisp/ant.lsp, ant_ai).
 *
 * The AI sits inside a `/* this code has been compiled *\/` block in the
 * script - the original moved it into C++ for speed and kept the Lisp as the
 * readable copy - which makes it the spec rather than dead code.
 */

/** Everything the ant AI reads, with where each number comes from. */
const ANT = {
  /** abilities in def_char ANT_ROOF. */
  runTopSpeed: speed(7),
  startAccel: accel(20),
  stopAccel: accel(20),
  jumpYvel: speed(-4),
  /**
   * `will_fall_if_jump`'s look-ahead: |jump_yvel| * jump_xvel = 4 * 20. It is
   * already a distance in pixels, so it is not converted.
   */
  jumpReach: 80,

  /** push_char 30 20, the first line of ant_ai. */
  pushX: 30,
  pushY: 20,

  /** aistates 15 and 16: how close before a hanging ant lets go. */
  wakeDistX: 130,

  /** aistate 2: the ground firing window and the roll to take the shot. */
  fireDistX: 180,
  fireDistY: 100,
  /** aistate 2: the pounce band. */
  pounceNear: 10,
  pounceFar: 100,
  /** aistate 2: closes with a leap rather than a walk beyond this. */
  leapDistX: 140,

  /** not_ant_congestion: the box searched ahead for another ant. */
  congestionNear: 23,
  congestionFar: 30,
  congestionY: 20,

  /** aistate 9: 2px of clear air below means fall again rather than run. */
  landingProbe: 2,

  /** roof_above: a ceiling within this is worth jumping to. */
  roofProbe: 120,

  /** aistates 12 and 13 measure the ant's head this far above its feet. */
  headHeight: 31,

  /** aistate 13: stop and shoot downwards. */
  ceilFireDistX: 120,
  /** aistate 13: lined up closely enough to drop straight onto the player. */
  ceilDropDistX: 10,

  /** fire_at_player: the muzzle, relative to the anchor. */
  muzzleX: 15,
  muzzleY: 15,
  /**
   * fire_at_player leads the target by 8 ticks of the player's horizontal
   * speed and 2 of their vertical. Those are original ticks, so they stretch
   * to ours; the pixel distance the lead works out to stays the same.
   */
  leadTicksX: ticks(8),
  leadTicksY: ticks(2),

  /** ant_dodge: the jump back up to the ceiling, and the sideways evade. */
  dodgeRoofYvel: speed(-17),
  dodgeLongYvel: speed(-12),
  dodgeLongXvel: speed(20),

  /** scream_check: ticks of lost sight before re-acquiring screams again. */
  screamGap: ticks(20),
  /** ant_cons seeds this so the very first sighting screams. */
  noSeeTimeInit: 300,

  /**
   * Contact damage, from the `dive` figure's hitDamage in art/ant.spe. It is
   * the only ant frame that carries any, so an ant hurts on touch while it is
   * airborne mid-pounce and at no other time. tools/convert.ts drops the
   * per-frame damage table, hence the constant here.
   */
  contactDamage: 4,
} as const

/**
 * Whether a wounded ant ever recovers. See the flinch branch in `think`: the
 * original's never does.
 */
const STUN_IS_PERMANENT = true

/** ant_ct: health per variant, applied when the level saved none. */
const HP_BY_AITYPE = [15, 50, 25, 35, 35, 20]

/** The three frames that use the `dive` picture, and so hurt on contact. */
const DIVE_STATES = new Set(['run_jump', 'run_jump_fall', 'start_run_jump'])

const ABILITIES: MoveAbilities = {
  runTopSpeed: ANT.runTopSpeed,
  startAccel: ANT.startAccel,
  stopAccel: ANT.stopAccel,
  jumpYvel: ANT.jumpYvel,
}

/**
 * The aistate ladder as a state union.
 *
 * `finishing` is aistate 9, which the script calls the "general finish
 * animation state": both the landing and the turn-around end up there, and it
 * decides between falling again and starting to run.
 */
export type AntPhase =
  | 'hanging'
  | 'hiding'
  | 'falling'
  | 'finishing'
  | 'running'
  | 'pounceWait'
  | 'leaping'
  | 'groundFire'
  | 'climbing'
  | 'ceilingWalk'
  | 'ceilingFire'

/** What the levels store, and what each saved value means. */
const PHASE_BY_AISTATE: Record<number, AntPhase> = {
  1: 'falling',
  2: 'running',
  4: 'pounceWait',
  6: 'leaping',
  8: 'groundFire',
  9: 'finishing',
  12: 'climbing',
  13: 'ceilingWalk',
  14: 'ceilingFire',
  15: 'hanging',
  16: 'hiding',
}

/** The animation each phase rests in, for putting one back after a flinch. */
const PHASE_STATE: Record<AntPhase, string> = {
  hanging: 'hanging',
  hiding: 'hiding',
  falling: 'falling',
  finishing: 'landing',
  running: 'running',
  pounceWait: 'pounce_wait',
  leaping: 'run_jump',
  groundFire: 'fire_wait',
  climbing: 'jump_up',
  ceilingWalk: 'top_walk',
  ceilingFire: 'ceil_fire',
}

export class Ant extends Enemy {
  private phase: AntPhase
  /** Set to re-run the ladder this same tick - the script's `go_state`. */
  private replay = false

  /** The three lisp vars ANT_ROOF declares. */
  private needToDodge = false
  private noSeeTime: number = ANT.noSeeTimeInit
  private readonly hideFlag: 0 | 1

  /** Two frames of stun after a hit, during which the ladder does not run. */
  private flinching = false

  constructor(
    assets: GameAssets,
    data: LevelObjectData,
    objectIndex: number,
    world: Battlefield,
    overrides: EnemyOverrides = {},
  ) {
    super(assets, data, objectIndex, world)

    // From art/ant.spe's 48x29 walk frame, pulled in because the frame
    // includes the legs it stands on rather than just the body.
    this.halfWidth = 10
    this.height = 24

    this.hideFlag = overrides.hideFlag ?? 0

    // ant_ct sets health from the aitype. ANT_ROOF also carries force_health,
    // which means a level's saved hp wins - and every ant in the core levels
    // saves one, including values like 75 that no aitype produces.
    if (!data.hp) this.health = HP_BY_AITYPE[data.aitype] ?? this.health

    this.phase = PHASE_BY_AISTATE[data.aistate] ?? (this.hideFlag ? 'hiding' : 'hanging')
    this.trySetState(PHASE_STATE[this.phase], true)
  }

  /** Nothing can touch an ant while it is still hanging on the ceiling. */
  get isDormant(): boolean {
    return this.phase === 'hanging' || this.phase === 'hiding'
  }

  /* ---------------------------------------------------------------- */

  protected think(player: PlayerView): boolean {
    this.pushChar(player, ANT.pushX, ANT.pushY)

    if (this.flinching) {
      const playing = this.nextPicture()
      // And that is the whole of it: there is no way out of this branch.
      //
      // Both copies of ant_ai dead-end here - the lisp spec at ant.lsp:184 and
      // the compiled `src/ant.cpp:144-148`, which discards next_picture's
      // return and just re-enters every tick - and `ant_damage` sets one of the
      // two flinch states on *every* non-lethal hit (ant.lsp:407-409). So in
      // the shipped game a single non-lethal shot neutralises an ant for good:
      // it stands in its wince pose, out of the fight, until something finishes
      // it. That reads like a bug in the original rather than a design, but it
      // is what the original does, so it is what this does.
      //
      // Flip STUN_IS_PERMANENT to false to get the two-frame stun the port used
      // to have, which is much harder and much less faithful.
      if (!STUN_IS_PERMANENT && !playing) {
        this.flinching = false
        this.trySetState(PHASE_STATE[this.phase], true)
      }
      return true
    }

    // `go_state` acts in the same tick rather than the next one, so the ladder
    // may run more than once. Three passes covers the longest chain the script
    // has (4 -> 6, 13 -> 14, 9 -> 2).
    let passes = 3
    do {
      this.replay = false
      this.dispatch(player)
    } while (this.replay && passes-- > 0)

    if (DIVE_STATES.has(this.state) && this.touching(player)) {
      this.touchDamage(ANT.contactDamage)
    }

    return true
  }

  private dispatch(player: PlayerView): void {
    switch (this.phase) {
      case 'hanging':
        return this.hang(player)
      case 'hiding':
        return this.hide(player)
      case 'falling':
        return this.fall(player)
      case 'finishing':
        return this.finishAnimation()
      case 'running':
        return this.run(player)
      case 'pounceWait':
        return this.pounceWait()
      case 'leaping':
        return this.leap()
      case 'groundFire':
        return this.groundFire(player)
      case 'climbing':
        return this.climb()
      case 'ceilingWalk':
        return this.ceilingWalk(player)
      case 'ceilingFire':
        return this.ceilingFire(player)
    }
  }

  /** `set_aistate`: takes effect next tick. */
  private setPhase(phase: AntPhase): void {
    this.phase = phase
    this.resetStateTime()
  }

  /** `go_state`: takes effect now, in this tick. */
  private goPhase(phase: AntPhase): void {
    this.setPhase(phase)
    this.replay = true
  }

  /* ---------------------------------------------------------------- */
  /* waking up - aistates 15 and 16                                    */
  /* ---------------------------------------------------------------- */

  private hang(player: PlayerView): void {
    if (!this.nextPicture()) this.setState('hanging')
    if (this.shouldWake(player)) this.drop(player)
  }

  private hide(player: PlayerView): void {
    this.setState('hiding')
    if (this.shouldWake(player)) this.drop(player)
  }

  /**
   * The wake test both dormant states share: an unlinked ant waits for the
   * player to come within 130px *and* to be below it, a linked one waits for
   * its sensor.
   */
  private shouldWake(player: PlayerView): boolean {
    const links = this.linkedObjects
    if (links.length > 0) return this.world.isSignalOn(links[0])
    if (player.hidden) return false
    return this.distX(player) < ANT.wakeDistX && this.y < player.y
  }

  private drop(player: PlayerView): void {
    this.setState('fall_start')
    this.direction = this.toward(player)
    this.setPhase('falling')
  }

  /* ---------------------------------------------------------------- */
  /* coming down - aistates 1 and 9                                    */
  /* ---------------------------------------------------------------- */

  private fall(player: PlayerView): void {
    this.setState('falling')
    this.screamCheck(player)

    const blocked = moveCharacter(this.world.level, this, ABILITIES, 0, false, true)
    if (blocked.down) {
      this.vy = 0
      this.setState('landing')
      this.playSound('ALAND_SND')
      this.setPhase('finishing')
    }
  }

  /**
   * aistate 9: hold until the current animation runs out, then either fall
   * again or start running. Both the landing and the turn-around end here,
   * which is why it is written as a general finisher.
   */
  private finishAnimation(): void {
    if (this.nextPicture()) return

    if (probeMove(this.world.level, this, 0, ANT.landingProbe)) {
      this.setPhase('falling')
      return
    }

    this.setState('stopped')
    this.goPhase('running')
  }

  /* ---------------------------------------------------------------- */
  /* the ground - aistates 2, 4, 6 and 8                               */
  /* ---------------------------------------------------------------- */

  private run(player: PlayerView): void {
    this.screamCheck(player)
    if (oneIn(20)) this.needToDodge = true
    if (this.dodge()) return

    if (!this.facingPlayer(player)) {
      this.direction = this.toward(player)
      this.setState('turn_around')
      this.setPhase('finishing')
      return
    }

    this.nextPicture()

    const distX = this.distX(player)

    if (oneIn(5) && distX < ANT.fireDistX && this.distY(player) < ANT.fireDistY && this.canHitPlayer(player)) {
      this.setState('weapon_fire')
      this.setPhase('groundFire')
      return
    }

    if (distX < ANT.pounceFar && distX > ANT.pounceNear && oneIn(5)) {
      this.setPhase('pounceWait')
      return
    }

    if (distX > ANT.leapDistX && this.roomToAdvance() && !this.wouldLeapIntoAPit()) {
      this.setPhase('leaping')
      return
    }

    // Plain walking. An ant with another one just ahead of it does not move at
    // all - it does not turn either - so a column of ants queues rather than
    // piling into one another.
    if (!this.roomToAdvance()) return

    const airborne = !isGrounded(this.world.level, this)
    const blocked = noFallMove(this.world.level, this, ABILITIES, this.direction, airborne)
    if (this.direction > 0 ? blocked.right : blocked.left) {
      this.direction = -this.direction as 1 | -1
    }
  }

  /** aistate 4: hold the crouch, then lunge. */
  private pounceWait(): void {
    if (this.dodge()) return

    this.setState('pounce_wait')
    moveCharacter(this.world.level, this, ABILITIES, 0, false, true)

    if (this.stateTime > DIFFICULTY.pounceWaitTicks) {
      this.playSound('ASLASH_SND')
      this.setState('stopped')
      this.goPhase('leaping')
    }
  }

  /** aistate 6: in the air with the jump held until something is underfoot. */
  private leap(): void {
    this.needToDodge = false
    const blocked = moveCharacter(this.world.level, this, ABILITIES, this.direction, true, true)
    if (blocked.down) {
      this.vy = 0
      this.setPhase('running')
    }
  }

  /**
   * aistate 8: three frames of `fire_wait`, then the shot.
   *
   * fire_at_player finishes by setting weapon_fire, and this immediately
   * overwrites it with stopped - so the four-frame muzzle flash is on screen
   * for exactly the one tick in aistate 2 that decided to shoot.
   */
  private groundFire(player: PlayerView): void {
    if (this.dodge()) return

    if (this.state !== 'fire_wait') {
      this.setState('fire_wait')
      return
    }

    if (this.nextPicture()) return

    this.fireAtPlayer(player)
    this.setState('stopped')
    this.setPhase('running')
  }

  /* ---------------------------------------------------------------- */
  /* the ceiling - aistates 12, 13 and 14                              */
  /* ---------------------------------------------------------------- */

  /**
   * aistate 12: the climb back up.
   *
   * It probes upwards from its own head rather than moving and testing,
   * because the answer it needs is "did I touch something on the way": having
   * touched while still rising means it has reached the roof, and having
   * touched while already falling means the jump failed.
   */
  private climb(): void {
    this.needToDodge = false
    this.setState('jump_up')
    this.vy += GRAVITY
    // The script sets xacel rather than xvel to zero. With no acceleration
    // state to clear, killing the velocity is the nearest equivalent, and it
    // keeps the climb vertical, which is the point of it.
    this.vx = 0

    const top = this.y - ANT.headHeight
    const risingBefore = this.vy
    const newTop = top + this.vy

    const clear = seeDist(this.world.level, this.x, top, this.x, newTop)
    tryMove(this.world.level, this, 0, clear.y - top)

    if (Math.abs(clear.y - newTop) < 0.5) return

    if (risingBefore > 0) {
      this.setState('stopped')
      this.setPhase('running')
    } else {
      this.vy = 0
      this.setState('top_walk')
      this.setPhase('ceilingWalk')
    }
  }

  /** aistate 13: upside down, walking towards the player. */
  private ceilingWalk(player: PlayerView): void {
    this.screamCheck(player)

    const overhead = this.y < player.y && this.distX(player) < ANT.ceilDropDistX && oneIn(8)
    if (overhead || this.needToDodge) {
      this.setState('run_jump')
      this.goPhase('leaping')
      return
    }

    if (!this.facingPlayer(player)) this.direction = -this.direction as 1 | -1

    if (this.distX(player) < ANT.ceilFireDistX && oneIn(5)) {
      this.setState('ceil_fire')
      this.goPhase('ceilingFire')
      return
    }

    // Step along the roof by hand - no physics, since it is hanging from it.
    // Two tests have to pass: the path is clear, and there is still something
    // to grip one pixel above the destination.
    const step = ANT.runTopSpeed * this.direction
    const head = this.y - ANT.headHeight
    const level = this.world.level
    const pathClear = canSee(level, this.x, head, this.x + step, head)
    const stillCeiling = !canSee(level, this.x + step, head, this.x + step, head - 1)

    if (pathClear && stillCeiling) {
      this.x += step
      if (!this.nextPicture()) this.setState('top_walk')
      return
    }

    this.setPhase('falling')
  }

  /** aistate 14: three frames of `ceil_fire`, then the shot straight down. */
  private ceilingFire(player: PlayerView): void {
    if (this.nextPicture()) return
    this.fireAtPlayer(player)
    this.setState('top_walk')
    this.setPhase('ceilingWalk')
  }

  /* ---------------------------------------------------------------- */
  /* dodging                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * `ant_dodge`: one of three evasions, taken whenever the flag is up - which
   * every hit sets, plus a 1-in-20 roll while running. Returns true when it
   * acted, which ends the caller's tick.
   */
  private dodge(): boolean {
    if (!this.needToDodge) return false
    this.needToDodge = false

    if (random(2) === 1) {
      this.setState('stopped')
      this.goPhase('leaping')
      return true
    }

    if (roofAbove(this.world.level, this.x, this.y, ANT.roofProbe)) {
      this.vy = ANT.dodgeRoofYvel
      this.vx = 0
      this.goPhase('climbing')
      return true
    }

    this.vy = ANT.dodgeLongYvel
    this.vx = this.direction * ANT.dodgeLongXvel
    this.setPhase('leaping')
    return true
  }

  /* ---------------------------------------------------------------- */
  /* senses and shooting                                               */
  /* ---------------------------------------------------------------- */

  /**
   * `scream_check`: shout on acquiring the player, and again once the sight
   * has been lost for twenty ticks and regained. Never more often than that,
   * which is what keeps a room of ants from becoming one continuous noise.
   */
  private screamCheck(player: PlayerView): void {
    if (canSee(this.world.level, this.x, eyeY(this.y), player.x, eyeY(player.y), this.world.sightBlockers(this))) {
      if (this.noSeeTime === 0 || this.noSeeTime > ANT.screamGap) this.playSound('ASCREAM_SND')
      this.noSeeTime = 1
    } else {
      this.noSeeTime++
    }
  }

  private get muzzle(): { x: number; y: number } {
    return { x: this.x + this.direction * ANT.muzzleX, y: this.y - ANT.muzzleY }
  }

  /** `can_hit_player`: the cheap pre-test, against the player's chest. */
  private canHitPlayer(player: PlayerView): boolean {
    const muzzle = this.muzzle
    return canSee(this.world.level, muzzle.x, muzzle.y, player.x, player.y - ANT.muzzleY, this.world.sightBlockers(this))
  }

  /**
   * `fire_at_player`: lead the target, check the line twice - once from the
   * body to its own muzzle, once from the muzzle to where the player will be -
   * and fire whatever the aitype selects.
   */
  private fireAtPlayer(player: PlayerView): void {
    const muzzle = this.muzzle
    const level = this.world.level
    const targetX = player.x + player.vx * ANT.leadTicksX
    const targetY = player.y - ANT.muzzleY + player.vy * ANT.leadTicksY

    if (!canSee(level, this.x, eyeY(this.y), muzzle.x, muzzle.y, this.world.sightBlockers(this))) return
    if (!canSee(level, muzzle.x, muzzle.y, targetX, targetY, this.world.sightBlockers(this))) return

    const angle = aimAngle(muzzle.x, muzzle.y, targetX, targetY)
    this.world.fire(shotFrom(this.data.aitype, muzzle.x, muzzle.y, angle, this))
  }

  /** `not_ant_congestion`: is the space just ahead already taken? */
  private roomToAdvance(): boolean {
    const near = this.x + this.direction * ANT.congestionNear
    const far = this.x + this.direction * ANT.congestionFar
    return !this.world.anyIn(
      'ANT_ROOF',
      Math.min(near, far),
      this.y - ANT.congestionY,
      Math.max(near, far),
      this.y + ANT.congestionY,
    )
  }

  private wouldLeapIntoAPit(): boolean {
    return willFallIfJump(this.world.level, this, this.direction, ANT.jumpReach)
  }

  /* ---------------------------------------------------------------- */
  /* damage                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * `ant_damage`.
   *
   * Refused outright while hanging, so an ant on the ceiling cannot be shot
   * awake - only a hiding one can. Ants cannot hurt each other either: the
   * test walks the projectile's creator and refuses when that is another ant.
   */
  override damage(amount: number, fromCharacter?: string): boolean {
    if (this.isDying || this.isDead) return false
    if (fromCharacter === 'ANT_ROOF') return false
    if (this.phase === 'hanging') return false

    this.setState(random(2) === 0 ? 'flinch_up' : 'flinch_down', true)
    this.flinching = true

    const killed = super.damage(amount)
    this.playSound('APAIN_SND')
    this.needToDodge = true

    if (killed) {
      this.flinching = false
      this.die()
    }
    return killed
  }

  private die(): void {
    this.playSound(this.data.aitype === 0 ? 'ASML_DEATH' : 'ALRG_DEATH')

    // `create_dead_parts` throws five body parts here. They belong to the
    // host, which spawns them from the kill along with everything else's
    // death effect - an ant gets no explosion at all, only the parts.
    this.dropAmmo()
  }

  /**
   * The ammo drop, which reads oddly but is: on a 1-in-8 roll take the upgrade
   * branch, which itself drops the next tier up only 1 time in 4 and otherwise
   * nothing; the other 7 times in 8 drop this ant's own tier. On `hard` that
   * comes out at 87.5% own tier, 3.1% one better, 9.4% nothing at all.
   */
  private dropAmmo(): void {
    if (oneIn(DIFFICULTY.ammoDropDivisor)) {
      if (oneIn(4)) this.world.dropPickup?.(ammoFor(this.data.aitype + 1), this.x, this.y)
      return
    }
    this.world.dropPickup?.(ammoFor(this.data.aitype), this.x, this.y)
  }
}
