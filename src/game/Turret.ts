import type { GameAssets } from '../assets/loader'
import type { LevelObjectData } from '../assets/types'
import { Prop } from './Prop'

/**
 * A wall-mounted gun that opens up and tracks the player.
 *
 * These sit in levels as closed pods - SPRAY_GUN's and TRACK_GUN's `stopped`
 * state is a single dormant frame - which is why a level looks empty until
 * something wakes them. Both carry a 24-frame aiming set on the same angular
 * convention as the player's own torso, so pointing one at the player is a
 * matter of picking the right frame.
 *
 * Ours: notice, open, track, close again. It does not shoot back yet.
 */

/** How far a turret notices the player from. */
const WAKE_RANGE = 260
/** Extra distance before it closes again, so it does not flutter at the edge. */
const SLEEP_MARGIN = 60
/** Frames per second for opening and closing. */
const OPEN_FPS = 14

interface TurretStates {
  aim: string
  open?: string
  close?: string
}

/** The state names each kind of turret uses. */
const KINDS: Record<string, TurretStates> = {
  SPRAY_GUN: { aim: 'spray.aim', open: 'spray.appear', close: 'spray.disappear' },
  TRACK_GUN: { aim: 'spinning', open: 'opening', close: 'shuting' },
}

type Phase = 'dormant' | 'opening' | 'tracking' | 'closing'

export class Turret extends Prop {
  private phase: Phase = 'dormant'
  private timer = 0
  private readonly states: TurretStates
  private readonly aimFrames: number

  constructor(assets: GameAssets, data: LevelObjectData, objectIndex: number) {
    super(assets, data, objectIndex)
    this.states = KINDS[data.type]
    this.aimFrames = assets.animation(data.type, this.states.aim).length
    this.setState('stopped', true)
  }

  get isAwake(): boolean {
    return this.phase !== 'dormant'
  }

  update(playerX: number, playerY: number): void {
    const distance = Math.hypot(playerX - this.x, playerY - this.y)

    switch (this.phase) {
      case 'dormant':
        if (distance < WAKE_RANGE) this.begin('opening', this.states.open)
        break

      case 'opening':
        if (this.step()) this.begin('tracking', this.states.aim)
        break

      case 'tracking':
        if (distance > WAKE_RANGE + SLEEP_MARGIN) {
          this.begin('closing', this.states.close)
          break
        }
        this.aimAt(playerX, playerY)
        break

      case 'closing':
        if (this.step()) {
          this.phase = 'dormant'
          this.setState('stopped', true)
        }
        break
    }
  }

  private begin(phase: Phase, state: string | undefined): void {
    this.phase = phase
    this.timer = 0
    if (state && this.assets.hasState(this.character, state)) this.setState(state, true)
  }

  /** Advances a one-shot animation; true once it has played through. */
  private step(): boolean {
    this.timer += OPEN_FPS / 60
    this.advanceAnimation(OPEN_FPS / 60)
    return this.timer >= this.frameCount
  }

  /**
   * Points the barrel at the player by choosing among the aim frames, the same
   * way the player's torso picks one of its 24.
   */
  private aimAt(playerX: number, playerY: number): void {
    if (this.aimFrames === 0) return
    const angle = (Math.atan2(-(playerY - this.y), playerX - this.x) * 180) / Math.PI
    const local = this.direction >= 0 ? angle : 180 - angle
    const normalized = ((local % 360) + 360) % 360
    this.setFrame(Math.round((normalized / 360) * this.aimFrames) % this.aimFrames)
  }
}

/** Builds the turrets in a level, replacing the inert props they stand in for. */
export function buildTurrets(
  assets: GameAssets,
  objects: LevelObjectData[],
  props: Prop[],
): Turret[] {
  const turrets: Turret[] = []

  objects.forEach((object, index) => {
    if (!KINDS[object.type]) return
    if (!assets.character(object.type)) return

    const turret = new Turret(assets, object, index)
    turrets.push(turret)

    const existing = props.findIndex((p) => p.data === object)
    if (existing >= 0) props.splice(existing, 1)
  })

  return turrets
}
