/**
 * The shared explosion helpers - lisp/explo.lsp's `do_explo`, `do_white_explo`
 * and `do_small_explo`, plus the two the death ray adds.
 *
 * All of them are called on the exploding object, so `(x)` and `(y)` are its
 * position, and all of them end in `hurt_radius` with the object's creator
 * excluded - which is why a grenade never kills the hand that threw it. Each
 * returns nil in the original, and that nil is what removes the caller.
 */

// The explicit path matters: macOS filesystems are case-insensitive, so
// '../effects' is ambiguous with src/game/Effects.ts.
import type { PuffKind } from '../effects/sprites'
import type { ProjectileHost } from './host'
import type { ProjectileOwner } from './bmove'
import { randomBelow } from './angles'

/**
 * `(add_object EXPLODEn x y delay)`.
 *
 * The eleven `def_explo` characters, EG_EXPLO and the addon's two death-ray
 * bursts are catalogued and pooled by the effects subsystem, which runs them
 * at one frame per engine tick. The weapons ask for them through this rather
 * than keeping a second copy of the same table: the same fireball has to play
 * at the same speed whether a grenade or a dying turret asked for it.
 */
export interface BurstSink {
  spawn(kind: PuffKind, x: number, y: number, delay?: number): void
}

export interface BlastContext {
  readonly host: ProjectileHost
  readonly bursts: BurstSink
}

export interface Point {
  readonly x: number
  readonly y: number
}

/** `(add_object EXP_LIGHT (x) (y) 100)` - 4 ticks at a 100px outer radius. */
const EXP_LIGHT_TICKS = 4
const EXP_LIGHT_RADIUS = 100
/** QUICK_EXP_LIGHT dies at state_time >= 1 (addon/twist/lisp/light.lsp). */
const QUICK_LIGHT_TICKS = 1

/** `(frame_panic)`, defaulted to "keeping up" when the host does not track it. */
export function frameSkip(host: ProjectileHost): boolean {
  return host.frameSkip?.() ?? false
}

function explosionLight(ctx: BlastContext, at: Point, ticks = EXP_LIGHT_TICKS): void {
  ctx.host.addLight?.(at.x, at.y, EXP_LIGHT_RADIUS, ticks)
}

/** `do_explo (radius amount)` - the ordinary orange blast. */
export function doExplo(
  ctx: BlastContext,
  at: Point,
  owner: ProjectileOwner | null,
  radius: number,
  amount: number,
): void {
  ctx.host.playSound('GRENADE_SND', at.x, at.y)
  ctx.bursts.spawn('EXPLODE1', at.x + randomBelow(10), at.y + randomBelow(10) - 20, 0)
  if (!frameSkip(ctx.host)) {
    // The second sprite starts two ticks late, so the blast rolls rather than
    // flashing as one shape.
    ctx.bursts.spawn('EXPLODE1', at.x - randomBelow(10), at.y - randomBelow(10) - 20, 2)
    explosionLight(ctx, at)
  }
  ctx.host.hurtRadius(at.x, at.y, radius, amount, owner, 20)
}

/** `do_white_explo (radius amount)` - one EXPLODE8 and no second sprite. */
export function doWhiteExplo(
  ctx: BlastContext,
  at: Point,
  owner: ProjectileOwner | null,
  radius: number,
  amount: number,
): void {
  ctx.host.playSound('GRENADE_SND', at.x, at.y)
  ctx.bursts.spawn('EXPLODE8', at.x + randomBelow(10), at.y + randomBelow(10) - 20, 0)
  if (!frameSkip(ctx.host)) explosionLight(ctx, at)
  ctx.host.hurtRadius(at.x, at.y, radius, amount, owner, 20)
}

/** `do_small_explo (radius amount)` - four staggered sprites, no sound. */
export function doSmallExplo(
  ctx: BlastContext,
  at: Point,
  owner: ProjectileOwner | null,
  radius: number,
  amount: number,
): void {
  ctx.bursts.spawn('EXPLODE3', at.x + randomBelow(5), at.y + randomBelow(5), 0)
  ctx.bursts.spawn('EXPLODE2', at.x + randomBelow(5), at.y + randomBelow(5), 2)
  ctx.bursts.spawn('EXPLODE3', at.x - randomBelow(5), at.y - randomBelow(5), 1)
  ctx.bursts.spawn('EXPLODE3', at.x - randomBelow(5), at.y - randomBelow(5), 2)
  ctx.host.hurtRadius(at.x, at.y, radius, amount, owner, 20)
}

/**
 * `do_dray_explo` and `do_drl_explo` (addon/twist/lisp/weapons.lsp) - the same
 * shape as do_explo with the death ray's own sprites, one for an impact and
 * one for running out of time.
 *
 * DEATH_RAY_SND is addon/twist/sfx/dray.wav, which the converter does not
 * pick up, so it is missing from sounds.json and this blast is silent until it
 * is added. Asking for it by name costs nothing - playNamed ignores unknowns.
 */
export function doDeathRayExplo(
  ctx: BlastContext,
  at: Point,
  owner: ProjectileOwner | null,
  radius: number,
  amount: number,
  sprite: 'EXPDRAY' | 'EXPDRL',
): void {
  ctx.host.playSound('DEATH_RAY_SND', at.x, at.y)
  ctx.bursts.spawn(sprite, at.x, at.y - 10, 0)
  if (!frameSkip(ctx.host)) explosionLight(ctx, at)
  ctx.host.hurtRadius(at.x, at.y, radius, amount, owner, 20)
}

/** The death ray's per-tick flash: QUICK_EXP_LIGHT at (x, y-10), radius 100. */
export function quickLight(ctx: BlastContext, at: Point): void {
  if (frameSkip(ctx.host)) return
  ctx.host.addLight?.(at.x, at.y - 10, EXP_LIGHT_RADIUS, QUICK_LIGHT_TICKS)
}
