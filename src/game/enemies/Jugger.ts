import type { GameAssets } from '../../assets/loader'
import type { LevelObjectData } from '../../assets/types'
import { moveAndCollide } from '../collision'
import { Enemy, type Battlefield } from './Enemy'
import { tryMove } from './motion'
import { canSee } from './raycast'
import { speed, ticks } from './tuning'
import type { EnemyOverrides, PlayerView } from './types'
import { shotFrom } from './weapons'

/**
 * JUGGER - the walking grenade thrower (lisp/jugger.lsp, jug_ai).
 *
 * The interesting part is that it does not have a speed. It walks by sprite
 * root motion: the thirteen `rwlk` frames carry advances of 0 to 4 pixels and
 * the AI only ever calls `next_picture`, so its gait is in the art. Cliff
 * safety is a rewind rather than a look-ahead - it takes the step, and if
 * there turns out to be nothing under it, it puts itself back and falls
 * instead.
 *
 * It does no contact damage. None of its frames carry any; all it does on
 * touch is shove.
 */

const JUG = {
  /** jug_ai's first line once activated. */
  pushX: 35,
  pushY: 40,

  /** jug_ai case 1: nothing solid 5px down means the step went off an edge. */
  cliffProbe: 5,
  /** ...and how far it drops in one tick when it did. */
  fallProbe: 10,

  /** The frame the foot lands on, and where the grenade comes from. */
  stompFrame: 8,
  grenadeY: 24,

  /** jug_ai case 2: ticks of wind-up before the throw. */
  windUp: ticks(3),

  /** jug_cons's grenade launch velocity, before the level tunes it. */
  throwXvel: speed(13),
  throwYvel: speed(-10),

  /** The grenade is aitype 2 in fire_object's table, whatever the jugger's is. */
  grenadeType: 2,
} as const

/** aistate 0..3, which is genuinely a cycle: prepare, walk, throw, recover. */
type JugPhase = 'prepare' | 'walk' | 'throw' | 'recover'

const PHASE_BY_AISTATE: Record<number, JugPhase> = {
  0: 'prepare',
  1: 'walk',
  2: 'throw',
  3: 'recover',
}

export class Jugger extends Enemy {
  private phase: JugPhase
  private replay = false

  /**
   * A stationary jugger is a turret: it never walks and throws on a timer.
   * The flag is the level's saved `stationary` lvar - 21 of the 52 juggers in
   * the core levels are turrets, and treating those as walkers gave them the
   * walk cycle's fire rate instead of their own much slower one.
   */
  private readonly stationary: number

  /**
   * Ticks a stationary one waits between throws. For a JUGGER the `aitype`
   * field is not a weapon at all - def_char maps it to `jug_throw_spd` - and
   * the levels set it to 10, 15, 50 or 100.
   */
  private readonly throwPeriod: number

  private readonly throwXvel: number
  private readonly throwYvel: number

  constructor(
    assets: GameAssets,
    data: LevelObjectData,
    objectIndex: number,
    world: Battlefield,
    overrides: EnemyOverrides = {},
  ) {
    super(assets, data, objectIndex, world)

    // art/jug.spe's walk frames are around 51x45.
    this.halfWidth = 16
    this.height = 44

    // The level's saved vars are the real tuning; the constructor's values in
    // `jug_cons` are only the fallback for an object that saved none.
    const lvars = data.lvars ?? {}
    this.stationary = overrides.stationary ?? lvars.stationary ?? 0
    this.throwPeriod = ticks(data.aitype || 10)
    this.throwXvel = speed(overrides.throwXvel ?? lvars.throw_xvel ?? 13)
    this.throwYvel = speed(overrides.throwYvel ?? lvars.throw_yvel ?? -10)

    this.phase = PHASE_BY_AISTATE[data.aistate] ?? 'prepare'
  }

  /**
   * The walk is in the frames, so the root motion has to collide. Entity's
   * version just translates, which walks a jugger into walls.
   */
  protected override applyRootMotion(dx: number): void {
    moveAndCollide(this.world.level, this, dx, 0)
  }

  protected think(player: PlayerView): boolean {
    // An unactivated jugger is untargetable and does nothing at all.
    if (!this.activated) return true

    this.pushChar(player, JUG.pushX, JUG.pushY)

    let passes = 2
    do {
      this.replay = false
      this.dispatch(player)
    } while (this.replay && passes-- > 0)

    return true
  }

  private dispatch(player: PlayerView): void {
    switch (this.phase) {
      case 'prepare':
        return this.prepare()
      case 'walk':
        return this.walk(player)
      case 'throw':
        return this.throwGrenade()
      case 'recover':
        return this.recover()
    }
  }

  private setPhase(phase: JugPhase): void {
    this.phase = phase
    this.stateTime = 0
  }

  private goPhase(phase: JugPhase): void {
    this.setPhase(phase)
    this.replay = true
  }

  private prepare(): void {
    if (this.stationary === 0) {
      this.setState('running')
      this.goPhase('walk')
      return
    }
    if (this.stateTime > this.throwPeriod) {
      this.setState('weapon_fire')
      this.setPhase('throw')
    }
  }

  /**
   * One frame of the walk cycle, then the cliff rewind. The stomp lands on
   * frame 8 and again as the cycle wraps, which is also when it stops to
   * throw - so a jugger fires once per full stride.
   */
  private walk(player: PlayerView): void {
    if (this.stationary !== 0) {
      if (this.stateTime > this.throwPeriod) {
        this.setState('weapon_fire')
        this.setPhase('throw')
      }
      return
    }

    this.direction = this.toward(player)

    const wasX = this.x
    const wasY = this.y

    if (this.nextPicture()) {
      if (this.frameJustAdvanced && this.pictureAt === JUG.stompFrame) {
        this.playSound('JSTOMP_SND')
      }
    } else {
      this.playSound('JSTOMP_SND')
      this.setState('weapon_fire')
      this.setPhase('throw')
    }

    if (canSee(this.world.level, this.x, this.y, this.x, this.y + JUG.cliffProbe)) {
      this.x = wasX
      this.y = wasY
      tryMove(this.world.level, this, 0, JUG.fallProbe)
    }
  }

  /**
   * The throw.
   *
   * The original adds a real GRENADE object and then *overwrites* its velocity
   * with (throw_xvel * direction, throw_yvel), so the grenade is lobbed rather
   * than launched: 13 across and 10 up in the original's units, against the 20
   * `fire_object` would have given it. The velocity goes along with the shot so
   * the projectile system uses it instead of deriving one from the angle.
   */
  private throwGrenade(): void {
    if (this.stateTime <= JUG.windUp) {
      this.nextPicture()
      return
    }

    const vx = this.throwXvel * this.direction
    const vy = this.throwYvel
    const angle = (Math.atan2(-vy, vx) * 180) / Math.PI

    this.playSound('GRENADE_THROW')
    this.world.fire({
      ...shotFrom(JUG.grenadeType, this.x, this.y - JUG.grenadeY, angle, this),
      velocity: { vx, vy },
    })
    this.goPhase('recover')
  }

  private recover(): void {
    if (!this.nextPicture()) this.setPhase('prepare')
  }

  /**
   * `explo_damage`, shared with ROB1: a puff on every hit, no knockback at
   * all, and the grenade explosion sound when it finally goes down.
   */
  override damage(amount: number): boolean {
    if (this.isDying || this.isDead) return false

    this.world.explode(this.x + 10 - Math.random() * 20, this.y - Math.random() * 30, 'sparks')

    // Prop steps a multi-frame object through its frames as it loses health,
    // which is right for a cracking wall and wrong for a walking animation -
    // it would teleport the jugger, since its walk is root motion. Put the
    // cursor back where it was.
    const frame = this.pictureAt
    // BLOWN_UP belongs to the host's death effect, which plays it along with
    // the rest of `explo_damage`'s send-off.
    const killed = super.damage(amount)
    if (!killed) this.setPicture(frame)
    return killed
  }
}
