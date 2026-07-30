import { Container, Sprite, Texture } from 'pixi.js'

/**
 * The glow an explosion throws onto the screen.
 *
 * Invented, and the piece the effects were missing. `LightLayer` composites its
 * lights as a *multiply*, which is the right model for a room lamp - it reveals
 * art that is already there and can never exceed it. A fireball is the opposite
 * case: it is brighter than anything it is standing in front of, and it should
 * wash the wall out rather than merely fail to darken it. That needs an
 * additive pass, and it has to sit above the light overlay or a blast in an
 * unlit corner - exactly where you want it - gets multiplied back down to
 * nothing.
 *
 * So this is screen-space, drawn after the overlay, with world coordinates
 * converted at draw time. It is the same arrangement `hurtFlash` already uses.
 *
 * Related but different from the shockwave ring blastGlow.ts rules out: a ring
 * is a hard edge travelling outward and reads as a modern effect pasted over
 * 1995 art. This is a soft light with no edge at all, which is what a bright
 * thing on a CRT actually looks like.
 */

/** Which ramp a flare burns through. */
export type FlareKind = 'white' | 'fire' | 'shock'

/**
 * Colour stops per kind, as offset / colour / alpha.
 *
 * Baked into the texture rather than applied as a sprite tint, because a tint
 * is one multiply over the whole sprite and cannot express "white in the
 * middle, red at the edge". The middle stop is what makes fire read as fire.
 */
const RAMPS: Record<FlareKind, readonly (readonly [number, string, number])[]> = {
  white: [
    [0, '255,255,255', 1],
    [0.35, '255,255,255', 0.5],
    [1, '255,255,255', 0],
  ],
  fire: [
    [0, '255,246,208', 1],
    [0.25, '255,208,64', 0.85],
    [0.55, '255,80,16', 0.4],
    [1, '255,40,0', 0],
  ],
  shock: [
    [0, '255,255,255', 1],
    [0.25, '176,216,255', 0.8],
    [0.55, '32,96,255', 0.35],
    [1, '0,48,255', 0],
  ],
}

/** Side of the generated texture. Big enough that a huge blast is not blocky. */
const TEXTURE_SIZE = 256

/**
 * Fraction of the life spent growing. The rest is spent shrinking back, so the
 * flash blooms and collapses rather than simply fading where it stands.
 */
const GROW_FRACTION = 0.35

/** Scale at birth, at the top of the grow, and at death, as fractions of full. */
const SCALE_BIRTH = 0.35
const SCALE_PEAK = 1
const SCALE_DEATH = 0.72

/** Fraction of the life the flare stays at full brightness before falling off. */
const HOLD_FRACTION = 0.18

interface Flare {
  sprite: Sprite
  x: number
  y: number
  /** Radius at full scale, in world pixels. */
  radius: number
  life: number
  age: number
}

/** Ease-out, so the bloom is fastest at the instant it appears. */
const easeOut = (t: number): number => 1 - (1 - t) * (1 - t)

export class Flares {
  readonly container = new Container()

  private readonly textures = new Map<FlareKind, Texture>()
  private readonly live: Flare[] = []
  private readonly pool: Sprite[] = []

  constructor() {
    // Additive, and never dimmed by the light overlay it is drawn after.
    this.container.blendMode = 'add'
  }

  /**
   * `radius` is the world-space radius of the whole glow, so pass the blast's
   * outer light radius rather than the sprite's own size - the point is that it
   * reaches past the fireball.
   */
  add(x: number, y: number, radius: number, kind: FlareKind, life: number, peak = 1): void {
    if (radius <= 0 || life <= 0 || peak <= 0) return

    const sprite = this.pool.pop() ?? new Sprite()
    sprite.texture = this.textureFor(kind)
    sprite.anchor.set(0.5)
    sprite.alpha = peak
    sprite.visible = false
    this.container.addChild(sprite)
    this.live.push({ sprite, x, y, radius, life, age: 0 })
  }

  /** One sim tick. */
  advance(): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const flare = this.live[i]
      flare.age++
      if (flare.age < flare.life) continue
      this.container.removeChild(flare.sprite)
      flare.sprite.visible = false
      this.pool.push(flare.sprite)
      this.live.splice(i, 1)
    }
  }

  /**
   * Places every live flare for this frame.
   *
   * World to screen happens here rather than at spawn because the camera moves
   * under a flare that outlives a single frame.
   */
  draw(cameraX: number, cameraY: number, zoom: number): void {
    for (const flare of this.live) {
      const t = flare.age / flare.life

      // Grow fast, then fall back - the collapse is what makes it read as a
      // flash rather than as a light someone switched off.
      const scale =
        t < GROW_FRACTION
          ? SCALE_BIRTH + (SCALE_PEAK - SCALE_BIRTH) * easeOut(t / GROW_FRACTION)
          : SCALE_PEAK + (SCALE_DEATH - SCALE_PEAK) * ((t - GROW_FRACTION) / (1 - GROW_FRACTION))

      // Squared falloff: additive light that fades linearly reads as a plate
      // being slid away, and the last third of it hangs about looking flat.
      const fade = t < HOLD_FRACTION ? 1 : 1 - (t - HOLD_FRACTION) / (1 - HOLD_FRACTION)

      const diameter = flare.radius * 2 * scale * zoom
      flare.sprite.visible = true
      flare.sprite.alpha = fade * fade
      flare.sprite.width = diameter
      flare.sprite.height = diameter
      flare.sprite.x = (flare.x - cameraX) * zoom
      flare.sprite.y = (flare.y - cameraY) * zoom
    }
  }

  clear(): void {
    for (const flare of this.live) {
      this.container.removeChild(flare.sprite)
      this.pool.push(flare.sprite)
    }
    this.live.length = 0
  }

  get liveCount(): number {
    return this.live.length
  }

  destroy(): void {
    this.clear()
    for (const texture of this.textures.values()) texture.destroy(true)
    this.textures.clear()
    this.container.destroy({ children: true })
  }

  /** One canvas gradient per kind, built once and kept. */
  private textureFor(kind: FlareKind): Texture {
    const existing = this.textures.get(kind)
    if (existing) return existing

    const canvas = document.createElement('canvas')
    canvas.width = TEXTURE_SIZE
    canvas.height = TEXTURE_SIZE
    const ctx = canvas.getContext('2d')
    if (!ctx) return Texture.WHITE

    const half = TEXTURE_SIZE / 2
    const gradient = ctx.createRadialGradient(half, half, 0, half, half, half)
    for (const [offset, rgb, alpha] of RAMPS[kind]) {
      gradient.addColorStop(offset, `rgba(${rgb},${alpha})`)
    }
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE)

    const texture = Texture.from(canvas)
    this.textures.set(kind, texture)
    return texture
  }
}
