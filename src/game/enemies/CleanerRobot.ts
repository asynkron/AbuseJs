import type { GameAssets } from '../../assets/loader'
import type { LevelObjectData } from '../../assets/types'
import { Enemy, type Battlefield } from './Enemy'
import { tryMove } from './motion'
import { canSee, eyeY } from './raycast'
import { speed, ticks } from './tuning'
import type { PlayerView } from './types'

/**
 * ROB1 - the cleaner robot (lisp/jugger.lsp, rob1_ai).
 *
 * It fades in when its sensor turns on, walks the one way the level pointed
 * it, and stops dead when its look-ahead is blocked. There is no turn-around
 * anywhere in its AI: it is a machine on a track, not a hunter. It is also the
 * only creature here that hurts by walking into you - all ten of its `clen`
 * frames carry 5 contact damage in art/rob1.spe.
 */

const ROB = {
  /** rob1_ai: it shoves the player in every state, including after death. */
  pushX: 30,
  pushY: 55,

  /** How far ahead it checks before taking a step, on top of its own speed. */
  lookAhead: 23,
  /** It settles onto the floor each tick rather than having gravity. */
  fallProbe: 10,

  /** CLEANER_SND every six ticks. */
  soundPeriod: ticks(6),
  /** Ticks of fade-in when a hidden one wakes up. */
  fadeTicks: 15,
  /** Ticks between the death explosions and removal. */
  deadLinger: ticks(3),

  /** rob_cons's walk speed, when the level saved none. */
  defaultSpeed: 2,

  /** hitDamage on every `clen` frame in art/rob1.spe. */
  contactDamage: 5,
} as const

type RobPhase = 'dormant' | 'walking'

export class CleanerRobot extends Enemy {
  private phase: RobPhase = 'dormant'
  /** Counts down to zero as it materialises; drives the sprite's alpha. */
  private fade = 0
  private readonly hidden: boolean
  private readonly walkSpeed: number

  constructor(assets: GameAssets, data: LevelObjectData, objectIndex: number, world: Battlefield) {
    super(assets, data, objectIndex, world)

    // art/rob1.spe's `clen` frames are 74x47.
    this.halfWidth = 20
    this.height = 45

    // `rob_hiden`, straight from the level now that the lvars are read. The
    // frame it was saved in is not a reliable stand-in: 80 of the 141 robots
    // set the flag but only 32 were saved sitting in `rob_hiding`, so guessing
    // from the state left 48 of them visible when they should have been
    // waiting invisibly for their sensor.
    this.hidden = (data.lvars?.rob_hiden ?? (data.state === 'rob_hiding' ? 1 : 0)) !== 0

    // ROB1 is one of the few characters whose speed really is in the object -
    // def_char maps its `xvel` field to ai_xvel, and the levels use 1 to 15.
    this.walkSpeed = speed(data.xvel || ROB.defaultSpeed)

    this.setState(this.hidden ? 'rob_hiding' : 'stopped', true)
  }

  get isDormant(): boolean {
    return this.phase === 'dormant'
  }

  protected think(player: PlayerView): boolean {
    if (this.fade > 0) {
      this.fade--
      this.sprite.alpha = 1 - this.fade / ROB.fadeTicks
    }

    switch (this.phase) {
      case 'dormant':
        return this.waitForSignal(player)
      case 'walking':
        return this.walk(player)
    }
  }

  /**
   * aistate 2: it keeps shoving for three ticks after it blows up, then goes.
   * The corpse has no art - ROB1 defines neither `dieing` nor `dead` - so
   * those three ticks are the explosions covering the frame it died on.
   */
  protected override decay(player: PlayerView): boolean {
    this.pushChar(player, ROB.pushX, ROB.pushY)
    return ++this.stateTime < ROB.deadLinger
  }

  private waitForSignal(player: PlayerView): boolean {
    if (this.hidden) {
      this.setState('rob_hiding')
    } else {
      this.pushChar(player, ROB.pushX, ROB.pushY)
    }

    if (!this.activated) return true

    if (this.hidden) {
      this.fade = ROB.fadeTicks
      this.sprite.alpha = 0
    }
    this.setState('stopped', true)
    this.phase = 'walking'
    this.resetStateTime()
    return true
  }

  private walk(player: PlayerView): boolean {
    this.pushChar(player, ROB.pushX, ROB.pushY)
    this.nextPicture()

    if (this.stateTime % ROB.soundPeriod === 0) this.playSound('CLEANER_SND')

    // It has no gravity: each tick it simply tries to sink onto the floor.
    tryMove(this.world.level, this, 0, ROB.fallProbe)

    // `(can_see (x) (y) (+ (x) (xvel) 23) (y) nil)` - a horizontal probe along
    // its own feet, so it has to start on the last row the robot occupies
    // rather than the floor row underneath it.
    const reach = this.direction * (this.walkSpeed + ROB.lookAhead)
    const eye = eyeY(this.y)
    if (canSee(this.world.level, this.x, eye, this.x + reach, eye, this.world.sightBlockers())) {
      this.x += this.direction * this.walkSpeed
    }

    if (this.touching(player)) this.touchDamage(ROB.contactDamage)
    return true
  }

  /**
   * `explo_damage` again, plus the robot's own send-off: eight explosions at
   * fixed offsets and three ticks of shoving before it is taken away.
   */
  override damage(amount: number): boolean {
    if (this.isDying || this.isDead) return false

    this.world.explode(this.x + 10 - Math.random() * 20, this.y - Math.random() * 30, 'sparks')

    // Same reason as the jugger: Prop's damage frames would jump a walk cycle.
    const frame = this.pictureAt
    const killed = super.damage(amount)
    if (!killed) {
      this.setPicture(frame)
      return false
    }

    // rob1_ai's eight staggered fireballs and its BLOWN_UP are the host's -
    // the pattern is authored over six ticks and needs the spawn delay.
    this.resetStateTime()
    return true
  }
}
