import { Container, Sprite } from 'pixi.js'

import { bloodArt, type SplatShape } from './bloodArt'
import { SIM_TICKS_PER_TICK } from './clock'
import type { BloodProfile } from './gore'
import { random } from './random'
import type { Box, Terrain } from './types'

/**
 * Blood: droplets that fly and marks that stay.
 *
 * Invented in full. The original has none of it - see the note at the top of
 * DeathEffects.ts - and this exists for one reason: the instant a creature
 * dies its sprite is swapped for five tumbling cutouts, and that swap is the
 * ugliest frame in the game. A burst of spray expanding through it is what
 * covers the join. The cutouts are untouched underneath.
 *
 * Droplets run on the 60 Hz sim tick, not the subsystem's 15 Hz clock. There
 * is no lisp duration here to preserve, and a droplet moving five pixels per
 * step at 15 Hz reads as a dashed line rather than a spray - and because the
 * collision resolution would be at 15 Hz too, it would visibly pass through a
 * wall and snap back. The drying ramp is the one thing here slow enough to
 * live on the engine clock.
 *
 * Everything is drawn at whole world pixels from flat 1-bit art. The scene is
 * nearest-neighbour at an integer zoom under a CRT filter; a soft-edged blob
 * would look pasted on.
 */

/**
 * `head_ai` adds 3 to a gib's yvel per engine tick (lisp/ant.lsp). This runs
 * sixteen times as often - four for the velocity, four for the tick - so blood
 * falls at exactly the rate the parts it came off do.
 */
const DROPLET_GRAVITY = 3 / (SIM_TICKS_PER_TICK * SIM_TICKS_PER_TICK)

/** Movement is applied in steps no larger than this, as in collision.ts. */
const MAX_STEP = 2

/**
 * Invented, in the spirit of Particles.POOL_LIMIT (64) and the gib pool's 40.
 * One ant is about 110 droplets spread over two seconds and peaks near 50
 * alive; five ants caught by one grenade is around 300. Over the cap the
 * oldest is recycled rather than the new spawn refused, so a fresh kill always
 * reads even in a massacre.
 */
const MAX_DROPLETS = 384

/**
 * Invented. Roughly seventeen corpses' worth of history, which outlasts any
 * firefight that fits on a screen. Past that the oldest mark is reused, and it
 * is almost always the one furthest behind you.
 */
const MAX_DECALS = 256

/** Sim ticks a droplet lives if it never hits anything. */
const DROPLET_LIFE = 90

/**
 * The original's own fade granularity: `set_fade_count` runs 0..15
 * (Particles.MAX_FADE). Blood dissolves in those same sixteen steps over the
 * last part of its life rather than on a smooth modern curve.
 */
const FADE_STEPS = 15
/** Fraction of a droplet's life spent fading. */
const FADE_TAIL = 0.35

/** Engine ticks a mark spends at each step of the drying ramp. */
const DRY_TICKS = 45

/** Which face a droplet stopped against; picks the mark's shape. */
type Surface = SplatShape

interface Droplet extends Box {
  sprite: Sprite
  vx: number
  vy: number
  prevX: number
  prevY: number
  /** Side in world pixels: 1, 2 or 3. */
  size: number
  /** Carried so a droplet that lands leaves a mark that dries like any other. */
  ramp: readonly [number, number, number]
  age: number
  life: number
  /** Carries enough to leave a mark. Roughly one in three. */
  heavy: boolean
}

interface Decal {
  sprite: Sprite
  ramp: readonly [number, number, number]
  /** Engine ticks since it landed. */
  age: number
  /** How far down the ramp it has walked, 0..2. */
  step: number
}

export class Blood {
  /** Airborne spray. Belongs in the effects container, above the gibs. */
  readonly spray = new Container()
  /**
   * Marks that stuck. Belongs under the actors and over the tiles, which is
   * why it is a separate container the world places itself - blood on a floor
   * is beneath everything standing on it.
   */
  readonly decals = new Container()

  enabled = true

  private readonly live: Droplet[] = []
  private readonly pool: Sprite[] = []
  private readonly marks: Decal[] = []
  /** Next slot in the mark ring. */
  private next = 0

  constructor(private readonly terrain: Terrain) {}

  /**
   * The spray off a corpse. Velocities are `create_dead_parts`' own -
   * `(* dir (random 10))` across and `(- 0 (random 25))` up, per engine tick -
   * converted to this clock, so the blood leaves the body at the same speed
   * the body parts do.
   */
  burst(x: number, y: number, profile: BloodProfile | null): void {
    if (!profile || !this.enabled) return
    const count = Math.round((20 + random(12)) * profile.amount)
    for (let i = 0; i < count; i++) {
      this.spawn(
        x,
        y,
        (random(21) - 10) / SIM_TICKS_PER_TICK,
        -random(25) / SIM_TICKS_PER_TICK,
        profile,
      )
    }
  }

  /** A hit that did not kill. Small, and from the middle - there is no wound. */
  spit(x: number, y: number, profile: BloodProfile | null, amount: number): void {
    if (!profile || !this.enabled) return
    const count = 2 + Math.min(6, amount >> 3)
    for (let i = 0; i < count; i++) {
      this.spawn(x, y, (random(13) - 6) / 4, (random(13) - 8) / 4, profile)
    }
  }

  /** One drop shed by something already flying, thrown slightly against it. */
  trail(x: number, y: number, vx: number, vy: number, profile: BloodProfile | null): void {
    if (!profile || !this.enabled) return
    this.spawn(x, y, vx * 0.2 + (random(5) - 2) / 4, vy * 0.2 + (random(5) - 2) / 4, profile)
  }

  /** A mark plus a small fan away from the surface it hit. */
  splat(x: number, y: number, surface: Surface, profile: BloodProfile | null): void {
    if (!profile || !this.enabled) return
    this.mark(x, y, surface, profile.ramp)

    const count = Math.round((5 + random(4)) * profile.amount)
    for (let i = 0; i < count; i++) {
      const away = surface === 'ceiling' ? 1 : -1
      this.spawn(x, y, (random(9) - 4) / 3, (away * (1 + random(6))) / 3, profile)
    }
  }

  /** One sim tick. */
  advance(): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const drop = this.live[i]
      drop.prevX = drop.x
      drop.prevY = drop.y
      drop.vy += DROPLET_GRAVITY

      const surface = this.move(drop)
      if (surface) {
        if (drop.heavy) this.mark(drop.x, drop.y, surface, drop.ramp)
        this.retire(i)
        continue
      }

      if (++drop.age >= drop.life) this.retire(i)
    }
  }

  /** One engine tick. Only the drying ramp is slow enough to belong here. */
  dry(): void {
    for (const decal of this.marks) {
      if (decal.step >= 2) continue
      if (++decal.age < DRY_TICKS) continue
      decal.age = 0
      decal.step++
      decal.sprite.tint = decal.ramp[decal.step]
    }
  }

  /** `alpha` is the sim tick's own fraction - droplets step at 60 Hz. */
  draw(alpha: number): void {
    for (const drop of this.live) {
      const x = Math.round(drop.prevX + (drop.x - drop.prevX) * alpha)
      const y = Math.round(drop.prevY + (drop.y - drop.prevY) * alpha)
      drop.sprite.position.set(x, y)
      drop.sprite.alpha = this.fade(drop)
    }
  }

  clear(): void {
    while (this.live.length > 0) this.retire(this.live.length - 1)
    for (const decal of this.marks) decal.sprite.removeFromParent()
    this.marks.length = 0
    this.next = 0
  }

  get dropletCount(): number {
    return this.live.length
  }

  get decalCount(): number {
    return this.marks.length
  }

  /* ---------------------------------------------------------------- */

  private spawn(x: number, y: number, vx: number, vy: number, profile: BloodProfile): void {
    if (this.live.length >= MAX_DROPLETS) this.retire(0)

    const sprite = this.pool.pop() ?? new Sprite(bloodArt().droplet)
    const size = 1 + random(3)
    sprite.visible = true
    sprite.tint = profile.ramp[0]
    sprite.width = size
    sprite.height = size
    this.spray.addChild(sprite)

    this.live.push({
      sprite,
      x,
      y,
      prevX: x,
      prevY: y,
      vx,
      vy,
      // A droplet is a square, and the collision box convention is an anchor
      // column with the feet at y.
      halfWidth: 0.5,
      height: 1,
      size,
      ramp: profile.ramp,
      age: 0,
      life: DROPLET_LIFE,
      heavy: random(3) === 0,
    })
  }

  /**
   * Moves one droplet and reports the face it stopped against.
   *
   * Deliberately not `bounceMove`. That is `bounce_move` from lisp/duong.lsp,
   * whose "lose two pixels a bounce" rule is tuned for gibs at 15 Hz and is
   * wrong by a factor of sixteen here - and blood is supposed to stick, not
   * ping around. Anything it touches ends it.
   */
  private move(drop: Droplet): Surface | null {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(drop.vx), Math.abs(drop.vy)) / MAX_STEP))
    const stepX = drop.vx / steps
    const stepY = drop.vy / steps

    for (let i = 0; i < steps; i++) {
      drop.x += stepX
      if (this.terrain.isBlocked(drop)) {
        drop.x -= stepX
        return 'wall'
      }
      drop.y += stepY
      if (this.terrain.isBlocked(drop)) {
        drop.y -= stepY
        return stepY > 0 ? 'floor' : 'ceiling'
      }
    }
    return null
  }

  /**
   * Lays one mark. The ring is the whole budget: a mark is placed once at a
   * whole world pixel and never moves, so the only cost after this is the
   * drying ramp.
   */
  private mark(x: number, y: number, surface: Surface, ramp: readonly [number, number, number]): void {
    const art = bloodArt().splats[surface]
    const frame = art[random(art.length)]

    let decal = this.marks[this.next]
    if (!decal) {
      decal = { sprite: new Sprite(), ramp: [0, 0, 0], age: 0, step: 0 }
      this.marks[this.next] = decal
      this.decals.addChild(decal.sprite)
    }

    decal.ramp = ramp
    decal.age = 0
    decal.step = 0
    decal.sprite.texture = frame
    decal.sprite.tint = ramp[0]
    // Mirrored, never rotated: a flipped mask is still on the pixel grid and a
    // rotated one is not.
    decal.sprite.scale.set(random(2) === 0 ? -1 : 1, 1)
    decal.sprite.anchor.set(0.5)
    decal.sprite.position.set(Math.round(x), Math.round(y))

    this.next = (this.next + 1) % MAX_DECALS
  }

  /** Quantised to the engine's own 0..15 fade steps over the tail of the life. */
  private fade(drop: Droplet): number {
    const tail = drop.life * FADE_TAIL
    const left = drop.life - drop.age
    if (left >= tail) return 1
    return Math.round((left / tail) * FADE_STEPS) / FADE_STEPS
  }

  private retire(index: number): void {
    const drop = this.live[index]
    this.live.splice(index, 1)
    drop.sprite.removeFromParent()
    drop.sprite.visible = false
    this.pool.push(drop.sprite)
  }
}
