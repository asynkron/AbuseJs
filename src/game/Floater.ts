import type { GameAssets } from '../assets/loader'
import type { LevelObjectData } from '../assets/types'
import type { Level } from './Level'
import { Prop } from './Prop'
import { isBlocked } from './collision'

/**
 * WHO - the hovering robot out of `art/rob2.spe`.
 *
 * It is the only creature the training level contains, and its state list is
 * short and unambiguous: `stopped`, `running`, `turn_around` (nine frames of
 * it, so the turn is meant to be seen) and `flinch_up`. No death animation,
 * which is why one just vanishes when it runs out of health.
 *
 * Ours: it hovers on its patrol line, drifts towards the player when they get
 * close, plays the full turn when it reverses, and flinches when shot. It does
 * not fall - hence a floater rather than something with gravity.
 */

/** How far from its spawn point it will wander on its own. */
const PATROL_REACH = 120
/** ...and how far it will chase past that once it has seen someone. */
const CHASE_REACH = 300
const DRIFT_SPEED = 0.55
const CHASE_SPEED = 0.95
/** Hover bob, in pixels and in ticks per cycle. */
const BOB_HEIGHT = 3
const BOB_PERIOD = 150
/** Ticks the turn animation owns before the drift resumes. */
const TURN_TICKS = 27
/** Ticks the flinch holds after being hit. */
const FLINCH_TICKS = 12
const TOUCH_DAMAGE = 6
const TOUCH_COOLDOWN = 40

type Phase = 'drifting' | 'turning' | 'flinching'

export class Floater extends Prop {
  private phase: Phase = 'drifting'
  private timer = 0
  private touchTimer = 0
  private bob = 0
  private readonly homeX: number
  private readonly homeY: number

  constructor(
    assets: GameAssets,
    data: LevelObjectData,
    objectIndex: number,
    private readonly level: Level,
  ) {
    super(assets, data, objectIndex)
    this.halfWidth = 10
    this.height = 18
    this.homeX = this.x
    this.homeY = this.y
    // Each one starts at a different point in the bob so a row of them does
    // not pulse in lockstep.
    this.bob = (objectIndex * 37) % BOB_PERIOD
    this.setState('running', true)
  }

  /** Being shot makes it flinch, which the character has art for. */
  damage(amount: number): boolean {
    const killed = super.damage(amount)
    if (!killed && this.phase !== 'flinching') {
      this.phase = 'flinching'
      this.timer = 0
      if (this.assets.hasState(this.character, 'flinch_up')) this.setState('flinch_up', true)
    }
    return killed
  }

  update(playerX: number, playerY: number, unseen = false): void {
    if (this.touchTimer > 0) this.touchTimer--

    this.bob = (this.bob + 1) % BOB_PERIOD
    const hover = Math.sin((this.bob / BOB_PERIOD) * Math.PI * 2) * BOB_HEIGHT

    switch (this.phase) {
      case 'flinching':
        this.advanceAnimation(10 / 60)
        if (++this.timer >= FLINCH_TICKS) this.resume()
        break

      case 'turning':
        this.advanceAnimation(TURN_TICKS / 60)
        if (++this.timer >= TURN_TICKS) {
          this.direction = -this.direction as 1 | -1
          this.resume()
        }
        break

      case 'drifting': {
        const chasing = !unseen && Math.hypot(playerX - this.x, playerY - this.y) < CHASE_REACH
        if (chasing) this.direction = playerX < this.x ? -1 : 1

        const speed = chasing ? CHASE_SPEED : DRIFT_SPEED
        const next = this.x + speed * this.direction
        const leash = chasing ? CHASE_REACH : PATROL_REACH

        if (Math.abs(next - this.homeX) > leash || this.wallAt(next)) {
          this.phase = 'turning'
          this.timer = 0
          if (this.assets.hasState(this.character, 'turn_around')) {
            this.setState('turn_around', true)
          } else {
            this.direction = -this.direction as 1 | -1
          }
          break
        }

        this.x = next
        this.advanceAnimation(speed / 3)
        break
      }
    }

    this.y = this.homeY + hover
  }

  /**
   * Damage dealt to a player in contact, or 0 if it is not touching or is
   * still on cooldown.
   */
  touchDamage(playerX: number, playerY: number, playerHalfWidth: number, playerHeight: number): number {
    if (this.touchTimer > 0 || this.isDying || this.isDead) return 0
    if (Math.abs(playerX - this.x) > playerHalfWidth + this.halfWidth) return 0
    if (this.y < playerY - playerHeight) return 0
    if (this.y - this.height > playerY) return 0

    this.touchTimer = TOUCH_COOLDOWN
    return TOUCH_DAMAGE
  }

  private resume(): void {
    this.phase = 'drifting'
    this.timer = 0
    this.setState('running', true)
  }

  private wallAt(x: number): boolean {
    return isBlocked(this.level, {
      x,
      y: this.y,
      halfWidth: this.halfWidth,
      height: this.height,
    })
  }
}

/** Builds the floaters, replacing the inert props they stand in for. */
export function buildFloaters(
  assets: GameAssets,
  objects: LevelObjectData[],
  props: Prop[],
  level: Level,
): Floater[] {
  const floaters: Floater[] = []

  objects.forEach((object, index) => {
    if (object.type !== 'WHO') return
    if (!assets.character(object.type)) return

    floaters.push(new Floater(assets, object, index, level))
    const existing = props.findIndex((p) => p.data === object)
    if (existing >= 0) props.splice(existing, 1)
  })

  return floaters
}
