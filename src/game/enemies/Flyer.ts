import type { GameAssets } from '../../assets/loader'
import type { LevelObjectData } from '../../assets/types'
import { Enemy, type Battlefield } from './Enemy'
import { bounceMove } from './motion'
import { canSee } from './raycast'
import { accel, oneIn, speed, ticks } from './tuning'
import type { EnemyOverrides, PlayerView } from './types'
import { aimAngle, shotFrom } from './weapons'

/**
 * FLYER, GREEN_FLYER and WHO - all three run `flyer_ai` (lisp/flyer.lsp, and
 * def_char WHO in lisp/jugger.lsp points at the same function; the `who_ai`
 * defined beside it is never wired up).
 *
 * It holds a band fifty to seventy pixels above the player, drifts towards
 * them, wobbles, bounces off walls, and fires bursts of whatever its aitype
 * selects. Two states and no death animation: when it runs out of health it
 * simply comes apart.
 */

const FLYER = {
  /** flyer_cons: the shipped defaults for the five tunable vars. */
  fireDelay: ticks(20),
  burstDelay: ticks(3),
  burstTotal: 2,
  maxXvel: speed(10),
  maxYvel: speed(5),

  /** One unit of velocity a tick, towards the player and as random wobble. */
  drift: accel(1),

  /** flyer_ai: the band it tries to hold above the player. */
  hoverLow: 70,
  hoverHigh: 50,

  /** Range at which it opens fire, and where the round leaves. */
  fireDistX: 150,
  muzzleX: 10,

  /** The lead, half the ants' horizontally. Original ticks, so converted. */
  leadTicksX: ticks(4),
  leadTicksY: ticks(2),
  /** The player's chest rather than their feet. */
  aimHeight: 15,

  /** FLYER_SND every five ticks while it is awake. */
  soundPeriod: ticks(5),

  /** flyer_damage kicks it upwards. */
  flinchYvel: speed(14),
} as const

/** The three characters that share the AI. */
export const FLYER_TYPES = ['FLYER', 'GREEN_FLYER', 'WHO'] as const

export class Flyer extends Enemy {
  /** Two states only: waiting to be switched on, and everything else. */
  private awake: boolean

  private readonly fireDelay: number
  private readonly burstDelay: number
  private readonly burstTotal: number
  private readonly maxXvel: number
  private readonly maxYvel: number

  private fireTime = 0
  private burstWait = 0
  private burstLeft = 0

  constructor(
    assets: GameAssets,
    data: LevelObjectData,
    objectIndex: number,
    world: Battlefield,
    overrides: EnemyOverrides = {},
  ) {
    super(assets, data, objectIndex, world)

    // art/flyer.spe's body is 24x22; the drawn frame is mostly rotor.
    this.halfWidth = 10
    this.height = 20

    // These five come from the level's saved lvars, falling back to
    // `flyer_cons`. Most flyers agree with the constructor anyway - 177 of 234
    // keep fire_delay 20, 207 keep max_xvel 10 - but the ones that do not are
    // the fast, aggressive ones the later levels are built around.
    const lvars = data.lvars ?? {}
    const fireDelay = overrides.fireDelay ?? lvars.fire_delay
    const burstDelay = overrides.burstDelay ?? lvars.burst_delay
    const maxXvel = overrides.maxXvel ?? lvars.max_xvel
    const maxYvel = overrides.maxYvel ?? lvars.max_yvel

    this.fireDelay = fireDelay ? ticks(fireDelay) : FLYER.fireDelay
    this.burstDelay = burstDelay ? ticks(burstDelay) : FLYER.burstDelay
    this.burstTotal = overrides.burstTotal ?? lvars.burst_total ?? FLYER.burstTotal
    this.maxXvel = maxXvel ? speed(maxXvel) : FLYER.maxXvel
    this.maxYvel = maxYvel ? speed(maxYvel) : FLYER.maxYvel

    this.awake = data.aistate !== 0
    this.setState(this.awake ? 'running' : 'stopped', true)
  }

  /** Dormant flyers are untargetable, which flyer_damage enforces by state. */
  get isDormant(): boolean {
    return !this.awake
  }

  protected think(player: PlayerView): boolean {
    if (!this.awake) {
      if (!this.activated || player.hidden) {
        this.setState('stopped')
        return true
      }
      // It plays its dormant animation out once before coming to life.
      if (this.nextPicture()) return true
      this.awake = true
      this.setState('running', true)
      return true
    }

    if (this.health <= 0) return false

    if (this.stateTime % FLYER.soundPeriod === 0) this.playSound('FLYER_SND')

    this.chase(player)
    this.wobble()

    if (!this.nextPicture()) this.setState('running')

    // bounce_move has already reversed the velocity by the time the stubs run,
    // and every one of the flyer's four stubs halves it - so a wall bounce
    // reverses and halves.
    if (bounceMove(this.world.level, this) !== 'none') {
      this.vx /= 2
      this.vy /= 2
    }

    this.shoot(player)
    return true
  }

  /**
   * Horizontal chase and the vertical band.
   *
   * It accelerates a unit a tick towards the player's column, and reverses
   * with the full turn animation rather than snapping round. Vertically it
   * holds a twenty-pixel band above them: below 70 it climbs, above 50 it
   * descends, so it ends up hovering just out of easy reach.
   */
  private chase(player: PlayerView): void {
    if (player.x > this.x) {
      this.vx = Math.min(this.maxXvel, this.vx + FLYER.drift)
      if (this.direction === -1) {
        this.direction = 1
        this.setState('turn_around', true)
      }
    } else if (player.x < this.x) {
      this.vx = Math.max(-this.maxXvel, this.vx - FLYER.drift)
      if (this.direction === 1) {
        this.direction = -1
        this.setState('turn_around', true)
      }
    }

    if (player.y - FLYER.hoverLow > this.y) {
      this.vy = this.vy > this.maxYvel ? this.vy - FLYER.drift : this.vy + FLYER.drift
    } else if (player.y - FLYER.hoverHigh < this.y) {
      this.vy = this.vy < -this.maxYvel ? this.vy + FLYER.drift : this.vy - FLYER.drift
    }
  }

  /**
   * The random walk laid over the chase. Note the else: the decrement is only
   * rolled for when the increment missed, so the wobble is very slightly
   * biased upwards and to the right, exactly as the script has it.
   */
  private wobble(): void {
    if (oneIn(5)) this.vx += FLYER.drift
    else if (oneIn(5)) this.vx -= FLYER.drift

    if (oneIn(5)) this.vy += FLYER.drift
    else if (oneIn(5)) this.vy -= FLYER.drift
  }

  /**
   * The burst timer.
   *
   * `fire_time` counts down between bursts and reloads `burst_left` when it
   * expires; `burst_wait` spaces the rounds inside one. With the shipped
   * burst_total of 2 that is two rounds three ticks apart, then twenty ticks
   * of quiet.
   */
  private shoot(player: PlayerView): void {
    if (this.fireTime > 0) {
      this.fireTime--
      if (this.fireTime === 0) {
        this.burstLeft = this.burstTotal
        this.burstWait = 0
      }
      return
    }

    if (this.burstWait !== 0) {
      this.burstWait--
      return
    }

    if (this.distX(player) >= FLYER.fireDistX) return
    // `(eq (direction) (facing))` - the two only disagree while the turn
    // animation is playing, so this is "not mid-turn".
    if (this.state === 'turn_around') return

    const muzzleX = this.x + this.direction * FLYER.muzzleX
    const muzzleY = this.y
    const targetX = player.x + player.vx * FLYER.leadTicksX
    const targetY = player.y - FLYER.aimHeight + player.vy * FLYER.leadTicksY
    const level = this.world.level

    if (!canSee(level, this.x, this.y, muzzleX, muzzleY)) return
    if (!canSee(level, muzzleX, muzzleY, targetX, targetY)) return

    if (this.burstLeft <= 1) this.fireTime = this.fireDelay
    else this.burstLeft--
    this.burstWait = this.burstDelay

    const angle = aimAngle(muzzleX, muzzleY, targetX, targetY)
    this.world.fire(shotFrom(this.data.aitype, muzzleX, muzzleY, angle, this))
  }

  /**
   * `flyer_damage`: immune while dormant, kicked upwards otherwise, and immune
   * to other flyers' fire - though not WHO's, which is missing from that test
   * in the script and so shoots its own kind.
   *
   * The thirty ticks of SMALL_DARK_CLOUD it should trail afterwards are not
   * here: the cloud characters are built by an eval'd def_char the converter
   * does not expand, so they are absent from chars.json.
   */
  override damage(amount: number, fromCharacter?: string): boolean {
    if (!this.awake) return false
    if (fromCharacter === 'FLYER' || fromCharacter === 'GREEN_FLYER') return false

    this.vy -= FLYER.flinchYvel
    this.trySetState('flinch_up', true)

    // The three staggered fireballs flyer_ai leaves behind are the host's,
    // which has the spawn delay the stagger needs.
    return super.damage(amount)
  }
}
