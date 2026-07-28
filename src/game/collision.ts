import type { Level } from './Level'

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

/**
 * Ledges up to this tall are climbed automatically instead of blocking. Also
 * what lets the body walk up a ramp: a 30x15 slope rises at most 0.5px per
 * pixel travelled, far inside this.
 */
const STEP_HEIGHT = 8

/**
 * Movement is applied in steps no larger than this. Small steps mean a
 * collision can be resolved by simply undoing the step, with an error under a
 * couple of pixels, which keeps the solver simple enough to reason about on
 * ramps where there is no single "wall plane" to snap to.
 */
const MAX_STEP = 2

/**
 * Visits the solid span of every cell the body overlaps, already restricted to
 * the body's own x range.
 */
function forEachSpan(
  level: Level,
  body: Body,
  visit: (top: number, bottom: number) => void,
): void {
  const left = body.x - body.halfWidth
  const right = body.x + body.halfWidth
  const top = body.y - body.height
  const bottom = body.y

  const cx0 = Math.floor(left / level.tileW)
  const cx1 = Math.floor((right - 0.0001) / level.tileW)
  const cy0 = Math.floor(top / level.tileH)
  const cy1 = Math.floor((bottom - 0.0001) / level.tileH)

  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const span = level.spanInRange(cx, cy, left, right)
      if (!span) continue
      if (span.bottom <= top || span.top >= bottom) continue
      visit(span.top, span.bottom)
    }
  }
}

export function isBlocked(level: Level, body: Body): boolean {
  let blocked = false
  forEachSpan(level, body, () => {
    blocked = true
  })
  return blocked
}

/** Highest solid surface the body currently intersects, or null. */
function obstructionTop(level: Level, body: Body): number | null {
  let top: number | null = null
  forEachSpan(level, body, (spanTop) => {
    if (top === null || spanTop < top) top = spanTop
  })
  return top
}

/** Lowest solid underside the body currently intersects, or null. */
function obstructionBottom(level: Level, body: Body): number | null {
  let bottom: number | null = null
  forEachSpan(level, body, (_top, spanBottom) => {
    if (bottom === null || spanBottom > bottom) bottom = spanBottom
  })
  return bottom
}

/**
 * Moves the body by (dx, dy), resolving against the tile grid one axis at a
 * time and in small steps.
 */
export function moveAndCollide(level: Level, body: Body, dx: number, dy: number): CollisionResult {
  const result: CollisionResult = { onGround: false, hitCeiling: false, hitWall: false }

  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / MAX_STEP))
  const stepX = dx / steps
  const stepY = dy / steps

  for (let i = 0; i < steps; i++) {
    if (stepX !== 0) moveX(level, body, stepX, result)
    if (stepY !== 0) moveY(level, body, stepY, result)
  }

  return result
}

function moveX(level: Level, body: Body, dx: number, result: CollisionResult): void {
  const previousX = body.x
  body.x += dx
  if (!isBlocked(level, body)) return

  // A low obstruction gets stepped over rather than stopping the body. This is
  // also how ramps are climbed.
  const top = obstructionTop(level, body)
  if (top !== null && body.y > top && body.y - top <= STEP_HEIGHT) {
    const previousY = body.y
    body.y = top
    if (!isBlocked(level, body)) return
    body.y = previousY
  }

  body.x = previousX
  result.hitWall = true
}

function moveY(level: Level, body: Body, dy: number, result: CollisionResult): void {
  const previousY = body.y
  body.y += dy
  if (!isBlocked(level, body)) return

  if (dy > 0) {
    const top = obstructionTop(level, body)
    if (top !== null) body.y = top
    result.onGround = true
  } else {
    const bottom = obstructionBottom(level, body)
    if (bottom !== null) body.y = bottom + body.height
    result.hitCeiling = true
  }

  // Snapping can land inside something else on a busy tile; undoing the step
  // is always safe because the previous position was clear.
  if (isBlocked(level, body)) body.y = previousY
}

/** True when solid ground sits directly under the body. */
export function isGrounded(level: Level, body: Body): boolean {
  return isBlocked(level, { ...body, y: body.y + 1, height: 1 })
}
