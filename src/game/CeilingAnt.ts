import type { GameAssets } from '../assets/loader'
import type { LevelObjectData } from '../assets/types'
import type { Level } from './Level'
import { Prop } from './Prop'
import { isGrounded, moveAndCollide } from './collision'

/**
 * The ant that lives on the ceiling.
 *
 * Its state list says what it is meant to do: `top_walk` (ten frames of
 * walking upside down), `fire_wait` and `ceil_fire` (shooting straight down
 * from up there), and only then `fall_start`/`falling`/`landing` for coming
 * down to fight on the floor. It is not an ambush that waits for you to step
 * underneath - it stalks along the ceiling and shoots.
 *
 * That distinction matters because of where the levels actually put them. In
 * level01 a hanging ant sits a median 362px above the nearest floor, and up to
 * 1571px. An ant that only drops when you walk directly beneath it would
 * almost never do anything, which is exactly how the first version behaved.
 * So: stalk, and drop only when the floor below is close enough to be worth
 * it - otherwise stay up and fire.
 */

/** How far away it notices someone, as a radius. */
const NOTICE_RANGE = 340
/** It gives up and re-hangs past this, with hysteresis so it does not flutter. */
const FORGET_RANGE = 520
/** Ceiling walking speed. */
const STALK_SPEED = 0.9
/** Lined up closely enough to drop. */
const DROP_ALIGN = 40
/** A drop it considers survivable; further than this it stays up and shoots. */
const MAX_DROP = 400
/** Lined up closely enough to bother shooting. */
const FIRE_ALIGN = 170
/** Ticks between ceiling shots. */
const FIRE_DELAY = 75
/** `fire_wait` frames held before the shot goes off. */
const AIM_TICKS = 18
/** ...and how long the muzzle flash holds afterwards. */
const FIRE_TICKS = 10

const GRAVITY = 0.55
const MAX_FALL = 12
const WALK_SPEED = 1.5
/** Ticks the landing animation holds before it starts walking. */
const LANDING_TICKS = 24
/** A drop that has gone on this long has fallen out of the world; land anyway. */
const MAX_DROP_TICKS = 300
/** Contact damage, and how often it can be applied. */
const TOUCH_DAMAGE = 8
const TOUCH_COOLDOWN = 45

type Phase = 'hanging' | 'stalking' | 'aiming' | 'firing' | 'dropping' | 'landing' | 'walking'

const STATES: Record<Phase, string> = {
  hanging: 'hanging',
  stalking: 'top_walk',
  aiming: 'fire_wait',
  firing: 'ceil_fire',
  dropping: 'falling',
  landing: 'landing',
  walking: 'running',
}

export class CeilingAnt extends Prop {
  private phase: Phase = 'hanging'
  private timer = 0
  private touchTimer = 0
  private fireTimer = FIRE_DELAY
  /** Set on the tick it fires, for the caller to spawn a shot. */
  private pendingShot: { x: number; y: number; angle: number } | null = null
  /**
   * Whether we could find the ceiling this ant is clinging to. If we cannot,
   * the ceiling test is unreliable for this one and stalking ignores it rather
   * than pinning the ant in place.
   */
  private readonly ceilingKnown: boolean

  constructor(
    assets: GameAssets,
    data: LevelObjectData,
    objectIndex: number,
    private readonly level: Level,
  ) {
    super(assets, data, objectIndex)
    this.halfWidth = 9
    this.height = 20
    this.ceilingKnown = this.solidAbove(this.x)
    this.enter('hanging')
  }

  get isActive(): boolean {
    return this.phase !== 'hanging'
  }

  /** Being shot at wakes it up, whatever it was doing. */
  damage(amount: number): boolean {
    const killed = super.damage(amount)
    if (!killed && this.phase === 'hanging') this.enter('stalking')
    return killed
  }

  update(playerX: number, playerY: number, unseen = false): void {
    if (this.touchTimer > 0) this.touchTimer--
    if (this.fireTimer > 0) this.fireTimer--

    const dx = playerX - this.x
    const distance = Math.hypot(dx, playerY - this.y)

    switch (this.phase) {
      case 'hanging':
        // Only worth dropping on someone below - it cannot climb back up.
        if (!unseen && distance < NOTICE_RANGE && playerY > this.y) this.enter('stalking')
        break

      case 'stalking':
        this.stalk(dx, playerY, distance)
        break

      case 'aiming':
        this.advanceAnimation(8 / 60)
        if (++this.timer >= AIM_TICKS) {
          const angle = (Math.atan2(-(playerY - 12 - this.y), dx) * 180) / Math.PI
          this.pendingShot = { x: this.x, y: this.y + 2, angle }
          this.fireTimer = FIRE_DELAY
          this.enter('firing')
        }
        break

      case 'firing':
        this.advanceAnimation(12 / 60)
        if (++this.timer >= FIRE_TICKS) this.enter('stalking')
        break

      case 'dropping': {
        this.vy = Math.min(this.vy + GRAVITY, MAX_FALL)
        const result = moveAndCollide(this.level, this, 0, this.vy)
        if (result.onGround || isGrounded(this.level, this) || ++this.timer > MAX_DROP_TICKS) {
          this.vy = 0
          this.enter('landing')
        } else if (this.timer === 3) {
          // Swap to the falling frame once clear of the ceiling.
          this.setPhaseState('dropping')
        }
        break
      }

      case 'landing':
        this.advanceAnimation(10 / 60)
        if (++this.timer >= LANDING_TICKS) this.enter('walking')
        break

      case 'walking': {
        this.direction = dx < 0 ? -1 : 1
        const before = this.x
        moveAndCollide(this.level, this, WALK_SPEED * this.direction, GRAVITY * 4)

        // Blocked, or up against a ledge: face the other way.
        if (Math.abs(this.x - before) < WALK_SPEED * 0.5) {
          this.direction = -this.direction as 1 | -1
        }
        this.advanceAnimation(Math.abs(this.x - before) * (1 / 5))
        break
      }
    }
  }

  /** Consumes a shot it decided to take this tick. */
  takeShot(): { x: number; y: number; angle: number } | null {
    const shot = this.pendingShot
    this.pendingShot = null
    return shot
  }

  /**
   * Walks the ceiling towards the player, dropping when the floor below is
   * close enough and shooting when it is not.
   */
  private stalk(dx: number, playerY: number, distance: number): void {
    if (distance > FORGET_RANGE || playerY < this.y) {
      this.enter('hanging')
      return
    }

    this.direction = dx < 0 ? -1 : 1
    const drop = this.dropHeight()

    // It does not need the player to be on the floor it lands on - once down
    // it walks, and walking off the edge of a ledge carries it the rest of
    // the way.
    if (Math.abs(dx) < DROP_ALIGN && drop <= MAX_DROP) {
      this.setState('fall_start', true)
      this.phase = 'dropping'
      this.timer = 0
      return
    }

    if (Math.abs(dx) < FIRE_ALIGN && this.fireTimer <= 0) {
      this.enter('aiming')
      return
    }

    // Step along the ceiling, as long as there is still ceiling to cling to
    // and nothing in the way.
    const next = this.x + STALK_SPEED * this.direction
    const clinging = !this.ceilingKnown || this.solidAbove(next)
    if (clinging && !this.blocked(next)) {
      this.x = next
      this.advanceAnimation(STALK_SPEED / 4)
    }
  }

  private enter(phase: Phase): void {
    this.phase = phase
    this.timer = 0
    this.setPhaseState(phase)
  }

  private setPhaseState(phase: Phase): void {
    const state = STATES[phase]
    if (this.assets.hasState(this.character, state)) this.setState(state, true)
  }

  /** Is there ceiling to hang from at this x? */
  private solidAbove(x: number): boolean {
    const y = this.y - this.height - 2
    return this.solidNear(x, y, 3)
  }

  /** Is something in the way of the body at this x? */
  private blocked(x: number): boolean {
    return this.solidNear(x + this.halfWidth * this.direction, this.y - this.height / 2, 1)
  }

  private solidNear(x: number, y: number, spread: number): boolean {
    const cx = Math.floor(x / this.level.tileW)
    const cy = Math.floor(y / this.level.tileH)
    const span = this.level.spanInRange(cx, cy, x - spread, x + spread)
    return span !== null && y >= span.top - 4 && y <= span.bottom + 4
  }

  /** Distance straight down to the first thing it could land on. */
  private dropHeight(): number {
    const cx = Math.floor(this.x / this.level.tileW)
    const first = Math.floor(this.y / this.level.tileH) + 1
    for (let cy = first; cy < this.level.fgHeight; cy++) {
      const span = this.level.spanInRange(cx, cy, this.x - this.halfWidth, this.x + this.halfWidth)
      if (span) return span.top - this.y
    }
    return Infinity
  }

  /**
   * Damage dealt to a player in contact, or 0 if it is not touching or is
   * still on cooldown from the last hit.
   */
  touchDamage(playerX: number, playerY: number, playerHalfWidth: number, playerHeight: number): number {
    if (this.phase === 'hanging' || this.touchTimer > 0) return 0
    if (this.isDying || this.isDead) return 0

    // Both boxes hang off the feet, so compare the spans directly rather than
    // their centres - the halves cancel out and it degenerates into comparing
    // one pair of feet against the other.
    if (Math.abs(playerX - this.x) > playerHalfWidth + this.halfWidth) return 0
    if (this.y < playerY - playerHeight) return 0
    if (this.y - this.height > playerY) return 0

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
