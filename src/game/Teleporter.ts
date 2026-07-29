import type { GameAssets } from '../assets/loader'
import type { LevelObjectData } from '../assets/types'
import { Prop } from './Prop'

/**
 * A teleporter pad.
 *
 * Ours, but wired from the level: a teleporter's link is the pad it sends you
 * to, and they are placed in pairs. Standing on one and pressing down runs its
 * spin animation and then puts you down at the other, 16px above its own y -
 * the offset `tp2_ai` uses in lisp/duong.lsp.
 */

/** Where the rider ends up relative to the destination pad's anchor. */
const ARRIVAL_LIFT = 16
/** How close the player has to be to use one. */
const REACH_X = 22
const REACH_Y = 36
/** Frames per second for the spin. */
const SPIN_FPS = 20

export class Teleporter extends Prop {
  private charging = false
  private elapsed = 0
  private readonly spinTicks: number

  constructor(
    assets: GameAssets,
    data: LevelObjectData,
    readonly destination: { x: number; y: number },
    objectIndex = -1,
  ) {
    super(assets, data, objectIndex)
    // Pads saved mid-cycle should still start at rest.
    this.setState(assets.hasState(data.type, 'stopped') ? 'stopped' : data.state, true)

    const spin = assets.animation(data.type, 'running')
    this.spinTicks = Math.max(1, Math.round((spin.length / SPIN_FPS) * 60))
  }

  get isCharging(): boolean {
    return this.charging
  }

  /** True if the player is close enough to step onto this pad. */
  covers(x: number, y: number): boolean {
    return Math.abs(x - this.x) <= REACH_X && Math.abs(y - this.y) <= REACH_Y
  }

  /** Starts the spin. Returns false if it is already running. */
  trigger(): boolean {
    if (this.charging) return false
    this.charging = true
    this.elapsed = 0
    this.setState('running', true)
    return true
  }

  /**
   * Advances the spin. Returns the arrival point on the tick it completes, so
   * the caller can move whoever is standing here.
   */
  update(): { x: number; y: number } | null {
    if (!this.charging) return null

    this.elapsed++
    this.advanceAnimation(SPIN_FPS / 60)
    if (this.elapsed < this.spinTicks) return null

    this.charging = false
    this.setState('stopped', true)
    return { x: this.destination.x, y: this.destination.y - ARRIVAL_LIFT }
  }
}

/** Builds the teleporters in a level, dropping the inert props they replace. */
export function buildTeleporters(
  assets: GameAssets,
  objects: LevelObjectData[],
  links: number[][],
  props: Prop[],
): Teleporter[] {
  const teleporters: Teleporter[] = []

  objects.forEach((object, index) => {
    if (object.type !== 'TELE2') return
    const target = (links[index] ?? [])[0]
    // Unlinked pads go nowhere; `tp2_ai` ignores them too.
    if (target === undefined || target === index) return

    const destination = { x: objects[target].x, y: objects[target].y }
    teleporters.push(new Teleporter(assets, object, destination, index))

    const existing = props.findIndex((p) => p.data === object)
    if (existing >= 0) props.splice(existing, 1)
  })

  return teleporters
}
