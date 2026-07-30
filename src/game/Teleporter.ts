import type { GameAssets } from '../assets/loader'
import type { LevelObjectData } from '../assets/types'
import { Prop } from './Prop'

/**
 * A teleporter pad - TELE2, `tp2_ai` in lisp/duong.lsp.
 *
 * A pad's link is the pad it sends you to, and they are placed in pairs.
 * Standing on one and pressing down starts its fifteen-frame `elec` animation,
 * and for as long as that runs the pad owns the player:
 *
 *   (with_object (get_object 1)
 *      (progn (set_x x) (set_y (- y 16))
 *             (user_fun SET_FADE_COUNT fade)
 *             (setq is_teleporting 1)))
 *
 * - pinned to the pad, faded out a step at a time, and unable to shoot or be
 * shot. Only when the animation runs out is the player put down at the far pad
 * with the fade cleared. Without the pinning and the fade the cop just stands
 * there and then jumps across, which is what made the trip look like nothing
 * had happened.
 */

/** Where the rider stands relative to a pad's anchor, going and arriving. */
const ARRIVAL_LIFT = 16
/** How close the player has to be to use one. */
const REACH_X = 22
const REACH_Y = 36
/** Frames per second for the spin. */
const SPIN_FPS = 20
/** `(if (< (current_frame) 16) (current_frame) 15)` - the fade tops out here. */
const FADE_CAP = 15

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
   * Advances the spin.
   *
   * While it runs, `hold` is where the pad wants the player and how far faded
   * out they should be. On the tick it finishes, `arrival` is the far pad -
   * which is also the tick the fade is cleared.
   */
  update(): TeleportProgress {
    if (!this.charging) return { hold: null, arrival: null }

    this.elapsed++
    this.advanceAnimation(SPIN_FPS / 60)

    if (this.elapsed < this.spinTicks) {
      // `(if (< (current_frame) 16) (current_frame) 15)`, except the count has
      // to come off the pad's progress rather than its frame index: at 60Hz the
      // fifteen frames are stepped a third of a frame at a time, so reading the
      // index back would hold each fade step for three ticks and stall near 0.
      const fade = Math.min(FADE_CAP, Math.round((this.elapsed / this.spinTicks) * FADE_CAP))
      return {
        hold: { x: this.x, y: this.y - ARRIVAL_LIFT, fade },
        arrival: null,
      }
    }

    this.charging = false
    this.setState('stopped', true)
    return {
      hold: null,
      arrival: { x: this.destination.x, y: this.destination.y - ARRIVAL_LIFT },
    }
  }
}

/** What a pad wants done with the player this tick. */
export interface TeleportProgress {
  /** Where to pin them and how far to fade them, while the pad is running. */
  hold: { x: number; y: number; fade: number } | null
  /** Where to put them down, on the tick the pad finishes. */
  arrival: { x: number; y: number } | null
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
