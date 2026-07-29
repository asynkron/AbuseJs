import { Graphics } from 'pixi.js'

import type { Level } from './Level'
import type { Prop } from './Prop'

/**
 * Machine gun fire.
 *
 * The original's bullets are genuinely invisible - MBULLET carries
 * `(draw_fun dev_draw)` with the comment "you can't see the bullets" - and
 * live five ticks, hitting whatever they cross (lisp/weapons.lsp, mbullet_ai).
 * Impacts play one of two sounds at random.
 *
 * The lifetime, the impact sounds and the travel-until-blocked behaviour are
 * the original's. The visible tracer is ours: an invisible bullet gives no
 * feedback at all on a modern display, where the original leant on its muzzle
 * flash and hit particles.
 */

/** Ticks a bullet lives before expiring, as in mbullet_ai. */
const LIFETIME = 5
/** Pixels per tick. Fast enough to feel hitscan, slow enough to see. */
const SPEED = 26
/** How finely a bullet's path is tested against the level. */
const STEP = 4

interface Bullet {
  x: number
  y: number
  vx: number
  vy: number
  /** Tint, so enemy fire reads differently from the player's. */
  colour: number
  /** Where this bullet started life this tick, for drawing the tracer. */
  fromX: number
  fromY: number
  ticks: number
  alive: boolean
}

export interface Impact {
  x: number
  y: number
  /** The prop that was struck, if it hit something rather than the level. */
  hit?: Prop
  /** True when this one struck the player. */
  hitPlayer?: boolean
}

/** Box the player occupies, for bullets that are aimed at them. */
export interface PlayerBox {
  left: number
  top: number
  right: number
  bottom: number
}

export class Bullets {
  readonly graphics = new Graphics()

  private readonly pool: Bullet[] = []

  get liveCount(): number {
    return this.pool.filter((b) => b.alive).length
  }

  spawn(x: number, y: number, angleDegrees: number, colour = 0xffe9a0): void {
    const radians = (angleDegrees * Math.PI) / 180
    const bullet = this.pool.find((b) => !b.alive) ?? this.push()
    bullet.x = x
    bullet.y = y
    bullet.fromX = x
    bullet.fromY = y
    // Screen y grows downward; aim angles grow counter-clockwise.
    bullet.vx = Math.cos(radians) * SPEED
    bullet.vy = -Math.sin(radians) * SPEED
    bullet.ticks = 0
    bullet.colour = colour
    bullet.alive = true
  }

  private push(): Bullet {
    const bullet: Bullet = {
      x: 0, y: 0, vx: 0, vy: 0, fromX: 0, fromY: 0, ticks: 0, colour: 0xffe9a0, alive: false,
    }
    this.pool.push(bullet)
    return bullet
  }

  /**
   * Advances every bullet, returning where any of them struck. `targets` are
   * props the shots can hit; `playerBox` makes them hit the player instead,
   * which is what enemy fire uses.
   */
  update(level: Level, targets: readonly Prop[] = [], playerBox?: PlayerBox): Impact[] {
    const impacts: Impact[] = []

    for (const bullet of this.pool) {
      if (!bullet.alive) continue

      bullet.fromX = bullet.x
      bullet.fromY = bullet.y
      bullet.ticks++

      // Walk the step in small increments so a fast bullet cannot pass
      // through a wall between ticks.
      const distance = Math.hypot(bullet.vx, bullet.vy)
      const steps = Math.max(1, Math.ceil(distance / STEP))
      let hit = false

      for (let i = 0; i < steps && !hit; i++) {
        bullet.x += bullet.vx / steps
        bullet.y += bullet.vy / steps

        const struck = hitTarget(targets, bullet.x, bullet.y)
        if (struck) {
          hit = true
          impacts.push({ x: bullet.x, y: bullet.y, hit: struck })
        } else if (playerBox && inBox(playerBox, bullet.x, bullet.y)) {
          hit = true
          impacts.push({ x: bullet.x, y: bullet.y, hitPlayer: true })
        } else if (blocked(level, bullet.x, bullet.y)) {
          hit = true
          impacts.push({ x: bullet.x, y: bullet.y })
        }
      }

      if (hit || bullet.ticks >= LIFETIME) bullet.alive = false
    }

    return impacts
  }

  /** Redraws the tracers. Call with the camera offset already applied. */
  draw(): void {
    this.graphics.clear()
    for (const bullet of this.pool) {
      if (!bullet.alive) continue
      this.graphics
        .moveTo(bullet.fromX, bullet.fromY)
        .lineTo(bullet.x, bullet.y)
        .stroke({ width: 1, color: bullet.colour, alpha: 0.85 })
    }
  }

  clear(): void {
    for (const bullet of this.pool) bullet.alive = false
    this.graphics.clear()
  }
}

function inBox(box: PlayerBox, x: number, y: number): boolean {
  return x >= box.left && x < box.right && y >= box.top && y < box.bottom
}

/** The first live target whose box contains this point. */
function hitTarget(targets: readonly Prop[], x: number, y: number): Prop | undefined {
  for (const target of targets) {
    if (target.isDying || target.isDead) continue
    const box = target.hitBox
    if (x >= box.left && x < box.right && y >= box.top && y < box.bottom) return target
  }
  return undefined
}

/** A bullet stops at the first solid pixel column it enters. */
function blocked(level: Level, x: number, y: number): boolean {
  const cx = Math.floor(x / level.tileW)
  const cy = Math.floor(y / level.tileH)
  const span = level.spanInRange(cx, cy, x, x + 1)
  return span !== null && y >= span.top && y < span.bottom
}
