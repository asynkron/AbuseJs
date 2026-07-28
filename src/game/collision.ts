import type { Level, SolidBox } from './Level'

/**
 * Axis-aligned body. `x` is the horizontal anchor and `y` is the feet, matching
 * how the original engine positions objects (src/objects.cpp).
 */
export interface Body {
  x: number
  y: number
  halfWidth: number
  height: number
}

export interface CollisionResult {
  onGround: boolean
  hitCeiling: boolean
  hitWall: boolean
}

/** Ledges up to this tall are climbed automatically instead of blocking. */
const STEP_HEIGHT = 7

function forEachSolid(
  level: Level,
  left: number,
  top: number,
  right: number,
  bottom: number,
  visit: (box: SolidBox) => void,
): void {
  const cx0 = Math.floor(left / level.tileW)
  const cx1 = Math.floor((right - 0.0001) / level.tileW)
  const cy0 = Math.floor(top / level.tileH)
  const cy1 = Math.floor((bottom - 0.0001) / level.tileH)

  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const box = level.solidAt(cx, cy)
      if (!box) continue
      if (box.x1 <= left || box.x0 >= right || box.y1 <= top || box.y0 >= bottom) continue
      visit(box)
    }
  }
}

export function isBlocked(level: Level, body: Body): boolean {
  let blocked = false
  forEachSolid(level, body.x - body.halfWidth, body.y - body.height, body.x + body.halfWidth, body.y, () => {
    blocked = true
  })
  return blocked
}

/**
 * Moves the body by (dx, dy), resolving against the tile grid one axis at a
 * time. Movement is split into sub-steps no larger than half a tile so fast
 * bodies cannot tunnel through thin floors.
 */
export function moveAndCollide(level: Level, body: Body, dx: number, dy: number): CollisionResult {
  const result: CollisionResult = { onGround: false, hitCeiling: false, hitWall: false }

  const maxStep = Math.min(level.tileW, level.tileH) / 2
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / maxStep))
  const stepX = dx / steps
  const stepY = dy / steps

  for (let i = 0; i < steps; i++) {
    if (stepX !== 0) moveX(level, body, stepX, result)
    if (stepY !== 0) moveY(level, body, stepY, result)
  }

  return result
}

function moveX(level: Level, body: Body, dx: number, result: CollisionResult): void {
  body.x += dx

  const top = body.y - body.height
  const bottom = body.y
  let limit = dx > 0 ? Infinity : -Infinity
  let obstructionTop = Infinity
  let blocked = false

  forEachSolid(level, body.x - body.halfWidth, top, body.x + body.halfWidth, bottom, (box) => {
    blocked = true
    obstructionTop = Math.min(obstructionTop, box.y0)
    limit = dx > 0 ? Math.min(limit, box.x0) : Math.max(limit, box.x1)
  })

  if (!blocked) return

  // Small ledges get stepped over rather than stopping the body dead.
  const rise = bottom - obstructionTop
  if (rise > 0 && rise <= STEP_HEIGHT) {
    const lifted: Body = { ...body, y: obstructionTop }
    if (!isBlocked(level, lifted)) {
      body.y = obstructionTop
      return
    }
  }

  body.x = dx > 0 ? limit - body.halfWidth : limit + body.halfWidth
  result.hitWall = true
}

function moveY(level: Level, body: Body, dy: number, result: CollisionResult): void {
  body.y += dy

  const left = body.x - body.halfWidth
  const right = body.x + body.halfWidth
  let limit = dy > 0 ? Infinity : -Infinity
  let blocked = false

  forEachSolid(level, left, body.y - body.height, right, body.y, (box) => {
    blocked = true
    limit = dy > 0 ? Math.min(limit, box.y0) : Math.max(limit, box.y1)
  })

  if (!blocked) return

  if (dy > 0) {
    body.y = limit
    result.onGround = true
  } else {
    body.y = limit + body.height
    result.hitCeiling = true
  }
}

/** True when solid ground sits directly under the body. */
export function isGrounded(level: Level, body: Body): boolean {
  return isBlocked(level, { ...body, y: body.y + 1, height: 1 })
}
