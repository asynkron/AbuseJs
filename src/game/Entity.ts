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
 *
 * Positions are interpolated as floats and rounded to a whole game pixel at
 * the last moment. Pixi's own `roundPixels` is not enough: it rounds to a
 * device pixel, and the world is drawn at an integer zoom, so a sprite can
 * still land a fraction of a game pixel off the grid the tiles sit on. That
 * shows up as sprite edges crawling against the background - and as the CRT
 * scanlines refusing to line up with anything.
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
  /** Baked colour variant to draw, when this character has any. */
  protected tintIndex: number | undefined
  private frames: Frame[] = []
  private frameIndex = 0
  private frameClock = 0

  constructor(
    protected readonly assets: GameAssets,
    readonly character: string,
  ) {
    this.sprite.anchor.set(0, 0)
    this.setState(assets.defaultState(character))
  }

  setPosition(x: number, y: number): void {
    this.x = this.prevX = x
    this.y = this.prevY = y
  }

  /** Switches animation, restarting it unless we are already in that state. */
  setState(state: string, restart = false): void {
    if (this.state === state && !restart && this.frames.length) return
    const frames = this.assets.animation(this.character, state, this.tintIndex)
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

  /** Jumps straight to a frame, for animations driven by an angle. */
  setFrame(index: number): void {
    if (this.frames.length === 0) return
    this.frameIndex = ((index % this.frames.length) + this.frames.length) % this.frames.length
    this.frameClock = 0
  }

  /** Advances the animation by `amount` frames; wraps around. */
  advanceAnimation(amount: number): void {
    if (this.frames.length <= 1) return
    this.frameClock += amount
    while (this.frameClock >= 1) {
      this.frameClock -= 1
      this.frameIndex = (this.frameIndex + 1) % this.frames.length

      // Some walk cycles bake their movement into the frames rather than into
      // a velocity - JUGGER, T_REX and DROID all do (src/objects.cpp,
      // game_object::frame_advance). Apply it in the facing direction.
      const advance = this.frames[this.frameIndex]?.advance
      if (advance) this.applyRootMotion(advance * this.direction)
    }
  }

  /**
   * Moves the entity by a frame's baked-in displacement. The base version just
   * translates; anything that collides should override.
   */
  protected applyRootMotion(dx: number): void {
    this.x += dx
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
      this.sprite.x = Math.round(x - frame.xcfg)
    } else {
      this.sprite.scale.x = -1
      // Mirrored sprites draw from their right edge, so the anchor offset is
      // measured from the other side of the frame.
      this.sprite.x = Math.round(x - (frame.width - frame.xcfg - 1) + frame.width)
    }
    this.sprite.y = Math.round(y - frame.height + 1)
  }
}
