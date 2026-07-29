import type { GameAssets } from '../assets/loader'
import type { LevelObjectData } from '../assets/types'
import { Entity } from './Entity'

/**
 * A level object rendered from the original placement data - lava, doors,
 * teleporters, pickups, monsters standing where the level put them.
 *
 * Deliberately inert: it plays its animation and nothing else. Abuse's
 * behaviour lives in Lisp AI functions, and this project is writing its own
 * mechanics, so porting those would hand the design back to 1995. This is the
 * scenery those mechanics will eventually drive.
 */
export class Prop extends Entity {
  /** Animation rate in frames per second. */
  private static readonly FPS = 10

  /**
   * Whether this object cycles its frames on its own.
   *
   * Most do not. A door's frames are the positions it opens through and a
   * teleporter's are the spin it does once used - the original steps them from
   * the object's AI, not on a timer. Only fire, lava and water genuinely loop,
   * and the converter works out which from the scripts.
   */
  private readonly loops: boolean

  constructor(
    assets: GameAssets,
    readonly data: LevelObjectData,
  ) {
    super(assets, data.type)
    this.setPosition(data.x, data.y)
    this.direction = data.direction < 0 ? -1 : 1

    // Colour variants: ants and the like index a tint array with their aitype.
    this.tintIndex = assets.tintFor(data.type, data.aitype)

    // Levels record the state name each object was saved in; fall back when
    // that state no longer exists in the current scripts.
    const state = assets.hasState(data.type, data.state) ? data.state : assets.defaultState(data.type)
    this.setState(state, true)

    this.loops = assets.isIdleAnimated(data.type)
  }

  advance(dt: number): void {
    if (!this.loops) return
    this.advanceAnimation(Prop.FPS * dt)
  }
}

/** Objects worth putting in the world: known, drawable, not editor-only. */
export function spawnProps(assets: GameAssets, objects: LevelObjectData[]): Prop[] {
  const props: Prop[] = []
  for (const object of objects) {
    // Types absent from the scripts were deleted from the game after these
    // levels were saved; the original drops them on load too.
    if (!assets.character(object.type)) continue
    if (assets.isEditorOnly(object.type)) continue
    props.push(new Prop(assets, object))
  }
  return props
}
