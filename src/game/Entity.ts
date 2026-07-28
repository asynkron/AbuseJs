import { Sprite } from 'pixi.js'

import type { Frame, GameAssets } from '../assets/loader'
import type { Body } from './collision'

/**
 * A drawable, animated actor.
 *
 * Positioning follows the original engine: `x` is an anchor column and `y` is
 * the feet, and each frame carries its own `xcfg` offset from that anchor
 * (src/objects.cpp, game_object::drawer). Facing left mirrors the sprite and
 * offsets from the opposite edge, which is what keeps guns and feet lined up
 * across a flip.
 */
export class Entity implements Body {
  readonly sprite = new Sprite()

  x = 0
  y = 0
  vx = 0
  vy = 0
  /** 1 facing right, -1 facing left. */
  direction = 1

  halfWidth = 8
  height = 28

  /** Previous tick's position, for render interpolation. */
  prevX = 0
  prevY = 0

  state = 'stopped'
  private frames: Frame[] = []
  private frameIndex = 0
  private frameClock = 0

  constructor(
    protected readonly assets: GameAssets,
    readonly character: string,
  ) {
    this.sprite.anchor.set(0, 0)
    this.setState('stopped')
  }

  setPosition(x: number, y: number): void {
    this.x = this.prevX = x
    this.y = this.prevY = y
  }

  /** Switches animation, restarting it unless we are already in that state. */
  setState(state: string, restart = false): void {
    if (this.state === state && !restart && this.frames.length) return
    const frames = this.assets.animation(this.character, state)
    if (!frames.length) return
    this.state = state
    this.frames = frames
    this.frameIndex = 0
    this.frameClock = 0
  }

  get currentFrame(): Frame | undefined {
    return this.frames[this.frameIndex]
  }

  get frameCount(): number {
    return this.frames.length
  }

  /** Advances the animation by `amount` frames; wraps around. */
  advanceAnimation(amount: number): void {
    if (this.frames.length <= 1) return
    this.frameClock += amount
    while (this.frameClock >= 1) {
      this.frameClock -= 1
      this.frameIndex = (this.frameIndex + 1) % this.frames.length
    }
  }

  /** Positions the sprite for this render pass. `alpha` interpolates the tick. */
  draw(alpha: number): void {
    const frame = this.currentFrame
    if (!frame) {
      this.sprite.visible = false
      return
    }

    this.sprite.visible = true
    this.sprite.texture = frame.texture

    const x = this.prevX + (this.x - this.prevX) * alpha
    const y = this.prevY + (this.y - this.prevY) * alpha

    if (this.direction >= 0) {
      this.sprite.scale.x = 1
      this.sprite.x = x - frame.xcfg
    } else {
      this.sprite.scale.x = -1
      // Mirrored sprites draw from their right edge, so the anchor offset is
      // measured from the other side of the frame.
      this.sprite.x = x - (frame.width - frame.xcfg - 1) + frame.width
    }
    this.sprite.y = y - frame.height + 1
  }
}
