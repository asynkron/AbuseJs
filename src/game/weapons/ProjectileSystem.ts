/**
 * The weapons subsystem: `fire_object`, the projectiles it spawns, and the
 * explosions they leave behind.
 *
 * One entry point, as in the original. `fire_object (creator type x y angle
 * target)` in lisp/guns.lsp is shared by the player and by every AI that
 * shoots, and the type is a number - which is why a turret's `aitype` is both
 * its weapon and its colour. Everything else here is that function's eight
 * arms and the ai_fun each one leaves running.
 */

import { Container, Graphics, Sprite } from 'pixi.js'

import type { Frame, GameAssets } from '../../assets/loader'
import type { RenderLight } from '../../assets/types'
import { cosDeg, frameForAngle, normalizeAngle, randomBelow, setCourse, sinDeg, atan2Deg } from './angles'
import { bmove, canSee, findTargetInArea } from './bmove'
import type { MovingPoint, ProjectileLevel, ProjectileOwner, ProjectileTarget } from './bmove'
import { tickProjectile } from './behaviour'
import type { TickContext } from './behaviour'
import type { BurstSink } from './blasts'
import { MUZZLE, WeaponGlow } from './glow'
import type { ProjectileHost } from './host'
import { ascatterLine, drawLine, rgb, scatterLine } from './lines'
import { PROJECTILE_TYPE, ROCKET_SEARCH_RADIUS, WEAPON_SLOTS } from './definitions'
import { motion, PROJECTILE_CHARACTER } from './Projectile'
import type { Projectile, ProjectileKind } from './Projectile'
import { DIFFICULTY, PLAYER_TICK_SCALE, speed, TICK_SCALE, ticks } from '../enemies/tuning'

/**
 * Characters `def_char` never produced, so chars.json has no entry - the same
 * problem the explosions have. DEATH_RAY lives in addon/twist, which is not in
 * the converter's script list, though its four frames are in the atlas under
 * their .bmp names (`(seqbmp "dray" 1 4)`).
 */
const MISSING_CHARACTERS: Readonly<Record<string, { file: string; frames: readonly string[] }>> = {
  DEATH_RAY: {
    file: 'addon/twist/art/dray.spe',
    frames: ['dray0001.bmp', 'dray0002.bmp', 'dray0003.bmp', 'dray0004.bmp'],
  },
}

/**
 * Every speed below is a velocity out of the scripts and so goes through
 * `speed()`, and every lifetime through `ticks()` - the same conversion the
 * creatures use. The two together preserve each weapon's *range*: a bullet at
 * the original's 15 for 6 of its ticks and one at speed(15) for ticks(6) of
 * ours both cover 90px, but only the converted one stays in proportion to the
 * cop and the ants moving around it.
 */

/** The bullet ballistics of the three SHOTGUN_BULLET variants. */
const BULLET_VARIANTS = {
  [PROJECTILE_TYPE.aiBullet]: {
    lifetime: ticks(6),
    speed: speed(15),
    growth: TICK_SCALE,
    bright: rgb(255, 255, 200),
    medium: rgb(150, 150, 0),
  },
  [PROJECTILE_TYPE.slowBullet]: {
    lifetime: ticks(40),
    speed: speed(6),
    growth: TICK_SCALE,
    bright: rgb(255, 128, 64),
    medium: rgb(255, 0, 0),
  },
  // The cop's own round is hand-tuned with the rest of him: his figures are read
  // as our ticks, so it leaves at 900px/s where a monster's identical round
  // leaves at 225. Putting it on the world's clock made his fire read as slow
  // motion while the monsters looked right.
  [PROJECTILE_TYPE.playerBullet]: {
    lifetime: 6,
    speed: 15,
    growth: PLAYER_TICK_SCALE,
    bright: rgb(255, 0, 0),
    medium: rgb(150, 0, 0),
  },
} as const

/** `(set_course angle 20)` for both thrown weapons. */
const THROW_SPEED = speed(20)
/**
 * The plasma bolt's single step, and the light sabre's. Both are distances
 * rather than velocities - one `bmove` of that length, resolved on the tick it
 * is fired - so neither converts.
 */
const PLASMA_RANGE = 200
const SABRE_RANGE = 45
const PLASMA_DAMAGE = 10
const SABRE_DAMAGE = 30
/** The disc leaves the hand at 25 and settles to its cruise speed at once. */
const DISC_LAUNCH_SPEED = speed(25)
const ROCKET_START_SPEED = speed(5)
/** `(if ... (isa_player) (setq max_speed 14) (setq max_speed 10))`. */
const ROCKET_MAX_SPEED_PLAYER = speed(14)
const ROCKET_MAX_SPEED_AI = speed(10)

/** The plasma beam's ramp: 255, 215, 175, 135, 95, 55 over its six ticks. */
const PLASMA_FADE_STEP = 40

/**
 * The death ray's tendril colours. The addon draws with raw palette indices
 * 239, 187, 239 (addon/twist/lisp/weapons.lsp), and resolving those would mean
 * plumbing palette.json in for three lines - so these are INVENTED to read as
 * the same white-hot core inside a violet sheath the rest of the effect uses.
 */
const TENDRIL_COLOURS = [rgb(210, 170, 255), rgb(255, 255, 255), rgb(210, 170, 255)] as const

/** What the player's trigger needs to spawn a shot. */
export interface PlayerShot {
  /** Status bar slot, 0..7. */
  slot: number
  /** The cop: the creator its own shots ignore, and whose velocity they take. */
  shooter: ProjectileOwner
  /**
   * Where the shot leaves from. Player.ts already has the 24-entry
   * `small_fire_off` table from src/cop.cpp, which is finer than the lisp's
   * `(+ (x) (* (cos angle) 17))`, so the muzzle is the caller's to decide.
   */
  muzzle: { x: number; y: number }
  /** Aim angle in Abuse degrees - 0 due right, 90 straight up. */
  angle: number
  /**
   * The point the line-of-sight gate is measured from. The lisp uses the
   * torso's `(x), (y)-16`, i.e. the chest.
   */
  from: { x: number; y: number }
  /** A rocket's lock, from the ±160px search. Ignored by every other slot. */
  target?: ProjectileTarget | null
}

export class ProjectileSystem {
  /** Add this to the world once; it holds the sprites and the beams. */
  readonly container = new Container()

  private readonly beams = new Graphics()
  /** This frame's dynamic lights, rebuilt in `draw`. See glow.ts. */
  private readonly glow = new WeaponGlow()
  private readonly live: Projectile[] = []
  private readonly sprites = new Map<Projectile, Sprite>()
  private readonly spare: Sprite[] = []
  private readonly frames = new Map<ProjectileKind, readonly Frame[]>()
  private tick = 0

  constructor(
    private readonly assets: GameAssets,
    private readonly host: ProjectileHost,
    /**
     * Where the impact sprites go. The effects subsystem owns the `def_explo`
     * catalogue and steps it at the engine's rate, so the bursts a weapon
     * leaves behind draw in its container rather than in this one.
     */
    private readonly bursts: BurstSink,
  ) {
    // Beams over the projectile sprites; both are `(add_front T)` originals.
    this.container.addChild(this.beams)
  }

  get liveCount(): number {
    return this.live.length
  }

  private get level(): ProjectileLevel {
    return this.host.level
  }

  /* ---------------------------------------------------------------- *
   * fire_object
   * ---------------------------------------------------------------- */

  /**
   * `fire_object (creator type x y angle target)`.
   *
   * `type` is the lisp's own number, so an AI can pass its `aitype` straight
   * through. Unknown types are ignored, which is what `select` does with no
   * matching arm - including type 8, which the addon's ammo_type names for the
   * death ray and `fire_object` has no case for.
   */
  fireObject(
    type: number,
    x: number,
    y: number,
    angle: number,
    owner: ProjectileOwner | null,
    target: ProjectileTarget | null = null,
    velocity?: { vx: number; vy: number },
  ): void {
    switch (type) {
      case PROJECTILE_TYPE.aiBullet:
      case PROJECTILE_TYPE.slowBullet:
      case PROJECTILE_TYPE.playerBullet:
        this.spawnBullet(type, x, y, angle, owner)
        break
      case PROJECTILE_TYPE.grenade:
        this.spawnGrenade(x, y, angle, owner, velocity)
        break
      case PROJECTILE_TYPE.rocket:
        this.spawnRocket(x, y, angle, owner, target)
        break
      case PROJECTILE_TYPE.plasma:
        this.spawnPlasma(x, y, angle, owner)
        break
      case PROJECTILE_TYPE.firebomb:
        this.spawnFirebomb(x, y, angle, owner)
        break
      case PROJECTILE_TYPE.disc:
        this.spawnDisc(x, y, angle, owner)
        break
      case PROJECTILE_TYPE.lightSabre:
        this.spawnSabre(x, y, angle, owner)
        break
      case PROJECTILE_TYPE.straitRocket:
        this.spawnStraitRocket(x, y, angle, owner)
        break
      default:
        break
    }
  }

  /**
   * The player's trigger: `player_fire_weapon` plus `fire_object`.
   *
   * Returns true when something actually left the barrel, which is the -1 the
   * torso's user_fun hands back for `add_ammo` - a refused shot costs nothing.
   * Firing is refused outright when the muzzle is not visible from the chest,
   * so the cop cannot shoot from inside a wall.
   */
  firePlayer(shot: PlayerShot): boolean {
    const slot = WEAPON_SLOTS[shot.slot]
    if (!slot) return false

    // The muzzle inherits the player's velocity, as the lisp's firex/firey do.
    const x = shot.muzzle.x + shot.shooter.vx
    const y = shot.muzzle.y + shot.shooter.vy
    if (!canSee(this.level, shot.from.x, shot.from.y, x, y, this.host.sightBlockers?.())) return false

    if (slot.projectile === null) {
      // Only the death ray, which never went through fire_object.
      this.spawnDeathRay(shot.shooter)
      return true
    }

    this.fireObject(slot.projectile, x, y, shot.angle, shot.shooter, shot.target ?? null)
    return true
  }

  /**
   * `find_object_in_area` over ±160px, which is the lock the rocket asks for
   * (lisp/people.lsp, player_rocket_ufun). Pass the result to `firePlayer`.
   */
  findRocketTarget(x: number, y: number): ProjectileTarget | null {
    const r = ROCKET_SEARCH_RADIUS
    return findTargetInArea(this.host.targets(), x - r, y - r, x + r, y + r, null)
  }

  /**
   * The death ray, spawned the way the addon spawns it: a hand-written block
   * at the top of `get_local_input` puts a DEATH_RAY at the player's middle
   * and spends a round (lisp/input.lsp). Its heading is taken from the
   * crosshair once, at birth, and never re-aimed.
   *
   * Two things about the shipped version are not reproduced. It only fires
   * when `(<= (ammo_total 7) 1)`, which is plainly an inverted test - the
   * caller here spends ammo the ordinary way. And its cadence lives in a
   * global reset every 15 ticks, which is a fire delay by another name and is
   * carried in the slot table instead.
   */
  spawnDeathRay(owner: ProjectileOwner): void {
    const pointer = this.host.pointer()
    const y = owner.y - this.pictureHeight('deathRay') / 2
    const heading = pointer ? atan2Deg(y - pointer.y - 4, pointer.x - owner.x) : 0

    this.host.playSound('DEATH_RAY_SND', owner.x, y)
    this.muzzleFlash('deathRay', owner.x, y)
    this.add({
      kind: 'deathRay',
      ...motion(owner.x, y, owner, this.tick),
      heading: normalizeAngle(heading),
      frameIndex: 0,
      tendril: null,
    })
  }

  /* ---------------------------------------------------------------- *
   * The eight arms
   * ---------------------------------------------------------------- */

  private spawnBullet(
    type: keyof typeof BULLET_VARIANTS,
    x: number,
    y: number,
    angle: number,
    owner: ProjectileOwner | null,
  ): void {
    const variant = BULLET_VARIANTS[type]
    this.host.playSound('ZAP_SND', x, y)
    this.muzzleFlash('machineGun', x, y)

    // fire_object also does `(setq sgb_speed (+ sgb_speed (/ (xvel) 2)))`
    // inside the new bullet's own scope, so `(xvel)` is the bullet's own and
    // still 0. It reads as an intent to inherit the shooter's speed that never
    // fires, so it is left out.
    const bullet: Projectile = {
      kind: 'machineGun',
      ...motion(x, y, owner, this.tick),
      angle: normalizeAngle(angle),
      speed: variant.speed,
      lifetime: variant.lifetime,
      growth: variant.growth,
      lastX: x,
      lastY: y,
      bright: variant.bright,
      medium: variant.medium,
    }
    this.add(bullet)
    // `(sgun_ai)` runs immediately, so the bullet already travels on the tick
    // it was fired.
    tickProjectile(bullet, this.context())
    bullet.age++
    if (!bullet.alive) this.retire(bullet)
  }

  /**
   * `velocity` overrides the angle-derived course for the one caller that sets
   * its grenade's velocity by hand - see EnemyShot.velocity. Note it also
   * skips inheriting the thrower's motion, because the jugger's assignment
   * replaces rather than adds.
   */
  private spawnGrenade(
    x: number,
    y: number,
    angle: number,
    owner: ProjectileOwner | null,
    velocity?: { vx: number; vy: number },
  ): void {
    this.host.playSound('GRENADE_THROW', x, y)
    const course = velocity ?? setCourse(angle, THROW_SPEED)
    const grenade: Projectile = {
      kind: 'grenade',
      ...motion(x, y, owner, this.tick),
      // A thrown grenade carries the thrower's whole velocity, so running
      // forward throws further.
      vx: course.vx + (velocity ? 0 : (owner?.vx ?? 0)),
      vy: course.vy + (velocity ? 0 : (owner?.vy ?? 0)),
      frameIndex: frameForAngle(angle, this.frameCount('grenade')),
    }
    this.add(grenade)
  }

  private spawnRocket(
    x: number,
    y: number,
    angle: number,
    owner: ProjectileOwner | null,
    target: ProjectileTarget | null,
  ): void {
    this.host.playSound('ROCKET_LAUNCH_SND', x, y)
    this.muzzleFlash('rocket', x, y)
    // No lock through walls: the target is linked only if it can be seen.
    const locked = target && canSee(this.level, x, y, target.x, target.y) ? target : null

    this.add({
      kind: 'rocket',
      // The sprite is centred on its frame, so the spawn drops half a frame to
      // line up with the muzzle.
      ...motion(x, y + this.pictureHeight('rocket') / 2, owner, this.tick),
      heading: normalizeAngle(angle),
      speed: ROCKET_START_SPEED,
      maxSpeed: owner?.isPlayer ? ROCKET_MAX_SPEED_PLAYER : ROCKET_MAX_SPEED_AI,
      target: locked,
      // `(abilities (start_hp 4))` with `(hurtable T)`: rockets can be shot
      // out of the air.
      health: 4,
    })
  }

  /**
   * The plasma bolt is genuinely instantaneous: one 200px `bmove` at spawn,
   * and what is left is a decal.
   */
  private spawnPlasma(x: number, y: number, angle: number, owner: ProjectileOwner | null): void {
    this.host.playSound('PLASMA_SND', x, y)
    this.muzzleFlash('plasma', x, y)
    const impact = this.sweep(x, y, angle, PLASMA_RANGE, owner)

    if (impact.outcome.kind === 'wall') {
      this.bursts.spawn('EXPLODE5', impact.x - randomBelow(5), impact.y - randomBelow(5))
    } else if (impact.outcome.kind === 'object') {
      this.bursts.spawn('EXPLODE3', impact.x - randomBelow(5), impact.y - randomBelow(5))
      // The lisp pushes with `(cos sgb_angle)`, but sgb_angle is never
      // assigned on this path - a real bug in the shipped script, which pushes
      // by whatever the variable happened to hold. The fire angle is used.
      this.host.damage(impact.outcome.target, PLASMA_DAMAGE, cosDeg(angle) * 20, sinDeg(angle) * 10)
    }

    this.add({
      kind: 'plasma',
      // The lisp keeps the impact in sgb_lastx/lasty and restores x/y to the
      // muzzle; the beam is the same segment either way.
      ...motion(impact.x, impact.y, owner, this.tick),
      fromX: x,
      fromY: y,
    })
  }

  private spawnFirebomb(x: number, y: number, angle: number, owner: ProjectileOwner | null): void {
    this.host.playSound('FIREBOMB_SND', x, y)
    const course = setCourse(angle, THROW_SPEED)
    this.add({
      kind: 'firebomb',
      ...motion(x, y, owner, this.tick),
      vx: course.vx,
      // The firebomb inherits the thrower's yvel only, not xvel.
      vy: course.vy + (owner?.vy ?? 0),
      // Through fire_object nothing sets `(direction)`, so a firebomb thrown
      // left never tests blocked_left and only ever dies of old age. Taking
      // the facing from the throw is the evident intent.
      facing: course.vx < 0 ? -1 : 1,
    })
  }

  private spawnDisc(x: number, y: number, angle: number, owner: ProjectileOwner | null): void {
    this.host.playSound('ROCKET_LAUNCH_SND', x, y)
    this.muzzleFlash('disc', x, y)
    const course = setCourse(angle, DISC_LAUNCH_SPEED)
    const disc: Projectile = {
      kind: 'disc',
      ...motion(x, y, owner, this.tick),
      vx: course.vx,
      vy: course.vy,
      heading: normalizeAngle(angle),
    }
    this.add(disc)
    // `(dfris_ai)` runs immediately, as the machine gun's does.
    tickProjectile(disc, this.context())
    disc.age++
    if (!disc.alive) this.retire(disc)
  }

  /** 45px, 30 damage, and nothing at all happens on a wall hit. */
  private spawnSabre(x: number, y: number, angle: number, owner: ProjectileOwner | null): void {
    this.host.playSound('LSABER_SND', x, y)
    this.muzzleFlash('lightSabre', x, y)
    const impact = this.sweep(x, y, angle, SABRE_RANGE, owner)
    if (impact.outcome.kind === 'object') {
      // Same stale sgb_angle as the plasma bolt; the fire angle is used.
      this.host.damage(impact.outcome.target, SABRE_DAMAGE, cosDeg(angle) * 20, sinDeg(angle) * 10)
    }
    this.add({
      kind: 'lightSabre',
      ...motion(impact.x, impact.y, owner, this.tick),
      fromX: x,
      fromY: y,
    })
  }

  private spawnStraitRocket(
    x: number,
    y: number,
    angle: number,
    owner: ProjectileOwner | null,
  ): void {
    // Both sounds, back to back, as fire_object's arm 9 plays them.
    this.host.playSound('MGUN_SND', x, y)
    this.host.playSound('GRENADE_THROW', x, y)
    this.muzzleFlash('straitRocket', x, y)
    this.add({
      kind: 'straitRocket',
      ...motion(x, y, owner, this.tick),
      heading: normalizeAngle(angle),
      // `strait_rocket_ai` picks its speed by difficulty - easy 12, medium 15,
      // hard 17, extreme 22 - and `hard` is what startup.lsp falls back to
      // with no hardness.lsp to load, which is the case here.
      speed: DIFFICULTY.straitRocketSpeed,
    })
  }

  /** One `bmove` of `range` px, for the two weapons that resolve at spawn. */
  private sweep(
    x: number,
    y: number,
    angle: number,
    range: number,
    owner: ProjectileOwner | null,
  ): { x: number; y: number; outcome: ReturnType<typeof bmove> } {
    const course = setCourse(angle, range)
    const mover: MovingPoint = { x, y, vx: course.vx, vy: course.vy }
    const outcome = bmove(this.level, this.host.targets(), mover, owner)
    return { x: mover.x, y: mover.y, outcome }
  }

  /* ---------------------------------------------------------------- *
   * Simulation
   * ---------------------------------------------------------------- */

  /** One tick: every projectile, then every explosion. */
  update(): void {
    const ctx = this.context()

    for (const projectile of this.live) {
      // Two weapons already ran their ai at spawn, and the caller may fire
      // either side of this pass, so nothing runs twice on its birth tick.
      if (projectile.spawnTick === this.tick) continue
      projectile.prevX = projectile.x
      projectile.prevY = projectile.y
      tickProjectile(projectile, ctx)
      projectile.age++
    }

    for (let i = this.live.length - 1; i >= 0; i--) {
      if (!this.live[i].alive) this.remove(i)
    }

    this.tick++
  }

  /**
   * Damages any projectile in flight that is hurtable, which today is the
   * rocket alone - `(flags (hurtable T))` with 4hp, so it can be shot down.
   * Returns true if anything was hit.
   */
  hurtProjectiles(x: number, y: number, radius: number, amount: number): boolean {
    let hit = false
    for (const projectile of this.live) {
      if (projectile.kind !== 'rocket') continue
      if (Math.hypot(projectile.x - x, projectile.y - y) > radius) continue
      projectile.health -= amount
      hit = true
    }
    return hit
  }

  draw(alpha: number): void {
    this.beams.clear()
    this.glow.begin()

    for (const projectile of this.live) {
      const x = projectile.prevX + (projectile.x - projectile.prevX) * alpha
      const y = projectile.prevY + (projectile.y - projectile.prevY) * alpha
      this.drawOne(projectile, x, y)
      // Collected here rather than on the tick, because this is where the
      // interpolated position already exists - a light a frame behind the
      // sprite it belongs to is visible at these speeds.
      this.glow.collect(projectile, x, y)
    }
  }

  /**
   * Lights the projectiles are throwing this frame. Rebuilt by `draw`, so read
   * it after. Invented in full - see glow.ts.
   */
  get lights(): readonly RenderLight[] {
    return this.glow.lights
  }

  /**
   * The flash at the barrel. Invented; the original has none, and because
   * `fire_object` is the shared dispatch it covers the monsters' guns too.
   */
  private muzzleFlash(kind: ProjectileKind, x: number, y: number): void {
    const flash = MUZZLE[kind]
    if (!flash) return
    this.host.addLight?.(x, y, flash.outer, {
      ticks: flash.ticks,
      peak: flash.peak,
      tint: flash.tint,
    })
  }

  clear(): void {
    for (const projectile of this.live) this.releaseSprite(projectile)
    this.live.length = 0
    this.beams.clear()
  }

  /* ---------------------------------------------------------------- *
   * Drawing
   * ---------------------------------------------------------------- */

  private drawOne(projectile: Projectile, x: number, y: number): void {
    switch (projectile.kind) {
      case 'machineGun': {
        // sgun_draw: five lines from last tick's position to this one, so the
        // streak is exactly one tick of travel long and grows with the speed.
        const g = this.beams
        const { lastX: lx, lastY: ly, bright, medium } = projectile
        drawLine(g, lx, ly - 1, projectile.x, projectile.y - 1, medium)
        drawLine(g, lx, ly + 1, projectile.x, projectile.y + 1, medium)
        drawLine(g, lx - 1, ly, projectile.x - 1, projectile.y, bright)
        drawLine(g, lx + 1, ly, projectile.x + 1, projectile.y, medium)
        drawLine(g, lx, ly, projectile.x, projectile.y, bright)
        break
      }
      case 'plasma': {
        // pgun_draw: a clean core inside a halo that widens as it fades.
        const c = Math.max(0, 255 - projectile.age * PLASMA_FADE_STEP)
        const colour = rgb(c, Math.floor(c / 2), c)
        const { fromX, fromY } = projectile
        scatterLine(this.beams, fromX, fromY, projectile.x, projectile.y, colour, projectile.age)
        scatterLine(this.beams, fromX, fromY, projectile.x, projectile.y, colour, 0)
        break
      }
      case 'lightSabre': {
        // lsaber_draw: white core, pale-blue scatter, then the same
        // ascatter_line the force fields are drawn with.
        const { fromX, fromY } = projectile
        const white = rgb(255, 255, 255)
        scatterLine(this.beams, fromX, fromY, projectile.x, projectile.y, white, 0)
        scatterLine(this.beams, fromX, fromY, projectile.x, projectile.y, rgb(147, 155, 195), 2)
        ascatterLine(this.beams, fromX, fromY, projectile.x, projectile.y, white, rgb(70, 59, 67), 1)
        break
      }
      case 'grenade':
        this.placeSprite(projectile, x, y, projectile.frameIndex)
        break
      case 'rocket':
        this.placeSprite(projectile, x, y, frameForAngle(projectile.heading, this.frameCount('rocket')))
        break
      case 'straitRocket':
        this.placeSprite(
          projectile,
          x,
          y,
          frameForAngle(projectile.heading, this.frameCount('straitRocket')),
        )
        break
      case 'disc':
        this.placeSprite(projectile, x, y, 0)
        break
      case 'deathRay': {
        this.placeSprite(projectile, x, y, projectile.frameIndex)
        const target = projectile.tendril
        if (target) {
          const ty = target.y - (target.hitBox.bottom - target.hitBox.top) / 2
          TENDRIL_COLOURS.forEach((colour, i) => {
            drawLine(this.beams, target.x + i - 1, ty, x + i - 1, y - 10, colour)
          })
        }
        break
      }
      case 'firebomb':
        // fb_draw returns nil: there is nothing to draw but the flames.
        break
    }
  }

  private placeSprite(projectile: Projectile, x: number, y: number, frameIndex: number): void {
    const sprite = this.sprites.get(projectile)
    const frames = this.framesFor(projectile.kind)
    const frame = frames[frameIndex] ?? frames[0]
    if (!sprite || !frame) return

    sprite.visible = true
    sprite.texture = frame.texture
    // The engine's own anchoring: blit at x - xcfg, y - height + 1.
    sprite.x = Math.round(x - frame.xcfg)
    sprite.y = Math.round(y - frame.height + 1)
  }

  /* ---------------------------------------------------------------- *
   * Bookkeeping
   * ---------------------------------------------------------------- */

  private context(): TickContext {
    return {
      host: this.host,
      bursts: this.bursts,
      level: this.level,
      targets: this.host.targets(),
      gameTick: this.tick,
      pictureHeight: (kind) => this.pictureHeight(kind),
      frameCount: (kind) => this.frameCount(kind),
    }
  }

  private add(projectile: Projectile): void {
    this.live.push(projectile)
    if (!this.framesFor(projectile.kind).length) return

    const sprite = this.spare.pop() ?? new Sprite()
    sprite.visible = false
    this.container.addChild(sprite)
    this.sprites.set(projectile, sprite)
  }

  /** Drops one that died the same tick it was created. */
  private retire(projectile: Projectile): void {
    const index = this.live.indexOf(projectile)
    if (index >= 0) this.remove(index)
  }

  private remove(index: number): void {
    const projectile = this.live[index]
    this.live.splice(index, 1)
    this.releaseSprite(projectile)
  }

  private releaseSprite(projectile: Projectile): void {
    const sprite = this.sprites.get(projectile)
    if (!sprite) return
    this.sprites.delete(projectile)
    this.container.removeChild(sprite)
    sprite.visible = false
    this.spare.push(sprite)
  }

  private framesFor(kind: ProjectileKind): readonly Frame[] {
    const cached = this.frames.get(kind)
    if (cached) return cached

    const character = PROJECTILE_CHARACTER[kind]
    let frames: readonly Frame[] = []
    if (character) {
      frames = this.assets.animation(character, 'stopped')
      if (!frames.length) {
        const fallback = MISSING_CHARACTERS[character]
        if (fallback) {
          frames = fallback.frames
            .map((name) => this.assets.frame(fallback.file, name))
            .filter((frame): frame is Frame => frame !== undefined)
        }
      }
    }

    this.frames.set(kind, frames)
    return frames
  }

  private frameCount(kind: ProjectileKind): number {
    return this.framesFor(kind).length
  }

  private pictureHeight(kind: ProjectileKind): number {
    return this.framesFor(kind)[0]?.height ?? 0
  }
}
