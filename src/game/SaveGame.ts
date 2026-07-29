import type { Player } from './Player'
import type { PowerKind } from './Weapons'

/**
 * The save consoles, and what they write.
 *
 * The console is `RESTART_POSITION` - the same object that tells a fresh level
 * where to put you. Its `stopped` state is the six-frame idle flicker
 * (`console`/`console2`) and `running` is `console_on`, so the art already has
 * an "activated" look to switch to. There is one in the training level, next
 * to the line that says what it is for.
 *
 * A save is the level id, where you were standing, and what you were carrying.
 * It survives a reload, and it moves where dying puts you.
 */

const KEY = 'abusejs.save'
/** Ticks the console holds its lit frame after being used. */
export const CONSOLE_LIT_TICKS = 90

export interface SaveState {
  level: string
  x: number
  y: number
  health: number
  magazines: number[]
  weapon: number
  power: PowerKind | null
  powerCharge: number
  kills: number
  /** Wall-clock stamp, so a save can be reported as recent or stale. */
  at: number
}

export function readSave(): SaveState | null {
  try {
    const stored = localStorage.getItem(KEY)
    if (!stored) return null
    const parsed = JSON.parse(stored) as Partial<SaveState>
    if (typeof parsed.level !== 'string') return null
    if (!Array.isArray(parsed.magazines)) return null
    if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return null
    return parsed as SaveState
  } catch {
    // Private browsing, a corrupt entry - either way there is no save.
    return null
  }
}

export function writeSave(state: SaveState): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
    return true
  } catch {
    return false
  }
}

export function clearSave(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // Nothing to do; the caller does not care either.
  }
}

/** Snapshots the player against a level id and a console position. */
export function snapshot(
  level: string,
  player: Player,
  at: { x: number; y: number },
  kills: number,
  now: number,
): SaveState {
  return {
    level,
    x: at.x,
    y: at.y,
    health: player.health,
    magazines: [...player.magazines],
    weapon: player.weapon,
    power: player.power,
    powerCharge: player.powerCharge,
    kills,
    at: now,
  }
}

/** Puts a save back into a player. Position is the caller's business. */
export function restore(player: Player, state: SaveState): void {
  player.health = state.health
  state.magazines.forEach((rounds, slot) => {
    if (slot < player.magazines.length) player.magazines[slot] = rounds
  })
  player.weapon = Math.min(Math.max(0, state.weapon | 0), player.magazines.length - 1)
  player.power = state.power
  player.powerCharge = state.powerCharge
}
