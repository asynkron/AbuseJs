import type { GameAssets } from '../../assets/loader'
import type { LevelObjectData } from '../../assets/types'
import { Ant } from './Ant'
import { Enemy, type Battlefield } from './Enemy'
import { speed } from './tuning'
import type { EnemyOverrides, PlayerView } from './types'

/**
 * ANT_CRACK - a hole in the wall that ants come out of.
 *
 * lisp/ant.lsp, crack_ai. Once triggered it uses its own animation frame as
 * the state machine: three frames of nothing, one that spits an ant out, and
 * back to the start until the counter runs dry - then it parks on the last
 * frame and is inert forever. Four ticks an ant is fast, and that is the
 * point; a crack is how a room fills up.
 */

const CRACK = {
  /** crack_ai: how close an unlinked crack lets the player get. */
  triggerDistX: 50,
  triggerDistY: 70,
  /** The frame that spawns, and the one a spent crack parks on. */
  spawnFrame: 3,
  spentFrame: 4,
  /** Where the ant appears, and how hard it comes out. */
  spawnOffsetX: 20,
  spawnXvel: speed(20),
} as const

/**
 * `crack_cons`'s default, for a crack whose level saved no `create_total`.
 *
 * Only 15 cracks in the whole game are in that position; the rest carry
 * anything from 1 to 25, which is the number that decides whether a room
 * trickles one ant at you or buries you in fifteen.
 */
const CREATE_TOTAL_DEFAULT = 1

export class AntCrack extends Enemy {
  private armed: boolean
  private remaining: number

  constructor(
    assets: GameAssets,
    data: LevelObjectData,
    objectIndex: number,
    world: Battlefield,
    overrides: EnemyOverrides = {},
  ) {
    super(assets, data, objectIndex, world)
    this.remaining =
      overrides.createTotal ?? data.lvars?.create_total ?? CREATE_TOTAL_DEFAULT
    this.armed = data.aistate === 0
    this.setPicture(0)
  }

  protected think(player: PlayerView): boolean {
    if (this.armed) {
      if (this.triggered(player)) this.armed = false
      return true
    }

    switch (this.pictureAt) {
      case CRACK.spentFrame:
        break
      case CRACK.spawnFrame:
        this.pour()
        break
      default:
        this.nextPicture()
    }
    return true
  }

  private triggered(player: PlayerView): boolean {
    const links = this.linkedObjects
    if (links.length > 0) return this.world.isSignalOn(links[0])
    if (player.hidden) return false
    return this.distX(player) < CRACK.triggerDistX && this.distY(player) < CRACK.triggerDistY
  }

  /**
   * One ant, and a decision about whether there will be another.
   *
   * The ant arrives already mid-leap - state run_jump, aistate 6, launched
   * sideways - which is why it does its 4 points of contact damage on the way
   * out. The original inserts it with `add_object_after` so it thinks in the
   * same tick it was made; here it joins the end of the list and starts on the
   * next one, which is a tick of difference and nothing else.
   */
  private pour(): void {
    if (this.remaining <= 1) {
      this.setPicture(CRACK.spentFrame)
      this.remaining = 0
    } else {
      this.remaining--
      this.setPicture(0)
    }

    const spawn: LevelObjectData = {
      ...this.data,
      type: 'ANT_ROOF',
      state: 'run_jump',
      x: this.x + this.direction * CRACK.spawnOffsetX,
      y: this.y,
      // Prop reads the byte the level stored; -1 survives the sign extension
      // Enemy does on it just as 255 would.
      direction: this.direction,
      aistate: 6,
      hp: 0,
    }

    // No object index: a spawned ant has no entry in the level's link table,
    // and borrowing the crack's would wire it to the crack's own sensor.
    const ant = new Ant(this.assets, spawn, -1, this.world)
    ant.vx = this.direction * CRACK.spawnXvel
    this.world.spawn(ant)
  }
}
