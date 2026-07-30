import type { Body } from '../collision'
import { isGrounded, moveAndCollide } from '../collision'
import type { Level } from '../Level'
import { GRAVITY, MAX_FALL, speed } from './tuning'
import { canSee } from './raycast'

/**
 * The movement primitives the scripts call: `try_move`, `move`, `bounce_move`
 * and the two ledge probes that keep an ant from walking off a cliff.
 *
 * collision.ts already resolves a box against the tile grid; this is the layer
 * above it that the AI actually speaks - block flags, acceleration towards a
 * top speed, gravity, and the reverse-and-lose-a-bit bounce.
 */

/** Which way a move was stopped, the way `blocked_left` and friends read it. */
export interface Blocked {
  left: boolean
  right: boolean
  up: boolean
  down: boolean
}

const CLEAR: Blocked = { left: false, right: false, up: false, down: false }

/**
 * `try_move`: shifts the body as far along the offset as it fits and reports
 * whether the whole move was free. Used as a probe - the scripts save and
 * restore the position around it when they only wanted the answer.
 */
export function tryMove(level: Level, body: Body, dx: number, dy: number): boolean {
  const targetX = body.x + dx
  const targetY = body.y + dy
  moveAndCollide(level, body, dx, dy)
  return Math.abs(body.x - targetX) < 0.5 && Math.abs(body.y - targetY) < 0.5
}

/** `try_move` with the position put back, for the probes that only ask. */
export function probeMove(level: Level, body: Body, dx: number, dy: number): boolean {
  const x = body.x
  const y = body.y
  const free = tryMove(level, body, dx, dy)
  body.x = x
  body.y = y
  return free
}

/** What a character's `move` needs to know about itself. */
export interface MoveAbilities {
  /** Top horizontal speed, already in our units. */
  runTopSpeed: number
  /** Acceleration towards that speed, and towards a standstill. */
  startAccel: number
  stopAccel: number
  /** Launch velocity when the jump input is held and the feet are down. */
  jumpYvel: number
}

/** A body with velocity - everything in here is an Entity, which has both. */
export interface Mover extends Body {
  vx: number
  vy: number
}

/**
 * `move(xm, ym, but)`: accelerate towards `xInput * run_top_speed`, apply
 * gravity when it is on, jump when `jump` is held and there is ground
 * underfoot, then resolve against the level and report what stopped it.
 *
 * The original returns block flags that the AI reads with `blocked_down` and
 * `blocked_right`; the ants lean on both.
 */
export function moveCharacter(
  level: Level,
  body: Mover,
  abilities: MoveAbilities,
  xInput: number,
  jump: boolean,
  gravity: boolean,
): Blocked {
  const target = Math.sign(xInput) * abilities.runTopSpeed
  const rate = target === 0 ? abilities.stopAccel : abilities.startAccel
  if (body.vx < target) body.vx = Math.min(target, body.vx + rate)
  else if (body.vx > target) body.vx = Math.max(target, body.vx - rate)

  if (jump && isGrounded(level, body)) body.vy = abilities.jumpYvel
  if (gravity) body.vy = Math.min(body.vy + GRAVITY, MAX_FALL)

  return integrate(level, body)
}

/** Moves a body by its own velocity and reports which sides stopped it. */
export function integrate(level: Level, body: Mover): Blocked {
  const blocked: Blocked = { ...CLEAR }

  if (body.vx !== 0) {
    const horizontal = moveAndCollide(level, body, body.vx, 0)
    if (horizontal.hitWall) {
      if (body.vx > 0) blocked.right = true
      else blocked.left = true
    }
  }

  if (body.vy !== 0) {
    const vertical = moveAndCollide(level, body, 0, body.vy)
    blocked.down = vertical.onGround
    blocked.up = vertical.hitCeiling
  } else {
    blocked.down = isGrounded(level, body)
  }

  return blocked
}

/**
 * How much speed a vertical bounce loses - two units in the original's terms
 * (`bounce_move` in lisp/duong.lsp reverses yvel and subtracts 2 from the
 * result). A horizontal bounce loses nothing.
 */
const BOUNCE_LOSS = speed(2)

/**
 * The threshold the loss applies above - `(if (> old_yv 1) ...)`. It is a
 * different number from the loss itself, and using the loss for both let a
 * band of impact speeds reverse cleanly that should have lost energy.
 */
const BOUNCE_MIN = speed(1)

export type BounceSide = 'none' | 'vertical' | 'horizontal'

/**
 * `bounce_move`: step the body, and on a hit reverse the velocity on the axis
 * that stopped it. Vertical first, then horizontal, first match only - the
 * order lisp/duong.lsp tests the block flags in.
 *
 * The caller gets the side back rather than a set of callbacks, because both
 * users of this - the flyer and the ant's severed parts - want to do something
 * different afterwards.
 */
export function bounceMove(level: Level, body: Mover): BounceSide {
  const previousY = body.vy
  const previousX = body.vx
  const blocked = integrate(level, body)

  if (blocked.up || blocked.down) {
    body.vx = previousX
    body.vy = previousY > BOUNCE_MIN ? BOUNCE_LOSS - previousY : -previousY
    return 'vertical'
  }

  if (blocked.left || blocked.right) {
    body.vy = previousY
    body.vx = -previousX
    return 'horizontal'
  }

  return 'none'
}

/**
 * How far down the ledge probes look, from `no_fall_move` and
 * `will_fall_if_jump` in lisp/ant.lsp. Five pixels clear underneath means the
 * step walked off something.
 */
export const LEDGE_PROBE = 5

/**
 * `no_fall_move`: a step that refuses to walk off a ledge.
 *
 * On the ground it takes the step, probes 5px down, and if that is clear puts
 * the body back and stops dead. The original returns 0 in that case, which
 * reads as "not blocked" to the caller - so an ant at the edge of a drop
 * neither moves nor turns round, it simply stands there. That is deliberate
 * and is preserved: the flags come back clear.
 */
export function noFallMove(
  level: Level,
  body: Mover,
  abilities: MoveAbilities,
  xInput: number,
  airborne: boolean,
): Blocked {
  if (airborne) return moveCharacter(level, body, abilities, xInput, false, true)

  const x = body.x
  const y = body.y
  const blocked = moveCharacter(level, body, abilities, xInput, false, false)

  if (probeMove(level, body, 0, LEDGE_PROBE)) {
    body.x = x
    body.y = y
    body.vx = 0
    return { ...CLEAR }
  }

  return blocked
}

/**
 * `will_fall_if_jump`: whether the far end of a jump has anything to land on.
 *
 * The reach is `|jump_yvel| * jump_xvel` - 4 * 20 = 80px for an ant. It is a
 * crude estimate of a jump's range in the original's own arithmetic, and it is
 * in pixels, so it needs no conversion.
 */
export function willFallIfJump(level: Level, body: Body, direction: number, reach: number): boolean {
  const x = body.x
  const y = body.y
  body.x += Math.sign(direction) * reach
  const noFloor = probeMove(level, body, 0, LEDGE_PROBE)
  body.x = x
  body.y = y
  return noFloor
}

/**
 * `roof_above`: a ceiling close enough overhead to be worth jumping for.
 * lisp/ant.lsp probes 120px straight up and calls a blocked line a roof.
 */
export function roofAbove(level: Level, x: number, y: number, reach: number): boolean {
  return !canSee(level, x, y, x, y - reach)
}
