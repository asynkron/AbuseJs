import { Container, Sprite } from 'pixi.js'

import type { GameAssets, Frame } from '../assets/loader'

/**
 * One-shot animated puffs - explosions, for now.
 *
 * The art is the game's own: `EG_EXPLO`'s `stopped` state is the four-frame
 * blast flash out of `art/missle.spe`. Nothing here collides or is collided
 * with; a puff is purely something to look at, which is why it lives outside
 * the prop list and gets its own container above everything else.
 */

/** Ticks each frame of a puff is held for. */
const FRAME_TICKS = 4
/** Sprites kept around for reuse; deaths come in bursts. */
const POOL_LIMIT = 32

interface Puff {
  sprite: Sprite
  frames: Frame[]
  x: number
  y: number
  index: number
  timer: number
}

export class Effects {
  readonly container = new Container()

  private readonly live: Puff[] = []
  private readonly pool: Sprite[] = []
  private readonly explosion: Frame[]

  constructor(assets: GameAssets) {
    this.explosion = assets.animation('EG_EXPLO', 'stopped')
  }

  /** Puts an explosion at a world position. Silent - the caller owns the sound. */
  explode(x: number, y: number): void {
    if (!this.explosion.length) return

    const sprite = this.pool.pop() ?? new Sprite()
    sprite.visible = true
    this.container.addChild(sprite)
    this.live.push({ sprite, frames: this.explosion, x, y, index: 0, timer: 0 })
  }

  update(): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const puff = this.live[i]
      if (++puff.timer < FRAME_TICKS) continue

      puff.timer = 0
      if (++puff.index >= puff.frames.length) {
        this.retire(i)
      }
    }
  }

  /** Puffs do not interpolate - they are only ever a few frames long. */
  draw(): void {
    for (const puff of this.live) {
      const frame = puff.frames[puff.index]
      if (!frame) continue
      puff.sprite.texture = frame.texture
      // Centre the blast on the point it was asked for, rather than using the
      // feet-and-anchor convention the actors draw with.
      puff.sprite.x = Math.round(puff.x - frame.width / 2)
      puff.sprite.y = Math.round(puff.y - frame.height / 2)
    }
  }

  clear(): void {
    while (this.live.length) this.retire(this.live.length - 1)
  }

  private retire(index: number): void {
    const puff = this.live[index]
    this.live.splice(index, 1)
    this.container.removeChild(puff.sprite)
    puff.sprite.visible = false
    if (this.pool.length < POOL_LIMIT) this.pool.push(puff.sprite)
  }
}
