import type { Box, Terrain } from './types'

/**
 * `bounce_move` (lisp/duong.lsp), the shared helper every loose object in the
 * game moves with: gibs, boulder chunks, thrown grenades.
 *
 * It moves under the current velocity and, if that ran into something,
 * reverses the axis that hit. A vertical hit keeps xvel and sets
 * `(- 2 old_yv)` when the object was falling faster than 1, otherwise plain
 * `(- 0 old_yv)` - so each bounce loses two pixels per tick and a part settles
 * instead of pinging forever. A horizontal hit keeps yvel and negates xvel.
 *
 * The original tests up, then down, then left, then right, and only one branch
 * runs: a corner counts as a vertical hit and does nothing horizontally. That
 * precedence is kept.
 */

/** Movement is applied in steps no larger than this, as in collision.ts. */
const MAX_STEP = 2

export interface BlockFlags {
  up: boolean
  down: boolean
  left: boolean
  right: boolean
}

export interface MovingBox extends Box {
  vx: number
  vy: number
}

export function bounceMove(terrain: Terrain, body: MovingBox): BlockFlags {
  const flags: BlockFlags = { up: false, down: false, left: false, right: false }
  const oldVy = body.vy

  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(body.vx), Math.abs(body.vy)) / MAX_STEP))
  const stepX = body.vx / steps
  const stepY = body.vy / steps

  for (let i = 0; i < steps; i++) {
    if (!flags.left && !flags.right && stepX !== 0) {
      body.x += stepX
      if (terrain.isBlocked(body)) {
        body.x -= stepX
        if (stepX > 0) flags.right = true
        else flags.left = true
      }
    }
    if (!flags.up && !flags.down && stepY !== 0) {
      body.y += stepY
      if (terrain.isBlocked(body)) {
        body.y -= stepY
        if (stepY > 0) flags.down = true
        else flags.up = true
      }
    }
  }

  if (flags.up || flags.down) {
    body.vy = oldVy > 1 ? 2 - oldVy : -oldVy
  } else if (flags.left || flags.right) {
    body.vx = -body.vx
  }

  return flags
}
