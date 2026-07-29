import { Container, Sprite, Texture } from 'pixi.js'

import { bounceMove } from './bounce'
import { random } from './random'
import type { Terrain } from './types'

/**
 * Moving particles: embers, smoke, sparks, debris, blood.
 *
 * Invented. Abuse has nothing like this - `Particles` next door is the real
 * article, `exp_ai` from lisp/explo.lsp, and it is a one-shot animation that
 * never moves. This is the modern half of the effects: things with a velocity,
 * a colour that shifts as they age, and a size that grows or shrinks.
 *
 * Two constraints shape the whole file.
 *
 * The first is the clock. The subsystem around this runs at 15 Hz because
 * every duration in it transcribes a lisp constant (see clock.ts). Motes have
 * no lisp to preserve and they move, and at 15 Hz an ember travelling five
 * pixels a step reads as a dotted line. So they run on the 60 Hz sim tick,
 * which also means `draw` has nothing to interpolate: a 2px mote can be at
 * most half a step out of date, which is under a pixel.
 *
 * The second is that this has to read as pixel art. Everything here is an
 * integer number of world pixels at an integer world position, drawn from one
 * flat white texture with nearest sampling - never a soft radial blob. The
 * whole scene is nearest-neighbour art at an integer zoom under a CRT filter,
 * and one gaussian sprite in the middle of it announces itself as belonging to
 * a different decade. The colour ramp is quantised for the same reason: an
 * ember stepping through six shades reads as indexed colour, a smooth lerp
 * reads as a gradient.
 */

/** Side of the shared texture. 2px so a mote can be scaled down as well as up. */
const TEXTURE_SIZE = 2

/**
 * Invented, and in the spirit of Particles.POOL_LIMIT and the gib pool's 40. A
 * rocket in flight carries about 55 and a `huge` blast throws 143, so this is
 * roughly a hidden-wall chain going off with two rockets already in the air.
 * They batch into one draw call and only the debris class does any collision
 * work, so the ceiling is generous. Over it the *oldest* mote is recycled
 * rather than the new one refused, so a fresh explosion always reads.
 */
const MAX_MOTES = 1000

/**
 * Steps in the colour and alpha ramps.
 *
 * Six, to read as a palette rather than a gradient. The original's own fade is
 * `set_fade_count` 0..15 (Particles.MAX_FADE), which is the same idea at finer
 * granularity; six is coarse enough to see, which is the point.
 */
const RAMP_STEPS = 6

export interface MoteSpec {
  x: number
  y: number
  /** Pixels per sim tick - 60 Hz, not the effects clock's 15. */
  vx: number
  vy: number
  /** Lifetime in sim ticks. */
  life: number
  /** Added to vy each sim tick. 0 for hot gas, ~0.15 for debris, below 0 rises. */
  gravity?: number
  /** Velocity scaled by this each sim tick. 1 is none, 0.9 is thick smoke. */
  drag?: number
  /** 0xRRGGBB at birth. */
  colour: number
  /** Walked to over the life, in RAMP_STEPS. Defaults to `colour`. */
  fadeTo?: number
  /** Square side in world pixels at birth. */
  size: number
  /** Walked to over the life. Defaults to `size`. */
  sizeTo?: number
  alpha?: number
  alphaTo?: number
  /** `add` for fire and embers, `normal` for smoke and debris. */
  blend?: 'add' | 'normal'
  /** Bounce off terrain rather than passing through it. Debris only. */
  collide?: boolean
}

/** What the emitters see. Kept narrow so weapons can hold one without the pool. */
export interface MoteSink {
  emit(spec: MoteSpec): void
  /**
   * `count` motes in a cone: `spread` degrees either side of `angle`, in the
   * engine's convention - 0 due right, 90 straight up (see weapons/angles.ts).
   */
  burst(
    count: number,
    x: number,
    y: number,
    angle: number,
    spread: number,
    speed: number,
    speedVar: number,
    template: MoteTemplate,
  ): void
  readonly liveCount: number
}

/** A spec without the things `burst` works out for itself. */
export type MoteTemplate = Omit<MoteSpec, 'x' | 'y' | 'vx' | 'vy'>

interface Mote {
  sprite: Sprite
  x: number
  y: number
  vx: number
  vy: number
  halfWidth: number
  height: number
  gravity: number
  drag: number
  age: number
  life: number
  from: number
  to: number
  size: number
  sizeTo: number
  alpha: number
  alphaTo: number
  collide: boolean
}

/** One flat white pixel block, shared by every mote. Built once per page. */
let shared: Texture | null = null

function sharedTexture(): Texture {
  if (shared) return shared
  const canvas = document.createElement('canvas')
  canvas.width = TEXTURE_SIZE
  canvas.height = TEXTURE_SIZE
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE)
  shared = Texture.from(canvas)
  shared.source.scaleMode = 'nearest'
  return shared
}

/** Walks one channel of a colour towards another in whole steps. */
function rampColour(from: number, to: number, step: number): number {
  if (from === to) return from
  const t = step / RAMP_STEPS
  const r = ((from >> 16) & 0xff) + (((to >> 16) & 0xff) - ((from >> 16) & 0xff)) * t
  const g = ((from >> 8) & 0xff) + (((to >> 8) & 0xff) - ((from >> 8) & 0xff)) * t
  const b = (from & 0xff) + ((to & 0xff) - (from & 0xff)) * t
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b)
}

export class Motes implements MoteSink {
  /**
   * Two containers, because motes belong on both sides of the authored art.
   * Smoke and debris go behind the fireball sprites so they frame them;
   * embers go in front so the sparks read against the smoke.
   */
  readonly behind = new Container()
  readonly front = new Container()

  private readonly live: Mote[] = []
  private readonly pool: Sprite[] = []

  constructor(private readonly terrain: Terrain) {}

  emit(spec: MoteSpec): void {
    // Over the cap the oldest goes, not the newest: a fresh blast has to read
    // even when the screen is already full of the last one.
    if (this.live.length >= MAX_MOTES) this.retire(0)

    const blend = spec.blend ?? 'normal'
    const sprite = this.pool.pop() ?? new Sprite(sharedTexture())
    sprite.blendMode = blend
    sprite.visible = true

    const mote: Mote = {
      sprite,
      x: spec.x,
      y: spec.y,
      vx: spec.vx,
      vy: spec.vy,
      // bounceMove works on the engine's box - anchor column and feet - and a
      // mote is a square, so it is half a pixel wide and one tall at size 1.
      halfWidth: 0.5,
      height: 1,
      gravity: spec.gravity ?? 0,
      drag: spec.drag ?? 1,
      age: 0,
      life: Math.max(1, spec.life),
      from: spec.colour,
      to: spec.fadeTo ?? spec.colour,
      size: spec.size,
      sizeTo: spec.sizeTo ?? spec.size,
      alpha: spec.alpha ?? 1,
      alphaTo: spec.alphaTo ?? 0,
      collide: spec.collide ?? false,
    }

    ;(blend === 'add' ? this.front : this.behind).addChild(sprite)
    this.live.push(mote)
  }

  burst(
    count: number,
    x: number,
    y: number,
    angle: number,
    spread: number,
    speed: number,
    speedVar: number,
    template: MoteTemplate,
  ): void {
    for (let i = 0; i < count; i++) {
      const theta = ((angle + random(spread * 2 + 1) - spread) * Math.PI) / 180
      const v = speed + (speedVar > 0 ? (random(201) / 100 - 1) * speedVar : 0)
      this.emit({
        ...template,
        x,
        y,
        vx: Math.cos(theta) * v,
        // Screen y grows downward while the engine's angles measure upward,
        // exactly as weapons/angles.ts setCourse has it.
        vy: -Math.sin(theta) * v,
      })
    }
  }

  /** One sim tick. */
  advance(): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const mote = this.live[i]
      if (++mote.age >= mote.life) {
        this.retire(i)
        continue
      }

      mote.vy += mote.gravity
      if (mote.drag !== 1) {
        mote.vx *= mote.drag
        mote.vy *= mote.drag
      }

      if (mote.collide) {
        // Debris shares the gibs' own mover, so a wall chunk settles the way a
        // body part does rather than inventing a second bounce rule.
        bounceMove(this.terrain, mote)
      } else {
        mote.x += mote.vx
        mote.y += mote.vy
      }
    }
  }

  /**
   * Motes step at 60 Hz, so there is nothing to interpolate - and rounding to
   * whole world pixels is what keeps them on the same grid as the art.
   */
  draw(): void {
    for (const mote of this.live) {
      const step = Math.round((mote.age / mote.life) * RAMP_STEPS)
      const t = step / RAMP_STEPS
      const size = Math.max(1, Math.round(mote.size + (mote.sizeTo - mote.size) * t))

      mote.sprite.tint = rampColour(mote.from, mote.to, step)
      mote.sprite.alpha = mote.alpha + (mote.alphaTo - mote.alpha) * t
      mote.sprite.width = size
      mote.sprite.height = size
      mote.sprite.position.set(Math.round(mote.x - size / 2), Math.round(mote.y - size / 2))
    }
  }

  private retire(index: number): void {
    const mote = this.live[index]
    this.live.splice(index, 1)
    mote.sprite.removeFromParent()
    mote.sprite.visible = false
    this.pool.push(mote.sprite)
  }

  get liveCount(): number {
    return this.live.length
  }

  clear(): void {
    while (this.live.length > 0) this.retire(this.live.length - 1)
  }
}
