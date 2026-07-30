import { segmentBlocked, type SightBlocker } from '../enemies/raycast'
/**
 * `bmove` - the move-and-report primitive every Abuse projectile is built on.
 *
 * The original's projectiles do not sweep a ray and ask what they crossed.
 * They step by their current xvel/yvel and the engine reports what stopped
 * them, in three shapes every caller branches on the same way (lisp/weapons.lsp
 * sgun_ai, rocket_ai, dfris_ai; lisp/guns.lsp types 4 and 7):
 *
 *   T    - moved the full step, nothing hit
 *   nil  - hit level geometry, with which side readable via blocked_left/right
 *   else - the object it hit, handed straight to do_damage
 *
 * The argument is an object to ignore, always the shooter, which is how a shot
 * cannot hit whoever fired it.
 */

import type { Frame } from '../../assets/loader'

/** The slice of Level a projectile needs. `Level` satisfies it as it stands. */
export interface ProjectileLevel {
  readonly tileW: number
  readonly tileH: number
  spanInRange(cx: number, cy: number, xFrom: number, xTo: number): { top: number; bottom: number } | null
}

export interface HitBox {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * Anything a shot can strike. `Prop` satisfies this as it stands, and the host
 * can wrap the player in the same shape so enemy fire and player fire go
 * through one path - in the original they always did.
 */
export interface ProjectileTarget {
  readonly x: number
  readonly y: number
  readonly hitBox: HitBox
  readonly isDead: boolean
  readonly isDying: boolean
}

/**
 * The creator a projectile carries as its linked object 0: the thing shots
 * ignore, whose velocity the muzzle inherits, and which explosions spare.
 */
export interface ProjectileOwner {
  readonly x: number
  readonly y: number
  readonly vx: number
  readonly vy: number
  /** `(isa_player)` - the rocket's top speed is 14 for a player, 10 otherwise. */
  readonly isPlayer?: boolean
}

export type BlockSide = 'left' | 'right' | 'up' | 'down'

export type MoveOutcome =
  | { readonly kind: 'clear' }
  | { readonly kind: 'wall'; readonly sides: readonly BlockSide[] }
  | { readonly kind: 'object'; readonly target: ProjectileTarget }

const CLEAR: MoveOutcome = { kind: 'clear' }

/**
 * How finely a step is walked. A plasma bolt covers 200px in one call, so the
 * step has to be subdivided or it would pass straight through a wall.
 */
const SUBSTEP = 3

export interface MovingPoint {
  x: number
  y: number
  vx: number
  vy: number
}

/** True when this point sits inside solid level geometry. */
export function isSolid(level: ProjectileLevel, x: number, y: number): boolean {
  const cx = Math.floor(x / level.tileW)
  const cy = Math.floor(y / level.tileH)
  const span = level.spanInRange(cx, cy, x, x + 1)
  return span !== null && y >= span.top && y < span.bottom
}

function targetAt(
  targets: readonly ProjectileTarget[],
  x: number,
  y: number,
  ignore: unknown,
): ProjectileTarget | null {
  for (const target of targets) {
    if (target === ignore || target.isDead || target.isDying) continue
    const box = target.hitBox
    if (x >= box.left && x < box.right && y >= box.top && y < box.bottom) return target
  }
  return null
}

/** Which side of the mover the wall it just entered is on. */
function sidesFor(vx: number, vy: number): BlockSide[] {
  const sides: BlockSide[] = []
  if (vx > 0) sides.push('right')
  if (vx < 0) sides.push('left')
  if (vy > 0) sides.push('down')
  if (vy < 0) sides.push('up')
  return sides
}

/**
 * Advances `mover` by its velocity, stopping at the first thing in the way and
 * leaving it at the point of impact - which is where every caller then places
 * its impact sprite, `(- (x) (random 5))` and so on.
 */
export function bmove(
  level: ProjectileLevel,
  targets: readonly ProjectileTarget[],
  mover: MovingPoint,
  ignore: unknown,
): MoveOutcome {
  const distance = Math.hypot(mover.vx, mover.vy)
  const steps = Math.max(1, Math.ceil(distance / SUBSTEP))
  const stepX = mover.vx / steps
  const stepY = mover.vy / steps

  for (let i = 0; i < steps; i++) {
    mover.x += stepX
    mover.y += stepY

    const struck = targetAt(targets, mover.x, mover.y, ignore)
    if (struck) return { kind: 'object', target: struck }
    if (isSolid(level, mover.x, mover.y)) return { kind: 'wall', sides: sidesFor(mover.vx, mover.vy) }
  }

  return CLEAR
}

/**
 * The engine's default mover, which is what carries the grenade and the
 * firebomb. Both are ordinary gravity objects: the grenade reads the block
 * flags back out with `(tick)` and the firebomb calls `(move 0 0 0)` inside
 * its own blocked test (lisp/weapons.lsp grenade_ai, firebomb_ai).
 *
 * Gravity and terminal velocity are not in the lisp - they are engine-side, so
 * these match the values Player.ts already uses for the cop, which keeps a
 * thrown grenade arcing the way a jump does.
 */
export function moveUnderGravity(
  level: ProjectileLevel,
  mover: MovingPoint,
  options: { gravity: number; maxFall: number; topSpeed?: number },
): readonly BlockSide[] {
  mover.vy = Math.min(mover.vy + options.gravity, options.maxFall)
  if (options.topSpeed !== undefined) {
    mover.vx = Math.max(-options.topSpeed, Math.min(options.topSpeed, mover.vx))
  }

  const sides: BlockSide[] = []
  const steps = Math.max(1, Math.ceil(Math.hypot(mover.vx, mover.vy) / SUBSTEP))
  let stepX = mover.vx / steps
  let stepY = mover.vy / steps

  // The axes are resolved separately and a blocked one is retired rather than
  // ending the move: a firebomb resting on the floor is blocked downward every
  // single tick, and it still has to slide.
  for (let i = 0; i < steps; i++) {
    if (stepX !== 0) {
      mover.x += stepX
      if (isSolid(level, mover.x, mover.y)) {
        mover.x -= stepX
        sides.push(stepX > 0 ? 'right' : 'left')
        mover.vx = 0
        stepX = 0
      }
    }
    if (stepY !== 0) {
      mover.y += stepY
      if (isSolid(level, mover.x, mover.y)) {
        mover.y -= stepY
        sides.push(stepY > 0 ? 'down' : 'up')
        mover.vy = 0
        stepY = 0
      }
    }
    if (stepX === 0 && stepY === 0) break
  }

  return sides
}

/**
 * `can_see(x1, y1, x2, y2, nil)` - line of sight against level geometry only.
 *
 * It gates the player's own trigger: `player_fire_weapon` refuses to spawn
 * anything when the muzzle is not visible from the chest, so a cop pressed
 * into a wall cannot shoot through it (lisp/people.lsp).
 */
export function canSee(
  level: ProjectileLevel,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  blockers?: Iterable<SightBlocker>,
): boolean {
  const dx = x2 - x1
  const dy = y2 - y1
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / SUBSTEP))
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    if (isSolid(level, x1 + dx * t, y1 + dy * t)) return false
  }
  // The cop's own muzzle gate is `(can_see ... nil)` too (lisp/people.lsp:179),
  // so a closed door stops him firing through it as well.
  return blockers ? blockedBySightObject(x1, y1, x2, y2, blockers) === false : true
}

/**
 * `find_object_in_area(x1, y1, x2, y2, bad_guy_list)` - the grenade's and the
 * disc's ±7px proximity fuse and the rocket's ±160px target search.
 */
export function findTargetInArea(
  targets: readonly ProjectileTarget[],
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  ignore: unknown,
): ProjectileTarget | null {
  for (const target of targets) {
    if (target === ignore || target.isDead || target.isDying) continue
    const box = target.hitBox
    if (box.right < x1 || box.left > x2 || box.bottom < y1 || box.top > y2) continue
    return target
  }
  return null
}

/** Half the sprite's height, which several projectiles offset their smoke by. */
export function halfHeight(frame: Frame | undefined): number {
  return frame ? frame.height / 2 : 0
}


/** True when any blocking object's box lies across the segment. */
function blockedBySightObject(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  blockers: Iterable<SightBlocker>,
): boolean {
  for (const box of blockers) {
    if (segmentBlocked(x1, y1, x2, y2, box)) return true
  }
  return false
}
