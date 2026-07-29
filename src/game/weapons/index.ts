/**
 * The weapons subsystem's public surface.
 *
 * Import from `./weapons/index` rather than `./weapons`: macOS filesystems are
 * case-insensitive, and `./weapons` would be ambiguous with the existing
 * src/game/Weapons.ts.
 */

export { ProjectileSystem } from './ProjectileSystem'
export type { PlayerShot } from './ProjectileSystem'

export {
  AI_AMMO_DROP,
  AMMO_ICON_SLOT,
  PROJECTILE_TYPE,
  ROCKET_SEARCH_RADIUS,
  TORSO_FALLBACK,
  WEAPON_SLOTS,
} from './definitions'
export type { ProjectileTypeNumber, WeaponSlot } from './definitions'

export type { ProjectileHost, ProjectileLevel, ProjectileOwner, ProjectileTarget } from './host'
export type { HitBox } from './bmove'

// Useful outside the subsystem: the same line-of-sight test that gates the
// player's trigger also gates every AI's decision to shoot.
export { canSee, findTargetInArea } from './bmove'
export { atan2Deg, frameForAngle, normalizeAngle, setCourse } from './angles'

export type { Projectile, ProjectileKind } from './Projectile'
export type { BurstSink } from './blasts'
