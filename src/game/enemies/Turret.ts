import type { GameAssets } from '../../assets/loader'
import type { LevelObjectData } from '../../assets/types'
import { frameForAngle, normalizeAngle } from '../weapons/angles'
import { Enemy, type Battlefield } from './Enemy'
import { random, ticks } from './tuning'
import type { PlayerView } from './types'
import { shotFrom } from './weapons'

/**
 * The two wall guns - SPRAY_GUN and TRACK_GUN, lisp/guns.lsp.
 *
 * They share a character: `art/gun2.spe`, a 24-frame barrel that points
 * wherever `set_frame_angle` puts it, folded away behind a two-frame shutter
 * when the gun is off. Both wait on `(activated)`, so a level wires them to a
 * sensor, a switch or a gate and they come out when it goes non-zero.
 *
 * They are the commonest hostile thing in the game after the ants - fifteen in
 * level01, twenty in level03 - and they are what makes a corridor a corridor.
 *
 * What they are not is a creature. Neither has a hunt, a walk or a retreat:
 * the spray gun sweeps a fixed arc regardless of where anybody is standing,
 * and the track gun turns towards the player one degree a tick and fires when
 * it has more or less arrived. Both live in this file because everything they
 * do differently is in `think`, and everything else - the shutter, the angle
 * frames, the shared damage handler - is the same gun.
 */

/** `spray_gun_cons` and `track_cons`. The levels override these through their
 *  lvars block, which the converter does not read yet, so these are what every
 *  gun in the game runs on for now. */
const SPRAY = {
  fireDelay: ticks(4),
  angleSpeed: 10,
  startAngle: 270,
  endAngle: 350,
} as const

const TRACK = {
  turnSpeed: 1,
  fireDelay: ticks(5),
  burstTotal: 3,
  continueTime: ticks(8),
  startAngle: 180,
  endAngle: 359,
  /** `(< angle_add 5)` - close enough to the player to pull the trigger. */
  aimTolerance: 5,
  /** `(mod (+ angle (- 2 (random 5))) 360)` - the scatter on each round. */
  spread: 5,
} as const

/**
 * `(and (< (distx) 450) (< (disty) 400))` - the spray gun does nothing at all
 * beyond this, whatever its sensor says. The track gun has no such test.
 */
const SPRAY_RANGE_X = 450
const SPRAY_RANGE_Y = 400

/** Where the muzzle sits relative to the pivot, per `spray_fire`/`track_fire`. */
const SPRAY_MUZZLE = { reach: 20, rise: 22, drop: 21 }
const TRACK_MUZZLE = { reach: 18, rise: 15, drop: 15 }

/** The spray gun's phases - aistate 0, 1, 3 and 4. 2 folds up and is unreachable. */
type SprayPhase = 'off' | 'unfolding' | 'sweepingDown' | 'sweepingUp'

export class Turret extends Enemy {
  private readonly tracking: boolean

  /** Where the barrel points, in the engine's degrees. */
  private angle: number
  private spray: SprayPhase = 'off'

  /** Ticks until the next round, and rounds left in this burst. */
  private fireDelayLeft = 0
  private burstLeft = 0
  /** Ticks the track gun spends looking away after emptying a burst. */
  private continueLeft = 0

  constructor(assets: GameAssets, data: LevelObjectData, objectIndex: number, world: Battlefield) {
    super(assets, data, objectIndex, world)

    this.tracking = data.type === 'TRACK_GUN'
    this.angle = this.tracking ? 270 : SPRAY.startAngle
    this.setState('stopped', true)
  }

  /**
   * `set_targetable` follows the shutter: a folded gun cannot be shot, which
   * is what stops you clearing a corridor before anything opens.
   */
  get isDormant(): boolean {
    return this.state === 'stopped'
  }

  protected think(player: PlayerView): boolean {
    return this.tracking ? this.trackThink(player) : this.sprayThink(player)
  }

  /* ------------------------------------------------------------------ *
   * SPRAY_GUN - spray_gun_ai
   * ------------------------------------------------------------------ */

  private sprayThink(player: PlayerView): boolean {
    // Out of range it holds whatever it was doing rather than folding away -
    // the original returns T from the outer test's else without touching the
    // aistate, so a gun you walk away from mid-sweep is mid-sweep when you
    // come back.
    if (this.distX(player) >= SPRAY_RANGE_X || this.distY(player) >= SPRAY_RANGE_Y) {
      this.setState('stopped')
      return true
    }

    switch (this.spray) {
      case 'off':
        if (!this.activated) {
          this.setState('stopped')
          return true
        }
        // `(if (eq (state) stopped) ... (go_state 3))`: the shutter only plays
        // on the way out of `stopped`, so a gun that was already open when its
        // sensor flickered goes straight back to sweeping.
        if (this.state === 'stopped') {
          this.setState('spray.appear', true)
          this.spray = 'unfolding'
        } else {
          this.spray = 'sweepingDown'
        }
        return true

      case 'unfolding':
        if (this.nextPicture()) return true
        this.setState('spray.aim', true)
        this.angle = SPRAY.startAngle
        this.aimBarrel()
        this.spray = 'sweepingDown'
        this.stateTime = 0
        return true

      case 'sweepingDown':
      case 'sweepingUp':
        return this.sweep()
    }
  }

  /**
   * aistates 3 and 4: step the barrel one `angle_speed` per `fire_delay`,
   * firing on every step, and turn round at each end of the arc.
   *
   * It fires whether or not anything is in front of it. That is the whole
   * character of the weapon - it is a hazard laid across a corridor, not
   * something that aims.
   */
  private sweep(): boolean {
    if (++this.stateTime <= SPRAY.fireDelay) return true
    this.stateTime = 0

    if (this.spray === 'sweepingDown') {
      this.angle -= SPRAY.angleSpeed
      if (this.angle <= SPRAY.startAngle) {
        this.angle = SPRAY.startAngle
        this.spray = 'sweepingUp'
      }
    } else {
      this.angle += SPRAY.angleSpeed
      if (this.angle >= SPRAY.endAngle) {
        this.angle = SPRAY.endAngle
        // Back to aistate 0, which re-tests the sensor and starts down again.
        this.spray = 'off'
      }
    }

    this.aimBarrel()
    this.shoot(SPRAY_MUZZLE, this.angle)
    return true
  }

  /* ------------------------------------------------------------------ *
   * TRACK_GUN - track_ai
   * ------------------------------------------------------------------ */

  private trackThink(player: PlayerView): boolean {
    if (!this.activated) {
      this.setState('stopped')
      return true
    }

    if (this.state === 'stopped') {
      this.setState('opening', true)
      return true
    }
    if (this.state === 'opening' && this.nextPicture()) return true

    this.setState('spinning')
    this.aimBarrel()

    // Emptying a burst leaves it looking the wrong way for a moment. That
    // pause is the only thing that makes a track gun survivable.
    if (this.continueLeft > 0) {
      if (--this.continueLeft === 0) this.burstLeft = TRACK.burstTotal
      return true
    }

    if (this.fireDelayLeft > 0) {
      this.fireDelayLeft--
      return true
    }

    // `(atan2 (- (- (y) (bg.y)) -8) (- (bg.x) (x)))` - it aims eight pixels
    // above the middle of the cop.
    const wanted = normalizeAngle(
      (Math.atan2(this.y - player.y + 8, player.x - this.x) * 180) / Math.PI,
    )

    // The clockwise distance, then whichever way round is shorter.
    const clockwise = wanted < this.angle ? this.angle - wanted : this.angle + (360 - wanted)
    const shortest = clockwise > 180 ? 360 - clockwise : clockwise
    const step = Math.min(shortest, TRACK.turnSpeed)
    this.turnTo(clockwise > 180 ? this.angle + step : this.angle - step)

    if (step < TRACK.aimTolerance) this.trackFire()
    return true
  }

  /**
   * `track_set_angle`: the gun refuses any angle outside its arc, and refuses
   * it by *not moving at all* rather than by clamping. A track gun aimed past
   * the end of its own sweep simply stops there.
   */
  private turnTo(next: number): void {
    const angle = normalizeAngle(next)
    const { startAngle: start, endAngle: end } = TRACK
    const inside = start > end ? angle >= end && angle <= start : angle <= end && angle >= start
    if (inside) this.angle = angle
  }

  private trackFire(): void {
    this.shoot(TRACK_MUZZLE, normalizeAngle(this.angle + 2 - random(TRACK.spread)))

    if (this.burstLeft <= 1) {
      this.continueLeft = TRACK.continueTime
    } else {
      this.burstLeft--
      this.fireDelayLeft = TRACK.fireDelay
    }

    this.setState('firing')
    this.aimBarrel()
  }

  /* ------------------------------------------------------------------ */

  /** `(set_frame_angle 0 359 angle)` over whichever 24-frame state is up. */
  private aimBarrel(): void {
    this.setPicture(frameForAngle(this.angle, this.frameCount))
  }

  /**
   * `fire_object (me) (aitype) ...` - a turret's `aitype` is the projectile
   * type, exactly as it is for an ant, so the same table serves both.
   */
  private shoot(muzzle: { reach: number; rise: number; drop: number }, angle: number): void {
    const radians = (this.angle * Math.PI) / 180
    this.world.fire(
      shotFrom(
        this.data.aitype,
        this.x + Math.cos(radians) * muzzle.reach,
        this.y - muzzle.drop - Math.sin(radians) * muzzle.rise,
        angle,
        this,
      ),
    )
  }

  /**
   * `guner_damage` (lisp/weapons.lsp): a folded gun takes nothing at all, an
   * open one throws the four-sprite debris cluster on every hit and takes no
   * knockback. What it comes apart into when it dies is the host's, like every
   * other authored death.
   */
  override damage(amount: number): boolean {
    if (this.state === 'stopped') return false
    if (this.isDying || this.isDead) return false

    this.world.explode(this.x + 5 - random(10), this.y - 20 - random(10), 'sparks')

    const frame = this.pictureAt
    const killed = super.damage(amount)
    if (!killed) this.setPicture(frame)
    return killed
  }
}
