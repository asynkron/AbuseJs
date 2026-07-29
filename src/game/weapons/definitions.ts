/**
 * The eight weapon slots, and the numeric projectile types they fire.
 *
 * There is exactly one dispatch point in the original - `fire_object (creator
 * type x y angle target)` in lisp/guns.lsp - and the type is a plain number
 * shared by the player and by every AI that shoots. A turret's `aitype` *is*
 * its weapon, which is also what `gun_tints` colours it by, so an AI fires by
 * handing its own aitype straight to `fireObject`.
 */

/** The `select type` arms of `fire_object` (lisp/guns.lsp). */
export const PROJECTILE_TYPE = {
  /** Yellow SHOTGUN_BULLET, lifetime 6, speed 15. The default AI shot. */
  aiBullet: 0,
  /** Orange SHOTGUN_BULLET, lifetime 40, speed 6. A slow tracer. */
  slowBullet: 1,
  grenade: 2,
  rocket: 3,
  plasma: 4,
  firebomb: 5,
  disc: 6,
  lightSabre: 7,
  /** AI-only, ant.lsp's STRAIT_ROCKET. */
  straitRocket: 9,
  /** Red SHOTGUN_BULLET - the player's machine gun, from `ammo_type`. */
  playerBullet: 10,
} as const

export type ProjectileTypeNumber = (typeof PROJECTILE_TYPE)[keyof typeof PROJECTILE_TYPE]

export interface WeaponSlot {
  /** Status bar position, 0..7. */
  readonly slot: number
  readonly name: string
  /** Pickup prefix: `MBULLET_ICON20` -> `MBULLET`. */
  readonly pickup: string
  /** Torso character in art/coptop.spe, 24 aim frames. */
  readonly top: string
  /**
   * What `fire_object` is asked for. Null for the death ray, which has no
   * `fire_object` arm at all and is spawned by hand.
   */
  readonly projectile: number | null
  /** `fire_delay1` in ticks, set by the torso's user_fun. */
  readonly fireDelay: number
  /** Delay when the magazine is empty; only the machine gun has one. */
  readonly dryFireDelay: number | null
  /** Rounds spent per shot that actually left the barrel. */
  readonly ammoCost: number
}

/**
 * Slot order is the `giver` calls in `weapon_icon_ai` (lisp/weapons.lsp), whose
 * own comment reads "these numbers correspond to status bar position".
 *
 * Note slots 3 and 4: the firebomb is 3 and the plasma rifle is 4. The existing
 * src/game/Weapons.ts has those two the other way round, which is a straight
 * bug against the original and is why an ammo box marked plasma tops up the
 * wrong magazine.
 */
export const WEAPON_SLOTS: readonly WeaponSlot[] = [
  {
    slot: 0,
    name: 'machine gun',
    pickup: 'MBULLET',
    top: 'MGUN_TOP',
    // ammo_type maps MGUN_TOP to 10, the red variant - not the yellow 0 the AI use.
    projectile: PROJECTILE_TYPE.playerBullet,
    // laser_ufun: 3 ticks with ammo, 7 without. The only gun that dry-fires.
    fireDelay: 3,
    dryFireDelay: 7,
    ammoCost: 1,
  },
  {
    slot: 1,
    name: 'grenade',
    pickup: 'GRENADE',
    top: 'GRENADE_TOP',
    projectile: PROJECTILE_TYPE.grenade,
    // top_ufun's generic 12, shared by the grenade, firebomb and disc.
    fireDelay: 12,
    dryFireDelay: null,
    ammoCost: 1,
  },
  {
    slot: 2,
    name: 'rocket',
    pickup: 'ROCKET',
    top: 'ROCKET_TOP',
    projectile: PROJECTILE_TYPE.rocket,
    // player_rocket_ufun.
    fireDelay: 12,
    dryFireDelay: null,
    ammoCost: 1,
  },
  {
    slot: 3,
    name: 'firebomb',
    pickup: 'FBOMB',
    top: 'FIREBOMB_TOP',
    projectile: PROJECTILE_TYPE.firebomb,
    fireDelay: 12,
    dryFireDelay: null,
    ammoCost: 1,
  },
  {
    slot: 4,
    name: 'plasma rifle',
    pickup: 'PLASMA',
    top: 'PGUN_TOP',
    projectile: PROJECTILE_TYPE.plasma,
    // plaser_ufun's 2 - the fastest weapon in the game.
    fireDelay: 2,
    dryFireDelay: null,
    ammoCost: 1,
  },
  {
    slot: 5,
    name: 'light sabre',
    // The torso really is called LIGHT_SABER, not LSABER_TOP: people.lsp's
    // ammo_type entry for (LSABER_TOP 5) names a symbol that exists nowhere,
    // and its type number is the firebomb's. 7 is what fire_object's own arm
    // spawns, so 7 it is. The 24-frame "4gch" torso is in the atlas, so there
    // is no reason to fall back to the machine gun's as Weapons.ts does.
    pickup: 'LSABER',
    top: 'LIGHT_SABER',
    projectile: PROJECTILE_TYPE.lightSabre,
    // INVENTED. `lsaber_ufun` is named by make_top_char and then never
    // defined, so the shipped scripts have no delay for this weapon at all.
    // 6 sits between plasma's 2 and the generic 12, which is about right for
    // 30 damage a swing at 45px of reach.
    fireDelay: 6,
    dryFireDelay: null,
    ammoCost: 1,
  },
  {
    slot: 6,
    name: 'disc frisbee',
    // ammo_type's (DFIRS_TOP 6) is a typo for DFRIS_TOP; the type number 6 is
    // right, and fire_object's arm 6 spawns DFRIS_BULLET.
    pickup: 'DFRIS',
    top: 'DFRIS_TOP',
    projectile: PROJECTILE_TYPE.disc,
    fireDelay: 12,
    dryFireDelay: null,
    ammoCost: 1,
  },
  {
    slot: 7,
    name: 'death ray',
    pickup: 'DRAY',
    top: 'DRAY_TOP',
    // The addon's ammo_type maps DRAY_TOP to 8, but fire_object has no arm 8.
    // `dray_ufun` returns 0 and the projectile is spawned by a hand-written
    // block in get_local_input, so this slot goes through spawnDeathRay.
    projectile: null,
    // Not a fire_delay1 at all: get_local_input clears dray_has_fired every
    // 15 game ticks, so the cadence is one shot per 15 (lisp/input.lsp).
    fireDelay: 15,
    dryFireDelay: null,
    ammoCost: 1,
  },
]

/**
 * The torso art each slot uses, for slots whose character the converter never
 * recorded. DRAY_TOP comes from addon/twist, which is not in the converter's
 * script list, but its 24 frames are in the atlas under their own names.
 */
export const TORSO_FALLBACK: Readonly<Record<string, { file: string; frames: readonly string[] }>> = {
  DRAY_TOP: {
    file: 'art/coptop.spe',
    // (make_top_char 'DRAY_TOP "4gbf" ...) - addon/twist/lisp/weapons.lsp.
    frames: Array.from({ length: 24 }, (_, i) => `4gbf${String(i + 1).padStart(4, '0')}.pcx`),
  },
}

/**
 * Ammo pickups, by icon character, to the slot they top up. Straight from the
 * `select (otype)` in `weapon_icon_ai`; the amount is the icon's own `start_hp`
 * ability, which `giver` reads with `(get_ability start_hp)`.
 */
export const AMMO_ICON_SLOT: Readonly<Record<string, number>> = {
  MBULLET_ICON5: 0,
  MBULLET_ICON20: 0,
  GRENADE_ICON2: 1,
  GRENADE_ICON10: 1,
  ROCKET_ICON2: 2,
  ROCKET_ICON5: 2,
  FBOMB_ICON1: 3,
  FBOMB_ICON5: 3,
  PLASMA_ICON20: 4,
  PLASMA_ICON50: 4,
  LSABER_ICON50: 5,
  LSABER_ICON100: 5,
  DFRIS_ICON4: 6,
  DFRIS_ICON10: 6,
  // addon/twist/lisp/weapons.lsp adds these two for slot 7.
  DRAY_ICON4: 7,
  DRAY_ICON8: 7,
}

/**
 * What a killed shooter drops, by its aitype - `ai_ammo` in lisp/guns.lsp.
 * Index 0..8; everything outside 2..4 drops rifle rounds.
 */
export const AI_AMMO_DROP: readonly string[] = [
  'MBULLET_ICON5',
  'MBULLET_ICON5',
  'GRENADE_ICON2',
  'ROCKET_ICON2',
  'PLASMA_ICON20',
  'MBULLET_ICON5',
  'MBULLET_ICON5',
  'MBULLET_ICON5',
  'MBULLET_ICON5',
]

/** The ±160px box `player_rocket_ufun` searches for something to lock onto. */
export const ROCKET_SEARCH_RADIUS = 160
