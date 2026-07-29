import type { GameAssets } from '../assets/loader'
import type { LevelObjectData } from '../assets/types'
import { Prop } from './Prop'

/**
 * A moving platform.
 *
 * Ours, not a port of `platform_ai`, but it reads the level's own wiring: the
 * object's first two links are its endpoints, and `start_accel` is how far
 * above the platform's own y a rider stands (22px for the small one, 26 for
 * the big, 72 for the red). Speed comes from the `xacel` field the level
 * stores.
 *
 * Behaviour: idle at one end, and stepping onto it and pressing down sends it
 * to the other end. It carries whatever is riding it.
 */

/**
 * The original advances a platform one step per logic tick and runs its logic
 * slower than we render. Keeping that as discrete jumps would make the
 * platform visibly stutter, so the travel time is preserved - `xacel` steps at
 * the original's rate - while the motion itself is continuous.
 */
const TICKS_PER_STEP = 4
const DEFAULT_STEPS = 40
const DEFAULT_SNAP = 22

export class Platform extends Prop {
  /** The two endpoints, in world coordinates. */
  private readonly from: { x: number; y: number }
  private readonly to: { x: number; y: number }

  /**
   * How far above `y` the original teleports a boarding player.
   *
   * Not the surface height - `small_off` is 15px tall but carries a
   * `start_accel` of 22, and `big_off` is 44 tall with 26. It is a generous
   * grab distance for stepping on; standing is handled by the object collision
   * system, which we do not have. The surface itself comes from the sprite.
   */
  readonly boardingReach: number

  /** Total travel time in ticks. */
  private readonly duration: number
  /** 0 = resting at `from`, 1 = resting at `to`. */
  private atEnd = 0
  private elapsed = 0
  private moving = false

  /** Movement applied this tick, for carrying riders. */
  deltaX = 0
  deltaY = 0

  constructor(assets: GameAssets, data: LevelObjectData, endpoints: { x: number; y: number }[]) {
    super(assets, data)
    this.from = endpoints[0]
    this.to = endpoints[1]
    this.boardingReach = assets.ability(data.type, 'start_accel') ?? DEFAULT_SNAP
    this.duration = Math.max(4, data.xacel || DEFAULT_STEPS) * TICKS_PER_STEP

    // Levels place the platform at one of its endpoints; start from whichever
    // it is actually sitting on.
    const distanceToFrom = Math.hypot(data.x - this.from.x, data.y - this.from.y)
    const distanceToTo = Math.hypot(data.x - this.to.x, data.y - this.to.y)
    this.atEnd = distanceToTo < distanceToFrom ? 1 : 0
    const start = this.atEnd === 0 ? this.from : this.to
    this.setPosition(start.x, start.y)
  }

  /**
   * The surface a rider stands on: left, right and the top's y.
   *
   * Taken from the sprite, using the same `y - height + 1` rule everything
   * else is drawn with, so the player's feet sit on the pixels they look like
   * they are standing on.
   */
  get surface(): { left: number; right: number; y: number } {
    const frame = this.currentFrame
    const width = frame?.width ?? 32
    const height = frame?.height ?? 15
    const anchor = frame?.xcfg ?? width / 2
    return {
      left: this.x - anchor,
      right: this.x - anchor + width,
      y: this.y - height + 1,
    }
  }

  get isMoving(): boolean {
    return this.moving
  }

  /** Sends the platform to its other endpoint, if it is not already going. */
  trigger(): boolean {
    if (this.moving) return false
    this.moving = true
    this.elapsed = 0
    return true
  }

  update(): void {
    // Render interpolation reads these; without updating them every tick the
    // platform is drawn interpolating from wherever it started, which reads as
    // flicker and makes riders appear to outrun it.
    this.prevX = this.x
    this.prevY = this.y

    this.deltaX = 0
    this.deltaY = 0
    if (!this.moving) return

    this.elapsed++
    const source = this.atEnd === 0 ? this.from : this.to
    const target = this.atEnd === 0 ? this.to : this.from
    const t = Math.min(1, this.elapsed / this.duration)

    this.x = source.x + (target.x - source.x) * t
    this.y = source.y + (target.y - source.y) * t
    this.deltaX = this.x - this.prevX
    this.deltaY = this.y - this.prevY

    if (t >= 1) {
      this.moving = false
      this.atEnd = 1 - this.atEnd
      this.elapsed = 0
    }
  }
}

/**
 * Builds the platforms in a level. Needs two endpoints to be useful; the
 * original's `platform_ai` gives up on anything else too.
 */
export function buildPlatforms(
  assets: GameAssets,
  objects: LevelObjectData[],
  links: number[][],
  props: Prop[],
): Platform[] {
  const platforms: Platform[] = []

  objects.forEach((object, index) => {
    if (!object.type.includes('PLAT')) return
    const targets = links[index] ?? []
    if (targets.length < 2) return

    const endpoints = targets.slice(0, 2).map((i) => ({ x: objects[i].x, y: objects[i].y }))
    // Endpoints that coincide would make a platform that never goes anywhere.
    if (endpoints[0].x === endpoints[1].x && endpoints[0].y === endpoints[1].y) return

    const platform = new Platform(assets, object, endpoints)
    platforms.push(platform)

    // Replace the inert prop that was spawned for this object.
    const existing = props.findIndex(
      (p) => p.data === object || (p.character === object.type && p.data.x === object.x && p.data.y === object.y),
    )
    if (existing >= 0) props.splice(existing, 1)
  })

  return platforms
}
