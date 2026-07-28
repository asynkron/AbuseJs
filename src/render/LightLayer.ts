import { Container, Rectangle, RenderTexture, Sprite, Texture, type Renderer } from 'pixi.js'

import type { LightSource } from '../assets/types'

/**
 * Abuse's static per-level lighting.
 *
 * Every light is accumulated additively into an offscreen buffer that starts
 * at the level's ambient floor, and that buffer is then multiplied over the
 * finished scene. This is what makes the game dark with pools of light rather
 * than the flat, evenly-lit look we had before.
 *
 * The falloff is ported from `calc_light_value` in src/light.cpp:
 *
 *     dx = |lx - px| << xshift
 *     dy = |ly - py| << yshift
 *     r  = dx + dy - min(dx, dy) / 2          // octagonal distance
 *     contribution = (outer - r) / (outer - inner) * 64
 *
 * summed over every light on top of `minLight`, clamped to 63. Note the
 * distance is an octagon, not a circle - that faceted edge is part of the
 * original's look, so it is baked into the gradient texture rather than
 * smoothed away.
 */

/** Abuse works in 0..63 light units. */
const MAX_LIGHT = 63
/** Resolution of the falloff texture, covering the full -1..1 ellipse. */
const GRADIENT_SIZE = 256

/**
 * Which part of the ellipse each light type covers, in units of its reach.
 * Straight from calc_range in src/light.cpp: type 0 is the full ellipse and
 * the rest are halves and quadrants, which is how wall lamps throw
 * directionally.
 */
const TYPE_BOUNDS: [number, number, number, number][] = [
  [-1, -1, 1, 1], // 0 full
  [-1, -1, 1, 0], // 1 upper
  [-1, 0, 1, 1], // 2 lower
  [0, -1, 1, 1], // 3 right
  [-1, -1, 0, 1], // 4 left
  [0, -1, 1, 0], // 5 upper right
  [-1, -1, 0, 0], // 6 upper left
  [-1, 0, 0, 1], // 7 lower left
  [0, 0, 1, 1], // 8 lower right
]

/**
 * Builds the falloff texture once: white, with the light's intensity in alpha
 * so an additive draw contributes exactly that much. Covers the whole -1..1
 * ellipse; each light type samples the sub-rectangle it needs.
 */
function buildGradientTexture(): Texture {
  const canvas = document.createElement('canvas')
  canvas.width = GRADIENT_SIZE
  canvas.height = GRADIENT_SIZE
  const ctx = canvas.getContext('2d')!
  const image = ctx.createImageData(GRADIENT_SIZE, GRADIENT_SIZE)
  const half = GRADIENT_SIZE / 2

  for (let py = 0; py < GRADIENT_SIZE; py++) {
    for (let px = 0; px < GRADIENT_SIZE; px++) {
      // Normalised distance on each axis; the shifts are already folded in by
      // scaling the sprite, so this is the same curve for every light.
      const u = Math.abs((px + 0.5 - half) / half)
      const v = Math.abs((py + 0.5 - half) / half)
      const r = u + v - Math.min(u, v) / 2
      const intensity = Math.max(0, Math.min(1, 1 - r))

      const o = (py * GRADIENT_SIZE + px) * 4
      image.data[o] = 255
      image.data[o + 1] = 255
      image.data[o + 2] = 255
      image.data[o + 3] = Math.round(intensity * 255)
    }
  }

  ctx.putImageData(image, 0, 0)
  return Texture.from(canvas)
}

export class LightLayer {
  /** Multiply this over the scene. Lives in screen space. */
  readonly overlay = new Sprite()

  enabled = true

  private readonly accumulator = new Container()
  private readonly pool: Sprite[] = []
  private readonly frames: Texture[]
  private target: RenderTexture
  private width = 1
  private height = 1
  private visible = 0

  constructor() {
    const gradient = buildGradientTexture()
    const half = GRADIENT_SIZE / 2
    this.frames = TYPE_BOUNDS.map(
      ([x0, y0, x1, y1]) =>
        new Texture({
          source: gradient.source,
          frame: new Rectangle((x0 + 1) * half, (y0 + 1) * half, (x1 - x0) * half, (y1 - y0) * half),
        }),
    )

    this.target = RenderTexture.create({ width: 1, height: 1 })
    this.overlay.texture = this.target
    this.overlay.blendMode = 'multiply'
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return
    this.width = width
    this.height = height
    this.target.destroy(true)
    this.target = RenderTexture.create({ width, height })
    this.overlay.texture = this.target
  }

  /**
   * Redraws the light buffer for the current camera. Must run before the main
   * render, since it renders to its own target.
   */
  update(
    renderer: Renderer,
    lights: LightSource[],
    minLight: number,
    cameraX: number,
    cameraY: number,
    zoom: number,
  ): void {
    if (!this.enabled) {
      this.overlay.visible = false
      return
    }
    this.overlay.visible = true

    const viewW = this.width / zoom
    const viewH = this.height / zoom
    let used = 0

    for (const light of lights) {
      const reachX = light.outer >> light.xshift
      const reachY = light.outer >> light.yshift
      const bounds = TYPE_BOUNDS[light.type]
      // Type 9 is a solid rectangle that overrides everything under it. Three
      // of them exist across all 125 levels; approximate rather than special
      // case the whole accumulation.
      if (!bounds) continue

      const [nx0, ny0, nx1, ny1] = bounds
      const x = light.x + nx0 * reachX
      const y = light.y + ny0 * reachY
      const w = (nx1 - nx0) * reachX
      const h = (ny1 - ny0) * reachY
      if (w <= 0 || h <= 0) continue

      // Cull against the visible world rectangle.
      if (x + w < cameraX || x > cameraX + viewW || y + h < cameraY || y > cameraY + viewH) continue

      const sprite = this.take(used++)
      sprite.texture = this.frames[light.type]
      sprite.position.set((x - cameraX) * zoom, (y - cameraY) * zoom)
      sprite.width = w * zoom
      sprite.height = h * zoom
    }

    for (let i = used; i < this.pool.length; i++) this.pool[i].visible = false
    this.visible = used

    // The buffer starts at the level's ambient floor; lights add on top and
    // the 8-bit target clamps the sum, exactly like the engine's clamp to 63.
    const ambient = Math.min(1, minLight / MAX_LIGHT)
    renderer.render({
      container: this.accumulator,
      target: this.target,
      clear: true,
      clearColor: [ambient, ambient, ambient, 1],
    })
  }

  private take(index: number): Sprite {
    let sprite = this.pool[index]
    if (!sprite) {
      sprite = new Sprite()
      sprite.blendMode = 'add'
      this.pool[index] = sprite
      this.accumulator.addChild(sprite)
    }
    sprite.visible = true
    return sprite
  }

  get visibleCount(): number {
    return this.visible
  }
}
