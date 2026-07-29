import type { GameAssets } from '../assets/loader'
import type { LevelObjectData } from '../assets/types'
import { Prop } from './Prop'

/**
 * Doors that actually stop you.
 *
 * `SWITCH_DOOR` and the trap doors carry `can_block` and a four-state set:
 * `stopped` is the closed frame, `running` runs the shutter open
 * (door0006 -> door0001), `walking` runs the same frames back to close it, and
 * `blocking` is the collision frame. Until now the world only ever swapped
 * their sprite, because collision is tile-based and a door is an object - so a
 * closed door was a picture you strolled through.
 *
 * Ours: solid unless fully open. A door wired to the level's signal network
 * does what the network says; an unwired one opens for anyone who walks up to
 * it, which is what a door that no switch controls should obviously do.
 */

/** Frames per second the shutter runs at. */
const DOOR_FPS = 14
/** How close an unwired door lets you get before opening. */
const AUTO_RANGE_X = 46
const AUTO_RANGE_Y = 56
/** Ticks an auto door stays open after you leave, so it does not clip you. */
const AUTO_LINGER = 30

/** Characters that are doors rather than any other kind of blocker. */
const DOOR_TYPES = new Set(['SWITCH_DOOR', 'TRAP_DOOR2', 'TRAP_DOOR3', 'SPACE_DOOR'])

type Phase = 'closed' | 'opening' | 'open' | 'closing'

export class Door extends Prop {
  private phase: Phase = 'closed'
  private clock = 0
  private linger = 0
  /** True when the level wires this door to a switch rather than to proximity. */
  readonly wired: boolean

  constructor(assets: GameAssets, data: LevelObjectData, objectIndex: number, wired: boolean) {
    super(assets, data, objectIndex)
    this.wired = wired
    this.setState('stopped', true)
  }

  get isOpen(): boolean {
    return this.phase === 'open'
  }

  /** Doors block until they are all the way open. */
  get isSolid(): boolean {
    return this.phase !== 'open'
  }

  /**
   * The box the player is kept out of, taken from the sprite rather than a
   * guess, so a door is exactly as wide as it looks.
   */
  get blockBox(): { left: number; top: number; right: number; bottom: number } {
    return this.hitBox
  }

  /**
   * `driven` is the signal network's answer for a wired door, and ignored for
   * an unwired one, which watches for the player instead.
   */
  update(driven: boolean, playerX: number, playerY: number): void {
    let wants: boolean
    if (this.wired) {
      wants = driven
    } else {
      const near =
        Math.abs(playerX - this.x) < AUTO_RANGE_X && Math.abs(playerY - this.y) < AUTO_RANGE_Y
      if (near) this.linger = AUTO_LINGER
      else if (this.linger > 0) this.linger--
      wants = near || this.linger > 0
    }

    switch (this.phase) {
      case 'closed':
        if (wants) this.begin('opening', 'running')
        break

      case 'open':
        if (!wants) this.begin('closing', 'walking')
        break

      case 'opening':
        if (!wants) {
          this.reverse('closing', 'walking')
          break
        }
        if (this.step()) this.phase = 'open'
        break

      case 'closing':
        if (wants) {
          this.reverse('opening', 'running')
          break
        }
        if (this.step()) {
          this.phase = 'closed'
          this.setState('stopped', true)
        }
        break
    }
  }

  private begin(phase: Phase, state: string): void {
    this.phase = phase
    this.clock = 0
    if (this.assets.hasState(this.character, state)) this.setState(state, true)
  }

  /**
   * Turns a door round mid-travel without snapping it shut. The two states are
   * the same frames in opposite orders, so the position through one is the
   * complement of the position through the other.
   */
  private reverse(phase: Phase, state: string): void {
    const progress = this.frameCount > 0 ? this.clock / this.frameCount : 0
    this.begin(phase, state)
    this.clock = Math.max(0, Math.min(this.frameCount, (1 - progress) * this.frameCount))
    this.setFrame(Math.floor(this.clock))
  }

  /** Advances the shutter; true once it has run through. */
  private step(): boolean {
    this.clock += DOOR_FPS / 60
    this.advanceAnimation(DOOR_FPS / 60)
    return this.clock >= this.frameCount
  }
}

/** Builds the doors, replacing the inert props they stand in for. */
export function buildDoors(
  assets: GameAssets,
  objects: LevelObjectData[],
  links: number[][],
  props: Prop[],
): Door[] {
  const doors: Door[] = []

  objects.forEach((object, index) => {
    if (!DOOR_TYPES.has(object.type)) return
    if (!assets.character(object.type)) return

    doors.push(new Door(assets, object, index, (links[index] ?? []).length > 0))
    const existing = props.findIndex((p) => p.data === object)
    if (existing >= 0) props.splice(existing, 1)
  })

  return doors
}
