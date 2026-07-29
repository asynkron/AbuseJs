import type { Prop } from '../Prop'
import type { EnemyShot, EnemySound } from './types'

/**
 * What an `aitype` fires.
 *
 * Every enemy shot in Abuse goes through `fire_object(creator, type, x, y,
 * angle, target)` in lisp/guns.lsp, where `type` is the shooter's own aitype.
 * The same number picks an ant's tint, its health and its gun, which is why a
 * blue ant is dangerous and a green one is not.
 *
 * Nothing in this game travels - the cop's own eight weapons are hitscan
 * tracers - so each entry here is the payload and the look of the round rather
 * than a projectile. The damage figures are the originals; the flight is not.
 */
export interface EnemyWeapon {
  /** Damage to whatever it hits directly. */
  damage: number
  /** Blast for the rounds that explode, in pixels and health. */
  splash?: { radius: number; damage: number }
  /** Tracer colour. */
  colour: number
  sound: EnemySound
}

/**
 * Colours.
 *
 * Types 0, 1 and 10 carry their own `find_rgb` pairs in fire_object and use
 * the bright one. The rest have no colour of their own - they were whole
 * sprites - so these are read off the gun tint each round is drawn with
 * (`gun_tints` in lisp/guns.lsp: 1 orange, 2 green for the grenade, 3 redish
 * for the rocket, 4 blue for the plasma). The exact shades are invented; the
 * point is that a rocket does not look like a plasma bolt.
 */
const WEAPONS: Record<number, EnemyWeapon> = {
  // fire_object case 0: SHOTGUN_BULLET, speed 15, lifetime 6, do_damage 5 in
  // sgun_ai (lisp/weapons.lsp). The default ant round.
  0: { damage: 5, colour: 0xffffc8, sound: 'ZAP_SND' },
  // case 1: the same character at speed 6 with a 40-tick life - the slow
  // orange bolt - and the same 5 damage.
  1: { damage: 5, colour: 0xff8040, sound: 'ZAP_SND' },
  // case 2: GRENADE. grenade_ai ends in do_explo 40 36.
  2: { damage: 36, splash: { radius: 40, damage: 36 }, colour: 0x60c040, sound: 'GRENADE_THROW' },
  // case 3: ROCKET, homing. rocket_ai ends in do_explo 40 50.
  3: { damage: 50, splash: { radius: 40, damage: 50 }, colour: 0xff6040, sound: 'ROCKET_LAUNCH_SND' },
  // case 4: PLASMAGUN_BULLET, resolved in a single 200px step - already
  // hitscan in the original - for do_damage 10.
  4: { damage: 10, colour: 0x60a0ff, sound: 'PLASMA_SND' },
  // case 5: FIREBOMB. firebomb_ai calls hurt_radius 60 40 every tick it burns.
  5: { damage: 40, splash: { radius: 60, damage: 40 }, colour: 0xff9020, sound: 'FIREBOMB_SND' },
  // case 6: DFRIS_BULLET, homing disc. dfris_ai ends in do_white_explo 40 45.
  6: { damage: 45, splash: { radius: 40, damage: 45 }, colour: 0xe0e0ff, sound: 'ROCKET_LAUNCH_SND' },
  // case 7: LSABER_BULLET, another single-step beam, do_damage 30.
  7: { damage: 30, colour: 0xa0d0ff, sound: 'LSABER_SND' },
  // case 9: STRAIT_ROCKET, the flyer's round. strait_rocket_ai finishes with
  // hurt_radius(x, y+20, 25, 15, nil, 10) - from is nil, so in the original it
  // hurts monsters too.
  9: { damage: 15, splash: { radius: 25, damage: 15 }, colour: 0xffc080, sound: 'MGUN_SND' },
  // case 10: the fast round again, in red.
  10: { damage: 5, colour: 0xff4040, sound: 'ZAP_SND' },
}

/** Falls back to the plain fast round, which is what aitype 0 fires. */
export function weaponFor(aitype: number): EnemyWeapon {
  return WEAPONS[aitype] ?? WEAPONS[0]
}

/** Builds a shot of the given aitype leaving a muzzle at an angle. */
export function shotFrom(
  aitype: number,
  x: number,
  y: number,
  angle: number,
  shooter?: Prop,
): EnemyShot {
  const weapon = weaponFor(aitype)
  return {
    x,
    y,
    angle,
    aitype,
    shooter,
    damage: weapon.damage,
    splash: weapon.splash,
    colour: weapon.colour,
    sound: weapon.sound,
  }
}

/**
 * `ai_ammo` in lisp/guns.lsp: the pickup a monster of this aitype leaves
 * behind. Nine entries, and an ant's aitype never exceeds 5, so the upgrade
 * branch that asks for `aitype + 1` stays inside the table.
 */
const AI_AMMO = [
  'MBULLET_ICON5',
  'MBULLET_ICON5',
  'GRENADE_ICON2',
  'ROCKET_ICON2',
  'PLASMA_ICON20',
  'MBULLET_ICON5',
  'MBULLET_ICON5',
  'MBULLET_ICON5',
  'MBULLET_ICON5',
] as const

export function ammoFor(aitype: number): string {
  return AI_AMMO[Math.max(0, Math.min(AI_AMMO.length - 1, aitype))]
}

/**
 * The angle from a muzzle to a point, in the degrees-counter-clockwise
 * convention the tracers use.
 *
 * `(atan2 (- firey playery) (- playerx firex))` in lisp/ant.lsp - the y term
 * is inverted before the call because the original's atan2 works in maths
 * coordinates while the screen's y grows downwards.
 */
export function aimAngle(fromX: number, fromY: number, toX: number, toY: number): number {
  return (Math.atan2(fromY - toY, toX - fromX) * 180) / Math.PI
}
