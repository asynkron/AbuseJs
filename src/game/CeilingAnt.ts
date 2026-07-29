import type { GameAssets } from '../assets/loader'
import type { LevelObjectData } from '../assets/types'
import type { Level } from './Level'
import { Prop } from './Prop'
import { isGrounded, moveAndCollide } from './collision'

/**
 * The ant that waits on the ceiling and drops on you.
 *
 * Levels save these `hanging`, which is why they read as decoration until
 * something wakes them. The state names are the character's own: `hanging`,
 * `fall_start`, `falling`, `landing`, then `running`.
 *
 * Ours: drop when the player walks underneath, land, then walk towards them,
 * turning at walls and ledges. It hurts on contact but does not shoot.
 */

/** How far to either side the ant notices someone passing below. */
const DROP_RANGE_X = 90
/** And how far below - it will not drop on someone two floors down. */
const DROP_RANGE_Y = 260
const GRAVITY = 0.55
const MAX_FALL = 12
const WALK_SPEED = 1.5
/** Ticks the landing animation holds before it starts walking. */
const LANDING_TICKS = 24
/** Contact damage, and how often it can be applied. */
const TOUCH_DAMAGE = 8
const TOUCH_COOLDOWN = 45

type Phase = 'hanging' | 'dropping' | 'landing' | 'walking'

export class CeilingAnt extends Prop {
  private phase: Phase = 'hanging'
  private timer = 0
  private touchTimer = 0

  constructor(
    assets: GameAssets,
    data: LevelObjectData,
    objectIndex: number,
    private readonly level: Level,
  ) {
    super(assets, data, objectIndex)
    this.halfWidth = 9
    this.height = 20
    this.enter('hanging')
  }

  get isActive(): boolean {
    return this.phase !== 'hanging'
  }

  private enter(phase: Phase): void {
    this.phase = phase
    this.timer = 0
    const state = {
      hanging: 'hanging',
      dropping: 'falling',
      landing: 'landing',
      walking: 'running',
    }[phase]
    if (this.assets.hasState(this.character, state)) this.setState(state, true)
  }

  update(playerX: number, playerY: number): void {
    if (this.touchTimer > 0) this.touchTimer--

    switch (this.phase) {
      case 'hanging': {
        const below = playerY - this.y
        if (Math.abs(playerX - this.x) < DROP_RANGE_X && below > 0 && below < DROP_RANGE_Y) {
          if (this.assets.hasState(this.character, 'fall_start')) this.setState('fall_start', true)
          this.phase = 'dropping'
        }
        break
      }

      case 'dropping': {
        this.vy = Math.min(this.vy + GRAVITY, MAX_FALL)
        const result = moveAndCollide(this.level, this, 0, this.vy)
        if (result.onGround || isGrounded(this.level, this)) {
          this.vy = 0
          this.enter('landing')
        } else if (this.timer++ === 2) {
          // Swap to the falling frame once clear of the ceiling.
          if (this.assets.hasState(this.character, 'falling')) this.setState('falling', true)
        }
        break
      }

      case 'landing':
        this.advanceAnimation(10 / 60)
        if (++this.timer >= LANDING_TICKS) this.enter('walking')
        break

      case 'walking': {
        this.direction = playerX < this.x ? -1 : 1
        const before = this.x
        moveAndCollide(this.level, this, WALK_SPEED * this.direction, GRAVITY * 4)

        // Blocked, or about to walk off a ledge: face the other way.
        const stuck = Math.abs(this.x - before) < WALK_SPEED * 0.5
        if (stuck) this.direction = -this.direction as 1 | -1

        this.advanceAnimation(Math.abs(this.x - before) * (1 / 5))
        break
      }
    }
  }

  /**
   * Damage dealt to a player in contact, or 0 if it is not touching or is
   * still on cooldown from the last hit.
   */
  touchDamage(playerX: number, playerY: number, playerHalfWidth: number, playerHeight: number): number {
    if (this.phase === 'hanging' || this.touchTimer > 0) return 0
    if (this.isDying || this.isDead) return 0

    if (Math.abs(playerX - this.x) > playerHalfWidth + this.halfWidth) return 0
    const overlapY = Math.abs(playerY - this.height / 2 - (this.y - this.height / 2))
    if (overlapY > (playerHeight + this.height) / 2) return 0

    this.touchTimer = TOUCH_COOLDOWN
    return TOUCH_DAMAGE
  }
}

/** Builds the ceiling ants, replacing the inert props they stand in for. */
export function buildCeilingAnts(
  assets: GameAssets,
  objects: LevelObjectData[],
  props: Prop[],
  level: Level,
): CeilingAnt[] {
  const ants: CeilingAnt[] = []

  objects.forEach((object, index) => {
    if (object.type !== 'ANT_ROOF') return
    if (!assets.character(object.type)) return

    ants.push(new CeilingAnt(assets, object, index, level))
    const existing = props.findIndex((p) => p.data === object)
    if (existing >= 0) props.splice(existing, 1)
  })

  return ants
}
