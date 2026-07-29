import { Container, Sprite } from 'pixi.js'

import type { Frame, GameAssets } from '../../assets/loader'
import type { TickClock } from './clock'
import { random } from './random'
import { placeAnchored, placeMiddle, puffFrames, puffIsAnchored, type PuffKind } from './sprites'

/**
 * The generic one-shot sprite actor, and the trails built out of it.
 *
 * `exp_ai` (lisp/explo.lsp) is four lines:
 *
 *     (if (eq (aitype) 0) (next_picture)
 *       (progn (set_aitype (- (aitype) 1)) T))
 *
 * so the fourth argument to `add_object` - the aitype - is a spawn delay in
 * ticks during which the object exists but is frozen and invisible, and after
 * it the sequence plays at exactly one frame per tick until `next_picture`
 * runs out and the engine removes the object. `exp_draw` draws nothing while
 * the delay is running.
 *
 * That delay is the whole staging mechanism. ROB1 dies under eight fireballs
 * at delays 0,1,2,2,3,4,4,5 (lisp/jugger.lsp) and reads as a rolling
 * demolition; without the delay all eight land on the same frame and it reads
 * as one flash. lisp/jugger.lsp:138 says as much in a comment: ";; wait 2
 * frames before appearing".
 */

/**
 * Sprites kept for reuse. A firebomb alone lays down twenty of these.
 *
 * Raised from 64 because a rocket trail spawns once per *sim* tick where the
 * original spawns once per engine tick. The spacing on screen is identical -
 * the rocket also covers four times the ground per second - but four times as
 * many puffs are alive at once, and two rockets in the air used to empty the
 * pool.
 */
const POOL_LIMIT = 96

/**
 * `set_fade_count` runs 0 (opaque) to 15 (invisible). Smoke trails are spawned
 * at 11 (lisp/weapons.lsp rocket_ai), so roughly a quarter opacity. The exact
 * curve the engine used is C++ side and not in the shipped data; straight
 * linear is the natural reading of a 0..15 count.
 */
const MAX_FADE = 15

interface Puff {
  sprite: Sprite
  frames: Frame[]
  /** Feet anchor rather than `middle_draw` - EG_EXPLO and its wall splash. */
  anchored: boolean
  x: number
  y: number
  /** Ticks left before it appears - the aitype the caller passed to add_object. */
  delay: number
  frame: number
  alpha: number
}

export class Particles {
  readonly container = new Container()

  private readonly live: Puff[] = []
  private readonly pool: Sprite[] = []
  private readonly frames = new Map<PuffKind, Frame[]>()

  constructor(
    private readonly assets: GameAssets,
    private readonly clock: TickClock,
  ) {}

  /**
   * `(add_object KIND x y delay)`. `fade` is the original's fade_count, 0..15.
   *
   * The position is where the sprite's middle goes for everything the
   * `def_explo` factory built, since all of those draw through `middle_draw`.
   * EG_EXPLO is the exception and anchors at its feet.
   */
  spawn(kind: PuffKind, x: number, y: number, delay = 0, fade = 0): void {
    const frames = this.framesFor(kind)
    if (!frames.length) return

    const sprite = this.pool.pop() ?? new Sprite()
    sprite.visible = false
    this.container.addChild(sprite)
    this.live.push({
      sprite,
      frames,
      anchored: puffIsAnchored(kind),
      x,
      y,
      delay,
      frame: 0,
      alpha: Math.max(0, 1 - fade / MAX_FADE),
    })
  }

  /**
   * A hit flyer trails dark smoke for thirty ticks, one puff every second tick
   * (lisp/flyer.lsp flyer_ai). No offset and no jitter: the original spawns it
   * dead on the flyer's own x/y.
   *
   * Deviation: the original tests the parity of the flyer's own `smoke_time`
   * countdown; this tests the parity of the clock, which is the same cadence
   * and saves the caller from keeping a counter in engine ticks.
   */
  flyerSmoke(x: number, y: number): void {
    if (!this.clock.stepped || this.clock.ticks % 2 !== 0) return
    this.spawn('SMALL_DARK_CLOUD', x, y)
  }

  /**
   * The FLY power's exhaust: a cloud every tick, ten pixels behind the player
   * in the facing direction (lisp/people.lsp do_special_power). The only place
   * CLOUD is used in the whole game.
   */
  flyExhaust(x: number, y: number, direction: number): void {
    if (!this.clock.stepped) return
    this.spawn('CLOUD', x + direction * -10 + random(5), y + random(5))
  }

  /** One engine tick. Delays run down first, then the animation. */
  advance(): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const puff = this.live[i]
      if (puff.delay > 0) {
        puff.delay--
        continue
      }
      // next_picture returns nil on the tick after the last frame, and the
      // engine removes the object then.
      if (++puff.frame >= puff.frames.length) this.retire(i)
    }
  }

  /** Puffs never move, so there is nothing to interpolate. */
  draw(): void {
    for (const puff of this.live) {
      if (puff.delay > 0) {
        puff.sprite.visible = false
        continue
      }
      const frame = puff.frames[puff.frame]
      if (!frame) continue
      puff.sprite.visible = true
      puff.sprite.alpha = puff.alpha
      if (puff.anchored) placeAnchored(puff.sprite, frame, puff.x, puff.y)
      else placeMiddle(puff.sprite, frame, puff.x, puff.y)
    }
  }

  clear(): void {
    while (this.live.length) this.retire(this.live.length - 1)
  }

  get liveCount(): number {
    return this.live.length
  }

  private framesFor(kind: PuffKind): Frame[] {
    let frames = this.frames.get(kind)
    if (!frames) {
      frames = puffFrames(this.assets, kind)
      this.frames.set(kind, frames)
    }
    return frames
  }

  private retire(index: number): void {
    const puff = this.live[index]
    this.live.splice(index, 1)
    this.container.removeChild(puff.sprite)
    puff.sprite.visible = false
    puff.sprite.alpha = 1
    if (this.pool.length < POOL_LIMIT) this.pool.push(puff.sprite)
  }
}
