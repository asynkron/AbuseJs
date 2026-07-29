import type { LogicObjectData } from './types'

/**
 * The level's signal bus.
 *
 * Abuse wires a level with one idea: every object carries an integer
 * `aistate`, and non-zero means on. Producers set their own from the player or
 * the world, gates recompute theirs each tick from the objects they link to,
 * and consumers read `(with_object (get_object 0) (aistate))`. There is no
 * event queue and no propagation order - each object runs once per tick in
 * level order and sees its inputs as of whenever they last ran, so a chain of
 * gates settles at one link per tick. That is a visible part of how the levels
 * feel, so it is reproduced rather than smoothed out.
 *
 * Links are one-way and stored per owner. Direction is not consistent in the
 * shipped data: a door owns the link to its switch, but a sensor owns links to
 * the hidden walls and turrets it wakes, and only 758 of 7336 pairs have a
 * mirror. Both directions therefore have to be consulted to answer "is
 * anything driving me".
 */
export class SignalNetwork {
  /** Current `aistate` per object index, for every object in the level. */
  private readonly signal: Int32Array
  /** Links this object owns, i.e. `(get_object n)` - mutable, see `unlink`. */
  private readonly outgoing: number[][]
  /** Objects that own a link pointing at this one. */
  private readonly incoming: number[][]

  constructor(objects: readonly LogicObjectData[], links: readonly (readonly number[])[]) {
    this.signal = new Int32Array(objects.length)
    // Levels save each object's aistate and the engine restores it on load.
    objects.forEach((object, index) => {
      this.signal[index] = object.aistate
    })

    this.outgoing = objects.map((_, index) =>
      (links[index] ?? []).filter((target) => target >= 0 && target < objects.length),
    )
    this.incoming = objects.map(() => [])
    this.outgoing.forEach((targets, owner) => {
      for (const target of targets) this.incoming[target].push(owner)
    })
  }

  get size(): number {
    return this.signal.length
  }

  stateOf(index: number): number {
    return this.signal[index] ?? 0
  }

  setState(index: number, value: number): void {
    if (index >= 0 && index < this.signal.length) this.signal[index] = value
  }

  isOn(index: number): boolean {
    return this.stateOf(index) !== 0
  }

  linksOf(index: number): readonly number[] {
    return this.outgoing[index] ?? []
  }

  /** The object a consumer reads - `(get_object 0)`. */
  driverOf(index: number): number | undefined {
    return this.outgoing[index]?.[0]
  }

  /** True when this object's own link 0 is on. */
  isDriven(index: number): boolean {
    const driver = this.driverOf(index)
    return driver !== undefined && this.isOn(driver)
  }

  /**
   * The engine's `(activated)`, written out longhand all over the lisp as
   * `(or (eq (total_objects) 0) (not (eq (with_object (get_object 0) (aistate)) 0)))`
   * - true when the object has no links at all, otherwise true when its driver
   * is on.
   *
   * The inbound half is ours: the original's compiled flag only looks at the
   * object's own links, which leaves a hidden wall that a sensor links to
   * looking permanently unwired. Any inbound source being on counts, because
   * an object can be woken by several sensors.
   */
  isActivated(index: number): boolean {
    const own = this.outgoing[index] ?? []
    if (own.length > 0) return this.isOn(own[0])

    const sources = this.incoming[index] ?? []
    if (sources.length > 0) return sources.some((source) => this.isOn(source))

    // Unwired means always awake - what makes a lone hidden wall shootable.
    return true
  }

  /**
   * Drops a link, as `remove_object` does inside a death sensor. The pairing
   * has to be maintained by hand because the reverse index is derived.
   */
  unlink(owner: number, target: number): void {
    const targets = this.outgoing[owner]
    const at = targets?.indexOf(target) ?? -1
    if (!targets || at < 0) return
    targets.splice(at, 1)

    const sources = this.incoming[target]
    const mirror = sources?.indexOf(owner) ?? -1
    if (sources && mirror >= 0) sources.splice(mirror, 1)
  }
}
