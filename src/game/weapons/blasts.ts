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
import { applyBlastGlow, type BlastGlow, type BlastSize } from '../effects/blastGlow'
import type { FlashSink } from '../effects/blastGlow'
import type { MoteSink } from '../effects/motes'
import type { BlastSource } from '../effects/types'
import type { PuffKind } from '../effects/sprites'
import type { ProjectileHost } from './host'
import type { ProjectileOwner } from './bmove'
import { PROJECTILE_BLAST_SOURCE, type ProjectileKind } from './Projectile'
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
  /** `fade` is the engine's own 0..15 `set_fade_count`; 0 is fully opaque. */
  spawn(kind: PuffKind, x: number, y: number, delay?: number, fade?: number): void
  /** The moving particles - fire, smoke, embers, debris. Invented; see motes.ts. */
  readonly motes: MoteSink
}

export interface BlastContext {
  readonly host: ProjectileHost
  readonly bursts: BurstSink
}

/**
 * Where a blast goes off, and what set it off.
 *
 * Every caller hands over the projectile itself, so `kind` comes for free -
 * and it is what lets the blast tell the world who to credit. Without it a
 * weapon kill can never colour its victim's body parts, because `get_dead_part`
 * reads exactly this (lisp/ant.lsp).
 */
export interface Point {
  readonly x: number
  readonly y: number
  readonly kind?: ProjectileKind
}

export function blastSource(at: Point): BlastSource | null {
  return at.kind ? { type: PROJECTILE_BLAST_SOURCE[at.kind] } : null
}

const EXP_LIGHT_RADIUS = 100
/** QUICK_EXP_LIGHT dies at state_time >= 1 (addon/twist/lisp/light.lsp). */
const QUICK_LIGHT_TICKS = 1

/** `(frame_panic)`, defaulted to "keeping up" when the host does not track it. */
export function frameSkip(host: ProjectileHost): boolean {
  return host.frameSkip?.() ?? false
}

/**
 * `applyBlastGlow` writes through whatever can take a flash; here that is the
 * host's optional `addLight`, adapted rather than passed straight because the
 * host may not have one at all.
 */
function flashes(ctx: BlastContext): FlashSink | null {
  const add = ctx.host.addLight
  if (!add) return null
  return { add: (x, y, outer, options) => add.call(ctx.host, x, y, outer, options) }
}

/** The light and the particles over one blast. See effects/blastGlow.ts. */
function glow(ctx: BlastContext, at: Point, size: BlastSize, extra?: BlastGlow): void {
  if (frameSkip(ctx.host)) return
  applyBlastGlow(flashes(ctx), ctx.bursts.motes, at.x, at.y, size, extra)
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
  }
  glow(ctx, { x: at.x, y: at.y - 10 }, 'medium')
  ctx.host.hurtRadius(at.x, at.y, radius, amount, owner, 20, blastSource(at))
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
  // The disc's blast is the only white one in the game, so its light and its
  // embers are white too rather than the fire ramp.
  glow(ctx, { x: at.x, y: at.y - 10 }, 'medium', {
    tint: 0xffffff,
    emberColour: 0xffffff,
    emberFade: 0x80b0ff,
  })
  ctx.host.hurtRadius(at.x, at.y, radius, amount, owner, 20, blastSource(at))
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
  glow(ctx, at, 'small')
  ctx.host.hurtRadius(at.x, at.y, radius, amount, owner, 20, blastSource(at))
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
  glow(ctx, { x: at.x, y: at.y - 10 }, 'medium', {
    tint: 0xd2aaff,
    emberColour: 0xe8d0ff,
    emberFade: 0x8020c0,
  })
  ctx.host.hurtRadius(at.x, at.y, radius, amount, owner, 20, blastSource(at))
}

/** The death ray's per-tick flash: QUICK_EXP_LIGHT at (x, y-10), radius 100. */
export function quickLight(ctx: BlastContext, at: Point): void {
  if (frameSkip(ctx.host)) return
  ctx.host.addLight?.(at.x, at.y - 10, EXP_LIGHT_RADIUS, { ticks: QUICK_LIGHT_TICKS })
}
