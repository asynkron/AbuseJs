/**
 * What a projectile is.
 *
 * Abuse's weapons are almost all real moving objects: `fire_object` spawns a
 * `def_char` whose ai_fun runs once per tick, moves itself with `bmove` and
 * decides what to do when something stops it. Only the plasma bolt and the
 * light sabre resolve at spawn, and even those hang around for a few ticks as
 * a decal drawn in world space.
 *
 * The original keeps per-weapon state wherever it can find room - `aistate`
 * holds a heading in degrees for the rocket, the disc and the death ray, and
 * SHOTGUN_BULLET declares six `vars` of its own. Here each weapon is its own
 * member of a discriminated union, so the fields a rocket has are the fields a
 * rocket has.
 */

import type { ProjectileOwner, ProjectileTarget } from './bmove'

interface Motion {
  x: number
  y: number
  vx: number
  vy: number
  /** Previous tick's position, so the renderer can interpolate. */
  prevX: number
  prevY: number
  /** `(state_time)` - ticks since it was spawned. */
  age: number
  /**
   * The system tick this was created on, so a projectile cannot be run twice
   * on its birth tick. Two weapons run their own ai once at spawn - the
   * machine gun and the disc - and the caller may fire either side of the
   * system's own update.
   */
  spawnTick: number
  alive: boolean
  /** Linked object 0: the creator, which shots and blasts spare. */
  owner: ProjectileOwner | null
}

/**
 * SHOTGUN_BULLET. Six ticks of travel that accelerate 20% each tick, drawn as
 * a five-line streak one tick long (lisp/weapons.lsp sgun_ai, sgun_draw).
 */
export interface MachineGunBullet extends Motion {
  readonly kind: 'machineGun'
  angle: number
  speed: number
  lifetime: number
  /** The trail anchor, refreshed at the top of every tick. */
  lastX: number
  lastY: number
  readonly bright: number
  readonly medium: number
}

/** GRENADE - a gravity object that detonates on its first blocked move. */
export interface Grenade extends Motion {
  readonly kind: 'grenade'
  /** One of eight rotation frames; set from the throw angle, then tumbles. */
  frameIndex: number
}

/** ROCKET - homing, smoke-trailing, and shootable out of the air. */
export interface Rocket extends Motion {
  readonly kind: 'rocket'
  /** The original keeps this in aistate. Degrees, 0..359. */
  heading: number
  speed: number
  readonly maxSpeed: number
  target: ProjectileTarget | null
  /** `(abilities (start_hp 4))` with `(hurtable T)`. */
  health: number
}

/**
 * PLASMAGUN_BULLET. The damage is done at spawn by a single 200px `bmove`;
 * what is left is six ticks of fading scatter line hanging in world space.
 */
export interface PlasmaBolt extends Motion {
  readonly kind: 'plasma'
  /** The muzzle. x/y is the impact point - see fireObject's note. */
  readonly fromX: number
  readonly fromY: number
}

/** FIREBOMB - invisible, skids along the floor, spews flame every tick. */
export interface Firebomb extends Motion {
  readonly kind: 'firebomb'
  /** `(direction)`, which is the side its blocked test looks at. */
  facing: 1 | -1
}

/** DFRIS_BULLET - a slow disc that steers towards the mouse crosshair. */
export interface Disc extends Motion {
  readonly kind: 'disc'
  heading: number
}

/** LSABER_BULLET - one tick, 45px, 30 damage. */
export interface SabreSlash extends Motion {
  readonly kind: 'lightSabre'
  readonly fromX: number
  readonly fromY: number
}

/** STRAIT_ROCKET - the AI-only dumb rocket, fire_object type 9. */
export interface StraitRocket extends Motion {
  readonly kind: 'straitRocket'
  heading: number
  readonly speed: number
}

/** DEATH_RAY - the fRaBs Twist addon's BFG. */
export interface DeathRay extends Motion {
  readonly kind: 'deathRay'
  heading: number
  frameIndex: number
  /** Whatever the tendril latched onto this tick, for the renderer to join. */
  tendril: ProjectileTarget | null
}

export type Projectile =
  | MachineGunBullet
  | Grenade
  | Rocket
  | PlasmaBolt
  | Firebomb
  | Disc
  | SabreSlash
  | StraitRocket
  | DeathRay

export type ProjectileKind = Projectile['kind']

/** The character whose art each kind draws with, or null when it draws none. */
export const PROJECTILE_CHARACTER: Readonly<Record<ProjectileKind, string | null>> = {
  // sgun_draw never calls (draw): the sprite is entirely behind the streak.
  machineGun: null,
  grenade: 'GRENADE',
  rocket: 'ROCKET',
  // pgun_draw and lsaber_draw likewise draw only lines.
  plasma: null,
  // fb_draw returns nil, so the firebomb itself is never drawn at all - the
  // flames it emits are the whole of what you see.
  firebomb: null,
  disc: 'DFRIS_BULLET',
  lightSabre: null,
  straitRocket: 'STRAIT_ROCKET',
  // DEATH_RAY is missing from chars.json because addon/twist is not in the
  // converter's script list; its four frames are handled as a special case.
  deathRay: 'DEATH_RAY',
}

/** Shared starting point for every kind. */
export function motion(
  x: number,
  y: number,
  owner: ProjectileOwner | null,
  spawnTick: number,
): Motion {
  return { x, y, vx: 0, vy: 0, prevX: x, prevY: y, age: 0, spawnTick, alive: true, owner }
}
