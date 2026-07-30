/**
 * One tick of each projectile - the ai_fun of every weapon in lisp/weapons.lsp,
 * plus the addon's death ray.
 *
 * Each function is the original's ai_fun in the original's order, because the
 * order is load-bearing: sgun_ai refreshes its trail anchor before it moves,
 * the firebomb burns before it checks whether it is still alive, and the
 * rocket steers before `bmove` decides whether it got there.
 */

import {
  atan2Deg,
  angleDiff,
  cosDeg,
  normalizeAngle,
  randomBelow,
  setCourse,
  sinDeg,
  steerTowards,
} from './angles'
import { bmove, findTargetInArea, moveUnderGravity } from './bmove'
import type { MoveOutcome, ProjectileLevel, ProjectileTarget } from './bmove'
import { accel, MAX_FALL, speed, ticks, TICK_SCALE } from '../enemies/tuning'
import { blastSource, doDeathRayExplo, doExplo, doWhiteExplo, frameSkip, quickLight } from './blasts'
import { firebombFlames, rocketExhaust } from './exhaust'
import type { BlastContext } from './blasts'
import type {
  DeathRay,
  Disc,
  Firebomb,
  Grenade,
  MachineGunBullet,
  PlasmaBolt,
  Projectile,
  ProjectileKind,
  Rocket,
  SabreSlash,
  StraitRocket,
} from './Projectile'

export interface TickContext extends BlastContext {
  readonly level: ProjectileLevel
  readonly targets: readonly ProjectileTarget[]
  /** `(game_tick)` - only the disc's smoke cadence reads it. */
  readonly gameTick: number
  /** `(picture_height)` of this kind's own sprite. */
  pictureHeight(kind: ProjectileKind): number
  /** How many frames this kind's `stopped` state has, for next_picture. */
  frameCount(kind: ProjectileKind): number
}

/**
 * Gravity for the two projectiles that fall.
 *
 * The engine adds 1 to yvel per 15Hz tick for a gravity object, so this is
 * that acceleration in our units - and it has to be that, not the cop's
 * hand-tuned 0.55, or the authored launch velocities arc to the wrong height:
 * a grenade thrown at the original's 20 reaches 200px under `accel(1)` and
 * 364px under 0.55, which is most of a screen too high.
 */
const GRAVITY = { gravity: accel(1), maxFall: MAX_FALL }

/* ------------------------------------------------------------------ *
 * Machine gun - SHOTGUN_BULLET
 * ------------------------------------------------------------------ */

/** `(do_damage 5 bx ...)` in sgun_ai. */
const MGUN_DAMAGE = 5
/** Knockback: `(* (cos sgb_angle) 10)` and `(* (sin sgb_angle) 10)`. */
const MGUN_PUSH = 10

function tickMachineGun(bullet: MachineGunBullet, ctx: TickContext): void {
  bullet.lastX = bullet.x
  bullet.lastY = bullet.y

  // 20% per *original* tick, so the per-tick factor carries the tick scale
  // like any other rate. Over the nine of our ticks the player's variant lives
  // that comes to about 150px of reach, which is what the original's six
  // integer steps of 18, 21, 25, 30, 37, 44 covered. The truncation the lisp's
  // fixed point imposed is dropped with it: the ladder is no longer integral
  // in these units, and rounding it here would just lose range.
  bullet.speed *= Math.pow(1.2, bullet.growth)
  const course = setCourse(bullet.angle, bullet.speed)
  bullet.vx = course.vx
  bullet.vy = course.vy

  if (bullet.lifetime === 0) {
    bullet.alive = false
    return
  }

  const outcome = bmove(ctx.level, ctx.targets, bullet, bullet.owner)
  bullet.lifetime--
  if (outcome.kind === 'clear') return

  // Zeroing the lifetime rather than dying outright leaves this tick's streak
  // on screen; the bullet goes on the next one.
  bullet.lifetime = 0
  // `o->x+jrand()%4` (src/cop.cpp:938) - added, and 0..3, not subtracted 0..4.
  const x = bullet.x + randomBelow(4)
  const y = bullet.y + randomBelow(4)

  if (outcome.kind === 'wall') {
    ctx.bursts.spawn('EXPLODE5', x, y)
    return
  }

  ctx.bursts.spawn('EXPLODE3', x, y)
  // The push keeps the lisp's signs. yvel grows downward, so an upward shot
  // pushes its victim down - almost certainly a slip in the script, but the
  // host decides what a push means, so it is passed through as written.
  ctx.host.damage(
    outcome.target,
    MGUN_DAMAGE,
    cosDeg(bullet.angle) * MGUN_PUSH,
    sinDeg(bullet.angle) * MGUN_PUSH,
    blastSource(bullet),
  )
}

/* ------------------------------------------------------------------ *
 * Grenade
 * ------------------------------------------------------------------ */

/** `(do_explo 40 36)`. */
const GRENADE_BLAST = { radius: 40, damage: 36 }
/** The proximity fuse box, `(x-7, y-7)..(x+7, y+7)`. */
const PROXIMITY = 7

function tickGrenade(grenade: Grenade, ctx: TickContext): void {
  // grenade_ai reads `(tick)`, which is the block flags of the move the engine
  // already made this tick - so the fall happens first, then the test.
  const blocked = moveUnderGravity(ctx.level, grenade, GRAVITY)
  const near = findTargetInArea(
    ctx.targets,
    grenade.x - PROXIMITY,
    grenade.y - PROXIMITY,
    grenade.x + PROXIMITY,
    grenade.y + PROXIMITY,
    grenade.owner,
  )

  if (blocked.length === 0 && !near) {
    // It does not bounce; it tumbles until something stops it.
    const frames = ctx.frameCount('grenade')
    if (frames > 1) grenade.frameIndex = (grenade.frameIndex + 1) % frames
    return
  }

  doExplo(ctx, grenade, grenade.owner, GRENADE_BLAST.radius, GRENADE_BLAST.damage)
  grenade.alive = false
}

/* ------------------------------------------------------------------ *
 * Rocket
 * ------------------------------------------------------------------ */

const ROCKET_BLAST = { radius: 40, damage: 50 }
/**
 * `angle_add` caps at 23 degrees per original tick, with nothing under 5. The
 * cap is a rate and converts; the deadband is a tolerance and does not.
 */
const ROCKET_TURN = 23 * TICK_SCALE
const ROCKET_DEADBAND = 5
/** `(setq speed (+ speed 2))` until max_speed - an acceleration. */
const ROCKET_ACCEL = accel(2)
/** It aims 15px below the target's origin, at the body rather than the feet. */
const ROCKET_AIM_OFFSET = 15
/** Fuse box once it is on top of what it locked onto. */
const ROCKET_FUSE = 10

/**
 * SMALL_LIGHT_CLOUD at `(x + random 3, y - random 3 - picture_height/2)`.
 *
 * The original saves and restores `rand_on` around this so cosmetic particles
 * cannot pull the shared deterministic random cursor out from under netplay.
 * Math.random has no such cursor, so there is nothing to save - but that is
 * why the original looks the way it does.
 */
function trailSmoke(projectile: { x: number; y: number }, kind: ProjectileKind, ctx: TickContext): void {
  if (frameSkip(ctx.host)) return
  ctx.bursts.spawn(
    'SMALL_LIGHT_CLOUD',
    projectile.x + randomBelow(3),
    projectile.y - randomBelow(3) - ctx.pictureHeight(kind) / 2,
    0,
    // `(set_fade_count 11)` - the puff is meant to be about a quarter opaque.
    // The argument had nowhere to go until BurstSink grew one, so the trail
    // has been drawing at full strength.
    TRAIL_FADE,
  )
}

/** `(set_fade_count 11)` on the 0..15 scale - lisp/weapons.lsp rocket_ai. */
const TRAIL_FADE = 11

function liveTarget(target: ProjectileTarget | null): ProjectileTarget | null {
  if (!target || target.isDead || target.isDying) return null
  return target
}

function tickRocket(rocket: Rocket, ctx: TickContext): void {
  trailSmoke(rocket, 'rocket', ctx)
  if (!frameSkip(ctx.host)) rocketExhaust(ctx.bursts.motes, rocket)

  const target = liveTarget(rocket.target)
  rocket.target = target
  if (target) {
    const wanted = atan2Deg(rocket.y - target.y + ROCKET_AIM_OFFSET, target.x - rocket.x)
    rocket.heading = steerTowards(rocket.heading, wanted, ROCKET_TURN, ROCKET_DEADBAND)
  }

  if (rocket.speed < rocket.maxSpeed) rocket.speed += ROCKET_ACCEL
  const course = setCourse(rocket.heading, rocket.speed)
  rocket.vx = course.vx
  rocket.vy = course.vy

  const outcome = bmove(ctx.level, ctx.targets, rocket, rocket.owner)
  const onTop =
    target !== null &&
    Math.abs(target.x - rocket.x) < ROCKET_FUSE &&
    Math.abs(target.y - rocket.y - ROCKET_AIM_OFFSET) < ROCKET_FUSE

  if (rocket.health <= 0 || outcome.kind !== 'clear' || onTop) {
    doExplo(ctx, rocket, rocket.owner, ROCKET_BLAST.radius, ROCKET_BLAST.damage)
    rocket.alive = false
  }
}

/* ------------------------------------------------------------------ *
 * Plasma bolt - a decal; the damage was done at spawn
 * ------------------------------------------------------------------ */

/**
 * pgun_ai answers T for state_time 0..4 and nil at 5, and pgun_draw's ramp
 * runs 255, 215, 175, 135, 95, 55 - six values. Six draws it is.
 */
const PLASMA_TICKS = 6

function tickPlasma(bolt: PlasmaBolt): void {
  if (bolt.age >= PLASMA_TICKS) bolt.alive = false
}

/* ------------------------------------------------------------------ *
 * Firebomb
 * ------------------------------------------------------------------ */

/** `(hurt_radius (x) (y) 60 40 creator 10)`, every single tick. */
const FIREBOMB_BLAST = { radius: 60, damage: 40, maxPush: 10 }
/** `(< (state_time) 20)`. */
const FIREBOMB_LIFETIME = ticks(20)
/** Three ticks of grace before a stalled firebomb counts as finished. */
const FIREBOMB_GRACE = ticks(3)
/** `(abilities (walk_top_speed 20) (run_top_speed 20))` clamps the skid. */
const FIREBOMB_TOP_SPEED = speed(20)

function tickFirebomb(bomb: Firebomb, ctx: TickContext): void {
  // The flame comes first and unconditionally: a firebomb that dies this tick
  // still burns this tick.
  ctx.bursts.spawn('EXPLODE1', bomb.x - randomBelow(5), bomb.y + randomBelow(20))
  if (!frameSkip(ctx.host)) firebombFlames(ctx.bursts.motes, bomb.x, bomb.y)
  ctx.host.hurtRadius(
    bomb.x,
    bomb.y,
    FIREBOMB_BLAST.radius,
    FIREBOMB_BLAST.damage,
    bomb.owner,
    FIREBOMB_BLAST.maxPush,
    blastSource(bomb),
  )

  // `(move 0 0 0)` inside the blocked test is what actually advances it.
  const blocked = moveUnderGravity(ctx.level, bomb, { ...GRAVITY, topSpeed: FIREBOMB_TOP_SPEED })
  // `(not (eq (xvel) 0))` against integer velocities. Here a launch angle near
  // vertical leaves a hair of floating-point xvel that would never read as
  // zero, so anything under half a pixel a tick counts as stopped.
  const sliding = bomb.age < FIREBOMB_GRACE || Math.abs(bomb.vx) >= 0.5
  const wallAhead = blocked.includes(bomb.facing > 0 ? 'right' : 'left')

  if (!sliding || bomb.age >= FIREBOMB_LIFETIME || wallAhead) bomb.alive = false
}

/* ------------------------------------------------------------------ *
 * Disc frisbee
 * ------------------------------------------------------------------ */

const DISC_BLAST = { radius: 40, damage: 45 }
/** `(set_course (aistate) 12)` - it launches at 25 and settles to 12 at once. */
const DISC_SPEED = speed(12)
/** The most it will turn in a tick. */
const DISC_TURN = 35 * TICK_SCALE
/** get_fris_angle aims 4px above the crosshair. */
const DISC_AIM_OFFSET = 4

function tickDisc(disc: Disc, ctx: TickContext): void {
  // Half the rocket's smoke rate.
  if (ctx.gameTick % 2 === 0) trailSmoke(disc, 'disc', ctx)

  const course = setCourse(disc.heading, DISC_SPEED)
  disc.vx = course.vx
  disc.vy = course.vy

  const outcome = bmove(ctx.level, ctx.targets, disc, disc.owner)
  const near = findTargetInArea(
    ctx.targets,
    disc.x - PROXIMITY,
    disc.y - PROXIMITY,
    disc.x + PROXIMITY,
    disc.y + PROXIMITY,
    disc.owner,
  )

  if (outcome.kind !== 'clear' || !disc.owner || near) {
    doWhiteExplo(ctx, disc, disc.owner, DISC_BLAST.radius, DISC_BLAST.damage)
    disc.alive = false
    return
  }

  // It steers towards wherever the mouse is pointing, not towards an enemy -
  // which is the whole character of the weapon.
  const pointer = disc.owner.isPlayer ? ctx.host.pointer() : null
  if (!pointer) return

  const wanted = atan2Deg(disc.y - pointer.y - DISC_AIM_OFFSET, pointer.x - disc.x)
  const change = angleDiff(disc.heading, wanted)
  disc.heading = normalizeAngle(
    disc.heading + (Math.abs(change) < DISC_TURN ? change : change >= 0 ? DISC_TURN : -DISC_TURN),
  )
}

/* ------------------------------------------------------------------ *
 * Light sabre - one tick of life
 * ------------------------------------------------------------------ */

function tickSabre(slash: SabreSlash): void {
  // lsaber_ai returns nil on its first call, so the slash is drawn once - on
  // the tick it was fired - and then removed. It also calls
  // `(shift_rand_table (random 80))`, which only matters to netplay
  // determinism and has no equivalent here.
  slash.alive = false
}

/* ------------------------------------------------------------------ *
 * Strait rocket - AI only
 * ------------------------------------------------------------------ */

/** `(hurt_radius (x) (+ (y) 20) 25 15 nil 10)` on an object hit. */
const STRAIT_BLAST = { radius: 25, damage: 15, maxPush: 10 }

function tickStraitRocket(rocket: StraitRocket, ctx: TickContext): void {
  // Dimmer than the player's own rocket, but there: incoming fire has to be
  // readable across a dark room.
  if (!frameSkip(ctx.host)) rocketExhaust(ctx.bursts.motes, rocket, 0.6)

  const course = setCourse(rocket.heading, rocket.speed)
  rocket.vx = course.vx
  rocket.vy = course.vy

  const outcome = bmove(ctx.level, ctx.targets, rocket, rocket.owner)
  if (outcome.kind === 'clear') return

  if (outcome.kind === 'wall') {
    // Always the plain splash. `eg_explo_ufun` takes its sideways branch only
    // `(if block_flags ...)`, and `strait_rocket_ai` hands it `(car stat)` where
    // `stat` is nil on a wall hit - so block_flags is always nil and the "bilw"
    // variant is unreachable in the original (ant.lsp:71-100).
    ctx.bursts.spawn('EG_EXPLO', rocket.x, rocket.y)
    rocket.alive = false
    return
  }

  ctx.bursts.spawn('EXPLODE3', rocket.x + randomBelow(5), rocket.y + randomBelow(5), 0)
  ctx.bursts.spawn('EXPLODE2', rocket.x + randomBelow(5), rocket.y + randomBelow(5), 2)
  ctx.bursts.spawn('EXPLODE3', rocket.x - randomBelow(5), rocket.y - randomBelow(5), 1)
  ctx.bursts.spawn('EXPLODE3', rocket.x - randomBelow(5), rocket.y - randomBelow(5), 2)
  ctx.host.hurtRadius(
    rocket.x,
    rocket.y + 20,
    STRAIT_BLAST.radius,
    STRAIT_BLAST.damage,
    null,
    STRAIT_BLAST.maxPush,
    blastSource(rocket),
  )
  rocket.alive = false
}

/* ------------------------------------------------------------------ *
 * Death ray
 * ------------------------------------------------------------------ */

const DEATH_RAY_BLAST = { radius: 50, damage: 40 }
/** `(hurt_radius (x) (y) 30 20 (bg) 15)` as it travels. */
const DEATH_RAY_AURA = { radius: 30, damage: 20, maxPush: 15 }
const DEATH_RAY_SPEED = speed(6)
const DEATH_RAY_LIFETIME = ticks(20)

function tickDeathRay(ray: DeathRay, ctx: TickContext): void {
  const frames = ctx.frameCount('deathRay')
  if (frames > 1) ray.frameIndex = (ray.frameIndex + 1) % frames

  runTendril(ray, ctx)

  ctx.host.hurtRadius(
    ray.x,
    ray.y,
    DEATH_RAY_AURA.radius,
    DEATH_RAY_AURA.damage,
    ray.owner,
    DEATH_RAY_AURA.maxPush,
    blastSource(ray),
  )

  const course = setCourse(ray.heading, DEATH_RAY_SPEED)
  ray.vx = course.vx
  ray.vy = course.vy

  quickLight(ctx, ray)

  // death_ray_ai bmoves twice per tick and, because lisp has no early return,
  // carries on running after do_dray_explo - so as shipped the ray can explode
  // and keep flying. The evident intent is taken instead: explode and stop.
  let outcome: MoveOutcome = bmove(ctx.level, ctx.targets, ray, ray.owner)
  if (outcome.kind === 'clear' && ray.age <= DEATH_RAY_LIFETIME) {
    outcome = bmove(ctx.level, ctx.targets, ray, ray.owner)
  }

  if (outcome.kind !== 'clear') {
    doDeathRayExplo(ctx, ray, ray.owner, DEATH_RAY_BLAST.radius, DEATH_RAY_BLAST.damage, 'EXPDRAY')
    ray.alive = false
    return
  }

  if (ray.age > DEATH_RAY_LIFETIME) {
    doDeathRayExplo(ctx, ray, ray.owner, DEATH_RAY_BLAST.radius, DEATH_RAY_BLAST.damage, 'EXPDRL')
    ray.alive = false
  }
}

/**
 * The Quake-2 tendril: pick one destroyable thing within ±50px, hurt it, and
 * leave a scrap of EXPDRL on it. The addon does all of this inside
 * `death_ray_draw` - cosmetics and gameplay are the same code there.
 *
 * The damage is done here instead, once a tick. A draw pass can run more often
 * than a tick under a fixed timestep, so leaving it where the addon has it
 * would scale the weapon's damage with the frame rate.
 */
const TENDRIL = {
  /** `find_object_in_area` over ±50px of object_destroyable_list. */
  searchRadius: 50,
  /** `(hurt_radius target.x target.y 1 2 (bg) 15)`. */
  damage: 2,
  maxPush: 15,
}

function runTendril(ray: DeathRay, ctx: TickContext): void {
  const r = TENDRIL.searchRadius
  const target = findTargetInArea(ctx.targets, ray.x - r, ray.y - r, ray.x + r, ray.y + r, ray.owner)
  ray.tendril = target
  if (!target) return

  ctx.bursts.spawn(
    'EXPDRL',
    target.x + 10 - randomBelow(20),
    target.y - (target.hitBox.bottom - target.hitBox.top) / 2 + 10 - randomBelow(20),
    1,
  )
  ctx.host.hurtRadius(target.x, target.y, 1, TENDRIL.damage, ray.owner, TENDRIL.maxPush, blastSource(ray))
}

/* ------------------------------------------------------------------ */

/** Runs one tick of whatever this is. */
export function tickProjectile(projectile: Projectile, ctx: TickContext): void {
  switch (projectile.kind) {
    case 'machineGun':
      tickMachineGun(projectile, ctx)
      break
    case 'grenade':
      tickGrenade(projectile, ctx)
      break
    case 'rocket':
      tickRocket(projectile, ctx)
      break
    case 'plasma':
      tickPlasma(projectile)
      break
    case 'firebomb':
      tickFirebomb(projectile, ctx)
      break
    case 'disc':
      tickDisc(projectile, ctx)
      break
    case 'lightSabre':
      tickSabre(projectile)
      break
    case 'straitRocket':
      tickStraitRocket(projectile, ctx)
      break
    case 'deathRay':
      tickDeathRay(projectile, ctx)
      break
  }
}
