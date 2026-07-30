import type { GameAssets } from '../../assets/loader'
import type { LevelObjectData } from '../../assets/types'
import type { Prop } from '../Prop'
import { Ant } from './Ant'
import { AntCrack } from './AntCrack'
import { BossAnt } from './BossAnt'
import { CleanerRobot } from './CleanerRobot'
import { Enemy, type Battlefield } from './Enemy'
import { Flyer, FLYER_TYPES } from './Flyer'
import { Jugger } from './Jugger'
import { Turret } from './Turret'
import type { EnemyContext, EnemyOverrides, EnemyShot, PlayerView } from './types'

export { Ant } from './Ant'
export { AntCrack } from './AntCrack'
export { BossAnt } from './BossAnt'
export { CleanerRobot } from './CleanerRobot'
export { Enemy } from './Enemy'
export { Flyer } from './Flyer'
export { Jugger } from './Jugger'
export { Turret } from './Turret'
export { canSee, seeDist } from './raycast'
export type {
  EnemyContext,
  EnemyOverrides,
  EnemyShot,
  EnemySound,
  PlayerView,
} from './types'

/** The view box, grown, that decides which creatures are awake this tick. */
export interface ActiveBox {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** Every level object type this subsystem takes over. */
export const ENEMY_TYPES: readonly string[] = [
  'ANT_ROOF',
  'HIDDEN_ANT',
  'ANT_CRACK',
  ...FLYER_TYPES,
  'JUGGER',
  'ROB1',
  'BOSS_ANT',
  'SPRAY_GUN',
  'TRACK_GUN',
]

/**
 * Everything in a level that thinks, ticked as one.
 *
 * The group owns the list because the list changes: an ANT_CRACK adds ants to
 * it while it is being iterated, and anything that dies leaves it. Both go out
 * through the context's `onSpawn` and `onRemove` so the host can keep its
 * display list and its bullet targets in step.
 */
export class EnemyGroup {
  /** Live creatures, in spawn order. Read it, do not splice it. */
  readonly members: Enemy[] = []

  /** Creatures made during this tick; they join the list at the end of it. */
  private readonly arrivals: Enemy[] = []

  private readonly field: Battlefield

  constructor(private readonly context: EnemyContext) {
    this.field = {
      level: context.level,
      sightBlockers: (exclude) => context.sightBlockers(exclude),
      isSignalOn: (index) => context.isSignalOn(index),
      hurtPlayer: (amount) => context.hurtPlayer(amount),
      pushPlayer: (dx) => context.pushPlayer(dx),
      playSound: (sound, x, y) => context.playSound(sound, x, y),
      explode: (x, y, kind) => context.explode(x, y, kind),
      dropPickup: (character, x, y) => context.dropPickup?.(character, x, y),
      fire: (shot: EnemyShot) => context.onFire?.(shot),
      spawn: (enemy) => this.arrivals.push(enemy),
      anyIn: (character, x0, y0, x1, y1) => this.anyIn(character, x0, y0, x1, y1),
    }
  }

  /** Adds a creature the level placed. */
  add(enemy: Enemy): void {
    this.members.push(enemy)
  }

  /**
   * One tick for everything in range, then the day's arrivals and departures.
   *
   * `active` is the view box grown by a quarter of its own size, which is what
   * `add_actives` is handed (src/game.cpp:1954). A creature outside it, plus its
   * own `(range x y)`, does not think at all - it is frozen exactly as it stands
   * until the view comes back. That is how the original keeps a level's far side
   * still, and running everything everywhere let creatures path, fall and die
   * off-screen.
   *
   * One thing the original also does and this does not: `pull_actives` drags any
   * object *linked* to an active one into the list, however far away it is. No
   * creature in the shipped levels depends on being pulled that way, so it is
   * left out rather than guessed at.
   */
  update(player: PlayerView, active: ActiveBox): void {
    for (let i = this.members.length - 1; i >= 0; i--) {
      const enemy = this.members[i]

      const [rangeX, rangeY] = enemy.range
      const inRange =
        enemy.x + rangeX >= active.x1 &&
        enemy.x - rangeX <= active.x2 &&
        enemy.y + rangeY >= active.y1 &&
        enemy.y - rangeY <= active.y2
      if (!inRange) continue

      if (enemy.update(player)) continue

      this.members.splice(i, 1)
      this.context.onRemove?.(enemy)
    }

    for (const arrival of this.arrivals) {
      this.members.push(arrival)
      this.context.onSpawn?.(arrival)
    }
    this.arrivals.length = 0
  }

  /** `find_object_in_area` for one character - the ants' congestion test. */
  private anyIn(character: string, x0: number, y0: number, x1: number, y1: number): boolean {
    return this.members.some(
      (enemy) =>
        enemy.character === character &&
        enemy.x >= x0 &&
        enemy.x <= x1 &&
        enemy.y >= y0 &&
        enemy.y <= y1,
    )
  }

  /** Exposed so a level's placed creatures can be built against it. */
  get battlefield(): Battlefield {
    return this.field
  }
}

/** Per-object tuning the caller can supply once the lvars block is readable. */
export type OverrideLookup = (object: LevelObjectData, index: number) => EnemyOverrides

/**
 * Builds every thinking creature a level placed, and takes the inert Props
 * that were standing in for them out of `props`.
 *
 * HIDDEN_ANT is the one that needs explaining. Read literally it is an
 * invisible character with a single frame and no animations, bound to the ant
 * AI, which would immediately ask it for `hanging` and `running` states it
 * does not have - and its draw function only draws in the editor. That cannot
 * be what 363 of them across the core levels are for, and 200 of those carry
 * `hide_flag 1`. The reading taken here, which is an invention and not
 * something the script says: a HIDDEN_ANT is an ANT_ROOF placed with hide_flag
 * forced on, invisible until the wake test fires and an ordinary ant
 * afterwards.
 */
export function buildEnemies(
  assets: GameAssets,
  objects: LevelObjectData[],
  props: Prop[],
  context: EnemyContext,
  overridesFor?: OverrideLookup,
): EnemyGroup {
  const group = new EnemyGroup(context)
  const field = group.battlefield

  objects.forEach((object, index) => {
    const overrides = overridesFor?.(object, index) ?? {}
    const enemy = createEnemy(assets, object, index, field, overrides)
    if (!enemy) return

    group.add(enemy)

    const standIn = props.findIndex((prop) => prop.data === object)
    if (standIn >= 0) props.splice(standIn, 1)
  })

  return group
}

export function createEnemy(
  assets: GameAssets,
  object: LevelObjectData,
  index: number,
  field: Battlefield,
  overrides: EnemyOverrides,
): Enemy | null {
  switch (object.type) {
    case 'ANT_ROOF':
      return new Ant(assets, object, index, field, overrides)

    case 'HIDDEN_ANT': {
      // Built as an ant that starts out of sight. The level's own record is
      // kept for its position, health and aitype; only the type and the flag
      // are rewritten.
      const asAnt: LevelObjectData = { ...object, type: 'ANT_ROOF', state: 'hiding' }
      return new Ant(assets, asAnt, index, field, { ...overrides, hideFlag: 1 })
    }

    case 'ANT_CRACK':
      return new AntCrack(assets, object, index, field, overrides)

    case 'FLYER':
    case 'GREEN_FLYER':
    case 'WHO':
      return new Flyer(assets, object, index, field, overrides)

    case 'JUGGER':
      return new Jugger(assets, object, index, field, overrides)

    case 'ROB1':
      return new CleanerRobot(assets, object, index, field)

    case 'SPRAY_GUN':
    case 'TRACK_GUN':
      return new Turret(assets, object, index, field)

    case 'BOSS_ANT':
      return new BossAnt(assets, object, index, field)

    default:
      return null
  }
}
