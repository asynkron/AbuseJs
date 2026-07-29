/**
 * The eight weapons, and the powers the special button spends.
 *
 * The status bar has eight slots and the art ships eight lit/dim icon pairs
 * (`bweap0001..8` / `dweap0001..8`), and every level scatters ammo for all of
 * them - `MBULLET_ICON20`, `GRENADE_ICON10`, `ROCKET_ICON2` and so on, each
 * naming its own amount. The pickup prefix is what ties an icon to a slot.
 *
 * Each weapon also has its own 24-frame torso in `art/coptop.spe`, so the cop
 * visibly holds the thing he is firing. Two of them - the light sabre and the
 * death ray - never got one, and fall back to the machine gun's.
 *
 * The behaviour is ours. All eight fire hitscan tracers, and what separates
 * them is rate, damage, how many go out per pull, how far they spread and
 * whether the impact hurts anything standing near it.
 */

export interface WeaponDef {
  /** Pickup prefix: `MBULLET_ICON20` -> `MBULLET`. */
  readonly pickup: string
  readonly name: string
  /** Torso character, drawn over the legs. */
  readonly top: string
  /** Damage per tracer. */
  readonly damage: number
  /** Ticks between shots. */
  readonly delay: number
  /** Tracers per pull of the trigger. */
  readonly shots: number
  /** Half-angle the shots are spread over, in degrees. */
  readonly spread: number
  /** Radius around an impact that also takes damage; 0 for none. */
  readonly splash: number
  readonly tracer: number
  /** Rounds spent per pull. */
  readonly cost: number
}

/**
 * Slot order follows the status bar's icon order. Slot 0 is the machine gun,
 * which the cop always has - the rest arrive with their ammo.
 */
export const WEAPONS: readonly WeaponDef[] = [
  {
    pickup: 'MBULLET',
    name: 'machine gun',
    top: 'MGUN_TOP',
    damage: 5,
    delay: 3,
    shots: 1,
    spread: 0,
    splash: 0,
    tracer: 0xffe08a,
    cost: 1,
  },
  {
    pickup: 'GRENADE',
    name: 'grenade',
    top: 'GRENADE_TOP',
    damage: 14,
    delay: 26,
    shots: 1,
    spread: 0,
    splash: 46,
    tracer: 0x9de24a,
    cost: 1,
  },
  {
    pickup: 'ROCKET',
    name: 'rocket',
    top: 'ROCKET_TOP',
    damage: 30,
    delay: 34,
    shots: 1,
    spread: 0,
    splash: 60,
    tracer: 0xff8a3c,
    cost: 1,
  },
  {
    pickup: 'PLASMA',
    name: 'plasma rifle',
    top: 'PGUN_TOP',
    damage: 9,
    delay: 5,
    shots: 1,
    spread: 1.5,
    splash: 0,
    tracer: 0x6ad2ff,
    cost: 1,
  },
  {
    pickup: 'FBOMB',
    name: 'firebomb',
    top: 'FIREBOMB_TOP',
    damage: 12,
    delay: 30,
    shots: 3,
    spread: 9,
    splash: 34,
    tracer: 0xff5a2a,
    cost: 1,
  },
  {
    pickup: 'LSABER',
    name: 'light sabre',
    top: 'MGUN_TOP',
    damage: 22,
    delay: 6,
    shots: 1,
    spread: 0,
    splash: 0,
    tracer: 0xd8a0ff,
    cost: 1,
  },
  {
    pickup: 'DFRIS',
    name: 'disc frisbee',
    top: 'DFRIS_TOP',
    damage: 11,
    delay: 16,
    shots: 5,
    spread: 22,
    splash: 0,
    tracer: 0xfff0c0,
    cost: 1,
  },
  {
    pickup: 'DRAY',
    name: 'death ray',
    top: 'MGUN_TOP',
    damage: 26,
    delay: 12,
    shots: 1,
    spread: 0,
    splash: 0,
    tracer: 0xff4de0,
    cost: 1,
  },
]

/** `GRENADE_ICON10` -> `{ slot: 1, amount: 10 }`. Null for anything else. */
export function ammoPickup(type: string): { slot: number; amount: number } | null {
  const match = /^([A-Z]+)_ICON(\d+)$/.exec(type)
  if (!match) return null
  const slot = WEAPONS.findIndex((w) => w.pickup === match[1])
  if (slot < 0) return null
  return { slot, amount: Number(match[2]) }
}

/* ------------------------------------------------------------------ */
/* special powers                                                      */
/* ------------------------------------------------------------------ */

/**
 * What holding the special button spends.
 *
 * The levels place these as `POWER_FAST`, `POWER_FLY`, `POWER_SNEAKY` and
 * `POWER_HEALTH` - level00 has a POWER_FAST sitting next to the tutorial line
 * that tells you about them. `POWER_NONE` exists too and is exactly what it
 * says. A power is not spent on pickup: it is held, and the charge only drains
 * while the button is down.
 */
export type PowerKind = 'fast' | 'fly' | 'sneaky' | 'health'

export const POWERS: Record<string, PowerKind> = {
  POWER_FAST: 'fast',
  POWER_FLY: 'fly',
  POWER_SNEAKY: 'sneaky',
  POWER_HEALTH: 'health',
}

/** Ticks of use one pickup is worth. */
export const POWER_CHARGE = 360

export const POWER_LABEL: Record<PowerKind, string> = {
  fast: 'FAST',
  fly: 'FLY',
  sneaky: 'SNEAKY',
  health: 'HEAL',
}
